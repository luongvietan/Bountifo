import { describe, expect, it } from "vitest";
import {
  computeIntegrity,
  REQUIRED_UNIT_IDS,
  type UnitOutcome,
} from "../lib/model/integrity";
import type { KiResult } from "../lib/dom/knownIssues";
import type { Evidence, PermissionFact } from "../lib/types";

// Unit criticality table from the task brief / plan (set by the coordinator).
const ALL_UNITS: { id: string; required: boolean; critical: boolean }[] = [
  { id: "u01_validate_url", required: false, critical: true },
  { id: "u02_init_job", required: false, critical: true },
  { id: "u03_collect_details", required: true, critical: true },
  { id: "u04_api_enrichment", required: false, critical: false },
  { id: "u05_collect_targets", required: true, critical: false },
  { id: "u06_collect_policy", required: true, critical: false },
  { id: "u07_collect_activity", required: true, critical: false },
  { id: "u08_known_issues", required: true, critical: false },
  { id: "u09_build_evidence", required: false, critical: true },
  { id: "u10_normalize_facts", required: false, critical: true },
  { id: "u11_integrity_check", required: false, critical: true },
  { id: "u12_render_download", required: false, critical: true },
  { id: "u13_cleanup", required: false, critical: false },
];

function outcome(
  id: string,
  status: UnitOutcome["status"] = "ok",
  warnings: string[] = [],
): UnitOutcome {
  const u = ALL_UNITS.find((x) => x.id === id);
  if (u === undefined) throw new Error(`unknown unit ${id}`);
  return {
    unitId: id,
    status,
    required: u.required,
    critical: u.critical,
    warnings,
  };
}

function allOk(): UnitOutcome[] {
  return ALL_UNITS.map((u) => outcome(u.id));
}

function ki(overrides: Partial<KiResult> = {}): KiResult {
  return {
    targetDomKey: "target:acme",
    displayedCount: 2,
    collectedCount: 2,
    columns: ["Priority"],
    rows: [{ cells: ["P1"] }, { cells: ["P2"] }],
    skipped: false,
    countMatches: true,
    warnings: [],
    records: [],
    ...overrides,
  };
}

function ev(id: string, contentHash = `sha256:${"a".repeat(64)}`): Evidence {
  return {
    id,
    source_key: `dom:x:${id}`,
    source: {
      url: "https://bugcrowd.com/engagements/acme",
      type: "dom",
      authenticated: true,
    },
    locator: {},
    source_level: "explicit_program_rule",
    collected_at: "2026-09-20T01:10:22+07:00",
    quote: "q",
    content_hash: contentHash,
    extraction: { status: "exact", parser_version: "2.0.0" },
  };
}

function fact(overrides: Partial<PermissionFact> = {}): PermissionFact {
  return {
    status: "allowed",
    conditions: [],
    applies_to: { type: "engagement" },
    evidence_refs: [],
    conflict: { detected: false, evidence_refs: [], asserted_statuses: [] },
    extraction: { status: "exact" },
    ...overrides,
  };
}

