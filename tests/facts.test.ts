import { describe, expect, it } from "vitest";
import {
  buildPermissionFact,
  buildSafeHarborFact,
  mapTechnique,
  type AssertionInput,
} from "../lib/model/facts";
import type {
  Applicability,
  Evidence,
  ExtractionStatus,
  PermissionStatus,
} from "../lib/types";

function ev(id: string, status: ExtractionStatus = "exact"): Evidence {
  return {
    id,
    source_key: `k:${id}`,
    source: {
      url: "https://bugcrowd.com/engagements/acme",
      type: "dom",
      authenticated: true,
    },
    locator: {},
    source_level: "explicit_program_rule",
    collected_at: "2026-09-20T01:10:22+07:00",
    quote: `quote for ${id}`,
    content_hash: `sha256:${"0".repeat(52)}${id}`,
    extraction: { status, parser_version: "2.0.0" },
  };
}

const ENGAGEMENT: Applicability = { type: "engagement" };

function assertion(overrides: Partial<AssertionInput> = {}): AssertionInput {
  return {
    status: "allowed",
    conditions: [],
    applies_to: ENGAGEMENT,
    evidence: [],
    ...overrides,
  };
}

describe("buildPermissionFact — asserted statuses", () => {
  it("asserts a status backed by exact evidence", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_a")] }),
    ]);
    expect(fact.status).toBe("allowed");
    expect(fact.conflict).toEqual({
      detected: false,
      evidence_refs: [],
      asserted_statuses: [],
    });
    expect(fact.resolution).toBeUndefined();
    expect(fact.extraction.status).toBe("exact");
    expect(fact.evidence_refs).toEqual(["ev_a"]);
    expect(fact.applies_to).toEqual(ENGAGEMENT);
  });

  it("asserts conditional with merged conditions", () => {
    const fact = buildPermissionFact([
      assertion({
        status: "conditional",
        conditions: ["Only against listed targets."],
        evidence: [ev("ev_a")],
      }),
    ]);
    expect(fact.status).toBe("conditional");
    expect(fact.conditions).toEqual([
      { id: "condition_001", text: "Only against listed targets." },
    ]);
  });

  it("asserts when exact and partial evidence agree — partial stays attached", () => {
    const fact = buildPermissionFact([
      assertion({
        status: "prohibited",
        evidence: [ev("ev_exact", "exact"), ev("ev_part", "partial")],
      }),
      assertion({ status: "prohibited", evidence: [ev("ev_part2", "partial")] }),
    ]);
    expect(fact.status).toBe("prohibited");
    expect(fact.extraction.status).toBe("exact");
    expect(fact.evidence_refs).toEqual(["ev_exact", "ev_part", "ev_part2"]);
  });

  it("dedupes and sorts evidence_refs", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_b"), ev("ev_a")] }),
      assertion({ status: "allowed", evidence: [ev("ev_a"), ev("ev_c")] }),
    ]);
    expect(fact.evidence_refs).toEqual(["ev_a", "ev_b", "ev_c"]);
  });

  it("merges conditions from asserted assertions: dedupe + deterministic order", () => {
    const fact = buildPermissionFact([
      assertion({
        status: "conditional",
        conditions: ["With prior approval.", "Only on weekdays."],
        evidence: [ev("ev_a")],
      }),
      assertion({
        status: "conditional",
        conditions: ["Only on weekdays.", "Within scope."],
        evidence: [ev("ev_b")],
      }),
    ]);
    expect(fact.status).toBe("conditional");
    expect(fact.conditions.map((c) => c.text)).toEqual([
      "Only on weekdays.",
      "With prior approval.",
      "Within scope.",
    ]);
    expect(fact.conditions.map((c) => c.id)).toEqual([
      "condition_001",
      "condition_002",
      "condition_003",
    ]);
  });

  it("does not merge conditions from non-asserted (partial-only) assertions", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_a")] }),
      assertion({
        status: "conditional",
        conditions: ["Unverifiable condition."],
        evidence: [ev("ev_p", "partial")],
      }),
    ]);
    expect(fact.status).toBe("allowed");
    expect(fact.conditions).toEqual([]);
  });
});

