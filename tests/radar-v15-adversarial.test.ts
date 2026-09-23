import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/errors";
import type { CatalogScanResult } from "../lib/radar/catalog";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.5 adversarial pins.
//
// Pins the plan's Review-Focus behaviors end to end: the site client is the
// only network sink and is mocked at the module boundary, so the REAL
// enumerate → hydrate → deepHydrate pipeline runs and every outbound request
// is counted by operation/versionId/groupId. Pure pins (payout edges,
// surface URL shape, percentile arithmetic) exercise the functions directly.
//
// Contract under test (docs/superpowers/plans/2026-09-23-radar-v1.5.md):
//   - changelog < 2 entries → arc "no_baseline"; exactly 2 → the arc baseline
//     IS the step baseline and the doc is fetched ONCE (dedupe).
//   - arc baseline fetch fails while the step baseline succeeds → arc
//     "unavailable", semantic_diff "complete", envelope "partial", and
//     deep_enriched still counts the completed diff.
//   - an unaddressable qualifying group id fails the whole breakdown BEFORE
//     any request — groups_fetched 0, never a partial sample.
//   - group_stats "complete" with categories summing to 0 while the aggregate
//     reported uniques → ki_concentration null, group_stats still "complete".
//   - percentile cohort = eligible ∧ minConfidence-passing, computed before
//     `limit` — the displayed page cannot inflate it; bottom reads 0.0.
//   - average_payout "$0"/0 → a REAL 0; negative/absent/malformed → null.
//   - surface: first path segment percent-decoded + lowercased; deep tokens,
//     version-only paths, userinfo, non-http(s) and scheme-less still false.
//   - envelope: all four sub-sources terminal-OK → "complete"; any terminal
//     plus any failure → "partial". (skipped_* group-stats states are
//     terminal-OK, so a failed aggregate + skipped breakdown reads "partial"
//     — "unavailable"/"failed" envelopes are unreachable through
//     hydrateRadarDeep and exist for pre-V1.5 persisted payloads.)
// ---------------------------------------------------------------------------

const siteRequest = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequest(...args),
}));

import { enumerateEngagementCatalog } from "../lib/radar/catalog";
import { RadarCoordinator } from "../lib/radar/coordinator";
import { hydrateRadarDeep } from "../lib/radar/deep";
import { hydrateRadarProgram } from "../lib/radar/enrichment";
import { extractProgramFeatures } from "../lib/radar/features";
import { cohortPercentile } from "../lib/radar/percentile";
import { payoutRealizedSignal } from "../lib/radar/payout";
import { locationLooksApi } from "../lib/radar/surface";
import { getLatestSnapshot, getRun, openRadarStore } from "../lib/radar/store";
import type { ApiEngagementData } from "../lib/types";

const T0 = "2026-09-21T00:00:00.000Z";

interface Call {
  operation: string;
  slug?: string;
  page?: number;
  versionId?: string;
  groupId?: string;
}

function calls(): Call[] {
  return siteRequest.mock.calls.map((c) => c[0] as Call);
}

function callsWhere(pred: (c: Call) => boolean): Call[] {
  return calls().filter(pred);
}

// -- site payload fixtures ----------------------------------------------------

interface GroupSpec {
  id: string;
  inScope?: boolean;
}

function changelogList(ids: string[]): object {
  return {
    changelogs: ids.map((id, i) => ({
      id,
      changelogState: i === 0 ? "Latest" : "Superseded",
    })),
  };
}

function briefDoc(slug: string, groups: GroupSpec[] = [{ id: "g1" }]): object {
  return {
    id: "ver-1",
    publishedAt: "2026-09-11T15:03:27Z",
    lastTransitionAt: "2026-09-01T00:00:00Z",
    statusLabel: "In progress",
    engagementTypeDetail: { productLabel: "Bug Bounty" },
    data: {
      brief: { name: `Program ${slug}`, safeHarborStatus: { status: "full" } },
      engagement: { code: slug, state: "in_progress" },
      scope: groups.map((g) => ({
        id: g.id,
        name: `Group ${g.id}`,
        inScope: g.inScope ?? true,
        description: null,
        rewardRange: { p1MaxCents: 300000 },
        targets: [
          {
            id: `t-${g.id}`,
            uri: "https://app.example.com",
            name: "app.example.com",
            category: "website",
            tags: [{ name: "Website Testing" }],
          },
        ],
      })),
    },
  };
}

