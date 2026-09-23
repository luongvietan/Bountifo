import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/errors";
import type { CatalogScanResult } from "../lib/radar/catalog";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";

// ---------------------------------------------------------------------------
// Deep-source diagnostics pins (V1.5.1).
//
// Regression context: a real scan reported "60 deep analyzed · 0 warnings"
// while EVERY deep-analyzed program's Known Issues aggregate was absent —
// live probes show engagement_known_issues.json and the per-group stats route
// are the only session-gated reads in the pipeline (401 unauthenticated;
// every other endpoint is public). The pipeline honestly stored
// "unavailable"/"skipped_upstream" per program, but the run-level summary
// never surfaced the systemic outage: a successful scan obscured the total
// failure of an entire deep-evidence source.
//
// The contract under test:
//   - The run record + terminal summary carry a deterministic per-source
//     outcome tally for all four deep sub-sources:
//     known_issues / semantic_diff / scope_arc / group_stats.
//   - A sub-source that failed for EVERY attempted program produces a
//     run-level warning naming the source and the failure kind — a complete
//     semantic diff must not conceal an aggregate KI outage.
//   - Honest bounds are not warnings: all-skipped group stats, all
//     no_baseline diffs, and mixed (per-program) outages warn nothing.
//   - deep_analyzed still counts attempted programs; deep_enriched still
//     counts programs that gained ANY real evidence. Neither is conflated.
//   - The tallies persist on the run record and accumulate across resume.
//   - The summary line renders complete/analyzed per source with the
//     dominant non-complete outcome ("KI 0/60 unavailable").
// ---------------------------------------------------------------------------

const siteRequest = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequest(...args),
}));

import { enumerateEngagementCatalog } from "../lib/radar/catalog";
import {
  RadarCoordinator,
  type RadarScanSummary,
} from "../lib/radar/coordinator";
import { hydrateRadarDeep } from "../lib/radar/deep";
import { hydrateRadarProgram } from "../lib/radar/enrichment";
import {
  getLatestSnapshot,
  getRun,
  openRadarStore,
  putCatalogItems,
  putRun,
  putSnapshot,
  setLatestRunId,
} from "../lib/radar/store";
import { deepSummaryText, summaryText } from "../entrypoints/radar/view";
import type { ApiEngagementData } from "../lib/types";
import type { RadarProgramSnapshot } from "../lib/radar/types";

const T0 = "2026-09-21T00:00:00.000Z";

// -- site payload fixtures (same shape as the V1.5 adversarial harness) ------

function changelogList(ids: string[]): object {
  return {
    changelogs: ids.map((id, i) => ({
      id,
      changelogState: i === 0 ? "Latest" : "Superseded",
    })),
  };
}

