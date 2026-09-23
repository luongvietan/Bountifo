import { canonicalJson } from "../canonical";
import { BUGCROWD_SITE } from "../constants";
import { sha256Hex } from "../hash";
import { escapeMd, mdTable } from "../render/markdown";
import { redactSecrets } from "../secrets";
import { formatScoreDelta } from "./stage";
import { RADAR_FEATURE_KEYS, STABLE_TOP_K } from "./types";
import type {
  ProgramScore,
  RadarEvidenceLevel,
  RadarFeatureKey,
  RadarProfileId,
  RadarSignalSource,
} from "./types";

// ---------------------------------------------------------------------------
// Radar report export (V1.5) — pure serializers over an assembled snapshot.
//
// The coordinator collects RadarExportData ONCE from the persisted store
// (pinned to meta.latestRunId's run record — one coherent scan snapshot);
// everything below is deterministic: no clocks, no randomness, no I/O. The
// wall-clock export timestamp never enters the body or the content hash — it
// rides the message response envelope as `generated_at` only.
//
// `content_hash` hashes the canonical DATA MODEL (canonicalJson of
// RadarExportData), not any rendered body — so the same export carries the
// same hash in every format and the value may be embedded inside the
// Markdown/JSON bodies without self-reference.
// ---------------------------------------------------------------------------

export type RadarExportFormat = "markdown" | "json" | "csv";

/** What the caller asks for; `profiles` is already resolved (1 or all 6). */
export interface RadarExportQuery {
  profiles: RadarProfileId[];
  /** Per-profile row cap; null = the whole ranked cohort. */
  limit: number | null;
  /** Attach per-stage score components, reasons, and the signal table. */
  detail: boolean;
  /** Attach run-level deep sub-source diagnostics. */
  diagnostics: boolean;
  provenance: { app_version: string | null; commit_sha: string | null };
}

/** Deep-enrichment digest — every field is persisted data or null. */
export interface RadarExportDeepDigest {
  /** Envelope status ("complete"|"partial"|"unavailable"|"failed"). */
  status: string;
  known_issues: {
    status: string;
    unique_count: number | null;
    total_count: number | null;
    group_stats: {
      status: string;
      groups_fetched: number | null;
      groups_total: number | null;
    } | null;
  } | null;
  semantic_diff: {
    status: string;
    from_version: string | null;
    to_version: string | null;
  } | null;
  scope_arc: {
    status: string;
    window_versions: number | null;
  } | null;
}

/** One stage's persisted score record (detail blocks only). */
export interface RadarExportStageScore {
  stage: RadarEvidenceLevel;
  scoring_version: string;
  source_hash: string;
  score: number | null;
  confidence: number;
  provisional: boolean;
  components: ProgramScore["components"];
  reasons: string[];
}

export interface RadarExportRowDetail {
  /** One entry per persisted stage score — metadata always, deep when run. */
  stages: RadarExportStageScore[];
  /** Per-signal provenance from the embedded feature vector; a null entry
   *  means the score row predates embedded vectors — provenance unknown,
   *  never invented. */
  signal_meta: Record<
    RadarFeatureKey,
    { source: RadarSignalSource; reason_code: string } | null
  >;
}

