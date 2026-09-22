import { describe, expect, it } from "vitest";
import { getRadarProfile, RADAR_PROFILES } from "../lib/radar/profiles";
import type { RadarProfile } from "../lib/radar/profiles";
import {
  explainScore,
  rankPrograms,
  REASON_TEXT,
  scoreProgram,
} from "../lib/radar/scoring";
import {
  programScoreSchema,
  RADAR_FEATURE_KEYS,
  RADAR_PROFILE_IDS,
} from "../lib/radar/types";
import type {
  ProgramFeatureVector,
  ProgramScore,
  RadarFeatureKey,
  RadarProgramSnapshot,
  RadarSignal,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Fixtures — vectors are built by hand so exact signal values pin the math.
// ---------------------------------------------------------------------------

function sig(value: number | null): RadarSignal {
  return { value, source: "engagement_detail", reason_code: "test" };
}

function vector(
  values: Partial<Record<RadarFeatureKey, number | null>> = {},
): ProgramFeatureVector {
  const v = {} as Record<RadarFeatureKey, RadarSignal>;
  for (const key of RADAR_FEATURE_KEYS) {
    v[key] = sig(values[key] ?? null);
  }
  return { schema_version: 1, ...v };
}

function snapshot(uuid: string): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid,
    code: uuid,
    catalog: {
      uuid,
      code: uuid,
      name: uuid,
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: "2026-09-01T00:00:00.000Z",
    },
    detail: null,
    enrichment: { status: "complete" },
    source_hash: `sha256:${"ab".repeat(32)}`,
  };
}

function profile(overrides: Partial<RadarProfile> = {}): RadarProfile {
  return {
    id: "best_ev",
    version: "1.0.0",
    label: "Test",
    weights: { reward_potential: 1 },
    minConfidence: 0.5,
    ...overrides,
  };
}