function briefDoc(slug: string, groups: { id: string; inScope?: boolean }[] = [
  { id: "g1" },
]): object {
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

function groupStatsBody(groupId: string | undefined, uniqueCount = 8): object {
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
  groups?: { id: string; inScope?: boolean }[];
  kiBody?: unknown;
  kiError?: ApiError;
  /** Per-slug KI override — for mixed per-program outcomes. */
  kiBySlug?: Record<string, { body?: unknown; error?: ApiError }>;
  groupStatsError?: ApiError;
  groupUnique?: number;
}

function mockSite(slugs: string[], spec: SiteSpec = {}): void {
  const {
    changelogIds = ["ver-1", "ver-old"],
    groups,
    kiBody = { unique: 12, total: 30 },
    kiError,
    kiBySlug = {},
    groupStatsError,
    groupUnique = 8,
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
          return { data: briefDoc(opts.slug ?? "?", groups), status: 200 };
        case "GET_BRIEF_STATS":
          return { data: statsBody(), status: 200 };
        case "GET_RECENTLY_JOINED":
          return {
            data: { users: [{ username: "reactor1" }], total: 349 },
            status: 200,
          };
        case "GET_ENGAGEMENT_KNOWN_ISSUES": {
          const perSlug = kiBySlug[opts.slug ?? ""];
          if (perSlug?.error !== undefined) throw perSlug.error;
          if (perSlug !== undefined) {
            return { data: perSlug.body, status: 200 };
          }
          if (kiError !== undefined) throw kiError;
          return { data: kiBody, status: 200 };
        }
        case "GET_GROUP_KI_STATS":
          if (groupStatsError !== undefined) throw groupStatsError;
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
    newRunId: () => `run-diag-${++runSeq}`,
  };
}

async function runScan(slugs: string[]) {
  const coord = new RadarCoordinator(makeDeps());
  const run = await coord.start();
  await coord.waitForIdle();
  expect(run.phase).toBe("done");
  return { coord, run };
}

async function latestDeep(slug: string) {
  const db = await openRadarStore();
  const snapshot = await getLatestSnapshot(db, slug);
  db.close();
  expect(snapshot?.deep).toBeDefined();
  return snapshot!;
}

function warningList(run: { summary?: RadarScanSummary }): string[] {
  return run.summary?.warnings ?? [];
}

beforeEach(() => {
  siteRequest.mockReset();
});

// ---------------------------------------------------------------------------
// The regression signature: a systemic KI outage inside a "successful" scan.
// ---------------------------------------------------------------------------

describe("systemic deep-source outage (the reported regression)", () => {
  it("an all-401 KI run tallies the outage and warns — a complete diff does not conceal it", async () => {
    const slugs = ["ki-out-a", "ki-out-b", "ki-out-c"];
    // Live-verified shape: the aggregate endpoint answers 401 when the
    // researcher session is absent — everything else stays public.
    mockSite(slugs, {
      kiError: new ApiError("unauthorized", "unauthorized", 401),
    });
    const { coord, run } = await runScan(slugs);

    const summary = run.summary!;
    // The per-source tally makes the systemic failure explicit.
    expect(summary.deep_sources?.known_issues).toEqual({ unavailable: 3 });
    expect(summary.deep_sources?.group_stats).toEqual({
      skipped_upstream: 3,
    });
    // The public-evidence sources completed — their success is recorded
    // separately, never averaged over the KI failure.
    expect(summary.deep_sources?.semantic_diff).toEqual({ complete: 3 });
    expect(summary.deep_sources?.scope_arc).toEqual({ complete: 3 });
    // deep_analyzed counts attempts; deep_enriched counts real evidence —
    // diff/arc completions keep enriched high while KI shows zero.
    expect(summary.deep_analyzed).toBe(3);
    expect(summary.deep_enriched).toBe(3);
    // The scan no longer reports "0 warnings" over a total source outage.
    expect(warningList(run)).toContain("deep_known_issues_unavailable");
    expect(warningList(run)).not.toContain("deep_group_stats_failed");

    // Persisted: the run record carries the tally for post-restart reads.
    const db = await openRadarStore();
    const persisted = await getRun(db, run.run_id);
    expect(persisted?.deep_sources).toMatchObject({
      known_issues: { unavailable: 3 },
    });
    db.close();

    // The result row keeps the honest signature: KI signals null, the
    // changelog-derived signals populated.
    const rows = await coord.getResults("low_competition", 50, 0, "deep");
    const mine = rows.filter((r) => slugs.includes(r.uuid));
    expect(mine).toHaveLength(3);
    for (const row of mine) {
      expect(row.signals.known_issue_density).toBeNull();
      expect(row.signals.ki_concentration).toBeNull();
      expect(row.signals.opportunity_change).not.toBeNull();
      expect(row.signals.scope_momentum).not.toBeNull();
    }
  });

  it.each([
    ["network", new ApiError("network", "request failed")],
    ["rate_limited", new ApiError("rate_limited", "API rate limit persisted", 429)],
  ])(
    "an all-%s KI run tallies 'failed' and warns deep_known_issues_failed",
    async (_kind, error) => {
      mockSite(["ki-fail-1", "ki-fail-2"], { kiError: error as ApiError });
      const { run } = await runScan(["ki-fail-1", "ki-fail-2"]);

      expect(run.summary?.deep_sources?.known_issues).toEqual({ failed: 2 });
      expect(warningList(run)).toContain("deep_known_issues_failed");
      expect(warningList(run)).not.toContain("deep_known_issues_unavailable");
    },
  );

  it("a malformed aggregate body counts as failed, not zero", async () => {
    mockSite(["ki-bad-body"], {
      kiBody: { unique: "12", total: "30" },
    });
    const { coord, run } = await runScan(["ki-bad-body"]);

    expect(run.summary?.deep_sources?.known_issues).toEqual({ failed: 1 });
    expect(warningList(run)).toContain("deep_known_issues_failed");
    const snapshot = await latestDeep("ki-bad-body");
    expect(snapshot.deep?.known_issues?.unique_count).toBeNull();
    const rows = await coord.getResults("low_competition", 50, 0, "deep");
    expect(
      rows.find((r) => r.uuid === "ki-bad-body")?.signals
        .known_issue_density,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Independence + honesty bounds.
// ---------------------------------------------------------------------------

describe("aggregate vs per-group independence", () => {
  it("a group-stats failure warns on group_stats but never erases the aggregate signal", async () => {
    mockSite(["ki-gs-fail"], {
      kiBody: { unique: 40, total: 100 },
      groupStatsError: new ApiError("unauthorized", "unauthorized", 401),
    });
    const { coord, run } = await runScan(["ki-gs-fail"]);

    const summary = run.summary!;
    expect(summary.deep_sources?.known_issues).toEqual({ complete: 1 });
    expect(summary.deep_sources?.group_stats).toEqual({ failed: 1 });
    expect(warningList(run)).toContain("deep_group_stats_failed");
    expect(warningList(run)).not.toContain("deep_known_issues_unavailable");

    // Aggregate density survived the group outage; concentration is honest
    // null — never fabricated from a failed sample.
    const rows = await coord.getResults("low_competition", 50, 0, "deep");
    const row = rows.find((r) => r.uuid === "ki-gs-fail")!;
    expect(row.signals.known_issue_density).not.toBeNull();
    expect(row.signals.ki_concentration).toBeNull();
  });

  it("a fully-skipped group breakdown warns nothing — the bound is deliberate", async () => {
    // unique 5 < KI_GROUP_MIN_UNIQUE: the gate skips before any request.
    mockSite(["ki-lowvol"], { kiBody: { unique: 5, total: 20 } });
    const { coord, run } = await runScan(["ki-lowvol"]);

    const summary = run.summary!;
    expect(summary.deep_sources?.known_issues).toEqual({ complete: 1 });
    expect(summary.deep_sources?.group_stats).toEqual({
      skipped_low_volume: 1,
    });
    expect(
      warningList(run).filter((w) => w.startsWith("deep_")),
    ).toEqual([]);

    const rows = await coord.getResults("low_competition", 50, 0, "deep");
    const row = rows.find((r) => r.uuid === "ki-lowvol")!;
    expect(row.signals.known_issue_density).not.toBeNull();
    expect(row.signals.ki_concentration).toBeNull();
  });

  it("a mixed per-program outage tallies each outcome and warns nothing", async () => {
    // Per-program absence is normal (KI feature off) — only a uniform
    // outage signals a systemic failure.
    mockSite(["ki-mix-ok", "ki-mix-off1", "ki-mix-off2"], {
      kiBySlug: {
        "ki-mix-off1": {
          error: new ApiError("unauthorized", "unauthorized", 401),
        },
        "ki-mix-off2": {
          error: new ApiError("not_found", "not found", 404),
        },
      },
    });
    const { run } = await runScan(["ki-mix-ok", "ki-mix-off1", "ki-mix-off2"]);

    expect(run.summary?.deep_sources?.known_issues).toEqual({
      complete: 1,
      unavailable: 2,
    });
    expect(
      warningList(run).filter((w) => w.startsWith("deep_")),
    ).toEqual([]);
  });

  it("a healthy run tallies completes, warns nothing, and populates both KI signals", async () => {
    mockSite(["ki-ok"], { kiBody: { unique: 40, total: 100 } });
    const { coord, run } = await runScan(["ki-ok"]);

    const summary = run.summary!;
    expect(summary.deep_sources).toEqual({
      known_issues: { complete: 1 },
      semantic_diff: { complete: 1 },
      scope_arc: { complete: 1 },
      group_stats: { complete: 1 },
    });
    expect(warningList(run).filter((w) => w.startsWith("deep_"))).toEqual(
      [],
    );

    const rows = await coord.getResults("low_competition", 50, 0, "deep");
    const row = rows.find((r) => r.uuid === "ki-ok")!;
    expect(row.signals.known_issue_density).not.toBeNull();
    // One group, one category at unique 8 → concentration 1.0.
    expect(row.signals.ki_concentration).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deep_analyzed vs attempted: programs with no metadata detail complete
// without a deep payload — they count as analyzed but not tallied.
// ---------------------------------------------------------------------------

describe("analyzed vs attempted bookkeeping", () => {
  it("a shortlisted program with no detail tallies nothing", async () => {
    const db = await openRadarStore();
    const slug = "ki-nodetail";
    // Seed: one normal program already snapshot-complete, one shortlisted
    // program whose metadata enrichment produced no detail.
    await putCatalogItems(db, [
      {
        uuid: slug,
        code: slug,
        name: `Program ${slug}`,
        lifecycle_status: "live",
        engagement_type: "bug_bounty",
        discovered_at: T0,
      },
    ]);
    const bareSnapshot: RadarProgramSnapshot = {
      schema_version: 1,
      uuid: slug,
      code: slug,
      catalog: {
        uuid: slug,
        code: slug,
        name: `Program ${slug}`,
        lifecycle_status: "live",
        engagement_type: "bug_bounty",
        discovered_at: T0,
      },
      detail: null,
      enrichment: { status: "unavailable", error_kind: "forbidden" },
      source_hash: `sha256:${"a".repeat(64)}`,
    };
    await putSnapshot(db, bareSnapshot, T0);
    await putRun(db, {
      run_id: "run-diag-nodetail",
      phase: "deep_enriching",
      discovered: 1,
      enriched: 0,
      scored: 0,
      pending_uuids: [],
      completed_uuids: [slug],
      deep_pending_uuids: [slug],
      deep_completed_uuids: [],
      deep_enriched: 0,
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 1,
      warning_details: [],
      cancel_requested: false,
    });
    await setLatestRunId(db, "run-diag-nodetail");
    db.close();

    mockSite([slug]);
    const coord = new RadarCoordinator(makeDeps());
    await coord.resume();

    const rec = await getRun(await openRadarStore(), "run-diag-nodetail");
    expect(rec?.phase).toBe("done");
    const summary = rec?.summary as RadarScanSummary | undefined;
    expect(summary?.deep_analyzed).toBe(1);
    // Nothing was attempted — every tally stays empty rather than
    // fabricating an "unavailable" that never happened.
    expect(summary?.deep_sources?.known_issues).toEqual({});
    expect(
      (summary?.warnings ?? []).filter((w) => w.startsWith("deep_")),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resume: the tally must survive a service-worker restart mid-deep-stage.
// ---------------------------------------------------------------------------

describe("resume continuity", () => {
  it("tallies accumulate across a persisted deep_enriching restart", async () => {
    const db = await openRadarStore();
    const slug = "ki-resume";
    const catalogItem = {
      uuid: slug,
      code: slug,
      name: `Program ${slug}`,
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: T0,
    };
    await putCatalogItems(db, [catalogItem]);
    // A metadata snapshot the deep stage can hydrate onto.
    const detail: ApiEngagementData = {
      uuid: slug,
      name: `Program ${slug}`,
      code: slug,
      engagementType: "bug_bounty",
      managedBounty: true,
      lifecycleStatus: "live",
      testingStart: null,
      testingEnd: null,
      testingPeriodLabel: null,
      lastStatusTransition: T0,
      lastBriefUpdate: T0,
      safeHarborLevel: "full",
      statistics: {},
      targetGroups: [
        {
          id: "g1",
          name: "Web",
          inScope: true,
          description: null,
          rewards: { p1: 5000, p2: 500, p3: 100, p4: null, p5: null },
        },
      ],
      targets: [
        {
          id: "t1",
          groupId: "g1",
          location: "https://app.example.com",
          name: "app",
          category: "website",
          tags: [],
          inScope: true,
        },
      ],
      participation: null,
      credentialsProvided: null,
      briefText: null,
      observedApiVersion: "2026-09-20",
    };
    const snapshot: RadarProgramSnapshot = {
      schema_version: 1,
      uuid: slug,
      code: slug,
      catalog: catalogItem,
      detail,
      enrichment: { status: "complete" },
      source_hash: `sha256:${"b".repeat(64)}`,
    };
    await putSnapshot(db, snapshot, T0);
    await putRun(db, {
      run_id: "run-diag-resume",
      phase: "deep_enriching",
      discovered: 1,
      enriched: 1,
      scored: 1,
      pending_uuids: [],
      completed_uuids: [slug],
      deep_pending_uuids: [slug],
      deep_completed_uuids: ["ki-resume-prev"],
      deep_enriched: 0,
      // The pre-restart worker observed one unavailable aggregate — the
      // tally must continue from it, not reset.
      deep_sources: {
        known_issues: { unavailable: 1 },
        semantic_diff: { complete: 1 },
        scope_arc: { complete: 1 },
        group_stats: { skipped_upstream: 1 },
      },
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
    });
    await setLatestRunId(db, "run-diag-resume");
    db.close();

    mockSite([slug], {
      kiError: new ApiError("unauthorized", "unauthorized", 401),
    });
    const coord = new RadarCoordinator(makeDeps());
    await coord.resume();

    const db2 = await openRadarStore();
    const rec = await getRun(db2, "run-diag-resume");
    db2.close();
    expect(rec?.phase).toBe("done");
    const summary = rec?.summary as RadarScanSummary | undefined;
    expect(summary?.deep_analyzed).toBe(2);
    expect(summary?.deep_sources?.known_issues).toEqual({ unavailable: 2 });
    expect(summary?.deep_sources?.group_stats).toEqual({
      skipped_upstream: 2,
    });
    expect(summary?.warnings ?? []).toContain(
      "deep_known_issues_unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Summary validation + view rendering.
// ---------------------------------------------------------------------------

describe("summary integrity + UI surfacing", () => {
  it("a corrupt persisted deep_sources drops the summary rather than render it", async () => {
    const db = await openRadarStore();
    await putRun(db, {
      run_id: "run-diag-corrupt",
      phase: "done",
      discovered: 1,
      enriched: 1,
      scored: 1,
      pending_uuids: [],
      completed_uuids: ["x"],
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      summary: {
        status: "complete",
        catalog_complete: true,
        discovered: 1,
        enriched: 1,
        enrichment_failed: 0,
        scored: 1,
        warnings: [],
        deep_candidates: 1,
        deep_analyzed: 1,
        deep_sources: { known_issues: "lots" },
      },
    });
    await setLatestRunId(db, "run-diag-corrupt");
    db.close();

    const coord = new RadarCoordinator(makeDeps());
    const state = await coord.getState();
    expect(state?.summary).toBeUndefined();
  });

  it("deepSummaryText renders complete/analyzed per source with the dominant outage kind", () => {
    const summary: RadarScanSummary = {
      status: "complete",
      catalog_complete: true,
      discovered: 279,
      enriched: 279,
      enrichment_failed: 0,
      scored: 279,
      warnings: [],
      deep_candidates: 60,
      deep_analyzed: 60,
      deep_enriched: 60,
      deep_rounds: 2,
      deep_budget: 60,
      deep_stabilization: "budget_limited",
      deep_sources: {
        known_issues: { unavailable: 60 },
        semantic_diff: { complete: 58, no_baseline: 2 },
        scope_arc: { complete: 55, no_baseline: 5 },
        group_stats: { skipped_upstream: 60 },
      },
    };
    const text = deepSummaryText(summary)!;
    expect(text).toContain("60 of 60 analyzed");
    expect(text).toContain("KI 0/60 unavailable");
    expect(text).toContain("diff 58/60");
    expect(text).toContain("arc 55/60");
    expect(text).toContain("groups 0/60 skipped_upstream");
    // The full status line no longer claims a silent clean sweep.
    expect(summaryText(summary, 1)).toContain("1 warning");
  });

  it("deepSummaryText without tallies keeps the V1.5 format (legacy summaries)", () => {
    const summary: RadarScanSummary = {
      status: "complete",
      catalog_complete: true,
      discovered: 10,
      enriched: 10,
      enrichment_failed: 0,
      scored: 10,
      warnings: [],
      deep_candidates: 3,
      deep_analyzed: 3,
      deep_rounds: 1,
      deep_budget: 60,
      deep_stabilization: "stable",
    };
    expect(deepSummaryText(summary)).toBe(
      "Deep: 3 analyzed · 1 round · Top-20 stable",
    );
  });

  it("a clean deep run renders bare complete counts with no outage kind", () => {
    const summary: RadarScanSummary = {
      status: "complete",
      catalog_complete: true,
      discovered: 5,
      enriched: 5,
      enrichment_failed: 0,
      scored: 5,
      warnings: [],
      deep_candidates: 2,
      deep_analyzed: 2,
      deep_enriched: 2,
      deep_rounds: 1,
      deep_budget: 60,
      deep_stabilization: "stable",
      deep_sources: {
        known_issues: { complete: 2 },
        semantic_diff: { complete: 2 },
        scope_arc: { complete: 1, no_baseline: 1 },
        group_stats: { complete: 1, skipped_low_volume: 1 },
      },
    };
    const text = deepSummaryText(summary)!;
    expect(text).toContain("KI 2/2");
    expect(text).toContain("diff 2/2");
    expect(text).toContain("arc 1/2 no_baseline");
    expect(text).toContain("groups 1/2 skipped_low_volume");
    expect(text).not.toContain("unavailable");
    expect(text).not.toContain("failed");
  });
});
