import { siteRequest } from "../api/siteClient";
import type { ApiEngagementData } from "../types";
import type { RadarScopeArc, RadarSemanticDiff } from "./deepTypes";
import { mapBriefDocument } from "./detailMap";
import { diffBriefDocuments } from "./diff";
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
// fetchScopeArc is the only impure export (one GET_BRIEF_DOC siteRequest);
// it NEVER throws — failures land in status. The selector and the score are
// pure and deterministic: no clock, no network, no randomness.
// ---------------------------------------------------------------------------

/**
 * Arc baseline = the changelog entry `depth` positions before the current
 * version in the newest-first list (clamped to the oldest entry).
 *
 *   latestId found at index i → j = min(i + depth, entries.length - 1);
 *     j === i (Latest is the oldest entry, or a single-entry list) → null;
 *     else {id: entries[j].id, window: j - i}.
 *   latestId null/empty       → the head is current (i = 0 — the list is
 *     newest-first even when no entry carries the "Latest" tag):
 *     j = min(depth, len - 1); j === 0 → null.
 *   latestId set but absent   → null. An asserted current version that the
 *     list doesn't contain (pagination drift, stale id) must never pair with
 *     an arbitrary older entry — same doctrine as selectDiffBaseline.
 *   entries.length < 2        → null (no baseline exists).
 *
 * A degenerate depth (≤ 0, fractional) yields j ≤ i or an unindexable j —
 * both read "no baseline" rather than emitting a negative/fractional window.
 */
export function selectArcBaseline(
  entries: RadarChangelogEntry[],
  latestId: string | null,
  depth: number = SCOPE_ARC_DEPTH,
): { id: string; window: number } | null {
  if (!Array.isArray(entries) || entries.length < 2) return null;
  let i = 0;
  if (typeof latestId === "string" && latestId !== "") {
    i = entries.findIndex((e) => e.id === latestId);
    if (i === -1) return null;
  }
  const j = Math.min(i + depth, entries.length - 1);
  const baseline = j <= i ? undefined : entries[j];
  return baseline === undefined ? null : { id: baseline.id, window: j - i };
}

/**
 * Fetches the arc baseline doc and diffs it against `currentDetail` — the
 * same map→diff path as the single-step diff in deep.ts, only the baseline
 * sits `sel.window` publishes back instead of one.
 *
 * NEVER throws:
 *   no baseline   → {status:"no_baseline", window_versions:null, diff:null}
 *   fetch/map throw → {status:"unavailable", window_versions:sel.window,
 *                      diff:null} — the selected window is still reported
 *                      honestly even though the document never arrived.
 *   otherwise     → {status:"complete", window_versions:sel.window, diff}
 *
 * A mapped pair the differ itself can't analyze (diff.status "unavailable")
 * collapses to the unavailable arc: the schema pins diff:null on every
 * non-complete status, so the half-computed diff is dropped rather than
 * emitted under a false "complete".
 */
export async function fetchScopeArc(
  slug: string,
  entries: RadarChangelogEntry[],
  latestId: string | null,
  currentDetail: ApiEngagementData,
): Promise<RadarScopeArc> {
  const sel = selectArcBaseline(entries, latestId);
  if (sel === null) {
    return { status: "no_baseline", window_versions: null, diff: null };
  }
  let prevDetail: ApiEngagementData;
  try {
    const res = await siteRequest({
      operation: "GET_BRIEF_DOC",
      slug,
      versionId: sel.id,
    });
    // Statistics/joined lists are signals of the CURRENT version — the arc
    // baseline maps with them absent, exactly like the step baseline.
    prevDetail = mapBriefDocument(slug, res.data, null, null);
  } catch {
    return { status: "unavailable", window_versions: sel.window, diff: null };
  }
  const diff = diffBriefDocuments(prevDetail, currentDetail, {
    from_version: sel.id,
    to_version: latestId,
  });
  if (diff.status !== "complete") {
    return { status: "unavailable", window_versions: sel.window, diff: null };
  }
  return { status: "complete", window_versions: sel.window, diff };
}

/**
 * Momentum accumulated over the arc window — how much NEW hunting
 * opportunity the last `window_versions` publishes opened NET, 0..1.
 * null unless the diff completed (unknown ≠ zero).
 *
 *   s = min(1, 0.35·ai/(ai+8) + 0.25·api/(api+4) + 0.10·ag/(ag+2)
 *            + 0.15·[reward_increase] + 0.15·mi/(mi+4))
 *
 * Same fact names as opportunityChangeScore with window-scaled
 * half-saturations — a 5-publish window accumulates more than a single
 * step, so each term saturates slower. Weights sum to exactly 1.00; every
 * term is monotone nondecreasing; reductions (removed_*, moved_out_of_scope,
 * reward_decrease) contribute NOTHING — momentum measures growth, it never
 * penalizes shrinkage. only_administrative_changes → a real 0: an analyzed
 * arc with no net scope growth is a reading, not an unknown.
 */
export function scopeMomentumScore(diff: RadarSemanticDiff): number | null {
  if (diff.status !== "complete") return null;
  if (diff.only_administrative_changes === true) return 0;
  const ai = diff.added_in_scope_targets ?? 0;
  const api = diff.added_api_targets ?? 0;
  const ag = diff.added_groups ?? 0;
  const mi = diff.moved_in_scope ?? 0;
  const rewardUp = diff.reward_increase === true ? 1 : 0;
  const s = Math.min(
    1,
    0.35 * (ai / (ai + 8)) +
      0.25 * (api / (api + 4)) +
      0.1 * (ag / (ag + 2)) +
      0.15 * rewardUp +
      0.15 * (mi / (mi + 4)),
  );
  return Number(s.toFixed(4));
}
