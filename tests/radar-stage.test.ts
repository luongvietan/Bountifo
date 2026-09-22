import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { RadarDeepEnrichment } from "../lib/radar/deepTypes";
import { RADAR_PROFILES } from "../lib/radar/profiles";
import { scoreProgram } from "../lib/radar/scoring";
import {
  annotateEvidence,
  deltaDirection,
  evidenceBadge,
  formatScoreDelta,
  isDeepProfile,
  profileDeepSignals,
  scoreForMode,
} from "../lib/radar/stage";
import {
  getLatestScoreRowsByStage,
  getScoreRows,
  openRadarStore,
  putScore,
  putSnapshot,
  scoreRowStage,
  type ScoreRow,
} from "../lib/radar/store";
import {
  DEEP_PROFILE_IDS,
  DEEP_SIGNAL_KEYS,
  RADAR_FEATURE_KEYS,
  RADAR_PROFILE_IDS,
} from "../lib/radar/types";
import type {
  ProgramFeatureVector,
  ProgramScore,
  RadarCatalogItem,
  RadarFeatureKey,
  RadarProgramSnapshot,
  RadarSignal,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Evidence-level semantics (V1.3.1). fake-indexeddb backs the real store; the
// `bce-radar` DB persists for the file's duration (same convention as
// radar-store.test.ts), so every test uses unique uuids and filters shared
// query results back down to its own rows.
// ---------------------------------------------------------------------------

const T1 = "2026-09-21T00:00:00.000Z";
const T2 = "2026-09-22T00:00:00.000Z";
const T3 = "2026-09-23T00:00:00.000Z";
const VERSION = "1.3.0";

function uuid(tag: string): string {
  return `u-stage-${tag}-${crypto.randomUUID()}`;
}

function hash(tag: string): string {
  return `sha256:${tag.padEnd(64, "0").slice(0, 64)}`;
}

function catalogItem(id: string): RadarCatalogItem {
  return {
    uuid: id,
    code: `c-${id}`,
    name: `Program ${id}`,
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: T1,
  };
}

/** A valid deep-enrichment payload (status/facts contract satisfied). */
function deepEnrichment(): RadarDeepEnrichment {
  return {
    status: "complete",
    known_issues: { status: "complete", unique_count: 10, total_count: 20 },
    semantic_diff: {
      status: "no_baseline",
      from_version: null,
      to_version: "v-latest",
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
  };
}

function snapshot(
  id: string,
  sourceHash: string,
  deep?: RadarDeepEnrichment | null,
): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: id,
    code: `c-${id}`,
    catalog: catalogItem(id),
    detail: null,
    enrichment: { status: "unavailable", error_kind: "forbidden" },
    ...(deep === undefined ? {} : { deep }),
    source_hash: sourceHash,
  };
}

function score(
  id: string,
  sourceHash: string,
  value: number | null,
  scoringVersion = VERSION,
  profile: ProgramScore["profile"] = "best_ev",
): ProgramScore {
  return {
    schema_version: 1,
    engagement_uuid: id,
    profile,
    scoring_version: scoringVersion,
    score: value,
    confidence: 0.9,
    provisional: false,
    components: {},
    reasons: [],
    source_hash: sourceHash,
  };
}

/** A pre-V1.3.1 score row: written straight to the store with no `stage`. */
async function putLegacyScoreRow(
  db: Awaited<ReturnType<typeof openRadarStore>>,
  row: ScoreRow,
): Promise<void> {
  await db.put("scores", row);
}

function legacyRow(
  id: string,
  sourceHash: string,
  value: number | null,
  storedAt: string,
  profile: ProgramScore["profile"] = "best_ev",
): ScoreRow {
  return {
    uuid: id,
    profile,
    scoring_version: VERSION,
    source_hash: sourceHash,
    stored_at: storedAt,
    score: score(id, sourceHash, value, VERSION, profile),
  };
}

function sig(value: number | null): RadarSignal {
  return { value, source: "engagement_detail", reason_code: "test" };
}

