import { ApiError } from "../api/errors";
import { isRestrictedAccess } from "./accessibility";
import type { CatalogScanResult } from "./catalog";
import {
  radarEngagementUrl,
  type RadarDeepDiagnostics,
  type RadarExportData,
  type RadarExportDeepDigest,
  type RadarExportQuery,
  type RadarExportRow,
  type RadarExportRowDetail,
  type RadarExportSection,
  type RadarExportStageScore,
  type SubSourceCounts,
} from "./export";
import { extractProgramFeatures } from "./features";
import { cohortPercentile } from "./percentile";
import { getRadarProfile } from "./profiles";
import {
  explainScore,
  rankPrograms,
  scoreProgram,
  type RankedProgram,
} from "./scoring";
import {
  compareBookkeeping,
  getCatalog,
  getCatalogItem,
  getLatestRunId,
  getLatestScoreRowsByStage,
  getLatestMetadataSnapshot,
  getLatestSnapshot,
  getRun,
  getScoreRows,
  putCatalogItems,
  putRun,
  putScore,
  putSnapshot,
  scoreRowStage,
  setLatestRunId,
  type RadarDb,
  type RadarRunRecord,
  type ScoreRow,
} from "./store";
import type { RadarDeepEnrichment } from "./deepTypes";
import { annotateEvidence } from "./stage";
import { selectDeepCandidates } from "./shortlist";
import { evaluateFrontier } from "./stabilize";
import {
  DEEP_BATCH_SIZE,
  DEEP_PROFILE_IDS,
  MAX_DEEP_PROGRAMS,
  PROFILE_CANDIDATE_DEPTH,
  STABILITY_BUFFER,
  STABLE_TOP_K,
  RADAR_FEATURE_KEYS,
  RADAR_PROFILE_IDS,
  type DeepCandidate,
  type DeepStabilization,
  type ProgramFeatureVector,
  type ProgramScore,
  type RadarCatalogItem,
  type RadarEvidenceLevel,
  type RadarProfileId,
  type RadarProgramSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Resumable radar scan coordinator (Tasks 14/15/17).
//
// MV3 service workers may terminate mid-scan, so every phase transition and
// every per-program step checkpoints the run record into the `runs` store.
// On restart, resume() picks up the persisted pending_uuids — a complete
// catalog that was already persisted is NEVER re-enumerated.
//
// Enrichment is bounded: a worker pool of `concurrency` (default 2) pulls
// uuids off a shared queue — never Promise.all over the whole catalog. HTTP
// retries stay inside siteRequest; this layer adds none.
//
// The coordinator holds no direct sink: the IndexedDB handle arrives via the
// injected `openStore`, and network access lives inside the injected
// `enumerate`/`hydrate` functions.
// ---------------------------------------------------------------------------

export type RadarRunPhase =
  | "catalog"
  | "enriching"
  | "scoring"
  | "deep_enriching"
  | "deep_scoring"
  | "done"
  | "failed"
  | "cancelled";

/** Persisted + in-memory progress of one radar scan run (Task 14). */
export interface RadarRunState {
  run_id: string;
  phase: RadarRunPhase;
  discovered: number;
  enriched: number;
  scored: number;
  pending_uuids: string[];
  completed_uuids: string[];
  /** V1.3 deep stage progress: shortlist queue, finished set, enriched count. */
  deep_pending_uuids: string[];
  deep_completed_uuids: string[];
  deep_enriched: number;
  /**
   * V1.3.1 iterative deepening: the profile-aware candidate union (with
   * per-profile metadata ranks), the current enrichment round, the run's
   * deep budget, and the terminal stabilization verdict (null while the
   * deep stage is running or never ran).
   */
  deep_candidates: DeepCandidate[];
  deep_round: number;
  deep_budget: number;
  deep_stabilization: DeepStabilization | null;
  /** Total warning count (details capped — see RadarScanSummary.warnings). */
  warnings: number;
  /**
   * V1.5.1 per-sub-source outcome tallies accumulated by the deep worker —
   * e.g. {known_issues: {unavailable: 60}} is the run-level signature of a
   * systemic source outage that per-program honest nulls alone cannot
   * express. Counts only programs that produced a deep payload; a completed
   * candidate with no detail tallies nothing. "absent" marks a sub-object
   * missing from the payload entirely.
   */
  deep_sources: RadarDeepSources;
  started_at: string;
  updated_at: string;
  /** Lifecycle verdict written when the run reaches done/failed (Task 17). */
  summary?: RadarScanSummary;
}

/**
 * Per-sub-source outcome tallies for the deep stage: literal status string
 * → program count (plus "absent" when the sub-object was missing from the
 * payload). Keys appear only for outcomes actually observed — deterministic
 * bookkeeping, no fabrication.
 */
export interface RadarDeepSources {
  known_issues: Record<string, number>;
  semantic_diff: Record<string, number>;
  scope_arc: Record<string, number>;
  group_stats: Record<string, number>;
}

/** Scan-result integrity status — never silently "complete" (Task 17). */
export interface RadarScanSummary {
  status: "complete" | "partial" | "failed";
  catalog_complete: boolean;
  discovered: number;
  enriched: number;
  enrichment_failed: number;
  scored: number;
  warnings: string[];
  /** V1.3.1 deep-stage outcome — absent on summaries written by V1.3 runs
   *  and on runs whose deep stage never started (no deepHydrate dep). */
  deep_candidates?: number;
  deep_analyzed?: number;
  /** Envelopes that gained real deep evidence — vs deep_analyzed, which
   *  counts attempted programs (missing data completes honestly too). */
  deep_enriched?: number;
  deep_rounds?: number;
  deep_budget?: number;
  deep_stabilization?: DeepStabilization | null;
  /**
   * V1.5.1 deep-stage source diagnostics — present exactly when the other
   * deep fields are. Per-sub-source outcome tallies let a scan that "ran
   * fine" still disclose a systemic deep-evidence outage.
   */
  deep_sources?: RadarDeepSources;
}

/**
 * The run record as persisted in the `runs` store: the public RadarRunState
 * plus bookkeeping fields needed to resume and to rebuild the summary after
 * a service-worker restart.
 */
export type PersistedRadarRun = RadarRunState & {
  catalog_complete: boolean;
  enrichment_failed: number;
  warning_details: string[];
  cancel_requested: boolean;
};

/**
 * The two result-table modes (V1.3.1):
 *   "metadata" — every in-scope program, ranked by its metadata-stage
 *                score; rows that were also deep-analyzed carry the DEEP
 *                badge plus deep_score/score_delta.
 *   "deep"     — deep-analyzed programs ONLY, ranked by their deep score;
 *                ordinal ranks are comparable because every row carries the
 *                same evidence level.
 */
export type RadarResultMode = "metadata" | "deep";

/** One row of the ranked results table returned by getResults. */
export interface RadarResultRow {
  uuid: string;
  code: string | null;
  name: string | null;
  /** The score at the requested evidence level (deep score in "deep" mode,
   *  metadata score in "metadata" mode). */
  score: number | null;
  confidence: number;
  /** "deep" iff a deep-stage score exists for this program+profile —
   *  independent of the current view mode. */
  evidence_level: RadarEvidenceLevel;
  /** Both scores when they exist — enables Meta/Deep/Δ display. */
  metadata_score: number | null;
  deep_score: number | null;
  score_delta: number | null;
  /** True when a profile-declared required signal group is entirely
   *  unknown — the row displays flagged, never silently final. */
  provisional: boolean;
  eligible: boolean;
  /** V1.5 — share of the eligible cohort this row outranks (0.0–100.0,
   *  one decimal); null on ineligible rows. */
  percentile: number | null;
  signals: RadarResultSignals;
}

/** The display columns of the results table (signal values or null). */
export interface RadarResultSignals {
  reward_potential: number | null;
  meaningful_surface: number | null;
  api_surface: number | null;
  web_surface: number | null;
  /** The research-saturation composite — observed attention, not a
   *  researcher count and not duplicate probability. */
  research_saturation: number | null;
  freshness: number | null;
  /** V1.3 duplicate-pressure proxy from Known Issues — null unless the
   *  program was deep-analyzed (null ≠ "no issues"). */
  known_issue_density: number | null;
  /** V1.3 semantic opportunity change — null unless the program was
   *  deep-analyzed (null ≠ "no change"). */
  opportunity_change: number | null;
  /** V1.4 entry-friction reading — null until the sourced rubric lands
   *  (contract stub keeps it unknown). */
  accessibility: number | null;
  /** V1.4 authz test-surface reading — null until the sourced rubric
   *  lands (contract stub keeps it unknown). */
  authz_opportunity: number | null;
  /** V1.5 realized average payout — null when statistics omit the field. */
  payout_realized: number | null;
  /** V1.5 multi-publish scope growth — null unless the deep arc completed. */
  scope_momentum: number | null;
  /** V1.5 known-issue concentration — null unless per-group stats ran. */
  ki_concentration: number | null;
}

/** Envelope returned by getProgram. */
export interface RadarProgramDetail {
  snapshot: RadarProgramSnapshot | null;
  /** The best available score: deep-stage when present, else metadata. */
  score: ProgramScore | null;
  /** V1.3.1: both stage scores side by side — either may be null when the
   *  program was never scored at that stage. */
  metadata_score: ProgramScore | null;
  deep_score: ProgramScore | null;
  /** The feature vector embedded on the best score row — lets the detail
   *  pane show unweighted signals (e.g. saturation inputs) without a
   *  re-read. */
  vector: ProgramFeatureVector | null;
  explanation: string[];
  catalog: RadarCatalogItem | null;
}

/** All side-effecting dependencies are injectable for tests. */
export interface RadarCoordinatorDeps {
  enumerate: () => Promise<CatalogScanResult>;
  hydrate: (item: RadarCatalogItem) => Promise<RadarProgramSnapshot>;
  /**
   * V1.3 deep enrichment for one shortlisted program: fetches the Known
   * Issues summary + previous-changelog semantic diff and returns a NEW
   * snapshot carrying `deep` (and the joined source_hash). Contract: never
   * throws — a program-scoped failure returns the snapshot with a failed
   * deep payload. When absent, the run skips the deep stage entirely.
   */
  deepHydrate?: (
    item: RadarCatalogItem,
    snapshot: RadarProgramSnapshot,
  ) => Promise<RadarProgramSnapshot>;
  /** Hard cap on unique deep-analyzed programs per run
   *  (default MAX_DEEP_PROGRAMS; the candidate union and stabilization
   *  batches share it). */
  deepLimit?: number;
  /** Per-profile metadata Top-N admitted to the deep candidate union
   *  (default PROFILE_CANDIDATE_DEPTH). */
  deepCandidateDepth?: number;
  /** Top-K the stabilization loop tries to keep fully deep-analyzed
   *  (default STABLE_TOP_K). */
  stableTopK?: number;
  /** Frontier margin beyond stableTopK (default STABILITY_BUFFER). */
  stabilityBuffer?: number;
  /** Programs added per stabilization round (default DEEP_BATCH_SIZE). */
  deepBatchSize?: number;
  openStore: () => Promise<RadarDb>;
  now: () => string;
  concurrency?: number;
  newRunId: () => string;
}

const ACTIVE_PHASES: ReadonlySet<RadarRunPhase> = new Set([
  "catalog",
  "enriching",
  "scoring",
  "deep_enriching",
  "deep_scoring",
]);

const ALL_PHASES: ReadonlySet<string> = new Set([
  "catalog",
  "enriching",
  "scoring",
  "deep_enriching",
  "deep_scoring",
  "done",
  "failed",
  "cancelled",
]);

const MAX_WARNING_DETAILS = 50;
const MAX_RESULT_LIMIT = 200;

/**
 * V1.3 request budget: the deep stage costs 3 site requests per program
 * (changelog list + previous brief doc + known-issues aggregate).
 *
 * @deprecated V1.3.1 replaced the single-profile cap with the profile-aware
 * candidate union (PROFILE_CANDIDATE_DEPTH × DEEP_PROFILE_IDS) bounded by
 * MAX_DEEP_PROGRAMS. Kept exported for the V1.3 budget test's pin.
 */
export const DEEP_ANALYSIS_LIMIT = 30;

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asIsoString(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

const DEEP_SOURCE_KEYS = [
  "known_issues",
  "semantic_diff",
  "scope_arc",
  "group_stats",
] as const;

function emptyDeepSources(): RadarDeepSources {
  return {
    known_issues: {},
    semantic_diff: {},
    scope_arc: {},
    group_stats: {},
  };
}

/** Loose persisted deep_sources → typed tallies (bad entries dropped). */
function asDeepSources(value: unknown): RadarDeepSources {
  const out = emptyDeepSources();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  const v = value as Record<string, unknown>;
  for (const key of DEEP_SOURCE_KEYS) {
    const tally = v[key];
    if (tally === null || typeof tally !== "object" || Array.isArray(tally)) {
      continue;
    }
    for (const [status, count] of Object.entries(tally)) {
      if (status === "") continue;
      if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
        continue;
      }
      out[key][status] = count;
    }
  }
  return out;
}

/** A tally is an object of non-empty status keys → positive int counts. */
function isTally(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).every(
    ([status, count]) =>
      status !== "" &&
      typeof count === "number" &&
      Number.isInteger(count) &&
      count > 0,
  );
}