function statsBody(): object {
  return {
    rewardedVulnerabilities: 721,
    averagePayout: "$2,000",
    validSubmissionCount: 150,
  };
}

function groupStatsBody(
  groupId: string | undefined,
  uniqueCount = 8,
): object {
  return [
    {
      id: groupId,
      knownIssues: {
        stats: [
          {
            name: "Cross Site Scripting (XSS)",
            uniqueCount,
            duplicateCount: 4,
          },
        ],
      },
    },
  ];
}

interface SiteSpec {
  changelogIds?: string[];
  groups?: GroupSpec[];
  kiBody?: unknown;
  kiError?: ApiError;
  statsBody?: unknown;
  /** uniqueCount each group's stats row reports. */
  groupUnique?: number;
  /** versionIds whose GET_BRIEF_DOC rejects. */
  failDocVersions?: ReadonlySet<string>;
  /** per-slug GET_BRIEF_STATS body override (e.g. a stat field absent). */
  statsBySlug?: Record<string, unknown>;
}

function mockSite(slugs: string[], spec: SiteSpec = {}): void {
  const {
    changelogIds = ["ver-1", "ver-old"],
    groups,
    kiBody = { unique: 12, total: 30 },
    kiError,
    statsBody: stats = statsBody(),
    groupUnique = 8,
    failDocVersions = new Set<string>(),
    statsBySlug = {},
  } = spec;
  siteRequest.mockImplementation(
    async (opts: {
      operation: string;
      slug?: string;
      page?: number;
      versionId?: string;
      groupId?: string;
    }) => {
      switch (opts.operation) {
        case "LIST_INDEX":
          return {
            data: {
              engagements: slugs.map((slug) => ({
                name: `Program ${slug}`,
                tagline: "tagline",
                briefUrl: `/engagements/${slug}`,
                accessStatus: "open",
                productEngagementType: {
                  label: "Bug Bounty",
                  iconVariant: "bug-bounty",
                },
                isPrivate: false,
              })),
              paginationMeta: { limit: 24, totalCount: slugs.length },
            },
            status: 200,
          };
        case "GET_CHANGELOGS":
          return { data: changelogList(changelogIds), status: 200 };
        case "GET_BRIEF_DOC":
          if (failDocVersions.has(opts.versionId ?? "")) {
            throw new ApiError("network", "simulated baseline outage");
          }
          return { data: briefDoc(opts.slug ?? "?", groups), status: 200 };
        case "GET_BRIEF_STATS":
          return {
            data: statsBySlug[opts.slug ?? ""] ?? stats,
            status: 200,
          };
        case "GET_RECENTLY_JOINED":
          return {
            data: { users: [{ username: "reactor1" }], total: 349 },
            status: 200,
          };
        case "GET_ENGAGEMENT_KNOWN_ISSUES":
          if (kiError !== undefined) throw kiError;
          return { data: kiBody, status: 200 };
        case "GET_GROUP_KI_STATS":
          return {
            data: groupStatsBody(opts.groupId, groupUnique),
            status: 200,
          };
        default:
          throw new Error(`unexpected op ${opts.operation}`);
      }
    },
  );
}

// -- pipeline driver ----------------------------------------------------------

let runSeq = 0;

/**
 * A ticking clock — `stored_at` ties break on source_hash (write order is
 * never consulted), so a constant `now` makes "latest snapshot" a coin
 * flip between the metadata and deep rows. The tick is MODULE-global:
 * several runs in one file share the DB, so a per-run clock would
 * re-tie identical stored_at values across scans and let stale rows win.
 */
