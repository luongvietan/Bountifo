import type {
  RadarExportData,
  RadarExportRow,
  RadarExportRowDetail,
  RadarExportSection,
} from "../../lib/radar/export";
import { getRadarProfile } from "../../lib/radar/profiles";
import { isDeepProfile } from "../../lib/radar/stage";
import { RADAR_FEATURE_KEYS, RADAR_PROFILE_IDS } from "../../lib/radar/types";
import type {
  RadarFeatureKey,
  RadarProfileId,
  RadarSignalSource,
} from "../../lib/radar/types";

// ---------------------------------------------------------------------------
// Deterministic sample export — three programs across all six profiles,
// exercising every honesty edge the serializers must render: a deep-analyzed
// gated program, a metadata-only program with a real zero signal, and an
// ineligible/provisional unscored row. Used by tests/radar-samples.test.ts to
// guard docs/samples/* — regenerate with WRITE_SAMPLES=1.
// ---------------------------------------------------------------------------

const T0 = "2026-09-20T08:00:00.000Z";
const T1 = "2026-09-20T08:07:31.000Z";

const hash = (ch: string) => `sha256:${ch.repeat(64)}`;

function signals(
  over: Partial<Record<RadarFeatureKey, number | null>> = {},
): Record<RadarFeatureKey, number | null> {
  const base = Object.fromEntries(
    RADAR_FEATURE_KEYS.map((k) => [k, null]),
  ) as Record<RadarFeatureKey, number | null>;
  return { ...base, ...over };
}

function signalMeta(
  over: Partial<
    Record<
      RadarFeatureKey,
      { source: RadarSignalSource; reason_code: string } | null
    >
  > = {},
): RadarExportRowDetail["signal_meta"] {
  const base = Object.fromEntries(
    RADAR_FEATURE_KEYS.map((k) => [k, null]),
  ) as RadarExportRowDetail["signal_meta"];
  return { ...base, ...over };
}

const ACME = "acme-security-bb";
const GLOBEX = "globex-bb";
const INITECH = "initech-vdp";

/** Deep digest for acme — analyzed, mixed sub-source outcomes. */
const acmeDeep: RadarExportRow["deep"] = {
  status: "partial",
  known_issues: {
    status: "complete",
    unique_count: 7,
    total_count: 26,
    group_stats: {
      status: "complete",
      groups_fetched: 3,
      groups_total: 3,
    },
  },
  semantic_diff: {
    status: "complete",
    from_version: "v-2026-08",
    to_version: "v-2026-09",
  },
  scope_arc: { status: "no_baseline", window_versions: null },
};

function acmeDetail(): RadarExportRowDetail {
  return {
    stages: [
      {
        stage: "metadata",
        scoring_version: "1.5.0",
        source_hash: hash("a"),
        score: 72.4,
        confidence: 0.75,
        provisional: false,
        components: {
          reward_potential: {
            signal: 0.82,
            weight: 3,
            direction: "benefit",
            contribution: 2.46,
          },
          research_saturation: {
            signal: 0.12,
            weight: 1.5,
            direction: "cost",
            contribution: 1.32,
          },
          known_issue_density: {
            signal: null,
            weight: 1,
            direction: "cost",
            contribution: null,
          },
        },
        reasons: ["REWARD_HIGH", "SATURATION_LOW", "UNKNOWN_KI_DENSITY"],
      },
      {
        stage: "deep",
        scoring_version: "1.5.0",
        source_hash: hash("b"),
        score: 78.9,
        confidence: 0.9,
        provisional: false,
        components: {
          reward_potential: {
            signal: 0.82,
            weight: 3,
            direction: "benefit",
            contribution: 2.46,
          },
          known_issue_density: {
            signal: 0.31,
            weight: 1,
            direction: "cost",
            contribution: 0.69,
          },
          opportunity_change: {
            signal: 0.74,
            weight: 2,
            direction: "benefit",
            contribution: 1.48,
          },
        },
        reasons: ["REWARD_HIGH", "OPPORTUNITY_EXPANDING"],
      },
    ],
    signal_meta: signalMeta({
      reward_potential: {
        source: "engagement_detail",
        reason_code: "REWARD_HIGH",
      },
      research_saturation: {
        source: "engagement_detail",
        reason_code: "SATURATION_LOW",
      },
      known_issue_density: {
        source: "deep_enrichment",
        reason_code: "KI_DENSITY",
      },
      opportunity_change: {
        source: "deep_enrichment",
        reason_code: "OPPORTUNITY_EXPANDING",
      },
    }),
  };
}