function programScoreFor(overrides: Partial<ProgramScore>): ProgramScore {
  return {
    schema_version: 1,
    engagement_uuid: "u",
    profile: "best_ev",
    scoring_version: "1.0.0",
    score: 50,
    confidence: 1,
    provisional: false,
    components: {},
    reasons: [],
    source_hash: `sha256:${"0".repeat(64)}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 10 — pinned profiles.
// ---------------------------------------------------------------------------

describe("RADAR_PROFILES pinned V1.1 calibration", () => {
  it("contains exactly the six profiles of RADAR_PROFILE_IDS, all v1.1.0", () => {
    expect(Object.keys(RADAR_PROFILES).sort()).toEqual(
      [...RADAR_PROFILE_IDS].sort(),
    );
    for (const id of RADAR_PROFILE_IDS) {
      expect(getRadarProfile(id).version).toBe("1.1.0");
      expect(getRadarProfile(id).id).toBe(id);
    }
  });

  it("best_ev — Best EV, minConfidence 0.6, freshness halved, competition is cost", () => {
    const p = getRadarProfile("best_ev");
    expect(p.label).toBe("Best EV");
    expect(p.minConfidence).toBe(0.6);
    expect(p.weights).toEqual({
      reward_potential: 3,
      meaningful_surface: 2,
      freshness: 0.75,
      researcher_competition: { weight: 1.5, direction: "cost" },
      api_surface: 1,
      web_surface: 1,
      reward_breadth: 1,
      rewarded_activity: 1,
      safe_harbor: 0.5,
      target_data_quality: 0.5,
    });
    expect(p.required_any).toEqual([
      ["researcher_competition", "known_issue_density"],
    ]);
  });

  it("low_competition — Low Competition, minConfidence 0.5", () => {
    const p = getRadarProfile("low_competition");
    expect(p.label).toBe("Low Competition");
    expect(p.minConfidence).toBe(0.5);
    expect(p.weights).toEqual({
      researcher_competition: { weight: 3, direction: "cost" },
      freshness: 2,
      meaningful_surface: 1.5,
      reward_potential: 1,
      target_data_quality: 0.5,
    });
    expect(p.required_any).toEqual([
      ["researcher_competition", "known_issue_density"],
    ]);
  });

  it("high_reward — High Reward, minConfidence 0.5", () => {
    const p = getRadarProfile("high_reward");
    expect(p.label).toBe("High Reward");
    expect(p.minConfidence).toBe(0.5);
    expect(p.weights).toEqual({
      reward_potential: 4,
      reward_breadth: 3,
      rewarded_activity: 1.5,
      target_data_quality: 0.5,
    });
    expect(p.required_any).toEqual([["reward_potential"]]);
  });

  it("authz_api — AuthZ/API, minConfidence 0.5, share+size split, authz_opportunity unweighted", () => {
    const p = getRadarProfile("authz_api");
    expect(p.label).toBe("AuthZ/API");
    expect(p.minConfidence).toBe(0.5);
    expect(p.weights).toEqual({
      api_surface: 1.5,
      api_surface_size: 3,
      meaningful_surface: 1.5,
      reward_potential: 1.5,
      freshness: 1,
      safe_harbor: 0.5,
      researcher_competition: { weight: 0.5, direction: "cost" },
    });
    expect(p.required_any).toEqual([
      ["api_surface", "api_surface_size"],
    ]);
    // Always null in V1 — a weight would only manufacture UNKNOWNs.
    expect(p.weights.authz_opportunity).toBeUndefined();
  });

  it("fresh_programs — Fresh Programs, minConfidence 0.4", () => {
    const p = getRadarProfile("fresh_programs");
    expect(p.label).toBe("Fresh Programs");
    expect(p.minConfidence).toBe(0.4);
    expect(p.weights).toEqual({
      freshness: 5,
      meaningful_surface: 1,
      researcher_competition: { weight: 1, direction: "cost" },
      reward_potential: 0.5,
    });
    expect(p.required_any).toEqual([["freshness"]]);
  });

  it("easy_entry — Easy Entry, minConfidence 0.3", () => {
    const p = getRadarProfile("easy_entry");
    expect(p.label).toBe("Easy Entry");
    expect(p.minConfidence).toBe(0.3);
    expect(p.weights).toEqual({
      accessibility: 2,
      freshness: 1.5,
      reward_breadth: 1.5,
      safe_harbor: 1,
      meaningful_surface: 1,
      reward_potential: 1,
    });
    expect(p.required_any).toEqual([["accessibility"]]);
  });

  it("every effective weight is non-negative — direction carries the sign", () => {
    for (const id of RADAR_PROFILE_IDS) {
      for (const [key, raw] of Object.entries(
        getRadarProfile(id).weights,
      )) {
        const w = typeof raw === "number" ? raw : raw!.weight;
        expect(w, `${id}.${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 11 — scoring math.
// ---------------------------------------------------------------------------

describe("scoreProgram math", () => {
  it("computes the exact weighted average × 100 when all weighted signals are known", () => {
    const p = profile({ weights: { reward_potential: 2, freshness: 1 } });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.5, freshness: 0.8 }),
      p,
    );
    // (2*0.5 + 1*0.8) / 3 = 0.6 → 60.0
    expect(s.score).toBe(60);
    expect(s.confidence).toBe(1);
  });

  it("excludes unknown signals from the score denominator AND the coverage numerator", () => {
    const p = profile({ weights: { reward_potential: 3, freshness: 1 } });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.6 }),
      p,
    );
    // freshness unknown → denominator is 3 alone, not 4.
    expect(s.score).toBe(60);
    // coverage = known w / total w = 3 / 4
    expect(s.confidence).toBe(0.75);
    expect(s.components.reward_potential).toEqual({
      signal: 0.6,
      weight: 3,
      direction: "benefit",
      contribution: 1.8,
    });
    expect(s.components.freshness).toEqual({
      signal: null,
      weight: 1,
      direction: "benefit",
      contribution: null,
    });
  });

  it("never coerces unknown to 0/0.5 and never multiplies score by coverage", () => {
    const p = profile({ weights: { reward_potential: 1, freshness: 9 } });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.6 }),
      p,
    );
    // 90% of the weight unknown: coverage collapses, score does not.
    expect(s.score).toBe(60);
    expect(s.confidence).toBe(0.1);
  });

  it("cost direction normalizes to 1 − signal (crowded competition is worse)", () => {
    const p = profile({
      weights: {
        reward_potential: 1,
        researcher_competition: { weight: 1, direction: "cost" },
      },
    });
    const crowded = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.5, researcher_competition: 0.9 }),
      p,
    );
    const quiet = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.5, researcher_competition: 0.1 }),
      p,
    );
    // crowded: (1*0.5 + 1*0.1) / 2 = 0.3 → 30
    expect(crowded.score).toBe(30);
    expect(crowded.components.researcher_competition).toEqual({
      signal: 0.9,
      weight: 1,
      direction: "cost",
      contribution: 0.1,
    });
    // quiet: (1*0.5 + 1*0.9) / 2 = 0.7 → 70
    expect(quiet.score).toBe(70);
  });

  it("a null cost signal ties known-perfect at best — never exceeds it", () => {
    const p = profile({
      weights: {
        reward_potential: 3,
        researcher_competition: { weight: 1.5, direction: "cost" },
      },
      minConfidence: 0,
    });
    const unknown = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 1 }),
      p,
    );
    const perfect = scoreProgram(
      snapshot("u2"),
      vector({ reward_potential: 1, researcher_competition: 0 }),
      p,
    );
    const worst = scoreProgram(
      snapshot("u3"),
      vector({ reward_potential: 1, researcher_competition: 1 }),
      p,
    );
    // unknown: 3/3 = 100, coverage 2/3. perfect: (3 + 1.5)/4.5 = 100.
    // worst: (3 + 0)/4.5 = 66.7. Unknown sits at the bound, not above —
    // and loses the rank tie-break on coverage.
    expect(unknown.score).toBe(100);
    expect(perfect.score).toBe(100);
    expect(worst.score).toBe(66.7);
    expect(unknown.confidence).toBeLessThan(perfect.confidence);
    const ranked = rankPrograms([unknown, perfect], p);
    expect(ranked.map((r) => r.score.engagement_uuid)).toEqual([
      "u2",
      "u1",
    ]);
  });

  it("rejects negative weights — the V1.0 signed-weight shape is gone", () => {
    const p = profile({
      weights: { reward_potential: -1 } as never,
    });
    expect(() => scoreProgram(snapshot("u1"), vector(), p)).toThrow(
      TypeError,
    );
  });

  it("marks the score provisional when a required_any group is entirely unknown", () => {
    const p = profile({
      weights: { reward_potential: 1 },
      required_any: [
        ["researcher_competition", "known_issue_density"],
      ],
    });
    const missing = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.9 }),
      p,
    );
    expect(missing.provisional).toBe(true);
    expect(missing.score).toBe(90); // still reported — flagged, not hidden
    const covered = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.9, known_issue_density: 0.4 }),
      p,
    );
    expect(covered.provisional).toBe(false);
  });

  it("no required_any means never provisional", () => {
    const p = profile({ weights: { reward_potential: 1 } });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.5 }),
      p,
    );
    expect(s.provisional).toBe(false);
  });

  it("returns score null and confidence 0 when every weighted signal is unknown", () => {
    const p = profile({ weights: { reward_potential: 3, freshness: 1 } });
    const s = scoreProgram(snapshot("u1"), vector(), p);
    expect(s.score).toBeNull();
    expect(s.confidence).toBe(0);
    expect(s.reasons).toEqual([
      "UNKNOWN_REWARD_POTENTIAL",
      "UNKNOWN_FRESHNESS",
    ]);
  });

  it("rounds score to 1 decimal and confidence to 4", () => {
    const p = profile({
      weights: { reward_potential: 1, freshness: 1, api_surface: 1 },
    });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.3333, api_surface: 0.3333 }),
      p,
    );
    // known 2/3 → confidence 0.6667; score (0.3333+0.3333)/2 → 33.3
    expect(s.confidence).toBe(0.6667);
    expect(s.score).toBe(33.3);
  });

  it("copies identity fields and emits one component per profile-weighted key", () => {
    const p = getRadarProfile("best_ev");
    const snap = snapshot("uuid-abc");
    const s = scoreProgram(snap, vector({ reward_potential: 0.8 }), p);
    expect(s.schema_version).toBe(1);
    expect(s.engagement_uuid).toBe("uuid-abc");
    expect(s.profile).toBe("best_ev");
    expect(s.scoring_version).toBe("1.1.0");
    expect(s.source_hash).toBe(snap.source_hash);
    expect(Object.keys(s.components)).toEqual(Object.keys(p.weights));
  });

  it("caps easy_entry coverage at 0.75 and flags provisional — accessibility is always null by design", () => {
    const p = getRadarProfile("easy_entry");
    const s = scoreProgram(
      snapshot("u1"),
      vector({
        freshness: 1,
        reward_breadth: 1,
        safe_harbor: 1,
        meaningful_surface: 1,
        reward_potential: 1,
        // accessibility: null — no V1 source exists.
      }),
      p,
    );
    expect(s.confidence).toBe(0.75); // 6/8 — visibly reduced, intentionally
    expect(s.score).toBe(100);
    expect(s.provisional).toBe(true);
    expect(s.reasons).toContain("UNKNOWN_ACCESSIBILITY");
  });
});