export interface RadarExportRow {
  rank: number;
  uuid: string;
  /** The engagement slug used for links (code ?? uuid). */
  slug: string;
  /** Slug-allowlisted Bugcrowd URL; null when the slug is unsafe. */
  engagement_url: string | null;
  name: string | null;
  /** The metadata-stage score the row ranked on (null = unscored). */
  score: number | null;
  metadata_score: number | null;
  deep_score: number | null;
  score_delta: number | null;
  /** "deep" iff a deep-stage score exists — never implied for metadata rows. */
  evidence_level: RadarEvidenceLevel;
  /** Data coverage fraction (0..1), NOT statistical confidence. */
  coverage: number;
  /** Share of the eligible cohort outranked — full-cohort semantics, never
   *  recomputed inside the truncated export window. null when ineligible. */
  percentile: number | null;
  eligible: boolean;
  provisional: boolean;
  /** The program's stated posture matched the gated/invite-only family —
   *  drives the authenticated-content notice. */
  restricted_access: boolean;
  /** Provenance of the ranked (metadata-stage) score row. */
  source_hash: string | null;
  scoring_version: string;
  reasons: string[];
  /** All 20 signals in pinned RADAR_FEATURE_KEYS order; null = unknown. */
  signals: Record<RadarFeatureKey, number | null>;
  enrichment_status: "complete" | "unavailable" | "failed" | null;
  /** Persisted deep digest; null when the program was never deep-analyzed. */
  deep: RadarExportDeepDigest | null;
  detail?: RadarExportRowDetail;
}

export interface RadarExportSection {
  profile_id: RadarProfileId;
  profile_version: string;
  profile_label: string;
  min_confidence: number;
  /** Size of the full ranked cohort (before `limit` truncated it). */
  total_ranked: number;
  eligible_count: number;
  exported_count: number;
  rows: RadarExportRow[];
}

/** Status tallies for one deep sub-source across the analyzed set. */
export interface SubSourceCounts {
  complete: number;
  unavailable: number;
  failed: number;
  no_baseline: number;
  /** Sum of the group-stats skipped_* terminal states. */
  skipped: number;
  /** Sub-block missing entirely (pre-V1.5 payload / never ran). */
  absent: number;
}

export interface RadarDeepDiagnostics {
  deep_candidates: number;
  deep_analyzed: number;
  /** Candidates never analyzed (budget/shortfall) — honest gap count. */
  not_analyzed: number;
  sub_sources: {
    known_issues: SubSourceCounts;
    semantic_diff: SubSourceCounts;
    scope_arc: SubSourceCounts;
    group_stats: SubSourceCounts;
  };
}

export interface RadarExportData {
  run: {
    run_id: string;
    phase: string;
    started_at: string;
    updated_at: string;
    /** Lifecycle verdict — null while the run is still active. */
    status: "complete" | "partial" | "failed" | null;
    catalog_complete: boolean;
    discovered: number;
    enriched: number;
    enrichment_failed: number;
    scored: number;
    /** Total warning count (warning_details is the capped detail list). */
    warnings: number;
    warning_details: string[];
    deep_candidates: number | null;
    deep_analyzed: number | null;
    deep_enriched: number | null;
    deep_rounds: number | null;
    deep_budget: number | null;
    deep_stabilization: string | null;
  };
  provenance: {
    schema: "bce-radar-export";
    schema_version: 1;
    app_version: string | null;
    commit_sha: string | null;
  };
  /** The resolved export options — echoed for downstream reproducibility. */
  options: {
    profiles: RadarProfileId[];
    limit: number | null;
    detail: boolean;
    diagnostics: boolean;
  };
  /** Exported rows whose stated posture is gated/invitation-only. */
  restricted_access: { count: number; programs: string[] };
  sections: RadarExportSection[];
  diagnostics: RadarDeepDiagnostics | null;
}

/** One serialized report: deterministic body + transport metadata. */
export interface RadarExportResult {
  filename: string;
  mime: string;
  body: string;
  /** "sha256:..." over canonicalJson(data) — format-independent. */
  content_hash: string;
}

// ---------------------------------------------------------------------------
// Canonical engagement URL — identical allowlist the site client and the
// radar page apply to deep links. Anything else yields null (no link).
// ---------------------------------------------------------------------------

const SLUG_RE = /^[A-Za-z0-9_-]+$/;

export function radarEngagementUrl(slug: string): string | null {
  return SLUG_RE.test(slug) ? `${BUGCROWD_SITE}/engagements/${slug}` : null;
}

