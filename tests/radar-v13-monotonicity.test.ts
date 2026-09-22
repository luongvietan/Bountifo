import { describe, expect, it } from "vitest";
import type { RadarDeepEnrichment } from "../lib/radar/deepTypes";
import { extractProgramFeatures } from "../lib/radar/features";
import { RADAR_PROFILES, getRadarProfile } from "../lib/radar/profiles";
import { scoreProgram } from "../lib/radar/scoring";
import { RADAR_PROFILE_IDS } from "../lib/radar/types";
import type {
  ProgramFeatureVector,
  RadarFeatureKey,
  RadarProgramSnapshot,
  RadarSignal,
} from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.3 monotonicity + weight-calibration contract tests.
//
// Two deep signals land in V1.3:
//   * known_issue_density  — duplicate-pressure proxy (Known Issues volume
//                            relative to program surface). COST semantics:
//                            a denser program is more worked over, never a
//                            better pick under best_ev.
//   * opportunity_change   — semantic scope movement between brief versions.
//                            BENEFIT semantics: growth is new opportunity.
//
// DOUBLE-COUNT RULE (documented invariant): crowding/saturation evidence
// enters a profile's score ONCE. On this branch the research_saturation
// composite is {recent_crowding 0.30, submission_activity 0.40,
// rewarded_activity 0.30} (SATURATION_WEIGHTS in features.ts) and
// known_issue_density is a DECLARED-BUT-WEIGHTLESS component slot. Post-merge
// there are two honest wirings and one dishonest one:
//   a) ki joins the composite (saturation weight table gains a ki term), or
//   b) ki is scored standalone via a profile weight —
//   but NEVER both: a profile weighting research_saturation AND
//   known_issue_density while ki is a composite constituent counts the same
//   evidence twice. The "composite membership probe" below detects which
//   wiring landed behaviorally (does varying ki move research_saturation?)
//   and applies the matching constraint — it cannot know the merged table,
//   so it infers constituent status from extractor output.
//
// CONVENTION: "INTEGRATION ASSERTION" tests pin intended post-merge
// calibration and FAIL on this branch (signals unwired, best_ev still
// 1.2.0). That is expected — the coordinator runs them post-merge.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";
const NOW = "2026-09-21T12:00:00.000Z";

function detail(uuid: string): ApiEngagementData {
  return {
    uuid,
    name: `Program ${uuid}`,
    code: uuid,
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: T0,
    lastBriefUpdate: T0,
    safeHarborLevel: "full",
    statistics: {
      // All three saturation components known -> research_saturation forms.
      researchers_participating: { value: "50", window: "all_time" },
      vulnerabilities_rewarded: { value: "30", window: "90d" },
      valid_submission_count: { value: "120", window: "all_time" },
    },
    targetGroups: [
      {
        id: `g-${uuid}`,
        name: "Web",
        inScope: true,
        description: null,
        rewards: { p1: 5000, p2: 500, p3: 100, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: `t-${uuid}`,
        groupId: `g-${uuid}`,
        location: "https://a.example.com",
        name: "site",
        category: "website",
        tags: [],
        inScope: true,
      },
    ],
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: "2026-09-20",
  };
}

function ki(
  unique: number | null,
  total: number | null,
): NonNullable<RadarDeepEnrichment["known_issues"]> {
  return { status: "complete", unique_count: unique, total_count: total };
}

function semanticDiff(facts: {
  added?: number;
  rewardUp?: boolean;
  adminOnly?: boolean;
}): NonNullable<RadarDeepEnrichment["semantic_diff"]> {
  const added = facts.added ?? 0;
  return {
    status: "complete",
    from_version: "ver-old",
    to_version: "ver-1",
    added_targets: added,
    removed_targets: 0,
    added_in_scope_targets: added,
    removed_in_scope_targets: 0,
    moved_in_scope: 0,
    moved_out_of_scope: 0,
    added_api_targets: 0,
    added_web_targets: added,
    added_groups: 0,
    reward_increase: facts.rewardUp ?? false,
    reward_decrease: false,
    safe_harbor_changed: false,
    status_changed: false,
    only_administrative_changes: facts.adminOnly ?? added === 0,
  };
}

function snapshot(uuid: string, deep?: RadarDeepEnrichment): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid,
    code: uuid,
    catalog: {
      uuid,
      code: uuid,
      name: `Program ${uuid}`,
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: T0,
    },
    detail: detail(uuid),
    enrichment: { status: "complete" },
    ...(deep === undefined ? {} : { deep }),
    source_hash: `sha256:${"ab".repeat(32)}`,
  };
}

function sig(value: number | null): RadarSignal {
  return { value, source: "engagement_detail", reason_code: "test" };
}

/** Hand-built vector — scoreProgram reads vector[key].value only, so signal
 *  sweeps exercise the exact scoring math without needing the extractor's
 *  (currently unwired) deep formulas. */
