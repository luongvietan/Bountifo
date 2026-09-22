import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../lib/api/errors";
import { BUGCROWD_SITE } from "../lib/constants";
import { radarKnownIssueSummarySchema } from "../lib/radar/deepTypes";

// ---------------------------------------------------------------------------
// Per-group Known Issues stats (Radar V1.5 — `ki_concentration` evidence).
//
// The collector's only sink is siteRequest — mocked at the module boundary so
// EVERY ApiError kind is reachable. The siteClient op itself is covered
// against the REAL module (vi.importActual) with a stubbed fetch, mirroring
// tests/radar-known-issues.test.ts.
//
// Fixtures under tests/fixtures/radar/site/*-ki-group-*.json carry the
// verified live envelope shape:
//   [{id, knownIssues:{stats:[{name, children[], uniqueCount,
//      duplicateCount}], totals:{unique,duplicate}}}]
// The website fixture's children[] deliberately sum to the parent row —
// parsed output proves sub-breakdowns are never double-counted.
// ---------------------------------------------------------------------------

const siteRequestMock = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequestMock(...args),
}));

import {
  fetchGroupKiStats,
  kiConcentrationScore,
  parseGroupKiStats,
  type GroupKiCategory,
} from "../lib/radar/groupStats";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "radar", "site");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** stats[] entry builder — valid by default, override per case. */
function stat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Cross Site Scripting (XSS)",
    uniqueCount: 5,
    duplicateCount: 2,
    children: [],
    ...overrides,
  };
}

/** Envelope builder: [{id, knownIssues:{stats, totals}}]. */
function envelope(
  id: string,
  stats: unknown[],
  extras: Record<string, unknown> = {},
): unknown[] {
  return [
    {
      id,
      knownIssues: { stats, totals: { unique: 0, duplicate: 0 }, ...extras },
    },
  ];
}

const FAILED = {
  status: "failed",
  categories: null,
} satisfies Awaited<ReturnType<typeof fetchGroupKiStats>>;

