import type { ApiEngagementData } from "../types";
import type {
  RadarCatalogItem,
  RadarSignal,
  RadarSignalSource,
} from "./types";

// ---------------------------------------------------------------------------
// V1.4 `accessibility` signal — how reachable is this program to a new
// researcher, judged ONLY from already-fetched metadata (zero new requests).
//
// Base band comes from the stated participation posture. `detail.participation`
// (the brief doc field) wins; when it is null the catalog row's accessStatus —
// `catalog.lifecycle_status` — is the fallback. The `??` chain is pinned
// verbatim: an empty-string participation is still a stated value, so it does
// NOT fall through to the catalog.
//   • contains "open"      → 0.8  (substring semantics — "reopened" counts)
//   • matches GATED_RE     → 0.2  (invite / application / approval / waitlist /
//                                  private / managed / closed family)
//   • any other non-empty  → 0.5  (a posture exists but is unclassified —
//                                  never null-by-accident)
//   • empty (neither source published anything)
//                          → null → "no_access_evidence", the honest unknown.
//
// Modifiers then read the normalized brief plaintext and the credentials flag:
//   +0.10  signup marker in briefText (SIGNUP_RE — @bugcrowdninja aliases,
//          "sign up", "self-serve", "create/register … account(s)")
//   +0.10  credentialsProvided === true — the brief ships test credentials;
//          null/false contribute nothing (absence is not evidence either way)
//   −0.20  friction marker in briefText (FRICTION_RE — VPN, IP whitelist,
//          NDA, identity verification, background check, citizenship)
//
// v = clamp01(round4(base + modifiers)) → "participation_access_rubric".
// Marker regexes apply to briefText only; GATED_RE applies to the
// participation string only — the two never cross fields.
// Pure and deterministic: no clock, no I/O, no randomness.
// ---------------------------------------------------------------------------

/** Self-serve signup markers in brief plaintext (case-insensitive). */
const SIGNUP_RE =
  /@bugcrowdninja|\bsign[\s-]?up\b|\bself[\s-]?serve\b|\bcreate(?:d|s)?\s+(?:an?\s+|your\s+own\s+)accounts?\b|\bregister(?:ed|ing)?\s+(?:an?\s+|your\s+own\s+)accounts?\b/i;

/** Access-friction markers in brief plaintext (case-insensitive). */
const FRICTION_RE =
  /\bvpn\b|ip[\s-]?whitelist|whitelist(?:ed|ing)?\s+ip|\bnda\b|non[\s-]?disclosure|identity\s+verification|background\s+check|citizenship\s+requirement/i;

/** Gated-participation family, matched against the participation string. */
const GATED_RE = /invite|application|approval|waitlist|private|managed|closed/i;

/**
 * True when the program's stated posture is gated/invitation-only — the
 * report-export restricted-access flag. Same precedence as the rubric:
 * `detail.participation` wins, catalog `lifecycle_status` is the fallback,
 * and a posture containing "open" ("reopened") is never gated. A program
 * with no stated posture is NOT flagged — absence is not evidence.
 */
export function isRestrictedAccess(
  detail: { participation: string | null } | null,
  catalog: { lifecycle_status: string | null } | null,
): boolean {
  const part = (
    detail?.participation ??
    catalog?.lifecycle_status ??
    ""
  ).toLowerCase();
  return !part.includes("open") && GATED_RE.test(part);
}

// Base bands — pinned V1.4 calibration. 0.8 leaves headroom for the two
// +0.10 bonuses to reach 1.0 on a fully self-serve open program; 0.2 can be
// softened by shipped credentials but never reach "open"; 0.5 is the honest
// midpoint for a stated posture we cannot classify.
const BASE_OPEN = 0.8;
const BASE_GATED = 0.2;
const BASE_STATED = 0.5;

// Modifier magnitudes — pinned: signup/credentials each +0.10, friction −0.20.
const SIGNUP_BONUS = 0.1;
const CREDENTIALS_BONUS = 0.1;
const FRICTION_PENALTY = 0.2;

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sig(
  value: number | null,
  source: RadarSignalSource,
  reasonCode: string,
): RadarSignal {
  return {
    value: value === null ? null : round4(value),
    source,
    reason_code: reasonCode,
  };
}

/**
 * Participation/credentials/friction rubric. `detail` is never null here —
 * extractProgramFeatures short-circuits the null-detail path before calling.
 */
export function accessibilitySignal(
  detail: ApiEngagementData,
  catalog: RadarCatalogItem,
): RadarSignal {
  const part = (
    detail.participation ??
    catalog.lifecycle_status ??
    ""
  ).toLowerCase();
  const base = part.includes("open")
    ? BASE_OPEN
    : GATED_RE.test(part)
      ? BASE_GATED
      : part !== ""
        ? BASE_STATED
        : null;
  if (base === null) {
    return sig(null, "engagement_detail", "no_access_evidence");
  }
  const brief = detail.briefText ?? "";
  const value = clamp01(
    round4(
      base +
        (SIGNUP_RE.test(brief) ? SIGNUP_BONUS : 0) +
        (detail.credentialsProvided === true ? CREDENTIALS_BONUS : 0) -
        (FRICTION_RE.test(brief) ? FRICTION_PENALTY : 0),
    ),
  );
  return sig(value, "engagement_detail", "participation_access_rubric");
}