// ---------------------------------------------------------------------------
// CSV — flat rows, RFC-4180 quoting, LF line endings, Excel formula guard.
// ---------------------------------------------------------------------------

/**
 * Escape one text cell: double `"`, wrap when the value carries `,",\r,\n`,
 * and — BEFORE quoting — prefix a leading apostrophe when the value could be
 * read as a spreadsheet formula (`=`, `+`, `-`, `@` after any whitespace, or
 * a leading tab/CR). Only untrusted text goes through here; numbers/booleans
 * are emitted raw by csvCell.
 */
export function csvEscape(value: string): string {
  const safe = /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return csvEscape(value);
}

/** Flat column list — identical on every export, options never reshape it. */
const CSV_COLUMNS: readonly string[] = [
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
];

function csvRow(section: RadarExportSection, row: RadarExportRow): string {
  const cells: (string | number | boolean | null)[] = [
    section.profile_id,
    section.profile_version,
    row.rank,
    row.slug,
    row.name,
    row.engagement_url,
    row.evidence_level,
    row.score,
    row.metadata_score,
    row.deep_score,
    row.score_delta,
    row.coverage,
    row.percentile,
    row.eligible,
    row.provisional,
    row.restricted_access,
    ...RADAR_FEATURE_KEYS.map((k) => row.signals[k]),
    row.deep?.known_issues?.status ?? null,
    row.deep?.semantic_diff?.status ?? null,
    row.deep?.scope_arc?.status ?? null,
    row.deep?.known_issues?.group_stats?.status ?? null,
    row.enrichment_status,
    row.source_hash,
    row.scoring_version,
    row.reasons.join(";"),
  ];
  return cells.map(csvCell).join(",");
}

export function renderRadarCsv(data: RadarExportData): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const section of data.sections) {
    for (const row of section.rows) lines.push(csvRow(section, row));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Filename — deterministic for identical data+options; filesystem-safe.
// ---------------------------------------------------------------------------

export function radarExportFileName(
  data: RadarExportData,
  ext: "md" | "json" | "csv",
): string {
  const runId = data.run.run_id.replace(/[^A-Za-z0-9_-]/g, "-");
  const scope =
    data.options.profiles.length === 1 ? data.options.profiles[0]! : "all";
  const limit = data.options.limit === null ? "all" : `top${data.options.limit}`;
  return `radar-report-${runId}-${scope}-${limit}.${ext}`;
}

// ---------------------------------------------------------------------------
// Redaction — applied to every body before it leaves the extension.
// ---------------------------------------------------------------------------

/** Defense in depth: the normalized radar store can never hold credentials,
 *  but any provided secrets are still stripped from the emitted body. */
export function applyExportRedaction(
  body: string,
  secrets: readonly string[],
): string {
  return redactSecrets(body, secrets);
}

// ---------------------------------------------------------------------------
// Shared cell formatters — identical semantics to the radar page: null renders
// "—" (Markdown) / "" (CSV) / null (JSON), never 0.
// ---------------------------------------------------------------------------

const EMPTY = "—";

/** Inline code span: metachars are literal inside backticks, so only the
 *  backtick itself and line breaks can break out — neutralize those. */
function codeSpan(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, " ")}\``;
}

function sig(value: number | null): string {
  return value === null ? EMPTY : value.toFixed(2);
}