describe("buildPermissionFact — unspecified", () => {
  it("never asserts from partial evidence alone — even 3 agreeing partials", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_1", "partial")] }),
      assertion({ status: "allowed", evidence: [ev("ev_2", "partial")] }),
      assertion({ status: "allowed", evidence: [ev("ev_3", "partial")] }),
    ]);
    expect(fact.status).toBe("unspecified");
    expect(fact.conflict.detected).toBe(false);
    expect(fact.evidence_refs).toEqual(["ev_1", "ev_2", "ev_3"]);
    expect(fact.extraction.status).toBe("partial");
  });

  it("takes the worst extraction status across evidence", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_p", "partial")] }),
      assertion({ status: "allowed", evidence: [ev("ev_f", "failed")] }),
    ]);
    expect(fact.status).toBe("unspecified");
    expect(fact.extraction.status).toBe("failed");
  });

  it("yields unspecified (never prohibited) with no assertions or evidence", () => {
    const empty = buildPermissionFact([]);
    expect(empty.status).toBe("unspecified");
    expect(empty.status).not.toBe("prohibited");
    expect(empty.evidence_refs).toEqual([]);
    expect(empty.extraction.status).toBe("failed");

    const noEvidence = buildPermissionFact([
      assertion({ status: "prohibited", evidence: [] }),
    ]);
    expect(noEvidence.status).toBe("unspecified");
    expect(noEvidence.status).not.toBe("prohibited");
  });

  it("failed extraction evidence never establishes a status", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_f", "failed")] }),
    ]);
    expect(fact.status).toBe("unspecified");
    expect(fact.extraction.status).toBe("failed");
  });
});

describe("buildPermissionFact — conflicts", () => {
  it("detects allowed+prohibited on the same technique and preserves everything", () => {
    const a1 = assertion({ status: "allowed", evidence: [ev("ev_allow")] });
    const a2 = assertion({ status: "prohibited", evidence: [ev("ev_deny")] });
    const fact = buildPermissionFact([a1, a2]);
    expect(fact.status).toBe("unspecified");
    expect(fact.conflict.detected).toBe(true);
    expect(fact.conflict.asserted_statuses).toEqual(["allowed", "prohibited"]);
    expect(fact.conflict.evidence_refs).toEqual(["ev_allow", "ev_deny"]);
    expect(fact.resolution).toEqual({ status: "unresolved" });
    // all evidence retained at top level too (nothing dropped)
    expect(fact.evidence_refs).toEqual(["ev_allow", "ev_deny"]);
  });

  it("conflict via mapTechnique-built assertions (same technique, two sources)", () => {
    const tech = { name: "automation", status: "allowed" as PermissionStatus, conditions: ["Scoped only."] };
    const assertions = [
      mapTechnique(tech, [ev("ev_dom")], ENGAGEMENT),
      mapTechnique(
        { ...tech, status: "prohibited" },
        [ev("ev_api")],
        ENGAGEMENT,
      ),
    ];
    const fact = buildPermissionFact(assertions);
    expect(fact.conflict.detected).toBe(true);
    expect(fact.conflict.asserted_statuses).toEqual(["allowed", "prohibited"]);
    expect(fact.resolution?.status).toBe("unresolved");
    expect(fact.status).toBe("unspecified");
  });

  it("drops ambiguous condition lists in a conflict (no resolved status)", () => {
    const fact = buildPermissionFact([
      assertion({
        status: "allowed",
        conditions: ["c1"],
        evidence: [ev("ev_a")],
      }),
      assertion({
        status: "prohibited",
        conditions: ["c2"],
        evidence: [ev("ev_b")],
      }),
    ]);
    expect(fact.conditions).toEqual([]);
  });

  it("three-way disagreement lists all asserted statuses", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_a")] }),
      assertion({ status: "conditional", evidence: [ev("ev_c")] }),
      assertion({ status: "prohibited", evidence: [ev("ev_p")] }),
    ]);
    expect(fact.conflict.asserted_statuses).toEqual([
      "allowed",
      "conditional",
      "prohibited",
    ]);
  });

  it("agreeing assertions with partial extras do not conflict", () => {
    const fact = buildPermissionFact([
      assertion({ status: "allowed", evidence: [ev("ev_a")] }),
      assertion({ status: "allowed", evidence: [ev("ev_b")] }),
      assertion({ status: "prohibited", evidence: [ev("ev_p", "partial")] }),
    ]);
    expect(fact.status).toBe("allowed");
    expect(fact.conflict.detected).toBe(false);
    expect(fact.evidence_refs).toEqual(["ev_a", "ev_b", "ev_p"]);
  });
});

