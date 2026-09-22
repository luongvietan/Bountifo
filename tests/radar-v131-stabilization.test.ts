import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEngagementData } from "../lib/types";
import type { CatalogScanResult } from "../lib/radar/catalog";
import { extractProgramFeatures } from "../lib/radar/features";
import { getRadarProfile } from "../lib/radar/profiles";
import { scoreProgram } from "../lib/radar/scoring";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";
import type {
  RadarDeepEnrichment,
  RadarSemanticDiff,
} from "../lib/radar/deepTypes";
import type {
  RadarCatalogItem,
  RadarProgramSnapshot,
  RadarProfileId,
} from "../lib/radar/types";
import { DEEP_PROFILE_IDS } from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.3.1 deep-ranking stabilization tests.
//
// EVERY test in this file is [INTEGRATION]-gated: it pins the specified
// V1.3.1 end-state (profile-aware candidate union, iterative deepening with
// frontier checks, hard budget, terminal stabilization verdict). On this
// branch the coordinator still runs the old single-pass, best_ev-only
// shortlist, so these tests are RED by design — they are the acceptance
// suite for the merge, not regressions.
//
// Fixture discipline: every profile's metadata top-2 is controlled
// independently (freshness → fresh_programs, reward → best_ev, zeroed stats
// → low_competition, api-target count → authz_api), verified in
// tests/radar-v131-scratch.test.ts.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";
const RECENT = "2026-09-20T00:00:00.000Z"; // 1d → freshness 1.0
const MID = "2026-06-23T00:00:00.000Z"; // 90d → freshness 0.6
const STALE = "2025-01-01T00:00:00.000Z"; // >180d → freshness 0.15

type CoordinatorModule = typeof import("../lib/radar/coordinator");
type StoreModule = typeof import("../lib/radar/store");

let coordinator: CoordinatorModule;
let store: StoreModule;
let runSeq = 0;
let snapSeq = 0;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  store = await import("../lib/radar/store");
  coordinator = await import("../lib/radar/coordinator");
});

function item(uuid: string): RadarCatalogItem {
  return {
    uuid,
    code: `c-${uuid}`,
    name: `Program ${uuid}`,
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: T0,
  };
}

interface DetailOpts {
  p1?: number | null;
  lastBriefUpdate?: string;
  researchers?: string;
  submissions?: string;
  rewarded?: string;
  apiTargets?: number;
  webTargets?: number;
}

function detail(uuid: string, o: DetailOpts = {}): ApiEngagementData {
  const statistics: Record<
    string,
    { value: string; window: string | null }
  > = {};
  if (o.researchers !== undefined) {
    statistics.researchers_participating = {
      value: o.researchers,
      window: "all_time",
    };
  }
  if (o.submissions !== undefined) {
    statistics.valid_submission_count = {
      value: o.submissions,
      window: "all_time",
    };
  }
  if (o.rewarded !== undefined) {
    statistics.vulnerabilities_rewarded = {
      value: o.rewarded,
      window: "90d",
    };
  }
  const targets: ApiEngagementData["targets"] = [];
  for (let i = 0; i < (o.apiTargets ?? 0); i++) {
    targets.push({
      id: `t-${uuid}-a${i}`,
      groupId: `g-${uuid}`,
      location: null,
      name: `api-${i}`,
      category: "api",
      tags: [],
      inScope: true,
    });
  }
  for (let i = 0; i < (o.webTargets ?? 0); i++) {
    targets.push({
      id: `t-${uuid}-w${i}`,
      groupId: `g-${uuid}`,
      location: `https://w${i}.example.com`,
      name: `web-${i}`,
      category: "website",
      tags: [],
      inScope: true,
    });
  }
  return {
    uuid,
    name: `Program ${uuid}`,
    code: `c-${uuid}`,
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: "2020-01-01T00:00:00.000Z",
    lastBriefUpdate: o.lastBriefUpdate ?? T0,
    safeHarborLevel: "full",
    statistics,
    targetGroups: [
      {
        id: `g-${uuid}`,
        name: "Scope",
        inScope: true,
        description: null,
        rewards: {
          p1: o.p1 === undefined ? 5000 : o.p1,
          p2: null,
          p3: null,
          p4: null,
          p5: null,
        },
      },
    ],
    targets,
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: "v1",
  };
}