function vector(
  values: Partial<Record<RadarFeatureKey, number | null>> = {},
): ProgramFeatureVector {
  const v = {} as Record<RadarFeatureKey, RadarSignal>;
  for (const key of RADAR_FEATURE_KEYS) {
    v[key] = sig(values[key] ?? null);
  }
  return { schema_version: 1, ...v };
}

describe("annotateEvidence", () => {
  it("labels a row 'deep' iff a deep-stage score exists", () => {
    const meta = score("u", hash("m1"), 50);
    const deep = score("u", hash("d1"), 61.9);
    const ann = annotateEvidence(meta, deep);
    expect(ann.evidence_level).toBe("deep");
    expect(ann.metadata_score).toBe(50);
    expect(ann.deep_score).toBe(61.9);
    expect(ann.score_delta).toBe(11.9);
  });

  it("metadata-only rows annotate as 'metadata' with no deep fields", () => {
    const ann = annotateEvidence(score("u", hash("m2"), 50), null);
    expect(ann).toEqual({
      evidence_level: "metadata",
      metadata_score: 50,
      deep_score: null,
      score_delta: null,
    });
  });

  it("is null-safe on both endpoints", () => {
    expect(annotateEvidence(null, null)).toEqual({
      evidence_level: "metadata",
      metadata_score: null,
      deep_score: null,
      score_delta: null,
    });
    // Deep-only (metadata row missing — practically unreachable) still
    // reports the deep level but never invents a delta.
    const ann = annotateEvidence(null, score("u", hash("d2"), 70));
    expect(ann.evidence_level).toBe("deep");
    expect(ann.metadata_score).toBeNull();
    expect(ann.deep_score).toBe(70);
    expect(ann.score_delta).toBeNull();
  });

  it("computes signed deltas, including negative (deep can lower a score)", () => {
    const meta = score("u", hash("m3"), 72);
    const deep = score("u", hash("d3"), 61.9);
    const ann = annotateEvidence(meta, deep);
    expect(ann.score_delta).toBe(-10.1);
    expect(deltaDirection(ann.score_delta)).toBe("down");
  });

  it("rounds the delta to 0.1 and collapses -0 to 0", () => {
    // 11.94 → 11.9 and 11.96 → 12.0 (nearest tenth).
    expect(
      annotateEvidence(score("u", hash("m4"), 50), score("u", hash("d4"), 61.94))
        .score_delta,
    ).toBe(11.9);
    expect(
      annotateEvidence(score("u", hash("m5"), 50), score("u", hash("d5"), 61.96))
        .score_delta,
    ).toBe(12);
    // A sub-0.05 drop rounds to zero — "no change" carries no sign.
    const flat = annotateEvidence(
      score("u", hash("m6"), 50),
      score("u", hash("d6"), 49.97),
    ).score_delta;
    expect(flat).toBe(0);
    expect(Object.is(flat, -0)).toBe(false);
  });

  it("treats a null score field as a missing endpoint — never a zero", () => {
    // A ProgramScore with score:null exists (all weighted signals unknown)
    // but cannot anchor a delta; the deep row still marks the level.
    const ann = annotateEvidence(
      score("u", hash("m7"), null),
      score("u", hash("d7"), 55),
    );
    expect(ann.evidence_level).toBe("deep");
    expect(ann.metadata_score).toBeNull();
    expect(ann.deep_score).toBe(55);
    expect(ann.score_delta).toBeNull();
  });
});

