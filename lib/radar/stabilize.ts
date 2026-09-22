import {
  DEEP_BATCH_SIZE,
  DEEP_PROFILE_IDS,
  MAX_DEEP_PROGRAMS,
  STABILITY_BUFFER,
  STABLE_TOP_K,
  type DeepCandidate,
  type DeepStabilization,
  type RadarProfileId,
} from "./types";

/**
 * V1.3.1 — deep-stage stabilization frontier (Agent C).
 *
 * V1.3 ran ONE deep pass over a fixed shortlist, then stopped. After the
 * deep re-score, programs fall out of the Top-K and unanalyzed metadata
 * candidates rise above them — V1.3 never went back for those. V1.3.1 adds
 * bounded iterative deepening: after each deep round the coordinator
 * re-evaluates the frontier — the union of every deep-dependent profile's
 * metadata Top-(K + buffer) — and pulls the next batch of window members
 * that are not yet deep-committed, until the frontier closes or the run's
 * deep budget is gone.
 *
 * This module is the pure verdict function for that loop. The coordinator
 * computes the inputs (per-profile metadata rankings — fixed for the whole
 * deep stage since metadata scores never change; the committed set — which
 * only grows) and owns all I/O, batching and persistence.
 *
 *   missing  — every in-window uuid not yet committed, with per-profile
 *              (profile, metadata_rank) provenance, in dispatch order;
 *   batch    — the next ≤ min(batchSize, remaining budget) of missing;
 *   statusIfStopped — "stable" / "budget_limited" / "incomplete";
 *   remainingAfter  — budget left once this batch is committed.
 *
 * Pure and deterministic: no I/O, no clock, no randomness — identical
 * inputs always produce an identical verdict.
 */

export interface FrontierInput {
  /**
   * Per deep-dependent profile: its metadata-stage ranking as ordered,
   * ELIGIBLE, latest-run-scoped uuids (rank 1 first). Missing profile =
   * empty window. Keys outside DEEP_PROFILE_IDS are ignored — a profile
   * that weights no deep signal can never demand deep analysis.
   */
  perProfileMetadata: ReadonlyMap<RadarProfileId, readonly string[]>;
  /**
   * uuids already committed to deep analysis: completed ∪ pending ∪
   * already-queued batches. Membership test for the frontier — a committed
   * uuid is never re-batched, wherever it ranks.
   */
  committed: ReadonlySet<string>;
  /**
   * How many unique programs have been committed so far — the budget
   * ledger. Kept separate from `committed` because the coordinator owns
   * the count (a uuid committed in an earlier round is still spent budget
   * even if it no longer sits in any window).
   */
  committedCount: number;
  /** Hard cap on unique programs deep-analyzed per run (default
   *  MAX_DEEP_PROGRAMS). */
  maxBudget?: number;
  /** The Top-K the frontier tries to make fully deep-analyzed (default
   *  STABLE_TOP_K). */
  stableTopK?: number;
  /** Extra metadata-rank margin watched beyond Top-K (default
   *  STABILITY_BUFFER). */
  buffer?: number;
  /** Programs dispatched per stabilization round (default
   *  DEEP_BATCH_SIZE). */
  batchSize?: number;
}

export interface FrontierVerdict {
  /**
   * uuids inside the frontier window not yet committed, each with the
   * profile window(s) that demand them — deterministic dispatch order:
   * (lowest DEEP_PROFILE_IDS index among reasons, lowest metadata_rank
   * among reasons, uuid ASC).
   */
  missing: DeepCandidate[];
  /**
   * The next batch to deep-analyze: ⊆ missing, size ≤ min(batchSize,
   * remaining budget). Empty when nothing is missing or budget is gone.
   */
  batch: DeepCandidate[];
  /**
   * What the run should report if it stopped now:
   *   missing empty                    → "stable"
   *   missing non-empty, batch empty   → "budget_limited"
   *   missing non-empty, batch non-empty → "incomplete" (keep going)
   */
  statusIfStopped: DeepStabilization;
  /** Remaining budget AFTER this batch. */
  remainingAfter: number;
}

