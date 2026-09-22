import type { ApiEngagementData } from "../types";
import type { RadarCatalogItem, RadarSignal } from "./types";

// ---------------------------------------------------------------------------
// V1.4 `accessibility` signal — CONTRACT STUB.
//
// Agent A lands the sourced rubric (participation/lifecycle band + signup /
// credentials / friction markers in detail.briefText). Until then the signal
// keeps the V1 honest-null shape: unknown, never fabricated — identical to
// the `notAvailableV1()` placeholder it replaces in features.ts.
// ---------------------------------------------------------------------------

export function accessibilitySignal(
  detail: ApiEngagementData,
  catalog: RadarCatalogItem,
): RadarSignal {
  // Stub: parameters are the contract's declared sources, unused until the
  // rubric lands.
  void detail;
  void catalog;
  return { value: null, source: "derived", reason_code: "not_available_v1" };
}
