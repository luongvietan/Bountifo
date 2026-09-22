import type {
  RadarResultRow,
  RadarResultSignals,
  RadarRunPhase,
  RadarRunState,
  RadarScanSummary,
} from "../../lib/radar/coordinator";
import { RADAR_PROFILES } from "../../lib/radar/profiles";
import { RADAR_PROFILE_IDS } from "../../lib/radar/types";
import type {
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
  coverage: string;
  reward: string;
  surface: string;
  saturation: string;
  freshness: string;
  /** Below the profile's confidence floor — rendered dimmed, never hidden. */
  eligible: boolean;
  /** A required signal group was entirely unknown — flagged in the row. */
  provisional: boolean;
}

/** Maps a coordinator row to display cells; `rank` is 1-based. */
export function buildRow(row: RadarResultRow, rank: number): RowView {
  const base = formatScore(row.score);
  return {
    uuid: row.uuid,
    rank: String(rank),
    program: programLabel(row),
    score: row.provisional && base !== EMPTY ? `${base} provisional` : base,
    coverage: formatCoverage(row.confidence),
    reward: formatSignal(row.signals.reward_potential),
    surface: surfaceText(row.signals),
    saturation: saturationText(row.signals.research_saturation),
    freshness: formatSignal(row.signals.freshness),
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
