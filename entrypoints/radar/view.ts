import { BUGCROWD_SITE } from "../../lib/constants";
import type {
  RadarProgramDetail,
  RadarResultMode,
  RadarResultRow,
  RadarResultSignals,
  RadarRunPhase,
  RadarRunState,
  RadarScanSummary,
} from "../../lib/radar/coordinator";
import type {
  RadarDeepEnrichment,
  RadarKnownIssueSummary,
  RadarSemanticDiff,
} from "../../lib/radar/deepTypes";
import { RADAR_PROFILES } from "../../lib/radar/profiles";
import { formatScoreDelta } from "../../lib/radar/stage";
import {
  DEEP_PROFILE_IDS,
  RADAR_PROFILE_IDS,
  STABLE_TOP_K,
} from "../../lib/radar/types";
import type {
  DeepStabilization,
  ProgramFeatureVector,
  ProgramScore,
  RadarProfileId,
} from "../../lib/radar/types";

// ---------------------------------------------------------------------------
// Pure view helpers for the radar page — no DOM, no messaging, no clocks.
// main.ts wires these onto the document; tests pin the formatting.
// ---------------------------------------------------------------------------

const ACTIVE_PHASES: ReadonlySet<RadarRunPhase> = new Set([
  "catalog",
  "enriching",
  "scoring",
  "deep_enriching",
  "deep_scoring",
]);

const EMPTY = "—";

/** "0.82" for a known signal, "—" for unknown (null is never coerced to 0). */
export function formatSignal(value: number | null): string {
  return value === null ? EMPTY : value.toFixed(2);
}

/**
 * Display bands for the research_saturation composite. Honest wording: this
 * is observed attention, not duplicate probability or researcher counts.
 */
export function saturationBand(value: number): string {
  if (value < 0.2) return "Low";
  if (value < 0.45) return "Moderate-low";
  if (value < 0.7) return "Moderate-high";
  return "High";
}

/** "0.68 · Moderate-high"; "—" when the composite has < 2 known inputs. */
export function saturationText(value: number | null): string {
  return value === null ? EMPTY : `${formatSignal(value)} · ${saturationBand(value)}`;
}

/**
 * Display band for known_issue_density — a duplicate-pressure proxy from the
 * engagement-level Known Issues aggregate (cost direction: higher = more
 * dup pressure). Heuristic thirds: <0.25 Low, <0.6 Moderate, ≥0.6 High —
 * chosen so the observed ~0.4–0.6 dup-share range doesn't all read "High".
 * Display wording only; not a calibrated duplicate probability.
 */
export function densityBand(value: number): string {
  if (value < 0.25) return "Low";
  if (value < 0.6) return "Moderate";
  return "High";
}

/** "0.61 · High"; "—" when the program was not deep-analyzed. */
export function densityText(value: number | null): string {
  return value === null ? EMPTY : `${formatSignal(value)} · ${densityBand(value)}`;
}

/**
 * Display band for opportunity_change — the semantic-diff opportunity
 * signal (benefit direction: higher = the latest changelog version added
 * more opportunity than it removed). Same heuristic thirds as densityBand:
 * <0.25 Low, <0.6 Moderate, ≥0.6 High.
 */
export function opportunityBand(value: number): string {
  if (value < 0.25) return "Low";
  if (value < 0.6) return "Moderate";
  return "High";
}

/** "0.30 · Moderate"; "—" when the program was not deep-analyzed. */
export function opportunityText(value: number | null): string {
  return value === null
    ? EMPTY
    : `${formatSignal(value)} · ${opportunityBand(value)}`;
}

/** Scores arrive on a 0–100 scale (scoring.ts round1); "—" when unscored. */
export function formatScore(score: number | null): string {
  return score === null ? EMPTY : score.toFixed(1);
}

/**
 * Data coverage is a 0–1 known-weight fraction rendered as a whole
 * percentage. Named "coverage" in UI copy — it is NOT statistical
 * confidence in the score.
 */
