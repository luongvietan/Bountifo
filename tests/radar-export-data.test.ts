import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cohortPercentile } from "../lib/radar/percentile";
import { getRadarProfile } from "../lib/radar/profiles";
import {
  RADAR_PROFILE_IDS,
  type DeepStabilization,
  type ProgramFeatureVector,
  type ProgramScore,
  type RadarCatalogItem,
  type RadarEvidenceLevel,
  type RadarProfileId,
  type RadarProgramSnapshot,
} from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";
import type { RadarExportQuery } from "../lib/radar/export";

// ---------------------------------------------------------------------------
// Coordinator.getExportData — the assembled export snapshot. Same conventions
// as radar-coordinator.test.ts: fake-indexeddb backs the real `bce-radar` DB
// for the file's lifetime, so every test seeds unique uuid/run-id prefixes
// and terminal runs. The export path must NEVER call enumerate/hydrate —
// read-only over persisted rows.
// ---------------------------------------------------------------------------

type CoordinatorModule = typeof import("../lib/radar/coordinator");
type StoreModule = typeof import("../lib/radar/store");

const T0 = "2026-09-21T00:00:00.000Z";
const T1 = "2026-09-21T00:05:00.000Z";
const PROVENANCE = { app_version: "0.1.0-test", commit_sha: "abc1234" };

let coordinator: CoordinatorModule;
let store: StoreModule;
let seq = 0;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  store = await import("../lib/radar/store");
  coordinator = await import("../lib/radar/coordinator");
});

const uid = () => `ex-${(++seq).toString(36)}`;
const rid = () => `run-ex-${(++seq).toString(36)}`;
const hash = () => `sha256:${(++seq).toString(16).padStart(64, "0")}`;

function item(uuid: string, lifecycle = "live"): RadarCatalogItem {
  return {
    uuid,
    code: `c-${uuid}`,
    name: `Program ${uuid}`,
    lifecycle_status: lifecycle,
    engagement_type: "bug_bounty",
    discovered_at: T0,
  };
}

function detail(uuid: string, participation: string | null = null): ApiEngagementData {
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
    lastStatusTransition: T0,
    lastBriefUpdate: T0,
    safeHarborLevel: "full",
    statistics: {
      researchers_participating: { value: "50", window: "all_time" },
      vulnerabilities_rewarded: { value: "30", window: "90d" },
    },
    targetGroups: [
      {
        id: `g-${uuid}`,
        name: "Web",
        inScope: true,
        description: null,
        rewards: { p1: 5000, p2: 500, p3: 100, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: `t-${uuid}`,
        groupId: `g-${uuid}`,
        location: "https://a.example.com",
        name: "site",
        category: "website",
        tags: [],
        inScope: true,
      },
    ],
    participation,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: "2026-09-20",
  };
}

/** A full 20-signal vector; `value` shared unless overridden per key. */
function vector(
  value: number | null = 0.5,
  over: Partial<Record<keyof ProgramFeatureVector, number | null>> = {},
): ProgramFeatureVector {
  const out = { schema_version: 1 } as Record<string, unknown>;
  for (const key of [
    "reward_potential",
    "reward_breadth",
    "meaningful_surface",
    "api_surface",
    "api_surface_size",
    "web_surface",
    "researcher_competition",
    "rewarded_activity",
    "submission_activity",
    "research_saturation",
    "freshness",
    "safe_harbor",
    "target_data_quality",
    "accessibility",
    "known_issue_density",
    "opportunity_change",
    "authz_opportunity",
    "payout_realized",
    "scope_momentum",
    "ki_concentration",
  ]) {
    out[key] = {
      value: key in over ? over[key as keyof ProgramFeatureVector] : value,
      source: "engagement_detail",
      reason_code: `${key}_rule`,
    };
  }
  return out as unknown as ProgramFeatureVector;
}

