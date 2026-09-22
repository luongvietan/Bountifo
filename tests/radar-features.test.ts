import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractProgramFeatures,
  normReward,
  parseStatValue,
} from "../lib/radar/features";
import { opportunityChangeScore } from "../lib/radar/diff";
import { knownIssueDensity } from "../lib/radar/knownIssues";
import type {
  RadarDeepEnrichment,
  RadarKnownIssueSummary,
  RadarSemanticDiff,
} from "../lib/radar/deepTypes";
import {
  programFeatureVectorSchema,
  RADAR_FEATURE_KEYS,
} from "../lib/radar/types";
import type {
  ApiEngagementData,
  ApiTarget,
  ApiTargetGroup,
} from "../lib/types";
import type { RadarProgramSnapshot } from "../lib/radar/types";

// ---------------------------------------------------------------------------
// The V1.3 seam modules (lib/radar/knownIssues.ts = Agent A, lib/radar/diff.ts
// = Agent B) are contract stubs on this branch — they throw if reached.
// Deterministic fakes substitute for them so the COMPLETE-path wiring is
// exercised for real and stays exercised after the genuine formulas land.
// The fakes must be shape-compatible only: feature extraction owns status
// dispatch + rounding + source/reason honesty, the seams own the numbers.
// ---------------------------------------------------------------------------
vi.mock("../lib/radar/knownIssues", () => ({
  // Density saturates unique issues against the meaningful-target
  // denominator; null count or empty denominator → null (still honest).
  knownIssueDensity: vi.fn(
    (
      summary: { unique_count: number | null },
      meaningfulTargetCount: number,
    ): number | null =>
      summary.unique_count === null || meaningfulTargetCount <= 0
        ? null
        : summary.unique_count /
          (summary.unique_count + meaningfulTargetCount),
  ),
}));

vi.mock("../lib/radar/diff", () => ({
  // 0 for an administrative-only diff (the text-only case), otherwise
  // saturates on in-scope/API additions — enough to distinguish
  // "analyzed, nothing grew" from "scope expanded".
  opportunityChangeScore: vi.fn(
    (diff: {
      added_in_scope_targets: number | null;
      added_api_targets: number | null;
      only_administrative_changes: boolean | null;
    }): number | null =>
      diff.only_administrative_changes === true
        ? 0
        : Math.min(
            1,
            ((diff.added_in_scope_targets ?? 0) +
              (diff.added_api_targets ?? 0)) /
              4,
          ),
  ),
}));

const kiDensityMock = vi.mocked(knownIssueDensity);
const oppChangeMock = vi.mocked(opportunityChangeScore);

// Fixed reference time — freshness bands are calibrated against this and
// tests never touch the wall clock.
const NOW = "2026-09-21T00:00:00.000Z";
const DAY_MS = 86_400_000;

/** ISO string `days` before the fixed NOW (fractional days allowed). */
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

function target(overrides: Partial<ApiTarget> = {}): ApiTarget {
  return {
    id: "t1",
    groupId: null,
    location: null,
    name: null,
    category: null,
    tags: [],
    inScope: true,
    ...overrides,
  };
}

function group(overrides: Partial<ApiTargetGroup> = {}): ApiTargetGroup {
  return {
    id: "g1",
    name: "G",
    inScope: true,
    description: null,
    rewards: { p1: null, p2: null, p3: null, p4: null, p5: null },
    ...overrides,
  };
}

function rewards(p: Partial<ApiTargetGroup["rewards"]>): ApiTargetGroup["rewards"] {
  return { p1: null, p2: null, p3: null, p4: null, p5: null, ...p };
}

function detail(overrides: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "uuid-1",
    name: "Acme",
    code: "acme",
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: null,
    lastBriefUpdate: null,
    safeHarborLevel: null,
    statistics: {},
    targetGroups: [],
    targets: [],
    observedApiVersion: null,
    ...overrides,
  };
}

function snapshot(
  detailValue: ApiEngagementData | null,
  deep?: RadarDeepEnrichment | null,
): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: "uuid-1",
    code: "acme",
    catalog: {
      uuid: "uuid-1",
      code: "acme",
      name: "Acme",
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: "2026-09-01T00:00:00.000Z",
    },
    detail: detailValue,
    enrichment:
      detailValue === null
        ? { status: "failed", error_kind: "http" }
        : { status: "complete" },
    // `deep` omitted entirely when undefined — absent and null are distinct
    // contract shapes and tests exercise both.
    ...(deep === undefined ? {} : { deep }),
    source_hash: `sha256:${"0".repeat(64)}`,
  };
}

/** Deep payload builders — every fact field must be explicit (strict). */
function kiSummary(
  overrides: Partial<RadarKnownIssueSummary> = {},
): RadarKnownIssueSummary {
  return {
    status: "complete",
    unique_count: 4,
    total_count: 10,
    ...overrides,
  };
}

