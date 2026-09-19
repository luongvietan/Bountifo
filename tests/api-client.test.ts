import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { API_ACCEPT, API_BASE } from "../lib/constants";

// Module-level state under test: the rate bucket in lib/api/client.ts and the
// cached lockdown promise in lib/storageAccess.ts. Both are reset per test via
// vi.resetModules() + fresh dynamic imports (same pattern as
// tests/storageAccess.test.ts).

const CREDENTIAL = "test-credential-4f8c2b91";
const UUID = "f2b0fb99-1b2c-45d2-9341-f4a25088ba3a";

type ClientModule = typeof import("../lib/api/client");
type ErrorsModule = typeof import("../lib/api/errors");

type SetAccessLevelFn = (details: { accessLevel: string }) => Promise<void>;

function stubSetAccessLevel(fn: SetAccessLevelFn | undefined) {
  Object.defineProperty(fakeBrowser.storage.local, "setAccessLevel", {
    value: fn,
    configurable: true,
    writable: true,
  });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/vnd.bugcrowd+json",
      ...(init.headers ?? {}),
    },
  });
}

let client: ClientModule;
let errors: ErrorsModule;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  vi.useFakeTimers();
  // Default: storage lockdown succeeds so getCredential() can read.
  stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
  await fakeBrowser.storage.local.set({ apiCredential: CREDENTIAL });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  errors = await import("../lib/api/errors");
  client = await import("../lib/api/client");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Attaches handlers immediately so later timer advancement never leaves an unhandled rejection. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true, value }) as const,
    (err) => ({ ok: false, err }) as const,
  );
}

function expectNoSecretLeak(err: unknown) {
  const haystack = `${JSON.stringify(err)} ${(err as Error).message} ${String(err)}`;
  expect(haystack).not.toContain(CREDENTIAL);
  expect(haystack).not.toContain("Token ");
}

describe("apiRequest URL and header construction", () => {
  it("LIST_ENGAGEMENTS builds the paged index URL with exact headers", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await client.apiRequest({ operation: "LIST_ENGAGEMENTS", page: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${API_BASE}/engagements?page[number]=2&page[size]=25`);
    expect(init.headers).toEqual({
      Accept: API_ACCEPT,
      Authorization: `Token ${CREDENTIAL}`,
    });
  });

  it("LIST_ENGAGEMENTS defaults to page 1", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await client.apiRequest({ operation: "LIST_ENGAGEMENTS" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${API_BASE}/engagements?page[number]=1&page[size]=25`,
    );
  });

  it("GET_ENGAGEMENT builds the detail URL with target_groups,targets include", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await client.apiRequest({ operation: "GET_ENGAGEMENT", uuid: UUID });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${API_BASE}/engagements/${UUID}?include=target_groups,targets`,
    );
  });

  it("TEST_TOKEN probes page 1 size 1", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await client.apiRequest({ operation: "TEST_TOKEN" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${API_BASE}/engagements?page[number]=1&page[size]=1`,
    );
  });

  it("only ever calls fetch with api.bugcrowd.com URLs (no caller-supplied URL surface)", async () => {
    // Fresh Response per call: a Response body is single-use.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: [] })),
    );
    await client.apiRequest({ operation: "LIST_ENGAGEMENTS", page: 3 });
    await client.apiRequest({ operation: "GET_ENGAGEMENT", uuid: UUID });
    await client.apiRequest({ operation: "TEST_TOKEN" });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0]).startsWith("https://api.bugcrowd.com/")).toBe(true);
    }
  });
});

