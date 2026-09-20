import type { PermissionFact } from "../types";

/**
 * Spec §12 conflict rollup for the policy block: counts facts whose conflict
 * was detected and remains unresolved. Conflicts never change collection
 * status — they only populate `policy.*`. Pure read; facts are never mutated.
 */
export function detectConflicts(facts: Record<string, PermissionFact>): {
  conflicts_present: boolean;
  unresolved_conflicts: number;
} {
  let unresolved = 0;
  for (const fact of Object.values(facts)) {
    if (fact.conflict.detected && fact.resolution?.status === "unresolved") {
      unresolved++;
    }
  }
  return {
    conflicts_present: unresolved > 0,
    unresolved_conflicts: unresolved,
  };
}