export function formatCoverage(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * A score delta (deep − metadata) always signed, rounded to one decimal:
 * "+3.2", "−11.4", "+0.0". The minus is U+2212 so it doesn't read as a
 * hyphen/dash; −0 collapses to "+0.0" rather than showing a sign lie.
 * Callers handle the null case — a delta is never fabricated from one side.
 * Rounding/sign come from lib/radar/stage.ts (single source of truth);
 * this layer only swaps the ASCII minus for U+2212.
 */
export function formatDelta(delta: number): string {
  return formatScoreDelta(delta).replace("-", "−");
}

/**
 * Weight display: "+3", "+1.5". Cost-direction weights stay positive in
 * V1.1 scoring — the "(cost)" suffix flags that contribution rises as the
 * raw signal falls.
 */
export function formatWeight(
  weight: number,
  direction: "benefit" | "cost",
): string {
  const sign = weight > 0 ? "+" : "";
  return direction === "cost" ? `${sign}${weight} (cost)` : `${sign}${weight}`;
}

/** Human-readable phase name for the status line. */
export function phaseLabel(phase: RadarRunPhase): string {
  switch (phase) {
    case "catalog":
      return "Catalog scan";
    case "enriching":
      return "Enriching";
    case "scoring":
      return "Scoring";
    case "deep_enriching":
      return "Deep analysis of shortlist";
    case "deep_scoring":
      return "Deep scoring";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Whether the run is still working — drives the cancel button and polling. */
export function isActive(state: RadarRunState | null): boolean {
  return state !== null && ACTIVE_PHASES.has(state.phase);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function countsText(state: RadarRunState): string {
  return (
    `${state.discovered} discovered · ${state.enriched} enriched · ` +
    `${state.scored} scored · ${plural(state.warnings, "warning")}`
  );
}

/**
 * Human label for the run's deep-stage stabilization verdict:
 * "Top-20 stable" / "budget-limited" / "incomplete"; null when the run has
 * no verdict — a missing verdict is omitted, never worded as "stable".
 */
export function stabilizationLabel(
  stabilization: DeepStabilization | null | undefined,
): string | null {
  switch (stabilization) {
    case "stable":
      return `Top-${STABLE_TOP_K} stable`;
    case "budget_limited":
      return "budget-limited";
    case "incomplete":
      return "incomplete";
    default:
      return null;
  }
}

/**
 * The deep-stage segment of a terminal summary, e.g.
 * "Deep: 44 analyzed · 2 rounds · Top-20 stable" — or "44 of 60 analyzed"
 * when the deep budget cut the candidate union short. Returns null when the
 * summary carries no deep fields (a run whose deep stage never ran).
 */
export function deepSummaryText(summary: RadarScanSummary): string | null {
  if (
    summary.deep_analyzed === undefined &&
    summary.deep_candidates === undefined
  ) {
    return null;
  }
  const analyzed = summary.deep_analyzed ?? 0;
  const candidates = summary.deep_candidates ?? 0;
  const counts =
    candidates > analyzed
      ? `${analyzed} of ${candidates} analyzed`
      : `${analyzed} analyzed`;
  const rounds = plural(summary.deep_rounds ?? 0, "round");
  const stabilization = stabilizationLabel(summary.deep_stabilization);
  return (
    `Deep: ${counts} · ${rounds}` +
    (stabilization === null ? "" : ` · ${stabilization}`)
  );
}

/**
 * Terminal verdict line. `warningCount` is the run's total warning count —
 * `summary.warnings` is only the capped detail list, not the count. When
 * the run had a deep stage its outcome joins the line ("Deep: 44 analyzed ·
 * 2 rounds · Top-20 stable").
 */
export function summaryText(
  summary: RadarScanSummary,
  warningCount: number,
): string {
  const failed =
    summary.enrichment_failed > 0
      ? ` · ${plural(summary.enrichment_failed, "enrichment failure")}`
      : "";
  const deep = deepSummaryText(summary);
  return (
    `Scan ${summary.status}: ${summary.discovered} discovered · ` +
    `${summary.enriched} enriched · ${summary.scored} scored${failed}` +
    `${deep === null ? "" : ` · ${deep}`} · ` +
    plural(warningCount, "warning")
  );
}

/**
 * While the run is in a deep phase, progress is "12/20 analyzed" (completed
 * of shortlisted) plus the stabilization round — the coordinator declares
 * deep_round = 1 for the initial dispatch, so a live deep stage always
 * shows a numbered round.
 */
function deepProgressText(state: RadarRunState): string {
  if (
    (state.phase !== "deep_enriching" && state.phase !== "deep_scoring") ||
    state.deep_candidates.length === 0
  ) {
    return "";
  }
  const round = state.deep_round > 0 ? ` · round ${state.deep_round}` : "";
  return (
    `${state.deep_completed_uuids.length}/${state.deep_candidates.length} ` +
    `analyzed${round} · `
  );
}

/**
 * The one-line status/progress readout under the controls: phase + counts
 * while running, honest verdict (complete/partial/failed/cancelled) after.
 */
export function statusText(state: RadarRunState | null): string {
  if (state === null) return "No scan yet — press Scan programs.";
  if (isActive(state)) {
    return (
      `${phaseLabel(state.phase)} — ` +
      `${deepProgressText(state)}${countsText(state)}`
    );
  }
  if (state.phase === "cancelled") return `Cancelled — ${countsText(state)}`;
  if (state.summary === undefined) {
    return `${phaseLabel(state.phase)} — ${countsText(state)}`;
  }
  return summaryText(state.summary, state.warnings);
}

/** Display identity for a row: name, else engagement code, else uuid. */
export function programLabel(row: {
  uuid: string;
  code: string | null;
  name: string | null;
}): string {
  return row.name ?? row.code ?? row.uuid;
}

/**
 * Slug safety for outbound links — identical allowlist the siteClient uses
 * for engagement paths. Anything else (spaces, slashes, unicode) refuses a
 * URL rather than linking somewhere arbitrary.
 */
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Canonical engagement URL for deep-linking a program name:
 * `BUGCROWD_SITE/engagements/<slug>` where slug = code ?? uuid. Returns null
 * when the slug fails the allowlist — the caller renders plain text instead.
 * No other URL shape is ever produced.
 */
export function engagementUrl(identity: {
  uuid: string;
  code?: string | null;
}): string | null {
  const slug = identity.code ?? identity.uuid;
  return SLUG_RE.test(slug) ? `${BUGCROWD_SITE}/engagements/${slug}` : null;
}

/**
 * The slug source for a detail-pane link: catalog code/uuid first, then the
 * snapshot's code/uuid, then the requested uuid — same `code ?? uuid` rule
 * as the results rows.
 */
export function detailSlugSource(
  detail: RadarProgramDetail,
  fallbackUuid: string,
): { uuid: string; code: string | null } {
  const catalog = detail.catalog ?? detail.snapshot?.catalog ?? null;
  return {
    uuid: catalog?.uuid ?? detail.snapshot?.uuid ?? fallbackUuid,
    code: catalog?.code ?? detail.snapshot?.code ?? null,
  };
}

/** Detail-pane heading: catalog name/code, snapshot fallbacks, then uuid. */
export function detailTitleText(
  detail: RadarProgramDetail,
  uuid: string,
): string {
  return (
    detail.catalog?.name ??
    detail.catalog?.code ??
    detail.snapshot?.catalog.name ??
    detail.snapshot?.catalog.code ??
    detail.snapshot?.code ??
    uuid
  );
}

/**
 * The single "Surface" column folds the three surface signals together:
 * meaningful surface first, api/web in parentheses when known.
 */
export function surfaceText(signals: RadarResultSignals): string {
  const extras: string[] = [];
  if (signals.api_surface !== null) {
    extras.push(`api ${formatSignal(signals.api_surface)}`);
  }
  if (signals.web_surface !== null) {
    extras.push(`web ${formatSignal(signals.web_surface)}`);
  }
  const base = formatSignal(signals.meaningful_surface);
  return extras.length === 0 ? base : `${base} (${extras.join(" · ")})`;
}

/**
 * One rendered row of the ranked results table (all display strings).
 * Ten cells: Rank, Program, Score (evidence badge + Δ + coverage folded
 * in), Reward, Surface, Saturation, KI Pressure, Opportunity, Access,
 * AuthZ — the Freshness column was dropped for V1.3 (freshness stays in
 * `signals` and shows in the detail meta line).
 */
export interface RowView {
  uuid: string;
  rank: string;
  program: string;
  /** Canonical engagement URL when the slug is site-safe; null → plain text. */
  programUrl: string | null;
  /** Which stage produced the displayed score — drives the DEEP/META badge. */
  evidence: "deep" | "metadata";
  /** "61.4 (Δ −11.4 · cov 80%)"; "82.4 (cov 75%)"; "—" when unscored. */
  score: string;
  /** "Δ −11.4" when both stage scores exist; null otherwise — never faked. */
  scoreDelta: string | null;
  reward: string;
  surface: string;
  saturation: string;
  /** known_issue_density — "0.61 · High"; "—" when not deep-analyzed. */
  kiPressure: string;
  /** opportunity_change — "0.30 · Moderate"; "—" when not deep-analyzed. */
  opportunity: string;
  /** accessibility — "0.80"; "—" when the brief carried no access evidence. */
  access: string;
  /** authz_opportunity — "0.10"; "—" when the brief carried no authz evidence. */
  authz: string;
  /** false → the KI Pressure cell renders "—" with an `unanalyzed` marker. */
  kiAnalyzed: boolean;
  /** false → the opportunity cell renders "—" with an `unanalyzed` marker. */
  opportunityAnalyzed: boolean;
  /** Below the profile's confidence floor — rendered dimmed, never hidden. */
  eligible: boolean;
  /** A required signal group was entirely unknown — flagged in the row. */
  provisional: boolean;
}

/** Maps a coordinator row to display cells; `rank` is 1-based. */
export function buildRow(row: RadarResultRow, rank: number): RowView {
  const base = formatScore(row.score);
  const delta =
    row.score_delta === null ? null : `Δ ${formatDelta(row.score_delta)}`;
  return {
    uuid: row.uuid,
    rank: String(rank),
    program: programLabel(row),
    programUrl: engagementUrl(row),
    evidence: row.evidence_level,
    score:
      base === EMPTY
        ? EMPTY
        : `${base} (${delta === null ? "" : `${delta} · `}cov ${formatCoverage(row.confidence)})${row.provisional ? " provisional" : ""}`,
    scoreDelta: delta,
    reward: formatSignal(row.signals.reward_potential),
    surface: surfaceText(row.signals),
    saturation: saturationText(row.signals.research_saturation),
    kiPressure: densityText(row.signals.known_issue_density),
    opportunity: opportunityText(row.signals.opportunity_change),
    access: formatSignal(row.signals.accessibility),
    authz: formatSignal(row.signals.authz_opportunity),
    kiAnalyzed: row.signals.known_issue_density !== null,
    opportunityAnalyzed: row.signals.opportunity_change !== null,
    eligible: row.eligible,
    provisional: row.provisional,
  };
}

/**
 * Rows arrive already ranked by the coordinator (eligible first, score DESC,
 * uuid tie-break) — display rank is simply the position in that order.
 */
export function buildRows(rows: RadarResultRow[]): RowView[] {
  return rows.map((row, index) => buildRow(row, index + 1));
}

/** "reward_potential" → "Reward potential". */
export function signalLabel(key: string): string {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One rendered row of the detail pane's deterministic breakdown table. */
export interface ComponentView {
  key: string;
  label: string;
  signal: string;
  weight: string;
  contribution: string;
}

/**
 * Component breakdown for the detail pane. `Object.entries` preserves the
 * profile's declared weight order, so the table reads in scoring order.
 * Unknown signals contribute null — rendered "—", never 0.
 */
export function componentRows(score: ProgramScore): ComponentView[] {
  return Object.entries(score.components).map(([key, component]) => ({
    key,
    label: signalLabel(key),
    signal: formatSignal(component.signal),
    weight: formatWeight(component.weight, component.direction),
    contribution:
      component.contribution === null
        ? EMPTY
        : component.contribution.toFixed(2),
  }));
}

/**
 * Saturation diagnostics for the detail pane: the composite plus its three
 * V1.2 inputs, always shown — the composite must never hide its evidence.
 * Values come from the embedded vector, so unweighted inputs still render.
 */
export function saturationRows(
  vector: ProgramFeatureVector | null,
): { label: string; value: string }[] {
  const rows: { label: string; key: keyof ProgramFeatureVector }[] = [
    { label: "Research saturation", key: "research_saturation" },
    { label: "Recent crowding", key: "researcher_competition" },
    { label: "Submission activity", key: "submission_activity" },
    { label: "Rewarded activity", key: "rewarded_activity" },
  ];
  return rows.map(({ label, key }) => ({
    label,
    value:
      vector === null
        ? EMPTY
        : formatSignal(
            (vector[key] as { value: number | null } | undefined)?.value ??
              null,
          ),
  }));
}

/**
 * Detail meta line — stage scores + coverage verdict, with freshness folded
 * in (the results table dropped its Freshness column for V1.3; the signal
 * stays visible here). Both stage scores show when they exist —
 * "Meta 72.8 · Deep 61.4 · Δ −11.4" — so a deep re-score never silently
 * replaces the metadata number. Freshness renders only when actually known.
 */
export function detailMetaText(detail: RadarProgramDetail): string {
  const freshness = detail.vector?.freshness.value ?? null;
  const fresh =
    freshness === null ? "" : ` · freshness ${formatSignal(freshness)}`;
  const meta = detail.metadata_score;
  const deep = detail.deep_score;
  // detail.score is already deep ?? metadata per the coordinator contract;
  // the fallbacks keep odd envelopes (score set, stage fields missing)
  // honest instead of dropping the number.
  const best = detail.score ?? deep ?? meta;
  if (best === null) {
    return freshness === null
      ? "No score stored for this profile."
      : `No score stored for this profile${fresh}`;
  }
  const tail =
    ` · coverage ${formatCoverage(best.confidence)}` +
    `${best.provisional ? " · PROVISIONAL" : ""}${fresh}`;
  const metaScore = meta?.score ?? null;
  const deepScore = deep?.score ?? null;
  if (metaScore !== null && deepScore !== null) {
    return (
      `Meta ${formatScore(metaScore)} · Deep ${formatScore(deepScore)} · ` +
      `Δ ${formatDelta(deepScore - metaScore)}${tail}`
    );
  }
  if (deepScore !== null) return `Deep ${formatScore(deepScore)}${tail}`;
  if (metaScore !== null) return `Meta ${formatScore(metaScore)}${tail}`;
  return `Score ${formatScore(best.score)}${tail}`;
}

/**
 * Client-side result filters (V1.3) — applied to fetched rows in main.ts
 * before buildRows, so rank numbers are post-filter. Semantics: an unset
 * criterion passes every row; an ACTIVE criterion fails any row whose signal
 * is null — unknown is not 0 and cannot be verified against a threshold.
 */
export interface FilterCriteria {
  /** Keep rows with research_saturation ≤ this (0..1). */
  maxSaturation?: number | null;
  /** Keep rows with known_issue_density (KI Pressure) ≤ this (0..1). */
  maxKiPressure?: number | null;
  /** Keep rows with opportunity_change ≥ this (0..1). */
  minOpportunity?: number | null;
  /** Keep rows with reward_potential ≥ this (0..1). */
  minReward?: number | null;
  /** Keep rows with api_surface ≥ 0.4 when true. */
  apiHeavy?: boolean;
}

/** api_surface floor for the "API-heavy" checkbox. */
export const API_HEAVY_MIN = 0.4;

function passMax(value: number | null, max: number | null | undefined): boolean {
  return max === null || max === undefined
    ? true
    : value !== null && value <= max;
}

function passMin(value: number | null, min: number | null | undefined): boolean {
  return min === null || min === undefined
    ? true
    : value !== null && value >= min;
}

export function filterRows(
  rows: RadarResultRow[],
  criteria: FilterCriteria,
): RadarResultRow[] {
  return rows.filter(
    (row) =>
      passMax(row.signals.research_saturation, criteria.maxSaturation) &&
      passMax(row.signals.known_issue_density, criteria.maxKiPressure) &&
      passMin(row.signals.opportunity_change, criteria.minOpportunity) &&
      passMin(row.signals.reward_potential, criteria.minReward) &&
      (!criteria.apiHeavy ||
        (row.signals.api_surface !== null &&
          row.signals.api_surface >= API_HEAVY_MIN)),
  );
}

/** One titled diagnostic group in the detail pane. */
export interface DetailRowGroup {
  title: string;
  rows: { label: string; value: string }[];
}

function countText(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : String(value);
}

/** "5 (3 in scope)"; "5" when in-scope unknown; "—" when total unknown. */
function scopedCountText(
  total: number | null | undefined,
  inScope: number | null | undefined,
): string {
  if (total === null || total === undefined) return EMPTY;
  return inScope === null || inScope === undefined
    ? String(total)
    : `${total} (${inScope} in scope)`;
}

function boolText(value: boolean | null | undefined): string {
  return value === null || value === undefined
    ? EMPTY
    : value
      ? "yes"
      : "no";
}

/** Changelog version ids are long; the first 8 chars identify the version. */
function shortVersion(value: string | null | undefined): string {
  return value === null || value === undefined ? EMPTY : value.slice(0, 8);
}

/** ↑ on increase, ↓ on decrease, both when both fired; "—" otherwise. */
function rewardChangeText(diff: RadarSemanticDiff | null): string {
  const up = diff?.reward_increase === true;
  const down = diff?.reward_decrease === true;
  if (up && down) return "↑ ↓";
  if (up) return "↑";
  if (down) return "↓";
  return EMPTY;
}

function knownIssuesStatus(ki: RadarKnownIssueSummary | null): string {
  if (ki === null) return "not analyzed";
  return ki.status; // "complete" | "unavailable" | "failed"
}

function diffStatus(diff: RadarSemanticDiff | null): string {
  if (diff === null) return "not analyzed";
  return diff.status === "no_baseline" ? "no baseline" : diff.status;
}

/**
 * Per-signal diagnostics for the detail pane — the evidence behind the
 * KI Pressure, Opportunity, Access, and AuthZ columns, always rendered
 * honestly: counts / version ids that never arrived show "—", a missing
 * deep pass reads "not analyzed", and a metadata-stage signal with no
 * brief evidence shows "—" rather than fabricating a zero.
 */
export function detailRows(detail: RadarProgramDetail): DetailRowGroup[] {
  const deep: RadarDeepEnrichment | null = detail.snapshot?.deep ?? null;
  const ki = deep?.known_issues ?? null;
  const diff = deep?.semantic_diff ?? null;
  return [
    {
      title: "Known-issue intelligence",
      rows: [
        { label: "Unique known issues", value: countText(ki?.unique_count) },
        {
          label: "Total (incl. duplicates)",
          value: countText(ki?.total_count),
        },
        {
          label: "Known issue density",
          value: densityText(detail.vector?.known_issue_density.value ?? null),
        },
        { label: "Source status", value: knownIssuesStatus(ki) },
      ],
    },
    {
      title: "Opportunity changes",
      rows: [
        { label: "Current version", value: shortVersion(diff?.to_version) },
        { label: "Baseline version", value: shortVersion(diff?.from_version) },
        {
          label: "Targets added",
          value: scopedCountText(
            diff?.added_targets,
            diff?.added_in_scope_targets,
          ),
        },
        {
          label: "Targets removed",
          value: scopedCountText(
            diff?.removed_targets,
            diff?.removed_in_scope_targets,
          ),
        },
        {
          label: "API targets added",
          value: countText(diff?.added_api_targets),
        },
        { label: "Reward change", value: rewardChangeText(diff) },
        { label: "Status change", value: boolText(diff?.status_changed) },
        {
          label: "Safe harbor change",
          value: boolText(diff?.safe_harbor_changed),
        },
        {
          label: "Opportunity change",
          value: opportunityText(
            detail.vector?.opportunity_change.value ?? null,
          ),
        },
        { label: "Source status", value: diffStatus(diff) },
      ],
    },
    {
      title: "Access & authorization",
      rows: [
        {
          label: "Accessibility",
          // Defensive read — a vector stored before V1.4 may lack the key.
          value: formatSignal(
            (
              detail.vector?.accessibility as
                | { value: number | null }
                | undefined
            )?.value ?? null,
          ),
        },
        {
          label: "AuthZ opportunity",
          value: formatSignal(
            (
              detail.vector?.authz_opportunity as
                | { value: number | null }
                | undefined
            )?.value ?? null,
          ),
        },
      ],
    },
  ];
}

/** The six profiles, in pinned declaration order, for the select element. */
export function profileOptions(): { id: RadarProfileId; label: string }[] {
  return RADAR_PROFILE_IDS.map((id) => ({
    id,
    label: RADAR_PROFILES[id].label,
  }));
}

// ---------------------------------------------------------------------------
// Evidence-level view mode (V1.3.1). The results table can rank by
// metadata-stage scores (every program) or deep-stage scores (deep-analyzed
// programs only). The toggle is only offered where a deep stage can exist —
// DEEP_PROFILE_IDS — and defaults to deep only when the latest run
// plausibly wrote deep scores.
// ---------------------------------------------------------------------------

/**
 * The two modes the control offers, in display order. Labels stay honest:
 * "deep" ranks only programs with deep-stage evidence; "metadata" ranks all
 * candidates by their metadata score (deep-analyzed rows keep their DEEP
 * badge there).
 */
export const RESULTS_MODE_OPTIONS: readonly {
  value: RadarResultMode;
  label: string;
}[] = [
  { value: "deep", label: "Deep ranking" },
  { value: "metadata", label: "All candidates (metadata)" },
];

/**
 * Whether the profile weights any deep signal — deep scores are only ever
 * written for DEEP_PROFILE_IDS, so for high_reward/easy_entry the deep view
 * is empty by design and the toggle is hidden entirely.
 */
export function profileHasDeepStage(profile: RadarProfileId): boolean {
  return (DEEP_PROFILE_IDS as readonly RadarProfileId[]).includes(profile);
}

/**
 * Whether the run plausibly produced deep-stage scores: the terminal
 * summary's deep_analyzed when present, else completed deep enrichments
 * (covers a run still inside its deep stage, where no summary exists yet).
 */
export function runHasDeepEvidence(state: RadarRunState | null): boolean {
  if (state === null) return false;
  if (state.summary?.deep_analyzed !== undefined) {
    return state.summary.deep_analyzed > 0;
  }
  return state.deep_completed_uuids.length > 0;
}

/** How the mode control should render and what to query. */
export interface ResultsModeResolution {
  /** false → hide the toggle: the profile has no deep stage at all. */
  offered: boolean;
  /** The mode to request — the user's choice, else the honest default. */
  requested: RadarResultMode;
  /** Explanatory note for the control, or null when nothing needs saying. */
  note: string | null;
}

/**
 * Resolves which mode to request and what the control shows.
 * `choice` is the user's explicit pick (null = no pick yet → default).
 *
 * Defaults: a deep-capable profile defaults to "deep" only when the latest
 * run plausibly wrote deep scores; otherwise it defaults to metadata WITH a
 * note saying why — defaulting to an empty deep table would look broken.
 * Metadata-only profiles never offer the toggle; their note says the deep
 * view is empty by design, not broken.
 */
export function resolveResultsMode(
  profile: RadarProfileId,
  state: RadarRunState | null,
  choice: RadarResultMode | null,
): ResultsModeResolution {
  if (!profileHasDeepStage(profile)) {
    return {
      offered: false,
      requested: "metadata",
      note: `${RADAR_PROFILES[profile].label} has no deep signals — metadata view.`,
    };
  }
  if (choice !== null) return { offered: true, requested: choice, note: null };
  if (runHasDeepEvidence(state)) {
    return { offered: true, requested: "deep", note: null };
  }
  const note =
    state === null
      ? "No scan yet — metadata view."
      : isActive(state)
        ? "Deep analysis pending — metadata view."
        : "Latest run produced no deep-stage scores — metadata view.";
  return { offered: true, requested: "metadata", note };
}

/** Post-fetch outcome when a "deep" request came back empty. */
export interface ModeFallback {
  /** The rows to render (metadata rows when the deep ranking was empty). */
  rows: RadarResultRow[];
  /** The mode the rendered rows were actually fetched under. */
  mode: RadarResultMode;
  /** Honest note when the view fell back; null otherwise. */
  note: string | null;
}

/**
 * An empty deep ranking falls back to the metadata rows — with a note —
 * when metadata has rows to show. When both are empty there is nothing to
 * fall back to: the view stays "deep" and the table's generic empty text
 * ("No scored programs yet") tells the truth without inventing a cause.
 */
export function deepFallback(
  deepRows: RadarResultRow[],
  metadataRows: RadarResultRow[],
): ModeFallback {
  if (deepRows.length > 0) {
    return { rows: deepRows, mode: "deep", note: null };
  }
  if (metadataRows.length > 0) {
    return {
      rows: metadataRows,
      mode: "metadata",
      note:
        "Deep ranking is empty — no deep-stage scores yet; " +
        "showing all candidates (metadata).",
    };
  }
  return { rows: deepRows, mode: "deep", note: null };
}

/**
 * Renders a router error honestly: protocol errors are static strings, API
 * failures arrive as {kind, message}. Anything else is "unknown error".
 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const { kind, message } = error as { kind?: unknown; message?: unknown };
    if (typeof kind === "string" && typeof message === "string") {
      return `${kind}: ${message}`;
    }
    if (typeof message === "string") return message;
    if (typeof kind === "string") return kind;
  }
  return "unknown error";
}