function semanticDiff(
  overrides: Partial<RadarSemanticDiff> = {},
): RadarSemanticDiff {
  return {
    status: "complete",
    from_version: "v-prev",
    to_version: "v-cur",
    added_targets: 0,
    removed_targets: 0,
    added_in_scope_targets: 0,
    removed_in_scope_targets: 0,
    moved_in_scope: 0,
    moved_out_of_scope: 0,
    added_api_targets: 0,
    added_web_targets: 0,
    added_groups: 0,
    reward_increase: false,
    reward_decrease: false,
    safe_harbor_changed: false,
    status_changed: false,
    only_administrative_changes: true,
    ...overrides,
  };
}

function vector(d: ApiEngagementData | null, now: string = NOW) {
  return extractProgramFeatures(snapshot(d), now);
}

describe("normReward frozen curve", () => {
  it("hits every anchor exactly", () => {
    expect(normReward(0)).toBe(0);
    expect(normReward(500)).toBe(0.25);
    expect(normReward(2000)).toBe(0.5);
    expect(normReward(10000)).toBe(0.8);
    expect(normReward(25000)).toBe(1);
  });

  it("clamps outside the anchor range", () => {
    expect(normReward(-100)).toBe(0);
    expect(normReward(50000)).toBe(1);
    expect(normReward(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normReward(Number.NaN)).toBe(0);
  });

  it("interpolates monotonically in ln(1+amount) space", () => {
    const mid = normReward(1000);
    expect(mid).toBeGreaterThan(0.25);
    expect(mid).toBeLessThan(0.5);
    // log-space: 1000 sits almost halfway between 500 and 2000 in ln terms
    // ln(501)=6.2166, ln(1001)=6.9088, ln(2001)=7.6019 → ~0.3749
    expect(mid).toBeCloseTo(0.3749, 3);
    expect(normReward(750)).toBeLessThan(normReward(1500));
    expect(normReward(1500)).toBeLessThan(normReward(5000));
  });
});

describe("parseStatValue strict parser", () => {
  it.each([
    ["1,234", 1234],
    ["$512.00", 512],
    ["321", 321],
    ["0", 0],
    ["1,234,567.89", 1234567.89],
    ["$1,000", 1000],
    ["42.5", 42.5],
    ["  77  ", 77],
    ["1234567", 1234567],
  ])("accepts %j → %d", (raw, expected) => {
    expect(parseStatValue(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "abc",
    "N/A",
    "1,23,4",
    "1,234,56",
    "12,34",
    "1,2345",
    "-5",
    "$-5",
    "$",
    "1.2.3",
    ".5",
    "5.",
    "1e3",
    "1 234",
    "1,234.56.7",
  ])("rejects %j", (raw) => {
    expect(parseStatValue(raw)).toBeNull();
  });
});

describe("reward_potential", () => {
  it("blends all three present tiers with frozen weights", () => {
    const v = vector(
      detail({
        targetGroups: [
          group({ rewards: rewards({ p1: 2000, p2: 500, p3: 25000 }) }),
        ],
      }),
    );
    // 0.5*norm(2000) + 0.3*norm(500) + 0.2*norm(25000)
    // = 0.5*0.5 + 0.3*0.25 + 0.2*1.0 = 0.525
    expect(v.reward_potential).toEqual({
      value: 0.525,
      source: "engagement_detail",
      reason_code: "reward_curve_p1_p2_p3",
    });
  });

  it("renormalizes weights over present tiers only", () => {
    // Only P1 present → weight 0.5/0.5 = 1 → plain norm(maxP1).
    const onlyP1 = vector(
      detail({ targetGroups: [group({ rewards: rewards({ p1: 2000 }) })] }),
    );
    expect(onlyP1.reward_potential.value).toBe(0.5);

    // P1 + P3 present → (0.5*0.5 + 0.2*0.8) / 0.7 = 0.585714… → 0.5857
    const p1p3 = vector(
      detail({
        targetGroups: [
          group({ rewards: rewards({ p1: 2000, p3: 10000 }) }),
        ],
      }),
    );
    expect(p1p3.reward_potential.value).toBe(0.5857);

    // P2 + P3 present → (0.3*norm(500) + 0.2*norm(25000)) / 0.5
    // = (0.3*0.25 + 0.2*1) / 0.5 = 0.275/0.5 = 0.55
    const p2p3 = vector(
      detail({
        targetGroups: [
          group({ rewards: rewards({ p2: 500, p3: 25000 }) }),
        ],
      }),
    );
    expect(p2p3.reward_potential.value).toBe(0.55);
  });

  it("takes the per-tier max across in-scope groups", () => {
    const v = vector(
      detail({
        targetGroups: [
          group({ id: "g1", rewards: rewards({ p1: 500 }) }),
          group({ id: "g2", rewards: rewards({ p1: 2000 }) }),
        ],
      }),
    );
    expect(v.reward_potential.value).toBe(0.5); // max 2000 → 0.5
  });

  it("ignores out-of-scope groups entirely", () => {
    const v = vector(
      detail({
        targetGroups: [
          group({ id: "g1", inScope: false, rewards: rewards({ p1: 25000 }) }),
          group({ id: "g2", inScope: true, rewards: rewards({ p1: 500 }) }),
        ],
      }),
    );
    expect(v.reward_potential.value).toBe(0.25);
  });

  it("is null when no in-scope group carries any P1/P2/P3", () => {
    for (const groups of [
      [],
      [group()],
      [group({ inScope: false, rewards: rewards({ p1: 25000 }) })],
      [group({ rewards: rewards({ p4: 9000, p5: 9000 }) })],
    ]) {
      const v = vector(detail({ targetGroups: groups }));
      expect(v.reward_potential.value).toBeNull();
      expect(v.reward_potential.reason_code).toBe("reward_curve_p1_p2_p3");
    }
  });
});

describe("reward_breadth", () => {
  it("is the fraction of in-scope groups with ≥1 non-null positive reward", () => {
    const v = vector(
      detail({
        targetGroups: [
          group({ id: "g1", rewards: rewards({ p3: 100 }) }),
          group({ id: "g2" }),
          group({ id: "g3", rewards: rewards({ p5: 50 }) }),
          group({ id: "g4", inScope: false, rewards: rewards({ p1: 1 }) }),
        ],
      }),
    );
    // g1 + g3 bear rewards; g4 is out of scope → 2/3
    expect(v.reward_breadth).toEqual({
      value: 0.6667,
      source: "engagement_detail",
      reason_code: "reward_bearing_group_share",
    });
  });

  it("does not count a group whose only rewards are zero", () => {
    const v = vector(
      detail({
        targetGroups: [
          group({ id: "g1", rewards: rewards({ p1: 0 }) }),
          group({ id: "g2", rewards: rewards({ p2: 10 }) }),
        ],
      }),
    );
    expect(v.reward_breadth.value).toBe(0.5);
  });

  it("is null when there are no in-scope groups", () => {
    for (const groups of [[], [group({ inScope: false })]]) {
      const v = vector(detail({ targetGroups: groups }));
      expect(v.reward_breadth.value).toBeNull();
      expect(v.reward_breadth.reason_code).toBe("reward_bearing_group_share");
    }
  });
});

describe("meaningful_surface", () => {
  it("saturates as c/(c+25) over in-scope targets with usable identity", () => {
    const usable = (id: string) => target({ id, location: "https://a.example" });
    for (const [count, expected] of [
      [0, 0],
      [1, 0.0385], // 1/26
      [5, 0.1667], // 5/30
      [25, 0.5], // 25/50
      [75, 0.75], // 75/100
    ] as const) {
      const v = vector(
        detail({ targets: Array.from({ length: count }, (_, i) => usable(`t${i}`)) }),
      );
      expect(v.meaningful_surface).toEqual({
        value: expected,
        source: "engagement_detail",
        reason_code: "in_scope_target_saturation",
      });
    }
  });

  it("counts non-empty name as usable identity and skips blank identity", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", name: "Admin panel" }), // usable via name
          target({ id: "t2", location: "  ", name: "" }), // blank identity
          target({ id: "t3" }), // null identity
          target({ id: "t4", location: "https://x", inScope: false }), // out
        ],
      }),
    );
    expect(v.meaningful_surface.value).toBe(0.0385); // c=1 → 1/26
  });

  it("is 0 (not null) when detail is present but nothing is in scope", () => {
    const v = vector(
      detail({ targets: [target({ inScope: false, location: "https://a" })] }),
    );
    expect(v.meaningful_surface.value).toBe(0);
  });
});

