import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BUGCROWD_SITE } from "../lib/constants";

// Same fresh-module pattern as before: lib/api/siteClient.ts keeps a
// module-level rate bucket, so each test re-imports the catalog module (and
// its client dependency) after vi.resetModules(). No credential setup — the
// site catalog is session-cookie based.

const TS = "2026-09-21T00:00:00.000Z";
const PAGE_LIMIT = 24;

type CatalogModule = typeof import("../lib/radar/catalog");

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

/** One engagements.json index row. briefUrl carries the slug — the item's
 *  canonical identity on the researcher surface. */
function indexEntry(
  slug: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: `Program ${slug}`,
    tagline: "tagline",
    briefUrl: `/engagements/${slug}`,
    accessStatus: "open",
    productEngagementType: { label: "Bug Bounty", iconVariant: "bug-bounty" },
    isPrivate: false,
    ...over,
  };
}

/** An engagements.json page: `totalCount` defaults to the row count. */
function indexPage(
  rows: unknown[],
  total?: number,
  limit: number = PAGE_LIMIT,
): object {
  return {
    engagements: rows,
    paginationMeta: { limit, totalCount: total ?? rows.length },
  };
}

/** A page of `count` unique entries starting at `offset`. */
function fullPage(offset: number, count = PAGE_LIMIT, total = 10_000): object {
  return indexPage(
    Array.from({ length: count }, (_, i) => indexEntry(`prog-${offset + i}`)),
    total,
  );
}

let catalog: CatalogModule;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  vi.useFakeTimers();
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
      indexPage([
        indexEntry("acme-bb", {
          name: "Acme Bug Bounty",
          accessStatus: "open",
          productEngagementType: {
            label: "Bug Bounty",
            iconVariant: "bug-bounty",
          },
        }),
      ]),
      TS,
    );
    expect(rawCount).toBe(1);
    expect(items).toEqual([
      {
        uuid: "acme-bb",
        code: "acme-bb",
        name: "Acme Bug Bounty",
        lifecycle_status: "open",
        engagement_type: "Bug Bounty",
        discovered_at: TS,
      },
    ]);
  });

  it("skips rows without a parseable engagement slug but counts them raw", () => {
    const { items, rawCount } = catalog.parseCatalogPage(
      indexPage([
        indexEntry("good-one"),
        indexEntry("broken-url", { briefUrl: "javascript:void(0)" }),
        { name: "no briefUrl at all" },
        "garbage",
        42,
        null,
      ]),
      TS,
    );
    expect(rawCount).toBe(6);
    expect(items.map((i) => i.uuid)).toEqual(["good-one"]);
  });

  it("flags missing/non-array engagements and non-object bodies as malformed", () => {
    for (const bad of [
      null,
      {},
      { engagements: {} },
      42,
      "x",
      { paginationMeta: { limit: 24, totalCount: 5 } },
    ]) {
      expect(catalog.parseCatalogPage(bad, TS)).toEqual({
        items: [],
        rawCount: 0,
        malformed: true,
      });
    }
  });

  it("treats engagements: [] as a valid empty page, not malformed", () => {
    expect(
      catalog.parseCatalogPage(indexPage([]), TS),
    ).toEqual({ items: [], rawCount: 0, malformed: false });
  });

  it("survives a missing paginationMeta", () => {
    const { items, rawCount, malformed } = catalog.parseCatalogPage(
      { engagements: [indexEntry("solo")] },
      TS,
    );
    expect(malformed).toBe(false);
    expect(rawCount).toBe(1);
    expect(items[0]?.uuid).toBe("solo");
  });
});