function score(
  uuid: string,
  profile: RadarProfileId,
  value: number | null,
  sourceHash: string,
): ProgramScore {
  return {
    schema_version: 1,
    engagement_uuid: uuid,
    profile,
    scoring_version: getRadarProfile(profile).version,
    score: value,
    confidence: 0.9,
    provisional: false,
    components: {},
    reasons: [],
    source_hash: sourceHash,
  };
}

function snapshot(
  it: RadarCatalogItem,
  deep: RadarProgramSnapshot["deep"] = null,
  participation: string | null = null,
): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: it.uuid,
    code: it.code,
    catalog: it,
    detail: detail(it.uuid, participation),
    enrichment: { status: "complete" },
    deep,
    source_hash: hash(),
  };
}

interface SeedRunOpts {
  uuids: string[];
  deepCompleted?: string[];
  deepPending?: string[];
  deepCandidates?: string[];
  warnings?: number;
  warningDetails?: string[];
  stabilization?: DeepStabilization | null;
  summary?: boolean;
}

/** Persist a terminal run record + the latestRunId pointer. */
async function seedRun(
  runId: string,
  opts: SeedRunOpts,
): Promise<void> {
  const db = await store.openRadarStore();
  const deepCompleted = opts.deepCompleted ?? [];
  const deepCandidates = (opts.deepCandidates ?? deepCompleted).map((u) => ({
    uuid: u,
    reasons: [{ profile: "best_ev" as const, metadata_rank: 1 }],
  }));
  const deepRan =
    deepCandidates.length > 0 ||
    deepCompleted.length > 0 ||
    (opts.deepPending?.length ?? 0) > 0;
  await store.putRun(db, {
    run_id: runId,
    phase: "done",
    discovered: opts.uuids.length,
    enriched: opts.uuids.length,
    scored: opts.uuids.length,
    pending_uuids: [],
    completed_uuids: [...opts.uuids],
    warnings: opts.warnings ?? 0,
    started_at: T0,
    updated_at: T1,
    catalog_complete: true,
    enrichment_failed: 0,
    warning_details: opts.warningDetails ?? [],
    cancel_requested: false,
    deep_pending_uuids: opts.deepPending ?? [],
    deep_completed_uuids: deepCompleted,
    deep_enriched: deepCompleted.length,
    deep_candidates: deepCandidates,
    deep_round: deepRan ? 1 : 0,
    deep_budget: deepRan ? 60 : 0,
    deep_stabilization: opts.stabilization ?? (deepRan ? "stable" : null),
    ...(opts.summary === false
      ? {}
      : {
          summary: {
            status: "complete",
            catalog_complete: true,
            discovered: opts.uuids.length,
            enriched: opts.uuids.length,
            enrichment_failed: 0,
            scored: opts.uuids.length,
            warnings: opts.warningDetails ?? [],
            ...(deepRan
              ? {
                  deep_candidates: deepCandidates.length,
                  deep_analyzed: deepCompleted.length,
                  deep_enriched: deepCompleted.length,
                  deep_rounds: 1,
                  deep_budget: 60,
                  deep_stabilization:
                    opts.stabilization === undefined
                      ? "stable"
                      : opts.stabilization,
                }
              : {}),
          },
        }),
  });
  await store.setLatestRunId(db, runId);
  db.close();
}

async function seedScore(
  uuid: string,
  profile: RadarProfileId,
  stage: RadarEvidenceLevel,
  value: number | null,
  opts: { vec?: ProgramFeatureVector; hash?: string } = {},
): Promise<void> {
  const db = await store.openRadarStore();
  await store.putScore(
    db,
    score(uuid, profile, value, opts.hash ?? hash()),
    T1,
    opts.vec,
    stage,
  );
  db.close();
}

async function seedSnapshot(snap: RadarProgramSnapshot): Promise<void> {
  const db = await store.openRadarStore();
  await store.putSnapshot(db, snap, T1);
  db.close();
}

async function seedCatalog(items: RadarCatalogItem[]): Promise<void> {
  const db = await store.openRadarStore();
  await store.putCatalogItems(db, items);
  db.close();
}

