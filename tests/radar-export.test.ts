import { describe, expect, it } from "vitest";
import {
  csvEscape,
  radarExportContentHash,
  radarExportFileName,
  renderRadarCsv,
  renderRadarJson,
  renderRadarMarkdown,
  serializeRadarExport,
  type RadarExportData,
  type RadarExportRow,
  type RadarExportRowDetail,
} from "../lib/radar/export";
import { RADAR_FEATURE_KEYS } from "../lib/radar/types";
import type { RadarFeatureKey } from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Radar report export — serializer tests over a deterministic in-memory
// fixture. No store, no clock: RadarExportData is already the assembled
// snapshot, so identical input must produce byte-identical output.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";
const T1 = "2026-09-21T00:04:00.000Z";

function signals(over: Partial<Record<RadarFeatureKey, number | null>> = {}) {
  const base = Object.fromEntries(
    RADAR_FEATURE_KEYS.map((k) => [k, null]),
  ) as Record<RadarFeatureKey, number | null>;
  return { ...base, ...over };
}

function signalMeta() {
  return Object.fromEntries(
    RADAR_FEATURE_KEYS.map((k) => [
      k,
      { source: "engagement_detail", reason_code: `${k}_rule` },
    ]),
  ) as RadarExportRowDetail["signal_meta"];
}

function detail(): RadarExportRowDetail {
  return {
    stages: [
      {
        stage: "metadata",
        scoring_version: "1.5.0",
        source_hash: `sha256:${"a".repeat(64)}`,
        score: 61.4,
        confidence: 0.8,
        provisional: false,
        components: {
          reward_potential: {
            signal: 0.6,
            weight: 3,
            direction: "benefit",
            contribution: 1.8,
          },
          research_saturation: {
            signal: 0.1,
            weight: 1.5,
            direction: "cost",
            contribution: 1.35,
          },
          known_issue_density: {
            signal: null,
            weight: 1,
            direction: "cost",
            contribution: null,
          },
        },
        reasons: ["REWARD_MEDIUM", "UNKNOWN_KNOWN_ISSUE_DENSITY"],
      },
      {
        stage: "deep",
        scoring_version: "1.5.0",
        source_hash: `sha256:${"b".repeat(64)}`,
        score: 55.0,
        confidence: 1,
        provisional: false,
        components: {
          reward_potential: {
            signal: 0.6,
            weight: 3,
            direction: "benefit",
            contribution: 1.8,
          },
          known_issue_density: {
            signal: 0.42,
            weight: 1,
            direction: "cost",
            contribution: 0.58,
          },
        },
        reasons: ["REWARD_MEDIUM"],
      },
    ],
    signal_meta: signalMeta(),
  };
}

function row(over: Partial<RadarExportRow> = {}): RadarExportRow {
  return {
    rank: 1,
    uuid: "prog-1",
    slug: "prog-1",
    engagement_url: "https://bugcrowd.com/engagements/prog-1",
    name: "Program One",
    score: 61.4,
    metadata_score: 61.4,
    deep_score: 55.0,
    score_delta: -6.4,
    evidence_level: "deep",
    coverage: 0.8,
    percentile: 90.0,
    eligible: true,
    provisional: false,
    restricted_access: false,
    source_hash: `sha256:${"a".repeat(64)}`,
    scoring_version: "1.5.0",
    reasons: ["REWARD_MEDIUM", "SATURATION_LOW"],
    signals: signals({ reward_potential: 0.6, research_saturation: 0.1 }),
    enrichment_status: "complete",
    detail: detail(),
    deep: {
      status: "complete",
      known_issues: {
        status: "complete",
        unique_count: 5,
        total_count: 20,
        group_stats: {
          status: "skipped_low_volume",
          groups_fetched: 0,
          groups_total: 2,
        },
      },
      semantic_diff: {
        status: "complete",
        from_version: "v-0",
        to_version: "v-1",
      },
      scope_arc: { status: "no_baseline", window_versions: null },
    },
    ...over,
  };
}

