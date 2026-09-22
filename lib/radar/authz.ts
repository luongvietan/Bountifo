import type { ApiEngagementData } from "../types";
import type { RadarSignal } from "./types";

// ---------------------------------------------------------------------------
// V1.4 `authz_opportunity` signal — CONTRACT STUB.
//
// Agent B lands the sourced rubric (account surface from
// credentialsProvided/briefText signup markers × authz-relevant policy
// sentences via lib/model/policyText.ts). Until then the signal keeps the
// V1 honest-null shape: unknown, never fabricated — identical to the
// `notAvailableV1()` placeholder it replaces in features.ts.
// ---------------------------------------------------------------------------

export function authzOpportunitySignal(
  detail: ApiEngagementData,
): RadarSignal {
  void detail;
  return { value: null, source: "derived", reason_code: "not_available_v1" };
}