function query(over: Partial<RadarExportQuery> = {}): RadarExportQuery {
  return {
    profiles: [...RADAR_PROFILE_IDS],
    limit: null,
    detail: true,
    diagnostics: true,
    provenance: PROVENANCE,
    ...over,
  };
}

/** A coordinator whose deps are all spies — getExportData must stay read-only. */
function readerCoordinator() {
  return new coordinator.RadarCoordinator({
    enumerate: vi.fn(async () => {
      throw new Error("export must not enumerate");
    }),
    hydrate: vi.fn(async () => {
      throw new Error("export must not hydrate");
    }),
    openStore: store.openRadarStore,
    now: () => T1,
    newRunId: () => rid(),
  });
}

// ---------------------------------------------------------------------------

describe("RadarCoordinator.getExportData", () => {
  it("returns null when no scan has ever run", async () => {
    const data = await readerCoordinator().getExportData(query());
    expect(data).toBeNull();
  });

  it("assembles all six profile sections in pinned order with versions", async () => {
    const u1 = uid();
    const it1 = item(u1);
    await seedCatalog([it1]);
    await seedSnapshot(snapshot(it1));
    for (const p of RADAR_PROFILE_IDS) await seedScore(u1, p, "metadata", 70);
    const runId = rid();
    await seedRun(runId, { uuids: [u1] });

    const data = await readerCoordinator().getExportData(query());
    expect(data).not.toBeNull();
    expect(data!.run.run_id).toBe(runId);
    expect(data!.run.status).toBe("complete");
    expect(data!.run.discovered).toBe(1);
    expect(data!.sections.map((s) => s.profile_id)).toEqual([
      ...RADAR_PROFILE_IDS,
    ]);
    expect(data!.sections.map((s) => s.profile_version)).toEqual(
      RADAR_PROFILE_IDS.map((p) => getRadarProfile(p).version),
    );
    for (const s of data!.sections) {
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.uuid).toBe(u1);
      expect(s.rows[0]!.evidence_level).toBe("metadata");
      expect(s.rows[0]!.deep_score).toBeNull();
      expect(s.rows[0]!.deep).toBeNull();
    }
  });

  it("scopes a single-profile export to one section", async () => {
    const u1 = uid();
    await seedCatalog([item(u1)]);
    await seedSnapshot(snapshot(item(u1)));
    await seedScore(u1, "low_competition", "metadata", 55);
    await seedRun(rid(), { uuids: [u1] });

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["low_competition"] }),
    );
    expect(data!.sections).toHaveLength(1);
    expect(data!.sections[0]!.profile_id).toBe("low_competition");
    expect(data!.options.profiles).toEqual(["low_competition"]);
  });

  it("isolates evidence stages: deep row carries both scores + digest", async () => {
    const u1 = uid();
    const u2 = uid();
    const it1 = item(u1);
    const it2 = item(u2);
    await seedCatalog([it1, it2]);
    await seedSnapshot(snapshot(it1));
    await seedSnapshot(snapshot(it2));
    for (const p of RADAR_PROFILE_IDS) {
      await seedScore(u1, p, "metadata", 70);
      await seedScore(u2, p, "metadata", 60);
    }
    // u1 was deep-analyzed: deep score rows exist ONLY for deep-capable
    // profiles — easy_entry/high_reward never get a deep row.
    const deepSnap = snapshot(it1, {
      status: "complete",
      known_issues: {
        status: "complete",
        unique_count: 4,
        total_count: 9,
        group_stats: {
          status: "skipped_low_volume",
          groups_fetched: 0,
          groups_total: 2,
        },
      },
      semantic_diff: {
        status: "complete",
        from_version: "v-0",
        to_version: "v-1",
        added_targets: 2,
        removed_targets: 0,
        added_in_scope_targets: 2,
        removed_in_scope_targets: 0,
        moved_in_scope: 0,
        moved_out_of_scope: 0,
        added_api_targets: 1,
        added_web_targets: 1,
        added_groups: 0,
        reward_increase: false,
        reward_decrease: false,
        safe_harbor_changed: false,
        status_changed: false,
        only_administrative_changes: false,
      },
      scope_arc: {
        status: "no_baseline",
        window_versions: null,
        diff: null,
      },
    });
    await seedSnapshot(deepSnap);
    for (const p of ["best_ev", "low_competition", "authz_api", "fresh_programs"] as const) {
      await seedScore(u1, p, "deep", 66, { hash: deepSnap.source_hash });
    }
    await seedRun(rid(), { uuids: [u1, u2], deepCompleted: [u1] });

    const data = await readerCoordinator().getExportData(query());
    const bestEv = data!.sections.find((s) => s.profile_id === "best_ev")!;
    const deepRow = bestEv.rows.find((r) => r.uuid === u1)!;
    const metaRow = bestEv.rows.find((r) => r.uuid === u2)!;

    expect(deepRow.evidence_level).toBe("deep");
    expect(deepRow.metadata_score).toBe(70);
    expect(deepRow.deep_score).toBe(66);
    expect(deepRow.score_delta).toBe(-4);
    expect(deepRow.deep?.status).toBe("complete");
    expect(deepRow.deep?.known_issues?.unique_count).toBe(4);
    expect(deepRow.deep?.known_issues?.group_stats?.status).toBe(
      "skipped_low_volume",
    );
    expect(deepRow.deep?.scope_arc?.status).toBe("no_baseline");
    expect(deepRow.detail?.stages.map((s) => s.stage)).toEqual([
      "metadata",
      "deep",
    ]);

    expect(metaRow.evidence_level).toBe("metadata");
    expect(metaRow.deep_score).toBeNull();
    expect(metaRow.score_delta).toBeNull();
    expect(metaRow.deep).toBeNull();
    expect(metaRow.detail?.stages.map((s) => s.stage)).toEqual(["metadata"]);

    // Metadata-only profile: u1's deep pass cannot fabricate a deep score.
    const easy = data!.sections.find((s) => s.profile_id === "easy_entry")!;
    const easyRow = easy.rows.find((r) => r.uuid === u1)!;
    expect(easyRow.evidence_level).toBe("metadata");
    expect(easyRow.deep_score).toBeNull();
  });

  it("gates stale deep rows: a deep score outside deep_completed stays metadata", async () => {
    const u1 = uid();
    const it1 = item(u1);
    await seedCatalog([it1]);
    await seedSnapshot(snapshot(it1));
    await seedScore(u1, "best_ev", "metadata", 70);
    // A stale deep score row exists (earlier run) but the latest run never
    // deep-analyzed u1.
    await seedScore(u1, "best_ev", "deep", 40);
    await seedRun(rid(), { uuids: [u1], deepCompleted: [] });

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    const row = data!.sections[0]!.rows[0]!;
    expect(row.evidence_level).toBe("metadata");
    expect(row.deep_score).toBeNull();
    expect(row.deep).toBeNull();
  });

  it("never mixes a second run's uuids into the latest run's export", async () => {
    const oldU = uid();
    const newU = uid();
    await seedCatalog([item(oldU), item(newU)]);
    await seedSnapshot(snapshot(item(oldU)));
    await seedSnapshot(snapshot(item(newU)));
    await seedScore(oldU, "best_ev", "metadata", 99);
    await seedScore(newU, "best_ev", "metadata", 50);
    await seedRun(rid(), { uuids: [newU] }); // oldU absent from latest scope

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    const uuids = data!.sections[0]!.rows.map((r) => r.uuid);
    expect(uuids).toEqual([newU]);
  });

  it("Top-N caps rows but percentile keeps full-cohort semantics", async () => {
    const uuids: string[] = [];
    const items: RadarCatalogItem[] = [];
    for (let i = 0; i < 25; i++) {
      const u = `${uid()}-${i}`;
      uuids.push(u);
      items.push(item(u));
      await seedSnapshot(snapshot(item(u)));
      // Descending scores → deterministic rank order.
      await seedScore(u, "best_ev", "metadata", 100 - i);
    }
    await seedCatalog(items);
    await seedRun(rid(), { uuids });

    const top20 = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"], limit: 20 }),
    );
    const sec = top20!.sections[0]!;
    expect(sec.total_ranked).toBe(25);
    expect(sec.eligible_count).toBe(25);
    expect(sec.exported_count).toBe(20);
    expect(sec.rows).toHaveLength(20);
    // Rank 20 of a 25-eligible cohort → 20.0. A window-recalculated
    // percentile would read 0.0.
    expect(sec.rows[19]!.rank).toBe(20);
    expect(sec.rows[19]!.percentile).toBe(cohortPercentile(20, 25));
    expect(sec.rows[0]!.percentile).toBe(cohortPercentile(1, 25));

    const all = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"], limit: null }),
    );
    expect(all!.sections[0]!.rows).toHaveLength(25);
    expect(all!.sections[0]!.rows[24]!.percentile).toBe(0);
  });

  it("honors detail=false by omitting per-row detail blocks", async () => {
    const u1 = uid();
    await seedCatalog([item(u1)]);
    await seedSnapshot(snapshot(item(u1)));
    await seedScore(u1, "best_ev", "metadata", 70, { vec: vector() });
    await seedRun(rid(), { uuids: [u1] });

    const bare = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"], detail: false }),
    );
    expect(bare!.sections[0]!.rows[0]!.detail).toBeUndefined();

    const full = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"], detail: true }),
    );
    const row = full!.sections[0]!.rows[0]!;
    expect(row.detail?.signal_meta.reward_potential?.reason_code).toBe(
      "reward_potential_rule",
    );
    expect(row.detail?.stages[0]?.source_hash).toMatch(/^sha256:/);
  });

  it("missing snapshot → null enrichment, no fabricated evidence", async () => {
    const u1 = uid();
    // Score rows exist (a snapshot existed at scan time) but the snapshot
    // row is gone now — export must report honestly, not synthesize.
    await seedScore(u1, "best_ev", "metadata", 65, { vec: vector(0.4) });
    await seedRun(rid(), { uuids: [u1] });

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    const row = data!.sections[0]!.rows[0]!;
    expect(row.enrichment_status).toBeNull();
    expect(row.deep).toBeNull();
    expect(row.slug).toBe(u1); // falls back to uuid without catalog/snapshot
    expect(row.engagement_url).toBe(`https://bugcrowd.com/engagements/${u1}`);
    expect(row.name).toBeNull();
    // Embedded vector still supplies the signals.
    expect(row.signals.reward_potential).toBe(0.4);
  });

  it("partial deep payload → honest digest + diagnostics tallies", async () => {
    const u1 = uid();
    const u2 = uid();
    const it1 = item(u1);
    const it2 = item(u2);
    await seedCatalog([it1, it2]);
    await seedSnapshot(snapshot(it1));
    await seedSnapshot(snapshot(it2));
    await seedScore(u1, "best_ev", "metadata", 70);
    await seedScore(u2, "best_ev", "metadata", 60);
    // u1: KI failed, diff unavailable, arc+group_stats absent → partial.
    const partialDeep = snapshot(it1, {
      status: "partial",
      known_issues: {
        status: "failed",
        unique_count: null,
        total_count: null,
      },
      semantic_diff: {
        status: "unavailable",
        from_version: null,
        to_version: null,
        added_targets: null,
        removed_targets: null,
        added_in_scope_targets: null,
        removed_in_scope_targets: null,
        moved_in_scope: null,
        moved_out_of_scope: null,
        added_api_targets: null,
        added_web_targets: null,
        added_groups: null,
        reward_increase: null,
        reward_decrease: null,
        safe_harbor_changed: null,
        status_changed: null,
        only_administrative_changes: null,
      },
      // scope_arc absent entirely (pre-V1.5 payload shape)
    });
    await seedSnapshot(partialDeep);
    await seedScore(u1, "best_ev", "deep", 68, {
      hash: partialDeep.source_hash,
    });
    // u2: deep-completed but the snapshot carries no deep payload at all
    // (detail was missing → worker completed it without enrichment).
    await seedRun(rid(), {
      uuids: [u1, u2],
      deepCompleted: [u1, u2],
      deepCandidates: [u1, u2, uid()], // one candidate never analyzed
      warnings: 0,
    });

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    const row = data!.sections[0]!.rows.find((r) => r.uuid === u1)!;
    expect(row.deep?.status).toBe("partial");
    expect(row.deep?.known_issues?.status).toBe("failed");
    expect(row.deep?.known_issues?.unique_count).toBeNull();
    expect(row.deep?.semantic_diff?.status).toBe("unavailable");
    expect(row.deep?.scope_arc).toBeNull();

    const diag = data!.diagnostics!;
    expect(diag.deep_candidates).toBe(3);
    expect(diag.deep_analyzed).toBe(2);
    expect(diag.not_analyzed).toBe(1);
    // u1 failed KI; u2's missing payload counts as absent — not zero, not ok.
    expect(diag.sub_sources.known_issues.failed).toBe(1);
    expect(diag.sub_sources.known_issues.absent).toBe(1);
    expect(diag.sub_sources.semantic_diff.unavailable).toBe(1);
    expect(diag.sub_sources.scope_arc.absent).toBe(2);
    expect(diag.sub_sources.group_stats.absent).toBe(2);
    // Coordinator warnings stayed 0 — the failed sub-source is still visible.
    expect(data!.run.warnings).toBe(0);
  });

  it("omits diagnostics when the option is off", async () => {
    const u1 = uid();
    await seedCatalog([item(u1)]);
    await seedSnapshot(snapshot(item(u1)));
    await seedScore(u1, "best_ev", "metadata", 70);
    await seedRun(rid(), { uuids: [u1], deepCompleted: [] });

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"], diagnostics: false }),
    );
    expect(data!.diagnostics).toBeNull();
  });

  it("flags gated/invitation-only programs for the restricted-access notice", async () => {
    const openU = uid();
    const gatedU = uid();
    await seedCatalog([item(openU, "live"), item(gatedU, "invite_only")]);
    await seedSnapshot(snapshot(item(openU, "live")));
    await seedSnapshot(snapshot(item(gatedU, "invite_only")));
    await seedScore(openU, "best_ev", "metadata", 70);
    await seedScore(gatedU, "best_ev", "metadata", 80);
    await seedRun(rid(), { uuids: [openU, gatedU] });

    const data = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    const rows = data!.sections[0]!.rows;
    expect(rows.find((r) => r.uuid === gatedU)!.restricted_access).toBe(true);
    expect(rows.find((r) => r.uuid === openU)!.restricted_access).toBe(false);
    expect(data!.restricted_access.count).toBe(1);
    expect(data!.restricted_access.programs).toEqual([`c-${gatedU}`]);
  });

  it("is read-only: no enumerate/hydrate calls, no store mutation", async () => {
    const u1 = uid();
    await seedCatalog([item(u1)]);
    await seedSnapshot(snapshot(item(u1)));
    await seedScore(u1, "best_ev", "metadata", 70, { vec: vector() });
    const runId = rid();
    await seedRun(runId, { uuids: [u1] });

    const db = await store.openRadarStore();
    const before = JSON.stringify(await store.getRun(db, runId));

    const reader = readerCoordinator();
    const data = await reader.getExportData(query());
    expect(data).not.toBeNull();

    const after = JSON.stringify(await store.getRun(db, runId));
    expect(after).toBe(before);
    db.close();
  });

  it("is deterministic for identical persisted data + options", async () => {
    const u1 = uid();
    await seedCatalog([item(u1)]);
    await seedSnapshot(snapshot(item(u1)));
    await seedScore(u1, "best_ev", "metadata", 70, { vec: vector() });
    await seedRun(rid(), { uuids: [u1] });

    const a = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    const b = await readerCoordinator().getExportData(
      query({ profiles: ["best_ev"] }),
    );
    expect(a).toEqual(b);
  });
});