let realSiteClient: typeof import("../lib/api/siteClient");
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  siteRequestMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  realSiteClient = await vi.importActual("../lib/api/siteClient");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseGroupKiStats", () => {
  it("parses the live-shaped website fixture; children[] never double-count", () => {
    const parsed = parseGroupKiStats(
      fixture("webdotcom-ki-group-website.json"),
      "grp-website",
    );
    expect(parsed).not.toBeNull();
    // children[] sum to the parent (30+30=60 XSS uniques) — if they were
    // counted the total would double. totals{} is likewise recomputed.
    expect([...parsed!.categories.entries()]).toEqual([
      ["Cross Site Scripting (XSS)", { unique: 60, total: 85 }],
      ["Broken Access Control", { unique: 20, total: 25 }],
      ["Server Security Misconfiguration", { unique: 10, total: 10 }],
    ]);
  });

  it.each([
    ["an object", { id: "grp-website" }],
    ["a bare string", "grp-website"],
    ["a bare number", 42],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
  ])("non-array raw: %s → null", (_label, raw) => {
    expect(parseGroupKiStats(raw, "grp-website")).toBeNull();
  });

  it("an empty array has no matching element → null", () => {
    expect(parseGroupKiStats([], "grp-website")).toBeNull();
  });

  it.each([
    ["a different id", envelope("grp-other", [stat()])],
    ["no id at all", [{ knownIssues: { stats: [stat()] } }]],
    ["a numeric id", [{ id: 7, knownIssues: { stats: [stat()] } }]],
    [
      "only non-object elements",
      [null, "grp-website", [stat()]],
    ],
  ])("no element matches groupId: %s → null", (_label, raw) => {
    expect(parseGroupKiStats(raw, "grp-website")).toBeNull();
  });

  it("STRICT id match — a single-element response with a different id fails", () => {
    const raw = envelope("grp-api", [stat()]);
    expect(parseGroupKiStats(raw, "grp-website")).toBeNull();
    expect(parseGroupKiStats(raw, "grp-api")).not.toBeNull();
  });

  it("a multi-element array picks the matching id only", () => {
    const raw = [
      { id: "grp-other", knownIssues: { stats: [stat({ uniqueCount: 99 })] } },
      { id: "grp-website", knownIssues: { stats: [stat({ uniqueCount: 5 })] } },
      { id: "grp-third", knownIssues: { stats: [stat({ uniqueCount: 77 })] } },
    ];
    const parsed = parseGroupKiStats(raw, "grp-website");
    expect(parsed!.categories.get("Cross Site Scripting (XSS)")).toEqual({
      unique: 5,
      total: 7,
    });
    expect(parsed!.categories.size).toBe(1);
  });

  it("non-matching elements are never validated — garbage there cannot poison", () => {
    const raw = [
      null,
      "noise",
      { id: "grp-other", knownIssues: "not-an-object" },
      { id: "grp-website", knownIssues: { stats: [stat()] } },
    ];
    const parsed = parseGroupKiStats(raw, "grp-website");
    expect(parsed!.categories.get("Cross Site Scripting (XSS)")).toEqual({
      unique: 5,
      total: 7,
    });
  });

  it("multiple elements matching groupId are merged (element(s) are used)", () => {
    const raw = [
      {
        id: "grp-website",
        knownIssues: { stats: [stat({ name: "A", uniqueCount: 3 })] },
      },
      {
        id: "grp-website",
        knownIssues: {
          stats: [
            stat({ name: "A", uniqueCount: 4 }),
            stat({ name: "B", uniqueCount: 1, duplicateCount: 0 }),
          ],
        },
      },
    ];
    const parsed = parseGroupKiStats(raw, "grp-website");
    expect([...parsed!.categories.entries()]).toEqual([
      ["A", { unique: 7, total: 11 }],
      ["B", { unique: 1, total: 1 }],
    ]);
  });

  it("a second matching element with malformed stats still fails — strict within a match", () => {
    const raw = [
      { id: "grp-website", knownIssues: { stats: [stat()] } },
      { id: "grp-website", knownIssues: { stats: [{ name: 1 }] } },
    ];
    expect(parseGroupKiStats(raw, "grp-website")).toBeNull();
  });

  it.each([
    ["knownIssues missing", [{ id: "grp-website" }]],
    ["knownIssues null", [{ id: "grp-website", knownIssues: null }]],
    ["knownIssues a string", [{ id: "grp-website", knownIssues: "x" }]],
    ["knownIssues an array", [{ id: "grp-website", knownIssues: [] }]],
    [
      "stats missing",
      [{ id: "grp-website", knownIssues: { totals: {} } }],
    ],
    [
      "stats not an array",
      [{ id: "grp-website", knownIssues: { stats: { name: "x" } } }],
    ],
    [
      "stats a string",
      [{ id: "grp-website", knownIssues: { stats: "many" } }],
    ],
  ])("structural violation: %s → null", (_label, raw) => {
    expect(parseGroupKiStats(raw, "grp-website")).toBeNull();
  });

  it.each([
    ["entry is a string", ["x"]],
    ["entry is null", [null]],
    ["entry is an array", [[1, 2]]],
    ["name missing", [{ uniqueCount: 1, duplicateCount: 0 }]],
    ["name empty", [stat({ name: "" })]],
    ["name a number", [stat({ name: 9 })]],
    ["name null", [stat({ name: null })]],
    ["uniqueCount missing", [{ name: "A", duplicateCount: 0 }]],
    ["uniqueCount negative", [stat({ uniqueCount: -1 })]],
    ["uniqueCount float", [stat({ uniqueCount: 1.5 })]],
    ["uniqueCount string", [stat({ uniqueCount: "5" })]],
    ["uniqueCount null", [stat({ uniqueCount: null })]],
    ["uniqueCount NaN", [stat({ uniqueCount: Number.NaN })]],
    [
      "uniqueCount Infinity",
      [stat({ uniqueCount: Number.POSITIVE_INFINITY })],
    ],
    ["duplicateCount missing", [{ name: "A", uniqueCount: 1 }]],
    ["duplicateCount negative", [stat({ duplicateCount: -2 })]],
    ["duplicateCount float", [stat({ duplicateCount: 0.5 })]],
    ["duplicateCount string", [stat({ duplicateCount: "2" })]],
    ["duplicateCount null", [stat({ duplicateCount: null })]],
  ])("stats[] entry violation: %s → null", (_label, stats) => {
    expect(
      parseGroupKiStats(envelope("grp-website", stats), "grp-website"),
    ).toBeNull();
  });

  it("one bad entry poisons the whole element — never a partial stats list", () => {
    const stats = [stat({ name: "Good" }), stat({ name: "" })];
    expect(
      parseGroupKiStats(envelope("grp-website", stats), "grp-website"),
    ).toBeNull();
  });

  it("children[] content is ignored entirely — even malformed children parse", () => {
    const stats = [
      stat({
        children: [
          { name: "", uniqueCount: "junk" },
          null,
          "garbage",
          { noFields: true },
        ],
      }),
    ];
    const parsed = parseGroupKiStats(
      envelope("grp-website", stats),
      "grp-website",
    );
    expect(parsed!.categories.get("Cross Site Scripting (XSS)")).toEqual({
      unique: 5,
      total: 7,
    });
  });

  it("totals{} is ignored — absent or garbage totals still parse", () => {
    const noTotals = [
      { id: "grp-website", knownIssues: { stats: [stat()] } },
    ];
    expect(
      parseGroupKiStats(noTotals, "grp-website"),
    ).not.toBeNull();
    const badTotals = [
      {
        id: "grp-website",
        knownIssues: { stats: [stat()], totals: "nonsense" },
      },
    ];
    expect(
      parseGroupKiStats(badTotals, "grp-website"),
    ).not.toBeNull();
  });

  it("extra keys are tolerated — a benign upstream addition must not fail", () => {
    const raw = [
      {
        id: "grp-website",
        future_field: { nested: [1] },
        knownIssues: {
          stats: [stat({ extra: true })],
          totals: { unique: 0, duplicate: 0 },
          another: "field",
        },
      },
    ];
    expect(parseGroupKiStats(raw, "grp-website")).not.toBeNull();
  });

  it("an empty stats[] parses to an empty map — a group with no issues", () => {
    const parsed = parseGroupKiStats(
      envelope("grp-website", []),
      "grp-website",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.categories.size).toBe(0);
  });

  it("a real zero pair is data, not a violation", () => {
    const stats = [stat({ uniqueCount: 0, duplicateCount: 0 })];
    const parsed = parseGroupKiStats(
      envelope("grp-website", stats),
      "grp-website",
    );
    expect(parsed!.categories.get("Cross Site Scripting (XSS)")).toEqual({
      unique: 0,
      total: 0,
    });
  });

  it("duplicate category names within stats[] are summed", () => {
    const stats = [
      stat({ name: "Same", uniqueCount: 3, duplicateCount: 1 }),
      stat({ name: "Same", uniqueCount: 2, duplicateCount: 4 }),
    ];
    const parsed = parseGroupKiStats(
      envelope("grp-website", stats),
      "grp-website",
    );
    expect(parsed!.categories.get("Same")).toEqual({ unique: 5, total: 10 });
  });

  it("is pure — identical input yields an equal fresh map", () => {
    const raw = envelope("grp-website", [stat()]);
    const a = parseGroupKiStats(raw, "grp-website");
    const b = parseGroupKiStats(raw, "grp-website");
    expect(a).toEqual(b);
    expect(a!.categories).not.toBe(b!.categories);
  });
});