describe("api_surface / web_surface token classification", () => {
  it("classifies by token-set intersection over category/tags/name", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", category: "api" }), // api
          target({ id: "t2", name: "GraphQL Endpoint" }), // api (2 tokens)
          target({ id: "t3", category: "website" }), // web
          target({ id: "t4", tags: ["Web-App"] }), // web via split token
        ],
      }),
    );
    expect(v.api_surface).toEqual({
      value: 0.5,
      source: "engagement_detail",
      reason_code: "api_token_share",
    });
    expect(v.web_surface).toEqual({
      value: 0.5,
      source: "engagement_detail",
      reason_code: "web_token_share",
    });
  });

  it("is substring-trap safe: capitol ≠ api, restaurant ≠ rest", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", name: "capitol" }),
          target({ id: "t2", category: "restaurant" }),
          target({ id: "t3", name: "graphene", location: "capitol Hill" }),
        ],
      }),
    );
    expect(v.api_surface.value).toBe(0);
    expect(v.web_surface.value).toBe(0);
  });

  it("counts an unmatched target with http(s) location toward web_surface", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", category: "other", location: "https://x.example" }),
          target({ id: "t2", category: "other", location: "http://y.example" }),
          target({ id: "t3", category: "other", location: "ftp://z.example" }),
          target({ id: "t4", category: "other", location: "bare.example.com" }),
          target({ id: "t5", category: "api", location: "https://a.example" }),
        ],
      }),
    );
    // t5 matches api tokens — no web fallback for it.
    expect(v.api_surface.value).toBe(0.2); // 1/5
    expect(v.web_surface.value).toBe(0.4); // t1+t2 /5
  });

  it("lets a dual-token target count toward both surfaces", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", name: "web api" }),
          target({ id: "t2", category: "website" }),
        ],
      }),
    );
    expect(v.api_surface.value).toBe(0.5);
    expect(v.web_surface.value).toBe(1);
  });

  it("is 0/0 (not null) when no targets are in scope", () => {
    const v = vector(
      detail({ targets: [target({ inScope: false, category: "api" })] }),
    );
    expect(v.api_surface.value).toBe(0);
    expect(v.web_surface.value).toBe(0);
  });
});

