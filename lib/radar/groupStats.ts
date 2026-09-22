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
//
// Contract stubs — Agent C lands the implementations (see
// docs/superpowers/plans/2026-09-23-radar-v1.5.md). Until then group stats
// read honestly unknown.
// ---------------------------------------------------------------------------

/** Aggregated VRT-category row (unique/total summed across groups). */
export interface GroupKiCategory {
  category: string;
  unique: number;
  total: number;
}

export type GroupStatsStatus = RadarGroupStats["status"];

/**
 * Parses one group's known_issue_stats response: the element whose `id`
 * equals `groupId` contributes its knownIssues.stats top-level rows
 * (children[] ignored — sub-breakdowns would double-count). Any structural
 * violation → null (the fetch layer maps null to "failed").
 */
export function parseGroupKiStats(
  raw: unknown,
  groupId: string,
): { categories: Map<string, { unique: number; total: number }> } | null {
  void raw;
  void groupId;
  return null;
}

/**
 * Fetches and aggregates per-group stats for `groupIds`. NEVER throws.
 * Every group must parse — a partial sample is never returned.
 */
export async function fetchGroupKiStats(
  slug: string,
  groupIds: readonly string[],
): Promise<{ status: GroupStatsStatus; categories: GroupKiCategory[] | null }> {
  void slug;
  void groupIds;
  return { status: "skipped_upstream", categories: null };
}

/**
 * Concentration of known-issue volume: top category's share of the total
 * (max(unique) / Σ unique over rows whose `unique` is known — persisted rows
 * may carry null). High = pressure concentrated in one VRT class — the rest
 * of the taxonomy is relatively unmined. null on empty input or a zero sum
 * (a complete stats payload contradicting a nonzero aggregate is unknown,
 * never 0).
 */
export function kiConcentrationScore(
  categories: readonly {
    category: string;
    unique: number | null;
    total: number | null;
  }[],
): number | null {
  void categories;
  return null;
}