export function exportData(over: Partial<RadarExportData> = {}): RadarExportData {
  return {
    run: {
      run_id: "radar_test01",
      phase: "done",
      started_at: T0,
      updated_at: T1,
      status: "complete",
      catalog_complete: true,
      discovered: 3,
      enriched: 3,
      enrichment_failed: 0,
      scored: 3,
      warnings: 0,
      warning_details: [],
      deep_candidates: 1,
      deep_analyzed: 1,
      deep_enriched: 1,
      deep_rounds: 1,
      deep_budget: 60,
      deep_stabilization: "stable",
    },
    provenance: {
      schema: "bce-radar-export",
      schema_version: 1,
      app_version: "0.1.0",
      commit_sha: "abc1234",
    },
    options: {
      profiles: ["best_ev", "easy_entry"],
      limit: 50,
      detail: true,
      diagnostics: true,
    },
    restricted_access: { count: 0, programs: [] },
    sections: [
      {
        profile_id: "best_ev",
        profile_version: "1.5.0",
        profile_label: "Best EV",
        min_confidence: 0.6,
        total_ranked: 3,
        eligible_count: 2,
        exported_count: 3,
        rows: [
          row(),
          row({
            rank: 2,
            uuid: "prog-2",
            slug: "prog-2",
            engagement_url: "https://bugcrowd.com/engagements/prog-2",
            name: "Second Program",
            score: 40.0,
            metadata_score: 40.0,
            deep_score: null,
            score_delta: null,
            evidence_level: "metadata",
            percentile: 50.0,
            signals: signals({ reward_potential: 0 }),
            deep: null,
          }),
          row({
            rank: 3,
            uuid: "prog-3",
            slug: "prog3",
            engagement_url: null,
            name: null,
            score: null,
            metadata_score: null,
            deep_score: null,
            score_delta: null,
            evidence_level: "metadata",
            coverage: 0,
            percentile: null,
            eligible: false,
            provisional: true,
            signals: signals(),
            deep: null,
          }),
        ],
      },
      {
        profile_id: "easy_entry",
        profile_version: "1.4.0",
        profile_label: "Easy Entry",
        min_confidence: 0.3,
        total_ranked: 1,
        eligible_count: 1,
        exported_count: 1,
        rows: [
          row({
            rank: 1,
            uuid: "prog-1",
            score: 72.5,
            metadata_score: 72.5,
            deep_score: null,
            score_delta: null,
            evidence_level: "metadata",
            percentile: 0.0,
            scoring_version: "1.4.0",
            reasons: ["ACCESS_OPEN"],
            deep: null,
          }),
        ],
      },
    ],
    diagnostics: {
      deep_candidates: 1,
      deep_analyzed: 1,
      not_analyzed: 0,
      sub_sources: {
        known_issues: {
          complete: 1,
          unavailable: 0,
          failed: 0,
          no_baseline: 0,
          skipped: 0,
          absent: 0,
        },
        semantic_diff: {
          complete: 1,
          unavailable: 0,
          failed: 0,
          no_baseline: 0,
          skipped: 0,
          absent: 0,
        },
        scope_arc: {
          complete: 0,
          unavailable: 0,
          failed: 0,
          no_baseline: 1,
          skipped: 0,
          absent: 0,
        },
        group_stats: {
          complete: 0,
          unavailable: 0,
          failed: 0,
          no_baseline: 0,
          skipped: 1,
          absent: 0,
        },
      },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("csvEscape", () => {
  it("leaves plain values untouched", () => {
    expect(csvEscape("acme")).toBe("acme");
    expect(csvEscape("")).toBe("");
  });

  it("quotes commas, double-quotes, and newlines; doubles inner quotes", () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("x\ny")).toBe('"x\ny"');
    expect(csvEscape("x\r\ny")).toBe('"x\r\ny"');
  });

  it("prefixes formula-triggering text with an apostrophe (Excel/Sheets)", () => {
    for (const evil of ["=1+1", "+cmd", "-2+3", "@sum(1)", "  =x", "\t=y"]) {
      const out = csvEscape(evil);
      expect(out.startsWith("'")).toBe(true);
      expect(out).not.toMatch(/^[\s]*[=+\-@]/);
    }
  });

  it("guards then quotes when a dangerous value also needs quoting", () => {
    expect(csvEscape('=a,"b"')).toBe('"\'=a,""b"""');
  });
});

describe("renderRadarCsv", () => {
  it("emits the pinned header then one row per exported result", () => {
    const csv = renderRadarCsv(exportData());
    const lines = csv.replace(/\n$/, "").split("\n");
    const header = lines[0]!.split(",");
    for (const col of [
      "profile_id",
      "profile_version",
      "rank",
      "engagement_slug",
      "program_name",
      "program_url",
      "evidence_level",
      "score",
      "metadata_score",
      "deep_score",
      "score_delta",
      "coverage",
      "percentile",
      "eligible",
      "provisional",
      "restricted_access",
      ...RADAR_FEATURE_KEYS,
      "ki_status",
      "diff_status",
      "arc_status",
      "group_stats_status",
      "enrichment_status",
      "source_hash",
      "scoring_version",
      "reasons",
    ]) {
      expect(header).toContain(col);
    }
    // 1 header + 3 best_ev rows + 1 easy_entry row.
    expect(lines).toHaveLength(5);
  });

  it("repeats profile_id/profile_version/rank/evidence_level/engagement_slug on every row", () => {
    const lines = renderRadarCsv(exportData()).replace(/\n$/, "").split("\n");
    const idx = Object.fromEntries(
      lines[0]!.split(",").map((c, i) => [c, i] as const),
    );
    const cells = lines.slice(1).map((l) => l.split(","));
    expect(cells[0]![idx["profile_id"]!]).toBe("best_ev");
    expect(cells[0]![idx["profile_version"]!]).toBe("1.5.0");
    expect(cells[0]![idx["rank"]!]).toBe("1");
    expect(cells[0]![idx["evidence_level"]!]).toBe("deep");
    expect(cells[0]![idx["engagement_slug"]!]).toBe("prog-1");
    // rank restarts per profile; second section row re-stamps its profile.
    const last = cells[cells.length - 1]!;
    expect(last[idx["profile_id"]!]).toBe("easy_entry");
    expect(last[idx["profile_version"]!]).toBe("1.4.0");
    expect(last[idx["rank"]!]).toBe("1");
  });

  it("keeps real zeros as 0 and unknowns as empty — never conflated", () => {
    const lines = renderRadarCsv(exportData())
      .replace(/\n$/, "")
      .split("\n");
    const idx = Object.fromEntries(
      lines[0]!.split(",").map((c, i) => [c, i] as const),
    );
    const cells = lines.slice(1).map((l) => l.split(","));
    // Row 2: reward_potential is a real 0; deep columns are null → empty.
    expect(cells[1]![idx["reward_potential"]!]).toBe("0");
    expect(cells[1]![idx["deep_score"]!]).toBe("");
    expect(cells[1]![idx["score_delta"]!]).toBe("");
    expect(cells[1]![idx["ki_status"]!]).toBe("");
    // Row 3: null score/percentile → empty; percentile 0.0 prints "0".
    expect(cells[2]![idx["score"]!]).toBe("");
    expect(cells[2]![idx["percentile"]!]).toBe("");
    expect(cells[cells.length - 1]![idx["percentile"]!]).toBe("0");
    // Deep statuses flatten for the deep-analyzed row.
    expect(cells[0]![idx["ki_status"]!]).toBe("complete");
    expect(cells[0]![idx["diff_status"]!]).toBe("complete");
    expect(cells[0]![idx["arc_status"]!]).toBe("no_baseline");
    expect(cells[0]![idx["group_stats_status"]!]).toBe("skipped_low_volume");
  });

  it("formula-guards untrusted text fields", () => {
    const data = exportData();
    data.sections[0]!.rows[0]!.name = "=cmd|'/c calc'!A1";
    const csv = renderRadarCsv(data);
    const lines = csv.replace(/\n$/, "").split("\n");
    const nameCol = lines[0]!.split(",").indexOf("program_name");
    const firstRowCell = lines[1]!.split(",")[nameCol]!;
    expect(firstRowCell.startsWith("'")).toBe(true);
  });

  it("is deterministic for identical input", () => {
    expect(renderRadarCsv(exportData())).toBe(renderRadarCsv(exportData()));
  });
});

describe("radarExportFileName", () => {
  it("names all-profile and single-profile exports deterministically", () => {
    expect(radarExportFileName(exportData(), "csv")).toBe(
      "radar-report-radar_test01-all-top50.csv",
    );
    const single = exportData({
      options: { profiles: ["best_ev"], limit: null, detail: true, diagnostics: true },
    });
    expect(radarExportFileName(single, "json")).toBe(
      "radar-report-radar_test01-best_ev-all.json",
    );
  });

  it("sanitizes a hostile run_id — dots go too, killing `..` traversal", () => {
    const data = exportData();
    data.run.run_id = "radar_../../evil";
    expect(radarExportFileName(data, "md")).toBe(
      "radar-report-radar_------evil-all-top50.md",
    );
  });
});

// ---------------------------------------------------------------------------

describe("renderRadarMarkdown", () => {
  it("executive summary carries run identity, counts, and deep outcome", () => {
    const md = renderRadarMarkdown(exportData(), "sha256:" + "0".repeat(64));
    for (const frag of [
      "radar_test01",
      "2026-09-21T00:00:00.000Z",
      "complete",
      "0.1.0",
      "abc1234",
      "3 discovered",
      "1 analyzed",
      "budget 60",
      "Top-20 stable",
    ]) {
      expect(md).toContain(frag);
    }
    // The content hash is embedded — and is the model hash, not a body hash.
    expect(md).toContain(`sha256:${"0".repeat(64)}`);
  });

  it("renders one section per profile with id + version pinned", () => {
    const md = renderRadarMarkdown(exportData(), "sha256:x");
    expect(md).toContain("Best EV");
    expect(md).toContain("`best_ev`");
    expect(md).toContain("v1.5.0");
    expect(md).toContain("Easy Entry");
    expect(md).toContain("`easy_entry`");
    expect(md).toContain("v1.4.0");
  });

  it("distinguishes deep and metadata evidence — never fakes deep", () => {
    const md = renderRadarMarkdown(exportData(), "sha256:x");
    const lines = md.split("\n");
    const deepRow = lines.find((l) => l.includes("Program One"))!;
    expect(deepRow).toContain("deep");
    expect(deepRow).toContain("61.4");
    expect(deepRow).toContain("55.0");
    const metaRow = lines.find((l) => l.includes("Second Program"))!;
    expect(metaRow).toContain("metadata");
    // metadata-only row: no deep score shown — a dash, never a 0.
    expect(metaRow).toContain("—");
    // ineligible row: percentile is a dash, never a fabricated rank context.
    const ineligible = lines.find((l) => l.includes("prog3"))!;
    expect(ineligible).toContain("no");
  });

  it("keeps percentile cohort semantics — stored value, not window-recalculated", () => {
    const md = renderRadarMarkdown(exportData(), "sha256:x");
    expect(md).toContain("90%");
    // Bottom-of-cohort real 0.0 prints, not "—".
    expect(md).toContain("0%");
  });

  it("detail blocks show components, weights, contributions, reasons, hashes", () => {
    const md = renderRadarMarkdown(exportData(), "sha256:x");
    expect(md).toContain(`sha256:${"a".repeat(64)}`);
    expect(md).toContain(`sha256:${"b".repeat(64)}`);
    expect(md).toContain("REWARD_MEDIUM");
    expect(md).toContain("UNKNOWN_KNOWN_ISSUE_DENSITY");
    // weight + contribution for the cost component
    expect(md).toContain("1.35");
    // deep sub-source statuses rendered honestly
    expect(md).toContain("skipped_low_volume");
    expect(md).toContain("no_baseline");
  });

  it("omits detail blocks when the option is off", () => {
    const data = exportData();
    delete data.sections[0]!.rows[0]!.detail;
    const md = renderRadarMarkdown(data, "sha256:x");
    expect(md).not.toContain("Components");
    expect(md).toContain("61.4");
  });

  it("diagnostics: zero coordinator warnings still show failed sub-sources", () => {
    const data = exportData();
    data.run.warnings = 0;
    data.diagnostics!.sub_sources.known_issues.failed = 2;
    const md = renderRadarMarkdown(data, "sha256:x");
    expect(md).toContain("Diagnostics");
    // the failed column for known_issues reads 2 — not hidden by warnings:0
    expect(md).toMatch(/known issues.*2/si);
  });

  it("restricted-access notice appears only when gated rows exist", () => {
    const clean = renderRadarMarkdown(exportData(), "sha256:x");
    expect(clean).not.toContain("invitation-only");
    const data = exportData({
      restricted_access: { count: 1, programs: ["prog-1"] },
    });
    data.sections[0]!.rows[0]!.restricted_access = true;
    const md = renderRadarMarkdown(data, "sha256:x");
    expect(md).toContain("invitation-only");
    expect(md).toContain("prog-1");
  });

  it("escapes markdown metacharacters in untrusted program names", () => {
    const data = exportData();
    data.sections[0]!.rows[0]!.name = "Evil [link](javascript:alert(1)) | pipe";
    const md = renderRadarMarkdown(data, "sha256:x");
    expect(md).not.toContain("[link](javascript:alert(1))");
    expect(md).toContain("\\[link\\]");
  });

  it("is deterministic for identical input", () => {
    const d = exportData();
    expect(renderRadarMarkdown(d, "sha256:x")).toBe(
      renderRadarMarkdown(exportData(), "sha256:x"),
    );
  });
});

describe("renderRadarJson", () => {
  it("emits a versioned envelope with the content hash and the report", () => {
    const data = exportData();
    const parsed = JSON.parse(renderRadarJson(data, "sha256:" + "f".repeat(64)));
    expect(parsed.schema).toBe("bce-radar-export");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.content_sha256).toBe(`sha256:${"f".repeat(64)}`);
    expect(parsed.report.run.run_id).toBe("radar_test01");
    expect(parsed.report.sections).toHaveLength(2);
  });

  it("uses real JSON null for unavailable fields — never 0", () => {
    const parsed = JSON.parse(renderRadarJson(exportData(), "sha256:x"));
    const row3 = parsed.report.sections[0].rows[2];
    expect(row3.score).toBeNull();
    expect(row3.percentile).toBeNull();
    expect(row3.deep_score).toBeNull();
    const row2 = parsed.report.sections[0].rows[1];
    expect(row2.signals.reward_potential).toBe(0);
    expect(row2.deep).toBeNull();
    expect(row2.signals.known_issue_density).toBeNull();
  });

  it("carries profile definitions, versions, and score provenance", () => {
    const parsed = JSON.parse(renderRadarJson(exportData(), "sha256:x"));
    const sec = parsed.report.sections[0];
    expect(sec.profile_id).toBe("best_ev");
    expect(sec.profile_version).toBe("1.5.0");
    expect(sec.min_confidence).toBe(0.6);
    const r0 = sec.rows[0];
    expect(r0.evidence_level).toBe("deep");
    expect(r0.source_hash).toBe(`sha256:${"a".repeat(64)}`);
    expect(r0.detail.stages).toHaveLength(2);
    expect(r0.detail.stages[1].stage).toBe("deep");
    expect(r0.detail.stages[1].components.known_issue_density.contribution).toBe(
      0.58,
    );
  });
});

