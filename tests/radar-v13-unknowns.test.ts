import { describe, expect, it } from "vitest";
import {
  radarDeepEnrichmentSchema,
  radarKnownIssueSummarySchema,
  radarSemanticDiffSchema,
} from "../lib/radar/deepTypes";
import type {
  RadarDeepEnrichment,
  RadarSemanticDiff,
} from "../lib/radar/deepTypes";
import { extractProgramFeatures } from "../lib/radar/features";
import { radarSourceHash } from "../lib/radar/hash";
import type { RadarProfile } from "../lib/radar/profiles";
import { scoreProgram } from "../lib/radar/scoring";
import {
  programFeatureVectorSchema,
  radarProgramSnapshotSchema,
} from "../lib/radar/types";
import type { RadarProgramSnapshot } from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.3 unknown-handling contract tests (adversarial).
//
// The V1.3 contract (lib/radar/deepTypes.ts) states: missing deep data is
// never coerced into 0 or "no issues"/"no change". These tests pin that
// discipline at three layers:
//
//   1. extractProgramFeatures — every non-complete deep state must emit
//      value:null (never 0, never 0.5) with an honest reason code, source
//      "deep_enrichment".
//   2. scoreProgram — a weighted-but-null signal must contribute to neither
//      the score numerator nor the denominator (null != 0, null != 0.5).
//   3. radarSourceHash — `deep` enters the preimage only when present;
//      absent and null hash identically (V1.2 preimage compatibility), and
//      no volatile field can live on the deep types.
//
// CONVENTION: assertions tagged "INTEGRATION ASSERTION" pin intended
// post-merge behavior. They may fail on this branch while the wiring seams
// in features.ts still emit the honest unwired codes
// ("ki_density_unwired" / "opportunity_unwired") — expected; the coordinator
// runs the suite after the A/B/C merges land.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";

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
    observedApiVersion: "2026-09-20",
  };
}

function snapshot(
  uuid: string,
  opts: { deep?: RadarDeepEnrichment | null; detailNull?: boolean } = {},
): RadarProgramSnapshot {
  const base: RadarProgramSnapshot = {
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
    detail: opts.detailNull === true ? null : detail(uuid),
    enrichment:
      opts.detailNull === true
        ? { status: "unavailable", error_kind: "forbidden" }
        : { status: "complete" },
    source_hash: `sha256:${"ab".repeat(32)}`,
  };
  // `deep` is optional on the schema: omit the key entirely unless the caller
  // passed one (distinguishing "absent" from "explicitly null" matters here).
  if ("deep" in opts) return { ...base, deep: opts.deep ?? null };
  return base;
}

// -- deep payload fixtures ----------------------------------------------------

function ki(
  status: "complete" | "unavailable" | "failed",
  unique: number | null = null,
  total: number | null = null,
): NonNullable<RadarDeepEnrichment["known_issues"]> {
  return { status, unique_count: unique, total_count: total };
}

function diff(
  status: RadarSemanticDiff["status"],
  facts: Partial<RadarSemanticDiff> = {},
): RadarSemanticDiff {
  return {
    status,
    from_version: status === "complete" ? "ver-old" : null,
    to_version: "ver-1",
    added_targets: null,
    removed_targets: null,
    added_in_scope_targets: null,
    removed_in_scope_targets: null,
    moved_in_scope: null,
    moved_out_of_scope: null,
    added_api_targets: null,
    added_web_targets: null,
    added_groups: null,
    reward_increase: null,
    reward_decrease: null,
    safe_harbor_changed: null,
    status_changed: null,
    only_administrative_changes: null,
    ...facts,
  };
}

function deep(over: Partial<RadarDeepEnrichment>): RadarDeepEnrichment {
  return { status: "partial", known_issues: null, semantic_diff: null, ...over };
}

// ---------------------------------------------------------------------------
// 1. extractProgramFeatures — deep-signal honesty matrix.
// ---------------------------------------------------------------------------