describe("evidence presentation helpers", () => {
  it("scoreForMode returns the score the active mode ranks on", () => {
    const ann = annotateEvidence(score("u", hash("m8"), 50), score("u", hash("d8"), 70));
    expect(scoreForMode(ann, "metadata")).toBe(50);
    expect(scoreForMode(ann, "deep")).toBe(70);
    // Metadata-only row in deep mode: null — the caller hides it.
    const metaOnly = annotateEvidence(score("u", hash("m9"), 50), null);
    expect(scoreForMode(metaOnly, "deep")).toBeNull();
    expect(scoreForMode(metaOnly, "metadata")).toBe(50);
  });

  it("evidenceBadge marks only deep-backed rows", () => {
    expect(evidenceBadge("deep")).toBe("DEEP");
    expect(evidenceBadge("metadata")).toBeNull();
  });

  it("formatScoreDelta signs real deltas and renders null as '—'", () => {
    expect(formatScoreDelta(null)).toBe("—");
    expect(formatScoreDelta(1.94)).toBe("+1.9");
    expect(formatScoreDelta(-10.14)).toBe("-10.1");
    expect(formatScoreDelta(0)).toBe("+0.0");
    // A sub-0.05 magnitude formats as "+0.0" — never "-0.0".
    expect(formatScoreDelta(-0.03)).toBe("+0.0");
  });

  it("deltaDirection never maps null to 'flat'", () => {
    expect(deltaDirection(null)).toBe("none");
    expect(deltaDirection(2)).toBe("up");
    expect(deltaDirection(-2)).toBe("down");
    expect(deltaDirection(0)).toBe("flat");
    expect(deltaDirection(-0)).toBe("flat");
  });
});

describe("deep-profile derivation", () => {
  it("isDeepProfile agrees with DEEP_PROFILE_IDS for all six profiles", () => {
    const derived = RADAR_PROFILE_IDS.filter((id) => isDeepProfile(id));
    expect(new Set(derived)).toEqual(new Set(DEEP_PROFILE_IDS));
    // And the constant's documented priority order covers the same set.
    expect(DEEP_PROFILE_IDS).toHaveLength(4);
  });

  it("high_reward and easy_entry are not deep profiles", () => {
    expect(isDeepProfile("high_reward")).toBe(false);
    expect(isDeepProfile("easy_entry")).toBe(false);
    expect(profileDeepSignals("high_reward")).toEqual([]);
    expect(profileDeepSignals("easy_entry")).toEqual([]);
  });

  it("every deep signal is consumed by at least one deep profile, and no deep signal leaks into a non-deep profile's weights", () => {
    const consumed = new Set(
      DEEP_PROFILE_IDS.flatMap((id) => profileDeepSignals(id)),
    );
    for (const key of DEEP_SIGNAL_KEYS) {
      expect(consumed.has(key)).toBe(true);
    }
    for (const id of RADAR_PROFILE_IDS) {
      if ((DEEP_PROFILE_IDS as readonly string[]).includes(id)) continue;
      const weighted = Object.keys(RADAR_PROFILES[id].weights);
      for (const key of DEEP_SIGNAL_KEYS) {
        expect(weighted).not.toContain(key);
      }
    }
    // Pin the per-profile deep-signal sets (declared weight order).
    expect(new Set(profileDeepSignals("best_ev"))).toEqual(
      new Set(["known_issue_density", "opportunity_change"]),
    );
    expect(new Set(profileDeepSignals("low_competition"))).toEqual(
      new Set(["known_issue_density", "opportunity_change"]),
    );
    expect(profileDeepSignals("authz_api")).toEqual(["opportunity_change"]);
    expect(profileDeepSignals("fresh_programs")).toEqual([
      "opportunity_change",
    ]);
  });
});

