import { describe, expect, it } from "vitest";
import {
  buildExportRequest,
  EXPORT_DEFAULTS,
  exportBlockedReason,
  parseExportResponse,
} from "../entrypoints/radar/exportDialog";
import type { RadarRunState } from "../lib/radar/coordinator";

// Pure logic behind the export dialog — DOM wiring in main.ts stays a thin
// shell over these helpers (same convention as view.ts / radar-page.test.ts).

const blankCounts = () => ({
  complete: 0,
  unavailable: 0,
  failed: 0,
  no_baseline: 0,
  skipped: 0,
  absent: 0,
});

function runState(over: Partial<RadarRunState> = {}): RadarRunState {
  return {
    run_id: "radar_test",
    phase: "done",
    discovered: 1,
    enriched: 1,
    scored: 1,
    pending_uuids: [],
    completed_uuids: ["u"],
    warnings: 0,
    started_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:05:00Z",
    deep_pending_uuids: [],
    deep_completed_uuids: [],
    deep_enriched: 0,
    deep_candidates: [],
    deep_round: 0,
    deep_budget: 0,
    deep_stabilization: null,
    deep_sources: {
      known_issues: blankCounts(),
      semantic_diff: blankCounts(),
      scope_arc: blankCounts(),
      group_stats: blankCounts(),
    },
    ...over,
  };
}

describe("EXPORT_DEFAULTS", () => {
  it("pins the spec defaults: markdown · all profiles · top 50 · detail+diagnostics", () => {
    expect(EXPORT_DEFAULTS).toEqual({
      format: "markdown",
      scope: "all",
      limit: 50,
      detail: true,
      diagnostics: true,
    });
  });
});

describe("buildExportRequest", () => {
  it("scope 'all' emits a profile-less request", () => {
    const req = buildExportRequest({
      format: "csv",
      scope: "all",
      profile: "authz_api",
      limit: "all",
      detail: false,
      diagnostics: false,
    });
    expect(req).toEqual({
      op: "RADAR_EXPORT_REPORT",
      format: "csv",
      scope: "all",
      profile: undefined,
      limit: "all",
      detail: false,
      diagnostics: false,
    });
  });

  it("scope 'current' carries the page's selected profile", () => {
    const req = buildExportRequest({
      format: "markdown",
      scope: "current",
      profile: "low_competition",
      limit: 20,
      detail: true,
      diagnostics: true,
    });
    expect(req).toMatchObject({
      op: "RADAR_EXPORT_REPORT",
      scope: "current",
      profile: "low_competition",
      limit: 20,
    });
  });

  it("scope 'current' without a profile is rejected", () => {
    expect(
      buildExportRequest({
        format: "json",
        scope: "current",
        profile: null,
        limit: 50,
        detail: true,
        diagnostics: true,
      }),
    ).toBeNull();
  });
});

describe("exportBlockedReason", () => {
  it("null state (no run persisted) blocks with a reason", () => {
    expect(exportBlockedReason(null)).toMatch(/no scan/i);
  });
  it("a persisted run — even mid-scan — exports its snapshot", () => {
    expect(exportBlockedReason(runState())).toBeNull();
    expect(exportBlockedReason(runState({ phase: "enriching" }))).toBeNull();
  });
});

describe("parseExportResponse", () => {
  const payload = {
    filename: "radar-report-run-1-all-top50.md",
    mime: "text/markdown",
    body: "# Radar Report\n",
    content_hash: "sha256:" + "ab".repeat(32),
    generated_at: "2026-09-21T12:00:00.000Z",
  };

  it("unwraps a well-formed export envelope", () => {
    const res = parseExportResponse({ ok: true, export: payload });
    expect(res).toEqual({ ok: true, payload });
  });

  it("no_scan → friendly 'run a scan' message", () => {
    const res = parseExportResponse({ ok: false, error: "no_scan" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/no scan/i);
  });

  it("invalid_params → pick-a-profile message", () => {
    const res = parseExportResponse({ ok: false, error: "invalid_params" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/profile/i);
  });

  it("ok:true with a malformed export → message, never a crash", () => {
    const res = parseExportResponse({ ok: true, export: { mime: "text/x" } });
    expect(res.ok).toBe(false);
  });
});