/** Summary-level validation: all four tallies must be present and clean. */
function isDeepSources(value: unknown): value is RadarDeepSources {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return DEEP_SOURCE_KEYS.every((key) => isTally(v[key]));
}

/**
 * Folds one deep payload into the run tallies — the literal sub-source
 * statuses, "absent" when the sub-object is missing. Group stats ride on
 * the aggregate's sub-block; an absent aggregate reads absent here too.
 */
function tallyDeepSources(
  tallies: RadarDeepSources,
  deep: RadarDeepEnrichment,
): void {
  const bump = (tally: Record<string, number>, status: string): void => {
    tally[status] = (tally[status] ?? 0) + 1;
  };
  bump(tallies.known_issues, deep.known_issues?.status ?? "absent");
  bump(tallies.semantic_diff, deep.semantic_diff?.status ?? "absent");
  bump(tallies.scope_arc, deep.scope_arc?.status ?? "absent");
  bump(
    tallies.group_stats,
    deep.known_issues?.group_stats?.status ?? "absent",
  );
}

/**
 * Systemic-outage warnings: a sub-source that reached a failure state for
 * EVERY program that attempted it is a run-level event (dead session, dead
 * route), not per-program noise. Deliberate bounds are not failures —
 * skipped_* group-stats states and no_baseline diffs warn nothing, and a
 * mixed outcome (some complete, some not) is ordinary per-program variance.
 */
function deepSourceWarnings(t: RadarDeepSources): string[] {
  const warnings: string[] = [];
  const sum = (tally: Record<string, number>): number =>
    Object.values(tally).reduce((a, n) => a + n, 0);

  const ki = t.known_issues;
  const kiAttempted = sum(ki) - (ki.absent ?? 0);
  const kiUnavailable = ki.unavailable ?? 0;
  const kiFailed = ki.failed ?? 0;
  if (
    kiAttempted > 0 &&
    (ki.complete ?? 0) === 0 &&
    kiUnavailable + kiFailed === kiAttempted
  ) {
    warnings.push(
      kiUnavailable >= kiFailed
        ? "deep_known_issues_unavailable"
        : "deep_known_issues_failed",
    );
  }

  for (const key of ["semantic_diff", "scope_arc"] as const) {
    const tally = t[key];
    const attempted = sum(tally) - (tally.absent ?? 0);
    if (attempted > 0 && (tally.unavailable ?? 0) === attempted) {
      warnings.push(`deep_${key}_unavailable`);
    }
  }

  const gs = t.group_stats;
  const gsAttempted =
    (gs.complete ?? 0) + (gs.unavailable ?? 0) + (gs.failed ?? 0);
  if (gsAttempted > 0 && (gs.complete ?? 0) === 0) {
    warnings.push("deep_group_stats_failed");
  }
  return warnings;
}

function isSummary(value: unknown): value is RadarScanSummary {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const status = v.status;
  if (
    status !== "complete" &&
    status !== "partial" &&
    status !== "failed"
  ) {
    return false;
  }
  // A valid status with garbage counts is not a summary — it's corrupt
  // persisted data; drop it rather than render lies in the UI.
  for (const key of [
    "catalog_complete",
    "discovered",
    "enriched",
    "enrichment_failed",
    "scored",
    "warnings",
  ]) {
    if (!(key in v)) return false;
  }
  const baseOk =
    typeof v.catalog_complete === "boolean" &&
    typeof v.discovered === "number" &&
    typeof v.enriched === "number" &&
    typeof v.enrichment_failed === "number" &&
    typeof v.scored === "number" &&
    Array.isArray(v.warnings);
  if (!baseOk) return false;
  // Optional V1.3.1 deep fields, when present, must be the right types —
  // a corrupt persisted `deep_analyzed: "lots"` must not render "lots
  // analyzed" in the UI.
  for (const key of [
    "deep_candidates",
    "deep_analyzed",
    "deep_enriched",
    "deep_rounds",
    "deep_budget",
  ] as const) {
    if (key in v && typeof v[key] !== "number") return false;
  }
  if ("deep_sources" in v && !isDeepSources(v.deep_sources)) return false;
  return (
    !("deep_stabilization" in v) ||
    v.deep_stabilization === null ||
    STABILIZATION_VALUES.has(v.deep_stabilization as string)
  );
}