function vector(
  values: Partial<Record<RadarFeatureKey, number | null>> = {},
): ProgramFeatureVector {
  const base = extractProgramFeatures(snapshot("u-vec"), NOW);
  const v = { ...base } as Record<RadarFeatureKey, RadarSignal> & {
    schema_version: 1;
  };
  for (const [key, val] of Object.entries(values)) {
    v[key as RadarFeatureKey] = sig(val);
  }
  return v;
}

const bestEv = () => getRadarProfile("best_ev");

// ---------------------------------------------------------------------------
// known_issue_density — cost semantics.
// ---------------------------------------------------------------------------

describe("known_issue_density signal contract", () => {
  it("is null for every non-complete KI status through extractProgramFeatures", () => {
    for (const status of ["unavailable", "failed"] as const) {
      const snap = snapshot("u-ki", {
        status: "partial",
        known_issues: { status, unique_count: null, total_count: null },
        semantic_diff: null,
      });
      const v = extractProgramFeatures(snap, NOW);
      expect(v.known_issue_density.value).toBeNull();
      expect(v.known_issue_density.reason_code).toBe(`ki_${status}`);
    }
  });

  it("best_ev score is nonincreasing as known_issue_density rises (signal-level)", () => {
    // Signal-contract sweep: whatever the merged formula, denser known
    // issues must never raise best_ev. On this branch the signal is
    // unweighted (flat is a trivial pass) — the STRICT end-to-end pin below
    // is what proves the weight landed post-merge.
    const p = bestEv();
    const snap = snapshot("u-ki-sweep");
    let prev = Infinity;
    for (const kiValue of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const s = scoreProgram(
        snap,
        vector({ known_issue_density: kiValue }),
        p,
      );
      expect(s.score!).toBeLessThanOrEqual(prev);
      prev = s.score!;
    }
  });

  it("INTEGRATION ASSERTION: end-to-end — heavier Known Issues score strictly lower (best_ev)", () => {
    // Two snapshots identical except the KI payload. Once wired (standalone
    // weight or composite constituent), the denser program must score
    // strictly lower. Fails today: both signals are null and scores tie.
    const p = bestEv();
    const quiet = snapshot("u-ki-low", {
      status: "complete",
      known_issues: ki(0, 0),
      semantic_diff: null,
    });
    const worked = snapshot("u-ki-high", {
      status: "complete",
      known_issues: ki(500, 1000),
      semantic_diff: null,
    });
    const sQuiet = scoreProgram(
      quiet,
      extractProgramFeatures(quiet, NOW),
      p,
    );
    const sWorked = scoreProgram(
      worked,
      extractProgramFeatures(worked, NOW),
      p,
    );
    expect(sQuiet.score).not.toBeNull();
    expect(sWorked.score).not.toBeNull();
    expect(sWorked.score!).toBeLessThan(sQuiet.score!);
  });
});

// ---------------------------------------------------------------------------
// opportunity_change — benefit semantics.
// ---------------------------------------------------------------------------

describe("opportunity_change signal contract", () => {
  it("best_ev score never decreases as opportunity_change rises 0 -> 1 (signal-level)", () => {
    const p = bestEv();
    const snap = snapshot("u-oc-sweep");
    let prev = -Infinity;
    for (const oc of [0, 0.25, 0.5, 0.75, 1]) {
      const s = scoreProgram(snap, vector({ opportunity_change: oc }), p);
      expect(s.score!).toBeGreaterThanOrEqual(prev);
      prev = s.score!;
    }
  });

  it("INTEGRATION ASSERTION: end-to-end — real scope growth scores strictly higher (best_ev)", () => {
    // no-op diff (only administrative edits) vs genuine growth. Fails today:
    // both read null while the seam is unwired.
    const p = bestEv();
    const flatSnap = snapshot("u-oc-flat", {
      status: "complete",
      known_issues: null,
      semantic_diff: semanticDiff({ added: 0, adminOnly: true }),
    });
    const growthSnap = snapshot("u-oc-growth", {
      status: "complete",
      known_issues: null,
      semantic_diff: semanticDiff({ added: 12, rewardUp: true }),
    });
    const flat = scoreProgram(
      flatSnap,
      extractProgramFeatures(flatSnap, NOW),
      p,
    );
    const growth = scoreProgram(
      growthSnap,
      extractProgramFeatures(growthSnap, NOW),
      p,
    );
    expect(growth.score!).toBeGreaterThan(flat.score!);
  });
});

// ---------------------------------------------------------------------------
// Profile calibration pins (V1.3.0) — all integration assertions.
// ---------------------------------------------------------------------------

