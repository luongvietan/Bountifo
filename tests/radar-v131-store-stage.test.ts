import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRadarMessage } from "../lib/messages";
import type { CatalogScanResult } from "../lib/radar/catalog";
import { getRadarProfile } from "../lib/radar/profiles";
import { annotateEvidence } from "../lib/radar/stage";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";
import {
  DEEP_BATCH_SIZE,
  DEEP_PROFILE_IDS,
  MAX_DEEP_PROGRAMS,
  PROFILE_CANDIDATE_DEPTH,
  STABILITY_BUFFER,
  STABLE_TOP_K,
  type ProgramScore,
  type RadarCatalogItem,
  type RadarProgramSnapshot,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.3.1 adversarial contract tests: STORE + STAGE + RUN
// RECORD NORMALIZATION layer.
//
// Everything in this file is CONTRACT-READY: it exercises only seams the
// contract commit landed (ScoreRow.stage, scoreRowStage,
// getLatestScoreRowsByStage, annotateEvidence, the V1.3.1 run-record fields,
// RADAR_GET_RESULTS.mode, the V1.3.1 constants). No stabilization-loop
// integration is required — these tests are green on this branch and must
// stay green after the coordinator merge.
//
// Adversarial probes against normalizeRunRecord (malformed persisted
// deep_candidates / spoofed bookkeeping) and stage spoofing via crafted
// score rows / mutated snapshots live here — findings feed
// .superpowers/sdd/2026-09-24-radar-v1.3.1/agent-e-audit.md.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";
const BEST_EV_VERSION = getRadarProfile("best_ev").version;

type CoordinatorModule = typeof import("../lib/radar/coordinator");
type StoreModule = typeof import("../lib/radar/store");

let coordinator: CoordinatorModule;
let store: StoreModule;
let runSeq = 0;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  store = await import("../lib/radar/store");
  coordinator = await import("../lib/radar/coordinator");
});

// -- fixtures ---------------------------------------------------------------

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

function snapshot(
  uuid: string,
  sourceHash: string,
  opts: { deep?: boolean } = {},
): RadarProgramSnapshot {
  const base: RadarProgramSnapshot = {
    schema_version: 1,
    uuid,
    code: `c-${uuid}`,
    catalog: item(uuid),
    detail: null,
    enrichment: { status: "unavailable", error_kind: "forbidden" },
    source_hash: sourceHash,
  };
  if (opts.deep !== true) return base;
  return {
    ...base,
    deep: {
      status: "complete",
      known_issues: { status: "complete", unique_count: 5, total_count: 20 },
      semantic_diff: {
        status: "no_baseline",
        from_version: null,
        to_version: "v-1",
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
    },
  };
}

function score(
  uuid: string,
  sourceHash: string,
  value: number | null,
  profile: ProgramScore["profile"] = "best_ev",
): ProgramScore {
  return {
    schema_version: 1,
    engagement_uuid: uuid,
    profile,
    scoring_version: BEST_EV_VERSION,
    score: value,
    confidence: 0.9,
    provisional: false,
    components: {},
    reasons: [],
    source_hash: sourceHash,
  };
}

/**
 * Writes a score row bypassing putScore's stage stamping — for legacy
 * (no `stage` field) and spoofed-stage rows. The scores store performs no
 * schema validation on write: whatever lands here is what queries read back.
 */
async function putRawScoreRow(
  db: Awaited<ReturnType<StoreModule["openRadarStore"]>>,
  row: Record<string, unknown>,
): Promise<void> {
  await db.put("scores", row);
}

function rawScoreRow(
  uuid: string,
  sourceHash: string,
  value: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    profile: "best_ev",
    scoring_version: BEST_EV_VERSION,
    source_hash: sourceHash,
    stored_at: T0,
    score: score(uuid, sourceHash, value),
    ...extra,
  };
}