let tickSeq = 0;
function ticker(): () => string {
  return () => new Date(Date.parse(T0) + tickSeq++ * 1000).toISOString();
}

function makeDeps(): RadarCoordinatorDeps {
  return {
    enumerate: (): Promise<CatalogScanResult> =>
      enumerateEngagementCatalog(T0),
    hydrate: (item) => hydrateRadarProgram(item),
    deepHydrate: (item, snapshot) => hydrateRadarDeep(item, snapshot),
    openStore: openRadarStore,
    now: ticker(),
    concurrency: 1,
    newRunId: () => `run-v15-${++runSeq}`,
  };
}

async function runScan(slugs: string[]): Promise<string> {
  const coord = new RadarCoordinator(makeDeps());
  const run = await coord.start();
  await coord.waitForIdle();
  expect(run.phase).toBe("done");
  return run.run_id;
}

async function latestDeep(slug: string) {
  const db = await openRadarStore();
  const snapshot = await getLatestSnapshot(db, slug);
  db.close();
  expect(snapshot?.deep).toBeDefined();
  return snapshot!;
}

beforeEach(() => {
  siteRequest.mockReset();
});

// ---------------------------------------------------------------------------
// Scope arc — selection, dedupe, failure isolation.
// ---------------------------------------------------------------------------

