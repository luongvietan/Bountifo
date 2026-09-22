// V1.3 CONTRACT STUB — replaced by Agent A at integration.
//
// The real module owns the Known Issues collector AND the density formula.
// This stub exists only so the Agent C feature-extractor wiring compiles on
// this branch; the coordinator merges Agent A's implementation over it.
//
// `extractProgramFeatures` calls this ONLY when `summary.status ===
// "complete"`, so this throw is unreachable on every path the contract
// permits — a reachable throw would itself be the bug to report.
import type { RadarKnownIssueSummary } from "./deepTypes";

/**
 * Known-issue density: the deep duplicate-pressure proxy in 0..1, or null
 * when a "complete" summary still lacks usable counts. Denominator is the
 * count of in-scope targets with usable identity (the same count
 * `meaningful_surface` saturates).
 */
export function knownIssueDensity(
  summary: RadarKnownIssueSummary,
  meaningfulTargetCount: number,
): number | null {
  void summary;
  void meaningfulTargetCount;
  throw new Error("unwired");
}
