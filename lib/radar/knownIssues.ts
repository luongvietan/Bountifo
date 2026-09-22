import { siteRequest } from "../api/siteClient";
import { ApiError, type ApiErrorKind } from "../api/errors";
import type { RadarKnownIssueSummary } from "./deepTypes";

// ---------------------------------------------------------------------------
// Radar V1.3 — Known Issues data path + duplicate-pressure signal.
//
// SOURCE (verified live 2026-09-22, authenticated researcher session):
//
//   GET /engagements/<slug>/engagement_known_issues.json
//     → 200 application/json, body exactly {"unique":<int>,"total":<int>}
//
// `unique` counts distinct accepted known issues; `total` counts the same
// issues plus their duplicates. Per the brief panel, both counts exclude
// out-of-scope issues and span P1–P4 in Triaged/Unresolved/Informational
// states. A program with the feature off (or a dead session) answers
// 401/403/404 or a login redirect — that is "unavailable", not "zero".
//
// Sampled distribution (unique/total) — the calibration ground truth:
//   webdotcom 165/409, nubank 28/69, matlab-online 9/23, rapyd 69/343,
//   launchdarkly-mbb-og 44/590, hostgator-latam-bb 26/58,
//   openai-safety 90/224, asana 173/353, indeed 264/574, tesla 111/766,
//   binance 52/141.  unique spans 9–264; duplicate share (total−unique)/total
//   spans 0.51–0.93.
//
// This is a read-only analysis plane: nothing here authorizes anything, and
// Bugcrowd fields are DATA — parsed, never evaluated.
// ---------------------------------------------------------------------------

// Same per-program error classification as enrichment.ts: session-scoped
// failures degrade this item only.
//
//   unauthorized, forbidden, not_found           → "unavailable"
//   invalid_response, http, network,             → "failed"
//   rate_limited (and any client-only kind)
//   parse failure, non-ApiError plumbing bug     → "failed"
const UNAVAILABLE_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
]);

function failedSummary(): RadarKnownIssueSummary {
  return { status: "failed", unique_count: null, total_count: null };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Parses the engagement_known_issues aggregate body. The endpoint contract is
 * exactly {"unique":int,"total":int} with both fields non-negative integers —
 * anything else (absent body, markup, floats, negatives, missing keys) is
 * "failed" with NULL counts: unknown is never coerced into 0 ("no issues").
 *
 * Extra keys are tolerated — a strict-object rejection would turn a benign
 * upstream field addition into a data outage.
 *
 * `total < unique` still parses "complete": the counts are site data and are
 * kept verbatim. (Semantically total ≥ unique is expected since total folds
 * in duplicates, but a contradicting payload is the site's answer, not ours
 * to repair.)
 */
export function parseEngagementKnownIssues(
  raw: unknown,
): RadarKnownIssueSummary {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failedSummary();
  }
  const { unique, total } = raw as { unique?: unknown; total?: unknown };
  if (!isNonNegativeInt(unique) || !isNonNegativeInt(total)) {
    return failedSummary();
  }
  return {
    status: "complete",
    unique_count: unique,
    total_count: total,
  };
}

/**
 * Fetches the Known Issues summary for one engagement. NEVER throws — the
 * outcome rides on `status`, and counts are null unless status is
 * "complete". One GET per call; the caller (deep-enrichment stage) bounds
 * how many programs get this fetch.
 */
export async function fetchKnownIssueSummary(
  slug: string,
): Promise<RadarKnownIssueSummary> {
  try {
    const res = await siteRequest({
      operation: "GET_ENGAGEMENT_KNOWN_ISSUES",
      slug,
    });
    return parseEngagementKnownIssues(res.data);
  } catch (err) {
    const unavailable =
      err instanceof ApiError && UNAVAILABLE_KINDS.has(err.kind);
    return {
      status: unavailable ? "unavailable" : "failed",
      unique_count: null,
      total_count: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Duplicate-pressure proxy — "how saturated is this program's known-issue
// surface". This is deliberately NOT a duplicate-probability estimate:
// (total−unique)/total is a property of researcher traffic on already-found
// issues, so `total_count` is captured on the summary but NOT consumed here.
// The signal blends two saturations of `unique` (u):
//
//   density = W·sat(u; K_VOL) + W·sat(d; K_DEN),   sat(x;k) = x/(x+k),
//             d = u / meaningfulTargetCount
//
// — volume saturation: a program that has already surfaced many DISTINCT
//   issues is heavily mined regardless of scope size. K_VOL = 50 puts
//   half-saturation just under the sampled median unique (69) and spreads
//   the 11 observed programs over 0.15–0.84 with no pinned extremes.
//
// — per-target density: u is interpreted against the meaningful in-scope
//   surface. K_DEN = 5 makes "5 known issues per target" the half-saturation
//   point; realistic d values are single-digit (even indeed's 264 uniques
//   over a 40-target surface is d=6.6), so K_DEN = 10 would compress every
//   sampled program below ~0.57 and waste the term's 0.5 weight.
//
// Blend weights are equal (0.5/0.5): neither facet dominates, and both stay
// monotone nondecreasing in u, so the blend is too. Output ∈ [0,1), round4.
//
// Worked values at an assumed 30 meaningful in-scope targets:
//   matlab-online   u=9   → 0.1046      binance  u=52  → 0.3836
//   hostgator       u=26  → 0.2449      rapyd    u=69  → 0.4475
//   nubank          u=28  → 0.2581      openai   u=90  → 0.5089
//   launchdarkly    u=44  → 0.3474      tesla    u=111 → 0.5574
//                                   webdotcom   u=165 → 0.6456
//                                   asana      u=173 → 0.6557
//                                   indeed     u=264 → 0.7392
//
// Missing surface (`meaningfulTargetCount` null, non-finite, or < 1) falls
// back to the VOLUME-ONLY component rather than nulling the signal or
// dividing by max(t,1): a zero/absent surface paired with real issue counts
// is a data anomaly, and d = u/1 would pin the density term at ≈1 —
// fabricating confidence from a degenerate input. Volume-only keeps the
// honest half of the measurement at full weight.
// ---------------------------------------------------------------------------

const VOLUME_SATURATION_K = 50;
const PER_TARGET_DENSITY_K = 5;
const TERM_WEIGHT = 0.5;

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Duplicate-pressure proxy ∈ [0,1] — see the calibration block above.
 * Returns null when the summary did not complete or its counts are absent:
 * unknown stays unknown. Pure and deterministic — no clocks, no randomness.
 */
export function knownIssueDensity(
  summary: RadarKnownIssueSummary,
  meaningfulTargetCount: number | null,
): number | null {
  if (summary.status !== "complete") return null;
  const u = summary.unique_count;
  const total = summary.total_count;
  if (
    typeof u !== "number" ||
    !Number.isFinite(u) ||
    u < 0 ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    total < 0
  ) {
    return null;
  }
  if (u === 0) return 0;
  const volume = u / (u + VOLUME_SATURATION_K);
  if (
    meaningfulTargetCount === null ||
    !Number.isFinite(meaningfulTargetCount) ||
    meaningfulTargetCount < 1
  ) {
    return round4(volume);
  }
  const perTarget = u / meaningfulTargetCount;
  const densityTerm = perTarget / (perTarget + PER_TARGET_DENSITY_K);
  return round4(TERM_WEIGHT * volume + TERM_WEIGHT * densityTerm);
}