describe("api_surface_size — count saturation, split from share", () => {
  it("saturates api target count as c/(c+10)", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", category: "api" }),
          target({ id: "t2", category: "api" }),
          target({ id: "t3", category: "website" }),
          target({ id: "t4", category: "website" }),
        ],
      }),
    );
    // 2 api / 4 total → share 0.5; size 2/12 = 0.1667.
    expect(v.api_surface.value).toBe(0.5);
    expect(v.api_surface_size).toEqual({
      value: 0.1667,
      source: "engagement_detail",
      reason_code: "api_target_saturation",
    });
  });

  it("a single api target cannot fake a large surface", () => {
    const v = vector(
      detail({ targets: [target({ id: "t1", category: "api" })] }),
    );
    expect(v.api_surface.value).toBe(1); // 100% share…
    expect(v.api_surface_size.value).toBe(0.0909); // …but 1/11 size
  });

  it("20 api targets out of 50 → modest share, large size", () => {
    const targets = [
      ...Array.from({ length: 20 }, (_, i) =>
        target({ id: `a${i}`, category: "api" }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        target({ id: `w${i}`, category: "website" }),
      ),
    ];
    const v = vector(detail({ targets }));
    expect(v.api_surface.value).toBe(0.4);
    expect(v.api_surface_size.value).toBe(0.6667); // 20/30
  });

  it("is 0 (not null) when no targets are in scope", () => {
    const v = vector(
      detail({ targets: [target({ inScope: false, category: "api" })] }),
    );
    expect(v.api_surface_size.value).toBe(0);
  });

  it("ignores out-of-scope targets", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", category: "api", inScope: false }),
          target({ id: "t2", category: "website" }),
        ],
      }),
    );
    expect(v.api_surface.value).toBe(0);
    expect(v.web_surface.value).toBe(1);
  });
});

describe("researcher_competition / rewarded_activity", () => {
  it("saturates researchers_participating as n/(n+500)", () => {
    const v = vector(
      detail({
        statistics: {
          researchers_participating: { value: "500", window: null },
        },
      }),
    );
    expect(v.researcher_competition).toEqual({
      value: 0.5,
      source: "statistics",
      reason_code: "researchers_participating_saturation",
    });
  });

  it("parses grouped/currency stat values and rounds to 4 decimals", () => {
    const v = vector(
      detail({
        statistics: {
          researchers_participating: { value: "1,000", window: "90d" },
          vulnerabilities_rewarded: { value: "$333.00", window: null },
        },
      }),
    );
    expect(v.researcher_competition.value).toBe(0.6667); // 1000/1500
    expect(v.rewarded_activity.value).toBe(0.6248); // 333/533 = 0.62476…
  });

  it("saturates vulnerabilities_rewarded as n/(n+200)", () => {
    const v = vector(
      detail({
        statistics: {
          vulnerabilities_rewarded: { value: "200", window: null },
        },
      }),
    );
    expect(v.rewarded_activity).toEqual({
      value: 0.5,
      source: "statistics",
      reason_code: "vulnerabilities_rewarded_saturation",
    });
  });

  it("is null on missing or unparseable statistics", () => {
    const missing = vector(detail({ statistics: {} }));
    expect(missing.researcher_competition.value).toBeNull();
    expect(missing.researcher_competition.reason_code).toBe(
      "researchers_participating_saturation",
    );
    expect(missing.rewarded_activity.value).toBeNull();
    expect(missing.rewarded_activity.reason_code).toBe(
      "vulnerabilities_rewarded_saturation",
    );

    const garbage = vector(
      detail({
        statistics: {
          researchers_participating: { value: "lots", window: null },
          vulnerabilities_rewarded: { value: "1,23,4", window: null },
        },
      }),
    );
    expect(garbage.researcher_competition.value).toBeNull();
    expect(garbage.rewarded_activity.value).toBeNull();
  });

  it("does not feed average_payout into any V1 signal", () => {
    const v = vector(
      detail({ statistics: { average_payout: { value: "99999", window: null } } }),
    );
    expect(v.rewarded_activity.value).toBeNull();
    expect(v.researcher_competition.value).toBeNull();
  });
});

