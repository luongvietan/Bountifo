import { canonicalJson } from "../canonical";
import { sha256Hex } from "../hash";
import { redactSecrets } from "../secrets";
import { RADAR_FEATURE_KEYS } from "./types";
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
  /** Per-signal provenance from the embedded feature vector. */
  signal_meta: Record<
    RadarFeatureKey,
    { source: RadarSignalSource; reason_code: string }
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
