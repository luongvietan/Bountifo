import {
  DEEP_PROFILE_IDS,
  MAX_DEEP_PROGRAMS,
  PROFILE_CANDIDATE_DEPTH,
  type DeepCandidate,
  type RadarProfileId,
} from "./types";

/**
 * V1.3.1 — profile-aware deep-candidate shortlist.
 *
 * Radar V1.3 deep-enriched only the best_ev metadata Top-30 — but
 * low_competition, authz_api and fresh_programs also weight deep signals
 * (known_issue_density / opportunity_change), so THEIR top rows never saw a
 * deep pass. This module builds the deterministic union over every
 * deep-dependent profile's metadata ranking:
 *
 *   1. each profile in DEEP_PROFILE_IDS order contributes its first `depth`
 *      uuids (rank 1 first — the caller supplies rankPrograms order, already
 *      eligible-only and latest-run-scoped);
 *   2. a uuid appearing under several profiles merges into ONE candidate
 *      carrying every reason, reasons ordered by profile priority;
 *   3. dispatch order sorts by (highest-priority contributing profile, best
 *      metadata rank, uuid ASC) — deterministic and total;
 *   4. the union is capped at `maxCandidates`; the overflow count is
 *      reported honestly in `truncated`.
 *
 * Pure: no I/O, no clock, no randomness — identical inputs always produce an
 * identical result.
 */

export interface ShortlistInput {
  /** For each deep-dependent profile: that profile's metadata-stage ranking
   *  as ordered uuids — eligible entries only, rankPrograms order (rank 1
   *  first), already latest-run-scoped. Absent profiles treated as empty. */
  perProfile: ReadonlyMap<RadarProfileId, readonly string[]>;
  /** Per-profile Top-N admitted (default PROFILE_CANDIDATE_DEPTH). */
  depth?: number;
  /** Hard cap on the returned union (default MAX_DEEP_PROGRAMS). */
  maxCandidates?: number;
}

export interface ShortlistResult {
  /** Deduped candidates in deterministic dispatch order (see below). */
  candidates: DeepCandidate[];
  /** How many selected candidates were cut by maxCandidates. */
  truncated: number;
  /** Union size BEFORE truncation. */
  unionSize: number;
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
  // DEEP_PROFILE_IDS is exhaustive for the inputs this module accepts —
  // a non-deep profile passed via a wider Map sorts last rather than
  // crashing the shortlist.
  return PROFILE_ORDER.get(profile) ?? DEEP_PROFILE_IDS.length;
}

export function selectDeepCandidates(input: ShortlistInput): ShortlistResult {
  const depth = clampCount(input.depth, PROFILE_CANDIDATE_DEPTH);
  const maxCandidates = clampCount(input.maxCandidates, MAX_DEEP_PROGRAMS);

  // Merge pass — profiles contribute in DEEP_PROFILE_IDS order, so the
  // reasons each uuid accumulates arrive already priority-sorted.
  const byUuid = new Map<string, DeepCandidate>();
  for (const profile of DEEP_PROFILE_IDS) {
    const ranking = input.perProfile.get(profile);
    if (ranking === undefined) continue;
    const admitted = ranking.slice(0, depth);
    for (let i = 0; i < admitted.length; i++) {
      const uuid = admitted[i];
      if (uuid === undefined) continue; // unreachable — in-bounds index
      let candidate = byUuid.get(uuid);
      if (candidate === undefined) {
        candidate = { uuid, reasons: [] };
        byUuid.set(uuid, candidate);
      }
      // A duplicated uuid inside one profile's ranking keeps its best
      // (first-seen) rank — one reason per contributing profile.
      if (candidate.reasons.some((r) => r.profile === profile)) continue;
      candidate.reasons.push({ profile, metadata_rank: i + 1 });
    }
  }

  // Dispatch order: the profile-priority bucket first (best_ev reasons
  // outrank fresh_programs reasons…), then the uuid's best metadata rank,
  // then uuid ASC for a total order when two programs swap ranks across
  // profiles (e.g. {best_ev:1, fresh:2} vs {best_ev:2, fresh:1}).
  const ordered = [...byUuid.values()].sort((a, b) => {
    const aKey = sortKey(a);
    const bKey = sortKey(b);
    if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
    if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
  });

  const unionSize = ordered.length;
  const candidates = ordered.slice(0, maxCandidates);
  return {
    candidates,
    truncated: unionSize - candidates.length,
    unionSize,
  };
}

/** [lowest DEEP_PROFILE_IDS index among reasons, lowest rank among reasons]. */
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