describe("submission_activity", () => {
  it("saturates valid_submission_count as n/(n+500)", () => {
    const v = vector(
      detail({
        statistics: {
          valid_submission_count: { value: "500", window: null },
        },
      }),
    );
    expect(v.submission_activity).toEqual({
      value: 0.5,
      source: "statistics",
      reason_code: "submission_count_saturation",
    });
  });

  it("is 0 on a zero count, ~1 on thousands — never null-coerced", () => {
    const zero = vector(
      detail({
        statistics: {
          valid_submission_count: { value: "0", window: null },
        },
      }),
    );
    expect(zero.submission_activity.value).toBe(0);
    const big = vector(
      detail({
        statistics: {
          valid_submission_count: { value: "19,500", window: null },
        },
      }),
    );
    expect(big.submission_activity.value).toBe(0.975); // 19500/20000
  });

  it("is null on missing or unparseable values — never zero", () => {
    const missing = vector(detail({ statistics: {} }));
    expect(missing.submission_activity.value).toBeNull();
    expect(missing.submission_activity.reason_code).toBe(
      "submission_count_saturation",
    );
    const garbage = vector(
      detail({
        statistics: {
          valid_submission_count: { value: "many", window: null },
        },
      }),
    );
    expect(garbage.submission_activity.value).toBeNull();
  });

  it("is monotone non-decreasing in the raw count", () => {
    const counts = ["0", "10", "100", "500", "2,000", "10,000"];
    let prev = -1;
    for (const c of counts) {
      const v = vector(
        detail({
          statistics: {
            valid_submission_count: { value: c, window: null },
          },
        }),
      );
      expect(v.submission_activity.value).not.toBeNull();
      expect(v.submission_activity.value!).toBeGreaterThanOrEqual(prev);
      prev = v.submission_activity.value!;
    }
  });
});

describe("research_saturation composite", () => {
  const stats = (over: Record<string, string>) =>
    detail({
      statistics: Object.fromEntries(
        Object.entries(over).map(([k, val]) => [
          k,
          { value: val, window: null },
        ]),
      ),
    });

  it("weights recent_crowding 0.3 / submission_activity 0.4 / rewarded 0.3 over known", () => {
    // crowding 1000→0.6667, submissions 500→0.5, rewarded 200→0.5
    const v = vector(
      stats({
        researchers_participating: "1,000",
        valid_submission_count: "500",
        vulnerabilities_rewarded: "200",
      }),
    );
    // (0.3*0.6667 + 0.4*0.5 + 0.3*0.5) / 1.0 = 0.55001… → 0.55
    expect(v.research_saturation).toEqual({
      value: 0.55,
      source: "derived",
      reason_code: "research_saturation_composite",
    });
  });

  it("normalizes over known components only — a missing one is NOT zero", () => {
    // crowding unknown; submissions 2000→0.8, rewarded 400→0.6667
    const v = vector(
      stats({
        valid_submission_count: "2,000",
        vulnerabilities_rewarded: "400",
      }),
    );
    // (0.4*0.8 + 0.3*0.6667) / 0.7 = 0.32+0.20001… = 0.74287… → 0.7429
    expect(v.research_saturation.value).toBe(0.7429);
  });

  it("is null when fewer than two components are known", () => {
    const one = vector(stats({ vulnerabilities_rewarded: "400" }));
    expect(one.research_saturation.value).toBeNull();
    expect(one.research_saturation.reason_code).toBe(
      "insufficient_saturation_components",
    );
    const none = vector(detail({ statistics: {} }));
    expect(none.research_saturation.value).toBeNull();
  });

  it("never decreases when recent crowding rises, all else equal", () => {
    const low = vector(
      stats({
        researchers_participating: "50",
        vulnerabilities_rewarded: "400",
      }),
    );
    const high = vector(
      stats({
        researchers_participating: "2,000",
        vulnerabilities_rewarded: "400",
      }),
    );
    expect(high.research_saturation.value!).toBeGreaterThan(
      low.research_saturation.value!,
    );
  });
});

describe("freshness age bands (fixed now)", () => {
  it.each([
    [0, 1],
    [7, 1],
    [7.5, 0.85],
    [30, 0.85],
    [30.5, 0.6],
    [90, 0.6],
    [90.5, 0.35],
    [180, 0.35],
    [180.5, 0.15],
    [400, 0.15],
  ])("age %dd → %s", (days, expected) => {
    const v = vector(detail({ lastBriefUpdate: daysAgo(days) }));
    expect(v.freshness).toEqual({
      value: expected,
      source: "engagement_detail",
      reason_code: "age_band",
    });
  });

  it("uses the most recent valid date across both fields", () => {
    const v = vector(
      detail({
        lastBriefUpdate: daysAgo(200),
        lastStatusTransition: daysAgo(5),
      }),
    );
    expect(v.freshness.value).toBe(1);
  });

  it("treats a future date as maximally fresh", () => {
    const v = vector(detail({ lastBriefUpdate: daysAgo(-5) }));
    expect(v.freshness.value).toBe(1);
  });

  it("skips invalid dates and is null when none are valid", () => {
    const partial = vector(
      detail({
        lastBriefUpdate: "not-a-date",
        lastStatusTransition: daysAgo(10),
      }),
    );
    expect(partial.freshness.value).toBe(0.85);

    for (const d of [
      detail(),
      detail({ lastBriefUpdate: "garbage", lastStatusTransition: "" }),
    ]) {
      const v = vector(d);
      expect(v.freshness.value).toBeNull();
      expect(v.freshness.reason_code).toBe("age_band");
    }
  });

  it("is null when now itself is unparseable", () => {
    const v = vector(detail({ lastBriefUpdate: daysAgo(1) }), "junk");
    expect(v.freshness.value).toBeNull();
  });
});