/** Defensive count normalization: undefined/non-finite → fallback, then a
 *  floored non-negative integer. */
function clampCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

const PROFILE_ORDER = new Map<RadarProfileId, number>(
  DEEP_PROFILE_IDS.map((id, index) => [id, index]),
);

function profileOrder(profile: RadarProfileId): number {
  // Reasons only ever carry DEEP_PROFILE_IDS members here — the merge pass
  // iterates that list — but DeepCandidate admits any RadarProfileId, so a
  // stray profile sorts last rather than crashing the comparator.
  return PROFILE_ORDER.get(profile) ?? DEEP_PROFILE_IDS.length;
}

/**
 * Dispatch-order sort key — identical rule to the V1.3.1 shortlist
 * (selectDeepCandidates): [lowest DEEP_PROFILE_IDS index among reasons,
 * lowest metadata_rank among reasons]. The rank minimum is over ALL
 * reasons, not just the best-priority one — a program ranked 1st in any
 * deep profile outranks a middling best_ev-only row.
 */
function sortKey(candidate: DeepCandidate): readonly [number, number] {
  let minProfile = Number.POSITIVE_INFINITY;
  let minRank = Number.POSITIVE_INFINITY;
  for (const reason of candidate.reasons) {
    const order = profileOrder(reason.profile);
    if (order < minProfile) minProfile = order;
    if (reason.metadata_rank < minRank) minRank = reason.metadata_rank;
  }
  return [minProfile, minRank];
}

function compareCandidates(a: DeepCandidate, b: DeepCandidate): number {
  const aKey = sortKey(a);
  const bKey = sortKey(b);
  if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
  if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
  // Total order: identical (profile, rank) keys across profiles fall back
  // to uuid ASC — identical inputs always dispatch identically.
  return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

export function evaluateFrontier(input: FrontierInput): FrontierVerdict {
  const topK = clampCount(input.stableTopK, STABLE_TOP_K);
  const buffer = clampCount(input.buffer, STABILITY_BUFFER);
  const batchSize = clampCount(input.batchSize, DEEP_BATCH_SIZE);
  const maxBudget = clampCount(input.maxBudget, MAX_DEEP_PROGRAMS);
  const committedCount = clampCount(input.committedCount, 0);
  const windowSize = topK + buffer;

  // Merge pass — profiles contribute in DEEP_PROFILE_IDS order, so each
  // candidate's reasons accumulate already priority-sorted.
  const byUuid = new Map<string, DeepCandidate>();
  for (const profile of DEEP_PROFILE_IDS) {
    const ranking = input.perProfileMetadata.get(profile);
    if (ranking === undefined) continue;
    const window = ranking.slice(0, windowSize);
    for (const [index, uuid] of window.entries()) {
      // Committed (completed ∪ pending ∪ queued) uuids are never missing —
      // the frontier asks only for work still owed.
      if (input.committed.has(uuid)) continue;
      let candidate = byUuid.get(uuid);
      if (candidate === undefined) {
        candidate = { uuid, reasons: [] };
        byUuid.set(uuid, candidate);
      }
      // A duplicated uuid inside one profile's ranking keeps its best
      // (first-seen) rank — one reason per contributing profile.
      if (candidate.reasons.some((r) => r.profile === profile)) continue;
      candidate.reasons.push({ profile, metadata_rank: index + 1 });
    }
  }

  const missing = [...byUuid.values()].sort(compareCandidates);

  const budgetLeft = Math.max(0, maxBudget - committedCount);
  const batch = missing.slice(0, Math.min(batchSize, budgetLeft));

  const statusIfStopped: DeepStabilization =
    missing.length === 0
      ? // "stable" = stable within the K+buffer frontier — every deep-
        // dependent profile's watched window is fully committed. It is NOT
        // a proven global fixpoint: a program below the window could still
        // out-score a deep-analyzed row if it were analyzed; the bounded
        // frontier deliberately does not claim more.
        "stable"
      : batch.length === 0
        ? "budget_limited"
        : "incomplete";

  return {
    missing,
    batch,
    statusIfStopped,
    remainingAfter: budgetLeft - batch.length,
  };
}