function snap(
  it: RadarCatalogItem,
  opts: DetailOpts = {},
): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: it.uuid,
    code: it.code,
    catalog: it,
    detail: detail(it.uuid, opts),
    enrichment: { status: "complete" },
    source_hash: `sha256:${String(++snapSeq).padStart(64, "0")}`,
  };
}

function kiSummary(
  unique: number,
  total: number,
): NonNullable<RadarDeepEnrichment["known_issues"]> {
  return { status: "complete", unique_count: unique, total_count: total };
}

function diffComplete(
  facts: Partial<RadarSemanticDiff> = {},
): RadarSemanticDiff {
  return {
    status: "complete",
    from_version: "v-old",
    to_version: "v-1",
    added_targets: 0,
    removed_targets: 0,
    added_in_scope_targets: 0,
    removed_in_scope_targets: 0,
    moved_in_scope: 0,
    moved_out_of_scope: 0,
    added_api_targets: 0,
    added_web_targets: 0,
    added_groups: 0,
    reward_increase: false,
    reward_decrease: false,
    safe_harbor_changed: false,
    status_changed: false,
    only_administrative_changes: true,
    ...facts,
  };
}

function benignDeep(): RadarDeepEnrichment {
  return {
    status: "complete",
    known_issues: kiSummary(5, 20),
    semantic_diff: diffComplete(),
  };
}

function saturatingDeep(): RadarDeepEnrichment {
  return {
    status: "complete",
    known_issues: kiSummary(300, 600),
    semantic_diff: diffComplete(),
  };
}

function growthDeep(): RadarDeepEnrichment {
  return {
    status: "complete",
    known_issues: kiSummary(2, 5),
    semantic_diff: diffComplete({
      added_targets: 6,
      added_in_scope_targets: 6,
      added_api_targets: 3,
      added_web_targets: 3,
      added_groups: 1,
      only_administrative_changes: false,
    }),
  };
}

function deepSnap(
  base: RadarProgramSnapshot,
  payload: RadarDeepEnrichment | null,
): RadarProgramSnapshot {
  return {
    ...base,
    deep: payload,
    source_hash: `sha256:deep${String(++snapSeq).padStart(59, "0")}`,
  };
}

// ---------------------------------------------------------------------------
// The disjoint-leaders catalog — the adversarial case the whole plan exists
// for. Four tiers:
//
//   Tier A  ev1, ev2     best_ev leaders (huge p1; MID freshness + mid
//                        stats so reward alone keeps them top — and no
//                        other profile's top-2 picks them)
//   Tier B  fp*,lc*,aa*  profile specialists — each pair tops exactly ONE
//                        non-best_ev profile while sitting at best_ev
//                        rank ≥ 9 (p1 ~6000, far below every blocker)
//   Tier C  bf1..bf6     best_ev ranks 3-8 (p1 15000..20000, MID, mid stats)
//                        — these are what the OLD single-profile shortlist
//                        spends the budget on instead of the specialists
//   Tier D  bt1, bt2     strictly-bottom fillers
//
// Profile-aware union (depth 2) = {ev1,ev2, fp1,fp2, lc1,lc2, aa1,aa2} — all
// eight below-tier-C programs are OUTSIDE best_ev's top-8, so a best_ev-only
// shortlist can never reach them. With frontier = top-1 per profile
// (stableTopK 1, buffer 0) every frontier member is already in the union →
// the converged verdict is "stable" and exactly 8 programs are analyzed.
// ---------------------------------------------------------------------------

