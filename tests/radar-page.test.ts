import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  RadarProgramDetail,
  RadarResultRow,
  RadarRunState,
  RadarScanSummary,
} from "../lib/radar/coordinator";
import { explainScore } from "../lib/radar/scoring";
import type { ProgramFeatureVector, ProgramScore } from "../lib/radar/types";
import {
  API_HEAVY_MIN,
  buildRow,
  buildRows,
  componentRows,
  deepFallback,
  deepSummaryText,
  densityBand,
  densityText,
  detailMetaText,
  detailRows,
  detailSlugSource,
  detailTitleText,
  engagementUrl,
  errorText,
  filterRows,
  formatCoverage,
  formatDelta,
  formatScore,
  formatSignal,
  formatWeight,
  isActive,
  opportunityBand,
  opportunityText,
  phaseLabel,
  programLabel,
  profileHasDeepStage,
  profileOptions,
  resolveResultsMode,
  RESULTS_MODE_OPTIONS,
  runHasDeepEvidence,
  saturationRows,
  saturationText,
  stabilizationLabel,
  statusText,
  summaryText,
  surfaceText,
} from "../entrypoints/radar/view";

// View-helper tests for the radar page (Task 21) — the DOM in main.ts is a
// thin shell; every formatting/ordering decision lives in these pure fns.

const UUID = "01234567-89ab-cdef-0123-456789abcdef";

function runState(over: Partial<RadarRunState> = {}): RadarRunState {
  return {
    run_id: "radar_test",
    phase: "enriching",
    discovered: 40,
    enriched: 12,
    scored: 0,
    pending_uuids: [],
    completed_uuids: [],
    deep_pending_uuids: [],
    deep_completed_uuids: [],
    deep_enriched: 0,
    deep_candidates: [],
    deep_round: 0,
    deep_budget: 0,
    deep_stabilization: null,
    warnings: 1,
    started_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:01:00Z",
    ...over,
  };
}

function resultRow(over: Partial<RadarResultRow> = {}): RadarResultRow {
  return {
    uuid: UUID,
    code: "acme",
    name: "Acme Corp",
    score: 82.4,
    confidence: 0.75,
    evidence_level: "metadata",
    metadata_score: 82.4,
    deep_score: null,
    score_delta: null,
    provisional: false,
    eligible: true,
    signals: {
      reward_potential: 0.82,
      meaningful_surface: 0.6,
      api_surface: 0.4,
      web_surface: 0.3,
      research_saturation: 0.25,
      freshness: 0.9,
      known_issue_density: null,
      opportunity_change: null,
      accessibility: null,
      authz_opportunity: null,
    },
    ...over,
  };
}

describe("formatSignal", () => {
  it("renders known values to two decimals", () => {
    expect(formatSignal(0.82)).toBe("0.82");
    expect(formatSignal(0)).toBe("0.00");
    expect(formatSignal(1)).toBe("1.00");
  });

  it("renders null as an em dash, never coerced to 0", () => {
    expect(formatSignal(null)).toBe("—");
  });
});

describe("formatScore / formatCoverage / formatWeight", () => {
  it("score is a 0–100 value with one decimal, or a dash", () => {
    expect(formatScore(82.36)).toBe("82.4");
    expect(formatScore(82)).toBe("82.0");
    expect(formatScore(null)).toBe("—");
  });

  it("coverage is a whole percentage", () => {
    expect(formatCoverage(0.756)).toBe("76%");
    expect(formatCoverage(0.6)).toBe("60%");
    expect(formatCoverage(0)).toBe("0%");
  });

  it("benefit weights render with a + sign", () => {
    expect(formatWeight(3, "benefit")).toBe("+3");
    expect(formatWeight(0.5, "benefit")).toBe("+0.5");
  });

  it("cost weights keep a positive magnitude with a (cost) marker", () => {
    expect(formatWeight(1.5, "cost")).toBe("+1.5 (cost)");
  });
});