// ---------------------------------------------------------------------------
// Task 12 — reason codes, text templates, explanation lines.
// ---------------------------------------------------------------------------

describe("reason codes", () => {
  it("emits stable codes in profile-declared key order, unknown codes last", () => {
    const p = getRadarProfile("best_ev");
    const s = scoreProgram(
      snapshot("u1"),
      vector({
        reward_potential: 0.9,
        meaningful_surface: 0.6,
        freshness: 0.9,
        researcher_competition: 0.2,
        api_surface: 0.5,
        web_surface: 0.4,
        reward_breadth: 0.7,
        rewarded_activity: 0.6,
        safe_harbor: 1,
        target_data_quality: 0.3,
      }),
      p,
    );
    expect(s.reasons).toEqual([
      "REWARD_HIGH",
      "SURFACE_LARGE",
      "RECENTLY_UPDATED",
      "COMPETITION_LOW",
      "API_SURFACE_HIGH",
      "WEB_SURFACE_HIGH",
      "REWARD_BROAD",
      "ACTIVITY_PROVEN",
      "SAFE_HARBOR_PRESENT",
      "DATA_INCOMPLETE",
    ]);
  });

  it.each([
    [{ reward_potential: 0.8 }, "REWARD_HIGH"],
    [{ reward_potential: 0.5 }, "REWARD_MEDIUM"],
    [{ reward_potential: 0.49 }, "REWARD_LOW"],
    [{ reward_breadth: 0.5 }, "REWARD_BROAD"],
    [{ reward_breadth: 0.49 }, null],
    [{ api_surface: 0.4 }, "API_SURFACE_HIGH"],
    [{ api_surface: 0.39 }, null],
    [{ web_surface: 0.4 }, "WEB_SURFACE_HIGH"],
    [{ meaningful_surface: 0.5 }, "SURFACE_LARGE"],
    [{ meaningful_surface: 0.49 }, null],
    [{ researcher_competition: 0.3 }, "COMPETITION_LOW"],
    [{ researcher_competition: 0.7 }, "COMPETITION_HIGH"],
    [{ researcher_competition: 0.5 }, null],
    [{ rewarded_activity: 0.5 }, "ACTIVITY_PROVEN"],
    [{ freshness: 0.85 }, "RECENTLY_UPDATED"],
    [{ freshness: 0.15 }, "STALE_PROGRAM"],
    [{ freshness: 0.5 }, null],
    [{ safe_harbor: 1 }, "SAFE_HARBOR_PRESENT"],
    [{ safe_harbor: 0.5 }, "SAFE_HARBOR_PARTIAL"],
    [{ safe_harbor: 0 }, "SAFE_HARBOR_ABSENT"],
    [{ target_data_quality: 0.4 }, "DATA_INCOMPLETE"],
    [{ target_data_quality: 0.41 }, null],
  ])("threshold %j → %s", (values, expected) => {
    const key = Object.keys(values)[0] as RadarFeatureKey;
    const p = profile({
      weights: { [key]: 1 } as Partial<Record<RadarFeatureKey, number>>,
    });
    const s = scoreProgram(snapshot("u1"), vector(values), p);
    if (expected === null) {
      expect(s.reasons).toEqual([]);
    } else {
      expect(s.reasons).toEqual([expected]);
    }
  });

  it("emits UNKNOWN_<KEY> only for weighted signals that are null", () => {
    const p = profile({
      weights: { accessibility: 2, freshness: 1 },
    });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ freshness: 0.9 }),
      p,
    );
    // accessibility is weighted + null → UNKNOWN; reward_potential is null
    // but unweighted → no UNKNOWN_REWARD_POTENTIAL.
    expect(s.reasons).toEqual(["RECENTLY_UPDATED", "UNKNOWN_ACCESSIBILITY"]);
  });

  it("REASON_TEXT covers every emitted code, including all UNKNOWN_*", () => {
    const weights = Object.fromEntries(
      RADAR_FEATURE_KEYS.map((k) => [k, 1]),
    ) as Partial<Record<RadarFeatureKey, number>>;
    const p = profile({ weights });
    const everything = scoreProgram(
      snapshot("u1"),
      vector({
        reward_potential: 0.9,
        reward_breadth: 0.6,
        meaningful_surface: 0.6,
        api_surface: 0.5,
        web_surface: 0.5,
        researcher_competition: 0.9,
        rewarded_activity: 0.6,
        freshness: 0.9,
        safe_harbor: 1,
        target_data_quality: 0.3,
        accessibility: 0.5,
        known_issue_density: 0.5,
        authz_opportunity: 0.5,
      }),
      p,
    );
    const nothing = scoreProgram(snapshot("u2"), vector(), p);
    for (const code of [...everything.reasons, ...nothing.reasons]) {
      expect(
        REASON_TEXT[code],
        `REASON_TEXT missing '${code}'`,
      ).toBeTruthy();
    }
    // Pinned human templates from the plan.
    expect(REASON_TEXT.REWARD_HIGH).toBe("strong P1/P2 reward");
    expect(REASON_TEXT.COMPETITION_LOW).toBe("low researcher competition");
    expect(REASON_TEXT.UNKNOWN_ACCESSIBILITY).toBe(
      "accessibility unavailable",
    );
  });
});

