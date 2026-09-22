import { API_RATE_LIMIT_PER_MINUTE, BUGCROWD_SITE } from "../constants";
import { ApiError } from "./errors";

/**
 * Researcher-side Bugcrowd site client — DISTINCT from client.ts.
 *
 * client.ts speaks to `api.bugcrowd.com`, the organization/program-owner API
 * (Token key:secret credentials). That surface never exposes the researcher's
 * engagement catalog. The researcher view lives on the site itself:
 *
 *   GET /engagements.json?page=N   catalog index ({engagements, paginationMeta})
 *   GET /engagements/<slug>        engagement brief HTML
 *
 * Authentication is the browser session — requests carry
 * `credentials: "include"` so the SW fetch sends the bugcrowd.com cookies
 * (allowed by host_permissions). There is no stored credential: logged-out
 * scans still see the public catalog, and session-dependent content degrades
 * per item instead of aborting.
 *
 * Same transport contract as client.ts: allowlisted URLs built here only,
 * one rolling 60/min rate bucket, bounded retries (429 honors Retry-After
 * once, 5xx/network get exponential backoff), ApiError kinds, and error
 * payloads that never carry request detail.
 */

export type SiteRequestOptions =
  | { operation: "LIST_INDEX"; page?: number }
  | { operation: "GET_BRIEF"; slug: string };

export interface SiteResponse<T> {
  data: T;
  status: number;
}

const RATE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const JITTER_MAX_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rolling-window token bucket, module-level — every site request in the
// service worker shares one budget (identical semantics to client.ts; kept
// separate because the two clients serve different auth domains).
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
      await sleep(RATE_WINDOW_MS - (now - (oldest ?? now)));
    }
  } finally {
    release();
  }
}

function buildUrl(opts: SiteRequestOptions): string {
  switch (opts.operation) {
    case "LIST_INDEX":
      return `${BUGCROWD_SITE}/engagements.json?page=${opts.page ?? 1}`;
    case "GET_BRIEF": {
      const slug = opts.slug;
      if (typeof slug !== "string" || !/^[A-Za-z0-9_-]+$/.test(slug)) {
        throw new TypeError("siteRequest: GET_BRIEF requires a slug");
      }
      return `${BUGCROWD_SITE}/engagements/${slug}`;
    }
  }
}

function acceptFor(opts: SiteRequestOptions): string {
  return opts.operation === "LIST_INDEX"
    ? "application/json"
    : "text/html,application/xhtml+xml";
}

/** Bounded exponential backoff: base 500ms ×2^(n-1) + jitter 0–250ms. */
function retryDelayMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * JITTER_MAX_MS;
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * A followed redirect onto the login surface means the session is absent or
 * dead for this resource. Detected on res.url — the 200 HTML that follows is
 * a login page, not engagement data.
 */
function isLoginRedirect(res: Response): boolean {
  if (!res.redirected) return false;
  try {
    const url = new URL(res.url);
    return (
      url.hostname === "identity.bugcrowd.com" ||
      /^\/(?:login|users\/sign_in|h\/login)\b/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Executes one allowlisted site read. LIST_INDEX resolves `data` as parsed
 * JSON (non-JSON bodies → invalid_response — e.g. a markup answer where the
 * index endpoint should be); GET_BRIEF resolves `data` as raw HTML text for
 * the offscreen parser.
 */
export async function siteRequest(
  opts: SiteRequestOptions & { operation: "LIST_INDEX" },
): Promise<SiteResponse<unknown>>;
export async function siteRequest(
  opts: SiteRequestOptions & { operation: "GET_BRIEF" },
): Promise<SiteResponse<string>>;
export async function siteRequest(
  opts: SiteRequestOptions,
): Promise<SiteResponse<unknown>> {
  const url = buildUrl(opts);
  let retryAfterHonored = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireRateSlot();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: acceptFor(opts) },
      });
    } catch {
      // Network failure. Static message only — a rejection may carry request
      // detail (§18).
      if (attempt === MAX_ATTEMPTS) {
        throw new ApiError("network", "request failed");
      }
      await sleep(retryDelayMs(attempt));
      continue;
    }

    if (isLoginRedirect(res)) {
      throw new ApiError("unauthorized", "unauthorized", 401);
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

    if (opts.operation === "LIST_INDEX") {
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        throw new ApiError(
          "invalid_response",
          "response was not JSON",
          res.status,
        );
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
      return { data: parsed, status: res.status };
    }

    return { data: await res.text(), status: res.status };
  }
  // Unreachable: the loop either returns or throws by MAX_ATTEMPTS.
  throw new ApiError("network", "request failed");
}