function scoreText(value: number | null): string {
  return value === null ? EMPTY : value.toFixed(1);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function boolText(value: boolean): string {
  return value ? "yes" : "no";
}

function percentileText(value: number | null): string {
  return value === null ? EMPTY : `${value}%`;
}

/** Program cell: linked when the slug produced a site-safe URL. */
function programCell(row: RadarExportRow): string {
  const label = escapeMd(row.name ?? row.slug);
  return row.engagement_url === null
    ? label
    : `[${label}](${row.engagement_url})`;
}

// ---------------------------------------------------------------------------
// Markdown report — consolidated, human-readable, deterministic.
// ---------------------------------------------------------------------------

function deepDigestText(deep: RadarExportDeepDigest | null): string {
  if (deep === null) return "not deep-analyzed";
  const parts = [`envelope ${codeSpan(deep.status)}`];
  const ki = deep.known_issues;
  if (ki === null) {
    parts.push("known issues `absent`");
  } else {
    parts.push(
      `known issues ${codeSpan(ki.status)}` +
        (ki.unique_count === null
          ? ""
          : ` (unique ${ki.unique_count} · total ${ki.total_count ?? "—"})`),
    );
    const gs = ki.group_stats;
    parts.push(
      gs === null
        ? "group stats `absent`"
        : `group stats ${codeSpan(gs.status)}` +
            ` (${gs.groups_fetched ?? "—"}/${gs.groups_total ?? "—"} groups)`,
    );
  }
  const diff = deep.semantic_diff;
  parts.push(
    diff === null
      ? "semantic diff `absent`"
      : `semantic diff ${codeSpan(diff.status)}` +
          ` (${diff.from_version ?? "—"} → ${diff.to_version ?? "—"})`,
  );
  const arc = deep.scope_arc;
  parts.push(
    arc === null
      ? "scope arc `absent`"
      : `scope arc ${codeSpan(arc.status)}` +
          (arc.window_versions === null
            ? ""
            : ` (${arc.window_versions} versions)`),
  );
  return parts.join(" · ");
}

function detailBlock(row: RadarExportRow): string {
  const detail = row.detail;
  if (detail === undefined) return "";
  const lines: string[] = [
    `#### ${row.rank}. ${escapeMd(row.name ?? row.slug)} — evidence detail`,
    "",
    `- Engagement ${codeSpan(row.uuid)} · ranked source hash ${codeSpan(
      row.source_hash ?? "—",
    )} · enrichment ${codeSpan(row.enrichment_status ?? "unknown")}`,
    `- Deep evidence: ${deepDigestText(row.deep)}`,
    `- Reasons: ${
      row.reasons.length === 0
        ? "none"
        : row.reasons.map(codeSpan).join(", ")
    }`,
    "",
    "Signals (richest stored vector):",
    "",
    mdTable(
      ["Signal", "Value", "Source", "Reason code"],
      RADAR_FEATURE_KEYS.map((key) => [
        key,
        sig(row.signals[key]),
        detail.signal_meta[key]?.source ?? EMPTY,
        detail.signal_meta[key]?.reason_code ?? EMPTY,
      ]),
    ),
    "",
    mdTable(
      ["Stage", "Scoring version", "Source hash", "Score", "Coverage", "Provisional", "Reasons"],
      detail.stages.map((s) => [
        s.stage,
        s.scoring_version,
        s.source_hash,
        scoreText(s.score),
        pct(s.confidence),
        boolText(s.provisional),
        s.reasons.length === 0 ? EMPTY : s.reasons.join(", "),
      ]),
    ),
  ];
  for (const stage of detail.stages) {
    lines.push(
      "",
      `${stage.stage === "metadata" ? "Metadata" : "Deep"}-stage components:`,
      "",
      mdTable(
        ["Signal", "Value", "Weight", "Direction", "Contribution"],
        Object.entries(stage.components).map(([key, c]) => [
          key,
          sig(c.signal),
          String(c.weight),
          c.direction,
          c.contribution === null ? EMPTY : c.contribution.toFixed(4),
        ]),
      ),
    );
  }
  return lines.join("\n");
}

function diagnosticsSection(diag: RadarDeepDiagnostics, warnings: number): string {
  const sub = diag.sub_sources;
  const rows: [string, SubSourceCounts][] = [
    ["Known issues", sub.known_issues],
    ["Semantic diff", sub.semantic_diff],
    ["Scope arc", sub.scope_arc],
    ["Per-group KI stats", sub.group_stats],
  ];
  return [
    "## Diagnostics",
    "",
    `Deep sub-source outcomes across ${diag.deep_analyzed} deep-analyzed ` +
      `program(s) (${diag.deep_candidates} candidates · ` +
      `${diag.not_analyzed} never analyzed):`,
    "",
    mdTable(
      ["Sub-source", "Complete", "Unavailable", "Failed", "No baseline", "Skipped", "Absent"],
      rows.map(([label, c]) => [
        label,
        String(c.complete),
        String(c.unavailable),
        String(c.failed),
        String(c.no_baseline),
        String(c.skipped),
        String(c.absent),
      ]),
    ),
    "",
    "- A `0` in a signal cell is a real observed zero; `unavailable`, `failed`, `no_baseline`, `skipped` and `absent` mark missing evidence — the two are never conflated.",
    `- Coordinator warnings (${warnings}) count catalog/enrichment problems only — deep sub-source failures above are independent and can exist in a zero-warning scan.`,
  ].join("\n");
}

export function renderRadarMarkdown(
  data: RadarExportData,
  contentHash: string,
): string {
  const run = data.run;
  const lines: string[] = [
    "# Radar Report",
    "",
    `- Content SHA-256: ${codeSpan(contentHash)}`,
    `- Scan date: ${run.started_at} · run ${codeSpan(run.run_id)} · phase ${codeSpan(run.phase)}`,
    `- Generated by Bountifo Radar (app version ${data.provenance.app_version ?? "unknown"}, commit ${data.provenance.commit_sha ?? "unknown"})`,
    `- Options: ${
      data.options.profiles.length === 1
        ? `profile ${codeSpan(data.options.profiles[0]!)}`
        : `${data.options.profiles.length} profiles`
    } · ${data.options.limit === null ? "all ranked rows" : `top ${data.options.limit}`} per profile` +
      `${data.options.detail ? " · detailed signal breakdown" : ""}` +
      `${data.options.diagnostics ? " · diagnostics" : ""}`,
  ];
  if (data.restricted_access.count > 0) {
    lines.push(
      "",
      `> **Notice:** this report contains information from ` +
        `${data.restricted_access.count} gated or invitation-only program(s) ` +
        `(content visible only to authenticated or invited researchers): ` +
        data.restricted_access.programs.map(escapeMd).join(", ") +
        `. Exported reports are never uploaded or shared automatically.`,
    );
  }
  lines.push(
    "",
    "## Executive summary",
    "",
    `- Run ID: ${codeSpan(run.run_id)} · scan date ${run.started_at} · updated ${run.updated_at}`,
    `- Verdict: ${run.status ?? `in progress (phase ${codeSpan(run.phase)})`}`,
    `- App version ${data.provenance.app_version ?? "unknown"} · commit ${data.provenance.commit_sha ?? "unknown"}`,
    `- Scoring versions: ${data.sections
      .map((s) => `${s.profile_id} v${s.profile_version}`)
      .join(", ")}`,
    `- Catalog ${run.catalog_complete ? "complete" : "incomplete"} · ` +
      `${run.discovered} discovered · ${run.enriched} enriched · ` +
      `${run.scored} scored · ${run.enrichment_failed} enrichment failure(s) · ` +
      `${run.warnings} warning(s)`,
    run.deep_candidates === null
      ? "- Deep analysis: not run"
      : `- Deep analysis: ${run.deep_candidates} candidate(s) · ` +
        `${run.deep_analyzed ?? 0} analyzed · ${run.deep_enriched ?? 0} enriched · ` +
        `${run.deep_rounds ?? 0} round(s) · budget ${run.deep_budget ?? "—"} · ` +
        (run.deep_stabilization === null
          ? "no verdict"
          : run.deep_stabilization === "stable"
            ? `Top-${STABLE_TOP_K} stable`
            : escapeMd(run.deep_stabilization)),
  );

  for (const section of data.sections) {
    lines.push(
      "",
      `## ${escapeMd(section.profile_label)} — ${codeSpan(section.profile_id)} v${section.profile_version}`,
      "",
      `Coverage floor ${pct(section.min_confidence)} · ranked ${section.total_ranked} · ` +
        `eligible ${section.eligible_count} · exported ${section.exported_count}`,
      "",
    );
    if (section.rows.length === 0) {
      lines.push("No rows in scope.");
      continue;
    }
    lines.push(
      mdTable(
        [
          "Rank",
          "Program",
          "URL",
          "Evidence",
          "Score",
          "Deep",
          "Δ",
          "Coverage",
          "Pct",
          "Eligible",
          "Provisional",
          "Reward",
          "Realized avg",
          "Surface",
          "API share",
          "API size",
          "Web",
          "Saturation",
          "KI pressure",
          "Opportunity",
          "Momentum",
          "KI conc.",
          "Access",
          "AuthZ",
        ],
        section.rows.map((row) => [
          String(row.rank),
          programCell(row),
          row.engagement_url ?? EMPTY,
          row.evidence_level,
          scoreText(row.score),
          scoreText(row.deep_score),
          formatScoreDelta(row.score_delta),
          pct(row.coverage),
          percentileText(row.percentile),
          boolText(row.eligible),
          boolText(row.provisional),
          sig(row.signals.reward_potential),
          sig(row.signals.payout_realized),
          sig(row.signals.meaningful_surface),
          sig(row.signals.api_surface),
          sig(row.signals.api_surface_size),
          sig(row.signals.web_surface),
          sig(row.signals.research_saturation),
          sig(row.signals.known_issue_density),
          sig(row.signals.opportunity_change),
          sig(row.signals.scope_momentum),
          sig(row.signals.ki_concentration),
          sig(row.signals.accessibility),
          sig(row.signals.authz_opportunity),
        ]),
      ),
    );
    const blocks = section.rows
      .map(detailBlock)
      .filter((b) => b !== "");
    if (blocks.length > 0) {
      lines.push("", "### Evidence detail", "", blocks.join("\n\n"));
    }
  }

  if (data.diagnostics !== null) {
    lines.push("", diagnosticsSection(data.diagnostics, run.warnings));
  }
  if (run.warning_details.length > 0) {
    lines.push(
      "",
      "### Scan warnings",
      "",
      run.warning_details.map((w) => `- ${escapeMd(w)}`).join("\n"),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// JSON report — versioned envelope; the hash covers `report`, not the wrapper.
// ---------------------------------------------------------------------------

export function renderRadarJson(
  data: RadarExportData,
  contentHash: string,
): string {
  return (
    JSON.stringify(
      {
        schema: "bce-radar-export",
        schema_version: 1,
        content_sha256: contentHash,
        report: data,
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Hash + dispatch.
// ---------------------------------------------------------------------------

/** Format-independent content hash over the canonical export data model. */
export async function radarExportContentHash(
  data: RadarExportData,
): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(data))}`;
}

/** Serialize an assembled export: body + filename + mime + content hash. */
export async function serializeRadarExport(
  data: RadarExportData,
  format: RadarExportFormat,
  secrets: readonly string[] = [],
): Promise<RadarExportResult> {
  const content_hash = await radarExportContentHash(data);
  let body: string;
  let mime: string;
  let ext: "md" | "json" | "csv";
  if (format === "markdown") {
    body = renderRadarMarkdown(data, content_hash);
    mime = "text/markdown";
    ext = "md";
  } else if (format === "json") {
    body = renderRadarJson(data, content_hash);
    mime = "application/json";
    ext = "json";
  } else {
    body = renderRadarCsv(data);
    mime = "text/csv";
    ext = "csv";
  }
  return {
    filename: radarExportFileName(data, ext),
    mime,
    body: applyExportRedaction(body, secrets),
    content_hash,
  };
}