describe("fetchGroupKiStats", () => {
  it("empty groupIds → complete with [] and zero requests (the gate decides)", async () => {
    await expect(fetchGroupKiStats("webdotcom", [])).resolves.toEqual({
      status: "complete",
      categories: [],
    });
    expect(siteRequestMock).not.toHaveBeenCalled();
  });

  it("fetches one group per id via GET_GROUP_KI_STATS", async () => {
    siteRequestMock.mockResolvedValue({
      data: fixture("webdotcom-ki-group-website.json"),
      status: 200,
    });
    await fetchGroupKiStats("webdotcom", ["grp-website"]);
    expect(siteRequestMock).toHaveBeenCalledTimes(1);
    expect(siteRequestMock).toHaveBeenCalledWith({
      operation: "GET_GROUP_KI_STATS",
      slug: "webdotcom",
      groupId: "grp-website",
    });
  });

  it("a single group yields its sorted categories", async () => {
    siteRequestMock.mockResolvedValue({
      data: fixture("webdotcom-ki-group-website.json"),
      status: 200,
    });
    const res = await fetchGroupKiStats("webdotcom", ["grp-website"]);
    expect(res).toEqual({
      status: "complete",
      categories: [
        { category: "Cross Site Scripting (XSS)", unique: 60, total: 85 },
        { category: "Broken Access Control", unique: 20, total: 25 },
        {
          category: "Server Security Misconfiguration",
          unique: 10,
          total: 10,
        },
      ] satisfies GroupKiCategory[],
    });
  });

  it("aggregates categories across groups by name (unique +=, total +=)", async () => {
    siteRequestMock.mockImplementation(
      async (opts: { groupId?: string }) => ({
        data:
          opts.groupId === "grp-website"
            ? fixture("webdotcom-ki-group-website.json")
            : fixture("webdotcom-ki-group-api.json"),
        status: 200,
      }),
    );
    const res = await fetchGroupKiStats("webdotcom", [
      "grp-website",
      "grp-api",
    ]);
    expect(siteRequestMock).toHaveBeenCalledTimes(2);
    expect(res).toEqual({
      status: "complete",
      categories: [
        { category: "Cross Site Scripting (XSS)", unique: 75, total: 103 },
        { category: "SQL Injection", unique: 40, total: 50 },
        { category: "Broken Access Control", unique: 20, total: 25 },
        {
          category: "Server Security Misconfiguration",
          unique: 10,
          total: 10,
        },
      ] satisfies GroupKiCategory[],
    });
  });

  it("the aggregated categories satisfy the deep-envelope schema", async () => {
    siteRequestMock.mockResolvedValue({
      data: fixture("webdotcom-ki-group-api.json"),
      status: 200,
    });
    const res = await fetchGroupKiStats("webdotcom", ["grp-api"]);
    expect(res.status).toBe("complete");
    const summary = {
      status: "complete",
      unique_count: 95,
      total_count: 108,
      categories: res.categories,
    };
    expect(radarKnownIssueSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("sort order is canonical: unique DESC, ties broken category ASC", async () => {
    siteRequestMock.mockImplementation(async (opts: { groupId?: string }) => ({
      data:
        opts.groupId === "g1"
          ? envelope("g1", [
              stat({ name: "Zulu", uniqueCount: 10, duplicateCount: 0 }),
              stat({ name: "Alpha", uniqueCount: 10, duplicateCount: 5 }),
            ])
          : envelope("g2", [
              stat({ name: "Mid", uniqueCount: 30, duplicateCount: 0 }),
              stat({ name: "Alpha", uniqueCount: 10, duplicateCount: 1 }),
            ]),
      status: 200,
    }));
    const res = await fetchGroupKiStats("slug", ["g1", "g2"]);
    expect(res.categories!.map((c) => c.category)).toEqual([
      "Mid", // 30
      "Alpha", // 20 — tie-broken ahead of Zulu on code-unit order
      "Zulu", // 10
    ]);
    // Aggregation on the tied row: Alpha unique 10+10, total (10+5)+(10+1).
    expect(res.categories![1]).toEqual({
      category: "Alpha",
      unique: 20,
      total: 26,
    });
  });

  it("one group failing to parse fails the whole breakdown — never partial", async () => {
    siteRequestMock.mockImplementation(async (opts: { groupId?: string }) => ({
      data:
        opts.groupId === "grp-website"
          ? fixture("webdotcom-ki-group-website.json")
          : envelope("grp-api", [stat({ uniqueCount: -1 })]),
      status: 200,
    }));
    const res = await fetchGroupKiStats("webdotcom", [
      "grp-website",
      "grp-api",
    ]);
    expect(res).toEqual(FAILED);
    // All requests were still fired — Promise.all over the full id list.
    expect(siteRequestMock).toHaveBeenCalledTimes(2);
  });

  it("a group whose response carries no matching element → failed", async () => {
    siteRequestMock.mockImplementation(async (opts: { groupId?: string }) => ({
      data:
        opts.groupId === "grp-website"
          ? fixture("webdotcom-ki-group-website.json")
          : envelope("someone-else", [stat()]),
      status: 200,
    }));
    await expect(
      fetchGroupKiStats("webdotcom", ["grp-website", "grp-api"]),
    ).resolves.toEqual(FAILED);
  });

  it.each([
    "unauthorized",
    "forbidden",
    "not_found",
    "invalid_response",
    "http",
    "network",
    "rate_limited",
    "no_token",
    "storage_locked",
  ] as const)("ApiError %s on any group → failed (never a partial sample)", async (kind) => {
    siteRequestMock.mockImplementation(async (opts: { groupId?: string }) => {
      if (opts.groupId === "grp-api") throw new ApiError(kind, kind);
      return {
        data: fixture("webdotcom-ki-group-website.json"),
        status: 200,
      };
    });
    await expect(
      fetchGroupKiStats("webdotcom", ["grp-website", "grp-api"]),
    ).resolves.toEqual(FAILED);
  });

  it("non-ApiError plumbing failures → failed; the call never rejects", async () => {
    siteRequestMock.mockRejectedValue(new TypeError("weird"));
    await expect(fetchGroupKiStats("slug", ["g1"])).resolves.toEqual(FAILED);
    siteRequestMock.mockRejectedValue("a bare string rejection");
    await expect(fetchGroupKiStats("slug", ["g1"])).resolves.toEqual(FAILED);
  });

  it("a client-side invalid groupId (TypeError from buildUrl) → failed", async () => {
    // The real client would throw TypeError for "bad/id"; the mock is
    // already the boundary, so simulate its contract.
    siteRequestMock.mockRejectedValue(
      new TypeError("siteRequest: GET_GROUP_KI_STATS requires a groupId"),
    );
    await expect(fetchGroupKiStats("slug", ["bad/id"])).resolves.toEqual(
      FAILED,
    );
  });

  it("is deterministic — same responses, same canonical output", async () => {
    siteRequestMock.mockImplementation(async (opts: { groupId?: string }) => ({
      data:
        opts.groupId === "grp-website"
          ? fixture("webdotcom-ki-group-website.json")
          : fixture("webdotcom-ki-group-api.json"),
      status: 200,
    }));
    const a = await fetchGroupKiStats("webdotcom", ["grp-api", "grp-website"]);
    const b = await fetchGroupKiStats("webdotcom", ["grp-website", "grp-api"]);
    // Id ORDER must not matter: the canonical sort is over content, not
    // fetch order — source_hash stability depends on it.
    expect(a).toEqual(b);
  });
});

describe("siteRequest GET_GROUP_KI_STATS (real client, stubbed fetch)", () => {
  it("requests target_groups/<gid>/known_issue_stats with session cookies", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fixture("webdotcom-ki-group-api.json")));
    const res = await realSiteClient.siteRequest({
      operation: "GET_GROUP_KI_STATS",
      slug: "webdotcom",
      groupId: "grp-api",
    });
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      `${BUGCROWD_SITE}/engagements/webdotcom/target_groups/grp-api/known_issue_stats`,
    );
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toContain("application/json");
    expect(headers.Authorization).toBeUndefined();
  });

  it.each(["A-b_c9", "grp1", "XYZ"])(
    "accepts groupId %j from the id alphabet [A-Za-z0-9_-]",
    async (groupId) => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await realSiteClient.siteRequest({
        operation: "GET_GROUP_KI_STATS",
        slug: "webdotcom",
        groupId,
      });
      const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(
        `${BUGCROWD_SITE}/engagements/webdotcom/target_groups/${groupId}/known_issue_stats`,
      );
    },
  );

  it.each(["", "bad id", "a/b", "../escape", "id?x=1", "id.2"])(
    "rejects invalid groupId %j before any fetch",
    async (groupId) => {
      await expect(
        realSiteClient.siteRequest({
          operation: "GET_GROUP_KI_STATS",
          slug: "webdotcom",
          groupId,
        }),
      ).rejects.toThrow(/requires a groupId/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("kiConcentrationScore", () => {
  it("empty input → null", () => {
    expect(kiConcentrationScore([])).toBeNull();
  });

  it("rows whose unique is all null → null (nothing numeric to weigh)", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: null, total: null },
        { category: "B", unique: null, total: 4 },
      ]),
    ).toBeNull();
  });

  it("sum of uniques = 0 → null — a complete payload contradicting a nonzero aggregate is unknown, not 0", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: 0, total: 0 },
        { category: "B", unique: 0, total: 3 },
      ]),
    ).toBeNull();
  });

  it("a single category → exactly 1", () => {
    expect(
      kiConcentrationScore([{ category: "A", unique: 42, total: 90 }]),
    ).toBe(1);
  });

  it("an even spread reads low — four equal shares → 0.25", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: 25, total: 40 },
        { category: "B", unique: 25, total: 30 },
        { category: "C", unique: 25, total: 25 },
        { category: "D", unique: 25, total: 50 },
      ]),
    ).toBe(0.25);
  });

  it("the top category's share: 80 of 100 → 0.8", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: 80, total: 200 },
        { category: "B", unique: 20, total: 30 },
      ]),
    ).toBe(0.8);
  });

  it("null-unique rows are skipped, not zeroed into the sum", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: 80, total: null },
        { category: "B", unique: null, total: 500 },
        { category: "C", unique: 20, total: 20 },
      ]),
    ).toBe(0.8);
  });

  it("non-finite uniques are skipped — NaN/Infinity cannot poison the share", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: Number.NaN, total: 1 },
        { category: "B", unique: Number.POSITIVE_INFINITY, total: 1 },
        { category: "C", unique: 3, total: 3 },
        { category: "D", unique: 1, total: 1 },
      ]),
    ).toBe(0.75);
  });

  it("rounds to 4 decimals — a 1/3 top share → 0.3333", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: 1, total: 1 },
        { category: "B", unique: 1, total: 1 },
        { category: "C", unique: 1, total: 1 },
      ]),
    ).toBe(0.3333);
  });

  it("is monotone nondecreasing in the top category's share", () => {
    // Fixed pool of 100 uniques split two ways: sweep the leader 50 → 99
    // (below 50 the OTHER row would be the max — the share is max/sum).
    let prev = -1;
    for (let top = 50; top <= 99; top += 1) {
      const value = kiConcentrationScore([
        { category: "Top", unique: top, total: top },
        { category: "Rest", unique: 100 - top, total: 100 - top },
      ]);
      expect(value).not.toBeNull();
      expect(value!).toBeGreaterThanOrEqual(prev);
      prev = value!;
    }
  });

  it("`total` never enters the score — unique volume only", () => {
    expect(
      kiConcentrationScore([
        { category: "A", unique: 5, total: 9999 },
        { category: "B", unique: 5, total: 1 },
      ]),
    ).toBe(0.5);
  });

  it("the aggregated fixture pair concentrates at 75/145 → 0.5172", () => {
    const categories: GroupKiCategory[] = [
      { category: "Cross Site Scripting (XSS)", unique: 75, total: 103 },
      { category: "SQL Injection", unique: 40, total: 50 },
      { category: "Broken Access Control", unique: 20, total: 25 },
      { category: "Server Security Misconfiguration", unique: 10, total: 10 },
    ];
    expect(kiConcentrationScore(categories)).toBe(0.5172);
  });

  it("is deterministic — same input, same output", () => {
    const rows = [
      { category: "A", unique: 7, total: 9 },
      { category: "B", unique: 3, total: 3 },
    ];
    expect(kiConcentrationScore(rows)).toBe(kiConcentrationScore(rows));
  });
});