function makeDeps(): { deps: RadarCoordinatorDeps } {
  return {
    deps: {
      enumerate: async (): Promise<CatalogScanResult> => ({
        status: "complete",
        items: [],
        pages_fetched: 0,
        warnings: [],
      }),
      hydrate: async (it: RadarCatalogItem) => ({
        schema_version: 1,
        uuid: it.uuid,
        code: it.code,
        catalog: it,
        detail: null,
        enrichment: { status: "unavailable", error_kind: "forbidden" },
        source_hash: `sha256:${"00".repeat(32)}`,
      }),
      openStore: store.openRadarStore,
      now: () => T0,
      newRunId: () => `run-v131-store-${++runSeq}`,
    },
  };
}

// ---------------------------------------------------------------------------
// V1.3.1 constants — the contract pins these exact values.
// ---------------------------------------------------------------------------

describe("V1.3.1 constants", () => {
  it("pins the contract values verbatim", () => {
    expect(DEEP_PROFILE_IDS).toEqual([
      "best_ev",
      "fresh_programs",
      "low_competition",
      "authz_api",
    ]);
    expect(PROFILE_CANDIDATE_DEPTH).toBe(20);
    expect(STABLE_TOP_K).toBe(20);
    expect(STABILITY_BUFFER).toBe(10);
    expect(MAX_DEEP_PROGRAMS).toBe(60);
    expect(DEEP_BATCH_SIZE).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// annotateEvidence — the two-evidence-level annotation (pure function).
// ---------------------------------------------------------------------------

describe("annotateEvidence", () => {
  const meta = (v: number | null): ProgramScore => score("u-s", "h-meta", v);
  const deep = (v: number | null): ProgramScore => score("u-s", "h-deep", v);

  it("metadata-only program: level metadata, deep fields null, delta null", () => {
    expect(annotateEvidence(meta(60), null)).toEqual({
      evidence_level: "metadata",
      metadata_score: 60,
      deep_score: null,
      score_delta: null,
    });
  });

  it("deep-analyzed program: level deep, BOTH scores kept, delta = deep-meta", () => {
    const ann = annotateEvidence(meta(67.5), deep(57.5));
    expect(ann.evidence_level).toBe("deep");
    expect(ann.metadata_score).toBe(67.5);
    expect(ann.deep_score).toBe(57.5);
    // A crash delta is negative — never clamped, never absolutized.
    expect(ann.score_delta).toBe(-10);
  });

  it("delta rounds to 0.1 and can be positive", () => {
    const ann = annotateEvidence(meta(60.04), deep(72.09));
    expect(ann.score_delta).toBe(12.1); // 72.09-60.04 = 12.05 → 12.1 (fp path)
  });

  it("a null SCORE inside a deep row still means evidence level deep", () => {
    // The row exists (a deep pass ran and produced a null score) — evidence
    // was gathered even though it could not be condensed to a number.
    const ann = annotateEvidence(meta(60), deep(null));
    expect(ann.evidence_level).toBe("deep");
    expect(ann.deep_score).toBeNull();
    // No delta without both numeric endpoints — never falls back to meta,
    // never coerces null to 0.
    expect(ann.score_delta).toBeNull();
  });

  it("null metadata score + real deep score: delta still null (not deep-0)", () => {
    const ann = annotateEvidence(meta(null), deep(70));
    expect(ann.evidence_level).toBe("deep");
    expect(ann.metadata_score).toBeNull();
    expect(ann.score_delta).toBeNull();
  });

  it("neither score: level metadata, every field null", () => {
    expect(annotateEvidence(null, null)).toEqual({
      evidence_level: "metadata",
      metadata_score: null,
      deep_score: null,
      score_delta: null,
    });
  });
});

// ---------------------------------------------------------------------------
// ScoreRow.stage + scoreRowStage + getLatestScoreRowsByStage.
// ---------------------------------------------------------------------------

describe("score row stage bookkeeping", () => {
  it("putScore stage param round-trips; default is metadata", async () => {
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    await store.putScore(db, score(u, "h-a", 50), T0);
    await store.putScore(db, score(u, "h-b", 60), T0, undefined, "deep");
    const rows = await store.getScoreRows(db, u, "best_ev");
    const byHash = new Map(rows.map((r) => [r.source_hash, r]));
    expect(byHash.get("h-a")?.stage).toBe("metadata");
    expect(byHash.get("h-b")?.stage).toBe("deep");
    db.close();
  });

  it("scoreRowStage: explicit stage wins over the snapshot's deep payload", async () => {
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    // Snapshot carries deep under hash h-d — yet an explicit "metadata" row
    // pointing at it stays metadata. The written stage is the truth for new
    // rows; the snapshot is only the fallback for pre-V1.3.1 rows.
    await store.putSnapshot(db, snapshot(u, "h-d", { deep: true }), T0);
    const explicitMeta = rawScoreRow(u, "h-d", 10, { stage: "metadata" });
    await putRawScoreRow(db, explicitMeta);
    expect(await store.scoreRowStage(db, explicitMeta as never)).toBe(
      "metadata",
    );
    // And the mirror: explicit "deep" on a metadata-hash snapshot.
    await store.putSnapshot(db, snapshot(u, "h-m"), T0);
    const explicitDeep = rawScoreRow(u, "h-m", 20, { stage: "deep" });
    await putRawScoreRow(db, explicitDeep);
    expect(await store.scoreRowStage(db, explicitDeep as never)).toBe("deep");
    db.close();
  });

  it("scoreRowStage: legacy rows resolve via the snapshot's deep payload", async () => {
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    // No `stage` field — pre-V1.3.1 row shape.
    const metaRow = rawScoreRow(u, "h-meta", 30);
    const deepRow = rawScoreRow(u, "h-deep", 40);
    const orphanRow = rawScoreRow(u, "h-gone", 50);
    await store.putSnapshot(db, snapshot(u, "h-meta"), T0);
    await store.putSnapshot(db, snapshot(u, "h-deep", { deep: true }), T0);
    // h-gone deliberately has no snapshot row.
    expect(await store.scoreRowStage(db, metaRow as never)).toBe("metadata");
    expect(await store.scoreRowStage(db, deepRow as never)).toBe("deep");
    // Orphaned row → "metadata" (the embedded vector is the weaker evidence).
    expect(await store.scoreRowStage(db, orphanRow as never)).toBe(
      "metadata",
    );
    db.close();
  });

  it("getLatestScoreRowsByStage splits one uuid's two stage rows", async () => {
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    const other = `u-st-${crypto.randomUUID()}`;
    await store.putScore(db, score(u, "h-m1", 50), T0, undefined, "metadata");
    await store.putScore(db, score(u, "h-d1", 70), T0, undefined, "deep");
    // A second metadata row (newer hash) — latest per stage wins.
    await store.putScore(db, score(u, "h-m2", 55), T0, undefined, "metadata");
    // Noise: other uuid, other profile.
    await store.putScore(
      db,
      score(other, "h-x", 99, "high_reward"),
      T0,
      undefined,
      "deep",
    );
    const staged = await store.getLatestScoreRowsByStage(
      db,
      "best_ev",
      BEST_EV_VERSION,
    );
    const mine = (rows: typeof staged.metadata) =>
      rows.filter((r) => r.uuid === u);
    expect(mine(staged.metadata).map((r) => r.source_hash)).toEqual(["h-m2"]);
    expect(mine(staged.deep).map((r) => r.source_hash)).toEqual(["h-d1"]);
    // The other profile's deep row never leaks into best_ev buckets.
    expect(
      [...staged.metadata, ...staged.deep].filter((r) => r.uuid === other),
    ).toHaveLength(0);
    db.close();
  });

  it("legacy rows split by snapshot evidence, not by write order", async () => {
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    // Both rows legacy (no stage): h-m snapshot has no deep, h-d has deep.
    await store.putSnapshot(db, snapshot(u, "h-m"), T0);
    await store.putSnapshot(db, snapshot(u, "h-d", { deep: true }), T0);
    await putRawScoreRow(db, rawScoreRow(u, "h-d", 80)); // written first
    await putRawScoreRow(db, rawScoreRow(u, "h-m", 20)); // written second
    const staged = await store.getLatestScoreRowsByStage(
      db,
      "best_ev",
      BEST_EV_VERSION,
    );
    const mine = (rows: typeof staged.metadata) =>
      rows.filter((r) => r.uuid === u);
    // Write order must not smuggle the later-written metadata row past the
    // deep one — stage is content-derived.
    expect(mine(staged.metadata).map((r) => r.source_hash)).toEqual(["h-m"]);
    expect(mine(staged.deep).map((r) => r.source_hash)).toEqual(["h-d"]);
    db.close();
  });

  // -- adversarial stage-spoofing probes ------------------------------------

  it("AUDIT PROBE: mutating a snapshot under the same hash reclassifies legacy rows", async () => {
    // Stage resolution for legacy rows is a MUTABLE heuristic: it reads the
    // snapshot CURRENTLY stored at [uuid, source_hash]. Overwriting that
    // snapshot row with a deep-carrying payload (same hash — e.g. a
    // deepHydrate dep that forgets to re-hash) flips the score's resolved
    // stage after the fact. Pinned here so the behavior is conscious.
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    await store.putSnapshot(db, snapshot(u, "h-shared"), T0); // no deep
    const legacy = rawScoreRow(u, "h-shared", 42);
    await putRawScoreRow(db, legacy);
    expect(await store.scoreRowStage(db, legacy as never)).toBe("metadata");
    // In-place mutation of the snapshot row (same key, now carrying deep).
    await store.putSnapshot(db, snapshot(u, "h-shared", { deep: true }), T0);
    expect(await store.scoreRowStage(db, legacy as never)).toBe("deep");
    db.close();
  });

  it("AUDIT PROBE: any persisted stage starting with 'deep' lands in the deep bucket", async () => {
    // CONFIRMED BUG (agent-e-audit.md #S1): getLatestScoreRowsByStage builds
    // `key = `${stage}${uuid}`` (no separator) and bucket-splits on
    // `key.startsWith("deep")` — an unterminated prefix match. A persisted
    // score row whose stage is ANY string beginning with "deep" (corrupt
    // row, buggy writer, or hand-edited IDB) is classified as deep evidence.
    // scoreRowStage — the resolver getProgram uses — validates the enum and
    // resolves the same row via its snapshot → "metadata". The two stage
    // resolvers DISAGREE on the same stored row.
    const db = await store.openRadarStore();
    const u = `u-st-${crypto.randomUUID()}`;
    for (const [hash, spoofed] of [
      ["h-d1", "deep"],
      ["h-d2", "deepfake"],
      ["h-d3", "deep\trojan"],
      ["h-d4", "deep metadata"],
    ] as const) {
      await putRawScoreRow(db, rawScoreRow(u, hash, 99, { stage: spoofed }));
    }
    // A row with a plainly-non-enum stage that does NOT start with "deep".
    await putRawScoreRow(db, rawScoreRow(u, "h-junk", 11, { stage: "bogus" }));
    const staged = await store.getLatestScoreRowsByStage(
      db,
      "best_ev",
      BEST_EV_VERSION,
    );
    const mine = (rows: typeof staged.metadata) =>
      rows.filter((r) => r.uuid === u);
    // All four "deep*" stage strings classify DEEP — the bucket split is a
    // bare prefix test, so a spoofed stage lands a metadata-computed score
    // in the deep set. (Four distinct keys → all four survive.)
    expect(mine(staged.deep).map((r) => r.source_hash)).toEqual([
      "h-d1",
      "h-d2",
      "h-d3",
      "h-d4",
    ]);
    expect(mine(staged.metadata).map((r) => r.source_hash)).toEqual([
      "h-junk",
    ]);
    // And scoreRowStage — the strict resolver — classifies each spoofed row
    // by snapshot lookup (absent snapshot → "metadata"), contradicting the
    // bucket split above.
    for (const hash of ["h-d2", "h-d3", "h-d4"]) {
      const row = (await store.getScoreRows(db, u, "best_ev")).find(
        (r) => r.source_hash === hash,
      )!;
      expect(await store.scoreRowStage(db, row)).toBe("metadata");
    }
    db.close();
  });

  it("AUDIT PROBE: missing key separator lets a crafted row shadow a legit one", async () => {
    // key = `${stage}${uuid}` — pairs ("meta","data-x") and
    // ("metadata","-x") produce the SAME key "metadata-x". Both rows share
    // one latest-slot; the newer stored_at wins and the loser's row is
    // dropped from the staged results entirely (denial-of-results by
    // collision). Requires a non-enum stage — same preconditions as #S1.
    const db = await store.openRadarStore();
    const legit = rawScoreRow("-x", "h-legit", 10, { stage: "metadata" });
    const crafted = rawScoreRow("data-x", "h-crafted", 99, {
      stage: "meta",
    });
    await putRawScoreRow(db, legit);
    await putRawScoreRow(db, {
      ...crafted,
      stored_at: "2026-09-22T00:00:00.000Z", // newer wins the shared slot
    });
    const staged = await store.getLatestScoreRowsByStage(
      db,
      "best_ev",
      BEST_EV_VERSION,
    );
    const uuids = [...staged.metadata, ...staged.deep].map((r) => r.uuid);
    // The legit row's uuid is gone — shadowed by the crafted collision.
    expect(uuids).not.toContain("-x");
    expect(uuids).toContain("data-x");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// normalizeRunRecord — adversarial persisted-state shapes (via getState()).
// The store layer is loose on purpose; the coordinator must normalize, never
// trust, what it reads back — and never crash on garbage.
// ---------------------------------------------------------------------------

async function seedRun(record: Record<string, unknown>): Promise<string> {
  const runId = `run-norm-${++runSeq}`;
  const db = await store.openRadarStore();
  await store.putRun(db, { ...record, run_id: runId });
  await store.setLatestRunId(db, runId);
  db.close();
  return runId;
}

function baseRunRecord(over: Record<string, unknown> = {}) {
  return {
    phase: "done",
    discovered: 0,
    enriched: 0,
    scored: 0,
    pending_uuids: [],
    completed_uuids: [],
    warnings: 0,
    started_at: T0,
    updated_at: T0,
    catalog_complete: true,
    enrichment_failed: 0,
    warning_details: [],
    cancel_requested: false,
    deep_pending_uuids: [],
    deep_completed_uuids: [],
    deep_enriched: 0,
    deep_candidates: [],
    deep_round: 0,
    deep_budget: 0,
    deep_stabilization: null,
    ...over,
  };
}

describe("normalizeRunRecord adversarial inputs", () => {
  it("V1.3-legacy records (no V1.3.1 fields at all) normalize to defaults", async () => {
    const legacy = baseRunRecord();
    for (const k of [
      "deep_pending_uuids",
      "deep_completed_uuids",
      "deep_enriched",
      "deep_candidates",
      "deep_round",
      "deep_budget",
      "deep_stabilization",
    ]) {
      delete (legacy as Record<string, unknown>)[k];
    }
    await seedRun(legacy);
    const { deps } = makeDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const state = await coord.getState();
    expect(state).not.toBeNull();
    expect(state!.deep_pending_uuids).toEqual([]);
    expect(state!.deep_completed_uuids).toEqual([]);
    expect(state!.deep_enriched).toBe(0);
    expect(state!.deep_candidates).toEqual([]);
    expect(state!.deep_round).toBe(0);
    expect(state!.deep_budget).toBe(0);
    expect(state!.deep_stabilization).toBeNull();
  });

  it("malformed deep_candidates: bad entries dropped, valid kept verbatim", async () => {
    await seedRun(
      baseRunRecord({
        deep_candidates: [
          null,
          "a-string",
          42,
          { uuid: 123, reasons: [] }, // non-string uuid → dropped
          { uuid: "", reasons: [] }, // empty uuid → dropped
          { reasons: [{ profile: "best_ev", metadata_rank: 1 }] }, // no uuid
          { uuid: "u-ok", reasons: "not-an-array" }, // reasons → []
          {
            uuid: "u-mixed",
            reasons: [
              { profile: "best_ev", metadata_rank: 3 },
              { profile: "not_a_profile", metadata_rank: 1 }, // bad profile
              { profile: "best_ev", metadata_rank: "2" }, // string rank
              { profile: "best_ev", metadata_rank: NaN },
              { profile: "best_ev", metadata_rank: Infinity },
              { profile: "fresh_programs", metadata_rank: 7.9 }, // floored → 7
              { profile: "low_competition", metadata_rank: -4 }, // negative kept!
              null,
              "junk",
            ],
          },
          { uuid: "u-noReasons" }, // reasons absent → []
        ],
      }),
    );
    const { deps } = makeDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const state = await coord.getState();
    expect(state!.deep_candidates).toEqual([
      { uuid: "u-ok", reasons: [] },
      {
        uuid: "u-mixed",
        reasons: [
          { profile: "best_ev", metadata_rank: 3 },
          { profile: "fresh_programs", metadata_rank: 7 },
          // AUDIT NOTE: a negative metadata_rank survives normalization —
          // nonsense provenance is admitted (floored, not rejected).
          { profile: "low_competition", metadata_rank: -4 },
        ],
      },
      { uuid: "u-noReasons", reasons: [] },
    ]);
  });

  it("non-array deep_candidates collapses to [] (never fabricated)", async () => {
    for (const junk of [
      "x",
      5,
      { uuid: "u" },
      null,
      undefined,
      { 0: { uuid: "u-dict" }, length: 1 }, // array-like object, not array
    ]) {
      await seedRun(baseRunRecord({ deep_candidates: junk }));
      const { deps } = makeDeps();
      const coord = new coordinator.RadarCoordinator(deps);
      const state = await coord.getState();
      expect(state!.deep_candidates).toEqual([]);
    }
  });

  it("uuid lists drop non-strings; counts reject negative/NaN/Infinity", async () => {
    await seedRun(
      baseRunRecord({
        deep_pending_uuids: ["u-p1", 7, null, { uuid: "x" }, "u-p2"],
        deep_completed_uuids: "not-an-array",
        deep_enriched: -3,
        deep_round: 2.9, // floored
        deep_budget: Number.POSITIVE_INFINITY,
        pending_uuids: ["u-meta", false],
      }),
    );
    const { deps } = makeDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const state = await coord.getState();
    expect(state!.deep_pending_uuids).toEqual(["u-p1", "u-p2"]);
    expect(state!.deep_completed_uuids).toEqual([]);
    expect(state!.deep_enriched).toBe(0);
    expect(state!.deep_round).toBe(2);
    expect(state!.deep_budget).toBe(0); // Infinity → 0, no clamp to MAX
    expect(state!.pending_uuids).toEqual(["u-meta"]);
  });

  it("deep_stabilization accepts only the enum; spoofed values → null", async () => {
    for (const [raw, expected] of [
      ["stable", "stable"],
      ["budget_limited", "budget_limited"],
      ["incomplete", "incomplete"],
      ["STABLE", null],
      ["stable ", null],
      ["done", null],
      [1, null],
      [true, null],
      [{ status: "stable" }, null],
    ] as const) {
      await seedRun(baseRunRecord({ deep_stabilization: raw }));
      const { deps } = makeDeps();
      const coord = new coordinator.RadarCoordinator(deps);
      const state = await coord.getState();
      expect(state!.deep_stabilization).toBe(expected);
    }
  });

  it("an unknown persisted phase resolves to failed (fail-closed)", async () => {
    await seedRun(baseRunRecord({ phase: "deep_stabilizing" })); // plausible-but-fake
    const { deps } = makeDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const state = await coord.getState();
    expect(state!.phase).toBe("failed");
  });

  it("summary spoofing: only `status` is validated — extra junk is adopted verbatim", async () => {
    // AUDIT NOTE: isSummary() checks `status` membership only; a persisted
    // summary with fabricated/absent fields round-trips into getState().
    await seedRun(
      baseRunRecord({
        summary: {
          status: "complete",
          discovered: "lots",
          deep_stabilization: "stable-but-invented",
          injected: ["a", "b"],
        },
      }),
    );
    const { deps } = makeDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const state = await coord.getState();
    // Pinned as-is: the spoofed summary is trusted. Consumers must not rely
    // on summary field types beyond status.
    expect(state!.summary).toMatchObject({
      status: "complete",
      discovered: "lots",
    });
  });

  it("cancel_requested: only literal true is honored (truthy junk → false)", async () => {
    for (const [raw, expected] of [
      [true, true],
      [1, false],
      ["true", false],
      [{}, false],
    ] as const) {
      await seedRun(
        baseRunRecord({ phase: "enriching", cancel_requested: raw }),
      );
      const { deps } = makeDeps();
      const coord = new coordinator.RadarCoordinator(deps);
      const state = await coord.getState();
      // Internal field — reach it via the persisted-record type cast.
      expect(
        (state as unknown as { cancel_requested: boolean }).cancel_requested,
      ).toBe(expected);
    }
  });

  it("a garbage-laden ACTIVE record still resumes without crashing", async () => {
    // Resilience pin: normalization must not throw, and an active phase with
    // unusable queues must terminate — not hang the executor.
    await seedRun(
      baseRunRecord({
        phase: "deep_enriching",
        completed_uuids: [1, "u-active"],
        deep_pending_uuids: [{ bad: true }, "u-active"],
        deep_candidates: "corrupt",
        deep_round: "many",
        deep_budget: -1,
        deep_stabilization: 42,
      }),
    );
    const { deps } = makeDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();
    const state = await coord.getState();
    // u-active has no catalog item/snapshot → completed without enrichment;
    // the run terminates rather than spinning on garbage.
    expect(["done", "failed"]).toContain(state!.phase);
    expect(state!.deep_pending_uuids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RADAR_GET_RESULTS mode parameter — message-schema contract.
// ---------------------------------------------------------------------------

describe("RADAR_GET_RESULTS mode (message schema)", () => {
  it("accepts metadata and deep modes", () => {
    for (const mode of ["metadata", "deep"] as const) {
      const parsed = parseRadarMessage({
        op: "RADAR_GET_RESULTS",
        profile: "best_ev",
        mode,
      });
      expect(parsed).toMatchObject({
        op: "RADAR_GET_RESULTS",
        profile: "best_ev",
        limit: 50,
        mode,
      });
    }
  });

  it("mode is optional (absent → no key → coordinator default)", () => {
    const parsed = parseRadarMessage({
      op: "RADAR_GET_RESULTS",
      profile: "low_competition",
      limit: 10,
    });
    expect(parsed).not.toBeNull();
    expect("mode" in parsed!).toBe(false);
  });

  it("rejects non-enum and non-string modes", () => {
    for (const bad of [
      "both",
      "DEEP",
      "enriched",
      1,
      null,
      ["deep"],
      { mode: "deep" },
    ]) {
      expect(
        parseRadarMessage({
          op: "RADAR_GET_RESULTS",
          profile: "best_ev",
          mode: bad,
        }),
      ).toBeNull();
    }
  });
});
