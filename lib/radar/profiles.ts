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
 * V1.3 calibration — profiles touched by the deep-enrichment signals are
 * version "1.3.0": `known_issue_density` enters as a cost (duplicate
 * pressure) and `opportunity_change` as a benefit that out-weights raw
 * `freshness` where opportunity is the point of the profile. Untouched
 * profiles keep "1.1.0" — a version asserts the semantics, not a release
 * train. Do not retune without a version bump.
 *
 * Double-counting rule: `known_issue_density` is NOT also a component of
 * the `research_saturation` composite. The composite stays metadata-only
 * so catalog-wide (never deep-analyzed) programs remain comparable, and a
 * deep-analyzed program pays the cost exactly once — here, as a declared
 * profile weight.
 */
export const RADAR_PROFILES: Record<RadarProfileId, RadarProfile> = {
  /**
   * Balanced expected-value hunter: reward first, then surface, a moderate
   * cost weight on observed research saturation, and a light recency factor.
   * V1.3: `opportunity_change` (semantic scope movement) supersedes raw
   * `freshness` — a wording edit and a scope expansion used to look
   * identical — and `known_issue_density` prices duplicate pressure
   * alongside, not inside, the saturation composite so deep-analyzed
   * programs are never double-penalized.
   * V1.5: `payout_realized` adds realized payout evidence beside the
   * advertised ceiling; `scope_momentum` reads multi-publish scope growth
   * the single-step diff cannot see; `ki_concentration` is a benefit —
   * concentrated pressure means the rest of the taxonomy is unmined.
   */
  best_ev: {
    id: "best_ev",
    version: "1.5.0",
    label: "Best EV",
    weights: {
      reward_potential: 3,
      meaningful_surface: 2,
      freshness: 0.5,
      opportunity_change: 1.25,
      research_saturation: { weight: 1.5, direction: "cost" },
      known_issue_density: { weight: 1, direction: "cost" },
      api_surface: 1,
      web_surface: 1,
      reward_breadth: 1,
      rewarded_activity: 1,
      safe_harbor: 0.5,
      target_data_quality: 0.5,
      payout_realized: 0.5,
      scope_momentum: 1,
      ki_concentration: 0.75,
    },
    required_any: [
      ["research_saturation", "researcher_competition", "known_issue_density"],
    ],
    minConfidence: 0.6,
  },
  /**
   * Unsaturated-program hunter: dominant cost weights on the saturation
   * composite AND known-issue density (two independent duplicate-pressure
   * reads), with freshness and a small opportunity bonus. This is NOT a
   * duplicate-probability estimate — saturation is observed attention, not
   * proof that bugs are gone.
   * V1.5: `ki_concentration` joins as a BENEFIT — pressure concentrated in
   * one VRT class leaves the rest of the taxonomy unmined — and
   * `scope_momentum` keeps a genuinely expanding program competitive here.
   */
  low_competition: {
    id: "low_competition",
    version: "1.5.0",
    label: "Low Saturation",
    weights: {
      research_saturation: { weight: 3, direction: "cost" },
      known_issue_density: { weight: 2, direction: "cost" },
      freshness: 1.5,
      opportunity_change: 1,
      meaningful_surface: 1.5,
      reward_potential: 1,
      target_data_quality: 0.5,
      scope_momentum: 0.75,
      ki_concentration: 1,
    },
    required_any: [
      ["research_saturation", "researcher_competition", "known_issue_density"],
    ],
    minConfidence: 0.5,
  },
  /**
   * Payout hunter: ceiling (reward_potential) and breadth of reward-bearing
   * groups, with rewarded_activity as evidence the program actually pays.
   * V1.5: `payout_realized` (weight 2, second only to the ceiling) — the
   * measured average payout is the direct reading this profile exists for.
   */
  high_reward: {
    id: "high_reward",
    version: "1.5.0",
    label: "High Reward",
    weights: {
      reward_potential: 4,
      reward_breadth: 3,
      rewarded_activity: 1.5,
      target_data_quality: 0.5,
      payout_realized: 2,
    },
    required_any: [["reward_potential"]],
    minConfidence: 0.5,
  },
  /**
   * V1 meaning: "API-heavy / authenticated-research-friendly candidate" —
   * NOT a proven IDOR opportunity. API surface is measured two ways so a
   * lone API target cannot fake breadth: share (`api_surface`) and size
   * (`api_surface_size`, saturation over target count). The small cost
   * weight uses the saturation composite rather than raw crowding. V1.3
   * adds a small `opportunity_change` benefit — a diff that just added API
   * scope is exactly this profile's game. V1.4 adds `authz_opportunity`
   * (weight 2, after api_surface_size) — the brief-derived authz-surface
   * reading the profile was named for; while the contract stub keeps it
   * null it still contributes UNKNOWN_ coverage, not a score change.
   * V1.5: `scope_momentum` (0.75) — an arc that keeps adding API scope is
   * the profile's game over a longer window.
   */
  authz_api: {
    id: "authz_api",
    version: "1.5.0",
    label: "AuthZ/API",
    weights: {
      api_surface: 1.5,
      api_surface_size: 3,
      authz_opportunity: 2,
      meaningful_surface: 1.5,
      reward_potential: 1.5,
      freshness: 1,
      opportunity_change: 0.75,
      safe_harbor: 0.5,
      research_saturation: { weight: 0.5, direction: "cost" },
      scope_momentum: 0.75,
    },
    required_any: [["api_surface", "api_surface_size"]],
    minConfidence: 0.5,
  },
  /**
   * Opportunity hunter (V1.3 relabel — id `fresh_programs` is persisted so
   * it stays): `opportunity_change` slightly out-weights raw `freshness`
   * because a text-only diff must not read as a fresh opportunity; a light
   * saturation cost keeps a recently-updated-but-saturated program losing.
   * V1.5: `scope_momentum` (weight 2) — steady multi-publish growth is
   * exactly the fresh-opportunity shape this profile hunts.
   */
  fresh_programs: {
    id: "fresh_programs",
    version: "1.5.0",
    label: "Fresh Opportunity",
    weights: {
      freshness: 2.5,
      opportunity_change: 3,
      meaningful_surface: 1,
      research_saturation: { weight: 1, direction: "cost" },
      reward_potential: 0.5,
      scope_momentum: 2,
    },
    required_any: [["freshness", "opportunity_change"]],
    minConfidence: 0.4,
  },
  /**
   * Onboarding hunter. `accessibility` (weight 2, required_any) is sourced
   * in V1.4 from the brief's participation posture, credentials flag and
   * signup/friction markers — scores can leave `provisional`. While the
   * contract stub keeps the signal null the behavior is unchanged:
   * provisional, coverage capped at 6/8.
   * V1.5: untouched — no new signal is onboarding evidence; stays 1.4.0.
   */
  easy_entry: {
    id: "easy_entry",
    version: "1.4.0",
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
