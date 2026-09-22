import type { ApiEngagementData } from "../types";
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
// Contract stub — Agent A lands the implementation (see
// docs/superpowers/plans/2026-09-23-radar-v1.5.md). Until then the signal is
// honestly null: unknown, never coerced.
// ---------------------------------------------------------------------------

export function payoutRealizedSignal(detail: ApiEngagementData): RadarSignal {
  void detail;
  return {
    value: null,
    source: "statistics",
    reason_code: "average_payout_curve",
  };
}
