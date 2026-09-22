import { siteRequest } from "../api/siteClient";
import type { RadarGroupStats } from "./deepTypes";

// ---------------------------------------------------------------------------
// V1.5 per-group Known Issues stats — the evidence behind `ki_concentration`.
//
// Endpoint (verified live 2026-09-22, see V1.3 plan §Verified evidence):
//   GET /engagements/<slug>/target_groups/<groupId>/known_issue_stats
//   → [{id, knownIssues:{stats:[{name, children[], uniqueCount,
//        duplicateCount}], totals:{unique,duplicate}}}]
//
// One request PER in-scope group, gated at the coordinator level
// (KI_GROUP_MIN_UNIQUE aggregate floor, KI_GROUP_MAX_GROUPS per-program cap).
// The fetch is all-or-nothing: a concentration computed over a subset of
// groups fabricates precision, so any group failure → status "failed",
// categories null.
// ---------------------------------------------------------------------------

/** Aggregated VRT-category row (unique/total summed across groups). */
export interface GroupKiCategory {
  category: string;
  unique: number;
  total: number;
}

export type GroupStatsStatus = RadarGroupStats["status"];

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses one group's known_issue_stats response: the element(s) whose `id`
 * strictly equals `groupId` contribute their knownIssues.stats top-level
 * rows. Every stats[] entry must carry a non-empty string `name` and
 * non-negative integer `uniqueCount`/`duplicateCount`; categories[name] =
 * {unique: uniqueCount, total: uniqueCount + duplicateCount}.
 *
 * Strictness doctrine (per plan):
 *   - raw must be an array, and at least one element must match — no
 *     implicit single-element match, no match → null.
 *   - only MATCHED elements are structurally validated: unrelated elements
 *     (other groups' rows, stray non-objects) are skipped untouched, the
 *     same way extra object keys are tolerated upstream.
 *   - children[] is IGNORED — sub-breakdowns re-count the parent's issues
 *     and would double-count. `totals` is likewise ignored: the aggregate is
 *     recomputed from stats[] rows, never trusted from the envelope.
 *   - any structural violation → null (the fetch layer maps null to
 *     "failed").
 */
export function parseGroupKiStats(
  raw: unknown,
  groupId: string,
): { categories: Map<string, { unique: number; total: number }> } | null {
  if (!Array.isArray(raw)) return null;
  const categories = new Map<string, { unique: number; total: number }>();
  let matched = false;
  for (const element of raw) {
    if (!isRecord(element) || element.id !== groupId) continue;
    matched = true;
    const knownIssues = element.knownIssues;
    if (!isRecord(knownIssues)) return null;
    const stats = knownIssues.stats;
    if (!Array.isArray(stats)) return null;
    for (const entry of stats) {
      if (!isRecord(entry)) return null;
      const { name, uniqueCount, duplicateCount } = entry;
      if (typeof name !== "string" || name.length === 0) return null;
      if (!isNonNegativeInt(uniqueCount) || !isNonNegativeInt(duplicateCount)) {
        return null;
      }
      const acc = categories.get(name) ?? { unique: 0, total: 0 };
      acc.unique += uniqueCount;
      acc.total += uniqueCount + duplicateCount;
      categories.set(name, acc);
    }
  }
  if (!matched) return null;
  return { categories };
}

/**
 * Fetches and aggregates per-group stats for `groupIds`. NEVER throws — the
 * outcome rides on `status`, and `categories` is null unless "complete".
 *
 * All-or-nothing: EVERY group must fetch and parse, else {status:"failed",
 * categories:null} — never a partial sample (concentration over a subset
 * fabricates precision). Per the plan pin, every non-complete outcome here
 * is "failed"; the unavailable/skipped_* enum states are emitted by the
 * coordinator's gate, not by this path.
 *
 * An empty `groupIds` is a complete fetch of nothing — {status:"complete",
 * categories:[]} — so the caller's gate owns the 1..KI_GROUP_MAX_GROUPS
 * decision.
 *
 * Aggregation sums unique/total across groups by category name and sorts
 * unique DESC then category ASC (code-unit order — locale-independent).
 * The order is canonical because the array enters source_hash.
 */
export async function fetchGroupKiStats(
  slug: string,
  groupIds: readonly string[],
): Promise<{ status: GroupStatsStatus; categories: GroupKiCategory[] | null }> {
  if (groupIds.length === 0) {
    return { status: "complete", categories: [] };
  }
  try {
    const responses = await Promise.all(
      groupIds.map((groupId) =>
        siteRequest({ operation: "GET_GROUP_KI_STATS", slug, groupId }),
      ),
    );
    const aggregate = new Map<string, { unique: number; total: number }>();
    for (const [index, res] of responses.entries()) {
      const parsed = parseGroupKiStats(res.data, groupIds[index]!);
      if (parsed === null) {
        return { status: "failed", categories: null };
      }
      for (const [name, counts] of parsed.categories) {
        const acc = aggregate.get(name);
        if (acc === undefined) {
          aggregate.set(name, { unique: counts.unique, total: counts.total });
        } else {
          acc.unique += counts.unique;
          acc.total += counts.total;
        }
      }
    }
    const categories: GroupKiCategory[] = [...aggregate.entries()]
      .map(([category, counts]) => ({
        category,
        unique: counts.unique,
        total: counts.total,
      }))
      .sort(
        (a, b) =>
          b.unique - a.unique ||
          (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
      );
    return { status: "complete", categories };
  } catch {
    return { status: "failed", categories: null };
  }
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Concentration of known-issue volume: top category's share of the total
 * (max(unique) / Σ unique over rows whose `unique` is a finite number —
 * persisted rows may carry null, and those rows are skipped). High =
 * pressure concentrated in one VRT class — the rest of the taxonomy is
 * relatively unmined. null on empty input or a non-positive sum (a complete
 * stats payload contradicting the nonzero aggregate that gated the fetch is
 * unknown, never 0). A share outside [0,1] means corrupt input — again an
 * honest null. Pure and deterministic.
 */
export function kiConcentrationScore(
  categories: readonly {
    category: string;
    unique: number | null;
    total: number | null;
  }[],
): number | null {
  let sum = 0;
  let max = 0;
  let seen = false;
  for (const row of categories) {
    const u = row.unique;
    if (typeof u !== "number" || !Number.isFinite(u)) continue;
    sum += u;
    if (u > max) max = u;
    seen = true;
  }
  if (!seen || sum <= 0) return null;
  const score = max / sum;
  if (!(score >= 0 && score <= 1)) return null;
  return round4(score);
}