describe("deep signals: unknown states stay null with honest reason codes", () => {
  // [label, payload, expected ki reason_code, expected oc reason_code].
  // "not_deep_analyzed" is the honest code whenever the sub-object is
  // absent/null — consumers read the SUB-OBJECT status, never the envelope
  // (deepTypes.ts: "consumers read them, never the envelope, for data truth").
  // "___skip___" marks the side exercised by other cases (a complete
  // sub-object may legitimately produce a real value post-merge).
  const cases: Array<
    [string, { present: boolean; deep: RadarDeepEnrichment | null }, string, string]
  > = [
    [
      "snapshot.deep absent",
      { present: false, deep: null },
      "not_deep_analyzed",
      "not_deep_analyzed",
    ],
    [
      "snapshot.deep === null",
      { present: true, deep: null },
      "not_deep_analyzed",
      "not_deep_analyzed",
    ],
    [
      "deep.status failed, sub-objects null",
      { present: true, deep: deep({ status: "failed" }) },
      "not_deep_analyzed",
      "not_deep_analyzed",
    ],
    [
      "deep.status unavailable, sub-objects null",
      { present: true, deep: deep({ status: "unavailable" }) },
      "not_deep_analyzed",
      "not_deep_analyzed",
    ],
    [
      "deep.status failed + ki failed + diff unavailable",
      {
        present: true,
        deep: deep({
          status: "failed",
          known_issues: ki("failed"),
          semantic_diff: diff("unavailable"),
        }),
      },
      "ki_failed",
      "diff_unavailable",
    ],
    [
      "deep.status unavailable + ki unavailable + diff unavailable",
      {
        present: true,
        deep: deep({
          status: "unavailable",
          known_issues: ki("unavailable"),
          semantic_diff: diff("unavailable"),
        }),
      },
      "ki_unavailable",
      "diff_unavailable",
    ],
    [
      "ki unavailable under a partial envelope (diff complete)",
      {
        present: true,
        deep: deep({
          status: "partial",
          known_issues: ki("unavailable"),
          semantic_diff: diff("complete", { added_targets: 2 }),
        }),
      },
      "ki_unavailable",
      "___skip___",
    ],
    [
      "diff no_baseline under a partial envelope (ki complete)",
      {
        present: true,
        deep: deep({
          status: "partial",
          known_issues: ki("complete", 5, 20),
          semantic_diff: diff("no_baseline"),
        }),
      },
      "___skip___",
      "diff_no_baseline",
    ],
  ];

  for (const [label, payload, kiCode, ocCode] of cases) {
    it(`${label} -> null signals, honest codes`, () => {
      const snap = snapshot("u-deep", {
        ...(payload.present ? { deep: payload.deep } : {}),
      });
      expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
      const v = extractProgramFeatures(snap, T0);
      if (kiCode !== "___skip___") {
        // null — never 0 ("no issues"), never 0.5 ("neutral midpoint").
        expect(v.known_issue_density.value).toBeNull();
        expect(v.known_issue_density.source).toBe("deep_enrichment");
        expect(v.known_issue_density.reason_code).toBe(kiCode);
      }
      if (ocCode !== "___skip___") {
        expect(v.opportunity_change.value).toBeNull();
        expect(v.opportunity_change.source).toBe("deep_enrichment");
        expect(v.opportunity_change.reason_code).toBe(ocCode);
      }
      expect(programFeatureVectorSchema.safeParse(v).success).toBe(true);
    });
  }

  it("detail:null snapshot keeps deep signals honest (detail_unavailable)", () => {
    // A metadata-stage failure routes through the detail-null branch — the
    // deep signals read detail_unavailable rather than a fabricated value
    // (behavior the contract commit pinned in radar-features.test.ts).
    const snap = snapshot("u-dd", {
      detailNull: true,
      deep: deep({
        status: "complete",
        known_issues: ki("complete", 5, 20),
        semantic_diff: diff("complete", { added_targets: 2 }),
      }),
    });
    const v = extractProgramFeatures(snap, T0);
    expect(v.known_issue_density).toEqual({
      value: null,
      source: "deep_enrichment",
      reason_code: "detail_unavailable",
    });
    expect(v.opportunity_change).toEqual({
      value: null,
      source: "deep_enrichment",
      reason_code: "detail_unavailable",
    });
  });

  it("INTEGRATION ASSERTION: a complete deep payload yields real signal values once wired", () => {
    // TODAY the seams return null + "ki_density_unwired" /
    // "opportunity_unwired", so this FAILS on this branch. Post-merge a
    // complete deep pass must produce numbers — a real 0 counts; unwired
    // placeholders must be gone.
    const snap = snapshot("u-complete", {
      deep: deep({
        status: "complete",
        known_issues: ki("complete", 5, 20),
        semantic_diff: diff("complete", {
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
        }),
      }),
    });
    const v = extractProgramFeatures(snap, T0);
    expect(v.known_issue_density.value).not.toBeNull();
    expect(v.known_issue_density.value).toBeGreaterThanOrEqual(0);
    expect(v.known_issue_density.value).toBeLessThanOrEqual(1);
    expect(v.opportunity_change.value).not.toBeNull();
    expect(v.opportunity_change.value).toBeGreaterThanOrEqual(0);
    expect(v.opportunity_change.value).toBeLessThanOrEqual(1);
    expect(v.known_issue_density.reason_code).not.toBe("ki_density_unwired");
    expect(v.opportunity_change.reason_code).not.toBe("opportunity_unwired");
  });
});