function baseArgs(
  overrides: Partial<Parameters<typeof computeIntegrity>[0]> = {},
): Parameters<typeof computeIntegrity>[0] {
  return {
    outcomes: allOk(),
    kiResults: [],
    apiFailed: false,
    domCriticalFailure: null,
    facts: {},
    evidence: [ev("ev_1")],
    corpusHash: `sha256:${"c".repeat(64)}`,
    normalizedHash: `sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

describe("computeIntegrity — status (spec §18)", () => {
  it("reports complete with all flags true when every unit is ok", () => {
    const r = computeIntegrity(baseArgs());
    expect(r.collection.status).toBe("complete");
    expect(r.collection.api_status).toBe("complete");
    expect(r.collection.dom_status).toBe("complete");
    expect(r.collection.parser_version).toBe("2.0.0");
    expect(r.collection.evidence_corpus_hash).toBe(`sha256:${"c".repeat(64)}`);
    expect(r.collection.normalized_hash).toBe(`sha256:${"d".repeat(64)}`);
    expect(r.integrity).toEqual({
      evidence_hash_valid: true,
      known_issues_counts_valid: true,
      required_sections_complete: true,
    });
    expect(r.quality.warnings).toEqual([]);
    expect(r.policy).toEqual({
      conflicts_present: false,
      unresolved_conflicts: 0,
    });
  });

  it("apiFailed alone → status stays complete, api_status unavailable", () => {
    const r = computeIntegrity(
      baseArgs({
        apiFailed: true,
        outcomes: allOk().map((o) =>
          o.unitId === "u04_api_enrichment"
            ? { ...o, status: "warning", warnings: ["api_engagement_not_found"] }
            : o,
        ),
      }),
    );
    expect(r.collection.status).toBe("complete");
    expect(r.collection.api_status).toBe("unavailable");
    expect(r.collection.dom_status).toBe("complete");
    expect(r.integrity.required_sections_complete).toBe(true);
  });

  it("u04 failed without apiFailed flag still → api_status unavailable, not partial", () => {
    const r = computeIntegrity(
      baseArgs({
        outcomes: allOk().map((o) =>
          o.unitId === "u04_api_enrichment"
            ? { ...o, status: "failed", warnings: ["api_unreachable"] }
            : o,
        ),
      }),
    );
    expect(r.collection.api_status).toBe("unavailable");
    expect(r.collection.status).toBe("complete");
    expect(r.quality.warnings).toContain("api_unreachable");
  });

  it("u04 missing entirely → api_status unavailable", () => {
    const r = computeIntegrity(
      baseArgs({
        outcomes: allOk().filter((o) => o.unitId !== "u04_api_enrichment"),
      }),
    );
    expect(r.collection.api_status).toBe("unavailable");
    expect(r.collection.status).toBe("complete");
  });

  it("KI count mismatch → partial + warning + known_issues_counts_valid false", () => {
    const bad = ki({
      displayedCount: 3,
      collectedCount: 1,
      countMatches: false,
      warnings: ["ki_count_mismatch:displayed=3,collected=1"],
      rows: [{ cells: ["P1"] }],
    });
    const r = computeIntegrity(baseArgs({ kiResults: [bad] }));
    expect(r.collection.status).toBe("partial");
    expect(r.collection.dom_status).toBe("partial");
    expect(r.integrity.known_issues_counts_valid).toBe(false);
    // §13: the KI section cannot be marked complete.
    expect(r.integrity.required_sections_complete).toBe(false);
    expect(r.quality.warnings).toContain("ki_count_mismatch:displayed=3,collected=1");
  });

  it("refuses to call a collection complete when a required section is empty", () => {
    // A brief whose scope inventory came back empty is not a program without
    // targets - it is a collection that missed them. Reporting "complete"
    // there is the most dangerous reading an agent can be handed.
    const r = computeIntegrity(baseArgs({ missingSections: ["scope"] }));
    expect(r.collection.status).toBe("partial");
    expect(r.collection.dom_status).toBe("partial");
    expect(r.integrity.required_sections_complete).toBe(false);
    expect(r.quality.warnings).toContain("missing_section:scope");
  });

  it("stays complete when no required section is missing", () => {
    const r = computeIntegrity(baseArgs({ missingSections: [] }));
    expect(r.collection.status).toBe("complete");
    expect(r.integrity.required_sections_complete).toBe(true);
  });

  it("refuses to call counts valid when a target was never verified", () => {
    // A dialog that never opened, or a displayed count that was unavailable,
    // means that target was not checked (§13) — "valid" would be a claim the
    // collection cannot support.
    for (const warning of [
      "ki_dialog_not_opened:target:api",
      "ki_displayed_count_unavailable:target:api",
      "ki_pagination_stuck:target:api",
    ]) {
      const report = computeIntegrity(
        baseArgs({ kiResults: [ki({ countMatches: true, warnings: [warning] })] }),
      );
      expect(report.integrity.known_issues_counts_valid).toBe(false);
      expect(report.collection.status).toBe("partial");
      expect(report.quality.warnings).toContain(warning);
    }
  });

  it("keeps counts valid when the only warning is informational", () => {
    const report = computeIntegrity(
      baseArgs({ kiResults: [ki({ countMatches: true, warnings: [] })] }),
    );
    expect(report.integrity.known_issues_counts_valid).toBe(true);
  });

  it("synthesizes a mismatch warning when countMatches false but warnings empty", () => {
    const bad = ki({ countMatches: false, collectedCount: 0, warnings: [] });
    const r = computeIntegrity(baseArgs({ kiResults: [bad] }));
    expect(r.collection.status).toBe("partial");
    expect(r.quality.warnings.some((w) => w.includes("ki_count_mismatch"))).toBe(
      true,
    );
  });

  it("an unavailable displayed count leaves the target unverified → partial", () => {
    // §21 requires every non-zero Known Issues target to be attempted *and
    // validated*. Without a displayed count there is nothing to validate
    // against, so the collection cannot call itself complete.
    const warn = ki({
      displayedCount: null,
      warnings: ["ki_displayed_count_unavailable:target:acme"],
    });
    const r = computeIntegrity(baseArgs({ kiResults: [warn] }));
    expect(r.collection.status).toBe("partial");
    expect(r.integrity.known_issues_counts_valid).toBe(false);
    expect(r.quality.warnings).toContain(
      "ki_displayed_count_unavailable:target:acme",
    );
  });

  it("missing required outcome → partial", () => {
    const outcomes = allOk().filter((o) => o.unitId !== "u06_collect_policy");
    const r = computeIntegrity(baseArgs({ outcomes }));
    expect(r.collection.status).toBe("partial");
    expect(r.collection.dom_status).toBe("partial");
    expect(r.integrity.required_sections_complete).toBe(false);
    expect(r.quality.warnings).toContain(
      "missing_required_unit:u06_collect_policy",
    );
  });

  it("required outcome failed → partial", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u05_collect_targets"
        ? { ...o, status: "failed" as const, warnings: ["selector_miss"] }
        : o,
    );
    const r = computeIntegrity(baseArgs({ outcomes }));
    expect(r.collection.status).toBe("partial");
    expect(r.collection.dom_status).toBe("partial");
    expect(r.integrity.required_sections_complete).toBe(false);
  });

  it("required outcome skipped → partial", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u07_collect_activity" ? { ...o, status: "skipped" as const } : o,
    );
    const r = computeIntegrity(baseArgs({ outcomes }));
    expect(r.collection.status).toBe("partial");
    expect(r.integrity.required_sections_complete).toBe(false);
  });

  it("domCriticalFailure session_expired → failed", () => {
    const r = computeIntegrity(baseArgs({ domCriticalFailure: "session_expired" }));
    expect(r.collection.status).toBe("failed");
    expect(r.collection.dom_status).toBe("failed");
  });

  it("domCriticalFailure trumps an already-partial collection", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u05_collect_targets" ? { ...o, status: "failed" as const } : o,
    );
    const r = computeIntegrity(
      baseArgs({ outcomes, domCriticalFailure: "tab_closed" }),
    );
    expect(r.collection.status).toBe("failed");
  });

  it("critical unit failed → failed (u09 internal failure)", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u09_build_evidence" ? { ...o, status: "failed" as const } : o,
    );
    const r = computeIntegrity(baseArgs({ outcomes }));
    expect(r.collection.status).toBe("failed");
  });

  it("critical+required unit failed (u03 details) → failed, not partial", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u03_collect_details" ? { ...o, status: "failed" as const } : o,
    );
    const r = computeIntegrity(baseArgs({ outcomes }));
    expect(r.collection.status).toBe("failed");
  });

  it("warning outcome on a required unit does not downgrade status", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u08_known_issues"
        ? { ...o, status: "warning" as const, warnings: ["ki_dialog_not_ready"] }
        : o,
    );
    const r = computeIntegrity(baseArgs({ outcomes }));
    expect(r.collection.status).toBe("complete");
    expect(r.integrity.required_sections_complete).toBe(true);
    expect(r.quality.warnings).toContain("ki_dialog_not_ready");
  });

  it("policy conflicts only set policy.*, never collection.status", () => {
    const conflicted = fact({
      status: "unspecified",
      conflict: {
        detected: true,
        evidence_refs: ["ev_a", "ev_b"],
        asserted_statuses: ["allowed", "prohibited"],
      },
      resolution: { status: "unresolved" },
    });
    const r = computeIntegrity(baseArgs({ facts: { automation: conflicted } }));
    expect(r.collection.status).toBe("complete");
    expect(r.policy).toEqual({
      conflicts_present: true,
      unresolved_conflicts: 1,
    });
  });

  it("evidence_hash_valid is false for a malformed corpus hash", () => {
    const r = computeIntegrity(baseArgs({ corpusHash: "not-a-hash" }));
    expect(r.integrity.evidence_hash_valid).toBe(false);
  });

  it("evidence_hash_valid is false when any evidence content_hash is malformed", () => {
    const r = computeIntegrity(
      baseArgs({ evidence: [ev("ev_1"), ev("ev_2", "bad")] }),
    );
    expect(r.integrity.evidence_hash_valid).toBe(false);
  });

  it("aggregates and dedupes warnings across outcomes and KI results", () => {
    const outcomes = allOk().map((o) =>
      o.unitId === "u04_api_enrichment"
        ? { ...o, status: "warning" as const, warnings: ["w1", "w1"] }
        : o.unitId === "u07_collect_activity"
          ? { ...o, status: "warning" as const, warnings: ["w2"] }
          : o,
    );
    const r = computeIntegrity(
      baseArgs({
        outcomes,
        kiResults: [ki({ warnings: ["w2", "w3"] })],
      }),
    );
    expect(r.quality.warnings).toEqual(["w1", "w2", "w3"]);
  });
});

describe("REQUIRED_UNIT_IDS", () => {
  it("covers the five required collection units", () => {
    expect([...REQUIRED_UNIT_IDS].sort()).toEqual(
      [
        "u03_collect_details",
        "u05_collect_targets",
        "u06_collect_policy",
        "u07_collect_activity",
        "u08_known_issues",
      ].sort(),
    );
  });
});
