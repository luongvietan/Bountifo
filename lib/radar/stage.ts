import { RADAR_PROFILES } from "./profiles";
import { DEEP_SIGNAL_KEYS } from "./types";
import type {
  ProgramScore,
  RadarEvidenceLevel,
  RadarFeatureKey,
  RadarProfileId,
} from "./types";

// ---------------------------------------------------------------------------
// Evidence-level semantics (V1.3.1).
//
// A program can hold two scores per profile: the metadata-stage score (all
// programs, every scan) and the deep-stage score (deep-analyzed programs
// only, under the deep-joined source_hash). They are DIFFERENT evidence
// levels — never merged into one rank. The results table exposes them as
// separate modes; this module is the single place that decides how a row's
// evidence is labelled, which score a mode displays, and how the two scores
// are presented together. Everything here is pure — no I/O, no clocks.
// ---------------------------------------------------------------------------

/**
 * How a result row's evidence is presented: which stage's score is shown,
 * whether a deep score exists alongside, and the before/after delta.
 */
export interface EvidenceAnnotation {
  /** "deep" iff a deep-stage score exists for this program+profile —
   *  independent of which mode the table is currently showing. */
  evidence_level: RadarEvidenceLevel;
  /** The metadata-stage score (null when the program was never metadata
   *  scored — practically unreachable inside a run scope). */
  metadata_score: number | null;
  /** The deep-stage score, or null when the program was not deep-analyzed.
   *  null ≠ 0: a missing deep score is "not analyzed", not "bad". */
  deep_score: number | null;
  /** deep_score − metadata_score when both exist (rounded to 0.1). null
   *  otherwise — a delta without both endpoints is meaningless. */
  score_delta: number | null;
}

function round1(value: number): number {
  const rounded = Number(value.toFixed(1));
  // Collapse -0: a sub-0.05 delta is "no change" and carries no sign —
  // downstream comparisons and renders must never see "-0.0".
  return rounded === 0 ? 0 : rounded;
}

/**
 * Annotates one program's evidence from its two stage scores. Either may be
 * null (program not analyzed at that stage). The delta is only defined when
 * BOTH scores are known — a deep score never "replaces" the metadata score.
 * A score row whose `score` field is null (every weighted signal unknown)
 * counts as a missing endpoint: the row exists, but there is nothing to
 * subtract.
 */
export function annotateEvidence(
  metadata: ProgramScore | null,
  deep: ProgramScore | null,
): EvidenceAnnotation {
  const metadataScore = metadata?.score ?? null;
  const deepScore = deep?.score ?? null;
  return {
    evidence_level: deep === null ? "metadata" : "deep",
    metadata_score: metadataScore,
    deep_score: deepScore,
    score_delta:
      metadataScore === null || deepScore === null
        ? null
        : round1(deepScore - metadataScore),
  };
}

// ---------------------------------------------------------------------------
// Deep-profile derivation.
//
// A profile is "deep" iff its score can move under deep evidence — i.e. its
// weight table consumes at least one deep-only signal (DEEP_SIGNAL_KEYS).
// This is DERIVED from RADAR_PROFILES, never from DEEP_PROFILE_IDS: the
// constant exists for documented candidate-union priority order, and tests
// pin that the two agree for every profile. A profile weighting no deep
// signal (high_reward, easy_entry) would produce a byte-identical score
// under deep re-scoring — a deep row carrying zero new evidence — so the
// coordinator restricts deep re-scores to the deep set.
// ---------------------------------------------------------------------------

/**
 * The deep-only signal keys `profileId` weights, in the profile's declared
 * weight order. Empty for metadata-only profiles.
 */
export function profileDeepSignals(
  profileId: RadarProfileId,
): RadarFeatureKey[] {
  const weights = RADAR_PROFILES[profileId].weights;
  return (Object.keys(weights) as RadarFeatureKey[]).filter((key) =>
    (DEEP_SIGNAL_KEYS as readonly RadarFeatureKey[]).includes(key),
  );
}

/** Whether `profileId`'s score can change under deep evidence. */
export function isDeepProfile(profileId: RadarProfileId): boolean {
  return profileDeepSignals(profileId).length > 0;
}

// ---------------------------------------------------------------------------
// Presentation rules — the single source of truth for how evidence levels
// and deltas surface in the results table (and any other consumer).
// ---------------------------------------------------------------------------

/**
 * The score a results mode displays for an annotated row: "deep" mode ranks
 * on deep scores, "metadata" mode on metadata scores. Returns null when the
 * row lacks that stage's score — the mode decides whether such rows appear
 * at all (deep mode shows deep-analyzed rows only; metadata mode shows all).
 */
export function scoreForMode(
  annotation: EvidenceAnnotation,
  mode: RadarEvidenceLevel,
): number | null {
  return mode === "deep" ? annotation.deep_score : annotation.metadata_score;
}

/**
 * The evidence badge for a row: "DEEP" marks rows backed by a deep-stage
 * score. Metadata-only rows get NO badge — metadata is the baseline every
 * scored program holds; flagging it would read as a downgrade marker.
 */
export function evidenceBadge(level: RadarEvidenceLevel): "DEEP" | null {
  return level === "deep" ? "DEEP" : null;
}

/**
 * Direction of a score delta, for badge coloring: "up" when deep evidence
 * raised the score, "down" when it lowered it (a real regression signal —
 * e.g. known-issue pressure priced in), "flat" on a zero delta, "none"
 * when the delta is undefined. null never becomes "flat".
 */
export function deltaDirection(
  delta: number | null,
): "up" | "down" | "flat" | "none" {
  if (delta === null) return "none";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

/**
 * Canonical delta text: signed, one decimal ("+1.9", "-10.1", "+0.0" for a
 * rounded-to-zero delta). A null delta renders "—" — never "+0.0": a
 * missing endpoint is "not computed", not "no change".
 */
export function formatScoreDelta(delta: number | null): string {
  if (delta === null) return "—";
  const v = round1(delta);
  return v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
}