describe("safe_harbor (API field only)", () => {
  it.each([
    ["full", 1],
    ["FULL", 1],
    ["Full Safe Harbor", 1],
    ["partial", 0.5],
    ["Partial coverage", 0.5],
    ["none", 0],
    ["absent", 0],
  ])("maps %j → %s", (level, expected) => {
    const v = vector(detail({ safeHarborLevel: level }));
    expect(v.safe_harbor).toEqual({
      value: expected,
      source: "engagement_detail",
      reason_code: "safe_harbor_field",
    });
  });

  it.each([null, "unknown", "not specified", "vdp"])(
    "is null for %j",
    (level) => {
      const v = vector(detail({ safeHarborLevel: level }));
      expect(v.safe_harbor.value).toBeNull();
      expect(v.safe_harbor.reason_code).toBe("safe_harbor_field");
    },
  );
});

describe("target_data_quality composite", () => {
  it("means the four documented completeness parts", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", category: "api", location: "https://a" }),
          target({ id: "t2", name: "B" }), // identity, no category
          target({ id: "t3", category: "", location: "  " }), // neither
          target({ id: "t4", category: "api", inScope: false }), // excluded
        ],
        targetGroups: [
          group({ id: "g1", rewards: rewards({ p1: 100 }) }),
          group({ id: "g2" }), // no reward metadata
          group({ id: "g3", inScope: false, rewards: rewards({ p1: 5 }) }),
        ],
      }),
    );
    // category 1/3 + identity 2/3 + groups-present 1 + reward-metadata 1/2
    // = (0.3333 + 0.6667 + 1 + 0.5) / 4 = 0.625
    expect(v.target_data_quality).toEqual({
      value: 0.625,
      source: "derived",
      reason_code: "field_completeness_mix",
    });
  });

  it("scores 0 on group parts when no in-scope groups exist", () => {
    const v = vector(
      detail({
        targets: [target({ category: "api", location: "https://a" })],
        targetGroups: [],
      }),
    );
    // (1 + 1 + 0 + 0) / 4
    expect(v.target_data_quality.value).toBe(0.5);
  });

  it("is null when there are no in-scope targets and no in-scope groups", () => {
    for (const d of [
      detail(),
      detail({
        targets: [target({ inScope: false, category: "api" })],
        targetGroups: [group({ inScope: false })],
      }),
    ]) {
      const v = vector(d);
      expect(v.target_data_quality.value).toBeNull();
      expect(v.target_data_quality.reason_code).toBe("field_completeness_mix");
    }
  });

  it("counts non-null reward metadata even at zero amount", () => {
    const v = vector(
      detail({
        targets: [target({ category: "api", location: "https://a" })],
        targetGroups: [group({ rewards: rewards({ p1: 0 }) })],
      }),
    );
    // (1 + 1 + 1 + 1) / 4 — p1:0 is reward metadata presence (unlike breadth)
    expect(v.target_data_quality.value).toBe(1);
  });
});

describe("always-null V1 signals", () => {
  it("never fabricates accessibility / known_issue_density / authz_opportunity", () => {
    const v = vector(
      detail({
        targets: [target({ category: "api", location: "https://a" })],
        targetGroups: [group({ rewards: rewards({ p1: 100 }) })],
        statistics: {
          researchers_participating: { value: "10", window: null },
          vulnerabilities_rewarded: { value: "5", window: null },
        },
        safeHarborLevel: "full",
        lastBriefUpdate: daysAgo(1),
      }),
    );
    for (const key of [
      "accessibility",
      "authz_opportunity",
    ] as const) {
      expect(v[key]).toEqual({
        value: null,
        source: "derived",
        reason_code: "not_available_v1",
      });
    }
    // V1.3 deep signals: a snapshot that never received a deep pass reads
    // not_deep_analyzed — never a fabricated 0.
    for (const key of [
      "known_issue_density",
      "opportunity_change",
    ] as const) {
      expect(v[key]).toEqual({
        value: null,
        source: "deep_enrichment",
        reason_code: "not_deep_analyzed",
      });
    }
  });
});

