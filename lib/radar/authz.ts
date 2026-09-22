import {
  sentencesOf,
  statusOfSentence,
  techniqueMatches,
} from "../model/policyText";
import type { ApiEngagementData, PermissionStatus } from "../types";
import type { RadarSignal } from "./types";

// ---------------------------------------------------------------------------
// V1.4 `authz_opportunity` signal — sourced rubric (plan-pinned semantics).
//
// Two evidence halves, both from the brief document:
//
//   accountSurface ∈ {0,1} — the program hands the researcher an account to
//     test with: `credentialsProvided === true` (credentialsUrl present) or a
//     signup marker in briefText (SIGNUP_RE — deliberately the SAME regex as
//     accessibility.ts but NOT a shared module: the two rubrics must be free
//     to drift independently).
//
//   permScore ∈ {0, 0.5, 1, null} — the most conservative normative status
//     the brief asserts about authz-relevant techniques (AUTHZ_SLUGS below),
//     read through lib/model/policyText.ts sentence semantics:
//     prohibited > conditional > allowed. A bare topic mention with no
//     normative predicate (statusOfSentence → null) never counts — a program
//     that merely says "our platform uses multiple accounts" has not told us
//     anything about what may be tested.
//
//   value = round4(clamp01(0.5·accountSurface + 0.5·(permScore ?? 0.35)))
//
// Honesty rules (pinned):
//   - accountSurface 0 AND no authz-relevant status → null
//     ("no_authz_evidence") — unknown, never fabricated.
//   - permScore 0 (prohibited) → flat 0.1: a prohibition is a LOW reading of
//     opportunity, not an absence of one — the surface provably exists.
//   - permScore null with a real accountSurface contributes the conservative
//     0.35 midpoint for the permission half only — the surface evidence is
//     real, the policy silence is not read as either grant or ban.
//
// Pure and deterministic: no clock, no network, no randomness.
// ---------------------------------------------------------------------------

/** Spec §4.3 technique slugs whose status speaks to cross-account testing. */
const AUTHZ_SLUGS: ReadonlySet<string> = new Set([
  "multi-account",
  "cross-account-testing",
  "other-customer-data",
  "cross-tenant",
]);

// Same regex as accessibility.ts — duplicated per the pinned contract (do
// NOT extract a shared module).
const SIGNUP_RE =
  /@bugcrowdninja|\bsign[\s-]?up\b|\bself[\s-]?serve\b|\bcreate(?:d|s)?\s+(?:an?\s+|your\s+own\s+)accounts?\b|\bregister(?:ed|ing)?\s+(?:an?\s+|your\s+own\s+)accounts?\b/i;

// Pinned rubric constants — a prohibition reads 0.1 (low, not absent); an
// unknown permission posture contributes 0.35 to the permission half.
const PROHIBITED_VALUE = 0.1;
const UNKNOWN_PERM_SCORE = 0.35;

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sig(value: number | null, reasonCode: string): RadarSignal {
  return {
    value: value === null ? null : round4(value),
    source: "engagement_detail",
    reason_code: reasonCode,
  };
}

/**
 * Blends account surface (credentials/self-signup evidence) with the brief's
 * normative status on authz-relevant techniques. detail===null is handled by
 * the extractor's short-circuit — this function always sees a real detail.
 */
export function authzOpportunitySignal(
  detail: ApiEngagementData,
): RadarSignal {
  const briefText = detail.briefText ?? "";
  const accountSurface =
    detail.credentialsProvided === true || SIGNUP_RE.test(briefText) ? 1 : 0;

  // Only sentences that (a) name an authz-relevant technique AND (b) carry a
  // researcher-facing normative predicate feed permScore. Most conservative
  // wins: prohibited > conditional > allowed.
  const statuses: PermissionStatus[] = sentencesOf(briefText)
    .filter((s) => techniqueMatches(s).some((t) => AUTHZ_SLUGS.has(t.slug)))
    .map(statusOfSentence)
    .filter((s): s is PermissionStatus => s !== null);

  const permScore = statuses.includes("prohibited")
    ? 0
    : statuses.includes("conditional")
      ? 0.5
      : statuses.includes("allowed")
        ? 1
        : null;

  if (accountSurface === 0 && permScore === null) {
    return sig(null, "no_authz_evidence");
  }
  if (permScore === 0) {
    return sig(PROHIBITED_VALUE, "authz_surface_rubric");
  }
  return sig(
    clamp01(
      0.5 * accountSurface + 0.5 * (permScore ?? UNKNOWN_PERM_SCORE),
    ),
    "authz_surface_rubric",
  );
}