describe("radarExportContentHash + serializeRadarExport", () => {
  it("hash is deterministic and format-independent", async () => {
    const d = exportData();
    const h1 = await radarExportContentHash(d);
    const h2 = await radarExportContentHash(exportData());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("serializes each format with the right mime and embedded hash", async () => {
    const data = exportData();
    for (const [format, ext, mime] of [
      ["markdown", "md", "text/markdown"],
      ["json", "json", "application/json"],
      ["csv", "csv", "text/csv"],
    ] as const) {
      const res = await serializeRadarExport(data, format);
      expect(res.filename.endsWith(`.${ext}`)).toBe(true);
      expect(res.mime).toBe(mime);
      expect(res.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const md = await serializeRadarExport(data, "markdown");
    expect(md.body).toContain(md.content_hash);
    const json = await serializeRadarExport(data, "json");
    expect(JSON.parse(json.body).content_sha256).toBe(json.content_hash);
  });

  it("is byte-deterministic for identical data + options", async () => {
    const a = await serializeRadarExport(exportData(), "markdown");
    const b = await serializeRadarExport(exportData(), "markdown");
    expect(a.body).toBe(b.body);
  });

  it("redacts provided secrets from the emitted body", async () => {
    const data = exportData();
    data.sections[0]!.rows[0]!.name = "program SECRETTOKEN123 vulnerable";
    const res = await serializeRadarExport(data, "markdown", ["SECRETTOKEN123"]);
    expect(res.body).not.toContain("SECRETTOKEN123");
    expect(res.body).toContain("[REDACTED]");
  });
});
