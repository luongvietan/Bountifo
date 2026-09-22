import type { RadarFeatureKey, RadarProfileId } from "./types";

/**
 * A scoring profile — a named, versioned weight table over the radar signal
 * set.
 *
 * V1.1 weight semantics: every weight is NON-NEGATIVE; direction is declared
 * per signal. `"benefit"` (or the bare-number shorthand) contributes
 * `weight × signal`; `"cost"` contributes `weight × (1 − signal)`. A null
 * signal contributes nothing to either numerator or denominator — unknown
 * can never outrank a known-good value (the V1.0 signed-weight bug: a null
 * cost signal silently dropped its |weight| from the denominator, so a
 * program with unknown competition scored HIGHER than one with competition
 * provably at zero).
 *
 * `required_any` lists groups of alternative signals the profile considers
 * essential: a score is `provisional` when every alternative in a group is
 * null. Provisional rows still display — flagged, not hidden.
 *
 * `minConfidence` is the eligibility floor for ranked display.
 *
 * The key order inside each `weights` object is meaningful: components and
 * reason codes iterate the profile's declared order, so keep the pinned
 * declaration sequence.
 */
export type ProfileWeight =
  | number
  | { weight: number; direction: "benefit" | "cost" };

export interface RadarProfile {
  id: RadarProfileId;
  version: string;
  label: string;
  weights: Partial<Record<RadarFeatureKey, ProfileWeight>>;
  required_any?: RadarFeatureKey[][];
  minConfidence: number;
}

/**
 * V1.2 calibration — profiles touched by Research Saturation are version
 * "1.2.0" (cost weight moves from raw recent crowding to the composite
 * `research_saturation`; low_competition relabels to Low Saturation).
 * Untouched profiles keep "1.1.0" — a version asserts the semantics, not a
 * release train. Do not retune without a version bump.
 */
export const RADAR_PROFILES: Record<RadarProfileId, RadarProfile> = {
  /**
   * Balanced expected-value hunter: reward first, then surface, a moderate
   * cost weight on observed research saturation, and a light recency factor
   * (brief recency ≠ new opportunity — semantic diffing is not in V1). The
   * composite replaces raw researcher_competition so crowding evidence is
   * not double-counted.
   */
  best_ev: {
    id: "best_ev",
    version: "1.2.0",
    label: "Best EV",
    weights: {
      reward_potential: 3,
      meaningful_surface: 2,
      freshness: 0.75,
      research_saturation: { weight: 1.5, direction: "cost" },
      api_surface: 1,
      web_surface: 1,
      reward_breadth: 1,
      rewarded_activity: 1,
      safe_harbor: 0.5,
      target_data_quality: 0.5,
    },
    required_any: [
      ["research_saturation", "researcher_competition", "known_issue_density"],
    ],
    minConfidence: 0.6,
  },
  /**
   * Unsaturated-program hunter: dominant cost weight on the saturation
   * composite plus freshness and surface. This is NOT a
   * duplicate-probability estimate — saturation is observed attention, not
   * proof that bugs are gone.
   */
  low_competition: {
    id: "low_competition",
    version: "1.2.0",
    label: "Low Saturation",
    weights: {
      research_saturation: { weight: 3, direction: "cost" },
      freshness: 2,
      meaningful_surface: 1.5,
      reward_potential: 1,
      target_data_quality: 0.5,
    },
    required_any: [
      ["research_saturation", "researcher_competition", "known_issue_density"],
    ],
    minConfidence: 0.5,
  },
  /**
   * Payout hunter: ceiling (reward_potential) and breadth of reward-bearing
   * groups, with rewarded_activity as evidence the program actually pays.
   */
  high_reward: {
    id: "high_reward",
    version: "1.1.0",
    label: "High Reward",
    weights: {
      reward_potential: 4,
      reward_breadth: 3,
      rewarded_activity: 1.5,
      target_data_quality: 0.5,
    },
    required_any: [["reward_potential"]],
    minConfidence: 0.5,
  },
  /**
   * V1 meaning: "API-heavy / authenticated-research-friendly candidate" —
   * NOT a proven IDOR opportunity. `authz_opportunity` stays unweighted
   * because it is always null in V1 (no deterministic source exists until
   * deep program analysis lands). API surface is measured two ways so a
   * lone API target cannot fake breadth: share (`api_surface`) and size
   * (`api_surface_size`, saturation over target count). The small cost
   * weight uses the saturation composite rather than raw crowding.
   */
  authz_api: {
    id: "authz_api",
    version: "1.2.0",
    label: "AuthZ/API",
    weights: {
      api_surface: 1.5,
      api_surface_size: 3,
      meaningful_surface: 1.5,
      reward_potential: 1.5,
      freshness: 1,
      safe_harbor: 0.5,
      research_saturation: { weight: 0.5, direction: "cost" },
    },
    required_any: [["api_surface", "api_surface_size"]],
    minConfidence: 0.5,
  },
  /**
   * Recency hunter: freshness dominates; a light saturation cost replaces
   * raw crowding so a recently-updated-but-saturated program still loses.
   */
  fresh_programs: {
    id: "fresh_programs",
    version: "1.2.0",
    label: "Fresh Programs",
    weights: {
      freshness: 5,
      meaningful_surface: 1,
      research_saturation: { weight: 1, direction: "cost" },
      reward_potential: 0.5,
    },
    required_any: [["freshness"]],
    minConfidence: 0.4,
  },
  /**
   * Onboarding hunter. `accessibility` is always null in V1 (account/setup
   * requirements need deep analysis), so every score here is inherently
   * provisional and coverage is capped at 6/8 — that honesty is the plan's
   * intent, not a bug: an entry-friction claim must show it is partly
   * unknown.
   */
  easy_entry: {
    id: "easy_entry",
    version: "1.1.0",
    label: "Easy Entry",
    weights: {
      accessibility: 2,
      freshness: 1.5,
      reward_breadth: 1.5,
      safe_harbor: 1,
      meaningful_surface: 1,
      reward_potential: 1,
    },
    required_any: [["accessibility"]],
    minConfidence: 0.3,
  },
};

/** Returns the pinned profile for `id`. */
export function getRadarProfile(id: RadarProfileId): RadarProfile {
  return RADAR_PROFILES[id];
}
