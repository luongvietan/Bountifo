import type { ProfileWeight, RadarProfile } from "./profiles";
import { RADAR_FEATURE_KEYS } from "./types";
import type {
  ProgramFeatureVector,
  ProgramScore,
  RadarFeatureKey,
  RadarProgramSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Deterministic scoring engine — PURE. No clocks, no randomness, no I/O.
//
// Pinned math (V1.1 — direction-normalized weights):
//   effective_i = s_i (benefit) or 1 − s_i (cost)
//   coverage    = known w / total w   (unknown weighted signals reduce it)
//   score       = clamp(Σ w_i·eff_i / known w, 0, 1) × 100
//
// Unknown signals (value null) are excluded from the score denominator —
// never coerced to 0 or 0.5 — and the score is never multiplied by
// coverage. Both are reported separately. Because every weight is positive
// and eff ∈ [0,1], a null signal can only sit between the best and worst
// known outcomes — never above "known perfect" (the V1.0 signed-weight bug).
// ---------------------------------------------------------------------------

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Reason codes — stable, template-rendered; never AI-generated in V1.
// One evaluator per signal key; returns null when the value sits between
// thresholds (silence is a valid answer — not every band deserves a code).
// ---------------------------------------------------------------------------

const REASON_RULES: Record<RadarFeatureKey, (s: number) => string | null> = {
  reward_potential: (s) =>
    s >= 0.8 ? "REWARD_HIGH" : s >= 0.5 ? "REWARD_MEDIUM" : "REWARD_LOW",
  reward_breadth: (s) => (s >= 0.5 ? "REWARD_BROAD" : null),
  meaningful_surface: (s) => (s >= 0.5 ? "SURFACE_LARGE" : null),
  api_surface: (s) => (s >= 0.4 ? "API_SURFACE_HIGH" : null),
  api_surface_size: (s) => (s >= 0.5 ? "API_SURFACE_LARGE" : null),
  web_surface: (s) => (s >= 0.4 ? "WEB_SURFACE_HIGH" : null),
  researcher_competition: (s) =>
    s <= 0.3 ? "COMPETITION_LOW" : s >= 0.7 ? "COMPETITION_HIGH" : null,
  rewarded_activity: (s) => (s >= 0.5 ? "ACTIVITY_PROVEN" : null),
  submission_activity: (s) =>
    s <= 0.25
      ? "SUBMISSION_ACTIVITY_LOW"
      : s >= 0.7
        ? "SUBMISSION_ACTIVITY_HIGH"
        : null,
  research_saturation: (s) =>
    s <= 0.25 ? "SATURATION_LOW" : s >= 0.7 ? "SATURATION_HIGH" : null,
  freshness: (s) =>
    s >= 0.85 ? "RECENTLY_UPDATED" : s <= 0.15 ? "STALE_PROGRAM" : null,
  safe_harbor: (s) =>
    s === 1
      ? "SAFE_HARBOR_PRESENT"
      : s === 0.5
        ? "SAFE_HARBOR_PARTIAL"
        : s === 0
          ? "SAFE_HARBOR_ABSENT"
          : null,
  target_data_quality: (s) => (s <= 0.4 ? "DATA_INCOMPLETE" : null),
  // No V1 threshold codes — accessibility/authz stay UNKNOWN_* today.
  // known_issue_density / opportunity_change get real codes when their V1.3
  // deep sources are wired into the weight tables.
  accessibility: () => null,
  known_issue_density: () => null,
  opportunity_change: () => null,
  authz_opportunity: () => null,
};

/**
 * Human-readable template per reason code. UNKNOWN_<KEY> entries are the
 * signal key spelled out plus " unavailable". Keep every code the engine can
 * emit covered — the UI renders these verbatim, never generated prose.
 */
export const REASON_TEXT: Record<string, string> = {
  REWARD_HIGH: "strong P1/P2 reward",
  REWARD_MEDIUM: "moderate P1/P2 reward",
  REWARD_LOW: "low reward potential",
  REWARD_BROAD: "broad reward coverage",
  API_SURFACE_HIGH: "substantial API surface",
  API_SURFACE_LARGE: "large API target count",
  WEB_SURFACE_HIGH: "substantial web surface",
  SURFACE_LARGE: "large in-scope surface",
  COMPETITION_LOW: "low recent crowding",
  COMPETITION_HIGH: "high recent crowding",
  ACTIVITY_PROVEN: "proven reward activity",
  SUBMISSION_ACTIVITY_LOW: "low submission volume",
  SUBMISSION_ACTIVITY_HIGH: "high submission volume",
  SATURATION_LOW: "low observed research saturation",
  SATURATION_HIGH: "high observed research saturation",
  RECENTLY_UPDATED: "recently updated",
  STALE_PROGRAM: "stale program",
  SAFE_HARBOR_PRESENT: "safe harbor present",
  SAFE_HARBOR_PARTIAL: "partial safe harbor",
  SAFE_HARBOR_ABSENT: "no safe harbor",
  DATA_INCOMPLETE: "incomplete program data",
  ...Object.fromEntries(
    RADAR_FEATURE_KEYS.map((key) => [
      `UNKNOWN_${key.toUpperCase()}`,
      `${key.replace(/_/g, " ")} unavailable`,
    ]),
  ),
};

/** Codes rendered as cautions ("- ") rather than positives ("+ "). */
const CAUTION_CODES: ReadonlySet<string> = new Set([
  "REWARD_LOW",
  "COMPETITION_HIGH",
  "STALE_PROGRAM",
  "SAFE_HARBOR_ABSENT",
  "DATA_INCOMPLETE",
  "SUBMISSION_ACTIVITY_HIGH",
  "SATURATION_HIGH",
]);

/** V1.1 weight normalization: bare number → benefit; object → declared
 *  direction. Negative weights are a rejected legacy shape (the V1.0 bug
 *  source) — refuse them loudly rather than silently flipping direction. */
function normalizeWeight(
  raw: ProfileWeight,
  key: RadarFeatureKey,
): { weight: number; direction: "benefit" | "cost" } {
  const normalized =
    typeof raw === "number"
      ? { weight: raw, direction: "benefit" as const }
      : raw;
  if (!(normalized.weight >= 0) || !Number.isFinite(normalized.weight)) {
    throw new TypeError(
      `profile weight for ${key} must be a non-negative finite number`,
    );
  }
  return normalized;
}

/**
 * Scores one program under one profile. Components carry one entry per
 * profile-weighted key ({signal, declared weight, w_i·eff_i or null}).
 * Reason codes iterate the profile's declared key order over the RAW signal
 * value; UNKNOWN_<KEY> codes for weighted-but-null signals come last.
 *
 * `provisional` is true when a `required_any` group is entirely unknown —
 * the score is still reported but flagged as not final.
 */
export function scoreProgram(
  snapshot: RadarProgramSnapshot,
  vector: ProgramFeatureVector,
  profile: RadarProfile,
): ProgramScore {
  const entries = Object.entries(profile.weights) as Array<
    [RadarFeatureKey, ProfileWeight]
  >;

  let totalWeight = 0;
  let knownWeight = 0;
  let weightedSum = 0;
  const components: ProgramScore["components"] = {};
  const reasons: string[] = [];
  const unknownReasons: string[] = [];

  for (const [key, rawWeight] of entries) {
    const { weight, direction } = normalizeWeight(rawWeight, key);
    const signal = vector[key].value;
    totalWeight += weight;
    const effective =
      signal === null ? null : direction === "cost" ? 1 - signal : signal;
    components[key] = {
      signal,
      weight,
      direction,
      contribution:
        effective === null ? null : round4(weight * effective),
    };
    if (signal === null || effective === null) {
      unknownReasons.push(`UNKNOWN_${key.toUpperCase()}`);
      continue;
    }
    knownWeight += weight;
    weightedSum += weight * effective;
    const reason = REASON_RULES[key](signal);
    if (reason !== null) reasons.push(reason);
  }

  const confidence = totalWeight === 0 ? 0 : round4(knownWeight / totalWeight);
  const score =
    knownWeight === 0
      ? null
      : round1(clamp01(weightedSum / knownWeight) * 100);

  const provisional = (profile.required_any ?? []).some((group) =>
    group.every((key) => vector[key].value === null),
  );

  return {
    schema_version: 1,
    engagement_uuid: snapshot.uuid,
    profile: profile.id,
    scoring_version: profile.version,
    score,
    confidence,
    provisional,
    components,
    reasons: [...reasons, ...unknownReasons],
    source_hash: snapshot.source_hash,
  };
}

/** A score paired with its eligibility flag under the ranking profile. */
export interface RankedProgram {
  score: ProgramScore;
  eligible: boolean;
}

/**
 * Deterministic ordering on a COPY of `scores`: eligible programs
 * (confidence ≥ profile.minConfidence AND score non-null) first, then score
 * DESC (null treated as -1), confidence DESC, engagement_uuid ASC. The uuid
 * tie-break makes the order total — identical inputs always rank identically.
 */
export function rankPrograms(
  scores: ProgramScore[],
  profile: RadarProfile,
): RankedProgram[] {
  const ranked = scores.map((score) => ({
    score,
    eligible:
      score.score !== null && score.confidence >= profile.minConfidence,
  }));
  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const byScore = (b.score.score ?? -1) - (a.score.score ?? -1);
    if (byScore !== 0) return byScore;
    const byConfidence = b.score.confidence - a.score.confidence;
    if (byConfidence !== 0) return byConfidence;
    const au = a.score.engagement_uuid;
    const bu = b.score.engagement_uuid;
    return au < bu ? -1 : au > bu ? 1 : 0;
  });
  return ranked;
}

/**
 * Renders a score's reason codes as display lines: "+ " for known-positive
 * codes, "- " for cautions, "? " for UNKNOWN_* gaps. Line order follows the
 * score's `reasons` order (threshold codes first, unknowns last).
 */
export function explainScore(score: ProgramScore): string[] {
  return score.reasons.map((code) => {
    const text = REASON_TEXT[code] ?? fallbackReasonText(code);
    if (code.startsWith("UNKNOWN_")) return `? ${text}`;
    if (CAUTION_CODES.has(code)) return `- ${text}`;
    return `+ ${text}`;
  });
}

/** Backstop for codes absent from REASON_TEXT (e.g. a future UNKNOWN_*). */
function fallbackReasonText(code: string): string {
  const spaced = code.toLowerCase().replace(/_/g, " ");
  if (code.startsWith("UNKNOWN_")) {
    return `${spaced.slice("unknown ".length)} unavailable`;
  }
  return spaced;
}
