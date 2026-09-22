import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../types";
import { accessibilitySignal } from "./accessibility";
import { scopeMomentumScore } from "./arc";
import { authzOpportunitySignal } from "./authz";
import { normReward, parseStatValue } from "./curves";
import { opportunityChangeScore } from "./diff";
import { kiConcentrationScore } from "./groupStats";
import { knownIssueDensity as knownIssueDensityValue } from "./knownIssues";
import { payoutRealizedSignal } from "./payout";
import { classifyTarget } from "./surface";
import type {
  ProgramFeatureVector,
  RadarProgramSnapshot,
  RadarSignal,
  RadarSignalSource,
} from "./types";

// ---------------------------------------------------------------------------
// Engagement Radar feature extractor — PURE and deterministic.
//
// No network, no storage, no Date.now(), no randomness. The reference time is
// passed explicitly as `now` (ISO-8601) so persisted vectors are reproducible.
// Every emitted signal value is rounded to 4 decimal places; null means
// "unknown" and is never fabricated.
//
// V1 calibration is frozen — tests pin every anchor, weight, denominator and
// band boundary. V1.5 consumes `statistics.average_payout` via the shared
// normReward curve (lib/radar/curves.ts): realized payout evidence, still
// captured in source_hash so a change re-triggers scoring.
// ---------------------------------------------------------------------------

/** reward_potential blend weights over tiers P1/P2/P3 (renormalized over
 *  tiers present). */
const TIER_WEIGHTS = [
  { tier: "p1", weight: 0.5 },
  { tier: "p2", weight: 0.3 },
  { tier: "p3", weight: 0.2 },
] as const;

// meaningful_surface saturation: c/(c+MEANINGFUL_SURFACE_K).
const MEANINGFUL_SURFACE_K = 25;
// api_surface_size saturation: c/(c+API_SURFACE_SIZE_K) — the COUNT of
// API-classified targets, so a lone API target in a 1-target program cannot
// fake "large API surface" (api_surface alone only measures the share).
const API_SURFACE_SIZE_K = 10;
// researcher_competition saturation: n/(n+RESEARCHER_COMPETITION_K).
const RESEARCHER_COMPETITION_K = 500;
// rewarded_activity saturation: n/(n+REWARDED_ACTIVITY_K).
const REWARDED_ACTIVITY_K = 200;
// submission_activity saturation: n/(n+SUBMISSION_ACTIVITY_K) over
// statistics.valid_submission_count — a count of valid submissions, NOT a
// count of researchers.
const SUBMISSION_ACTIVITY_K = 500;

/**
 * Components of the research_saturation composite — the evidence a program
 * has already drawn sustained research attention. `known_issue_density`
 * stays declared but deliberately UNWEIGHTED in V1.3: the composite is
 * metadata-only so catalog-wide programs that never get a deep pass are
 * comparable, and deep-analyzed programs carry the signal once — as a
 * standalone profile cost, never twice (see profiles.ts).
 */
export type SaturationComponentKey =
  | "recent_crowding"
  | "submission_activity"
  | "rewarded_activity"
  | "known_issue_density";

/** V1.2 pinned weights — initial deterministic calibration. */
const SATURATION_WEIGHTS = {
  recent_crowding: 0.3,
  submission_activity: 0.4,
  rewarded_activity: 0.3,
} as const satisfies Partial<Record<SaturationComponentKey, number>>;

// Fewer than two known components means one noisy metric masquerading as
// saturation — the composite reports null instead.
const MIN_SATURATION_COMPONENTS = 2;

// The deterministic surface token sets live in ./surface (shared with the
// semantic differ since V1.4) — exact token membership only, so substring
// traps ("capitol"⊅"api", "restaurant"⊅"rest") never match.

// Freshness age bands (days → value), evaluated in order; older → 0.15.
const FRESHNESS_BANDS: ReadonlyArray<readonly [number, number]> = [
  [7, 1],
  [30, 0.85],
  [90, 0.6],
  [180, 0.35],
];
const FRESHNESS_OLD = 0.15;
const DAY_MS = 86_400_000;

const REASON_DETAIL_UNAVAILABLE = "detail_unavailable";
const REASON_NOT_AVAILABLE_V1 = "not_available_v1";

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function sig(
  value: number | null,
  source: RadarSignalSource,
  reasonCode: string,
): RadarSignal {
  return {
    value: value === null ? null : round4(value),
    source,
    reason_code: reasonCode,
  };
}