function globexDetail(): RadarExportRowDetail {
  return {
    stages: [
      {
        stage: "metadata",
        scoring_version: "1.5.0",
        source_hash: hash("c"),
        score: 51.6,
        confidence: 0.7,
        provisional: false,
        components: {
          reward_potential: {
            signal: 0.4,
            weight: 3,
            direction: "benefit",
            contribution: 1.2,
          },
          // A real observed zero — the brief states no rewarded targets.
          payout_realized: {
            signal: 0,
            weight: 1,
            direction: "benefit",
            contribution: 0,
          },
        },
        reasons: ["REWARD_MEDIUM"],
      },
    ],
    signal_meta: signalMeta({
      reward_potential: {
        source: "engagement_detail",
        reason_code: "REWARD_MEDIUM",
      },
      payout_realized: {
        source: "engagement_detail",
        reason_code: "PAYOUT_NONE",
      },
    }),
  };
}

interface RowSeed {
  uuid: string;
  slug: string;
  name: string | null;
  restricted_access: boolean;
  signals: Record<RadarFeatureKey, number | null>;
  deep: RadarExportRow["deep"];
  detail?: RadarExportRowDetail;
  enrichment_status: RadarExportRow["enrichment_status"];
  eligible: boolean;
  provisional: boolean;
  coverage: number;
  source_hash: string | null;
}

const PROGRAMS: Record<string, RowSeed> = {
  acme: {
    uuid: "3f8a2c10-7b4e-4a1d-9c2f-8e5b6d7a9012",
    slug: ACME,
    name: "Acme Security Bug Bounty",
    restricted_access: true,
    signals: signals({
      reward_potential: 0.82,
      meaningful_surface: 0.61,
      api_surface: 0.55,
      research_saturation: 0.12,
      known_issue_density: 0.31,
      opportunity_change: 0.74,
      authz_opportunity: 0.66,
      payout_realized: 0.58,
      scope_momentum: 0.4,
      ki_concentration: 0.22,
      accessibility: 0.35,
      freshness: 0.1,
    }),
    deep: acmeDeep,
    detail: acmeDetail(),
    enrichment_status: "complete",
    eligible: true,
    provisional: false,
    coverage: 0.75,
    source_hash: hash("a"),
  },
  globex: {
    uuid: "7d1e9b42-2c6f-4e8a-b3d1-0f9a8c7e6b5d",
    slug: GLOBEX,
    name: "Globex Corporation",
    restricted_access: false,
    signals: signals({
      reward_potential: 0.4,
      meaningful_surface: 0.33,
      research_saturation: 0.05,
      payout_realized: 0,
      accessibility: 0.9,
      freshness: 0.85,
      safe_harbor: 1,
    }),
    deep: null,
    detail: globexDetail(),
    enrichment_status: "complete",
    eligible: true,
    provisional: false,
    coverage: 0.5,
    source_hash: hash("c"),
  },
  initech: {
    uuid: "9c0d4e7f-1a3b-4f5c-8d2e-6b7a8c9d0e1f",
    slug: INITECH,
    name: "Initech VDP",
    restricted_access: false,
    signals: signals({ meaningful_surface: 0.1, accessibility: 0.4 }),
    deep: null,
    detail: { stages: [], signal_meta: signalMeta() },
    enrichment_status: "unavailable",
    eligible: false,
    provisional: true,
    coverage: 0.15,
    source_hash: null,
  },
};

/** Per-profile metadata scores + order — fresh_programs/easy_entry rank the
 *  fresh low-friction globex above gated acme. */
const SCORES: Record<
  RadarProfileId,
  { acme: number; globex: number; order: ["acme" | "globex", "acme" | "globex"] }
> = {
  best_ev: { acme: 72.4, globex: 51.6, order: ["acme", "globex"] },
  low_competition: { acme: 68.1, globex: 44.9, order: ["acme", "globex"] },
  high_reward: { acme: 81.0, globex: 47.3, order: ["acme", "globex"] },
  authz_api: { acme: 74.6, globex: 38.8, order: ["acme", "globex"] },
  fresh_programs: { acme: 55.2, globex: 63.0, order: ["globex", "acme"] },
  easy_entry: { acme: 43.5, globex: 61.2, order: ["globex", "acme"] },
};