describe("scope arc (deep-stage pipeline)", () => {
  it("a single-entry changelog leaves both diffs at no_baseline and fetches no baseline doc", async () => {
    mockSite(["arc-one"], { changelogIds: ["ver-1"] });
    await runScan(["arc-one"]);

    const snapshot = await latestDeep("arc-one");
    expect(snapshot.deep?.semantic_diff?.status).toBe("no_baseline");
    expect(snapshot.deep?.scope_arc?.status).toBe("no_baseline");
    // Only the metadata latest-doc fetch happened — no baseline doc at all.
    const docs = callsWhere((c) => c.operation === "GET_BRIEF_DOC");
    expect(docs.map((d) => d.versionId)).toEqual(["ver-1"]);
  });

  it("a two-entry changelog dedupes the arc onto the step baseline — one fetch, one document", async () => {
    mockSite(["arc-two"], { changelogIds: ["ver-1", "ver-old"] });
    await runScan(["arc-two"]);

    const snapshot = await latestDeep("arc-two");
    expect(snapshot.deep?.semantic_diff?.status).toBe("complete");
    expect(snapshot.deep?.scope_arc?.status).toBe("complete");
    // The arc window collapsed onto the step baseline (window 1) — and the
    // shared document was fetched exactly once.
    expect(snapshot.deep?.scope_arc?.window_versions).toBe(1);
    const baselineDocs = callsWhere(
      (c) => c.operation === "GET_BRIEF_DOC" && c.versionId === "ver-old",
    );
    expect(baselineDocs).toHaveLength(1);
  });

  it("a failed arc baseline leaves diff complete, arc unavailable, envelope partial — and still counts as enriched", async () => {
    mockSite(["arc-fail"], {
      changelogIds: ["ver-1", "ver-2", "ver-old"],
      failDocVersions: new Set(["ver-old"]),
    });
    const runId = await runScan(["arc-fail"]);

    const snapshot = await latestDeep("arc-fail");
    const deep = snapshot.deep!;
    expect(deep.semantic_diff?.status).toBe("complete");
    expect(deep.scope_arc?.status).toBe("unavailable");
    // The selected window is reported honestly even though the doc never
    // arrived.
    expect(deep.scope_arc?.window_versions).toBe(2);
    expect(deep.scope_arc?.diff).toBeNull();
    // ki complete + diff complete + arc unavailable + group_stats
    // (12 uniques, 1 group) complete → partial envelope.
    expect(deep.status).toBe("partial");
    // deep_enriched counts the completed evidence, not the failure.
    const db = await openRadarStore();
    const rec = await getRun(db, runId);
    db.close();
    expect(rec?.deep_enriched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-group KI stats — the gate, the all-or-nothing rule, the honest nulls.
// ---------------------------------------------------------------------------

describe("per-group KI stats gate (deep-stage pipeline)", () => {
  it.each([
    [["not a group id"], 1], // outside the route's charset
    [[""], 1], // empty — in-scope but unaddressable
    [["g1", "bad id"], 2], // ANY unaddressable group kills the whole sample
  ])(
    "an unaddressable qualifying group id (%j) fails the breakdown before any request",
    async (groupIds, expectedTotal) => {
      mockSite(["ki-badid"], {
        changelogIds: ["ver-1", "ver-old"],
        groups: (groupIds as string[]).map((id) => ({ id })),
      });
      await runScan(["ki-badid"]);

      const snapshot = await latestDeep("ki-badid");
      const gs = snapshot.deep?.known_issues?.group_stats;
      expect(gs?.status).toBe("failed");
      expect(gs?.groups_fetched).toBe(0);
      expect(gs?.groups_total).toBe(expectedTotal);
      expect(
        callsWhere((c) => c.operation === "GET_GROUP_KI_STATS"),
      ).toHaveLength(0);
    },
  );

  it("out-of-scope groups never qualify — they are not counted, not fetched", async () => {
    mockSite(["ki-oos"], {
      groups: [
        { id: "g1" },
        { id: "out-1", inScope: false },
        { id: "out-2", inScope: false },
      ],
    });
    await runScan(["ki-oos"]);

    const snapshot = await latestDeep("ki-oos");
    const gs = snapshot.deep?.known_issues?.group_stats;
    expect(gs?.status).toBe("complete");
    expect(gs?.groups_total).toBe(1);
    const groupCalls = callsWhere(
      (c) => c.operation === "GET_GROUP_KI_STATS",
    );
    expect(groupCalls.map((c) => c.groupId)).toEqual(["g1"]);
  });

  it("unique below KI_GROUP_MIN_UNIQUE skips before any group request", async () => {
    mockSite(["ki-lowvol"], { kiBody: { unique: 5, total: 20 } });
    await runScan(["ki-lowvol"]);

    const snapshot = await latestDeep("ki-lowvol");
    const gs = snapshot.deep?.known_issues?.group_stats;
    expect(gs?.status).toBe("skipped_low_volume");
    expect(gs?.groups_fetched).toBe(0);
    expect(
      callsWhere((c) => c.operation === "GET_GROUP_KI_STATS"),
    ).toHaveLength(0);
  });

  it("more than KI_GROUP_MAX_GROUPS qualifying groups skips before any request", async () => {
    mockSite(["ki-many"], {
      groups: Array.from({ length: 7 }, (_, i) => ({ id: `g${i + 1}` })),
    });
    await runScan(["ki-many"]);

    const snapshot = await latestDeep("ki-many");
    const gs = snapshot.deep?.known_issues?.group_stats;
    expect(gs?.status).toBe("skipped_group_count");
    expect(gs?.groups_total).toBe(7);
    expect(
      callsWhere((c) => c.operation === "GET_GROUP_KI_STATS"),
    ).toHaveLength(0);
  });

  it("an unavailable aggregate skips the breakdown upstream — no group requests", async () => {
    mockSite(["ki-down"], {
      kiError: new ApiError("not_found", "simulated 404", 404),
    });
    await runScan(["ki-down"]);

    const snapshot = await latestDeep("ki-down");
    const deep = snapshot.deep!;
    expect(deep.known_issues?.status).toBe("unavailable");
    expect(deep.known_issues?.group_stats?.status).toBe("skipped_upstream");
    expect(
      callsWhere((c) => c.operation === "GET_GROUP_KI_STATS"),
    ).toHaveLength(0);
    // skipped_upstream is terminal-OK: complete diff + complete arc +
    // deliberate skip → partial, not unavailable.
    expect(deep.status).toBe("partial");
  });

  it("a complete stats payload whose categories sum to 0 yields an honest null concentration", async () => {
    // The aggregate reports 12 uniques — above the volume gate — but every
    // per-group row reports 0. max/Σ over an all-zero table is undefined:
    // the signal stays null while the stats fetch still reads complete.
    mockSite(["ki-zero"], { groupUnique: 0 });
    await runScan(["ki-zero"]);

    const snapshot = await latestDeep("ki-zero");
    const ki = snapshot.deep?.known_issues;
    expect(ki?.status).toBe("complete");
    expect(ki?.group_stats?.status).toBe("complete");
    expect(ki?.categories).toEqual([
      { category: "Cross Site Scripting (XSS)", unique: 0, total: 4 },
    ]);
    const vector = extractProgramFeatures(snapshot, T0);
    expect(vector.ki_concentration.value).toBeNull();
  });

  it("group-stats complete populates categories and a real concentration", async () => {
    mockSite(["ki-ok"], { kiBody: { unique: 12, total: 30 } });
    await runScan(["ki-ok"]);

    const snapshot = await latestDeep("ki-ok");
    const ki = snapshot.deep?.known_issues;
    expect(ki?.group_stats?.status).toBe("complete");
    expect(ki?.group_stats?.groups_fetched).toBe(1);
    expect(ki?.categories).toEqual([
      { category: "Cross Site Scripting (XSS)", unique: 8, total: 12 },
    ]);
    // One category = concentration 1.0 — the whole volume sits in one class.
    const vector = extractProgramFeatures(snapshot, T0);
    expect(vector.ki_concentration.value).toBe(1);
    expect(vector.ki_concentration.reason_code).toBe("ki_concentration");
    // All four sub-sources terminal-OK → complete envelope.
    expect(snapshot.deep?.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// payout_realized — strict parse edges. Pure: payoutRealizedSignal only
// reads detail.statistics.average_payout.value.
// ---------------------------------------------------------------------------

function detailWithPayout(
  value: unknown,
  window: string | null = "30d",
): ApiEngagementData {
  return {
    uuid: "p",
    name: "p",
    code: "p",
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: null,
    lastBriefUpdate: null,
    safeHarborLevel: null,
    statistics:
      value === undefined
        ? {}
        : { average_payout: { value: value as string, window } },
    targetGroups: [],
    targets: [],
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: null,
  };
}

describe("payout_realized edges (pure)", () => {
  it.each([
    ["$0", 0],
    ["0", 0],
    ["$2,000", 0.5],
    ["$25,000", 1],
    ["$250,000", 1], // above the top anchor clamps to 1
    ["$500", 0.25],
  ])("average_payout %j → %s", (raw, expected) => {
    expect(payoutRealizedSignal(detailWithPayout(raw)).value).toBe(expected);
  });

  it.each([
    "-$500", // negative-as-text: the strict parser rejects it
    "-500",
    "n/a",
    "1,23,4", // broken thousands grouping
    "",
    "  ",
    "$",
    "1e5",
    "$2,00,0",
  ])("malformed %j → null, never coerced", (raw) => {
    const sig = payoutRealizedSignal(detailWithPayout(raw));
    expect(sig.value).toBeNull();
    expect(sig.reason_code).toBe("average_payout_curve");
    expect(sig.source).toBe("statistics");
  });

  it("absent statistic → null", () => {
    expect(
      payoutRealizedSignal(detailWithPayout(undefined)).value,
    ).toBeNull();
  });

  it("a real $0 survives as 0 — not the unknown null", () => {
    const sig = payoutRealizedSignal(detailWithPayout("$0"));
    expect(sig.value).toBe(0);
    expect(sig.value).not.toBeNull();
  });

  it("the stat's window is ignored — any window's average is payment evidence", () => {
    expect(
      payoutRealizedSignal(detailWithPayout("$2,000", "all_time")).value,
    ).toBe(0.5);
    expect(
      payoutRealizedSignal(detailWithPayout("$2,000", null)).value,
    ).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Surface URL shape — V1.5 case/percent-decoding fix, conservatism kept.
// ---------------------------------------------------------------------------

describe("locationLooksApi URL-shape adversarial", () => {
  it.each([
    "https://EXAMPLE.COM/API", // case-insensitive first segment (V1.5 fix)
    "https://example.com/Api/v1",
    "https://example.com/%61pi", // percent-encoded "api" decodes + matches
    "https://example.com/%41PI", // "%41PI" → "API" → lowercase match
    "https://api.example.com", // host token
    "https://internal-api.example.com/x",
  ])("%s → api", (location) => {
    expect(locationLooksApi(location)).toBe(true);
  });

  it.each([
    "https://example.com/docs/api", // token deeper than segment 1
    "https://example.com/v2", // bare version segment is not api
    "https://example.com/v2/api", // version first, api second — still no
    "https://api@example.com/", // userinfo is not a host token
    "https://example.com/api%2", // malformed escape → raw segment, no match
    "ftp://example.com/api", // non-http(s) scheme
    "mailto:api@example.com",
    "example.com/api", // scheme-less is not a URL
    "api.example.com", // scheme-less host alone
    "https://example.com/", // no path segment
    "https://capitol.example.com", // substring trap — no token
  ])("%s → not api", (location) => {
    expect(locationLooksApi(location)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Percentile — cohort arithmetic + the displayed-page independence pin.
// ---------------------------------------------------------------------------

describe("cohortPercentile (pure)", () => {
  it("top of a 4-cohort outranks 75%; the bottom reads a real 0.0", () => {
    expect(cohortPercentile(1, 4)).toBe(75);
    expect(cohortPercentile(4, 4)).toBe(0);
    expect(cohortPercentile(1, 1)).toBe(0);
    expect(cohortPercentile(1, 279)).toBe(99.6);
  });

  it("rejects non-integer or out-of-range positions honestly", () => {
    for (const [pos, size] of [
      [0, 4],
      [5, 4],
      [1.5, 4],
      [1, 0],
      [-1, 4],
      [1, -3],
    ] as const) {
      expect(cohortPercentile(pos, size)).toBe(0);
    }
  });
});

describe("percentile cohort (results pipeline)", () => {
  it("limit truncates the page, not the cohort; minConfidence shrinks the cohort", async () => {
    // pct-low's statistics omit average_payout → payout_realized honestly
    // null → confidence ≈0.73 under best_ev: eligible, but strictly below
    // pct-top's full-metadata 0.76 ceiling.
    mockSite(["pct-top", "pct-low"], {
      statsBySlug: {
        "pct-low": {
          rewardedVulnerabilities: 721,
          validSubmissionCount: 150,
        },
      },
    });
    await runScan(["pct-top", "pct-low"]);

    // A second coordinator over the same store reads the run's results —
    // getResults resolves the latest run context itself.
    const reader = new RadarCoordinator(makeDeps());

    const all = await reader.getResults("best_ev", 50);
    const top = all[0]!;
    const bottom = all[all.length - 1]!;
    const cohort = all.filter((r) => r.eligible).length;
    expect(cohort).toBe(2);
    expect(top.percentile).toBe(50);
    expect(bottom.percentile).toBe(0); // bottom of cohort: real 0.0

    // limit=1 returns only the top row — the percentile is unchanged: the
    // cohort is the full eligible set, not the displayed page.
    const capped = await reader.getResults("best_ev", 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]!.percentile).toBe(50);

    // minConfidence above the weak row's coverage removes it from the
    // cohort entirely — the sole remaining row is both top and bottom.
    const floor =
      (all.find((r) => r.uuid === "pct-low")?.confidence ?? 0) + 0.0001;
    const filtered = await reader.getResults("best_ev", 50, floor);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.uuid).toBe("pct-top");
    expect(filtered[0]!.percentile).toBe(0);
  });
});