describe("best_ev V1.3 calibration (INTEGRATION ASSERTIONS — red pre-merge)", () => {
  it("best_ev is versioned 1.3.0 once V1.3 weights land", () => {
    // A version asserts the semantics, not a release train — weighting two
    // new signals is a semantics change and demands the bump.
    expect(bestEv().version).toBe("1.3.0");
  });

  it("freshness carries strictly less weight than opportunity_change", () => {
    // The whole V1.3 point: brief-recency freshness rewards wording edits
    // indistinguishably; semantic opportunity_change is the only
    // recency-shaped input allowed to carry real EV weight (RADAR.md).
    const w = bestEv().weights;
    const freshnessW =
      typeof w.freshness === "number" ? w.freshness : w.freshness?.weight;
    const ocRaw = w.opportunity_change;
    const ocW = typeof ocRaw === "number" ? ocRaw : ocRaw?.weight;
    expect(ocW, "opportunity_change must be weighted").toBeDefined();
    expect(ocW!).toBeGreaterThan(0);
    expect(ocW!).toBeGreaterThan(freshnessW ?? 0);
    // opportunity_change is a benefit: growth is good.
    if (typeof ocRaw === "object") {
      expect(ocRaw.direction).toBe("benefit");
    }
  });

  it("known_issue_density is weighted as a cost (duplicate pressure)", () => {
    const w = bestEv().weights;
    const kiRaw = w.known_issue_density;
    expect(kiRaw, "known_issue_density must be weighted").toBeDefined();
    // Bare-number shorthand is benefit-only — a bare ki weight is the WRONG
    // sign for a duplicate-pressure signal, so it must be the object form.
    expect(typeof kiRaw).toBe("object");
    if (typeof kiRaw === "object") {
      expect(kiRaw.direction).toBe("cost");
      expect(kiRaw.weight).toBeGreaterThan(0);
    }
  });
});

describe("weight-shape invariants (hold pre- and post-merge)", () => {
  it("no profile weights researcher_competition alongside research_saturation", () => {
    // The composite replaced raw crowding in the score — co-weighting both
    // double-counts crowding evidence (pinned since V1.2; must survive V1.3).
    for (const id of RADAR_PROFILE_IDS) {
      const w = RADAR_PROFILES[id].weights;
      expect(
        w.researcher_competition !== undefined &&
          w.research_saturation !== undefined,
        `${id} co-weights researcher_competition + research_saturation`,
      ).toBe(false);
    }
  });

  it("wherever known_issue_density is weighted it is a cost; opportunity_change a benefit", () => {
    // Vacuously true today (unweighted); constrains every profile the merge
    // touches — the sign is the contract, the magnitude is calibration.
    for (const id of RADAR_PROFILE_IDS) {
      const w = RADAR_PROFILES[id].weights;
      const kiRaw = w.known_issue_density;
      if (kiRaw !== undefined) {
        expect(
          typeof kiRaw === "object" && kiRaw.direction === "cost",
          `${id}.known_issue_density must be declared cost`,
        ).toBe(true);
      }
      const ocRaw = w.opportunity_change;
      if (ocRaw !== undefined && typeof ocRaw === "object") {
        expect(
          ocRaw.direction,
          `${id}.opportunity_change must be benefit`,
        ).toBe("benefit");
      }
    }
  });

  it("composite-membership probe: KI evidence enters any score at most once", () => {
    // Behaviorally detect whether known_issue_density became a
    // research_saturation constituent: vary ONLY the KI payload across two
    // snapshots whose three current components are known, and watch whether
    // research_saturation moves.
    const lowKi = snapshot("u-probe-low", {
      status: "complete",
      known_issues: ki(0, 0),
      semantic_diff: null,
    });
    const highKi = snapshot("u-probe-high", {
      status: "complete",
      known_issues: ki(500, 1000),
      semantic_diff: null,
    });
    const satLow = extractProgramFeatures(lowKi, NOW).research_saturation.value;
    const satHigh = extractProgramFeatures(highKi, NOW).research_saturation.value;
    const kiIsConstituent = satLow !== satHigh;

    if (kiIsConstituent) {
      // ki evidence reaches the score through the composite — no profile may
      // also weight known_issue_density standalone (double count).
      for (const id of RADAR_PROFILE_IDS) {
        const w = RADAR_PROFILES[id].weights;
        expect(
          w.known_issue_density !== undefined &&
            w.research_saturation !== undefined,
          `${id} double-counts: weights research_saturation AND its ` +
            "constituent known_issue_density",
        ).toBe(false);
      }
    }
    // If ki is NOT a composite constituent, standalone weighting is the only
    // route and the co-weighting constraint does not apply. Either way the
    // invariant "evidence enters once" is enforced.
    expect(satLow === null || (satLow >= 0 && satLow <= 1)).toBe(true);
    expect(satHigh === null || (satHigh >= 0 && satHigh <= 1)).toBe(true);
  });
});
