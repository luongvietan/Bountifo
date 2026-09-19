import { API_ACCEPT, API_BASE, API_RATE_LIMIT_PER_MINUTE } from "../constants";
import { credentialStorageUsable } from "../storageAccess";
import { getCredential } from "../tokenOps";
import { ApiError } from "./errors";

export interface ApiRequestOptions {
  operation: "LIST_ENGAGEMENTS" | "GET_ENGAGEMENT" | "TEST_TOKEN";
  code?: string;
  uuid?: string;
  page?: number;
  tokenOverride?: string;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  observedVersion: string | null;
}

const RATE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Rolling-window token bucket (spec §6.1): at most API_RATE_LIMIT_PER_MINUTE
// requests per 60s per IP. Module-level so every API call in the service
// worker shares one budget. Acquisition is serialized through bucketChain so
// concurrent callers each consume their own slot instead of racing.
// ---------------------------------------------------------------------------
const requestTimes: number[] = [];
let bucketChain: Promise<void> = Promise.resolve();

async function acquireRateSlot(): Promise<void> {
  const previous = bucketChain;
  let release!: () => void;
  bucketChain = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    for (;;) {
      const now = Date.now();
      const oldest = requestTimes[0];
      if (oldest !== undefined && now - oldest >= RATE_WINDOW_MS) {
        requestTimes.shift();
        continue;
      }
      if (requestTimes.length < API_RATE_LIMIT_PER_MINUTE) {
        requestTimes.push(now);
        return;
      }
      // length >= limit implies a defined oldest; `?? now` is defensive only.
      await sleep(RATE_WINDOW_MS - (now - (oldest ?? now)));
    }
  } finally {
    release();
  }
}

function buildUrl(opts: ApiRequestOptions): string {
  switch (opts.operation) {
    case "LIST_ENGAGEMENTS":
      return `${API_BASE}/engagements?page[number]=${opts.page ?? 1}&page[size]=25`;
    case "GET_ENGAGEMENT":
      if (typeof opts.uuid !== "string" || opts.uuid === "") {
        throw new TypeError("apiRequest: GET_ENGAGEMENT requires opts.uuid");
      }
      return `${API_BASE}/engagements/${opts.uuid}?include=target_groups,targets`;
    case "TEST_TOKEN":
      return `${API_BASE}/engagements?page[number]=1&page[size]=1`;
  }
}

/**
 * Stored credential unless opts.tokenOverride is set (TEST_TOKEN probes an
 * unsaved candidate and must not touch storage). Fails closed: locked storage
 * → "storage_locked", missing credential → "no_token".
 */
async function resolveCredential(opts: ApiRequestOptions): Promise<string> {
  if (typeof opts.tokenOverride === "string" && opts.tokenOverride !== "") {
    return opts.tokenOverride;
  }
  if (!(await credentialStorageUsable())) {
    throw new ApiError("storage_locked", "credential storage is locked down");
  }
  const credential = await getCredential();
  if (credential === null) {
    throw new ApiError("no_token", "no API credential stored");
  }
  return credential;
}

/** Bounded exponential backoff: base 500ms ×2^(n-1) + jitter 0–250ms. */
function retryDelayMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * JITTER_MAX_MS;
}

/** Integer `Retry-After` seconds; anything else (HTTP-date, junk) → null. */
function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function observedVersion(headers: Headers): string | null {
  return headers.get("x-bugcrowd-version") ?? headers.get("x-api-version");
}

/**
 * Executes one allowlisted Bugcrowd API read. URLs are built here only —
 * callers can never inject a destination (spec §19). Every attempt consumes a
 * rate-bucket slot. Retries: 429 honors `Retry-After` seconds once, then
 * bounded backoff; 5xx and network rejections get bounded exponential backoff
 * (500ms×2^n + 0–250ms jitter), max 4 attempts total. Non-retryable statuses
 * map to ApiError kinds immediately. Error payloads never carry headers, the
 * credential, or response body.
 */
export async function apiRequest<T>(
  opts: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  const credential = await resolveCredential(opts);
  const url = buildUrl(opts);
  let retryAfterHonored = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireRateSlot();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: API_ACCEPT,
          Authorization: `Token ${credential}`,
        },
      });
    } catch {
      // Network failure. Never copy the rejection's message — it is not
      // guaranteed free of request detail; a static string is (§18).
      if (attempt === MAX_ATTEMPTS) {
        throw new ApiError("network", "request failed");
      }
      await sleep(retryDelayMs(attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt === MAX_ATTEMPTS) {
        throw new ApiError("rate_limited", "API rate limit persisted", 429);
      }
      const retryAfter = retryAfterHonored ? null : retryAfterSeconds(res);
      if (retryAfter !== null) {
        retryAfterHonored = true;
        await sleep(retryAfter * 1000);
      } else {
        await sleep(retryDelayMs(attempt));
      }
      continue;
    }

    if (res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new ApiError("http", `HTTP ${res.status}`, res.status);
      }
      await sleep(retryDelayMs(attempt));
      continue;
    }

    if (res.status === 401) {
      throw new ApiError("unauthorized", "unauthorized", 401);
    }
    if (res.status === 403) {
      throw new ApiError("forbidden", "forbidden", 403);
    }
    if (res.status === 404) {
      throw new ApiError("not_found", "not found", 404);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError("http", `HTTP ${res.status}`, res.status);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ApiError(
        "invalid_response",
        "response was not valid JSON",
        res.status,
      );
    }
    return {
      data: parsed as T,
      status: res.status,
      observedVersion: observedVersion(res.headers),
    };
  }
  // Unreachable: the loop either returns or throws by MAX_ATTEMPTS.
  throw new ApiError("network", "request failed");
}