describe("enumerateEngagementCatalog", () => {
  it("completes after a single page when totalCount is reached", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(indexPage([indexEntry("a"), indexEntry("b")], 2)),
    );
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(1);
    expect(res.warnings).toEqual([]);
    expect(res.items.map((i) => i.uuid)).toEqual(["a", "b"]);
    expect(res.items[0]).toMatchObject({
      code: "a",
      name: "Program a",
      discovered_at: TS,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BUGCROWD_SITE}/engagements.json?page=1`);
    expect(init.credentials).toBe("include");
  });

  it("pages through full pages until totalCount is exhausted", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("page=1")) return jsonResponse(fullPage(0, 24, 50));
      if (u.endsWith("page=2")) return jsonResponse(fullPage(24, 24, 50));
      return jsonResponse(indexPage([indexEntry("last")], 50));
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(3);
    expect(res.items).toHaveLength(49);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops without another request when a full page reaches totalCount", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage(0, 24, 24)));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(1);
    expect(res.items).toHaveLength(24);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on a short page even when totalCount claims more", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(indexPage([indexEntry("a"), indexEntry("b")], 500)),
    );
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(1);
    expect(res.items).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts malformed rows toward page fullness", async () => {
    const junkRows = [
      indexEntry("ok-1"),
      { name: "no slug" },
      "garbage",
      ...Array.from({ length: 21 }, (_, i) => indexEntry(`ok-${i + 2}`)),
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("page=1")) return jsonResponse(indexPage(junkRows, 25));
      return jsonResponse(indexPage([indexEntry("tail")], 25));
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    // 24 raw rows → full page → page 2 fetched even though only 22 valid
    // items came out of page 1.
    expect(res.pages_fetched).toBe(2);
    expect(res.status).toBe("complete");
    expect(res.items).toHaveLength(23);
  });

  it("dedupes by slug keeping the first occurrence", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("page=1")) {
        return jsonResponse(
          indexPage(
            [
              indexEntry("dup", { name: "first" }),
              ...Array.from({ length: 23 }, (_, i) => indexEntry(`p${i}`)),
            ],
            26,
          ),
        );
      }
      return jsonResponse(
        indexPage(
          [
            indexEntry("dup", { name: "dup-should-lose" }),
            indexEntry("new-one"),
          ],
          26,
        ),
      );
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    const slugs = res.items.map((i) => i.uuid);
    expect(slugs.filter((s) => s === "dup")).toHaveLength(1);
    expect(res.items[0]?.name).toBe("first");
    expect(slugs.at(-1)).toBe("new-one");
    expect(res.items).toHaveLength(25);
  });

  it("reports failed with malformed_page when a 200 page lacks engagements", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ meta: { page: 1 } }));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("malformed_page");
    expect(res.pages_fetched).toBe(0);
    expect(res.items).toEqual([]);
  });

  it("reports failed with malformed_page when engagements is not an array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ engagements: { not: "an-array" } }),
    );
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("malformed_page");
  });

  it("reports failed with malformed_page for a non-object body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(42));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("malformed_page");
  });

  it("reports failed for a non-JSON answer (SPA shell / login markup)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.warnings).toContain("invalid_response");
  });

  it("reports partial — never complete — when a later page is malformed", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("page=1")) return jsonResponse(fullPage(0, 24, 60));
      if (u.endsWith("page=2")) return jsonResponse(fullPage(24, 24, 60));
      return jsonResponse({ unexpected: "shape" });
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("partial");
    expect(res.warnings).toContain("malformed_page");
    expect(res.pages_fetched).toBe(2);
    expect(res.items).toHaveLength(48);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats an empty first page as a legitimately complete empty catalog", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(indexPage([], 0)));
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("complete");
    expect(res.pages_fetched).toBe(1);
    expect(res.items).toEqual([]);
  });

  it("reports failed with items collected so far when the site errors", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("page=1")) return jsonResponse(fullPage(0, 24, 60));
      return jsonResponse({}, { status: 403 });
    });
    const res = await catalog.enumerateEngagementCatalog(TS);
    expect(res.status).toBe("failed");
    expect(res.pages_fetched).toBe(1);
    expect(res.items).toHaveLength(24);
    expect(res.warnings.some((w) => w.includes("forbidden"))).toBe(true);
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

  it("reports partial — never complete — when page 100 is still short of totalCount", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? 0);
      return jsonResponse(fullPage((page - 1) * PAGE_LIMIT, PAGE_LIMIT, 100_000));
    });
    const promise = catalog.enumerateEngagementCatalog(TS);
    // The shared rate bucket admits 60 req/min; advance past the window so
    // pages 61–100 can acquire slots.
    await vi.advanceTimersByTimeAsync(120_000);
    const res = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(res.status).toBe("partial");
    expect(res.pages_fetched).toBe(100);
    expect(res.items).toHaveLength(2400);
    expect(res.warnings).toContain("page_limit_reached");
  });
});
