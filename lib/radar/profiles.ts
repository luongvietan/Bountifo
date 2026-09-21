import type { RadarFeatureKey, RadarProfileId } from "./types";

/**
 * A scoring profile — a named, versioned weight table over the radar signal
 * set. Weights are SIGNED: a negative weight means "more of this signal is
 * worse" (researcher_competition). Signals absent from `weights` contribute
 * nothing. `minConfidence` is the eligibility floor for ranked display.
 *
 * The key order inside each `weights` object is meaningful: components and
 * reason codes iterate the profile's declared order, so keep the pinned
 * declaration sequence.
 */
export interface RadarProfile {
  id: RadarProfileId;
  version: string;
  label: string;
  weights: Partial<Record<RadarFeatureKey, number>>;
  minConfidence: number;
}

/**
 * Frozen V1 calibration — every profile is version "1.0.0". These weights are
 * the controller's pinned calibration; do not retune without a version bump.
 */
export const RADAR_PROFILES: Record<RadarProfileId, RadarProfile> = {
  /**
   * Balanced expected-value hunter: reward first, then surface, freshness,
   * and a moderate penalty for crowded programs.
   */
  best_ev: {
    id: "best_ev",
    version: "1.0.0",
    label: "Best EV",
    weights: {
      reward_potential: 3,
      meaningful_surface: 2,
      freshness: 1.5,
      researcher_competition: -1.5,
      api_surface: 1,
      web_surface: 1,
      reward_breadth: 1,
      rewarded_activity: 1,
      safe_harbor: 0.5,
      target_data_quality: 0.5,
    },
    minConfidence: 0.6,
  },
  /**
   * Uncrowded-program hunter: dominant negative weight on competition plus
   * freshness and surface. This is NOT a duplicate-probability estimate —
   * researcher_competition is only a participation proxy.
   */
  low_competition: {
    id: "low_competition",
    version: "1.0.0",
    label: "Low Competition",
    weights: {
      researcher_competition: -3,
      freshness: 2,
      meaningful_surface: 1.5,
      reward_potential: 1,
      target_data_quality: 0.5,
    },
    minConfidence: 0.5,
  },
  /**
   * Payout hunter: ceiling (reward_potential) and breadth of reward-bearing
   * groups, with rewarded_activity as evidence the program actually pays.
   */
  high_reward: {
    id: "high_reward",
    version: "1.0.0",
    label: "High Reward",
    weights: {
      reward_potential: 4,
      reward_breadth: 3,
      rewarded_activity: 1.5,
      target_data_quality: 0.5,
    },
    minConfidence: 0.5,
  },
  /**
   * V1 meaning: "API-heavy / authenticated-research-friendly candidate" —
   * NOT a proven IDOR opportunity. `authz_opportunity` stays unweighted
   * because it is always null in V1 (no deterministic source exists until
   * deep program analysis lands).
   */
  authz_api: {
    id: "authz_api",
    version: "1.0.0",
    label: "AuthZ/API",
    weights: {
      api_surface: 4,
      meaningful_surface: 1.5,
      reward_potential: 1.5,
      freshness: 1,
      safe_harbor: 0.5,
      researcher_competition: -0.5,
    },
    minConfidence: 0.5,
  },
  /**
   * Recency hunter: freshness dominates; the rest is a light sanity floor.
   */
  fresh_programs: {
    id: "fresh_programs",
    version: "1.0.0",
    label: "Fresh Programs",
    weights: {
      freshness: 5,
      meaningful_surface: 1,
      researcher_competition: -1,
      reward_potential: 0.5,
    },
    minConfidence: 0.4,
  },
  /**
   * Onboarding hunter. `accessibility` is always null in V1 (account/setup
   * requirements need deep analysis), so confidence is visibly reduced —
   * max achievable is 6/8 = 0.75. That reduction is the plan's intent, not
   * a bug: an entry-friction claim must show it is partly unknown.
   */
  easy_entry: {
    id: "easy_entry",
    version: "1.0.0",
    label: "Easy Entry",
    weights: {
      accessibility: 2,
      freshness: 1.5,
      reward_breadth: 1.5,
      safe_harbor: 1,
      meaningful_surface: 1,
      reward_potential: 1,
    },
    minConfidence: 0.3,
  },
};

/** Returns the pinned V1 profile for `id`. */
export function getRadarProfile(id: RadarProfileId): RadarProfile {
  return RADAR_PROFILES[id];
}
