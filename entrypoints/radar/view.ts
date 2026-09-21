import type {
  RadarResultRow,
  RadarResultSignals,
  RadarRunPhase,
  RadarRunState,
  RadarScanSummary,
} from "../../lib/radar/coordinator";
import { RADAR_PROFILES } from "../../lib/radar/profiles";
import { RADAR_PROFILE_IDS } from "../../lib/radar/types";
import type { ProgramScore, RadarProfileId } from "../../lib/radar/types";

// ---------------------------------------------------------------------------
// Pure view helpers for the radar page — no DOM, no messaging, no clocks.
// main.ts wires these onto the document; tests pin the formatting.
// ---------------------------------------------------------------------------

const ACTIVE_PHASES: ReadonlySet<RadarRunPhase> = new Set([
  "catalog",
  "enriching",
  "scoring",
]);

const EMPTY = "—";

/** "0.82" for a known signal, "—" for unknown (null is never coerced to 0). */
export function formatSignal(value: number | null): string {
  return value === null ? EMPTY : value.toFixed(2);
}

/** Scores arrive on a 0–100 scale (scoring.ts round1); "—" when unscored. */
export function formatScore(score: number | null): string {
  return score === null ? EMPTY : score.toFixed(1);
}

/** Confidence is a 0–1 fraction rendered as a whole percentage. */
export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Signed weight display: "+3", "-1.5". */
export function formatWeight(weight: number): string {
  return weight > 0 ? `+${weight}` : `${weight}`;
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
 * Terminal verdict line. `warningCount` is the run's total warning count —
 * `summary.warnings` is only the capped detail list, not the count.
 */
export function summaryText(
  summary: RadarScanSummary,
  warningCount: number,
): string {
  const failed =
    summary.enrichment_failed > 0
      ? ` · ${plural(summary.enrichment_failed, "enrichment failure")}`
      : "";
  return (
    `Scan ${summary.status}: ${summary.discovered} discovered · ` +
    `${summary.enriched} enriched · ${summary.scored} scored${failed} · ` +
    plural(warningCount, "warning")
  );
}

/**
 * The one-line status/progress readout under the controls: phase + counts
 * while running, honest verdict (complete/partial/failed/cancelled) after.
 */
export function statusText(state: RadarRunState | null): string {
  if (state === null) return "No scan yet — press Scan programs.";
  if (isActive(state)) return `${phaseLabel(state.phase)} — ${countsText(state)}`;
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

/** One rendered row of the ranked results table (all display strings). */
export interface RowView {
  uuid: string;
  rank: string;
  program: string;
  score: string;
  confidence: string;
  reward: string;
  surface: string;
  competition: string;
  freshness: string;
  /** Below the profile's confidence floor — rendered dimmed, never hidden. */
  eligible: boolean;
}

/** Maps a coordinator row to display cells; `rank` is 1-based. */
export function buildRow(row: RadarResultRow, rank: number): RowView {
  return {
    uuid: row.uuid,
    rank: String(rank),
    program: programLabel(row),
    score: formatScore(row.score),
    confidence: formatConfidence(row.confidence),
    reward: formatSignal(row.signals.reward_potential),
    surface: surfaceText(row.signals),
    competition: formatSignal(row.signals.researcher_competition),
    freshness: formatSignal(row.signals.freshness),
    eligible: row.eligible,
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
    weight: formatWeight(component.weight),
    contribution:
      component.contribution === null
        ? EMPTY
        : component.contribution.toFixed(2),
  }));
}

/** The six profiles, in pinned declaration order, for the select element. */
export function profileOptions(): { id: RadarProfileId; label: string }[] {
  return RADAR_PROFILE_IDS.map((id) => ({
    id,
    label: RADAR_PROFILES[id].label,
  }));
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
