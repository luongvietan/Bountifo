import type { ProgramScore, RadarEvidenceLevel } from "./types";

// ---------------------------------------------------------------------------
// Evidence-level semantics (V1.3.1).
//
// A program can hold two scores per profile: the metadata-stage score (all
// programs, every scan) and the deep-stage score (deep-analyzed programs
// only, under the deep-joined source_hash). They are DIFFERENT evidence
// levels — never merged into one rank. The results table exposes them as
// separate modes; this module is the single place that decides how a row's
// evidence is labelled and how the two scores are presented together.
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
  return Number(value.toFixed(1));
}

/**
 * Annotates one program's evidence from its two stage scores. Either may be
 * null (program not analyzed at that stage). The delta is only defined when
 * BOTH scores are known — a deep score never "replaces" the metadata score.
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
