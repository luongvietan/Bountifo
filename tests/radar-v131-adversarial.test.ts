import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEngagementData } from "../lib/types";
import type { CatalogScanResult } from "../lib/radar/catalog";
import { extractProgramFeatures } from "../lib/radar/features";
import { getRadarProfile } from "../lib/radar/profiles";
import { scoreProgram } from "../lib/radar/scoring";
import type {
  RadarCoordinatorDeps,
  RadarResultRow,
} from "../lib/radar/coordinator";
import type {
  RadarDeepEnrichment,
  RadarSemanticDiff,
} from "../lib/radar/deepTypes";
import type {
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "../lib/radar/types";
import { RADAR_PROFILE_IDS } from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.3.1 adversarial coordinator tests.
//
// Harness: real RadarCoordinator + fake-indexeddb + injected
// enumerate/hydrate/deepHydrate mocks (pattern copied from
// radar-coordinator.test.ts / radar-v13-request-budget.test.ts). Hydration
// details are crafted per program so each profile's metadata ranking is
// controllable (freshness drives fresh_programs; rewards drive best_ev;
// zeroed stats drive low_competition; api-target counts drive authz_api).
//
// MARKING CONVENTION: describes/tests tagged [CONTRACT] are green on this
// branch (they exercise committed seams only). Tests tagged [INTEGRATION]
// pin the specified V1.3.1 end-state — multi-profile candidate union,
// stabilization rounds, terminal verdict — and are RED until the
// coordinator integration lands on main. That is by design.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";
const RECENT = "2026-09-20T00:00:00.000Z"; // 1d old → freshness 1.0
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

// -- catalog/snapshot fixtures ------------------------------------------------

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

/**
 * Crafted ApiEngagementData: every knob steers a known signal —
 *   p1              → reward_potential (best_ev/high_reward)
 *   lastBriefUpdate → freshness band (fresh_programs)
 *   stats           → research_saturation components (low_competition cost)
 *   apiTargets      → api_surface + api_surface_size (authz_api)
 *   webTargets      → web_surface + meaningful_surface
 */
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
    // Freshness reads the NEWEST of lastBriefUpdate/lastStatusTransition —
    // pin the transition old so lastBriefUpdate is the only driver.
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

// -- deep payload fixtures ------------------------------------------------------

function kiSummary(
  unique: number,
  total: number,
): NonNullable<RadarDeepEnrichment["known_issues"]> {
  return { status: "complete", unique_count: unique, total_count: total };
}

/** A complete diff: every fact is a real value (schema superRefine). */
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

/**
 * Benign deep pass: real-but-quiet evidence. unique_count 5 over a small
 * surface → low density; an admin-only diff → opportunity_change 0.
 */
function benignDeep(): RadarDeepEnrichment {
  return {
    status: "complete",
    known_issues: kiSummary(5, 20),
    semantic_diff: diffComplete(),
  };
}

/** Growth diff → positive opportunity_change (deep score rises). */
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

// -- deps + driver --------------------------------------------------------------

type DepsOverrides = Partial<RadarCoordinatorDeps>;

function makeDeps(
  items: RadarCatalogItem[],
  detailsByUuid: Map<string, DetailOpts>,
  overrides: DepsOverrides = {},
): { deps: RadarCoordinatorDeps; deepHydrate: ReturnType<typeof vi.fn> } {
  const deepHydrate = vi.fn(
    async (_it: RadarCatalogItem, s: RadarProgramSnapshot) =>
      deepSnap(s, benignDeep()),
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
    newRunId: () => `run-v131-adv-${++runSeq}`,
    ...overrides,
  };
  return { deps, deepHydrate };
}

function detailsOf(
  defs: Record<string, DetailOpts>,
): Map<string, DetailOpts> {
  return new Map(Object.entries(defs));
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function until(
  cond: () => Promise<boolean>,
  tries = 500,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await tick();
  }
  throw new Error("condition not met");
}

function mine(rows: RadarResultRow[], uuids: string[]): RadarResultRow[] {
  const set = new Set(uuids);
  return rows.filter((r) => set.has(r.uuid));
}

// ---------------------------------------------------------------------------
// [CONTRACT] Mixed evidence levels — the two result-table modes.
// ---------------------------------------------------------------------------

describe("[CONTRACT] mixed-evidence result modes", () => {
  const UUIDS = ["me-1", "me-2", "me-3", "me-4", "me-5"];

  async function runMixed(): Promise<{
    coord: InstanceType<CoordinatorModule["RadarCoordinator"]>;
    runId: string;
  }> {
    const items = UUIDS.map(item);
    // Descending rewards → deterministic best_ev order me-1..me-5.
    const details = detailsOf({
      "me-1": { p1: 25000, researchers: "200", submissions: "200", rewarded: "100", webTargets: 3, lastBriefUpdate: RECENT },
      "me-2": { p1: 20000, researchers: "200", submissions: "200", rewarded: "100", webTargets: 3, lastBriefUpdate: RECENT },
      "me-3": { p1: 15000, researchers: "200", submissions: "200", rewarded: "100", webTargets: 3, lastBriefUpdate: RECENT },
      "me-4": { p1: 10000, researchers: "200", submissions: "200", rewarded: "100", webTargets: 3, lastBriefUpdate: RECENT },
      "me-5": { p1: 5000, researchers: "200", submissions: "200", rewarded: "100", webTargets: 3, lastBriefUpdate: RECENT },
    });
    const { deps, deepHydrate } = makeDeps(items, details, { deepLimit: 3 });
    deepHydrate.mockImplementation(
      async (_it: RadarCatalogItem, s: RadarProgramSnapshot) =>
        deepSnap(s, growthDeep()),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    // Single-pass today, union post-merge — either way me-1..me-3 (best_ev
    // top-3 within limit 3) are the deep set.
    expect([...run.deep_completed_uuids].sort()).toEqual(["me-1", "me-2", "me-3"]);
    return { coord, runId: run.run_id };
  }

  it('mode "deep" returns ONLY deep-evidence rows, each annotated deep', async () => {
    const { coord } = await runMixed();
    const rows = await coord.getResults("best_ev", 50, undefined, "deep");
    const myRows = mine(rows, UUIDS);
    expect(myRows.map((r) => r.uuid).sort()).toEqual(["me-1", "me-2", "me-3"]);
    for (const r of myRows) {
      expect(r.evidence_level).toBe("deep");
      // The row's score IS the deep score in deep mode.
      expect(r.score).toBe(r.deep_score);
      expect(r.metadata_score).not.toBeNull();
      expect(r.score_delta).not.toBeNull();
      // delta = round1(deep − meta) — sign preserved, never clamped.
      expect(r.score_delta).toBe(
        Number(((r.deep_score ?? 0) - (r.metadata_score ?? 0)).toFixed(1)),
      );
    }
    // Metadata-only programs never share the deep ranking.
    expect(myRows.map((r) => r.uuid)).not.toContain("me-4");
    expect(myRows.map((r) => r.uuid)).not.toContain("me-5");
  });

  it('mode "metadata" keeps the metadata score AND exposes deep_score/delta', async () => {
    const { coord } = await runMixed();
    const rows = await coord.getResults("best_ev", 50, undefined, "metadata");
    const myRows = mine(rows, UUIDS);
    expect(myRows).toHaveLength(5);
    for (const r of myRows) {
      // The ranking score is the metadata score in metadata mode — even for
      // deep-analyzed rows the meta baseline is never overwritten.
      expect(r.score).toBe(r.metadata_score);
      if (["me-1", "me-2", "me-3"].includes(r.uuid)) {
        expect(r.evidence_level).toBe("deep"); // DEEP badge
        expect(r.metadata_score).not.toBeNull();
        expect(r.deep_score).not.toBeNull();
        expect(r.score_delta).toBe(
          Number(((r.deep_score ?? 0) - (r.metadata_score ?? 0)).toFixed(1)),
        );
        // Richest-vector wins: the deep row's vector carries REAL deep
        // signal values even in metadata mode (not null, not 0).
        expect(r.signals.known_issue_density).not.toBeNull();
        expect(r.signals.opportunity_change).not.toBeNull();
      } else {
        expect(r.evidence_level).toBe("metadata");
        expect(r.deep_score).toBeNull();
        expect(r.score_delta).toBeNull();
      }
    }
  });

  it("getProgram exposes metadata_score + deep_score side by side", async () => {
    const { coord } = await runMixed();
    const deep = await coord.getProgram("me-1", "best_ev");
    expect(deep).not.toBeNull();
    expect(deep!.metadata_score).not.toBeNull();
    expect(deep!.deep_score).not.toBeNull();
    // Best-available score is the deep one; its vector carries deep signals.
    expect(deep!.score?.source_hash).toBe(deep!.deep_score!.source_hash);
    expect(deep!.vector?.known_issue_density.value).not.toBeNull();
    // A metadata-only program has no deep score — null, never fabricated.
    const meta = await coord.getProgram("me-4", "best_ev");
    expect(meta!.metadata_score).not.toBeNull();
    expect(meta!.deep_score).toBeNull();
    expect(meta!.score?.source_hash).toBe(meta!.metadata_score!.source_hash);
  });
});

// ---------------------------------------------------------------------------
// [CONTRACT] Null semantics — unknown stays null, never 0, never "no issues".
// ---------------------------------------------------------------------------

describe("[CONTRACT] null semantics on the results surface", () => {
  it("metadata-only rows keep deep signal columns null (never 0)", async () => {
    const items = ["ns-1", "ns-2", "ns-3"].map(item);
    const details = detailsOf({
      "ns-1": { p1: 25000, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
      "ns-2": { p1: 100, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
      "ns-3": { p1: 50, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
    });
    const { deps } = makeDeps(items, details, { deepLimit: 1 });
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");

    const rows = await coord.getResults("best_ev", 50, undefined, "metadata");
    const metaOnly = mine(rows, ["ns-2", "ns-3"]);
    expect(metaOnly).toHaveLength(2);
    for (const r of metaOnly) {
      // Strict null — a 0 here would fabricate "no known issues".
      expect(r.signals.known_issue_density).toBeNull();
      expect(r.signals.opportunity_change).toBeNull();
      expect(r.deep_score).toBeNull();
      expect(r.score_delta).toBeNull();
      expect(r.evidence_level).toBe("metadata");
    }
  });

  it("non-deep profiles produce NO deep rows — mode deep is empty for them", async () => {
    const items = ["nd-1", "nd-2"].map(item);
    const details = detailsOf({
      "nd-1": { p1: 25000, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
      "nd-2": { p1: 100, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
    });
    const { deps } = makeDeps(items, details, { deepLimit: 2 });
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    expect(run.deep_completed_uuids.length).toBeGreaterThan(0);

    for (const pid of ["high_reward", "easy_entry"] as const) {
      const rows = await coord.getResults(pid, 50, undefined, "deep");
      expect(mine(rows, ["nd-1", "nd-2"])).toEqual([]);
      // Store-level: the deep bucket for a non-deep profile is empty —
      // deep_scoring must never write a stage:"deep" row for a profile that
      // weights no deep signal (profile isolation).
      const db = await store.openRadarStore();
      const profile = getRadarProfile(pid);
      const staged = await store.getLatestScoreRowsByStage(
        db,
        profile.id,
        profile.version,
      );
      expect(
        staged.deep.filter((r) => ["nd-1", "nd-2"].includes(r.uuid)),
      ).toEqual([]);
      db.close();
    }
  });

  it("mode deep is empty when the run never had a deep stage", async () => {
    const items = ["nn-1"].map(item);
    const { deps } = makeDeps(items, detailsOf({}));
    delete deps.deepHydrate; // no dep → no deep stage at all
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    expect(run.deep_completed_uuids).toEqual([]);
    for (const pid of RADAR_PROFILE_IDS) {
      expect(
        mine(await coord.getResults(pid, 50, undefined, "deep"), ["nn-1"]),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// [CONTRACT] Profile isolation — deep analysis must not perturb non-deep
// profile rankings.
// ---------------------------------------------------------------------------

describe("[CONTRACT] profile isolation", () => {
  it("high_reward/easy_entry rankings identical before and after deep analysis", async () => {
    const uuids = ["pi-1", "pi-2", "pi-3"];
    const items = uuids.map(item);
    const details = detailsOf({
      "pi-1": { p1: 25000, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
      "pi-2": { p1: 10000, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
      "pi-3": { p1: 100, webTargets: 2, researchers: "200", submissions: "200", rewarded: "100" },
    });

    // Run A: no deep stage at all.
    const a = makeDeps(items, details);
    delete a.deps.deepHydrate;
    const coordA = new coordinator.RadarCoordinator(a.deps);
    const runA = await coordA.start();
    await coordA.waitForIdle();
    expect(runA.phase).toBe("done");
    const before: Record<string, RadarResultRow[]> = {};
    for (const pid of ["high_reward", "easy_entry"] as const) {
      before[pid] = mine(await coordA.getResults(pid, 50), uuids);
    }

    // Run B: same catalog, deep stage enabled — the deep pass must not move
    // a single high_reward/easy_entry row (no deep signals are weighted).
    const b = makeDeps(items, details, { deepLimit: 3 });
    const coordB = new coordinator.RadarCoordinator(b.deps);
    const runB = await coordB.start();
    await coordB.waitForIdle();
    expect(runB.phase).toBe("done");
    expect(runB.deep_completed_uuids.length).toBeGreaterThan(0);

    for (const pid of ["high_reward", "easy_entry"] as const) {
      const beforeRows = before[pid]!;
      const after = mine(await coordB.getResults(pid, 50), uuids);
      expect(after.map((r) => r.uuid)).toEqual(
        beforeRows.map((r) => r.uuid),
      );
      for (const [i, row] of after.entries()) {
        expect(row.score).toBe(beforeRows[i]!.score);
        expect(row.confidence).toBe(beforeRows[i]!.confidence);
        // Deep evidence can never attach to a non-deep profile row.
        expect(row.evidence_level).toBe("metadata");
        expect(row.deep_score).toBeNull();
        expect(row.score_delta).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// [CONTRACT] Deep-stage boundary probes — the deepHydrate dep contract is
// load-bearing; these pin what happens when it's violated.
// ---------------------------------------------------------------------------

describe("[CONTRACT] deepHydrate contract violations", () => {
  it("a deepHydrate that throws fails the run (plumbing bug = fatal)", async () => {
    const items = ["dh-1", "dh-2"].map(item);
    const details = detailsOf({
      "dh-1": { p1: 25000, webTargets: 2 },
      "dh-2": { p1: 100, webTargets: 2 },
    });
    const { deps, deepHydrate } = makeDeps(items, details, { deepLimit: 2 });
    deepHydrate.mockRejectedValueOnce(new Error("dep broke contract"));
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    // The dep promises never to throw; a throw is a plumbing bug and the
    // run fails closed rather than fabricating deep data.
    expect(run.phase).toBe("failed");
    expect(run.summary?.status).toBe("failed");
  });

  it("AUDIT PROBE: deepHydrate returning another uuid's snapshot silently skews bookkeeping", async () => {
    const items = ["dw-1", "dw-2"].map(item);
    const details = detailsOf({
      "dw-1": { p1: 25000, webTargets: 2 },
      "dw-2": { p1: 100, webTargets: 2 },
    });
    const { deps, deepHydrate } = makeDeps(items, details, { deepLimit: 2 });
    deepHydrate.mockImplementation(
      async (_it: RadarCatalogItem, s: RadarProgramSnapshot) =>
        // Contract violation: returns a snapshot for a DIFFERENT uuid.
        deepSnap({ ...s, uuid: "dw-injected" }, benignDeep()),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    // Bookkeeping marks the REQUESTED uuids deep-completed…
    expect([...run.deep_completed_uuids].sort()).toEqual(["dw-1", "dw-2"]);
    // …but no deep score exists for them (their snapshots never gained a
    // deep payload) — deep_completed ≠ deep-analyzed here.
    const rows = await coord.getResults("best_ev", 50, undefined, "deep");
    expect(mine(rows, ["dw-1", "dw-2"])).toEqual([]);
    // The wrong-uuid snapshot row was persisted verbatim — the worker does
    // not validate the dep's return shape. (Audit finding D2.)
    const db = await store.openRadarStore();
    const injected = await store.getLatestSnapshot(db, "dw-injected");
    expect(injected?.deep).not.toBeNull();
    db.close();
  });

  it("AUDIT PROBE: deepHydrate keeping the same source_hash mutates the metadata snapshot row in place", async () => {
    const items = ["dh-same"].map(item);
    const { deps, deepHydrate } = makeDeps(items, detailsOf({}), {
      deepLimit: 1,
    });
    deepHydrate.mockImplementation(
      async (_it: RadarCatalogItem, s: RadarProgramSnapshot) =>
        // Contract violation: deep payload set but source_hash unchanged.
        ({ ...s, deep: benignDeep() }) as RadarProgramSnapshot,
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    const db = await store.openRadarStore();
    // The [uuid, hash] snapshot row was overwritten IN PLACE — the metadata
    // snapshot is gone (latest now carries deep). Finding D3.
    const latest = await store.getLatestSnapshot(db, "dh-same");
    expect(latest?.deep).not.toBeNull();
    // CASCADE: the deep re-score writes stage:"deep" under THE SAME
    // source_hash → same score key [uuid, profile, version, hash] → the
    // metadata score row is overwritten — the V1.3.1 invariant "metadata
    // scores are never overwritten" is destroyed by the dep violation.
    const metaRows = mine(
      await coord.getResults("best_ev", 50, undefined, "metadata"),
      ["dh-same"],
    );
    expect(metaRows).toEqual([]); // baseline gone from metadata mode
    const deepRows = mine(
      await coord.getResults("best_ev", 50, undefined, "deep"),
      ["dh-same"],
    );
    expect(deepRows).toHaveLength(1);
    expect(deepRows[0]!.metadata_score).toBeNull(); // nothing to diff against
    expect(deepRows[0]!.score_delta).toBeNull();
    const prog = await coord.getProgram("dh-same", "best_ev");
    expect(prog?.metadata_score).toBeNull();
    expect(prog?.deep_score).not.toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// [CONTRACT] Resume — persisted active runs continue without redoing work.
// (Round-aware assertions live in radar-v131-stabilization.test.ts.)
// ---------------------------------------------------------------------------

describe("[CONTRACT] deep-stage resume", () => {
  async function seedMetadataScoredRun(uuids: string[]): Promise<string> {
    const db = await store.openRadarStore();
    const items = uuids.map(item);
    await store.putCatalogItems(db, items);
    for (const uuid of uuids) {
      const s = snap(item(uuid), detailsOf({}).get(uuid) ?? {});
      await store.putSnapshot(db, s, T0);
      const vector = extractProgramFeatures(s, T0);
      for (const pid of RADAR_PROFILE_IDS) {
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
    const runId = `run-seeded-${++runSeq}`;
    await store.putRun(db, {
      run_id: runId,
      phase: "deep_enriching",
      discovered: uuids.length,
      enriched: uuids.length,
      scored: uuids.length,
      pending_uuids: [],
      completed_uuids: uuids,
      deep_pending_uuids: uuids.slice(0, 2),
      deep_completed_uuids: uuids.slice(2),
      deep_enriched: uuids.length - 2,
      deep_candidates: uuids.map((uuid, i) => ({
        uuid,
        reasons: [{ profile: "best_ev", metadata_rank: i + 1 }],
      })),
      deep_round: 1,
      deep_budget: 6,
      deep_stabilization: null,
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
    });
    // The two "already deep-analyzed" uuids carry deep snapshots so the
    // resumed deep_scoring pass can score them without re-enrichment.
    for (const uuid of uuids.slice(2)) {
      const meta = await store.getLatestSnapshot(db, uuid);
      await store.putSnapshot(db, deepSnap(meta!, benignDeep()), T0);
    }
    await store.setLatestRunId(db, runId);
    db.close();
    return runId;
  }

  it("resume() drains deep_pending without re-enriching deep_completed", async () => {
    const uuids = ["rs-1", "rs-2", "rs-3", "rs-4"];
    const runId = await seedMetadataScoredRun(uuids);
    const { deps, deepHydrate } = makeDeps(uuids.map(item), detailsOf({}));
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();

    // Only the PENDING uuids are deep-enriched — completed work is never
    // redone after a service-worker restart.
    expect(deepHydrate).toHaveBeenCalledTimes(2);
    expect(deepHydrate.mock.calls.map((c) => c[1].uuid).sort()).toEqual([
      "rs-1",
      "rs-2",
    ]);

    const db = await store.openRadarStore();
    const rec = await store.getRun(db, runId);
    expect(rec?.phase).toBe("done");
    expect(rec?.deep_pending_uuids).toEqual([]);
    expect([...(rec?.deep_completed_uuids as string[])].sort()).toEqual(
      uuids,
    );
    db.close();

    // All four hold deep scores → all four surface in mode "deep".
    const rows = mine(
      await coord.getResults("best_ev", 50, undefined, "deep"),
      uuids,
    );
    expect(rows.map((r) => r.uuid).sort()).toEqual(uuids);
    for (const r of rows) expect(r.evidence_level).toBe("deep");
  });

  it("AUDIT PROBE: catalog re-enumeration during deep_enriching rewinds the phase — and deepEnrichPhase clobbers it", async () => {
    // Finding D1: deepEnrichPhase checks run.phase BEFORE
    // ensureCatalogItems (coordinator.ts:970) but not after — unlike
    // enrichPhase, which re-checks at line 802. If the catalog store is
    // incomplete at resume, ensureCatalogItems → enumerateCatalog rewinds
    // run.phase to "enriching" and repopulates pending_uuids…
    const db = await store.openRadarStore();
    // …but the deep phase then runs anyway and force-sets "deep_scoring",
    // so the rewound metadata queue NEVER drains. Seed: deep_enriching run
    // with pending "px-1", but NO catalog row for it.
    const runId = `run-seeded-${++runSeq}`;
    await store.putRun(db, {
      run_id: runId,
      phase: "deep_enriching",
      discovered: 1,
      enriched: 0,
      scored: 0,
      pending_uuids: [],
      completed_uuids: [],
      deep_pending_uuids: ["px-1"],
      deep_completed_uuids: [],
      deep_enriched: 0,
      deep_candidates: [
        { uuid: "px-1", reasons: [{ profile: "best_ev", metadata_rank: 1 }] },
      ],
      deep_round: 1,
      deep_budget: 6,
      deep_stabilization: null,
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: false,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
    });
    await store.setLatestRunId(db, runId);
    db.close();

    // enumerate returns the missing item — the rewind supplies it.
    const { deps, deepHydrate } = makeDeps([item("px-1")], detailsOf({}));
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();
    const db2 = await store.openRadarStore();
    const rec = await store.getRun(db2, runId);

    // PINNED CURRENT BEHAVIOR (bug): the run ends "done" — deepEnrichPhase
    // ran deep workers and forced "deep_scoring", so px-1 is marked
    // deep-complete while its metadata enrichment NEVER ran (pending_uuids
    // still holds it; no snapshot exists). Correct behavior after the fix:
    // deepEnrichPhase returns once ensureCatalogItems rewinds the phase,
    // and the resumed enrich pass hydrates px-1 first.
    expect(rec?.phase).toBe("done");
    expect(rec?.pending_uuids).toEqual(["px-1"]); // metadata work stranded
    expect(await store.getLatestSnapshot(db2, "px-1")).toBeNull();
    // deepHydrate ran on a program that has no metadata snapshot —
    // getLatestSnapshot returned null so the worker skipped enrichment,
    // yet still marked it deep-completed:
    expect(deepHydrate).not.toHaveBeenCalled();
    expect(rec?.deep_completed_uuids).toEqual(["px-1"]);
    db2.close();
  });

  it("a persisted cancel_requested=true is honored on resume (no work runs)", async () => {
    const db = await store.openRadarStore();
    await store.putCatalogItems(db, [item("rc-1")]);
    await store.putRun(db, {
      run_id: `run-seeded-${++runSeq}`,
      phase: "deep_enriching",
      discovered: 1,
      enriched: 1,
      scored: 1,
      pending_uuids: [],
      completed_uuids: ["rc-1"],
      deep_pending_uuids: ["rc-1"],
      deep_completed_uuids: [],
      deep_enriched: 0,
      deep_candidates: [],
      deep_round: 0,
      deep_budget: 0,
      deep_stabilization: null,
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 0,
      warning_details: [],
      // A kill that raced the cancel checkpoint: the flag persisted but the
      // phase stayed active. Resume must honor it, not resume work.
      cancel_requested: true,
    });
    const runId = `run-seeded-${runSeq}`;
    await store.setLatestRunId(db, runId);
    db.close();

    const { deps, deepHydrate } = makeDeps([item("rc-1")], detailsOf({}));
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();
    expect(deepHydrate).not.toHaveBeenCalled();
    const rec = await store.getRun(await store.openRadarStore(), runId);
    expect(rec?.phase).toBe("cancelled");
  });

  it("a coordinator killed mid-deep-stage resumes deterministically (same results as a clean run)", async () => {
    const uuids = ["rk-1", "rk-2", "rk-3"];
    const items = uuids.map(item);
    const details = detailsOf({
      "rk-1": { p1: 25000, webTargets: 2 },
      "rk-2": { p1: 10000, webTargets: 2 },
      "rk-3": { p1: 100, webTargets: 2 },
    });

    // Coordinator A: killed (worker hung forever) after one deep completion.
    const a = makeDeps(items, details, { deepLimit: 3, concurrency: 1 });
    const hang = new Promise<RadarProgramSnapshot>(() => {});
    a.deps.deepHydrate = vi.fn(
      (_it: RadarCatalogItem, s: RadarProgramSnapshot) =>
        s.uuid === "rk-1" ? Promise.resolve(deepSnap(s, benignDeep())) : hang,
    );
    const coordA = new coordinator.RadarCoordinator(a.deps);
    const runA = await coordA.start();
    const db = await store.openRadarStore();
    await until(async () => {
      const rec = await store.getRun(db, runA.run_id);
      return (
        Array.isArray(rec?.deep_completed_uuids) &&
        (rec.deep_completed_uuids as string[]).includes("rk-1")
      );
    });
    // Simulated SW death: A stays hung; B resumes from the persisted record.
    const b = makeDeps(items, details, { deepLimit: 3, concurrency: 1 });
    const coordB = new coordinator.RadarCoordinator(b.deps);
    await coordB.resume();
    const recB = await store.getRun(db, runA.run_id);
    expect(recB?.phase).toBe("done");
    // rk-1 was checkpointed complete — B must not re-enrich it.
    expect(b.deepHydrate.mock.calls.map((c) => c[1].uuid).sort()).toEqual([
      "rk-2",
      "rk-3",
    ]);

    // Determinism: a clean run over the same catalog yields the same
    // deep-mode scores for these uuids.
    const resumed = new Map(
      mine(
        await coordB.getResults("best_ev", 50, undefined, "deep"),
        uuids,
      ).map((r) => [r.uuid, r.score]),
    );
    const c = makeDeps(items, details, { deepLimit: 3 });
    const coordC = new coordinator.RadarCoordinator(c.deps);
    const runC = await coordC.start();
    await coordC.waitForIdle();
    expect(runC.phase).toBe("done");
    const clean = new Map(
      mine(
        await coordC.getResults("best_ev", 50, undefined, "deep"),
        uuids,
      ).map((r) => [r.uuid, r.score]),
    );
    expect(resumed).toEqual(clean);
    db.close();
    // coordA intentionally left hung — it models the dead worker.
  });
});
