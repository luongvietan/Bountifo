import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BUGCROWD_SITE } from "../lib/constants";

// Same fresh-module pattern as api-client.test.ts: siteClient keeps a
// module-level rate bucket, so each test re-imports after
// vi.resetModules(). No credential setup — the site client is
// session-cookie based and must never touch storage.

type SiteClientModule = typeof import("../lib/api/siteClient");
type ErrorsModule = typeof import("../lib/api/errors");

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function htmlResponse(
  body: string,
  init: { status?: number; url?: string; redirected?: boolean } = {},
): Response {
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  // Response.redirected / .url are read-only; redefine for the redirect cases.
  if (init.redirected === true || init.url !== undefined) {
    Object.defineProperty(res, "redirected", {
      value: init.redirected === true,
    });
    Object.defineProperty(res, "url", { value: init.url ?? "" });
  }
  return res;
}

let client: SiteClientModule;
let errors: ErrorsModule;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  errors = await import("../lib/api/errors");
  client = await import("../lib/api/siteClient");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true, value }) as const,
    (err) => ({ ok: false, err }) as const,
  );
}

const INDEX_BODY = {
  engagements: [{ name: "X", briefUrl: "/engagements/x" }],
  paginationMeta: { limit: 24, totalCount: 1 },
};

describe("siteRequest URL and request construction", () => {
  it("LIST_INDEX requests the engagements.json page with session cookies", async () => {
    fetchMock.mockResolvedValue(jsonResponse(INDEX_BODY));
    const res = await client.siteRequest({ operation: "LIST_INDEX", page: 3 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual(INDEX_BODY);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BUGCROWD_SITE}/engagements.json?page=3`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toContain("application/json");
    // Session auth only — never a stored credential.
    expect(headers.Authorization).toBeUndefined();
  });

  it("LIST_INDEX defaults to page 1", async () => {
    fetchMock.mockResolvedValue(jsonResponse(INDEX_BODY));
    await client.siteRequest({ operation: "LIST_INDEX" });
    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BUGCROWD_SITE}/engagements.json?page=1`);
  });

  it("GET_BRIEF requests the brief HTML for the slug", async () => {
    fetchMock.mockResolvedValue(htmlResponse("<html></html>"));
    const res = await client.siteRequest({
      operation: "GET_BRIEF",
      slug: "webdotcom",
    });
    expect(res.data).toBe("<html></html>");
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BUGCROWD_SITE}/engagements/webdotcom`);
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toContain("text/html");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("siteRequest error mapping", () => {
  it("maps 401/403/404 to the matching ApiError kinds", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        new Response("nope", { status }),
      );
      await expect(
        client.siteRequest({ operation: "LIST_INDEX" }),
      ).rejects.toMatchObject({ kind });
    }
  });

  it("treats a redirect to the login host as unauthorized", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse("<html>login</html>", {
        redirected: true,
        url: "https://identity.bugcrowd.com/login?next=...",
      }),
    );
    await expect(
      client.siteRequest({ operation: "GET_BRIEF", slug: "private-prog" }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects a non-JSON body on LIST_INDEX as invalid_response", async () => {
    fetchMock.mockResolvedValue(htmlResponse("<html>spa shell</html>"));
    await expect(
      client.siteRequest({ operation: "LIST_INDEX" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("maps a non-2xx status to http", async () => {
    fetchMock.mockResolvedValue(new Response("teapot", { status: 418 }));
    await expect(
      client.siteRequest({ operation: "LIST_INDEX" }),
    ).rejects.toMatchObject({ kind: "http" });
  });
});

describe("siteRequest retries", () => {
  it("honors Retry-After once on 429, then backs off", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(INDEX_BODY));
    const p = settle(client.siteRequest({ operation: "LIST_INDEX" }));
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await p;
    expect(out).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off on 5xx and network errors, gives up at 4 attempts", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("x", { status: 500 }))
      .mockRejectedValueOnce(new TypeError("boom"))
      .mockRejectedValueOnce(new TypeError("boom"))
      .mockRejectedValueOnce(new TypeError("boom"));
    const p = settle(client.siteRequest({ operation: "LIST_INDEX" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await p;
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect((out.err as InstanceType<ErrorsModule["ApiError"]>).kind).toBe(
        "network",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