describe("deep re-scoring is restricted to deep profiles", () => {
  const baseSignals = {
    reward_potential: 0.9,
    reward_breadth: 0.8,
    rewarded_activity: 0.7,
    target_data_quality: 0.8,
    freshness: 0.5,
    meaningful_surface: 0.6,
    safe_harbor: 1,
  } satisfies Partial<Record<RadarFeatureKey, number | null>>;

  const deepOnly = {
    known_issue_density: 0.9,
    opportunity_change: 0.1,
  } satisfies Partial<Record<RadarFeatureKey, number | null>>;

  it.each(["high_reward", "easy_entry"] as const)(
    "%s produces an identical score with or without deep signals — a deep row would add no evidence",
    (profileId) => {
      const snap = snapshot("u-indist", hash("indist"));
      const metaScore = scoreProgram(
        snap,
        vector(baseSignals),
        RADAR_PROFILES[profileId],
      );
      const deepScore = scoreProgram(
        snap,
        vector({ ...baseSignals, ...deepOnly }),
        RADAR_PROFILES[profileId],
      );
      // The whole record is identical: unweighted signals never even enter
      // components, so a "deep" re-score under these profiles is a no-op.
      expect(deepScore).toEqual(metaScore);
    },
  );

  it("a deep profile's score does move: low_competition meta 72 → deep 61.9 (delta -10.1)", () => {
    const snapMeta = snapshot("u-move", hash("move-m"));
    const snapDeep = snapshot("u-move", hash("move-d"));
    const metaScore = scoreProgram(
      snapMeta,
      vector({
        research_saturation: 0.2,
        freshness: 0.8,
        meaningful_surface: 0.6,
        reward_potential: 0.5,
        target_data_quality: 0.8,
      }),
      RADAR_PROFILES.low_competition,
    );
    const deepScore = scoreProgram(
      snapDeep,
      vector({
        research_saturation: 0.2,
        freshness: 0.8,
        meaningful_surface: 0.6,
        reward_potential: 0.5,
        target_data_quality: 0.8,
        known_issue_density: 0.9,
        opportunity_change: 0.9,
      }),
      RADAR_PROFILES.low_competition,
    );
    expect(metaScore.score).toBe(72);
    expect(deepScore.score).toBe(61.9);
    const ann = annotateEvidence(metaScore, deepScore);
    expect(ann.score_delta).toBe(-10.1);
    expect(deltaDirection(ann.score_delta)).toBe("down");
  });
});

describe("store: staged score rows", () => {
  it("keeps metadata and deep rows side by side under different source_hash — the metadata row is not overwritten", async () => {
    const db = await openRadarStore();
    const id = uuid("dual");
    const hMeta = hash(`m-${id}`);
    const hDeep = hash(`d-${id}`);
    await putScore(db, score(id, hMeta, 60), T1, undefined, "metadata");
    await putScore(db, score(id, hDeep, 61.9), T2, undefined, "deep");

    // Two physical rows: the deep row lives under the joined hash, so the
    // metadata baseline survives intact.
    const rows = await getScoreRows(db, id, "best_ev");
    expect(rows).toHaveLength(2);

    const staged = await getLatestScoreRowsByStage(db, "best_ev", VERSION);
    const meta = staged.metadata.find((r) => r.uuid === id);
    const deep = staged.deep.find((r) => r.uuid === id);
    expect(meta?.source_hash).toBe(hMeta);
    expect(meta?.score.score).toBe(60);
    expect(deep?.source_hash).toBe(hDeep);
    expect(deep?.score.score).toBe(61.9);
    db.close();
  });

  it("putScore writes stage 'metadata' by default", async () => {
    const db = await openRadarStore();
    const id = uuid("default");
    await putScore(db, score(id, hash(`m-${id}`), 40), T1);
    const rows = await getScoreRows(db, id, "best_ev");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stage).toBe("metadata");
    db.close();
  });

  it("returns the latest row per stage per uuid and filters by profile+version", async () => {
    const db = await openRadarStore();
    const id = uuid("latest");
    // Two metadata rows for the same uuid — newest stored_at wins.
    await putScore(db, score(id, hash(`a-${id}`), 50), T1, undefined, "metadata");
    await putScore(db, score(id, hash(`b-${id}`), 55), T3, undefined, "metadata");
    await putScore(db, score(id, hash(`c-${id}`), 66), T2, undefined, "deep");
    // Noise: same uuid, different profile and scoring version.
    await putScore(
      db,
      score(id, hash(`x-${id}`), 99, "9.9.9"),
      T3,
      undefined,
      "deep",
    );
    await putScore(
      db,
      score(id, hash(`y-${id}`), 88, VERSION, "low_competition"),
      T3,
      undefined,
      "deep",
    );
    const staged = await getLatestScoreRowsByStage(db, "best_ev", VERSION);
    const meta = staged.metadata.filter((r) => r.uuid === id);
    const deep = staged.deep.filter((r) => r.uuid === id);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.score.score).toBe(55);
    expect(deep).toHaveLength(1);
    expect(deep[0]?.score.score).toBe(66);
    db.close();
  });
});