const STABILIZATION_VALUES: ReadonlySet<string> = new Set([
  "stable",
  "budget_limited",
  "incomplete",
]);

function asStabilization(value: unknown): DeepStabilization | null {
  return typeof value === "string" && STABILIZATION_VALUES.has(value)
    ? (value as DeepStabilization)
    : null;
}

/** Loose persisted deep_candidates → typed (bad entries dropped, never
 *  fabricated). */
function asDeepCandidates(value: unknown): DeepCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: DeepCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const uuid = (entry as { uuid?: unknown }).uuid;
    if (typeof uuid !== "string" || uuid === "" || seen.has(uuid)) continue;
    seen.add(uuid);
    const reasons: DeepCandidate["reasons"] = [];
    const rawReasons = (entry as { reasons?: unknown }).reasons;
    if (Array.isArray(rawReasons)) {
      for (const r of rawReasons) {
        if (r === null || typeof r !== "object") continue;
        const profile = (r as { profile?: unknown }).profile;
        const rank = (r as { metadata_rank?: unknown }).metadata_rank;
        if (
          typeof profile === "string" &&
          (RADAR_PROFILE_IDS as readonly string[]).includes(profile) &&
          typeof rank === "number" &&
          Number.isInteger(rank) &&
          rank >= 1
        ) {
          reasons.push({
            profile: profile as RadarProfileId,
            metadata_rank: rank,
          });
        }
      }
    }
    // A candidate exists only because some profile window demanded it —
    // an entry with no valid reason is corrupt persisted data; drop it.
    if (reasons.length > 0) out.push({ uuid, reasons });
  }
  return out;
}

/** Loose RadarRunRecord → normalized PersistedRadarRun (resume path). */
function normalizeRunRecord(
  record: RadarRunRecord,
  fallbackNow: string,
): PersistedRadarRun {
  const phase =
    typeof record.phase === "string" && ALL_PHASES.has(record.phase)
      ? (record.phase as RadarRunPhase)
      : "failed";
  return {
    run_id: record.run_id,
    phase,
    discovered: asCount(record.discovered),
    enriched: asCount(record.enriched),
    scored: asCount(record.scored),
    pending_uuids: asStringList(record.pending_uuids),
    completed_uuids: asStringList(record.completed_uuids),
    warnings: asCount(record.warnings),
    started_at: asIsoString(record.started_at, fallbackNow),
    updated_at: asIsoString(record.updated_at, fallbackNow),
    ...(isSummary(record.summary) ? { summary: record.summary } : {}),
    catalog_complete: record.catalog_complete === true,
    enrichment_failed: asCount(record.enrichment_failed),
    warning_details: asStringList(record.warning_details),
    cancel_requested: record.cancel_requested === true,
    deep_pending_uuids: asStringList(record.deep_pending_uuids),
    deep_completed_uuids: asStringList(record.deep_completed_uuids),
    deep_enriched: asCount(record.deep_enriched),
    deep_candidates: asDeepCandidates(record.deep_candidates),
    deep_round: asCount(record.deep_round),
    deep_budget: asCount(record.deep_budget),
    deep_stabilization: asStabilization(record.deep_stabilization),
    deep_sources: asDeepSources(record.deep_sources),
  };
}

/**
 * Drives one radar scan end to end: catalog → bounded enrichment → scoring
 * for all six profiles → done. Resumable: checkpoints after every program;
 * resume() continues a persisted active run after a service-worker restart.
 */
export class RadarCoordinator {
  private run: PersistedRadarRun | null = null;
  private db: RadarDb | null = null;
  private running: Promise<void> | null = null;
  private starting: Promise<RadarRunState> | null = null;
  private readonly itemsByUuid = new Map<string, RadarCatalogItem>();
  private readonly concurrency: number;

  constructor(private readonly deps: RadarCoordinatorDeps) {
    const c = deps.concurrency ?? 2;
    this.concurrency = Number.isFinite(c) ? Math.max(1, Math.floor(c)) : 2;
  }

  /** In-memory view of the current run (sync fast path). */
  get state(): RadarRunState | null {
    return this.run;
  }

  /** Resolves when the in-flight run terminates; returns immediately if idle. */
  async waitForIdle(): Promise<void> {
    await this.running;
  }

  private async database(): Promise<RadarDb> {
    this.db ??= await this.deps.openStore();
    return this.db;
  }

  /** Latest persisted run, or null — used when memory is empty (restart). */
  private async loadLatestRun(db: RadarDb): Promise<PersistedRadarRun | null> {
    const runId = await getLatestRunId(db);
    if (runId === null) return null;
    const record = await getRun(db, runId);
    return record === null
      ? null
      : normalizeRunRecord(record, this.deps.now());
  }

  /** Write the run record checkpoint — after every program and phase change. */
  private async checkpoint(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    run.updated_at = this.deps.now();
    await putRun(db, { ...run });
  }

  private addWarnings(run: PersistedRadarRun, warnings: string[]): void {
    for (const w of warnings) {
      run.warnings += 1;
      if (run.warning_details.length < MAX_WARNING_DETAILS) {
        run.warning_details.push(w);
      }
    }
  }