// ---------------------------------------------------------------------------
// 2. Schema-level invariants on the deep types.
// ---------------------------------------------------------------------------

describe("deep schema invariants", () => {
  it("a status:unavailable diff keeps every fact field null and parses", () => {
    const d = diff("unavailable");
    const parsed = radarSemanticDiffSchema.safeParse(d);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const { status, from_version, to_version, ...facts } = parsed.data;
      expect(status).toBe("unavailable");
      expect(from_version).toBeNull();
      for (const [key, value] of Object.entries(facts)) {
        expect(value, `fact ${key}`).toBeNull();
      }
    }
  });

  it("a status:no_baseline diff parses with a null from_version", () => {
    expect(radarSemanticDiffSchema.safeParse(diff("no_baseline")).success).toBe(
      true,
    );
  });

  it("rejects extra keys (strict) and non-integer/negative counts", () => {
    expect(
      radarSemanticDiffSchema.safeParse({
        ...diff("complete", { added_targets: 1 }),
        captured_at: T0, // volatile bookkeeping must not enter the contract
      }).success,
    ).toBe(false);
    expect(
      radarSemanticDiffSchema.safeParse(
        diff("complete", { added_targets: -1 }),
      ).success,
    ).toBe(false);
    expect(
      radarSemanticDiffSchema.safeParse(
        diff("complete", { added_targets: 1.5 }),
      ).success,
    ).toBe(false);
    expect(
      radarKnownIssueSummarySchema.safeParse(ki("complete", -1, 0)).success,
    ).toBe(false);
  });

  it("CONTRACT GAP (agent-e-audit.md): a complete diff with all-null facts should fail validation", () => {
    // deepTypes.ts: "Every fact field is null unless status === 'complete'"
    // — a complete diff must produce real counts (0 is a real answer). The
    // schema carries NO refinement enforcing this today, so the expectation
    // below is RED pre-merge. If the merge wires producers to never emit the
    // shape instead of refining the schema, the coordinator adjudicates —
    // either way a "complete but factless" diff must not silently pass.
    expect(radarSemanticDiffSchema.safeParse(diff("complete")).success).toBe(
      false,
    );
  });

  it("snapshot schema accepts deep absent and deep:null identically", () => {
    expect(radarProgramSnapshotSchema.safeParse(snapshot("u-h1")).success).toBe(
      true,
    );
    expect(
      radarProgramSnapshotSchema.safeParse(snapshot("u-h1", { deep: null }))
        .success,
    ).toBe(true);
  });

  it("no volatile field can live on the deep types", () => {
    // Deep payloads enter source_hash; a timestamp there would re-hash every
    // run and re-trigger scoring on identical semantics. Assert no field on
    // any deep schema smells like bookkeeping time.
    const volatile = /(_at\b|timestamp|date|time|created|updated)/i;
    for (const key of Object.keys(radarDeepEnrichmentSchema.shape)) {
      expect(key).not.toMatch(volatile);
    }
    for (const key of Object.keys(radarKnownIssueSummarySchema.shape)) {
      expect(key).not.toMatch(volatile);
    }
    for (const key of Object.keys(radarSemanticDiffSchema.shape)) {
      expect(key).not.toMatch(volatile);
    }
    // Belt-and-suspenders: strict envelopes physically reject an injected
    // timestamp at parse time.
    expect(
      radarDeepEnrichmentSchema.safeParse({
        ...deep({ status: "complete" }),
        captured_at: T0,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Scoring — a weighted-but-null signal is absent, not zero.
// ---------------------------------------------------------------------------

describe("scoreProgram: weighted-but-null known_issue_density is excluded", () => {
  const withKi: RadarProfile = {
    id: "best_ev",
    version: "test",
    label: "Test",
    weights: { reward_potential: 1, known_issue_density: 2 },
    minConfidence: 0.5,
  };
  const withoutKi: RadarProfile = {
    ...withKi,
    weights: { reward_potential: 1 },
  };

  function vectorWith(kiValue: number | null) {
    const snap = snapshot("u-score");
    const v = extractProgramFeatures(snap, T0);
    return {
      snap,
      vector: {
        ...v,
        reward_potential: {
          value: 0.6,
          source: "engagement_detail" as const,
          reason_code: "test",
        },
        known_issue_density: {
          value: kiValue,
          source: "deep_enrichment" as const,
          reason_code: "test",
        },
      },
    };
  }

  it("null contributes to neither numerator nor denominator", () => {
    const { snap, vector } = vectorWith(null);
    const a = scoreProgram(snap, vector, withoutKi); // key absent from weights
    const b = scoreProgram(snap, vector, withKi); // key weighted, value null
    expect(a.score).toBe(60);
    // If null were coerced to 0 the score would be 20; to 0.5 it would be
    // 53.3. It is exactly the unweighted score instead.
    expect(b.score).toBe(a.score);
    expect(b.confidence).toBeCloseTo(1 / 3, 4); // coverage drops, honestly
    expect(a.confidence).toBe(1);
    expect(b.components.known_issue_density).toEqual({
      signal: null,
      weight: 2,
      direction: "benefit",
      contribution: null,
    });
    expect(b.reasons).toContain("UNKNOWN_KNOWN_ISSUE_DENSITY");
  });

  it("a real 0 DOES move the score (null is not 0)", () => {
    const { snap, vector } = vectorWith(0);
    const s = scoreProgram(snap, vector, withKi);
    // (1*0.6 + 2*0) / 3 = 0.2 -> 20.0 — materially below the null case's 60.
    expect(s.score).toBe(20);
    expect(s.confidence).toBe(1);
    expect(s.components.known_issue_density?.contribution).toBe(0);
  });

  it("a real 0.5 DOES move the score (null is not a midpoint)", () => {
    const { snap, vector } = vectorWith(0.5);
    const s = scoreProgram(snap, vector, withKi);
    // (1*0.6 + 2*0.5) / 3 = 0.5333 -> 53.3.
    expect(s.score).toBe(53.3);
  });
});

// ---------------------------------------------------------------------------
// 4. radarSourceHash — conditional deep in the preimage.
// ---------------------------------------------------------------------------

describe("radarSourceHash deep preimage", () => {
  const catalog = snapshot("u-hash").catalog;

  it("deep absent vs deep:null hash identically (V1.2 compatibility)", async () => {
    const h0 = await radarSourceHash({ catalog, detail: detail("u-hash") });
    const hNull = await radarSourceHash({
      catalog,
      detail: detail("u-hash"),
      deep: null,
    });
    const hUndef = await radarSourceHash({
      catalog,
      detail: detail("u-hash"),
      deep: undefined,
    });
    expect(hNull).toBe(h0);
    expect(hUndef).toBe(h0);
  });

  it("a deep payload changes the hash", async () => {
    const h0 = await radarSourceHash({ catalog, detail: detail("u-hash") });
    const hDeep = await radarSourceHash({
      catalog,
      detail: detail("u-hash"),
      deep: deep({
        status: "complete",
        known_issues: ki("complete", 5, 20),
        semantic_diff: diff("complete", { added_targets: 2 }),
      }),
    });
    expect(hDeep).not.toBe(h0);
    expect(hDeep).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("mutating any deep fact changes the hash (every field is a scoring input)", async () => {
    const base = deep({
      status: "complete",
      known_issues: ki("complete", 5, 20),
      semantic_diff: diff("complete", { added_targets: 2 }),
    });
    const hA = await radarSourceHash({
      catalog,
      detail: detail("u-hash"),
      deep: base,
    });
    const hB = await radarSourceHash({
      catalog,
      detail: detail("u-hash"),
      deep: deep({
        status: "complete",
        known_issues: ki("complete", 6, 20), // unique_count 5 -> 6
        semantic_diff: diff("complete", { added_targets: 2 }),
      }),
    });
    const hC = await radarSourceHash({
      catalog,
      detail: detail("u-hash"),
      deep: deep({
        status: "complete",
        known_issues: ki("complete", 5, 20),
        semantic_diff: diff("complete", { added_targets: 3 }), // 2 -> 3
      }),
    });
    expect(hB).not.toBe(hA);
    expect(hC).not.toBe(hA);
  });

  it("no volatile-only field exists on the deep types to leak into the hash", () => {
    // There is no timestamp to mutate — verified structurally in the schema
    // test above. This test documents the preimage has nothing to exclude:
    // deep enters canonicalJson verbatim, so a volatile field would be both
    // unstorable (strict schema) and unhashable-by-omission.
    expect(Object.keys(radarDeepEnrichmentSchema.shape).sort()).toEqual([
      "known_issues",
      "semantic_diff",
      "status",
    ]);
  });
});