// normReward/parseStatValue moved to ./curves (V1.5) — re-exported so the
// pinned test importers keep resolving from this module.
export { normReward, parseStatValue };

/**
 * Maps one hydrated snapshot to its deterministic ProgramFeatureVector.
 * `now` is the explicit reference time (ISO-8601) — the extractor never reads
 * the wall clock. When `snapshot.detail` is null (enrichment
 * unavailable/failed) every detail-derived signal is `value: null` with
 * reason_code "detail_unavailable"; nothing is inferred from the catalog row.
 */
export function extractProgramFeatures(
  snapshot: RadarProgramSnapshot,
  now: string,
): ProgramFeatureVector {
  const detail = snapshot.detail;
  if (detail === null) {
    const unavailable = (source: RadarSignalSource): RadarSignal =>
      sig(null, source, REASON_DETAIL_UNAVAILABLE);
    return {
      schema_version: 1,
      reward_potential: unavailable("engagement_detail"),
      reward_breadth: unavailable("engagement_detail"),
      meaningful_surface: unavailable("engagement_detail"),
      api_surface: unavailable("engagement_detail"),
      api_surface_size: unavailable("engagement_detail"),
      web_surface: unavailable("engagement_detail"),
      researcher_competition: unavailable("statistics"),
      rewarded_activity: unavailable("statistics"),
      submission_activity: unavailable("statistics"),
      research_saturation: unavailable("derived"),
      freshness: unavailable("engagement_detail"),
      safe_harbor: unavailable("engagement_detail"),
      target_data_quality: unavailable("derived"),
      // detail === null keeps the V1.4 signals honestly null too — nothing
      // is inferred from the catalog row even though lifecycle_status
      // exists (pinned: the sourced stubs are never reached on this path).
      accessibility: notAvailableV1(),
      known_issue_density: unavailable("deep_enrichment"),
      opportunity_change: unavailable("deep_enrichment"),
      authz_opportunity: notAvailableV1(),
      payout_realized: unavailable("statistics"),
      scope_momentum: unavailable("deep_enrichment"),
      ki_concentration: unavailable("deep_enrichment"),
    };
  }

  const inScopeGroups = inScopeOnly(detail.targetGroups);
  const inScopeTargets = inScopeOnly(detail.targets);
  const surfaces = classifySurfaces(inScopeTargets);
  // Saturation inputs are computed once and shared: the standalone signals
  // and the composite must read identical values.
  const crowding = statSaturation(
    detail,
    "researchers_participating",
    RESEARCHER_COMPETITION_K,
    "researchers_participating_saturation",
  );
  const rewarded = statSaturation(
    detail,
    "vulnerabilities_rewarded",
    REWARDED_ACTIVITY_K,
    "vulnerabilities_rewarded_saturation",
  );
  const submissions = statSaturation(
    detail,
    "valid_submission_count",
    SUBMISSION_ACTIVITY_K,
    "submission_count_saturation",
  );

  return {
    schema_version: 1,
    reward_potential: rewardPotential(inScopeGroups),
    reward_breadth: rewardBreadth(inScopeGroups),
    meaningful_surface: meaningfulSurface(inScopeTargets),
    api_surface: surfaces.api,
    api_surface_size: surfaces.apiSize,
    web_surface: surfaces.web,
    researcher_competition: crowding,
    rewarded_activity: rewarded,
    submission_activity: submissions,
    research_saturation: researchSaturation({
      recent_crowding: crowding.value,
      submission_activity: submissions.value,
      rewarded_activity: rewarded.value,
    }),
    freshness: freshness(detail, Date.parse(now)),
    safe_harbor: safeHarbor(detail),
    target_data_quality: targetDataQuality(inScopeTargets, inScopeGroups),
    // V1.4 contract stubs — real sources land with Agents A/B; until then
    // they return the identical honest-null shape notAvailableV1() produced.
    accessibility: accessibilitySignal(detail, snapshot.catalog),
    known_issue_density: knownIssueDensity(snapshot),
    opportunity_change: opportunityChange(snapshot),
    authz_opportunity: authzOpportunitySignal(detail),
    payout_realized: payoutRealizedSignal(detail),
    scope_momentum: scopeMomentum(snapshot),
    ki_concentration: kiConcentration(snapshot),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — all pure.
// ---------------------------------------------------------------------------

/** accessibility/known_issue_density/authz_opportunity: no deterministic V1
 *  source exists, so the signal is honestly null. */
function notAvailableV1(): RadarSignal {
  return sig(null, "derived", REASON_NOT_AVAILABLE_V1);
}

/**
 * V1.3 Known Issues signal — honest about analysis state: programs outside
 * the deep shortlist read "not_deep_analyzed"; an analyzed-but-unavailable
 * or failed endpoint reads "ki_<status>" and stays null; only a COMPLETE
 * summary feeds the density formula (Agent A's `knownIssueDensity`).
 *
 * `meaningfulTargetCount` is the same denominator `meaningful_surface`
 * uses — in-scope targets with usable identity — so density is "known
 * issues per meaningful target", never per raw row. detail===null is
 * unreachable here (the extractor short-circuits above); the empty list
 * keeps the helper self-contained.
 */
function knownIssueDensity(snapshot: RadarProgramSnapshot): RadarSignal {
  const ki = snapshot.deep?.known_issues;
  if (ki === undefined || ki === null) {
    return sig(null, "deep_enrichment", "not_deep_analyzed");
  }
  if (ki.status !== "complete") {
    return sig(null, "deep_enrichment", `ki_${ki.status}`);
  }
  const inScopeTargets =
    snapshot.detail === null ? [] : inScopeOnly(snapshot.detail.targets);
  const meaningfulTargetCount = inScopeTargets.filter(usableIdentity).length;
  return sig(
    knownIssueDensityValue(ki, meaningfulTargetCount),
    "deep_enrichment",
    "ki_density",
  );
}

/**
 * V1.3 semantic opportunity change — same honesty rules: no deep pass →
 * "not_deep_analyzed"; unavailable/no_baseline diffs stay null; only a
 * COMPLETE diff feeds Agent B's `opportunityChangeScore`. A complete diff
 * scoring 0 is a real reading (text-only update), not an unknown.
 */
function opportunityChange(snapshot: RadarProgramSnapshot): RadarSignal {
  const diff = snapshot.deep?.semantic_diff;
  if (diff === undefined || diff === null) {
    return sig(null, "deep_enrichment", "not_deep_analyzed");
  }
  if (diff.status !== "complete") {
    return sig(null, "deep_enrichment", `diff_${diff.status}`);
  }
  return sig(
    opportunityChangeScore(diff),
    "deep_enrichment",
    "diff_score",
  );
}

/**
 * V1.5 scope momentum — the arc-window counterpart to opportunity_change.
 * Same honesty doctrine: absent scope_arc (pre-V1.5 deep payload) reads
 * "arc_absent"; an unavailable/no_baseline arc reads "arc_<status>"; only a
 * COMPLETE arc feeds `scopeMomentumScore` — a complete text-only arc scoring
 * 0 is a real reading, not an unknown.
 */
function scopeMomentum(snapshot: RadarProgramSnapshot): RadarSignal {
  const arc = snapshot.deep?.scope_arc;
  if (arc === undefined || arc === null) {
    return sig(null, "deep_enrichment", "arc_absent");
  }
  if (arc.status !== "complete") {
    return sig(null, "deep_enrichment", `arc_${arc.status}`);
  }
  return sig(
    arc.diff === null ? null : scopeMomentumScore(arc.diff),
    "deep_enrichment",
    "arc_momentum",
  );
}

/**
 * V1.5 Known-Issues concentration — same doctrine layered one level deeper:
 * the aggregate summary must be complete AND its group_stats sub-block
 * present-and-complete before `kiConcentrationScore` sees the categories.
 * skipped_* states are terminal OK (a deliberate bound), still honestly
 * null. A complete stats payload whose categories sum to 0 contradicts the
 * nonzero aggregate — null, never a fabricated 0.
 */
function kiConcentration(snapshot: RadarProgramSnapshot): RadarSignal {
  const ki = snapshot.deep?.known_issues;
  if (ki === undefined || ki === null) {
    return sig(null, "deep_enrichment", "not_deep_analyzed");
  }
  const gs = ki.group_stats;
  if (gs === undefined || gs === null) {
    return sig(null, "deep_enrichment", "ki_groups_absent");
  }
  if (gs.status !== "complete") {
    return sig(null, "deep_enrichment", `ki_groups_${gs.status}`);
  }
  return sig(
    kiConcentrationScore(ki.categories ?? []),
    "deep_enrichment",
    "ki_concentration",
  );
}

function inScopeOnly<T extends { inScope: boolean }>(items: T[] | undefined): T[] {
  return Array.isArray(items) ? items.filter((i) => i.inScope === true) : [];
}

function nonEmpty(value: string | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** Usable identity = non-empty location OR non-empty name. */
function usableIdentity(target: ApiTarget): boolean {
  return nonEmpty(target.location) || nonEmpty(target.name);
}

function rewardPotential(inScopeGroups: ApiTargetGroup[]): RadarSignal {
  const present: Array<{ weight: number; max: number }> = [];
  for (const { tier, weight } of TIER_WEIGHTS) {
    let max: number | null = null;
    for (const group of inScopeGroups) {
      const amount = group.rewards?.[tier];
      if (
        typeof amount === "number" &&
        Number.isFinite(amount) &&
        (max === null || amount > max)
      ) {
        max = amount;
      }
    }
    if (max !== null) present.push({ weight, max });
  }
  if (present.length === 0) {
    return sig(null, "engagement_detail", "reward_curve_p1_p2_p3");
  }
  const weightSum = present.reduce((sum, p) => sum + p.weight, 0);
  const blended =
    present.reduce((sum, p) => sum + p.weight * normReward(p.max), 0) /
    weightSum;
  return sig(blended, "engagement_detail", "reward_curve_p1_p2_p3");
}

/** Any non-null POSITIVE reward on p1..p5 (breadth cares about real money). */
function bearsPositiveReward(group: ApiTargetGroup): boolean {
  const r = group.rewards;
  if (r === null || r === undefined) return false;
  return [r.p1, r.p2, r.p3, r.p4, r.p5].some(
    (v) => typeof v === "number" && v > 0,
  );
}

/** Any non-null reward on p1..p5 (data quality cares about metadata
 *  presence — even a recorded 0 is data). */
function hasRewardMetadata(group: ApiTargetGroup): boolean {
  const r = group.rewards;
  if (r === null || r === undefined) return false;
  return [r.p1, r.p2, r.p3, r.p4, r.p5].some((v) => v !== null && v !== undefined);
}

function rewardBreadth(inScopeGroups: ApiTargetGroup[]): RadarSignal {
  if (inScopeGroups.length === 0) {
    return sig(null, "engagement_detail", "reward_bearing_group_share");
  }
  const bearing = inScopeGroups.filter(bearsPositiveReward).length;
  return sig(
    bearing / inScopeGroups.length,
    "engagement_detail",
    "reward_bearing_group_share",
  );
}

function meaningfulSurface(inScopeTargets: ApiTarget[]): RadarSignal {
  const c = inScopeTargets.filter(usableIdentity).length;
  return sig(
    c / (c + MEANINGFUL_SURFACE_K),
    "engagement_detail",
    "in_scope_target_saturation",
  );
}

/**
 * Surface classification — the shared classifier in ./surface decides each
 * target's api/web flags; here we only count. A target may be both api and
 * web; the http(s) fallback fires only when NEITHER token set matched.
 */
function classifySurfaces(inScopeTargets: ApiTarget[]): {
  api: RadarSignal;
  apiSize: RadarSignal;
  web: RadarSignal;
} {
  let apiCount = 0;
  let webCount = 0;
  for (const target of inScopeTargets) {
    const surface = classifyTarget(target);
    if (surface.api) apiCount++;
    if (surface.web) webCount++;
  }
  const total = inScopeTargets.length;
  return {
    api: sig(
      total === 0 ? 0 : apiCount / total,
      "engagement_detail",
      "api_token_share",
    ),
    apiSize: sig(
      apiCount / (apiCount + API_SURFACE_SIZE_K),
      "engagement_detail",
      "api_target_saturation",
    ),
    web: sig(
      total === 0 ? 0 : webCount / total,
      "engagement_detail",
      "web_token_share",
    ),
  };
}

/**
 * Research saturation composite — weighted mean over KNOWN components only
 * (a missing component drops out of numerator AND denominator, never reads
 * as 0). Returns null when fewer than MIN_SATURATION_COMPONENTS are known:
 * a single noisy metric must not pose as saturation truth.
 */
function researchSaturation(
  components: Partial<Record<SaturationComponentKey, number | null>>,
): RadarSignal {
  let weightSum = 0;
  let weighted = 0;
  let known = 0;
  for (const [key, weight] of Object.entries(SATURATION_WEIGHTS)) {
    const value = components[key as SaturationComponentKey];
    if (value === null || value === undefined) continue;
    known++;
    weightSum += weight;
    weighted += weight * value;
  }
  if (known < MIN_SATURATION_COMPONENTS) {
    return sig(null, "derived", "insufficient_saturation_components");
  }
  return sig(weighted / weightSum, "derived", "research_saturation_composite");
}

/** n/(n+k) over a strict-parsed statistic; missing/unparseable → null. */
function statSaturation(
  detail: ApiEngagementData,
  key: string,
  k: number,
  reasonCode: string,
): RadarSignal {
  const entry = detail.statistics?.[key];
  const n =
    entry === undefined || entry === null ? null : parseStatValue(entry.value);
  return sig(n === null ? null : n / (n + k), "statistics", reasonCode);
}

/**
 * Most recent valid date among lastBriefUpdate/lastStatusTransition, aged in
 * days vs `now` (invalid dates skipped; invalid `now` → null). Fixed bands:
 * ≤7→1.0, ≤30→0.85, ≤90→0.60, ≤180→0.35, older→0.15, none→null.
 */
function freshness(detail: ApiEngagementData, nowMs: number): RadarSignal {
  if (Number.isNaN(nowMs)) return sig(null, "engagement_detail", "age_band");
  let newest: number | null = null;
  for (const raw of [detail.lastBriefUpdate, detail.lastStatusTransition]) {
    if (typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  if (newest === null) return sig(null, "engagement_detail", "age_band");
  const ageDays = (nowMs - newest) / DAY_MS;
  for (const [maxDays, value] of FRESHNESS_BANDS) {
    if (ageDays <= maxDays) return sig(value, "engagement_detail", "age_band");
  }
  return sig(FRESHNESS_OLD, "engagement_detail", "age_band");
}

/**
 * safeHarborLevel field ONLY — never inferred from prose. contains "full"→1.0,
 * "partial"→0.5, "none"/"absent"→0.0 (case-insensitive); anything else or a
 * missing field → null.
 */
function safeHarbor(detail: ApiEngagementData): RadarSignal {
  const raw = detail.safeHarborLevel;
  let value: number | null = null;
  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    if (s.includes("full")) value = 1;
    else if (s.includes("partial")) value = 0.5;
    else if (s.includes("none") || s.includes("absent")) value = 0;
  }
  return sig(value, "engagement_detail", "safe_harbor_field");
}

/**
 * Mean of four completeness parts: fraction of in-scope targets with
 * non-empty category; fraction with usable location/name; 1 iff ≥1 in-scope
 * group exists; fraction of in-scope groups carrying ≥1 non-null reward.
 * Empty-denominator fractions score 0. Detail present but zero in-scope
 * targets AND zero in-scope groups → null (nothing to judge).
 */
function targetDataQuality(
  inScopeTargets: ApiTarget[],
  inScopeGroups: ApiTargetGroup[],
): RadarSignal {
  if (inScopeTargets.length === 0 && inScopeGroups.length === 0) {
    return sig(null, "derived", "field_completeness_mix");
  }
  const categoryFrac =
    inScopeTargets.length === 0
      ? 0
      : inScopeTargets.filter((t) => nonEmpty(t.category)).length /
        inScopeTargets.length;
  const identityFrac =
    inScopeTargets.length === 0
      ? 0
      : inScopeTargets.filter(usableIdentity).length / inScopeTargets.length;
  const groupsPresent = inScopeGroups.length > 0 ? 1 : 0;
  const rewardFrac =
    inScopeGroups.length === 0
      ? 0
      : inScopeGroups.filter(hasRewardMetadata).length / inScopeGroups.length;
  return sig(
    (categoryFrac + identityFrac + groupsPresent + rewardFrac) / 4,
    "derived",
    "field_completeness_mix",
  );
}
