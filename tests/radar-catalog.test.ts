import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { API_BASE } from "../lib/constants";

// Same fresh-module pattern as api-engagements.test.ts: lib/api/client.ts
// keeps a module-level rate bucket, so each test re-imports the catalog
// module (and its client dependency) after vi.resetModules().

const CREDENTIAL = "test-credential-4f8c2b91";
const TS = "2026-09-21T00:00:00.000Z";

type CatalogModule = typeof import("../lib/radar/catalog");

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

function uuidOf(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function engagement(uuid: string, attributes: Record<string, unknown> = {}) {
  return { type: "engagement", id: uuid, attributes };
}

/** A LIST_ENGAGEMENTS page containing `count` unique engagement rows. */
function fullPage(offset: number, count = 25): object {
  return {
    data: Array.from({ length: count }, (_, i) =>
      engagement(uuidOf(offset + i + 1), { code: `prog-${offset + i + 1}` }),
    ),
  };
}

function pageFor(rows: unknown[]): object {
  return { data: rows };
}

let catalog: CatalogModule;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  vi.useFakeTimers();
  stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
  await fakeBrowser.storage.local.set({ apiCredential: CREDENTIAL });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  catalog = await import("../lib/radar/catalog");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseCatalogPage", () => {
  it("extracts identity fields and stamps discovered_at", () => {
    const { items, rawCount } = catalog.parseCatalogPage(
      {
        data: [
          engagement("uuid-1", {
            code: "acme-bb",
            name: "Acme Bug Bounty",
            state: "running",
            engagement_type: "bug_bounty",
          }),
        ],
      },
      TS,
    );
    expect(rawCount).toBe(1);
    expect(items).toEqual([
      {
        uuid: "uuid-1",
        code: "acme-bb",
        name: "Acme Bug Bounty",
        lifecycle_status: "running",
        engagement_type: "bug_bounty",
        discovered_at: TS,
      },
    ]);
  });

  it("falls back to the engagement URL slug when code is absent", () => {
    const { items } = catalog.parseCatalogPage(
      {
        data: [
          engagement("uuid-2", {
            url: "https://bugcrowd.com/engagements/sluggy-prog",
          }),
        ],
      },
      TS,
    );
    expect(items[0]?.code).toBe("sluggy-prog");
  });

  it("keeps code null when neither attributes.code nor a slug exists", () => {
    const { items } = catalog.parseCatalogPage(
      { data: [engagement("uuid-3", { name: "No code" })] },
      TS,
    );
    expect(items[0]?.code).toBeNull();
  });

  it("ignores non-engagement and malformed rows but counts them in rawCount", () => {
    const { items, rawCount } = catalog.parseCatalogPage(
      {
        data: [
          engagement("uuid-1", { code: "ok" }),
          { type: "program", id: "uuid-x", attributes: { code: "nope" } },
          { type: "engagement", attributes: { code: "no-id" } },
          "garbage",
          42,
          null,
        ],
      },
      TS,
    );
    expect(rawCount).toBe(6);
    expect(items.map((i) => i.uuid)).toEqual(["uuid-1"]);
  });

  it("flags missing/non-array data and non-object bodies as malformed", () => {
    for (const bad of [null, {}, { data: {} }, 42, "x", { meta: {} }]) {
      expect(catalog.parseCatalogPage(bad, TS)).toEqual({
        items: [],
        rawCount: 0,
        malformed: true,
      });
    }
  });

  it("treats data: [] as a valid empty page, not malformed", () => {
    expect(catalog.parseCatalogPage({ data: [] }, TS)).toEqual({
      items: [],
      rawCount: 0,
      malformed: false,
    });
  });
});

