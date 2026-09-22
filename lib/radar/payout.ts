import type { ApiEngagementData } from "../types";
import { normReward, parseStatValue } from "./curves";
import type { RadarSignal } from "./types";

// ---------------------------------------------------------------------------
// V1.5 `payout_realized` — realized payout evidence.
//
// statistics.average_payout is the program's REALIZED average payout — the
// measured counterpart to reward_potential's advertised tier ceiling. The
// FROZEN normReward curve (lib/radar/curves.ts) applies unchanged: an average
// payout of $2k reads 0.5, $25k reads 1.0. The stat's `window` is ignored
// deliberately — any window's average is payment evidence.
//
// Pure: no clocks, no I/O, no randomness. Absent/unparseable values read
// honestly null — never coerced, never fabricated. A parsed 0 is a REAL 0
// (normReward(0) = 0), not an unknown.
// ---------------------------------------------------------------------------

/** Same 4-decimal rounding convention as features.ts' sig(). */
function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function payoutRealizedSignal(detail: ApiEngagementData): RadarSignal {
  // `?? ""` narrows the absent-index `undefined` (noUncheckedIndexedAccess)
  // onto the same null path — parseStatValue rejects the empty string.
  const n = parseStatValue(detail.statistics?.average_payout?.value ?? "");
  return {
    value: n === null ? null : round4(normReward(n)),
    source: "statistics",
    reason_code: "average_payout_curve",
  };
}
