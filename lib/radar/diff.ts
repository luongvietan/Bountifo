import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../types";
import type { RadarSemanticDiff } from "./deepTypes";

// ---------------------------------------------------------------------------
// Radar V1.3 semantic brief differ — turns "the changelog published again"
// (what `freshness` sees) into structured facts distinguishing a wording
// edit from a NEW HUNTING OPPORTUNITY (scope expansion, new API surface,
// reward raises).
//
// Inputs are MAPPED ApiEngagementData (lib/radar/detailMap.ts output), not
// raw changelog documents: target ids are stable across versions upstream,
// and `inScope` has already been folded from group → target. All diff facts
// live under RadarSemanticDiff (lib/radar/deepTypes.ts — pinned contract):
// every fact is null unless status === "complete"; null is UNKNOWN and must
// never read as "no change".
//
// Matching semantics
// ------------------
// Targets match by `id`; a target with an empty id falls back to the
// composite `location|name|category`. Groups match by `id`, fallback `name`.
// (Keys are namespaced — "id:…"/"cmp:…"/"name:…" — so a bare name never
// collides with an id.) Duplicate keys keep the first occurrence in
// document order — deterministic and never double-counted.
//
// "Moved" semantics: a target present in BOTH versions whose inScope flag
// flipped counts as moved_in_scope (out→in) or moved_out_of_scope (in→out).
// Because mapped targets inherit their group's inScope, this covers BOTH
// mechanics identically: a group-level inScope flip flips every member, and
// a target relisted under a different group keeps its id and flips flag.
// Moves are never also counted as added/removed — membership is keyed
// identity, not per-version scope state.
//
// Reward semantics: only SHARED groups that are in-scope in the CURRENT
// version compare `rewards.p1..p5`. Strictly greater (both values numeric)
// marks reward_increase; strictly less marks reward_decrease; a tier can
// legitimately move both ways across groups. null→x and x→null are DATA
// GAPS — a tier appearing or vanishing is unknown history, not a raise or
// cut. Groups absent from one version or currently out-of-scope contribute
// nothing: dead surface can't raise an opportunity.
//
// safe_harbor_changed / status_changed are literal field-difference flags on
// safeHarborLevel / lifecycleStatus (null↔value included — appearance of a
// field is a change); the null→x data-gap doctrine applies to reward tiers
// only.
//
// only_administrative_changes is true iff the diff completed, EVERY
// structural counter is 0, and every flag is false-or-null — the
// "13-minute wording edit" case (verified live: identical scope/rewards)
// that freshness cannot tell apart from a scope expansion.
//
// Pure and deterministic: no network, no Date.now(), no randomness.
// Bugcrowd strings are data — compared, never interpreted.
// ---------------------------------------------------------------------------

const REWARD_TIERS = ["p1", "p2", "p3", "p4", "p5"] as const;

const NULL_FACTS = {
  added_targets: null,
  removed_targets: null,
  added_in_scope_targets: null,
  removed_in_scope_targets: null,
  moved_in_scope: null,
  moved_out_of_scope: null,
  added_api_targets: null,
  added_web_targets: null,
  added_groups: null,
  reward_increase: null,
  reward_decrease: null,
  safe_harbor_changed: null,
  status_changed: null,
  only_administrative_changes: null,
} as const;

/**
 * A mapped doc is diffable when its collection fields are arrays or absent
 * (absent → empty). Anything else — a scalar, a string — means the mapping
 * contract broke; the diff reports "unavailable" rather than diffing junk.
 */
function isDiffable(d: ApiEngagementData): boolean {
  if (d === null || typeof d !== "object") return false;
  const targets = (d as { targets?: unknown }).targets;
  const groups = (d as { targetGroups?: unknown }).targetGroups;
  return (
    (targets === undefined || targets === null || Array.isArray(targets)) &&
    (groups === undefined || groups === null || Array.isArray(groups))
  );
}

function targetKey(t: ApiTarget): string {
  if (typeof t.id === "string" && t.id !== "") return `id:${t.id}`;
  const part = (v: string | null): string =>
    typeof v === "string" ? v : "";
  return `cmp:${part(t.location)}|${part(t.name)}|${part(t.category)}`;
}

