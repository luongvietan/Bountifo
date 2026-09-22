// V1.3 CONTRACT STUB — replaced by Agent B at integration.
//
// The real module owns the changelog semantic differ AND the opportunity
// score. This stub exists only so the Agent C feature-extractor wiring
// compiles on this branch; the coordinator merges Agent B's implementation
// over it.
//
// `extractProgramFeatures` calls this ONLY when `diff.status ===
// "complete"`, so this throw is unreachable on every path the contract
// permits — a reachable throw would itself be the bug to report.
import type { RadarSemanticDiff } from "./deepTypes";

/**
 * Semantic opportunity change: how much the latest brief diff expanded the
 * researchable opportunity, in 0..1 — or null when a "complete" diff still
 * cannot support a judgment. A text-only/administrative diff scores 0
 * (known, not null): freshness alone could never tell the two apart.
 */
export function opportunityChangeScore(diff: RadarSemanticDiff): number | null {
  void diff;
  throw new Error("unwired");
}