describe("deep-enrichment signals (V1.3)", () => {
  beforeEach(() => {
    kiDensityMock.mockClear();
    oppChangeMock.mockClear();
  });

  it("deep absent / null / empty sub-objects all read not_deep_analyzed", () => {
    for (const deep of [
      undefined,
      null,
      { status: "failed", known_issues: null, semantic_diff: null },
      { status: "unavailable", known_issues: null, semantic_diff: null },
    ] as const) {
      const v = extractProgramFeatures(snapshot(detail(), deep), NOW);
      for (const key of [
        "known_issue_density",
        "opportunity_change",
      ] as const) {
        expect(v[key]).toEqual({
          value: null,
          source: "deep_enrichment",
          reason_code: "not_deep_analyzed",
        });
      }
    }
    expect(kiDensityMock).not.toHaveBeenCalled();
    expect(oppChangeMock).not.toHaveBeenCalled();
  });

  it("ki status unavailable/failed → distinct ki_<status> codes, seam untouched", () => {
    for (const status of ["unavailable", "failed"] as const) {
      const v = extractProgramFeatures(
        snapshot(detail(), {
          status: "partial",
          known_issues: kiSummary({
            status,
            unique_count: null,
            total_count: null,
          }),
          semantic_diff: null,
        }),
        NOW,
      );
      expect(v.known_issue_density).toEqual({
        value: null,
        source: "deep_enrichment",
        reason_code: `ki_${status}`,
      });
    }
    expect(kiDensityMock).not.toHaveBeenCalled();
  });

  it("diff status unavailable/no_baseline → distinct diff_<status> codes, seam untouched", () => {
    for (const status of ["unavailable", "no_baseline"] as const) {
      const v = extractProgramFeatures(
        snapshot(detail(), {
          status: "partial",
          known_issues: null,
          semantic_diff: semanticDiff({ status }),
        }),
        NOW,
      );
      expect(v.opportunity_change).toEqual({
        value: null,
        source: "deep_enrichment",
        reason_code: `diff_${status}`,
      });
    }
    expect(oppChangeMock).not.toHaveBeenCalled();
  });

  it("absent vs unavailable vs failed are distinct honest codes", () => {
    const codes = [
      extractProgramFeatures(snapshot(detail()), NOW).known_issue_density
        .reason_code,
      extractProgramFeatures(
        snapshot(detail(), {
          status: "partial",
          known_issues: kiSummary({
            status: "unavailable",
            unique_count: null,
            total_count: null,
          }),
          semantic_diff: null,
        }),
        NOW,
      ).known_issue_density.reason_code,
      extractProgramFeatures(
        snapshot(detail(), {
          status: "partial",
          known_issues: kiSummary({
            status: "failed",
            unique_count: null,
            total_count: null,
          }),
          semantic_diff: null,
        }),
        NOW,
      ).known_issue_density.reason_code,
    ];
    expect(codes).toEqual([
      "not_deep_analyzed",
      "ki_unavailable",
      "ki_failed",
    ]);
    expect(new Set(codes).size).toBe(3);
  });

  it("complete KI summary calls the seam with summary + meaningfulTargetCount", () => {
    // 2 usable in-scope identities; a blank-identity and an out-of-scope
    // target must not inflate the density denominator.
    const d = detail({
      targets: [
        target({ id: "t1", location: "https://a.example" }),
        target({ id: "t2", name: "Admin panel" }),
        target({ id: "t3", location: "  ", name: "" }), // blank identity
        target({ id: "t4", location: "https://b.example", inScope: false }),
      ],
    });
    const ki = kiSummary({ unique_count: 4 });
    const v = extractProgramFeatures(
      snapshot(d, {
        status: "complete",
        known_issues: ki,
        semantic_diff: null,
      }),
      NOW,
    );
    expect(kiDensityMock).toHaveBeenCalledTimes(1);
    expect(kiDensityMock).toHaveBeenCalledWith(ki, 2);
    // Fake: 4/(4+2) = 0.6667 — the extractor rounds and tags the value.
    expect(v.known_issue_density).toEqual({
      value: 0.6667,
      source: "deep_enrichment",
      reason_code: "ki_density",
    });
  });

  it("complete diff calls the seam; a text-only diff scores a real 0, not null", () => {
    const textOnly = semanticDiff({ only_administrative_changes: true });
    const v = extractProgramFeatures(
      snapshot(detail(), {
        status: "complete",
        known_issues: null,
        semantic_diff: textOnly,
      }),
      NOW,
    );
    expect(oppChangeMock).toHaveBeenCalledWith(textOnly);
    expect(v.opportunity_change).toEqual({
      value: 0,
      source: "deep_enrichment",
      reason_code: "diff_score",
    });

    const expanded = semanticDiff({
      only_administrative_changes: false,
      added_in_scope_targets: 4,
    });
    const v2 = extractProgramFeatures(
      snapshot(detail(), {
        status: "complete",
        known_issues: null,
        semantic_diff: expanded,
      }),
      NOW,
    );
    expect(v2.opportunity_change.value).toBe(1);
  });

  it("a complete summary whose seam returns null keeps the signal honestly null", () => {
    const v = extractProgramFeatures(
      snapshot(detail(), {
        status: "complete",
        // Contract-legal: complete status with a null count → the formula
        // cannot produce a density; null flows through untouched.
        known_issues: kiSummary({ unique_count: null }),
        semantic_diff: null,
      }),
      NOW,
    );
    expect(kiDensityMock).toHaveBeenCalledTimes(1);
    expect(v.known_issue_density).toEqual({
      value: null,
      source: "deep_enrichment",
      reason_code: "ki_density",
    });
  });

  it("the envelope status is never read for truth — sub-object status decides", () => {
    const v = extractProgramFeatures(
      snapshot(detail(), {
        status: "complete", // envelope lies: ki failed, diff worked
        known_issues: kiSummary({
          status: "failed",
          unique_count: null,
          total_count: null,
        }),
        semantic_diff: semanticDiff({
          only_administrative_changes: false,
          added_in_scope_targets: 2,
        }),
      }),
      NOW,
    );
    expect(v.known_issue_density.reason_code).toBe("ki_failed");
    expect(v.known_issue_density.value).toBeNull();
    expect(v.opportunity_change.value).toBe(0.5); // fake: 2/4
  });

  it("detail:null short-circuits before the deep seams run", () => {
    const v = extractProgramFeatures(
      snapshot(null, {
        status: "complete",
        known_issues: kiSummary(),
        semantic_diff: semanticDiff(),
      }),
      NOW,
    );
    for (const key of [
      "known_issue_density",
      "opportunity_change",
    ] as const) {
      expect(v[key]).toEqual({
        value: null,
        source: "deep_enrichment",
        reason_code: "detail_unavailable",
      });
    }
    expect(kiDensityMock).not.toHaveBeenCalled();
    expect(oppChangeMock).not.toHaveBeenCalled();
  });

  it("stays pure and deterministic with a deep payload attached", () => {
    const snap = snapshot(
      detail({ targets: [target({ category: "api", location: "https://a" })] }),
      {
        status: "complete",
        known_issues: kiSummary({ unique_count: 2 }),
        semantic_diff: semanticDiff({
          only_administrative_changes: false,
          added_in_scope_targets: 1,
        }),
      },
    );
    const a = extractProgramFeatures(snap, NOW);
    const b = extractProgramFeatures(snap, NOW);
    expect(a).toEqual(b);
    expect(programFeatureVectorSchema.safeParse(a).success).toBe(true);
    expect(a.known_issue_density.value).not.toBeNull();
    expect(a.opportunity_change.value).not.toBeNull();
  });
});

