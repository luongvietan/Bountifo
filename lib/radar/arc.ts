import type { ApiEngagementData } from "../types";
import type { RadarScopeArc, RadarSemanticDiff } from "./deepTypes";
import type { RadarChangelogEntry } from "./history";
import { SCOPE_ARC_DEPTH } from "./types";

// ---------------------------------------------------------------------------
// V1.5 scope arc — the multi-publish semantic diff behind `scope_momentum`.
//
// The single-step diff (diffBriefDocuments over the immediate predecessor)
// answers "what did the latest publish change". The arc answers "what changed
// NET over the last SCOPE_ARC_DEPTH publishes" — gradual scope creep spread
// over several publishes, invisible to single-step diffs, becomes visible.
//
// Contract stubs — Agent B lands the implementations (see
// docs/superpowers/plans/2026-09-23-radar-v1.5.md). Until then the arc reads
// honestly unknown.
// ---------------------------------------------------------------------------

/**
 * Arc baseline = the changelog entry `depth` positions before the current
 * version in the newest-first list (clamped to the oldest entry). Same
 * doctrine as selectDiffBaseline: a latestId asserted but absent never pairs
 * with an arbitrary entry.
 */
export function selectArcBaseline(
  entries: RadarChangelogEntry[],
  latestId: string | null,
  depth: number = SCOPE_ARC_DEPTH,
): { id: string; window: number } | null {
  void entries;
  void latestId;
  void depth;
  return null;
}

/**
 * Fetches the arc baseline doc and diffs it against `currentDetail`.
 * NEVER throws — failures land in status ("unavailable"/"no_baseline").
 */
export async function fetchScopeArc(
  slug: string,
  entries: RadarChangelogEntry[],
  latestId: string | null,
  currentDetail: ApiEngagementData,
): Promise<RadarScopeArc> {
  void slug;
  void entries;
  void latestId;
  void currentDetail;
  return { status: "no_baseline", window_versions: null, diff: null };
}

/**
 * Opportunity accumulated over the arc window — same fact names as
 * opportunityChangeScore with window-scaled half-saturations:
 *   min(1, 0.35·ai/(ai+8) + 0.25·api/(api+4) + 0.10·ag/(ag+2)
 *        + 0.15·[reward_increase] + 0.15·mi/(mi+4))
 * status !== "complete" → null; only_administrative_changes → a real 0 —
 * an analyzed arc with no net scope growth is a reading, not an unknown.
 */
export function scopeMomentumScore(diff: RadarSemanticDiff): number | null {
  void diff;
  return null;
}