describe("apiRequest credential resolution", () => {
  it("sends Authorization: Token <cred> from storage", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await client.apiRequest({ operation: "TEST_TOKEN" });
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(`Token ${CREDENTIAL}`);
  });

  it("tokenOverride skips storage and is sent instead", async () => {
    await fakeBrowser.storage.local.clear();
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await client.apiRequest({ operation: "TEST_TOKEN", tokenOverride: "probe-token-7" });
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Token probe-token-7");
  });

  it("tokenOverride works even while credential storage is locked", async () => {
    // Re-import a fresh client whose lockdown cache will observe the failure.
    stubSetAccessLevel(() => {
      throw new Error("setAccessLevel not implemented");
    });
    vi.resetModules();
    const fresh = await import("../lib/api/client");
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const res = await fresh.apiRequest({
      operation: "TEST_TOKEN",
      tokenOverride: "probe-token-7",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no stored credential rejects with no_token", async () => {
    await fakeBrowser.storage.local.clear();
    const settled = settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    const res = await settled;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.err).toBeInstanceOf(errors.ApiError);
      expect((res.err as InstanceType<ErrorsModule["ApiError"]>).kind).toBe("no_token");
      expectNoSecretLeak(res.err);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("locked storage rejects with storage_locked", async () => {
    stubSetAccessLevel(() => {
      throw new Error("setAccessLevel not implemented");
    });
    vi.resetModules();
    const fresh = await import("../lib/api/client");
    const res = await settle(fresh.apiRequest({ operation: "TEST_TOKEN" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.err as InstanceType<ErrorsModule["ApiError"]>).kind).toBe(
        "storage_locked",
      );
      expectNoSecretLeak(res.err);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("apiRequest status mapping and observedVersion", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ] as const)("maps %i to kind %s without retrying", async (status, kind) => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [] }, { status }));
    const res = await settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.err as InstanceType<ErrorsModule["ApiError"]>;
      expect(err).toBeInstanceOf(errors.ApiError);
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expectNoSecretLeak(err);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps other non-2xx statuses to kind http with the status", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 400 }));
    const res = await settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.err as InstanceType<ErrorsModule["ApiError"]>;
      expect(err.kind).toBe("http");
      expect(err.status).toBe(400);
      expectNoSecretLeak(err);
    }
  });

  it("returns data, status, and observedVersion from x-bugcrowd-version", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [1] }, { headers: { "x-bugcrowd-version": "1.1.0" } }),
    );
    const res = await client.apiRequest<unknown>({ operation: "LIST_ENGAGEMENTS" });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ data: [1] });
    expect(res.observedVersion).toBe("1.1.0");
  });

  it("falls back to x-api-version then null", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({}, { headers: { "x-api-version": "2024-02-12" } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const res1 = await client.apiRequest<unknown>({ operation: "TEST_TOKEN" });
    const res2 = await client.apiRequest<unknown>({ operation: "TEST_TOKEN" });
    expect(res1.observedVersion).toBe("2024-02-12");
    expect(res2.observedVersion).toBeNull();
  });

  it("rejects invalid JSON on a 200 with invalid_response and no body leak", async () => {
    fetchMock.mockResolvedValue(
      new Response(`not json ${CREDENTIAL}`, { status: 200 }),
    );
    const res = await settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.err as InstanceType<ErrorsModule["ApiError"]>;
      expect(err.kind).toBe("invalid_response");
      expect(err.message).not.toContain(CREDENTIAL);
      expect(err.message).not.toContain("not json");
    }
  });
});

describe("apiRequest retry behavior", () => {
  it("honors Retry-After once on 429 then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: { "retry-after": "5" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const promise = client.apiRequest({ operation: "TEST_TOKEN" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Retry-After = 5s: not yet elapsed at +4.999s
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const res = await promise;
    expect(res.status).toBe(200);
  });

  it("uses bounded backoff when 429 carries no Retry-After", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const promise = client.apiRequest({ operation: "TEST_TOKEN" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // First backoff = 500ms + jitter(0-250) < 1000ms.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("gives up after 4 attempts on repeated 429 → rate_limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    const settled = settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await settled;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.err as InstanceType<ErrorsModule["ApiError"]>;
      expect(err.kind).toBe("rate_limited");
      expect(err.status).toBe(429);
      expectNoSecretLeak(err);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries 5xx then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const promise = client.apiRequest({ operation: "TEST_TOKEN" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("exhausts retries on persistent 500 → http ApiError after 4 attempts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    const settled = settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await settled;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.err as InstanceType<ErrorsModule["ApiError"]>;
      expect(err.kind).toBe("http");
      expect(err.status).toBe(500);
      expectNoSecretLeak(err);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries network rejections then fails with kind network", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${CREDENTIAL}`));
    const settled = settle(client.apiRequest({ operation: "TEST_TOKEN" }));
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await settled;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const err = res.err as InstanceType<ErrorsModule["ApiError"]>;
      expect(err.kind).toBe("network");
      expect(err.status).toBeUndefined();
      expectNoSecretLeak(err);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("apiRequest rate bucket", () => {
  it("allows 60 requests inside the rolling minute and queues the 61st", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: [] })),
    );
    // settle() attaches handlers immediately: no unhandled rejections while
    // the 61st request is still queued behind the window.
    const pending = Array.from({ length: 61 }, () =>
      settle(client.apiRequest({ operation: "TEST_TOKEN", tokenOverride: "x" })),
    );
    // Flush the serialized acquisition chain (microtasks, no timers needed).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(60);
    // Still throttled well inside the window.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(60);
    // Oldest timestamp ages out at +60s → the queued request proceeds.
    await vi.advanceTimersByTimeAsync(30_001);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(61);
    await Promise.all(pending);
  });
});