describe("explainScore", () => {
  it("prefixes known-positive '+ ', cautions '- ', unknowns '? '", () => {
    const p = profile({
      weights: {
        reward_potential: 1,
        researcher_competition: { weight: 1, direction: "cost" },
        freshness: 1,
        safe_harbor: 1,
        accessibility: 1,
      },
    });
    const s = scoreProgram(
      snapshot("u1"),
      vector({
        reward_potential: 0.9, // REWARD_HIGH → +
        researcher_competition: 0.9, // COMPETITION_HIGH → -
        freshness: 0.1, // STALE_PROGRAM → -
        safe_harbor: 0, // SAFE_HARBOR_ABSENT → -
        // accessibility null → UNKNOWN_ACCESSIBILITY → ?
      }),
      p,
    );
    expect(explainScore(s)).toEqual([
      "+ strong P1/P2 reward",
      "- high researcher competition",
      "- stale program",
      "- no safe harbor",
      "? accessibility unavailable",
    ]);
  });

  it("marks REWARD_LOW and DATA_INCOMPLETE as cautions, not positives", () => {
    const p = profile({
      weights: { reward_potential: 1, target_data_quality: 1 },
    });
    const s = scoreProgram(
      snapshot("u1"),
      vector({ reward_potential: 0.2, target_data_quality: 0.3 }),
      p,
    );
    const lines = explainScore(s);
    expect(lines[0]).toMatch(/^- /);
    expect(lines[1]).toMatch(/^- /);
  });
});