describe("legacy score-row stage resolution", () => {
  it("a stage-less row resolves 'deep' iff its snapshot carries a deep payload", async () => {
    const db = await openRadarStore();
    const id = uuid("legacy");
    const hMeta = hash(`lm-${id}`);
    const hDeep = hash(`ld-${id}`);
    await putSnapshot(db, snapshot(id, hMeta), T1);
    await putSnapshot(db, snapshot(id, hDeep, deepEnrichment()), T2);
    const meta = legacyRow(id, hMeta, 60, T1);
    const deep = legacyRow(id, hDeep, 61.9, T2);
    await putLegacyScoreRow(db, meta);
    await putLegacyScoreRow(db, deep);

    expect(await scoreRowStage(db, meta)).toBe("metadata");
    expect(await scoreRowStage(db, deep)).toBe("deep");

    // The staged query resolves both through the snapshot map — legacy rows
    // land in the same buckets as explicit-stage rows.
    const staged = await getLatestScoreRowsByStage(db, "best_ev", VERSION);
    expect(staged.metadata.find((r) => r.uuid === id)?.source_hash).toBe(hMeta);
    expect(staged.deep.find((r) => r.uuid === id)?.source_hash).toBe(hDeep);
    db.close();
  });

  it("a stage-less row resolves 'metadata' when the snapshot has no deep payload (absent or explicit null)", async () => {
    const db = await openRadarStore();
    const idA = uuid("legacy-absent");
    const idB = uuid("legacy-null");
    const hA = hash(`la-${idA}`);
    const hB = hash(`ln-${idB}`);
    await putSnapshot(db, snapshot(idA, hA), T1); // deep field absent
    await putSnapshot(db, snapshot(idB, hB, null), T1); // deep: null
    const rowA = legacyRow(idA, hA, 50, T1);
    const rowB = legacyRow(idB, hB, 51, T1);
    await putLegacyScoreRow(db, rowA);
    await putLegacyScoreRow(db, rowB);
    expect(await scoreRowStage(db, rowA)).toBe("metadata");
    expect(await scoreRowStage(db, rowB)).toBe("metadata");
    db.close();
  });

  it("an orphaned stage-less row (no snapshot) resolves 'metadata' — never claims deep without proof", async () => {
    const db = await openRadarStore();
    const id = uuid("orphan");
    const h = hash(`o-${id}`);
    const row = legacyRow(id, h, 42, T1);
    await putLegacyScoreRow(db, row);
    expect(await scoreRowStage(db, row)).toBe("metadata");
    const staged = await getLatestScoreRowsByStage(db, "best_ev", VERSION);
    expect(staged.metadata.find((r) => r.uuid === id)?.source_hash).toBe(h);
    expect(staged.deep.find((r) => r.uuid === id)).toBeUndefined();
    db.close();
  });

  it("an explicit stage field wins over the snapshot lookup", async () => {
    const db = await openRadarStore();
    const id = uuid("explicit");
    const hDeep = hash(`ed-${id}`);
    // Snapshot at hDeep carries deep data, but the row declares stage
    // "metadata" (e.g. a metadata re-score over a deep-enriched snapshot):
    // the field is authoritative — it records which run phase wrote the row.
    await putSnapshot(db, snapshot(id, hDeep, deepEnrichment()), T2);
    await putScore(db, score(id, hDeep, 58), T3, undefined, "metadata");
    const rows = await getScoreRows(db, id, "best_ev");
    expect(rows).toHaveLength(1);
    expect(await scoreRowStage(db, rows[0]!)).toBe("metadata");

    // And a declared deep row stays deep even with its snapshot gone.
    const idOrphan = uuid("explicit-orphan");
    await putScore(
      db,
      score(idOrphan, hash(`eo-${idOrphan}`), 61),
      T2,
      undefined,
      "deep",
    );
    const orphanRows = await getScoreRows(db, idOrphan, "best_ev");
    expect(orphanRows).toHaveLength(1);
    expect(await scoreRowStage(db, orphanRows[0]!)).toBe("deep");
    db.close();
  });
});
