import { describe, expect, it } from "vitest";
import type {
  RadarResultRow,
  RadarRunState,
} from "../lib/radar/coordinator";
import type { ProgramScore } from "../lib/radar/types";
import {
  buildRow,
  buildRows,
  componentRows,
  errorText,
  formatCoverage,
  formatScore,
  formatSignal,
  formatWeight,
  isActive,
  phaseLabel,
  programLabel,
  profileOptions,
  saturationRows,
  saturationText,
  statusText,
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
    ["done", "Done"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("phase %s → %s", (phase, label) => {
    expect(phaseLabel(phase)).toBe(label);
  });

  it.each(["catalog", "enriching", "scoring"] as const)(
    "phase %s is active",
    (phase) => {
      expect(isActive(runState({ phase }))).toBe(true);
    },
  );

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
      score: "82.4",
      coverage: "75%",
      reward: "0.82",
      surface: "0.60 (api 0.40 · web 0.30)",
      saturation: "0.25 · Moderate-low",
      freshness: "0.90",
      eligible: true,
      provisional: false,
    });
  });

  it("flags provisional scores in the score cell", () => {
    const view = buildRow(resultRow({ provisional: true }), 1);
    expect(view.score).toBe("82.4 provisional");
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
      { id: "fresh_programs", label: "Fresh Programs" },
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