// ---------------------------------------------------------------------------
// Task 11 — ranking.
// ---------------------------------------------------------------------------

describe("rankPrograms", () => {
  it("orders eligible first, then score DESC, confidence DESC, uuid ASC", () => {
    const p = profile({ minConfidence: 0.5 });
    const scores = [
      programScoreFor({ engagement_uuid: "c", score: 70, confidence: 0.9 }),
      programScoreFor({ engagement_uuid: "b", score: 70, confidence: 0.9 }),
      programScoreFor({ engagement_uuid: "d", score: 70, confidence: 0.8 }),
      programScoreFor({ engagement_uuid: "a", score: 90, confidence: 1 }),
      // eligible? no — confidence below floor despite the best score:
      programScoreFor({ engagement_uuid: "e", score: 99, confidence: 0.4 }),
      // eligible? no — null score is never eligible:
      programScoreFor({ engagement_uuid: "f", score: null, confidence: 1 }),
    ];
    const ranked = rankPrograms(scores, p);
    expect(ranked.map((r) => r.score.engagement_uuid)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(ranked.map((r) => r.eligible)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("treats confidence exactly at minConfidence as eligible", () => {
    const p = profile({ minConfidence: 0.5 });
    const [r] = rankPrograms(
      [programScoreFor({ score: 10, confidence: 0.5 })],
      p,
    );
    expect(r!.eligible).toBe(true);
    const [r2] = rankPrograms(
      [programScoreFor({ score: 10, confidence: 0.4999 })],
      p,
    );
    expect(r2!.eligible).toBe(false);
  });

  it("sorts a copy — the input array order is untouched", () => {
    const p = profile({ minConfidence: 0 });
    const input = [
      programScoreFor({ engagement_uuid: "x", score: 1 }),
      programScoreFor({ engagement_uuid: "y", score: 2 }),
    ];
    const ranked = rankPrograms(input, p);
    expect(input.map((s) => s.engagement_uuid)).toEqual(["x", "y"]);
    expect(ranked.map((r) => r.score.engagement_uuid)).toEqual(["y", "x"]);
  });

  it("orders ineligible programs among themselves by the same keys", () => {
    const p = profile({ minConfidence: 0.9 });
    const ranked = rankPrograms(
      [
        programScoreFor({ engagement_uuid: "z", score: null, confidence: 0 }),
        programScoreFor({ engagement_uuid: "m", score: 80, confidence: 0.5 }),
        programScoreFor({ engagement_uuid: "n", score: 80, confidence: 0.5 }),
      ],
      p,
    );
    // all ineligible → score DESC (null = -1), then uuid ASC
    expect(ranked.map((r) => r.score.engagement_uuid)).toEqual([
      "m",
      "n",
      "z",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: determinism + schema validity.
// ---------------------------------------------------------------------------

describe("determinism and schema", () => {
  it("identical inputs produce an identical score object", () => {
    const p = getRadarProfile("best_ev");
    const v = vector({
      reward_potential: 0.7,
      freshness: 0.9,
      researcher_competition: 0.4,
    });
    const a = scoreProgram(snapshot("u1"), v, p);
    const b = scoreProgram(snapshot("u1"), v, p);
    expect(a).toEqual(b);
  });

  it("produces programScoreSchema-valid output for every profile", () => {
    const v = vector({ reward_potential: 0.7, freshness: 0.9 });
    for (const id of RADAR_PROFILE_IDS) {
      const s = scoreProgram(snapshot("u1"), v, getRadarProfile(id));
      expect(
        programScoreSchema.safeParse(s).success,
        `score for profile '${id}' failed schema validation`,
      ).toBe(true);
    }
    // All-unknown vector also validates (score: null is legal).
    const s = scoreProgram(
      snapshot("u2"),
      vector(),
      getRadarProfile("best_ev"),
    );
    expect(programScoreSchema.safeParse(s).success).toBe(true);
  });
});
