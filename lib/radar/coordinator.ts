import { ApiError } from "../api/errors";
import type { CatalogScanResult } from "./catalog";
import { extractProgramFeatures } from "./features";
import { getRadarProfile } from "./profiles";
import { explainScore, rankPrograms, scoreProgram } from "./scoring";
import {
  compareBookkeeping,
  getCatalog,
  getCatalogItem,
  getLatestRunId,
  getLatestScoreRowsByStage,
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
  started_at: string;
  updated_at: string;
  /** Lifecycle verdict written when the run reaches done/failed (Task 17). */
  summary?: RadarScanSummary;
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
  deep_rounds?: number;
  deep_budget?: number;
  deep_stabilization?: DeepStabilization | null;
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

function isSummary(value: unknown): value is RadarScanSummary {
  if (value === null || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return status === "complete" || status === "partial" || status === "failed";
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
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const uuid = (entry as { uuid?: unknown }).uuid;
    if (typeof uuid !== "string" || uuid === "") continue;
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
          Number.isFinite(rank)
        ) {
          reasons.push({
            profile: profile as RadarProfileId,
            metadata_rank: Math.floor(rank),
          });
        }
      }
    }
    out.push({ uuid, reasons });
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
   */
  private async latestRunContext(
    db: RadarDb,
  ): Promise<{ scope: Set<string>; deepCompleted: Set<string> } | null> {
    const runId = await getLatestRunId(db);
    if (runId === null) return null;
    const record = await getRun(db, runId);
    if (record === null) return null;
    const scope = new Set<string>();
    for (const uuid of asStringList(record.completed_uuids)) scope.add(uuid);
    for (const uuid of asStringList(record.pending_uuids)) scope.add(uuid);
    return {
      scope,
      deepCompleted: new Set(asStringList(record.deep_completed_uuids)),
    };
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
    const cap = Math.max(1, Math.min(Math.floor(limit), MAX_RESULT_LIMIT));
    const out: RadarResultRow[] = [];
    for (const { score, eligible } of ranked) {
      if (out.length >= cap) break;
      if (minConfidence !== undefined && score.confidence < minConfidence) {
        continue;
      }
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
        },
      });
    }
    return out;
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
  ): Promise<void> {
    if (uuids.every((uuid) => this.itemsByUuid.has(uuid))) {
      return;
    }
    for (const it of await getCatalog(db)) this.itemsByUuid.set(it.uuid, it);
    if (uuids.every((uuid) => this.itemsByUuid.has(uuid))) {
      return;
    }
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
      const snapshot = await getLatestSnapshot(db, uuid);
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
    if (this.deps.deepHydrate === undefined) return;
    const perProfile = new Map<RadarProfileId, string[]>();
    for (const profileId of DEEP_PROFILE_IDS) {
      perProfile.set(
        profileId,
        await this.metadataRanking(db, run, profileId),
      );
    }
    const budget = this.deps.deepLimit ?? MAX_DEEP_PROGRAMS;
    const { candidates } = selectDeepCandidates({
      perProfile,
      depth: this.deps.deepCandidateDepth ?? PROFILE_CANDIDATE_DEPTH,
      maxCandidates: budget,
    });
    run.deep_candidates = candidates;
    run.deep_budget = budget;
    run.deep_pending_uuids = candidates.map((c) => c.uuid);
    if (candidates.length > 0) run.deep_round = 1;
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
    await this.ensureCatalogItems(db, run, run.deep_pending_uuids);
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
      await putSnapshot(db, enriched, this.deps.now());
      if (enriched.deep != null) run.deep_enriched += 1;
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
      ...(run.deep_candidates.length > 0 || run.deep_completed_uuids.length > 0
        ? {
            deep_candidates: run.deep_candidates.length,
            deep_analyzed: run.deep_completed_uuids.length,
            deep_rounds: run.deep_round,
            deep_budget: run.deep_budget,
            deep_stabilization: run.deep_stabilization,
          }
        : {}),
    };
  }
}