  /**
   * Starts a scan. Idempotent: if an active run exists (in memory or
   * persisted by a previous worker) it is adopted/continued and returned —
   * a second start never spawns a parallel scan. `kickoff()` is a no-op when
   * an executor already owns the run, and covers the adopted-without-executor
   * case (e.g. getState() loaded the persisted run after resume() failed).
   */
  async start(): Promise<RadarRunState> {
    if (this.run !== null && ACTIVE_PHASES.has(this.run.phase)) {
      this.kickoff();
      return this.run;
    }
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<RadarRunState> {
    const db = await this.database();
    if (this.run === null) this.run = await this.loadLatestRun(db);
    if (this.run !== null && ACTIVE_PHASES.has(this.run.phase)) {
      // Persisted active run — e.g. start() beat resume() after a restart.
      this.kickoff();
      return this.run;
    }
    const now = this.deps.now();
    this.itemsByUuid.clear();
    this.run = {
      run_id: this.deps.newRunId(),
      phase: "catalog",
      discovered: 0,
      enriched: 0,
      scored: 0,
      pending_uuids: [],
      completed_uuids: [],
      warnings: 0,
      started_at: now,
      updated_at: now,
      catalog_complete: false,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
      deep_pending_uuids: [],
      deep_completed_uuids: [],
      deep_enriched: 0,
      deep_candidates: [],
      deep_round: 0,
      deep_budget: 0,
      deep_stabilization: null,
      deep_sources: emptyDeepSources(),
    };
    await this.checkpoint(db, this.run);
    await setLatestRunId(db, this.run.run_id);
    this.kickoff();
    return this.run;
  }

  /**
   * Service-worker restart entry point: adopt the latest persisted run and
   * continue it when it sits in an active phase. Terminal runs and the
   * no-run case are a no-op.
   */
  async resume(): Promise<void> {
    if (this.running !== null) return this.running;
    const db = await this.database();
    if (this.run === null) this.run = await this.loadLatestRun(db);
    if (this.run === null || !ACTIVE_PHASES.has(this.run.phase)) return;
    this.kickoff();
    await this.running;
  }

  /**
   * Requests cancellation of the active run and waits for in-flight work to
   * checkpoint. The run flips to "cancelled"; terminal runs are a no-op.
   */
  async cancel(): Promise<RadarRunState | null> {
    const db = await this.database();
    if (this.run === null) this.run = await this.loadLatestRun(db);
    const run = this.run;
    if (run === null || !ACTIVE_PHASES.has(run.phase)) return run;
    run.cancel_requested = true;
    await this.checkpoint(db, run);
    if (this.running !== null) {
      await this.running;
    }
    if (ACTIVE_PHASES.has(run.phase)) {
      // No executor owned this run (persisted active, never resumed).
      run.phase = "cancelled";
      await this.checkpoint(db, run);
    }
    return run;
  }

  /**
   * Current run state — in-memory fast path, then the persisted latest run.
   * Read-only by contract: adopting a persisted active run here does NOT
   * start work (execution is resume()'s job at SW startup, and start()
   * guarantees an executor whenever it returns an active run).
   */
  async getState(): Promise<RadarRunState | null> {
    if (this.run !== null) return this.run;
    this.run = await this.loadLatestRun(await this.database());
    return this.run;
  }

  /**
   * The discovered set of the run `meta.latestRunId` points at:
   * completed ∪ pending uuids — plus the uuids that run's deep stage
   * completed. Result queries are always scoped to it — a program absent
   * from the latest run stops ranking (non-destructively: its
   * catalog/snapshot/score rows stay cached for future runs), and a missing
   * run or empty discovery honestly yields an empty set.
   *
   * `deepCompleted` gates the "deep" evidence level: only programs the
   * LATEST run actually deep-analyzed display deep scores/badges. A stale
   * deep row from an earlier scan stays cached but is not presented as
   * current evidence.
   *
   * The normalized run record rides along so report export can describe the
   * same coherent snapshot without a second load.
   */
  private async latestRunContext(
    db: RadarDb,
  ): Promise<{
    run: PersistedRadarRun;
    scope: Set<string>;
    deepCompleted: Set<string>;
  } | null> {
    const runId = await getLatestRunId(db);
    if (runId === null) return null;
    const record = await getRun(db, runId);
    if (record === null) return null;
    const scope = new Set<string>();
    for (const uuid of asStringList(record.completed_uuids)) scope.add(uuid);
    for (const uuid of asStringList(record.pending_uuids)) scope.add(uuid);
    return {
      // Read path: a missing timestamp falls back to "" (renders blank) —
      // never deps.now(), or the same corrupt store would serialize a
      // different report body and content hash on every export.
      run: normalizeRunRecord(record, ""),
      scope,
      deepCompleted: new Set(asStringList(record.deep_completed_uuids)),
    };
  }

  /** The shared row-collection half of getResults: latest-run scope filter,
   *  deep-gating, ranking, and the per-uuid lookups both consumers need.
   *  Percentile/limit stay with the caller — the export path applies its own
   *  cap after the full-cohort percentile is assigned. */
  private async collectProfileRows(
    db: RadarDb,
    ctx: { scope: Set<string>; deepCompleted: Set<string> },
    profileId: RadarProfileId,
    mode: RadarResultMode,
  ): Promise<{
    profile: ReturnType<typeof getRadarProfile>;
    ranked: RankedProgram[];
    metaByUuid: Map<string, ScoreRow>;
    deepByUuid: Map<string, ScoreRow>;
    shownByUuid: Map<string, ScoreRow>;
    catalog: Map<string, RadarCatalogItem>;
  }> {
    const profile = getRadarProfile(profileId);
    const staged = await getLatestScoreRowsByStage(
      db,
      profile.id,
      profile.version,
    );
    const inScope = (rows: ScoreRow[]): ScoreRow[] =>
      rows.filter((row) => ctx.scope.has(row.uuid));
    const metaRows = inScope(staged.metadata);
    // Deep rows only count when the LATEST run deep-analyzed the program —
    // otherwise the row is stale evidence from an earlier scan.
    const deepRows = inScope(staged.deep).filter((row) =>
      ctx.deepCompleted.has(row.uuid),
    );
    const metaByUuid = new Map(metaRows.map((row) => [row.uuid, row]));
    const deepByUuid = new Map(deepRows.map((row) => [row.uuid, row]));
    const shown = mode === "deep" ? deepRows : metaRows;
    const shownByUuid = new Map(shown.map((row) => [row.uuid, row]));
    const ranked = rankPrograms(
      shown.map((row) => row.score),
      profile,
    );
    const catalog = new Map(
      (await getCatalog(db)).map((item) => [item.uuid, item]),
    );
    return { profile, ranked, metaByUuid, deepByUuid, shownByUuid, catalog };
  }

  /**
   * Ranked results rows for one profile, at one evidence level:
   *
   *   mode "metadata" — every in-scope program ranked by its metadata-stage
   *     score; rows that were also deep-analyzed are annotated with
   *     evidence_level "deep" plus deep_score/score_delta.
   *   mode "deep" — ONLY programs holding a deep-stage score, ranked among
   *     themselves. Metadata-only programs never share this rank: the
   *     ordinal ordering would compare different evidence levels.
   *
   * For profiles without deep weights no deep rows are written, so "deep"
   * mode is honestly empty. `rankPrograms` supplies ordering;
   * `minConfidence` is an optional extra filter; `limit` clamps to ≤200.
   */
  async getResults(
    profileId: RadarProfileId,
    limit: number = 50,
    minConfidence?: number,
    mode: RadarResultMode = "metadata",
  ): Promise<RadarResultRow[]> {
    const db = await this.database();
    const ctx = await this.latestRunContext(db);
    if (ctx === null) return [];
    const { profile, ranked, metaByUuid, deepByUuid, shownByUuid, catalog } =
      await this.collectProfileRows(db, ctx, profileId, mode);
    const cap = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), MAX_RESULT_LIMIT))
      : MAX_RESULT_LIMIT;
    // V1.5: percentile ranks inside the cohort the table actually compares
    // — eligible rows that also pass the minConfidence argument — computed
    // before the `limit` cap so truncating the page cannot inflate it.
    const cohortSize = ranked.filter(
      (r) =>
        r.eligible &&
        (minConfidence === undefined || r.score.confidence >= minConfidence),
    ).length;
    let eligiblePos = 0;
    const out: RadarResultRow[] = [];
    for (const { score, eligible } of ranked) {
      if (out.length >= cap) break;
      if (minConfidence !== undefined && score.confidence < minConfidence) {
        continue;
      }
      if (eligible) eligiblePos++;
      const uuid = score.engagement_uuid;
      const ann = annotateEvidence(
        metaByUuid.get(uuid)?.score ?? null,
        deepByUuid.get(uuid)?.score ?? null,
      );
      // Richest vector wins: the deep vector carries the same metadata
      // signals plus real deep values, so a deep-analyzed row shows real
      // KI Pressure/Opportunity numbers even in metadata mode.
      const vector =
        deepByUuid.get(uuid)?.vector ?? shownByUuid.get(uuid)?.vector;
      const cat = catalog.get(uuid);
      out.push({
        uuid,
        code: cat?.code ?? null,
        name: cat?.name ?? null,
        score: score.score,
        confidence: score.confidence,
        evidence_level: ann.evidence_level,
        metadata_score: ann.metadata_score,
        deep_score: ann.deep_score,
        score_delta: ann.score_delta,
        provisional: score.provisional,
        eligible,
        percentile: eligible
          ? cohortPercentile(eligiblePos, cohortSize)
          : null,
        signals: {
          reward_potential: vector?.reward_potential.value ?? null,
          meaningful_surface: vector?.meaningful_surface.value ?? null,
          api_surface: vector?.api_surface.value ?? null,
          web_surface: vector?.web_surface.value ?? null,
          research_saturation:
            vector?.research_saturation.value ?? null,
          freshness: vector?.freshness.value ?? null,
          known_issue_density: vector?.known_issue_density.value ?? null,
          opportunity_change: vector?.opportunity_change.value ?? null,
          accessibility: vector?.accessibility.value ?? null,
          authz_opportunity: vector?.authz_opportunity.value ?? null,
          payout_realized: vector?.payout_realized.value ?? null,
          scope_momentum: vector?.scope_momentum.value ?? null,
          ki_concentration: vector?.ki_concentration.value ?? null,
        },
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Report export (V1.5) — one coherent snapshot of the persisted latest run.
  // Read-only by construction: no enumerate/hydrate calls, no store writes;
  // the same scope/deep-gating rules as getResults apply, but the row cap is
  // the export's own (Top-20/50/all) and never the UI's 200-row page limit.
  // -------------------------------------------------------------------------

  /** Persisted deep payload → export digest; null → honest absent. */
  private static deepDigest(
    deep: RadarProgramSnapshot["deep"],
  ): RadarExportDeepDigest | null {
    if (deep == null) return null;
    // Persisted payloads are read back without schema re-validation — a
    // pre-schema or corrupted payload can hold `undefined` where the type
    // promises null. `== null` + `?? "absent"` keep a malformed sub-object
    // honest (rendered as absent) instead of throwing the whole export.
    const ki = deep.known_issues;
    return {
      status: deep.status ?? "unknown",
      known_issues:
        ki == null
          ? null
          : {
              status: ki.status ?? "absent",
              unique_count: ki.unique_count ?? null,
              total_count: ki.total_count ?? null,
              group_stats:
                ki.group_stats == null
                  ? null
                  : {
                      status: ki.group_stats.status ?? "absent",
                      groups_fetched: ki.group_stats.groups_fetched ?? null,
                      groups_total: ki.group_stats.groups_total ?? null,
                    },
            },
      semantic_diff:
        deep.semantic_diff == null
          ? null
          : {
              status: deep.semantic_diff.status ?? "absent",
              from_version: deep.semantic_diff.from_version ?? null,
              to_version: deep.semantic_diff.to_version ?? null,
            },
      scope_arc:
        deep.scope_arc == null
          ? null
          : {
              status: deep.scope_arc.status ?? "absent",
              window_versions: deep.scope_arc.window_versions ?? null,
            },
    };
  }

  /** Tally one status string into the sub-source bucket it belongs to. */
  private static tally(
    counts: SubSourceCounts,
    status: string | null | undefined,
  ): void {
    switch (status) {
      case "complete":
        counts.complete += 1;
        break;
      case "unavailable":
        counts.unavailable += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "no_baseline":
        counts.no_baseline += 1;
        break;
      case "skipped_upstream":
      case "skipped_low_volume":
      case "skipped_group_count":
        counts.skipped += 1;
        break;
      default:
        // Absent sub-block or a status this exporter does not recognize —
        // an honest unknown, never silently counted as success or failure.
        counts.absent += 1;
    }
  }

  /**
   * Assembles the report data model for the persisted latest run — the SAME
   * scope + deep-completion gating the results table uses. Returns null when
   * no scan has ever run. Every unknown stays null; nothing is recomputed,
   * fabricated, or merged across runs.
   */
  async getExportData(
    query: RadarExportQuery,
  ): Promise<RadarExportData | null> {
    const db = await this.database();
    const ctx = await this.latestRunContext(db);
    if (ctx === null) return null;
    const run = ctx.run;

    // One snapshot read per exported uuid, shared across profile sections.
    const snapshots = new Map<string, RadarProgramSnapshot | null>();
    const snapshotFor = async (
      uuid: string,
    ): Promise<RadarProgramSnapshot | null> => {
      if (!snapshots.has(uuid)) {
        snapshots.set(uuid, await getLatestSnapshot(db, uuid));
      }
      return snapshots.get(uuid)!;
    };

    const restricted = new Set<string>();
    const sections: RadarExportSection[] = [];
    for (const profileId of query.profiles) {
      const { profile, ranked, metaByUuid, deepByUuid, shownByUuid, catalog } =
        await this.collectProfileRows(db, ctx, profileId, "metadata");
      // Percentile over the FULL eligible cohort — identical walk to
      // getResults with no minConfidence filter; the export cap truncates
      // rows afterwards, never the cohort math.
      const cohortSize = ranked.filter((r) => r.eligible).length;
      let eligiblePos = 0;
      const rows: RadarExportRow[] = [];
      const limit = query.limit;
      for (const { score, eligible } of ranked) {
        if (limit !== null && rows.length >= limit) break;
        if (eligible) eligiblePos += 1;
        const uuid = score.engagement_uuid;
        const ann = annotateEvidence(
          metaByUuid.get(uuid)?.score ?? null,
          deepByUuid.get(uuid)?.score ?? null,
        );
        const metaRow = metaByUuid.get(uuid);
        const deepRow = deepByUuid.get(uuid);
        const vector = deepRow?.vector ?? shownByUuid.get(uuid)?.vector;
        const snap = await snapshotFor(uuid);
        const cat = catalog.get(uuid) ?? snap?.catalog;
        const slug = cat?.code ?? snap?.code ?? uuid; // uuid-fallback rows get no site link
        const deepDigest =
          ctx.deepCompleted.has(uuid)
            ? // Analyzed this run — a missing/corrupt payload is "absent",
              // not "not deep-analyzed" (the run did the work).
              (RadarCoordinator.deepDigest(snap?.deep ?? null) ?? {
                status: "absent",
                known_issues: null,
                semantic_diff: null,
                scope_arc: null,
              })
            : null;
        const gated = isRestrictedAccess(snap?.detail ?? null, cat ?? null);
        if (gated) restricted.add(slug);
        const signals = Object.fromEntries(
          RADAR_FEATURE_KEYS.map((key) => [key, vector?.[key]?.value ?? null]),
        ) as RadarExportRow["signals"];
        const row: RadarExportRow = {
          rank: rows.length + 1,
          uuid,
          slug,
          engagement_url: radarEngagementUrl(slug),
          name: cat?.name ?? snap?.catalog?.name ?? null,
          score: score.score,
          metadata_score: ann.metadata_score,
          deep_score: ann.deep_score,
          score_delta: ann.score_delta,
          evidence_level: ann.evidence_level,
          coverage: score.confidence,
          percentile: eligible
            ? cohortPercentile(eligiblePos, cohortSize)
            : null,
          eligible,
          provisional: score.provisional,
          restricted_access: gated,
          source_hash: score.source_hash,
          scoring_version: score.scoring_version,
          reasons: score.reasons,
          signals,
          enrichment_status: snap?.enrichment?.status ?? null,
          deep: deepDigest,
        };
        if (query.detail) {
          const stages: RadarExportStageScore[] = [];
          for (const [stage, r] of [
            ["metadata", metaRow],
            ["deep", deepRow],
          ] as const) {
            if (r === undefined) continue;
            stages.push({
              stage,
              scoring_version: r.score.scoring_version,
              source_hash: r.score.source_hash,
              score: r.score.score,
              confidence: r.score.confidence,
              provisional: r.score.provisional,
              components: r.score.components,
              reasons: r.score.reasons,
            });
          }
          const signalMeta: RadarExportRowDetail["signal_meta"] =
            Object.fromEntries(
              RADAR_FEATURE_KEYS.map((key) => [
                key,
                vector?.[key] === undefined
                  ? null
                  : {
                      source: vector[key].source,
                      reason_code: vector[key].reason_code,
                    },
              ]),
            ) as RadarExportRowDetail["signal_meta"];
          row.detail = { stages, signal_meta: signalMeta };
        }
        rows.push(row);
      }
      sections.push({
        profile_id: profile.id,
        profile_version: profile.version,
        profile_label: profile.label,
        min_confidence: profile.minConfidence,
        total_ranked: ranked.length,
        eligible_count: cohortSize,
        exported_count: rows.length,
        rows,
      });
    }

    // Deep sub-source diagnostics: every deep-completed uuid's persisted
    // payload, tallied honestly — independent of the coordinator's own
    // warning count (zero warnings can still hide failed sub-sources).
    let diagnostics: RadarDeepDiagnostics | null = null;
    if (query.diagnostics) {
      const blank = (): SubSourceCounts => ({
        complete: 0,
        unavailable: 0,
        failed: 0,
        no_baseline: 0,
        skipped: 0,
        absent: 0,
      });
      const diag: RadarDeepDiagnostics = {
        // Records predating the persisted candidate list carry only the
        // summary count — fall back to it rather than reporting zero.
        deep_candidates:
          run.deep_candidates.length > 0
            ? run.deep_candidates.length
            : (run.summary?.deep_candidates ?? 0),
        deep_analyzed: ctx.deepCompleted.size,
        not_analyzed: 0,
        sub_sources: {
          known_issues: blank(),
          semantic_diff: blank(),
          scope_arc: blank(),
          group_stats: blank(),
        },
      };
      const analyzedSet = new Set(ctx.deepCompleted);
      for (const c of run.deep_candidates) {
        if (!analyzedSet.has(c.uuid)) diag.not_analyzed += 1;
      }
      for (const uuid of ctx.deepCompleted) {
        const deep = (await snapshotFor(uuid))?.deep ?? null;
        if (deep == null) {
          for (const key of [
            "known_issues",
            "semantic_diff",
            "scope_arc",
            "group_stats",
          ] as const) {
            diag.sub_sources[key].absent += 1;
          }
          continue;
        }
        RadarCoordinator.tally(
          diag.sub_sources.known_issues,
          deep.known_issues?.status ?? null,
        );
        RadarCoordinator.tally(
          diag.sub_sources.semantic_diff,
          deep.semantic_diff?.status ?? null,
        );
        RadarCoordinator.tally(
          diag.sub_sources.scope_arc,
          deep.scope_arc?.status ?? null,
        );
        RadarCoordinator.tally(
          diag.sub_sources.group_stats,
          deep.known_issues?.group_stats?.status ?? null,
        );
      }
      diagnostics = diag;
    }

    // "Ran" means the deep stage committed work — candidates, pending, or
    // completed uuids — or a summary recorded its outcome. Numbers stay null
    // otherwise (a metadata-only run is not a zeroed-out deep run).
    const deepRan =
      run.summary?.deep_candidates !== undefined ||
      run.deep_candidates.length > 0 ||
      run.deep_completed_uuids.length > 0 ||
      run.deep_pending_uuids.length > 0;
    return {
      run: {
        run_id: run.run_id,
        phase: run.phase,
        started_at: run.started_at,
        updated_at: run.updated_at,
        status: run.summary?.status ?? null,
        catalog_complete: run.catalog_complete,
        discovered: run.discovered,
        enriched: run.enriched,
        enrichment_failed: run.enrichment_failed,
        scored: run.scored,
        warnings: run.warnings,
        warning_details: [...run.warning_details],
        deep_candidates: deepRan
          ? (run.summary?.deep_candidates ?? run.deep_candidates.length)
          : null,
        deep_analyzed: deepRan
          ? (run.summary?.deep_analyzed ?? run.deep_completed_uuids.length)
          : null,
        deep_enriched: deepRan
          ? (run.summary?.deep_enriched ?? run.deep_enriched)
          : null,
        deep_rounds: deepRan
          ? (run.summary?.deep_rounds ?? run.deep_round)
          : null,
        deep_budget: deepRan
          ? (run.summary?.deep_budget ?? run.deep_budget)
          : null,
        deep_stabilization: deepRan
          ? (run.summary?.deep_stabilization ?? run.deep_stabilization)
          : null,
      },
      provenance: {
        schema: "bce-radar-export",
        schema_version: 1,
        app_version: query.provenance.app_version,
        commit_sha: query.provenance.commit_sha,
      },
      options: {
        profiles: [...query.profiles],
        limit: query.limit,
        detail: query.detail,
        diagnostics: query.diagnostics,
      },
      restricted_access: {
        count: restricted.size,
        programs: [...restricted].sort(),
      },
      sections,
      diagnostics,
    };
  }

  /**
   * Per-program drill-down: latest snapshot, BOTH stage scores for
   * `profileId` at its current version (metadata + deep — the deep row is
   * preferred for `score`/`vector`/`explanation`), and the catalog row.
   * Null envelope when nothing is stored — or when no latest run exists /
   * the uuid sits outside its discovered set.
   */
  async getProgram(
    uuid: string,
    profileId: RadarProfileId = "best_ev",
  ): Promise<RadarProgramDetail | null> {
    const db = await this.database();
    const ctx = await this.latestRunContext(db);
    if (ctx === null || !ctx.scope.has(uuid)) return null;
    const profile = getRadarProfile(profileId);
    const [snapshot, catalogItem] = await Promise.all([
      getLatestSnapshot(db, uuid),
      getCatalogItem(db, uuid),
    ]);
    // Latest row per stage for this uuid — the stage filter keeps a deep
    // re-score from hiding the metadata baseline it was computed on top of.
    // The deep row is only surfaced when the latest run actually deep-
    // analyzed the program (same gate as the results table).
    const metaRow = await this.latestStageRow(db, uuid, profile, "metadata");
    const deepRow = ctx.deepCompleted.has(uuid)
      ? await this.latestStageRow(db, uuid, profile, "deep")
      : null;
    const catalog = catalogItem ?? snapshot?.catalog ?? null;
    const best = deepRow ?? metaRow;
    const score = best?.score ?? null;
    if (snapshot === null && score === null && catalog === null) return null;
    return {
      snapshot,
      score,
      metadata_score: metaRow?.score ?? null,
      deep_score: deepRow?.score ?? null,
      vector: best?.vector ?? null,
      explanation: score === null ? [] : explainScore(score),
      catalog,
    };
  }

  /** The newest score row for one uuid at one stage (stage resolved the
   *  same way as the results table — explicit field, else snapshot deep). */
  private async latestStageRow(
    db: RadarDb,
    uuid: string,
    profile: ReturnType<typeof getRadarProfile>,
    stage: RadarEvidenceLevel,
  ): Promise<ScoreRow | null> {
    const rows = await getScoreRows(db, uuid, profile.id);
    let latest: ScoreRow | null = null;
    for (const row of rows) {
      if (row.scoring_version !== profile.version) continue;
      if ((await scoreRowStage(db, row)) !== stage) continue;
      if (latest === null || compareBookkeeping(row, latest) > 0) {
        latest = row;
      }
    }
    return latest;
  }

  private kickoff(): void {
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
  }

  private async execute(): Promise<void> {
    const run = this.run!;
    const db = await this.database();
    try {
      // Phase loop: V1.3.1's stabilization frontier can loop
      // deep_scoring → deep_enriching for another batch, so dispatch runs
      // until a terminal phase. A handler that returns without transitioning
      // fails closed rather than spinning.
      for (;;) {
        const before = run.phase;
        if (before === "catalog") await this.catalogPhase(db, run);
        else if (before === "enriching") await this.enrichPhase(db, run);
        else if (before === "scoring") await this.scorePhase(db, run);
        else if (before === "deep_enriching") {
          await this.deepEnrichPhase(db, run);
        } else if (before === "deep_scoring") {
          await this.deepScorePhase(db, run);
        }
        if (!ACTIVE_PHASES.has(run.phase)) break;
        if (run.phase === before) {
          // Phase handler returned without producing a next phase — fail
          // closed rather than hang or spin.
          this.addWarnings(run, ["internal_error"]);
          run.phase = "failed";
          this.buildSummary(run);
          await this.checkpoint(db, run);
          break;
        }
      }
    } catch (err) {
      this.addWarnings(run, [
        err instanceof ApiError ? err.kind : "internal_error",
      ]);
      this.markDeepIncomplete(run);
      run.phase = "failed";
      this.buildSummary(run);
      try {
        await this.checkpoint(db, run);
      } catch {
        // The store itself is broken — nothing left to persist into.
      }
    }
  }

  private async catalogPhase(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    await this.enumerateCatalog(db, run);
    if (run.phase === "enriching" && run.cancel_requested) {
      run.phase = "cancelled";
      await this.checkpoint(db, run);
    }
  }

  /**
   * Runs (or re-runs) catalog enumeration: persists items, refreshes
   * discovered/pending (minus already-completed uuids) and flips the run to
   * "enriching" — or to "failed" when the catalog itself failed.
   */
  private async enumerateCatalog(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    const result = await this.deps.enumerate();
    run.discovered = result.items.length;
    run.catalog_complete = result.status === "complete";
    this.addWarnings(run, result.warnings);
    if (result.items.length > 0) await putCatalogItems(db, result.items);
    for (const it of result.items) this.itemsByUuid.set(it.uuid, it);
    if (result.status === "failed") {
      run.phase = "failed";
      this.buildSummary(run);
      await this.checkpoint(db, run);
      return;
    }
    const done = new Set(run.completed_uuids);
    run.pending_uuids = result.items
      .map((it) => it.uuid)
      .filter((uuid) => !done.has(uuid));
    run.phase = "enriching";
    await this.checkpoint(db, run);
  }

  /**
   * Guarantees a catalog item for every pending uuid — from memory, then the
   * catalog store, and only when rows are still missing by re-enumerating
   * (a wiped/partial catalog store must not silently drop pending work).
   */
  private async ensureCatalogItems(
    db: RadarDb,
    run: PersistedRadarRun,
    uuids: readonly string[] = run.pending_uuids,
    reenumerate = true,
  ): Promise<void> {
    if (uuids.every((uuid) => this.itemsByUuid.has(uuid))) {
      return;
    }
    for (const it of await getCatalog(db)) this.itemsByUuid.set(it.uuid, it);
    if (uuids.every((uuid) => this.itemsByUuid.has(uuid))) {
      return;
    }
    // Re-enumeration rewinds the run to the enriching phase — valid for
    // metadata pending work, but wrong mid-deep: the deep worker already
    // completes uncatalogable uuids honestly, and a permanently-missing
    // uuid would otherwise loop scoring → deep_enriching → re-enumerate
    // forever.
    if (!reenumerate) return;
    this.addWarnings(run, ["catalog_store_incomplete"]);
    await this.enumerateCatalog(db, run);
  }

  private async enrichPhase(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    await this.ensureCatalogItems(db, run);
    if (run.phase !== "enriching") return;
    if (run.cancel_requested) {
      run.phase = "cancelled";
      await this.checkpoint(db, run);
      return;
    }
    if (run.pending_uuids.length > 0) {
      // Shared dispatch queue; run.pending_uuids stays the persisted truth —
      // a uuid leaves it only after its snapshot checkpoint lands.
      const queue = [...run.pending_uuids];
      const control: { stopped: boolean } = { stopped: false };
      const workers = Array.from(
        { length: Math.min(this.concurrency, queue.length) },
        () => this.enrichWorker(db, run, queue, control),
      );
      await Promise.all(workers);
      if (control.stopped) {
        run.phase = "failed";
        this.buildSummary(run);
        await this.checkpoint(db, run);
        return;
      }
      if (run.cancel_requested) {
        run.phase = "cancelled";
        await this.checkpoint(db, run);
        return;
      }
    }
    run.phase = "scoring";
    await this.checkpoint(db, run);
  }

  private async enrichWorker(
    db: RadarDb,
    run: PersistedRadarRun,
    queue: string[],
    control: { stopped: boolean },
  ): Promise<void> {
    while (!control.stopped && !run.cancel_requested) {
      const uuid = queue.shift();
      if (uuid === undefined) return;
      const item = this.itemsByUuid.get(uuid);
      if (item === undefined) {
        run.pending_uuids = run.pending_uuids.filter((u) => u !== uuid);
        run.completed_uuids.push(uuid);
        run.enrichment_failed += 1;
        this.addWarnings(run, [`${uuid}: missing_catalog_item`]);
        await this.checkpoint(db, run);
        continue;
      }
      let snapshot: RadarProgramSnapshot;
      try {
        snapshot = await this.deps.hydrate(item);
      } catch (err) {
        // Fatal (credential-wide) — the uuid stays pending for inspection.
        control.stopped = true;
        this.addWarnings(run, [
          `${uuid}: ${err instanceof ApiError ? err.kind : "unknown"}`,
        ]);
        await this.checkpoint(db, run);
        return;
      }
      await putSnapshot(db, snapshot, this.deps.now());
      run.pending_uuids = run.pending_uuids.filter((u) => u !== uuid);
      run.completed_uuids.push(uuid);
      if (snapshot.enrichment.status === "complete") {
        run.enriched += 1;
      } else {
        run.enrichment_failed += 1;
        this.addWarnings(run, [
          `${uuid}: ${snapshot.enrichment.error_kind ?? "unknown"}`,
        ]);
      }
      await this.checkpoint(db, run);
    }
  }

  private async scorePhase(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    if (run.cancel_requested) {
      run.phase = "cancelled";
      await this.checkpoint(db, run);
      return;
    }
    // Recomputed from scratch each entry: resuming mid-scoring re-scores all
    // completed uuids (putScore upserts by key — idempotent).
    run.scored = 0;
    const now = this.deps.now();
    for (const uuid of [...run.completed_uuids]) {
      if (run.cancel_requested) {
        run.phase = "cancelled";
        await this.checkpoint(db, run);
        return;
      }
      // Metadata stage reads the latest NON-deep snapshot only: scoring a
      // deep-joined snapshot here would label deep evidence "metadata" and
      // collide with the deep-stage row under the same source_hash.
      const snapshot = await getLatestMetadataSnapshot(db, uuid);
      if (snapshot === null) {
        this.addWarnings(run, [`${uuid}: missing_snapshot`]);
        continue;
      }
      const vector = extractProgramFeatures(snapshot, now);
      for (const profileId of RADAR_PROFILE_IDS) {
        const profile = getRadarProfile(profileId);
        const score = scoreProgram(snapshot, vector, profile);
        await putScore(db, score, this.deps.now(), vector, "metadata");
      }
      run.scored += 1;
      await this.checkpoint(db, run);
    }

    // Deep stage (V1.3.1): when a deepHydrate dep exists, build the
    // profile-aware candidate union over this run's metadata rankings for
    // known-issues + changelog-diff enrichment. Otherwise (or an empty
    // union) the run ends here.
    await this.buildDeepShortlist(db, run);
    if (run.deep_pending_uuids.length > 0) {
      run.phase = "deep_enriching";
      await this.checkpoint(db, run);
      return;
    }
    run.phase = "done";
    this.buildSummary(run);
    await this.checkpoint(db, run);
    await setLatestRunId(db, run.run_id);
  }

  /**
   * This run's eligible metadata-stage ranking for one profile, as ordered
   * uuids (rankPrograms order). Both the candidate union and the
   * stabilization frontier are built from these lists — eligible-only
   * (profile minConfidence), latest-run-scoped (run.completed_uuids), and
   * metadata-stage (a deep re-score must never feed the frontier).
   */
  private async metadataRanking(
    db: RadarDb,
    run: PersistedRadarRun,
    profileId: RadarProfileId,
  ): Promise<string[]> {
    const profile = getRadarProfile(profileId);
    const staged = await getLatestScoreRowsByStage(
      db,
      profile.id,
      profile.version,
    );
    const scope = new Set(run.completed_uuids);
    const ranked = rankPrograms(
      staged.metadata
        .filter((row) => scope.has(row.score.engagement_uuid))
        .map((row) => row.score),
      profile,
    );
    return ranked
      .filter((entry) => entry.eligible)
      .map((entry) => entry.score.engagement_uuid);
  }

  /**
   * V1.3.1 candidate selection: the deterministic UNION of every
   * deep-dependent profile's metadata Top-N (selectDeepCandidates), capped
   * by the run's deep budget. Provenance (which profile windows demanded
   * each uuid) is persisted on run.deep_candidates for diagnostics.
   */
  private async buildDeepShortlist(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    // The shortlist is recomputed authoritatively every time scoring
    // completes — including after a catalog-store wipe rewound the run
    // through enriching → scoring again. A stale persisted queue must never
    // resurrect the deep stage on its own, so reset the candidate set and
    // pending queue first. deep_completed_uuids is kept: those rows are
    // real current-run deep evidence whatever the new union looks like.
    run.deep_pending_uuids = [];
    run.deep_candidates = [];
    run.deep_round = 0;
    run.deep_stabilization = null;
    if (this.deps.deepHydrate === undefined) return;
    const perProfile = new Map<RadarProfileId, string[]>();
    for (const profileId of DEEP_PROFILE_IDS) {
      perProfile.set(
        profileId,
        await this.metadataRanking(db, run, profileId),
      );
    }
    const budget = this.deps.deepLimit ?? MAX_DEEP_PROGRAMS;
    const depth = this.deps.deepCandidateDepth ?? PROFILE_CANDIDATE_DEPTH;
    // The FULL union is recorded for provenance — the union cannot exceed
    // depth × |DEEP_PROFILE_IDS| by construction, so that bound means
    // "uncapped". deep_candidates documents every profile's demand even
    // when the budget binds; only the first `budget` candidates enter the
    // pending queue (deep_analyzed vs deep_candidates in the summary then
    // honestly shows the shortfall).
    const { candidates } = selectDeepCandidates({
      perProfile,
      depth,
      maxCandidates: depth * DEEP_PROFILE_IDS.length,
    });

    run.deep_candidates = candidates;
    run.deep_budget = budget;
    // Already-completed uuids are never re-queued — a rebuild after a
    // scoring-pass rewind must not redo (or double-count) finished work.
    const completed = new Set(run.deep_completed_uuids);
    run.deep_pending_uuids = candidates
      .map((c) => c.uuid)
      .filter((uuid) => !completed.has(uuid))
      .slice(0, budget);
    if (run.deep_pending_uuids.length > 0) run.deep_round = 1;
  }

  /**
   * Merge frontier-batch provenance into run.deep_candidates: a uuid the
   * union already selected gains the new reasons; a genuinely new uuid is
   * appended. Reasons stay sorted by DEEP_PROFILE_IDS priority.
   */
  private mergeCandidateProvenance(
    run: PersistedRadarRun,
    added: readonly DeepCandidate[],
  ): void {
    const byUuid = new Map(run.deep_candidates.map((c) => [c.uuid, c]));
    for (const cand of added) {
      const existing = byUuid.get(cand.uuid);
      if (existing === undefined) {
        const fresh: DeepCandidate = {
          uuid: cand.uuid,
          reasons: [...cand.reasons],
        };
        run.deep_candidates.push(fresh);
        byUuid.set(cand.uuid, fresh);
        continue;
      }
      for (const reason of cand.reasons) {
        if (!existing.reasons.some((r) => r.profile === reason.profile)) {
          existing.reasons.push(reason);
        }
      }
      existing.reasons.sort(
        (a, b) =>
          DEEP_PROFILE_IDS.indexOf(a.profile) -
          DEEP_PROFILE_IDS.indexOf(b.profile),
      );
    }
  }

  /**
   * End-of-round stabilization check (V1.3.1): every deep-dependent
   * profile's metadata Top-(K+buffer) must be fully deep-committed, else
   * deep-score drops could let an unanalyzed row displace the visible Top-K.
   * evaluateFrontier returns the next batch — bounded by batchSize and the
   * remaining budget — or the terminal verdict. A non-empty batch loops the
   * run back into deep_enriching for another round.
   */
  private async evaluateStabilization(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    const perProfileMetadata = new Map<RadarProfileId, string[]>();
    for (const profileId of DEEP_PROFILE_IDS) {
      perProfileMetadata.set(
        profileId,
        await this.metadataRanking(db, run, profileId),
      );
    }
    const committed = new Set([
      ...run.deep_completed_uuids,
      ...run.deep_pending_uuids,
    ]);
    const verdict = evaluateFrontier({
      perProfileMetadata,
      committed,
      committedCount: committed.size,
      maxBudget: run.deep_budget > 0 ? run.deep_budget : MAX_DEEP_PROGRAMS,
      stableTopK: this.deps.stableTopK ?? STABLE_TOP_K,
      buffer: this.deps.stabilityBuffer ?? STABILITY_BUFFER,
      batchSize: this.deps.deepBatchSize ?? DEEP_BATCH_SIZE,
    });
    if (verdict.batch.length > 0) {
      this.mergeCandidateProvenance(run, verdict.batch);
      run.deep_pending_uuids = verdict.batch.map((c) => c.uuid);
      run.deep_round += 1;
      run.phase = "deep_enriching";
      await this.checkpoint(db, run);
      return;
    }
    run.deep_stabilization = verdict.statusIfStopped;
    run.phase = "done";
    this.buildSummary(run);
    await this.checkpoint(db, run);
    await setLatestRunId(db, run.run_id);
  }

  /**
   * Marks the deep verdict "incomplete" when the stage committed candidates
   * but never reached a frontier verdict (cancel/fail mid-loop). A run that
   * ended cleanly sets "stable"/"budget_limited" itself — this only fills
   * the honest default for aborts.
   */
  private markDeepIncomplete(run: PersistedRadarRun): void {
    if (
      run.deep_stabilization === null &&
      (run.deep_candidates.length > 0 ||
        run.deep_completed_uuids.length > 0 ||
        run.deep_pending_uuids.length > 0)
    ) {
      run.deep_stabilization = "incomplete";
    }
  }

  private async deepEnrichPhase(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    if (run.phase !== "deep_enriching") return;
    // Deep pending never re-enumerates: an uncatalogable candidate is
    // completed with a warning by the worker, not a reason to rewind the
    // whole run (and a permanently-missing uuid would loop forever).
    await this.ensureCatalogItems(db, run, run.deep_pending_uuids, false);
    if (run.phase !== "deep_enriching") return;
    if (run.cancel_requested) {
      this.markDeepIncomplete(run);
      run.phase = "cancelled";
      await this.checkpoint(db, run);
      return;
    }
    if (run.deep_pending_uuids.length > 0) {
      const queue = [...run.deep_pending_uuids];
      const control: { stopped: boolean } = { stopped: false };
      const workers = Array.from(
        { length: Math.min(this.concurrency, queue.length) },
        () => this.deepWorker(db, run, queue, control),
      );
      await Promise.all(workers);
      if (control.stopped) {
        this.markDeepIncomplete(run);
        run.phase = "failed";
        this.buildSummary(run);
        await this.checkpoint(db, run);
        return;
      }
      if (run.cancel_requested) {
        this.markDeepIncomplete(run);
        run.phase = "cancelled";
        await this.checkpoint(db, run);
        return;
      }
    }
    run.phase = "deep_scoring";
    await this.checkpoint(db, run);
  }

  /**
   * Deep worker: pops a shortlisted uuid, loads its latest snapshot, and
   * calls the injected deepHydrate (which fetches Known Issues + the
   * previous changelog doc). The enriched snapshot replaces the latest row
   * via putSnapshot — deep data is joined into source_hash, so the same
   * deterministic scoring path re-scores it in deep_scoring. Programs with
   * no metadata detail are completed without enrichment — deep signals are
   * never fabricated.
   */
  private async deepWorker(
    db: RadarDb,
    run: PersistedRadarRun,
    queue: string[],
    control: { stopped: boolean },
  ): Promise<void> {
    while (!control.stopped && !run.cancel_requested) {
      const uuid = queue.shift();
      if (uuid === undefined) return;
      const markCompleted = async (): Promise<void> => {
        run.deep_pending_uuids = run.deep_pending_uuids.filter(
          (u) => u !== uuid,
        );
        run.deep_completed_uuids.push(uuid);
        await this.checkpoint(db, run);
      };
      const item = this.itemsByUuid.get(uuid);
      if (item === undefined) {
        this.addWarnings(run, [`${uuid}: missing_catalog_item`]);
        await markCompleted();
        continue;
      }
      const snapshot = await getLatestSnapshot(db, uuid);
      if (snapshot === null || snapshot.detail === null) {
        // Nothing to anchor the diff/KI signals to — honest skip.
        await markCompleted();
        continue;
      }
      let enriched: RadarProgramSnapshot;
      try {
        enriched = await this.deps.deepHydrate!(item, snapshot);
      } catch (err) {
        // deepHydrate promises never to throw; a throw is a plumbing bug and
        // treated as fatal (same contract as hydrate).
        control.stopped = true;
        this.addWarnings(run, [
          `${uuid}: ${err instanceof ApiError ? err.kind : "unknown"}`,
        ]);
        await this.checkpoint(db, run);
        return;
      }
      // Contract validation: a mislabeled snapshot must never be persisted
      // under the requested uuid's bookkeeping, and a deep payload under the
      // UNCHANGED source_hash would overwrite the metadata snapshot row in
      // place — silently reclassifying the metadata score as "deep". Both
      // are plumbing bugs → fatal, same as a throw.
      if (
        enriched.uuid !== item.uuid ||
        (enriched.deep != null &&
          enriched.source_hash === snapshot.source_hash)
      ) {
        control.stopped = true;
        this.addWarnings(run, [`${uuid}: invalid_deep_snapshot`]);
        await this.checkpoint(db, run);
        return;
      }
      if (enriched.source_hash === snapshot.source_hash) {
        // deep == null and identical input hash — nothing new to store.
        await markCompleted();
        continue;
      }
      await putSnapshot(db, enriched, this.deps.now());
      // Per-source outcomes land on the run tally BEFORE the completion
      // checkpoint — a restart must resume with the observed outcomes, not
      // a zeroed counter.
      if (enriched.deep != null) {
        tallyDeepSources(run.deep_sources, enriched.deep);
      }
      // "Enriched" counts envelopes that gained real deep evidence — a
      // wholly-failed envelope (every sub-source non-complete) is honest
      // bookkeeping, not enrichment. V1.5 adds the scope arc and the
      // per-group KI breakdown as evidence sources.
      if (
        enriched.deep?.known_issues?.status === "complete" ||
        enriched.deep?.semantic_diff?.status === "complete" ||
        enriched.deep?.scope_arc?.status === "complete" ||
        enriched.deep?.known_issues?.group_stats?.status === "complete"
      ) {
        run.deep_enriched += 1;
      }
      await markCompleted();
    }
  }

  /**
   * Re-score only the programs whose snapshot gained deep data, and only
   * the deep-dependent profiles — high_reward/easy_entry weight no deep
   * signal, so a deep row would duplicate the metadata score without adding
   * evidence (profile isolation). Deep rows are written under stage "deep"
   * at the joined source_hash; the metadata score row is never overwritten.
   */
  private async deepScorePhase(
    db: RadarDb,
    run: PersistedRadarRun,
  ): Promise<void> {
    const now = this.deps.now();
    for (const uuid of [...run.deep_completed_uuids]) {
      if (run.cancel_requested) {
        this.markDeepIncomplete(run);
        run.phase = "cancelled";
        await this.checkpoint(db, run);
        return;
      }
      const snapshot = await getLatestSnapshot(db, uuid);
      if (snapshot === null || snapshot.deep == null) continue;
      const vector = extractProgramFeatures(snapshot, now);
      for (const profileId of DEEP_PROFILE_IDS) {
        const profile = getRadarProfile(profileId);
        const score = scoreProgram(snapshot, vector, profile);
        await putScore(db, score, this.deps.now(), vector, "deep");
      }
      await this.checkpoint(db, run);
    }
    if (run.cancel_requested) {
      this.markDeepIncomplete(run);
      run.phase = "cancelled";
      await this.checkpoint(db, run);
      return;
    }
    // Stabilization frontier: pull the next metadata-window batch or record
    // the terminal verdict (stable / budget_limited). Loops back into
    // deep_enriching for another round when the frontier still owes work.
    await this.evaluateStabilization(db, run);
  }

  /**
   * Task 17 lifecycle verdict: "failed" when the run failed (catalog or a
   * fatal hydration); otherwise "complete" iff the catalog was complete AND
   * zero programs failed enrichment — any shortfall is honestly "partial".
   */
  private buildSummary(run: PersistedRadarRun): void {
    const hasDeep =
      run.deep_candidates.length > 0 || run.deep_completed_uuids.length > 0;
    // A uniform deep-source outage is a run-level warning — the terminal
    // summary must disclose that an entire evidence source delivered
    // nothing, even though every per-program payload stored honestly.
    if (hasDeep) {
      for (const w of deepSourceWarnings(run.deep_sources)) {
        if (!run.warning_details.includes(w)) this.addWarnings(run, [w]);
      }
    }
    const status: RadarScanSummary["status"] =
      run.phase === "failed"
        ? "failed"
        : run.catalog_complete && run.enrichment_failed === 0
          ? "complete"
          : "partial";
    const overflow = run.warnings - run.warning_details.length;
    run.summary = {
      status,
      catalog_complete: run.catalog_complete,
      discovered: run.discovered,
      enriched: run.enriched,
      enrichment_failed: run.enrichment_failed,
      scored: run.scored,
      warnings:
        overflow > 0
          ? [...run.warning_details, `…and ${overflow} more`]
          : [...run.warning_details],
      // Deep-stage bookkeeping — only present when the deep stage ran at
      // all (a run without deepHydrate leaves the fields absent).
      ...(hasDeep
        ? {
            deep_candidates: run.deep_candidates.length,
            deep_analyzed: run.deep_completed_uuids.length,
            deep_enriched: run.deep_enriched,
            deep_rounds: run.deep_round,
            deep_budget: run.deep_budget,
            deep_stabilization: run.deep_stabilization,
            deep_sources: {
              known_issues: { ...run.deep_sources.known_issues },
              semantic_diff: { ...run.deep_sources.semantic_diff },
              scope_arc: { ...run.deep_sources.scope_arc },
              group_stats: { ...run.deep_sources.group_stats },
            },
          }
        : {}),
    };
  }
}
