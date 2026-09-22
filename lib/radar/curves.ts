// ---------------------------------------------------------------------------
// Shared normalization curves + strict stat parsers — extracted from
// features.ts for V1.5 so sibling signal modules (payout.ts) can reuse the
// FROZEN reward curve without a module cycle. Pure: no clocks, no I/O, no
// randomness.
// ---------------------------------------------------------------------------

/** Reward normalization anchors: (usdAmount, normalizedValue). */
const REWARD_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [500, 0.25],
  [2000, 0.5],
  [10000, 0.8],
  [25000, 1],
];

// Piecewise interpolation runs in ln(1+amount) space, so anchors are
// precomputed in log space once.
const LOG_ANCHORS: ReadonlyArray<readonly [number, number]> =
  REWARD_ANCHORS.map(([amount, y]) => [Math.log(1 + amount), y]);

/**
 * Frozen V1 reward curve: piecewise-linear interpolation in ln(1+amount)
 * between anchors 0→0, 500→0.25, 2000→0.5, 10000→0.8, 25000→1.0. Values
 * ≤0 (incl. NaN) → 0; ≥25000 (incl. +∞) → 1.
 */
export function normReward(amount: number): number {
  if (!(amount > 0)) return 0;
  const top = REWARD_ANCHORS[REWARD_ANCHORS.length - 1]!;
  if (amount >= top[0]) return 1;
  const x = Math.log(1 + amount);
  for (let i = 0; i < LOG_ANCHORS.length - 1; i++) {
    const [x0, y0] = LOG_ANCHORS[i]!;
    const [x1, y1] = LOG_ANCHORS[i + 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return 1;
}

// "1,234" / "1234" with optional ".dec"; commas must be strict thousands
// separators (leading group 1–3 digits, then ",ddd" groups only).
const STAT_VALUE_RE = /^(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/;

/**
 * Strict parser for `statistics.*.value` strings. Accepts plain digits,
 * strict thousands grouping ("1,234", "1,234,567.89"), one optional leading
 * "$" ("$512.00") and surrounding whitespace. Rejects "1,23,4", empty,
 * negative-as-text, exponent or arbitrary text — never a bare parseFloat.
 */
export function parseStatValue(raw: string): number | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (!STAT_VALUE_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
