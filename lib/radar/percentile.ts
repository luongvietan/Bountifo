// ---------------------------------------------------------------------------
// V1.5 result-row percentile — catalog-relative rank context. Pure.
//
// A row's percentile is the share of the eligible cohort it outranks:
//   percentile = round1(100 · (E − pos) / E)
// where E is the cohort size and pos the row's 1-based position within it.
// Top of 279 → 99.6; the bottom eligible row → 0.0. Ineligible rows carry
// null — a percentile among rows that failed the confidence floor would be
// noise.
// ---------------------------------------------------------------------------

export function cohortPercentile(
  position: number,
  cohortSize: number,
): number {
  if (
    !Number.isInteger(position) ||
    !Number.isInteger(cohortSize) ||
    cohortSize < 1 ||
    position < 1 ||
    position > cohortSize
  ) {
    return 0;
  }
  return Number(((100 * (cohortSize - position)) / cohortSize).toFixed(1));
}
