import { z } from "zod";
import type { ApiEngagementData } from "../types";
import { radarDeepEnrichmentSchema } from "./deepTypes";

/**
 * Engagement Radar domain model. All scoring is deterministic — signals are
 * normalized 0..1 or null (unknown; never treated as 0 or "bad program"),
 * every schema is strict, and `schema_version` is a literal 1.
 */

export const RADAR_PROFILE_IDS = [
  "best_ev",
  "low_competition",
  "high_reward",
  "authz_api",
  "fresh_programs",
  "easy_entry",
] as const;
export type RadarProfileId = (typeof RADAR_PROFILE_IDS)[number];

// ---------------------------------------------------------------------------
// Signals. zod 4 `z.number()` already rejects NaN and ±Infinity; min/max pin
// the normalized range. null = unknown — excluded from score denominators
// downstream, never faked.
// ---------------------------------------------------------------------------

export const radarSignalSchema = z
  .object({
    value: z.number().min(0).max(1).nullable(),
    source: z.enum([
      "engagement_index",
      "engagement_detail",
      "statistics",
      "derived",
      "deep_enrichment",
    ]),
    reason_code: z.string().min(1),
  })
  .strict();
export type RadarSignal = z.infer<typeof radarSignalSchema>;
export type SignalValue = RadarSignal["value"];
export type RadarSignalSource = RadarSignal["source"];

// ---------------------------------------------------------------------------
// Catalog identity — one row per engagement discovered via GET
// /engagements.json. `uuid` carries the engagement's brief-URL slug: the
// researcher site surface has no org-API uuid, and the slug is the canonical
// identity (and the detail-endpoint path segment).
// ---------------------------------------------------------------------------

export const radarCatalogItemSchema = z
  .object({
    uuid: z.string().min(1),
    code: z.string().nullable(),
    name: z.string().nullable(),
    lifecycle_status: z.string().nullable(),
    engagement_type: z.string().nullable(),
    discovered_at: z.string().min(1),
  })
  .strict();
export type RadarCatalogItem = z.infer<typeof radarCatalogItemSchema>;

// ---------------------------------------------------------------------------
// Hydrated record. `detail` is the ApiEngagementData produced by mapping the
// structured brief document (GET /engagements/<slug>/changelog/<ver>.json +
// statistics.json); a
// runtime schema for ApiEngagementData is out of scope — it is only checked
// to be a non-array object or null. `enrichment.status` is the strict
// tri-state.
// ---------------------------------------------------------------------------

export const radarProgramSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    uuid: z.string().min(1),
    code: z.string().nullable(),
    catalog: radarCatalogItemSchema,
    detail: z.custom<ApiEngagementData | null>(
      (v) => v === null || (typeof v === "object" && !Array.isArray(v)),
    ),
    enrichment: z
      .object({
        status: z.enum(["complete", "unavailable", "failed"]),
        error_kind: z.string().min(1).optional(),
      })
      .strict(),
    /**
     * V1.3 deep-enrichment output (Known Issues summary + changelog
     * semantic diff). Absent/null on snapshots that never received a deep
     * pass — the derived deep signals stay null rather than faking data.
     * Every field inside enters `source_hash`.
     */
    deep: radarDeepEnrichmentSchema.nullable().optional(),
    source_hash: z.string().min(1),
  })
  .strict();
export type RadarProgramSnapshot = z.infer<typeof radarProgramSnapshotSchema>;

// ---------------------------------------------------------------------------
// Feature vector — 20 signals in fixed order. accessibility and
// authz_opportunity may legitimately be null in Radar V1.3;
// known_issue_density and opportunity_change are null unless the run's deep
// stage analyzed the program; submission_activity is null whenever the site
// omits valid_submission_count (the researcher surface currently ships it
// null). V1.5 appends payout_realized (statistics.average_payout — honest
// null when the field is absent/unparseable), scope_momentum and
// ki_concentration (deep-stage; null unless the arc/group-stats sub-sources
// completed).
// ---------------------------------------------------------------------------

export const programFeatureVectorSchema = z
  .object({
    schema_version: z.literal(1),
    reward_potential: radarSignalSchema,
    reward_breadth: radarSignalSchema,
    meaningful_surface: radarSignalSchema,
    api_surface: radarSignalSchema,
    api_surface_size: radarSignalSchema,
    web_surface: radarSignalSchema,
    researcher_competition: radarSignalSchema,
    rewarded_activity: radarSignalSchema,
    submission_activity: radarSignalSchema,
    research_saturation: radarSignalSchema,
    freshness: radarSignalSchema,
    safe_harbor: radarSignalSchema,
    target_data_quality: radarSignalSchema,
    accessibility: radarSignalSchema,
    known_issue_density: radarSignalSchema,
    opportunity_change: radarSignalSchema,
    authz_opportunity: radarSignalSchema,
    payout_realized: radarSignalSchema,
    scope_momentum: radarSignalSchema,
    ki_concentration: radarSignalSchema,
  })
  .strict();