const UNION_UUIDS = ["ev1", "ev2", "fp1", "fp2", "lc1", "lc2", "aa1", "aa2"];
const BLOCKER_UUIDS = ["bf1", "bf2", "bf3", "bf4", "bf5", "bf6"];
const BOTTOM_UUIDS = ["bt1", "bt2"];
const UNION_CATALOG = [...UNION_UUIDS, ...BLOCKER_UUIDS, ...BOTTOM_UUIDS];

const UNION_DETAILS: Record<string, DetailOpts> = {
  // Tier A — best_ev leaders: huge p1, stale, saturated, tiny api surface.
  ev1: { p1: 30000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  ev2: { p1: 28000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  // Tier B — specialists: LOW p1 (~6000, below every blocker).
  fp1: { p1: 5000, lastBriefUpdate: RECENT, researchers: "300", submissions: "300", rewarded: "150", apiTargets: 1, webTargets: 2 },
  fp2: { p1: 4900, lastBriefUpdate: RECENT, researchers: "300", submissions: "300", rewarded: "150", apiTargets: 1, webTargets: 2 },
  lc1: { p1: 4000, lastBriefUpdate: MID, researchers: "0", submissions: "0", rewarded: "0", apiTargets: 1, webTargets: 2 },
  lc2: { p1: 3900, lastBriefUpdate: MID, researchers: "0", submissions: "0", rewarded: "0", apiTargets: 1, webTargets: 2 },
  aa1: { p1: 5500, lastBriefUpdate: MID, researchers: "500", submissions: "500", rewarded: "200", apiTargets: 8, webTargets: 1 },
  aa2: { p1: 5400, lastBriefUpdate: MID, researchers: "500", submissions: "500", rewarded: "200", apiTargets: 7, webTargets: 1 },
  // Tier C — best_ev rank 3-8 blockers: mid p1, MID, mid stats, 1 api.
  bf1: { p1: 20000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf2: { p1: 19000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf3: { p1: 18000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf4: { p1: 17000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf5: { p1: 16000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf6: { p1: 15000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  // Tier D — bottom on every axis.
  bt1: { p1: 100, lastBriefUpdate: STALE, researchers: "5000", submissions: "5000", rewarded: "900", apiTargets: 0, webTargets: 1 },
  bt2: { p1: 100, lastBriefUpdate: STALE, researchers: "5000", submissions: "5000", rewarded: "900", apiTargets: 0, webTargets: 1 },
};

type DepsOverrides = Partial<RadarCoordinatorDeps>;

function makeDeps(
  items: RadarCatalogItem[],
  detailsByUuid: Map<string, DetailOpts>,
  deepByUuid?: Map<string, RadarDeepEnrichment>,
  overrides: DepsOverrides = {},
): { deps: RadarCoordinatorDeps; deepHydrate: ReturnType<typeof vi.fn> } {
  const deepHydrate = vi.fn(
    async (_it: RadarCatalogItem, s: RadarProgramSnapshot) =>
      deepSnap(s, deepByUuid?.get(s.uuid) ?? benignDeep()),
  );
  const deps: RadarCoordinatorDeps = {
    enumerate: async (): Promise<CatalogScanResult> => ({
      status: "complete",
      items,
      pages_fetched: 1,
      warnings: [],
    }),
    hydrate: async (it: RadarCatalogItem) =>
      snap(it, detailsByUuid.get(it.uuid) ?? {}),
    deepHydrate,
    openStore: store.openRadarStore,
    now: () => T0,
    concurrency: 2,
    newRunId: () => `run-v131-stab-${++runSeq}`,
    ...overrides,
  };
  return { deps, deepHydrate };
}

/** Small knobs so rounds/frontier gaps are observable on tiny catalogs. */
const SMALL_KNOBS: DepsOverrides = {
  deepCandidateDepth: 2,
  stableTopK: 2,
  stabilityBuffer: 1,
  deepBatchSize: 2,
};

/**
 * Frontier = top-1 per profile: every profile's leader is already a union
 * member, so a correct run converges after the union pass with no pull.
 */
const UNION_KNOBS: DepsOverrides = {
  deepCandidateDepth: 2,
  stableTopK: 1,
  stabilityBuffer: 0,
  deepBatchSize: 2,
};

// ---------------------------------------------------------------------------
// [INTEGRATION] 1. Cross-profile bias — the union, not best_ev's shortlist.
// ---------------------------------------------------------------------------

describe("[INTEGRATION] profile-aware candidate union", () => {
  it("every deep profile's own leaders are deep-analyzed, not just best_ev's", async () => {
    const items = UNION_CATALOG.map(item);
    const { deps, deepHydrate } = makeDeps(
      items,
      new Map(Object.entries(UNION_DETAILS)),
      undefined,
      { ...UNION_KNOBS, deepLimit: 8 }, // budget == union size exactly
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");

    const completed = new Set(run.deep_completed_uuids);

    // THE core assertion: the six specialists sit at best_ev rank ≥ 9, so
    // the old single-profile shortlist (best_ev top-8 = ev1,ev2,bf1..bf6)
    // can never reach them. Only the profile-aware union can.
    for (const leader of UNION_UUIDS) {
      expect(completed, `leader ${leader} must be deep-analyzed`).toContain(
        leader,
      );
    }
    // Budget discipline: frontier = top-1 per profile is already covered by
    // the union → the run stops at exactly the 8 union members; no blocker
    // or filler is ever deep-analyzed.
    expect(completed.size).toBe(8);
    for (const b of [...BLOCKER_UUIDS, ...BOTTOM_UUIDS]) {
      expect(completed).not.toContain(b);
    }

    // deep_candidates records the union WITH per-profile metadata ranks —
    // each leader carries a reason for ITS profile.
    const byUuid = new Map(
      (run.deep_candidates ?? []).map((c) => [c.uuid, c.reasons]),
    );
    for (const [uuid, profile] of [
      ["ev1", "best_ev"],
      ["fp1", "fresh_programs"],
      ["lc1", "low_competition"],
      ["aa1", "authz_api"],
    ] as const) {
      const reasons = byUuid.get(uuid);
      expect(
        reasons?.some(
          (r) => r.profile === profile && r.metadata_rank <= 2,
        ),
        `${uuid} should carry a ${profile} reason with metadata_rank ≤ 2`,
      ).toBe(true);
    }

    // Each profile's deep-mode results are led by its OWN leader — the
    // profile-selection bias is gone end-to-end. (Today these programs
    // have no deep rows at all, so this fails before ordering is even
    // reached — that's the point.)
    for (const [profile, leader] of [
      ["best_ev", "ev1"],
      ["fresh_programs", "fp1"],
      ["low_competition", "lc1"],
      ["authz_api", "aa1"],
    ] as const) {
      const rows = await coord.getResults(profile, 50, undefined, "deep");
      const uuids = new Set(UNION_CATALOG);
      const myRows = rows.filter((r) => uuids.has(r.uuid));
      expect(myRows.length).toBeGreaterThan(0);
      expect(myRows[0]!.uuid).toBe(leader);
      expect(myRows[0]!.evidence_level).toBe("deep");
    }

    // No uuid is deep-enriched twice — union dedup.
    const calls = deepHydrate.mock.calls.map((c) => c[1].uuid);
    expect(new Set(calls).size).toBe(calls.length);

    // A terminal verdict exists once the run finishes.
    expect(run.deep_stabilization).toBe("stable");
    expect(run.deep_round).toBeGreaterThanOrEqual(1);
    expect(run.deep_budget).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// [INTEGRATION] 2. One-pass rerank — deep evidence must be allowed to move
// the frontier; a rank-3 candidate enters in round 2.
// ---------------------------------------------------------------------------

describe("[INTEGRATION] iterative deepening / rerank", () => {
  it("a rank-3 candidate enters the frontier in round 2 after leaders saturate", async () => {
    // x1..x5: identical profiles except descending reward → every deep
    // profile ranks them x1 > x2 > x3 > x4 > x5. Union (depth 2) = {x1,x2};
    // frontier top-(2+1)=3 = {x1,x2,x3} → x3 must be pulled in round 2.
    const uuids = ["x1", "x2", "x3", "x4", "x5"];
    const details = new Map(
      uuids.map((u, i) => [
        u,
        {
          p1: 20000 - i * 4000,
          lastBriefUpdate: MID,
          researchers: "200",
          submissions: "200",
          rewarded: "100",
          apiTargets: 1,
          webTargets: 2,
        } satisfies DetailOpts,
      ]),
    );
    // Leaders x1/x2 discover saturation — their deep scores crash. x3 gets
    // benign evidence. A one-pass rerun would keep serving x1/x2 as the
    // deep top-2 even though the deep data says otherwise.
    const deepByUuid = new Map<string, RadarDeepEnrichment>([
      ["x1", saturatingDeep()],
      ["x2", saturatingDeep()],
      ["x3", growthDeep()],
    ]);
    const { deps, deepHydrate } = makeDeps(
      uuids.map(item),
      details,
      deepByUuid,
      { ...SMALL_KNOBS, deepLimit: 6 },
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");

    // Round-2 expansion happened.
    expect(run.deep_round).toBeGreaterThanOrEqual(2);
    expect(run.deep_completed_uuids).toContain("x3");
    // …but the loop must not run to catalog exhaustion: x5 (rank 5 of 5)
    // is beyond any frontier.
    expect(run.deep_completed_uuids).not.toContain("x5");
    expect(new Set(run.deep_completed_uuids).size).toBeLessThanOrEqual(4);
    // deepHydrate dedup: no uuid enriched twice across rounds.
    const calls = deepHydrate.mock.calls.map((c) => c[1].uuid);
    expect(new Set(calls).size).toBe(calls.length);

    // The deep ranking reflects deep evidence: growth-x3 above saturated
    // leaders, with negative deltas on the crashed rows.
    const rows = await coord.getResults("best_ev", 50, undefined, "deep");
    const myRows = rows.filter((r) => uuids.includes(r.uuid));
    expect(myRows[0]!.uuid).toBe("x3");
    for (const r of myRows) {
      if (r.uuid === "x1" || r.uuid === "x2") {
        expect(r.score_delta).not.toBeNull();
        expect(r.score_delta!).toBeLessThan(0);
      }
    }
    // Converged inside budget → terminal verdict "stable".
    expect(run.deep_stabilization).toBe("stable");
  });
});

// ---------------------------------------------------------------------------
// [INTEGRATION] 3. Budget ceiling — the hard cap binds the union, and the
// verdict says so instead of pretending stability.
// ---------------------------------------------------------------------------

describe("[INTEGRATION] hard budget", () => {
  it("budget_limited verdict when the union+frontier exceeds deepLimit", async () => {
    const items = UNION_CATALOG.map(item);
    const { deps, deepHydrate } = makeDeps(
      items,
      new Map(Object.entries(UNION_DETAILS)),
      undefined,
      { ...UNION_KNOBS, deepLimit: 6 }, // union is 8 → cannot all be analyzed
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");

    // HARD CAP: unique deep-analyzed programs ≤ deepLimit — the cap binds
    // the union itself, not just the stabilization batches.
    const unique = new Set(run.deep_completed_uuids);
    expect(unique.size).toBeLessThanOrEqual(6);
    expect(deepHydrate.mock.calls.length).toBeLessThanOrEqual(6);
    const calls = deepHydrate.mock.calls.map((c) => c[1].uuid);
    expect(new Set(calls).size).toBe(calls.length); // no re-enrichment

    // The run must NOT report "stable" — frontier gaps remain by
    // construction. The terminal verdict is "budget_limited".
    expect(run.deep_stabilization).toBe("budget_limited");
    // Budget bookkeeping is persisted.
    expect(run.deep_budget).toBe(6);
    // The union was still computed: candidates reference all four deep
    // profiles' reasons even though not all could be analyzed.
    const profilesSeen = new Set(
      (run.deep_candidates ?? []).flatMap((c) =>
        c.reasons.map((r) => r.profile),
      ),
    );
    for (const pid of DEEP_PROFILE_IDS) {
      expect(profilesSeen).toContain(pid);
    }
  });
});

// ---------------------------------------------------------------------------
// [INTEGRATION] 4. Mid-round-2 resume — a checkpoint during stabilization
// must restore pending queue + completed set exactly.
// ---------------------------------------------------------------------------

describe("[INTEGRATION] resume mid-stabilization", () => {
  it("a run checkpointed at deep_round 2 resumes pending work and reaches a terminal verdict", async () => {
    const uuids = ["rs1", "rs2", "rs3", "rs4"];
    const db = await store.openRadarStore();
    const items = uuids.map(item);
    await store.putCatalogItems(db, items);
    const detailOpts: Record<string, DetailOpts> = {
      rs1: { p1: 20000, webTargets: 2, apiTargets: 1 },
      rs2: { p1: 16000, webTargets: 2, apiTargets: 1 },
      rs3: { p1: 12000, webTargets: 2, apiTargets: 1 },
      rs4: { p1: 8000, webTargets: 2, apiTargets: 1 },
    };
    for (const uuid of uuids) {
      const s = snap(item(uuid), detailOpts[uuid]!);
      await store.putSnapshot(db, s, T0);
      const vector = extractProgramFeatures(s, T0);
      for (const pid of DEEP_PROFILE_IDS) {
        const profile = getRadarProfile(pid);
        await store.putScore(
          db,
          scoreProgram(s, vector, profile),
          T0,
          vector,
          "metadata",
        );
      }
    }
    // Checkpoint shape: round 2 in flight — rs1/rs2 already deep-analyzed
    // (their snapshots carry deep), rs3/rs4 pending.
    const runId = `run-seeded-${++runSeq}`;
    await store.putRun(db, {
      run_id: runId,
      phase: "deep_enriching",
      discovered: 4,
      enriched: 4,
      scored: 4,
      pending_uuids: [],
      completed_uuids: uuids,
      deep_pending_uuids: ["rs3", "rs4"],
      deep_completed_uuids: ["rs1", "rs2"],
      deep_enriched: 2,
      deep_candidates: uuids.map((uuid, i) => ({
        uuid,
        reasons: [{ profile: "best_ev" as RadarProfileId, metadata_rank: i + 1 }],
      })),
      deep_round: 2,
      deep_budget: 8,
      deep_stabilization: null,
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
    });
    for (const uuid of ["rs1", "rs2"]) {
      const meta = await store.getLatestSnapshot(db, uuid);
      await store.putSnapshot(db, deepSnap(meta!, benignDeep()), T0);
    }
    await store.setLatestRunId(db, runId);

    // Fresh coordinator = restarted service worker.
    const { deps, deepHydrate } = makeDeps(
      items,
      new Map(Object.entries(detailOpts)),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();

    // Pending queue restored: only rs3/rs4 are enriched — rs1/rs2 are
    // checkpointed complete and must not be re-fetched.
    expect(deepHydrate.mock.calls.map((c) => c[1].uuid).sort()).toEqual([
      "rs3",
      "rs4",
    ]);

    const rec = await store.getRun(db, runId);
    expect(rec?.phase).toBe("done");
    expect(rec?.deep_pending_uuids).toEqual([]);
    expect([...(rec?.deep_completed_uuids as string[])].sort()).toEqual(
      uuids,
    );
    // The resumed run still runs the frontier check → terminal verdict.
    // (RED today: deep_stabilization stays null on this branch.)
    expect(rec?.deep_stabilization).toBe("stable");
    db.close();
  });
});