/** Deep-stage re-scores for acme on the profiles that consume deep signals. */
const ACME_DEEP_SCORES: Partial<Record<RadarProfileId, number>> = {
  best_ev: 78.9,
  low_competition: 61.3,
  authz_api: 80.2,
  fresh_programs: 66.7,
};

function sectionRow(
  profileId: RadarProfileId,
  seed: RowSeed,
  rank: number,
  score: number | null,
  percentile: number | null,
): RadarExportRow {
  const deepScore =
    seed === PROGRAMS.acme && isDeepProfile(profileId)
      ? (ACME_DEEP_SCORES[profileId] ?? null)
      : null;
  return {
    rank,
    uuid: seed.uuid,
    slug: seed.slug,
    engagement_url: `https://bugcrowd.com/engagements/${seed.slug}`,
    name: seed.name,
    score,
    metadata_score: score,
    deep_score: deepScore,
    score_delta:
      deepScore !== null && score !== null
        ? Math.round((deepScore - score) * 10) / 10
        : null,
    evidence_level: deepScore !== null ? "deep" : "metadata",
    coverage: seed.coverage,
    percentile,
    eligible: seed.eligible,
    provisional: seed.provisional,
    restricted_access: seed.restricted_access,
    source_hash: seed.source_hash,
    scoring_version: getRadarProfile(profileId).version,
    reasons:
      seed === PROGRAMS.acme
        ? ["REWARD_HIGH", "SATURATION_LOW"]
        : seed === PROGRAMS.globex
          ? ["REWARD_MEDIUM"]
          : ["NO_REWARD_POOL"],
    signals: seed.signals,
    enrichment_status: seed.enrichment_status,
    deep: seed.deep,
    detail: seed.detail,
  };
}

function section(profileId: RadarProfileId): RadarExportSection {
  const { acme, globex, order } = SCORES[profileId];
  const profile = getRadarProfile(profileId);
  const eligibleRows = order.map((key, i) =>
    sectionRow(
      profileId,
      PROGRAMS[key]!,
      i + 1,
      key === "acme" ? acme : globex,
      i === 0 ? 50.0 : 0.0,
    ),
  );
  return {
    profile_id: profileId,
    profile_version: profile.version,
    profile_label: profile.label,
    min_confidence: profile.minConfidence,
    total_ranked: 3,
    eligible_count: 2,
    exported_count: 3,
    rows: [
      ...eligibleRows,
      sectionRow(profileId, PROGRAMS.initech!, 3, null, null),
    ],
  };
}

/** The fixed export snapshot behind docs/samples/radar-report.*. */
export function sampleRadarExportData(): RadarExportData {
  return {
    run: {
      run_id: "radar_sample01",
      phase: "done",
      started_at: T0,
      updated_at: T1,
      status: "complete",
      catalog_complete: true,
      discovered: 4,
      enriched: 3,
      enrichment_failed: 1,
      scored: 3,
      warnings: 1,
      warning_details: [
        "initech-vdp: brief fetch failed after 2 attempts",
      ],
      deep_candidates: 2,
      deep_analyzed: 1,
      deep_enriched: 1,
      deep_rounds: 1,
      deep_budget: 60,
      deep_stabilization: "stable",
    },
    provenance: {
      schema: "bce-radar-export",
      schema_version: 1,
      app_version: "0.1.0",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
    },
    options: {
      profiles: [...RADAR_PROFILE_IDS],
      limit: 50,
      detail: true,
      diagnostics: true,
    },
    restricted_access: { count: 1, programs: [ACME] },
    sections: RADAR_PROFILE_IDS.map(section),
    diagnostics: {
      deep_candidates: 2,
      deep_analyzed: 1,
      not_analyzed: 1,
      sub_sources: {
        known_issues: {
          complete: 1,
          unavailable: 0,
          failed: 0,
          no_baseline: 0,
          skipped: 0,
          absent: 0,
        },
        semantic_diff: {
          complete: 1,
          unavailable: 0,
          failed: 0,
          no_baseline: 0,
          skipped: 0,
          absent: 0,
        },
        scope_arc: {
          complete: 0,
          unavailable: 0,
          failed: 0,
          no_baseline: 1,
          skipped: 0,
          absent: 0,
        },
        group_stats: {
          complete: 1,
          unavailable: 0,
          failed: 0,
          no_baseline: 0,
          skipped: 0,
          absent: 0,
        },
      },
    },
  };
}