export type ProgramFeatureVector = z.infer<typeof programFeatureVectorSchema>;

export type RadarFeatureKey = Exclude<
  keyof ProgramFeatureVector,
  "schema_version"
>;

// ---------------------------------------------------------------------------
// V1.3.1 — evidence levels + deep-stage orchestration types.
//
// RadarEvidenceLevel marks which evidence a score was computed from:
//   "metadata" — the always-on catalog/brief enrichment signals only
//   "deep"     — the deep-enriched vector (known_issue_density +
//                opportunity_change populated from real evidence or
//                honestly null)
// A program can hold BOTH scores: the deep re-score writes under the joined
// source_hash, so the metadata row survives for before/after comparison.
//
// DeepStabilization is the run's honest verdict on iterative deepening:
//   "stable"         — every deep-dependent profile's metadata frontier is
//                      fully deep-analyzed (within STABLE_TOP_K + buffer)
//   "budget_limited" — MAX_DEEP_PROGRAMS exhausted with frontier gaps left
//   "incomplete"     — the deep stage ran but did not reach a verdict
//                      (cancelled/failed mid-loop)
// ---------------------------------------------------------------------------

export type RadarEvidenceLevel = "metadata" | "deep";
export type DeepStabilization = "stable" | "budget_limited" | "incomplete";

/**
 * The profiles whose weights consume deep signals — deep analysis is only
 * meaningful for these. Order is meaningful: it is the documented priority
 * used to order candidate-union provenance and stabilization batches.
 * high_reward and easy_entry weight no deep signal, so a deep pass cannot
 * change their scores.
 */
export const DEEP_PROFILE_IDS: readonly RadarProfileId[] = [
  "best_ev",
  "fresh_programs",
  "low_competition",
  "authz_api",
];

/** Signal keys that only deep enrichment can populate. */
export const DEEP_SIGNAL_KEYS: readonly RadarFeatureKey[] = [
  "known_issue_density",
  "opportunity_change",
  "scope_momentum",
  "ki_concentration",
];

/** Per-profile metadata Top-N admitted into the deep candidate union. */
export const PROFILE_CANDIDATE_DEPTH = 20;
/** The Top-K the stabilization loop tries to make fully deep-analyzed. */
export const STABLE_TOP_K = 20;
/**
 * Extra metadata-rank margin beyond STABLE_TOP_K: deep-score drops can admit
 * programs ranked just below K, so the frontier watches K + buffer.
 */
export const STABILITY_BUFFER = 10;
/** Hard cap on unique programs deep-analyzed per run (~3 requests each). */
export const MAX_DEEP_PROGRAMS = 60;
/** Programs added per stabilization round. */
export const DEEP_BATCH_SIZE = 10;

/** V1.5 — changelog versions the scope arc spans for `scope_momentum`. */
export const SCOPE_ARC_DEPTH = 5;
/** V1.5 — aggregate unique_count floor for the per-group stats fetch. */
export const KI_GROUP_MIN_UNIQUE = 10;
/** V1.5 — in-scope groups per program eligible for the stats fetch. */
export const KI_GROUP_MAX_GROUPS = 6;

/** Why a program entered the deep candidate set (per contributing profile). */
export interface DeepCandidateReason {
  profile: RadarProfileId;
  metadata_rank: number;
}

/** One shortlisted program plus its selection provenance. */
export interface DeepCandidate {
  uuid: string;
  reasons: DeepCandidateReason[];
}

/** The 20 signal keys, in interface order. */
export const RADAR_FEATURE_KEYS: readonly RadarFeatureKey[] = [
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
];

// ---------------------------------------------------------------------------
// Score — deterministic output of the scoring engine. `score` null when every
// weighted signal is unknown; `confidence` is data coverage (known-weight
// share), reported separately and never multiplied into the score.
// `provisional` marks scores whose profile-declared required signals are all
// absent — the row is shown but must not read as a final judgment.
// ---------------------------------------------------------------------------

const scoreComponentSchema = z
  .object({
    signal: z.number().nullable(),
    weight: z.number(),
    direction: z.enum(["benefit", "cost"]),
    contribution: z.number().nullable(),
  })
  .strict();

export const programScoreSchema = z
  .object({
    schema_version: z.literal(1),
    engagement_uuid: z.string().min(1),
    profile: z.enum(RADAR_PROFILE_IDS),
    scoring_version: z.string().min(1),
    score: z.number().nullable(),
    confidence: z.number().min(0).max(1),
    provisional: z.boolean(),
    components: z.record(z.string(), scoreComponentSchema),
    reasons: z.array(z.string()),
    source_hash: z.string().min(1),
  })
  .strict();
export type ProgramScore = z.infer<typeof programScoreSchema>;