describe("phaseLabel / isActive", () => {
  it.each([
    ["catalog", "Catalog scan"],
    ["enriching", "Enriching"],
    ["scoring", "Scoring"],
    ["deep_enriching", "Deep analysis of shortlist"],
    ["deep_scoring", "Deep scoring"],
    ["done", "Done"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("phase %s → %s", (phase, label) => {
    expect(phaseLabel(phase)).toBe(label);
  });

  it.each([
    "catalog",
    "enriching",
    "scoring",
    "deep_enriching",
    "deep_scoring",
  ] as const)("phase %s is active", (phase) => {
    expect(isActive(runState({ phase }))).toBe(true);
  });

  it.each(["done", "failed", "cancelled"] as const)(
    "phase %s is terminal",
    (phase) => {
      expect(isActive(runState({ phase }))).toBe(false);
    },
  );

  it("no run is not active", () => {
    expect(isActive(null)).toBe(false);
  });
});

describe("statusText", () => {
  it("prompts for a scan when no run exists", () => {
    expect(statusText(null)).toBe("No scan yet — press Scan programs.");
  });

  it("shows phase and counts while running", () => {
    expect(statusText(runState())).toBe(
      "Enriching — 40 discovered · 12 enriched · 0 scored · 1 warning",
    );
  });

  it("reads deep_enriching as deep analysis of the shortlist", () => {
    expect(statusText(runState({ phase: "deep_enriching" }))).toBe(
      "Deep analysis of shortlist — 40 discovered · 12 enriched · 0 scored · 1 warning",
    );
  });

  it("shows the summary verdict when done", () => {
    const state = runState({
      phase: "done",
      enriched: 38,
      scored: 228,
      warnings: 2,
      summary: {
        status: "complete",
        catalog_complete: true,
        discovered: 40,
        enriched: 38,
        enrichment_failed: 2,
        scored: 228,
        warnings: ["a", "b"],
      },
    });
    expect(statusText(state)).toBe(
      "Scan complete: 40 discovered · 38 enriched · 228 scored · 2 enrichment failures · 2 warnings",
    );
  });

  it("reports partial and failed runs honestly", () => {
    const partial = runState({
      phase: "done",
      summary: {
        status: "partial",
        catalog_complete: false,
        discovered: 40,
        enriched: 30,
        enrichment_failed: 0,
        scored: 180,
        warnings: [],
      },
    });
    expect(statusText(partial)).toContain("Scan partial:");
    const failed = runState({
      phase: "failed",
      summary: {
        status: "failed",
        catalog_complete: false,
        discovered: 0,
        enriched: 0,
        enrichment_failed: 0,
        scored: 0,
        warnings: [],
      },
    });
    expect(statusText(failed)).toContain("Scan failed:");
  });

  it("marks a cancelled run without needing a summary", () => {
    expect(statusText(runState({ phase: "cancelled" }))).toBe(
      "Cancelled — 40 discovered · 12 enriched · 0 scored · 1 warning",
    );
  });

  it("falls back to phase + counts when a terminal run has no summary", () => {
    expect(statusText(runState({ phase: "failed" }))).toBe(
      "Failed — 40 discovered · 12 enriched · 0 scored · 1 warning",
    );
  });
});

describe("programLabel / surfaceText", () => {
  it("prefers name, then code, then uuid", () => {
    expect(programLabel(resultRow())).toBe("Acme Corp");
    expect(programLabel(resultRow({ name: null }))).toBe("acme");
    expect(programLabel(resultRow({ name: null, code: null }))).toBe(UUID);
  });

  it("folds the three surface signals into one column", () => {
    expect(surfaceText(resultRow().signals)).toBe("0.60 (api 0.40 · web 0.30)");
  });

  it("omits unknown api/web surfaces", () => {
    const row = resultRow();
    row.signals.api_surface = null;
    row.signals.web_surface = null;
    expect(surfaceText(row.signals)).toBe("0.60");
  });

  it("renders an all-unknown surface as a dash", () => {
    const row = resultRow();
    row.signals.meaningful_surface = null;
    row.signals.api_surface = null;
    row.signals.web_surface = null;
    expect(surfaceText(row.signals)).toBe("—");
  });
});

describe("saturationText", () => {
  it("renders null as an em dash — never 0", () => {
    expect(saturationText(null)).toBe("—");
  });

  it("renders the numeric value plus an honest band label", () => {
    expect(saturationText(0.1)).toBe("0.10 · Low");
    expect(saturationText(0.3)).toBe("0.30 · Moderate-low");
    expect(saturationText(0.68)).toBe("0.68 · Moderate-high");
    expect(saturationText(0.9)).toBe("0.90 · High");
  });

  it("pins band boundaries", () => {
    expect(saturationText(0)).toBe("0.00 · Low");
    expect(saturationText(0.2)).toBe("0.20 · Moderate-low");
    expect(saturationText(0.45)).toBe("0.45 · Moderate-high");
    expect(saturationText(0.7)).toBe("0.70 · High");
    expect(saturationText(1)).toBe("1.00 · High");
  });
});

describe("saturationRows", () => {
  it("exposes the composite plus all three V1.2 inputs", () => {
    const rows = saturationRows({
      research_saturation: { value: 0.4 },
      researcher_competition: { value: 0.3 },
      submission_activity: { value: 0.7 },
      rewarded_activity: { value: 0.2 },
    } as never);
    expect(rows).toEqual([
      { label: "Research saturation", value: "0.40" },
      { label: "Recent crowding", value: "0.30" },
      { label: "Submission activity", value: "0.70" },
      { label: "Rewarded activity", value: "0.20" },
    ]);
  });

  it("dashes unknown inputs and handles a missing vector", () => {
    const rows = saturationRows({
      research_saturation: { value: null },
      researcher_competition: { value: 0.3 },
      submission_activity: { value: null },
      rewarded_activity: { value: 0.2 },
    } as never);
    expect(rows[0]!.value).toBe("—");
    expect(rows[2]!.value).toBe("—");
    expect(saturationRows(null).every((r) => r.value === "—")).toBe(true);
  });
});

describe("buildRow / buildRows", () => {
  it("maps a coordinator row onto display cells", () => {
    expect(buildRow(resultRow(), 1)).toEqual({
      uuid: UUID,
      rank: "1",
      program: "Acme Corp",
      programUrl: "https://bugcrowd.com/engagements/acme",
      evidence: "metadata",
      score: "82.4 (cov 75%)",
      scoreDelta: null,
      reward: "0.82",
      surface: "0.60 (api 0.40 · web 0.30)",
      saturation: "0.25 · Moderate-low",
      kiPressure: "—",
      opportunity: "—",
      access: "—",
      authz: "—",
      kiAnalyzed: false,
      opportunityAnalyzed: false,
      eligible: true,
      provisional: false,
    });
  });

  it("renders the V1.4 access/authz signals as plain values", () => {
    const row = resultRow();
    row.signals.accessibility = 0.9;
    row.signals.authz_opportunity = 0.1;
    const view = buildRow(row, 1);
    expect(view.access).toBe("0.90");
    expect(view.authz).toBe("0.10");
  });

  it("dashes the V1.4 signals when unknown — never 0.00", () => {
    const view = buildRow(resultRow(), 1);
    expect(view.access).toBe("—");
    expect(view.authz).toBe("—");
  });

  it("renders the V1.3 deep signals with bands when analyzed", () => {
    const row = resultRow();
    row.signals.known_issue_density = 0.61;
    row.signals.opportunity_change = 0.3;
    const view = buildRow(row, 1);
    expect(view.kiPressure).toBe("0.61 · High");
    expect(view.opportunity).toBe("0.30 · Moderate");
    expect(view.kiAnalyzed).toBe(true);
    expect(view.opportunityAnalyzed).toBe(true);
  });

  it("carries the evidence level through to the badge field", () => {
    expect(buildRow(resultRow(), 1).evidence).toBe("metadata");
    expect(
      buildRow(
        resultRow({ evidence_level: "deep", deep_score: 71 }),
        1,
      ).evidence,
    ).toBe("deep");
  });

  it("shows the score delta when both stage scores exist", () => {
    const row = resultRow({
      score: 61.4,
      confidence: 0.8,
      evidence_level: "deep",
      metadata_score: 72.8,
      deep_score: 61.4,
      score_delta: -11.4,
    });
    const view = buildRow(row, 1);
    expect(view.score).toBe("61.4 (Δ −11.4 · cov 80%)");
    expect(view.scoreDelta).toBe("Δ −11.4");
  });

  it("renders a positive delta with a + sign, never fabricated when null", () => {
    const up = buildRow(
      resultRow({ score_delta: 3.25, deep_score: 85.6, evidence_level: "deep" }),
      1,
    );
    expect(up.score).toBe("82.4 (Δ +3.3 · cov 75%)");
    expect(up.scoreDelta).toBe("Δ +3.3");
    const none = buildRow(resultRow({ score_delta: null }), 1);
    expect(none.score).toBe("82.4 (cov 75%)");
    expect(none.scoreDelta).toBeNull();
  });

  it("flags provisional scores in the score cell", () => {
    const view = buildRow(resultRow({ provisional: true }), 1);
    expect(view.score).toBe("82.4 (cov 75%) provisional");
    expect(view.provisional).toBe(true);
  });

  it("leaves an unscored provisional row as a dash", () => {
    const view = buildRow(
      resultRow({ score: null, provisional: true }),
      1,
    );
    expect(view.score).toBe("—");
  });

  it("carries the eligible flag and dashes unknown signals", () => {
    const row = resultRow({ score: null, eligible: false });
    row.signals.reward_potential = null;
    const view = buildRow(row, 7);
    expect(view.eligible).toBe(false);
    expect(view.score).toBe("—");
    expect(view.reward).toBe("—");
  });

  it("assigns 1-based ranks in coordinator order", () => {
    const second = resultRow({
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "Beta",
      score: 61,
    });
    const views = buildRows([resultRow(), second]);
    expect(views.map((v) => v.rank)).toEqual(["1", "2"]);
    expect(views.map((v) => v.program)).toEqual(["Acme Corp", "Beta"]);
  });
});

describe("componentRows", () => {
  const score: ProgramScore = {
    schema_version: 1,
    engagement_uuid: UUID,
    profile: "best_ev",
    scoring_version: "1.0.0",
    score: 82.4,
    confidence: 0.75,
    provisional: false,
    components: {
      reward_potential: {
        signal: 0.82,
        weight: 3,
        direction: "benefit",
        contribution: 2.46,
      },
      research_saturation: {
        signal: 0.4,
        weight: 1.5,
        direction: "cost",
        contribution: 0.9,
      },
      accessibility: {
        signal: null,
        weight: 2,
        direction: "benefit",
        contribution: null,
      },
    },
    reasons: ["REWARD_HIGH"],
    source_hash: "abc123",
  };

  it("renders signal, weight+direction, and contribution in declared order", () => {
    expect(componentRows(score)).toEqual([
      {
        key: "reward_potential",
        label: "Reward potential",
        signal: "0.82",
        weight: "+3",
        contribution: "2.46",
      },
      {
        key: "research_saturation",
        label: "Research saturation",
        signal: "0.40",
        weight: "+1.5 (cost)",
        contribution: "0.90",
      },
      {
        key: "accessibility",
        label: "Accessibility",
        signal: "—",
        weight: "+2",
        contribution: "—",
      },
    ]);
  });
});

describe("profileOptions", () => {
  it("lists the six V1 profiles in pinned order", () => {
    expect(profileOptions()).toEqual([
      { id: "best_ev", label: "Best EV" },
      { id: "low_competition", label: "Low Saturation" },
      { id: "high_reward", label: "High Reward" },
      { id: "authz_api", label: "AuthZ/API" },
      { id: "fresh_programs", label: "Fresh Opportunity" },
      { id: "easy_entry", label: "Easy Entry" },
    ]);
  });
});

describe("errorText", () => {
  it("passes through static protocol errors", () => {
    expect(errorText("forbidden")).toBe("forbidden");
    expect(errorText("unknown_message")).toBe("unknown_message");
  });

  it("renders API errors as kind: message", () => {
    expect(errorText({ kind: "unauthorized", message: "bad token" })).toBe(
      "unauthorized: bad token",
    );
  });

  it("falls back for missing or odd shapes", () => {
    expect(errorText(undefined)).toBe("unknown error");
    expect(errorText(null)).toBe("unknown error");
    expect(errorText({})).toBe("unknown error");
    expect(errorText({ kind: "rate_limited" })).toBe("rate_limited");
  });
});

describe("densityText / densityBand", () => {
  it("renders null as an em dash — never 0 or n/a", () => {
    expect(densityText(null)).toBe("—");
  });

  it("renders the value plus an honest band label", () => {
    expect(densityText(0.1)).toBe("0.10 · Low");
    expect(densityText(0.4)).toBe("0.40 · Moderate");
    expect(densityText(0.61)).toBe("0.61 · High");
  });

  it("pins band boundaries", () => {
    expect(densityBand(0)).toBe("Low");
    expect(densityBand(0.25)).toBe("Moderate");
    expect(densityBand(0.6)).toBe("High");
    expect(densityBand(1)).toBe("High");
  });
});

describe("opportunityText / opportunityBand", () => {
  it("renders null as an em dash — never 0", () => {
    expect(opportunityText(null)).toBe("—");
  });

  it("renders the value plus an honest band label", () => {
    expect(opportunityText(0.1)).toBe("0.10 · Low");
    expect(opportunityText(0.3)).toBe("0.30 · Moderate");
    expect(opportunityText(0.9)).toBe("0.90 · High");
  });

  it("pins band boundaries", () => {
    expect(opportunityBand(0)).toBe("Low");
    expect(opportunityBand(0.25)).toBe("Moderate");
    expect(opportunityBand(0.6)).toBe("High");
    expect(opportunityBand(1)).toBe("High");
  });
});

describe("engagementUrl", () => {
  it("builds the canonical engagement URL from the code slug", () => {
    expect(engagementUrl(resultRow())).toBe(
      "https://bugcrowd.com/engagements/acme",
    );
  });

  it("falls back to the uuid when no code exists", () => {
    expect(engagementUrl(resultRow({ code: null }))).toBe(
      `https://bugcrowd.com/engagements/${UUID}`,
    );
  });

  it("refuses to build a URL for an unsafe slug", () => {
    expect(engagementUrl(resultRow({ code: "bad slug" }))).toBeNull();
    expect(engagementUrl(resultRow({ code: "../admin" }))).toBeNull();
    expect(engagementUrl(resultRow({ code: "" }))).toBeNull();
    expect(
      engagementUrl(resultRow({ code: null, uuid: "not a slug!" })),
    ).toBeNull();
  });
});

function programDetail(over: Partial<RadarProgramDetail> = {}): RadarProgramDetail {
  return {
    snapshot: {
      schema_version: 1,
      uuid: UUID,
      code: "acme",
      catalog: {
        uuid: UUID,
        code: "acme",
        name: "Acme Corp",
        lifecycle_status: "live",
        engagement_type: "bug_bounty",
        discovered_at: "2026-09-20T00:00:00Z",
      },
      detail: null,
      enrichment: { status: "complete" },
      deep: {
        status: "complete",
        known_issues: {
          status: "complete",
          unique_count: 90,
          total_count: 224,
        },
        semantic_diff: {
          status: "complete",
          from_version: "3f5d9ee5aaaa",
          to_version: "9c1f2b34bbbb",
          added_targets: 7,
          removed_targets: 2,
          added_in_scope_targets: 5,
          removed_in_scope_targets: 1,
          moved_in_scope: 0,
          moved_out_of_scope: 0,
          added_api_targets: 3,
          added_web_targets: 2,
          added_groups: 1,
          reward_increase: true,
          reward_decrease: false,
          safe_harbor_changed: false,
          status_changed: false,
          only_administrative_changes: false,
        },
      },
      source_hash: "deadbeef",
    },
    score: null,
    metadata_score: null,
    deep_score: null,
    vector: {
      known_issue_density: { value: 0.61 },
      opportunity_change: { value: 0.3 },
      freshness: { value: 0.9 },
    } as unknown as ProgramFeatureVector,
    explanation: [],
    catalog: null,
    ...over,
  };
}

describe("detailSlugSource / detailTitleText", () => {
  it("prefers the catalog identity, code for the slug", () => {
    const detail = programDetail({
      catalog: {
        uuid: "cat-uuid",
        code: "catcode",
        name: "Catalog Name",
        lifecycle_status: null,
        engagement_type: null,
        discovered_at: "2026-09-20T00:00:00Z",
      },
    });
    expect(detailSlugSource(detail, "fallback")).toEqual({
      uuid: "cat-uuid",
      code: "catcode",
    });
    expect(detailTitleText(detail, "fallback")).toBe("Catalog Name");
  });

  it("falls back to the snapshot catalog/code then the uuid", () => {
    const detail = programDetail();
    expect(detailSlugSource(detail, "fallback")).toEqual({
      uuid: UUID,
      code: "acme",
    });
    expect(detailTitleText(detail, "fallback")).toBe("Acme Corp");
    expect(detailTitleText(programDetail({ snapshot: null }), "fallback")).toBe(
      "fallback",
    );
  });
});

describe("detailMetaText", () => {
  const score = (n: number, over: Partial<ProgramScore> = {}): ProgramScore => ({
    schema_version: 1,
    engagement_uuid: UUID,
    profile: "best_ev",
    scoring_version: "1.0.0",
    score: n,
    confidence: 0.75,
    provisional: false,
    components: {},
    reasons: [],
    source_hash: "x",
    ...over,
  });

  it("labels a metadata-only score as Meta, keeping freshness visible", () => {
    const s = score(82.4);
    expect(
      detailMetaText(programDetail({ score: s, metadata_score: s })),
    ).toBe("Meta 82.4 · coverage 75% · freshness 0.90");
  });

  it("shows both stage scores plus the delta when deep-analyzed", () => {
    const meta = score(72.8);
    const deep = score(61.4, { confidence: 0.8 });
    expect(
      detailMetaText(
        programDetail({ score: deep, metadata_score: meta, deep_score: deep }),
      ),
    ).toBe("Meta 72.8 · Deep 61.4 · Δ −11.4 · coverage 80% · freshness 0.90");
  });

  it("shows a positive delta honestly", () => {
    const meta = score(50);
    const deep = score(53.3);
    expect(
      detailMetaText(
        programDetail({ score: deep, metadata_score: meta, deep_score: deep }),
      ),
    ).toContain("Meta 50.0 · Deep 53.3 · Δ +3.3");
  });

  it("labels a deep-only score as Deep", () => {
    const deep = score(61.4);
    expect(
      detailMetaText(programDetail({ score: deep, deep_score: deep })),
    ).toBe("Deep 61.4 · coverage 75% · freshness 0.90");
  });

  it("falls back to a bare Score when stage fields are missing", () => {
    expect(detailMetaText(programDetail({ score: score(82.4) }))).toBe(
      "Score 82.4 · coverage 75% · freshness 0.90",
    );
  });

  it("marks provisional scores", () => {
    const s = score(82.4, { provisional: true });
    expect(
      detailMetaText(programDetail({ score: s, metadata_score: s })),
    ).toBe("Meta 82.4 · coverage 75% · PROVISIONAL · freshness 0.90");
  });

  it("omits freshness when unknown and reports an unscored profile", () => {
    const detail = programDetail({ vector: null });
    expect(detailMetaText(detail)).toBe("No score stored for this profile.");
  });

  it("still shows freshness when no score is stored", () => {
    expect(detailMetaText(programDetail())).toBe(
      "No score stored for this profile · freshness 0.90",
    );
  });
});

describe("filterRows", () => {
  const rows = [
    resultRow({ uuid: "a", name: "A" }),
    resultRow({ uuid: "b", name: "B" }),
  ];
  rows[0]!.signals.research_saturation = 0.1;
  rows[0]!.signals.known_issue_density = 0.2;
  rows[0]!.signals.opportunity_change = 0.7;
  rows[0]!.signals.reward_potential = 0.9;
  rows[0]!.signals.api_surface = 0.6;
  rows[1]!.signals.research_saturation = 0.8;
  rows[1]!.signals.known_issue_density = 0.5;
  rows[1]!.signals.opportunity_change = 0.2;
  rows[1]!.signals.reward_potential = 0.4;
  rows[1]!.signals.api_surface = 0.1;

  it("passes everything when no criterion is set", () => {
    expect(filterRows(rows, {})).toHaveLength(2);
    expect(
      filterRows(rows, {
        maxSaturation: null,
        maxKiPressure: null,
        minOpportunity: null,
        minReward: null,
        apiHeavy: false,
      }),
    ).toHaveLength(2);
  });

  it("applies each numeric criterion honestly", () => {
    expect(filterRows(rows, { maxSaturation: 0.5 })).toEqual([rows[0]]);
    expect(filterRows(rows, { maxKiPressure: 0.3 })).toEqual([rows[0]]);
    expect(filterRows(rows, { minOpportunity: 0.5 })).toEqual([rows[0]]);
    expect(filterRows(rows, { minReward: 0.8 })).toEqual([rows[0]]);
  });

  it("treats boundary values as inclusive", () => {
    expect(filterRows(rows, { maxSaturation: 0.8 })).toHaveLength(2);
    expect(filterRows(rows, { minReward: 0.9 })).toEqual([rows[0]]);
  });

  it("fails rows whose signal is null — unknown cannot pass a threshold", () => {
    const unknown = resultRow({ uuid: "u" });
    unknown.signals.known_issue_density = null;
    unknown.signals.opportunity_change = null;
    unknown.signals.research_saturation = null;
    unknown.signals.reward_potential = null;
    const all = [...rows, unknown];
    expect(filterRows(all, { maxKiPressure: 0.9 })).toHaveLength(2);
    expect(filterRows(all, { minOpportunity: 0 })).toHaveLength(2);
    expect(filterRows(all, { maxSaturation: 1 })).toHaveLength(2);
    expect(filterRows(all, { minReward: 0 })).toHaveLength(2);
    // …but with no criterion set the unknown row still shows.
    expect(filterRows(all, {})).toHaveLength(3);
  });

  it(`api-heavy keeps api_surface >= ${API_HEAVY_MIN}, fails null`, () => {
    expect(API_HEAVY_MIN).toBe(0.4);
    expect(filterRows(rows, { apiHeavy: true })).toEqual([rows[0]]);
    const unknown = resultRow({ uuid: "u" });
    unknown.signals.api_surface = null;
    expect(filterRows([unknown], { apiHeavy: true })).toHaveLength(0);
  });

  it("combines criteria conjunctively", () => {
    expect(
      filterRows(rows, {
        maxSaturation: 0.5,
        maxKiPressure: 0.3,
        minOpportunity: 0.5,
        minReward: 0.8,
        apiHeavy: true,
      }),
    ).toEqual([rows[0]]);
    expect(
      filterRows(rows, { maxSaturation: 0.5, minReward: 0.95 }),
    ).toHaveLength(0);
  });
});

describe("detailRows", () => {
  it("renders both diagnostic groups from a deep-analyzed snapshot", () => {
    const groups = detailRows(programDetail());
    expect(groups.map((g) => g.title)).toEqual([
      "Known-issue intelligence",
      "Opportunity changes",
      "Access & authorization",
    ]);
    expect(groups[0]!.rows).toEqual([
      { label: "Unique known issues", value: "90" },
      { label: "Total (incl. duplicates)", value: "224" },
      { label: "Known issue density", value: "0.61 · High" },
      { label: "Source status", value: "complete" },
    ]);
    expect(groups[1]!.rows).toEqual([
      { label: "Current version", value: "9c1f2b34" },
      { label: "Baseline version", value: "3f5d9ee5" },
      { label: "Targets added", value: "7 (5 in scope)" },
      { label: "Targets removed", value: "2 (1 in scope)" },
      { label: "API targets added", value: "3" },
      { label: "Reward change", value: "↑" },
      { label: "Status change", value: "no" },
      { label: "Safe harbor change", value: "no" },
      { label: "Opportunity change", value: "0.30 · Moderate" },
      { label: "Source status", value: "complete" },
    ]);
    // The V1.4 metadata signals read from the embedded vector — the
    // fixture omits them, so they render as honest dashes.
    expect(groups[2]!.rows).toEqual([
      { label: "Accessibility", value: "—" },
      { label: "AuthZ opportunity", value: "—" },
    ]);
  });

  it("renders the access/authz readings when the vector carries them", () => {
    const detail = programDetail();
    detail.vector = {
      ...detail.vector,
      accessibility: { value: 0.8 },
      authz_opportunity: { value: 0.1 },
    } as unknown as ProgramFeatureVector;
    const groups = detailRows(detail);
    expect(groups[2]!.rows).toEqual([
      { label: "Accessibility", value: "0.80" },
      { label: "AuthZ opportunity", value: "0.10" },
    ]);
  });

  it("dashes the access/authz rows when no vector is embedded", () => {
    const groups = detailRows(programDetail({ vector: null }));
    expect(groups[2]!.rows).toEqual([
      { label: "Accessibility", value: "—" },
      { label: "AuthZ opportunity", value: "—" },
    ]);
  });

  it("reads 'not analyzed' + dashes when no deep pass ran", () => {
    const detail = programDetail({ vector: null });
    detail.snapshot!.deep = null;
    const groups = detailRows(detail);
    for (const group of groups) {
      for (const row of group.rows) {
        expect(row.value === "—" || row.value === "not analyzed").toBe(true);
      }
    }
    expect(groups[0]!.rows[3]!.value).toBe("not analyzed");
    expect(groups[1]!.rows[9]!.value).toBe("not analyzed");
  });

  it("carries source status words through honestly", () => {
    const detail = programDetail();
    detail.snapshot!.deep = {
      status: "partial",
      known_issues: { status: "unavailable", unique_count: null, total_count: null },
      semantic_diff: {
        status: "no_baseline",
        from_version: null,
        to_version: "9c1f2b34bbbb",
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
      },
    };
    const groups = detailRows(detail);
    expect(groups[0]!.rows).toEqual([
      { label: "Unique known issues", value: "—" },
      { label: "Total (incl. duplicates)", value: "—" },
      { label: "Known issue density", value: "0.61 · High" },
      { label: "Source status", value: "unavailable" },
    ]);
    expect(groups[1]!.rows[1]!.value).toBe("—"); // no baseline version
    expect(groups[1]!.rows[0]!.value).toBe("9c1f2b34"); // current still shown
    expect(groups[1]!.rows[5]!.value).toBe("—"); // reward change unknown
    expect(groups[1]!.rows[9]!.value).toBe("no baseline");
  });
});

// ---------------------------------------------------------------------------
// V1.3.1 — evidence levels: mode toggle, badges, deltas, stabilization.
// ---------------------------------------------------------------------------

const RADAR_HTML = readFileSync(
  join(process.cwd(), "entrypoints/radar/index.html"),
  "utf8",
);

function deepSummary(over: Partial<RadarScanSummary> = {}): RadarScanSummary {
  return {
    status: "complete",
    catalog_complete: true,
    discovered: 40,
    enriched: 38,
    enrichment_failed: 0,
    scored: 228,
    warnings: [],
    deep_candidates: 44,
    deep_analyzed: 44,
    deep_rounds: 2,
    deep_budget: 60,
    deep_stabilization: "stable",
    ...over,
  };
}

describe("formatDelta", () => {
  it("renders negative deltas with a U+2212 minus", () => {
    expect(formatDelta(-11.4)).toBe("−11.4");
    expect(formatDelta(-0.05)).toBe("−0.1");
  });

  it("renders positive and zero deltas with a + sign", () => {
    expect(formatDelta(3.25)).toBe("+3.3");
    expect(formatDelta(0)).toBe("+0.0");
    expect(formatDelta(-0.01)).toBe("+0.0"); // −0 is not a sign lie
  });
});

describe("results mode toggle", () => {
  it("offers honest labels: Deep ranking / All candidates (metadata)", () => {
    expect(RESULTS_MODE_OPTIONS).toEqual([
      { value: "deep", label: "Deep ranking" },
      { value: "metadata", label: "All candidates (metadata)" },
    ]);
  });

  it("knows which profiles have a deep stage", () => {
    for (const id of [
      "best_ev",
      "fresh_programs",
      "low_competition",
      "authz_api",
    ] as const) {
      expect(profileHasDeepStage(id)).toBe(true);
    }
    expect(profileHasDeepStage("high_reward")).toBe(false);
    expect(profileHasDeepStage("easy_entry")).toBe(false);
  });

  it("detects deep evidence from the summary or live counters", () => {
    expect(runHasDeepEvidence(null)).toBe(false);
    expect(runHasDeepEvidence(runState())).toBe(false);
    expect(
      runHasDeepEvidence(
        runState({ deep_completed_uuids: ["a", "b"] }),
      ),
    ).toBe(true);
    expect(
      runHasDeepEvidence(
        runState({ phase: "done", summary: deepSummary() }),
      ),
    ).toBe(true);
    expect(
      runHasDeepEvidence(
        runState({ phase: "done", summary: deepSummary({ deep_analyzed: 0 }) }),
      ),
    ).toBe(false);
  });

  it("defaults a deep profile to deep when deep scores plausibly exist", () => {
    const state = runState({ deep_completed_uuids: ["a"] });
    expect(resolveResultsMode("best_ev", state, null)).toEqual({
      offered: true,
      requested: "deep",
      note: null,
    });
  });

  it("defaults to metadata with an honest note when no deep stage ran", () => {
    const state = runState({ phase: "done", summary: deepSummaryAbsent() });
    const res = resolveResultsMode("best_ev", state, null);
    expect(res.requested).toBe("metadata");
    expect(res.note).toBe(
      "Latest run produced no deep-stage scores — metadata view.",
    );
  });

  it("says pending while a run is still in an early phase", () => {
    const res = resolveResultsMode("best_ev", runState(), null);
    expect(res.requested).toBe("metadata");
    expect(res.note).toBe("Deep analysis pending — metadata view.");
    expect(resolveResultsMode("best_ev", null, null).note).toBe(
      "No scan yet — metadata view.",
    );
  });

  it("respects an explicit choice without second-guessing it", () => {
    const state = runState({ phase: "done", summary: deepSummaryAbsent() });
    expect(resolveResultsMode("best_ev", state, "deep")).toEqual({
      offered: true,
      requested: "deep",
      note: null,
    });
    expect(
      resolveResultsMode("best_ev", runState({ deep_completed_uuids: ["a"] }), "metadata"),
    ).toEqual({ offered: true, requested: "metadata", note: null });
  });

  it("hides the toggle for metadata-only profiles with an honest note", () => {
    const res = resolveResultsMode("high_reward", null, null);
    expect(res.offered).toBe(false);
    expect(res.requested).toBe("metadata");
    expect(res.note).toBe(
      "High Reward has no deep signals — metadata view.",
    );
    expect(resolveResultsMode("easy_entry", null, "deep").requested).toBe(
      "metadata",
    );
    expect(resolveResultsMode("easy_entry", null, "deep").note).toBe(
      "Easy Entry has no deep signals — metadata view.",
    );
  });
});

describe("deepFallback", () => {
  it("keeps deep rows when the deep ranking is non-empty", () => {
    const deep = [resultRow({ evidence_level: "deep", deep_score: 61 })];
    expect(deepFallback(deep, [resultRow()])).toEqual({
      rows: deep,
      mode: "deep",
      note: null,
    });
  });

  it("falls back to metadata rows with an honest note when deep is empty", () => {
    const meta = [resultRow()];
    const fb = deepFallback([], meta);
    expect(fb.mode).toBe("metadata");
    expect(fb.rows).toBe(meta);
    expect(fb.note).toBe(
      "Deep ranking is empty — no deep-stage scores yet; " +
        "showing all candidates (metadata).",
    );
  });

  it("stays deep with no note when both rankings are empty", () => {
    expect(deepFallback([], [])).toEqual({ rows: [], mode: "deep", note: null });
  });
});

describe("stabilization status", () => {
  it("labels each verdict, null included", () => {
    expect(stabilizationLabel("stable")).toBe("Top-20 stable");
    expect(stabilizationLabel("budget_limited")).toBe("budget-limited");
    expect(stabilizationLabel("incomplete")).toBe("incomplete");
    expect(stabilizationLabel(null)).toBeNull();
    expect(stabilizationLabel(undefined)).toBeNull();
  });

  it("renders the deep segment of a terminal summary", () => {
    expect(deepSummaryText(deepSummary())).toBe(
      "Deep: 44 analyzed · 2 rounds · Top-20 stable",
    );
    expect(
      deepSummaryText(
        deepSummary({
          deep_analyzed: 44,
          deep_candidates: 60,
          deep_stabilization: "budget_limited",
        }),
      ),
    ).toBe("Deep: 44 of 60 analyzed · 2 rounds · budget-limited");
  });

  it("omits the verdict word when stabilization is null", () => {
    expect(
      deepSummaryText(
        deepSummary({ deep_stabilization: null, deep_rounds: 1 }),
      ),
    ).toBe("Deep: 44 analyzed · 1 round");
  });

  it("returns null when the summary carries no deep fields", () => {
    expect(deepSummaryText(deepSummaryAbsent())).toBeNull();
  });

  it("joins the deep segment into the scan verdict line", () => {
    const state = runState({
      phase: "done",
      scored: 228,
      enriched: 38,
      warnings: 2,
      summary: deepSummary(),
    });
    expect(statusText(state)).toBe(
      "Scan complete: 40 discovered · 38 enriched · 228 scored · " +
        "Deep: 44 analyzed · 2 rounds · Top-20 stable · 2 warnings",
    );
  });

  it("shows deep progress with the round number during deep phases", () => {
    const state = runState({
      phase: "deep_scoring",
      deep_candidates: [
        { uuid: "a", reasons: [] },
        { uuid: "b", reasons: [] },
      ],
      deep_completed_uuids: ["a"],
      deep_round: 2,
    });
    expect(statusText(state)).toBe(
      "Deep scoring — 1/2 analyzed · round 2 · " +
        "40 discovered · 12 enriched · 0 scored · 1 warning",
    );
  });

  it("omits the deep fragment until a shortlist exists", () => {
    expect(statusText(runState({ phase: "deep_enriching" }))).toBe(
      "Deep analysis of shortlist — 40 discovered · 12 enriched · 0 scored · 1 warning",
    );
  });
});

describe("results table markup", () => {
  it("labels the column KI Pressure, never Dup", () => {
    expect(RADAR_HTML).toContain("KI Pressure");
    expect(RADAR_HTML).not.toContain(">Dup<");
    expect(RADAR_HTML).not.toContain('id="f-dup"');
  });

  it("carries honest tooltips on the deep-signal columns", () => {
    expect(RADAR_HTML).toContain(
      "Known-Issue pressure proxy from unique known issues and meaningful " +
        "target surface — not duplicate probability.",
    );
    expect(RADAR_HTML).toContain(
      "Semantic changelog expansion score — latest vs previous brief; " +
        "not a bug-finding probability.",
    );
  });

  it("ships the mode toggle with both honest labels", () => {
    expect(RADAR_HTML).toContain('id="mode"');
    expect(RADAR_HTML).toContain("Deep ranking");
    expect(RADAR_HTML).toContain("All candidates (metadata)");
  });

  it("adds V1.4 Access and AuthZ columns after Opportunity", () => {
    const access = RADAR_HTML.search(/>\s*Access\s*</);
    const authz = RADAR_HTML.search(/>\s*AuthZ\s*</);
    const opportunity = RADAR_HTML.search(/>\s*Opportunity\s*</);
    expect(access).toBeGreaterThan(-1);
    expect(authz).toBeGreaterThan(-1);
    expect(authz).toBeGreaterThan(access);
    expect(access).toBeGreaterThan(opportunity);
  });
});

describe("filterRows null semantics (V1.3.1)", () => {
  it("a META row never passes a KI Pressure or Opportunity threshold", () => {
    const meta = resultRow({ uuid: "m", evidence_level: "metadata" });
    meta.signals.known_issue_density = null;
    meta.signals.opportunity_change = null;
    expect(filterRows([meta], { maxKiPressure: 1 })).toHaveLength(0);
    expect(filterRows([meta], { minOpportunity: 0 })).toHaveLength(0);
    // …but with no criterion set the row still shows — null is unknown,
    // not a hidden failure.
    expect(filterRows([meta], {})).toHaveLength(1);
  });

  it("a DEEP row is judged on its real deep-signal values", () => {
    const deep = resultRow({ uuid: "d", evidence_level: "deep" });
    deep.signals.known_issue_density = 0.5;
    deep.signals.opportunity_change = 0.7;
    expect(filterRows([deep], { maxKiPressure: 0.4 })).toHaveLength(0);
    expect(filterRows([deep], { maxKiPressure: 0.6 })).toHaveLength(1);
    expect(filterRows([deep], { minOpportunity: 0.8 })).toHaveLength(0);
    expect(filterRows([deep], { minOpportunity: 0.7 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// V1.4 — Access/AuthZ columns + the reason codes the detail pane's
// explanation list renders verbatim (explainScore lines land in
// detail.explanation via the coordinator).
// ---------------------------------------------------------------------------

describe("V1.4 access/authz explanation lines", () => {
  const scoreWith = (reasons: string[]): ProgramScore => ({
    schema_version: 1,
    engagement_uuid: UUID,
    profile: "easy_entry",
    scoring_version: "1.4.0",
    score: 60,
    confidence: 0.5,
    provisional: false,
    components: {},
    reasons,
    source_hash: "x",
  });

  it("renders ACCESS_OPEN as a positive line", () => {
    expect(explainScore(scoreWith(["ACCESS_OPEN"]))).toEqual([
      "+ open access program",
    ]);
  });

  it("renders AUTHZ_PROHIBITED as a caution line", () => {
    expect(explainScore(scoreWith(["AUTHZ_PROHIBITED"]))).toEqual([
      "- cross-account testing prohibited",
    ]);
  });

  it("renders ACCESS_GATED and AUTHZ_SURFACE through their pinned text", () => {
    expect(
      explainScore(scoreWith(["ACCESS_GATED", "AUTHZ_SURFACE"])),
    ).toEqual([
      "- restricted or gated access",
      "+ authenticated authz test surface",
    ]);
  });
});

function deepSummaryAbsent(): RadarScanSummary {
  return {
    status: "complete",
    catalog_complete: true,
    discovered: 40,
    enriched: 38,
    enrichment_failed: 0,
    scored: 228,
    warnings: [],
  };
}