describe("detail:null snapshot", () => {
  it("emits null for every signal with honest reason codes", () => {
    const v = vector(null);
    for (const key of RADAR_FEATURE_KEYS) {
      expect(v[key].value).toBeNull();
    }
    for (const key of [
      "reward_potential",
      "reward_breadth",
      "meaningful_surface",
      "api_surface",
      "api_surface_size",
      "web_surface",
      "researcher_competition",
      "rewarded_activity",
      "submission_activity",
      "research_saturation",
      "freshness",
      "safe_harbor",
      "target_data_quality",
    ] as const) {
      expect(v[key].reason_code).toBe("detail_unavailable");
    }
    expect(v.accessibility.reason_code).toBe("not_available_v1");
    expect(v.known_issue_density.reason_code).toBe("detail_unavailable");
    expect(v.opportunity_change.reason_code).toBe("detail_unavailable");
    expect(v.authz_opportunity.reason_code).toBe("not_available_v1");
    expect(programFeatureVectorSchema.safeParse(v).success).toBe(true);
  });
});

describe("extractProgramFeatures contract", () => {
  it("is deterministic: same input → deep-equal vectors", () => {
    const d = detail({
      targets: [target({ category: "api", location: "https://a" })],
      targetGroups: [group({ rewards: rewards({ p1: 2000, p3: 10000 }) })],
      statistics: {
        researchers_participating: { value: "1,000", window: null },
      },
      safeHarborLevel: "partial",
      lastBriefUpdate: daysAgo(10),
    });
    const a = extractProgramFeatures(snapshot(d), NOW);
    const b = extractProgramFeatures(snapshot(d), NOW);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("produces a schema-valid vector with all values in 0..1 or null", () => {
    const v = vector(
      detail({
        targets: [
          target({ id: "t1", category: "api", location: "https://a" }),
          target({ id: "t2", name: "portal" }),
        ],
        targetGroups: [group({ rewards: rewards({ p1: 2000, p2: 500 }) })],
        statistics: {
          researchers_participating: { value: "123", window: null },
          vulnerabilities_rewarded: { value: "45", window: null },
        },
        safeHarborLevel: "full",
        lastBriefUpdate: daysAgo(3),
      }),
    );
    expect(programFeatureVectorSchema.safeParse(v).success).toBe(true);
    for (const key of RADAR_FEATURE_KEYS) {
      const value = v[key].value;
      if (value !== null) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
