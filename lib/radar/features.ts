import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../types";
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
// band boundary. `statistics.average_payout` is deliberately NOT consumed by
// any V1 signal: it is captured in source_hash (so a change re-triggers
// scoring) but payout averages are too noisy to feed a fixed curve yet.
// ---------------------------------------------------------------------------

/** Reward normalization anchors: (usdAmount, normalizedValue). */
const REWARD_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [500, 0.25],
  [2000, 0.5],
  [10000, 0.8],
  [25000, 1],
];

// Piecewise interpolation runs in ln(1+amount) space, so anchors are
// precomputed in log space once.
const LOG_ANCHORS: ReadonlyArray<readonly [number, number]> =
  REWARD_ANCHORS.map(([amount, y]) => [Math.log(1 + amount), y]);

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
 * has already drawn sustained research attention. `known_issue_density` is
 * declared for V1.3 wiring: it has no cheap source yet, so it carries no
 * V1.2 weight, but adding it later changes only the weight table.
 */
export type SaturationComponentKey =
  | "recent_crowding"
  | "submission_activity"
  | "rewarded_activity"
  | "known_issue_density";

/** V1.2 pinned weights — initial deterministic calibration. */
const SATURATION_WEIGHTS: Readonly<Record<string, number>> = {
  recent_crowding: 0.3,
  submission_activity: 0.4,
  rewarded_activity: 0.3,
} satisfies Partial<Record<SaturationComponentKey, number>>;

// Fewer than two known components means one noisy metric masquerading as
// saturation — the composite reports null instead.
const MIN_SATURATION_COMPONENTS = 2;

// Deterministic surface token sets — exact token membership only, so
// substring traps ("capitol"⊅"api", "restaurant"⊅"rest") never match.
const API_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "rest",
  "graphql",
  "grpc",
  "webservice",
  "endpoint",
]);
const WEB_TOKENS: ReadonlySet<string> = new Set([
  "web",
  "website",
  "webapp",
  "webapplication",
]);

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

// "1,234" / "1234" with optional ".dec"; commas must be strict thousands
// separators (leading group 1–3 digits, then ",ddd" groups only).
const STAT_VALUE_RE = /^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/;

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

/**
 * Frozen V1 reward curve: piecewise-linear interpolation in ln(1+amount)
 * between anchors 0→0, 500→0.25, 2000→0.5, 10000→0.8, 25000→1.0. Values
 * ≤0 (incl. NaN) → 0; ≥25000 (incl. +∞) → 1.
 */
export function normReward(amount: number): number {
  if (!(amount > 0)) return 0;
  const top = REWARD_ANCHORS[REWARD_ANCHORS.length - 1]!;
  if (amount >= top[0]) return 1;
  const x = Math.log(1 + amount);
  for (let i = 0; i < LOG_ANCHORS.length - 1; i++) {
    const [x0, y0] = LOG_ANCHORS[i]!;
    const [x1, y1] = LOG_ANCHORS[i + 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return 1;
}

/**
 * Strict parser for `statistics.*.value` strings. Accepts plain digits,
 * strict thousands grouping ("1,234", "1,234,567.89"), one optional leading
 * "$" ("$512.00") and surrounding whitespace. Rejects "1,23,4", empty,
 * negative-as-text, exponent or arbitrary text — never a bare parseFloat.
 */
export function parseStatValue(raw: string): number | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (!STAT_VALUE_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

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
      accessibility: notAvailableV1(),
      known_issue_density: notAvailableV1(),
      authz_opportunity: notAvailableV1(),
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
    accessibility: notAvailableV1(),
    known_issue_density: notAvailableV1(),
    authz_opportunity: notAvailableV1(),
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
 * Token set of a target: category, name and each tag, lowercased and split on
 * non-alphanumeric runs. Exact set membership only — never substring match.
 * `location` is deliberately NOT tokenized: the web fallback reads it as a
 * URL instead.
 */
function tokenSet(target: ApiTarget): Set<string> {
  const out = new Set<string>();
  const fields: unknown[] = [
    target.category,
    target.name,
    ...(Array.isArray(target.tags) ? target.tags : []),
  ];
  for (const field of fields) {
    if (typeof field !== "string") continue;
    for (const token of field.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token !== "") out.add(token);
    }
  }
  return out;
}

function intersects(a: Set<string>, b: ReadonlySet<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/** True iff `location` parses as an http(s) URL — a web target absent other
 *  info. */
function isHttpUrl(location: string | null): boolean {
  if (location === null) return false;
  try {
    const protocol = new URL(location.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function classifySurfaces(inScopeTargets: ApiTarget[]): {
  api: RadarSignal;
  apiSize: RadarSignal;
  web: RadarSignal;
} {
  let apiCount = 0;
  let webCount = 0;
  for (const target of inScopeTargets) {
    const tokens = tokenSet(target);
    const isApi = intersects(tokens, API_TOKENS);
    const isWeb = intersects(tokens, WEB_TOKENS);
    if (isApi) apiCount++;
    if (isWeb) webCount++;
    // Fallback: matches NEITHER set but location is an http(s) URL → web.
    if (!isApi && !isWeb && isHttpUrl(target.location)) webCount++;
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