describe("enumerateEngagementCatalog", () => {
  it("completes after a single short page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        pageFor([
          engagement("uuid-1", { code: "a", name: "A" }),
          engagement("uuid-2", { code: "b" }),
        ]),
      ),
    );
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(1);
    expect(res.warnings).toEqual([]);
    expect(res.items.map((i) => i.uuid)).toEqual(["uuid-1", "uuid-2"]);
    expect(res.items[0]).toMatchObject({
      code: "a",
      name: "A",
      discovered_at: TS,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${API_BASE}/engagements?page[number]=1&page[size]=25`,
    );
  });

  it("pages through full pages until a short final page", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) return jsonResponse(fullPage(0));
      if (u.includes("page[number]=2")) return jsonResponse(fullPage(25));
      return jsonResponse(pageFor([engagement("uuid-last")]));
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(3);
    expect(res.items).toHaveLength(51);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain(
        `${API_BASE}/engagements?page[number]=`,
      );
    }
  });

  it("treats a page with exactly 25 rows as full and keeps paging", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) return jsonResponse(fullPage(0));
      return jsonResponse({ data: [] });
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(2);
    expect(res.items).toHaveLength(25);
  });

  it("counts malformed rows toward page fullness", async () => {
    const junkRows = [
      engagement("uuid-1"),
      { type: "program", id: "p1" },
      "garbage",
      ...Array.from({ length: 22 }, (_, i) => engagement(uuidOf(10 + i))),
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) {
        return jsonResponse(pageFor(junkRows));
      }
      return jsonResponse({ data: [] });
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    // 25 raw rows → not a short page → page 2 fetched even though only 23
    // valid engagements came out of page 1.
    expect(res.pages_fetched).toBe(2);
    expect(res.status).toBe("complete");
    expect(res.items).toHaveLength(23);
  });

  it("dedupes by uuid keeping the first occurrence", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) {
        return jsonResponse(
          pageFor([
            engagement("uuid-1", { code: "first" }),
            ...Array.from({ length: 24 }, (_, i) =>
              engagement(uuidOf(100 + i)),
            ),
          ]),
        );
      }
      return jsonResponse(
        pageFor([
          engagement("uuid-1", { code: "dup-should-lose" }),
          engagement("uuid-new"),
        ]),
      );
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    const uuids = res.items.map((i) => i.uuid);
    expect(uuids.filter((u) => u === "uuid-1")).toHaveLength(1);
    expect(uuids[0]).toBe("uuid-1");
    expect(res.items[0]?.code).toBe("first");
    expect(uuids.at(-1)).toBe("uuid-new");
    expect(res.items).toHaveLength(26);
  });

  it("keeps deterministic first-seen ordering across pages", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) {
        return jsonResponse(
          pageFor([
            engagement("b-first", { code: "b" }),
            ...Array.from({ length: 23 }, (_, i) => engagement(`m${i}`)),
            engagement("a-second-page-dup"),
          ]),
        );
      }
      return jsonResponse(
        pageFor([
          engagement("a-second-page-dup"),
          engagement("z-last"),
        ]),
      );
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.items.map((i) => i.uuid)).toEqual([
      "b-first",
      ...Array.from({ length: 23 }, (_, i) => `m${i}`),
      "a-second-page-dup",
      "z-last",
    ]);
  });

  it("reports failed with malformed_page when a 200 page lacks data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ meta: { page: 1 } }));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("malformed_page");
    expect(res.pages_fetched).toBe(0);
    expect(res.items).toEqual([]);
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL);
  });

  it("reports failed with malformed_page when data is not an array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { not: "an-array" } }),
    );
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("malformed_page");
    expect(res.items).toEqual([]);
  });

  it("reports failed with malformed_page for a non-object body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(42));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("malformed_page");
  });

  it("reports partial — never complete — when a later page is malformed", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) return jsonResponse(fullPage(0));
      if (u.includes("page[number]=2")) return jsonResponse(fullPage(25));
      return jsonResponse({ unexpected: "shape" });
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("partial");
    expect(res.warnings).toContain("malformed_page");
    // Pages 1–2 were fetched and parsed cleanly; their 50 items survive.
    expect(res.pages_fetched).toBe(2);
    expect(res.items).toHaveLength(50);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats a first-page data: [] as a legitimately complete empty catalog", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(1);
    expect(res.warnings).toEqual([]);
    expect(res.items).toEqual([]);
  });

  it("reports failed with items collected so far when the API errors", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) return jsonResponse(fullPage(0));
      return jsonResponse({}, { status: 403 });
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.pages_fetched).toBe(1);
    expect(res.items).toHaveLength(25);
    expect(res.warnings.some((w) => w.includes("forbidden"))).toBe(true);
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL);
  });

  it("reports failed with the rate_limited kind after persistent 429s", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    const promise = catalog.enumerateEngagementCatalog(TS);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await promise;
    expect(res.status).toBe("failed");
    expect(res.pages_fetched).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.warnings.some((w) => w.includes("rate_limited"))).toBe(true);
  });

  it("reports failed when the credential is missing", async () => {
    await fakeBrowser.storage.local.remove("apiCredential");
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings.some((w) => w.includes("no_token"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports partial — never complete — when page 100 is still full", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      const m = /page\[number\]=(\d+)/.exec(u);
      const page = Number(m?.[1] ?? 0);
      return jsonResponse(fullPage((page - 1) * 25));
    });
    const promise = catalog.enumerateEngagementCatalog(TS);
    // The shared rate bucket admits 60 req/min; advance past the window so
    // pages 61–100 can acquire slots.
    await vi.advanceTimersByTimeAsync(120_000);
    const res = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(res.status).toBe("partial");
    expect(res.pages_fetched).toBe(100);
    expect(res.items).toHaveLength(2500);
    expect(res.warnings).toContain("page_limit_reached");
  });
});