function groupKey(g: ApiTargetGroup): string {
  if (typeof g.id === "string" && g.id !== "") return `id:${g.id}`;
  return `name:${typeof g.name === "string" ? g.name : ""}`;
}

/** First occurrence wins — duplicate keys are indistinguishable, so doc
 *  order decides and counts stay stable. */
function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Surface classification — copied VERBATIM from lib/radar/features.ts
// (API_TOKENS/WEB_TOKENS token sets, tokenSet, intersects, isHttpUrl and the
// isApi/isWeb/http-fallback counting inside classifySurfaces). The differ
// must not import features.ts's private helpers, so they are reimplemented
// identically on purpose: same sets, same exact-token membership (never
// substring), same http(s)-location web fallback. Keep the two in sync —
// drift would make added_api_targets/added_web_targets disagree with
// api_surface/web_surface computed over the same document.
// ---------------------------------------------------------------------------

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

function isHttpUrl(location: string | null): boolean {
  if (location === null) return false;
  try {
    const protocol = new URL(location.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Same counting as classifySurfaces: a target may be both api and web;
 *  the http(s) fallback fires only when NEITHER token set matched. */
function classifyTarget(target: ApiTarget): { api: boolean; web: boolean } {
  const tokens = tokenSet(target);
  const isApi = intersects(tokens, API_TOKENS);
  const isWeb = intersects(tokens, WEB_TOKENS);
  return {
    api: isApi,
    web: isWeb || (!isApi && !isWeb && isHttpUrl(target.location)),
  };
}

/**
 * Diffs the current brief document against a previous version.
 *
 *   prev === null        → "no_baseline": single-version history (or no
 *                          usable predecessor); every fact stays null —
 *                          unknown, never zero. to_version is still set.
 *   non-diffable shape   → "unavailable": the mapped input is structurally
 *                          broken; facts stay null.
 *   otherwise            → "complete": every counter/flag is a real value.
 */
export function diffBriefDocuments(
  prev: ApiEngagementData | null,
  curr: ApiEngagementData,
  ids: { from_version: string | null; to_version: string | null },
): RadarSemanticDiff {
  const toVersion = ids.to_version ?? null;
  if (prev === null) {
    // No version was diffed — from_version is honestly null.
    return {
      status: "no_baseline",
      from_version: null,
      to_version: toVersion,
      ...NULL_FACTS,
    };
  }
  const fromVersion = ids.from_version ?? null;
  if (!isDiffable(curr) || !isDiffable(prev)) {
    return {
      status: "unavailable",
      from_version: fromVersion,
      to_version: toVersion,
      ...NULL_FACTS,
    };
  }

  const prevTargets = indexBy(prev.targets ?? [], targetKey);
  const currTargets = indexBy(curr.targets ?? [], targetKey);

  let added = 0;
  let removed = 0;
  let addedInScope = 0;
  let removedInScope = 0;
  let movedIn = 0;
  let movedOut = 0;
  let addedApi = 0;
  let addedWeb = 0;

  for (const [key, t] of currTargets) {
    const p = prevTargets.get(key);
    if (p === undefined) {
      added++;
      if (t.inScope === true) {
        addedInScope++;
        const surface = classifyTarget(t);
        if (surface.api) addedApi++;
        if (surface.web) addedWeb++;
      }
    } else if (p.inScope !== true && t.inScope === true) {
      movedIn++;
    } else if (p.inScope === true && t.inScope !== true) {
      movedOut++;
    }
  }
  for (const [key, t] of prevTargets) {
    if (!currTargets.has(key)) {
      removed++;
      if (t.inScope === true) removedInScope++;
    }
  }

  const prevGroups = indexBy(prev.targetGroups ?? [], groupKey);
  const currGroups = indexBy(curr.targetGroups ?? [], groupKey);

  let addedGroups = 0;
  for (const [key, g] of currGroups) {
    if (!prevGroups.has(key) && g.inScope === true) addedGroups++;
  }

  let rewardIncrease = false;
  let rewardDecrease = false;
  for (const [key, g] of currGroups) {
    const p = prevGroups.get(key);
    // Reward deltas only count on surface that is in-scope NOW.
    if (p === undefined || g.inScope !== true) continue;
    for (const tier of REWARD_TIERS) {
      const a = p.rewards?.[tier];
      const b = g.rewards?.[tier];
      if (
        typeof a === "number" &&
        Number.isFinite(a) &&
        typeof b === "number" &&
        Number.isFinite(b)
      ) {
        if (b > a) rewardIncrease = true;
        else if (b < a) rewardDecrease = true;
      }
      // null→x / x→null: data gap — neither a raise nor a cut.
    }
  }

  const safeHarborChanged =
    (prev.safeHarborLevel ?? null) !== (curr.safeHarborLevel ?? null);
  const statusChanged =
    (prev.lifecycleStatus ?? null) !== (curr.lifecycleStatus ?? null);

  const structuralZero =
    added === 0 &&
    removed === 0 &&
    addedInScope === 0 &&
    removedInScope === 0 &&
    movedIn === 0 &&
    movedOut === 0 &&
    addedApi === 0 &&
    addedWeb === 0 &&
    addedGroups === 0;
  const flagsQuiet =
    rewardIncrease !== true &&
    rewardDecrease !== true &&
    safeHarborChanged !== true &&
    statusChanged !== true;

  return {
    status: "complete",
    from_version: fromVersion,
    to_version: toVersion,
    added_targets: added,
    removed_targets: removed,
    added_in_scope_targets: addedInScope,
    removed_in_scope_targets: removedInScope,
    moved_in_scope: movedIn,
    moved_out_of_scope: movedOut,
    added_api_targets: addedApi,
    added_web_targets: addedWeb,
    added_groups: addedGroups,
    reward_increase: rewardIncrease,
    reward_decrease: rewardDecrease,
    safe_harbor_changed: safeHarborChanged,
    status_changed: statusChanged,
    only_administrative_changes: structuralZero && flagsQuiet,
  };
}

// ---------------------------------------------------------------------------
// opportunity_change — how much NEW hunting opportunity the latest publish
// opened, 0..1. null unless the diff completed (unknown ≠ zero).
//
//   s = min(1, 0.35·ai/(ai+3) + 0.30·api/(api+2) + 0.10·ag/(ag+1)
//            + 0.15·[reward_increase] + 0.10·mi/(mi+2))
//
// Design rationale (calibration anchors, monotone in every term):
// - added_in_scope_targets (0.35, half-saturation 3) is the headline: new
//   authorized surface. One target → 0.0875; a dozen → ~0.28. Never reaches
//   the weight alone — breadth needs numbers.
// - added_api_targets (0.30, half 2) is a multiplier-free BONUS on top of
//   the ai term: new API endpoints are the highest-value surface class
//   (authz/logic flaws, thinner researcher coverage), so a single new API
//   target outscores a single new web target 0.1875 vs 0.0875.
// - added_groups (0.10, half 1) is the coarsest structural signal — a new
//   in-scope group often means repackaged surface — so it weighs least.
// - reward_increase (0.15 flat) is a mild positive: richer tiers on EXISTING
//   surface matter but don't open new hunting ground.
// - moved_in_scope (0.10, half 2): newly-authorized surface that existed
//   before — real opportunity, but weaker than fresh adds.
// - Reductions (removed_*, moved_out_of_scope, reward_decrease) contribute
//   NOTHING: this signal measures opportunity gained, never penalizes
//   shrinkage — surface size is the other signals' job.
// - safe_harbor/status changes are facts for the UI, not score inputs.
// - Weights sum to exactly 1.00; min(1,·) binds only as every term
//   saturates. Text-only diffs short-circuit to 0 via
//   only_administrative_changes — the case this signal exists to expose.
// ---------------------------------------------------------------------------

export function opportunityChangeScore(
  diff: RadarSemanticDiff,
): number | null {
  if (diff.status !== "complete") return null;
  if (diff.only_administrative_changes === true) return 0;
  const ai = diff.added_in_scope_targets ?? 0;
  const api = diff.added_api_targets ?? 0;
  const ag = diff.added_groups ?? 0;
  const mi = diff.moved_in_scope ?? 0;
  const rewardUp = diff.reward_increase === true ? 1 : 0;
  const s = Math.min(
    1,
    0.35 * (ai / (ai + 3)) +
      0.3 * (api / (api + 2)) +
      0.1 * (ag / (ag + 1)) +
      0.15 * rewardUp +
      0.1 * (mi / (mi + 2)),
  );
  return Number(s.toFixed(4));
}