describe("buildPermissionFact — applicability", () => {
  it("passes through a single applies_to", () => {
    const app: Applicability = { type: "target_ids", ids: ["target_zz", "target_aa"] };
    const fact = buildPermissionFact([
      assertion({ evidence: [ev("ev_a")], applies_to: app }),
    ]);
    expect(fact.applies_to).toEqual({
      type: "target_ids",
      ids: ["target_aa", "target_zz"],
    });
  });

  it("unions target_ids across asserted assertions", () => {
    const fact = buildPermissionFact([
      assertion({
        evidence: [ev("ev_a")],
        applies_to: { type: "target_ids", ids: ["target_b"] },
      }),
      assertion({
        evidence: [ev("ev_b")],
        applies_to: { type: "target_ids", ids: ["target_a", "target_b"] },
      }),
    ]);
    expect(fact.applies_to).toEqual({
      type: "target_ids",
      ids: ["target_a", "target_b"],
    });
  });

  it("widens divergent applicability kinds to engagement", () => {
    const fact = buildPermissionFact([
      assertion({
        evidence: [ev("ev_a")],
        applies_to: { type: "target_ids", ids: ["target_a"] },
      }),
      assertion({
        evidence: [ev("ev_b")],
        applies_to: { type: "all_targets" },
      }),
    ]);
    expect(fact.applies_to).toEqual({ type: "engagement" });
  });
});

describe("buildSafeHarborFact", () => {
  it("maps present-only evidence to present", () => {
    const r = buildSafeHarborFact({ present: [ev("ev_sh")] });
    expect(r.status).toBe("present");
    expect(r.evidence_refs).toEqual(["ev_sh"]);
  });

  it("maps absent-only evidence to absent", () => {
    const r = buildSafeHarborFact({ absent: [ev("ev_no")] });
    expect(r.status).toBe("absent");
    expect(r.evidence_refs).toEqual(["ev_no"]);
  });

  it("maps competing present+absent signals to unclear, keeping both", () => {
    const r = buildSafeHarborFact({
      present: [ev("ev_yes")],
      absent: [ev("ev_no")],
    });
    expect(r.status).toBe("unclear");
    expect(r.evidence_refs).toEqual(["ev_no", "ev_yes"]);
  });

  it("maps ambiguous-only or empty signals to unclear", () => {
    expect(buildSafeHarborFact({ ambiguous: [ev("ev_q")] }).status).toBe(
      "unclear",
    );
    expect(buildSafeHarborFact({}).status).toBe("unclear");
    expect(buildSafeHarborFact({}).evidence_refs).toEqual([]);
  });

  it("aggregates evidence from all buckets deduped", () => {
    const r = buildSafeHarborFact({
      present: [ev("ev_a")],
      ambiguous: [ev("ev_b"), ev("ev_a")],
    });
    expect(r.evidence_refs).toEqual(["ev_a", "ev_b"]);
  });
});

describe("mapTechnique", () => {
  it("maps technique fields into an AssertionInput", () => {
    const evidence = [ev("ev_a")];
    const app: Applicability = { type: "target_ids", ids: ["target_x"] };
    const a = mapTechnique(
      { name: "brute force", status: "prohibited", conditions: ["None."] },
      evidence,
      app,
    );
    expect(a).toEqual({
      status: "prohibited",
      conditions: ["None."],
      applies_to: app,
      evidence,
    });
  });
});
