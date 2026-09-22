import { z } from "zod";
import type { ApiEngagementData } from "../types";

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
    source_hash: z.string().min(1),
  })
  .strict();
export type RadarProgramSnapshot = z.infer<typeof radarProgramSnapshotSchema>;

// ---------------------------------------------------------------------------
// Feature vector — 13 signals in fixed order. accessibility,
// known_issue_density and authz_opportunity may legitimately be null in
// Radar V1.
// ---------------------------------------------------------------------------

export const programFeatureVectorSchema = z
  .object({
    schema_version: z.literal(1),
    reward_potential: radarSignalSchema,
    reward_breadth: radarSignalSchema,
    meaningful_surface: radarSignalSchema,
    api_surface: radarSignalSchema,
    web_surface: radarSignalSchema,
    researcher_competition: radarSignalSchema,
    rewarded_activity: radarSignalSchema,
    freshness: radarSignalSchema,
    safe_harbor: radarSignalSchema,
    target_data_quality: radarSignalSchema,
    accessibility: radarSignalSchema,
    known_issue_density: radarSignalSchema,
    authz_opportunity: radarSignalSchema,
  })
  .strict();
export type ProgramFeatureVector = z.infer<typeof programFeatureVectorSchema>;

export type RadarFeatureKey = Exclude<
  keyof ProgramFeatureVector,
  "schema_version"
>;

/** The 13 signal keys, in interface order. */
export const RADAR_FEATURE_KEYS: readonly RadarFeatureKey[] = [
  "reward_potential",
  "reward_breadth",
  "meaningful_surface",
  "api_surface",
  "web_surface",
  "researcher_competition",
  "rewarded_activity",
  "freshness",
  "safe_harbor",
  "target_data_quality",
  "accessibility",
  "known_issue_density",
  "authz_opportunity",
];

// ---------------------------------------------------------------------------
// Score — deterministic output of the scoring engine. `score` null when every
// weighted signal is unknown; confidence is reported separately and never
// multiplied into the score.
// ---------------------------------------------------------------------------

const scoreComponentSchema = z
  .object({
    signal: z.number().nullable(),
    weight: z.number(),
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
    components: z.record(z.string(), scoreComponentSchema),
    reasons: z.array(z.string()),
    source_hash: z.string().min(1),
  })
  .strict();
export type ProgramScore = z.infer<typeof programScoreSchema>;
