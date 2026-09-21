import { ApiError } from "../api/errors";
import type { CatalogScanResult } from "./catalog";
import { extractProgramFeatures } from "./features";
import { getRadarProfile } from "./profiles";
import { explainScore, rankPrograms, scoreProgram } from "./scoring";
import {
  getCatalog,
  getCatalogItem,
  getLatestRunId,
  getLatestScoreRow,
  getLatestScoreRowsForProfile,
  getLatestSnapshot,
  getRun,
  putCatalogItems,
  putRun,
  putScore,
  putSnapshot,
  setLatestRunId,
  type RadarDb,
  type RadarRunRecord,
} from "./store";
import {
  RADAR_PROFILE_IDS,
  type ProgramFeatureVector,
  type ProgramScore,
  type RadarCatalogItem,
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
// retries stay inside apiRequest; this layer adds none.
//
// The coordinator holds no direct sink: the IndexedDB handle arrives via the
// injected `openStore`, and network access lives inside the injected
// `enumerate`/`hydrate` functions.
// ---------------------------------------------------------------------------

export type RadarRunPhase =
  | "catalog"
  | "enriching"
  | "scoring"
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

/** One row of the ranked results table returned by getResults. */
export interface RadarResultRow {
  uuid: string;
  code: string | null;
  name: string | null;
  score: number | null;
  confidence: number;
  eligible: boolean;
  signals: RadarResultSignals;
}

/** The six display columns of the results table (signal values or null). */
export interface RadarResultSignals {
  reward_potential: number | null;
  meaningful_surface: number | null;
  api_surface: number | null;
  web_surface: number | null;
  researcher_competition: number | null;
  freshness: number | null;
}

/** Envelope returned by getProgram. */
export interface RadarProgramDetail {
  snapshot: RadarProgramSnapshot | null;
  score: ProgramScore | null;
  explanation: string[];
  catalog: RadarCatalogItem | null;
}

/** All side-effecting dependencies are injectable for tests. */
export interface RadarCoordinatorDeps {
  enumerate: () => Promise<CatalogScanResult>;
  hydrate: (item: RadarCatalogItem) => Promise<RadarProgramSnapshot>;
  openStore: () => Promise<RadarDb>;
  now: () => string;
  concurrency?: number;
  newRunId: () => string;
}

const ACTIVE_PHASES: ReadonlySet<RadarRunPhase> = new Set([
  "catalog",
  "enriching",
  "scoring",
]);

const ALL_PHASES: ReadonlySet<string> = new Set([
  "catalog",
  "enriching",
  "scoring",
  "done",
  "failed",
  "cancelled",
]);

const MAX_WARNING_DETAILS = 50;
const MAX_RESULT_LIMIT = 200;

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
   * Ranked results rows for one profile: latest score per engagement at the
   * profile's current version, joined with catalog identity and the stored
   * feature vector's six display signals. `rankPrograms` supplies ordering;
   * `minConfidence` is an optional extra filter; `limit` clamps to ≤200.
   */
  async getResults(
    profileId: RadarProfileId,
    limit: number = 50,
    minConfidence?: number,
  ): Promise<RadarResultRow[]> {
    const db = await this.database();
    const profile = getRadarProfile(profileId);
    const rows = await getLatestScoreRowsForProfile(
      db,
      profile.id,
      profile.version,
    );
    const byUuid = new Map(rows.map((row) => [row.uuid, row]));
    const ranked = rankPrograms(
      rows.map((row) => row.score),
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
      const vector = byUuid.get(uuid)?.vector;
      const cat = catalog.get(uuid);
      out.push({
        uuid,
        code: cat?.code ?? null,
        name: cat?.name ?? null,
        score: score.score,
        confidence: score.confidence,
        eligible,
        signals: {
          reward_potential: vector?.reward_potential.value ?? null,
          meaningful_surface: vector?.meaningful_surface.value ?? null,
          api_surface: vector?.api_surface.value ?? null,
          web_surface: vector?.web_surface.value ?? null,
          researcher_competition:
            vector?.researcher_competition.value ?? null,
          freshness: vector?.freshness.value ?? null,
        },
      });
    }
    return out;
  }

  /**
   * Per-program drill-down: latest snapshot, latest score for `profileId`
   * (defaults to best_ev) at the profile's current version, its rendered
   * explanation, and the catalog row. Null envelope when nothing is stored.
   */
  async getProgram(
    uuid: string,
    profileId: RadarProfileId = "best_ev",
  ): Promise<RadarProgramDetail | null> {
    const db = await this.database();
    const profile = getRadarProfile(profileId);
    const [snapshot, scoreRow, catalogItem] = await Promise.all([
      getLatestSnapshot(db, uuid),
      getLatestScoreRow(db, uuid, profile.id, profile.version),
      getCatalogItem(db, uuid),
    ]);
    const catalog = catalogItem ?? snapshot?.catalog ?? null;
    const score = scoreRow?.score ?? null;
    if (snapshot === null && score === null && catalog === null) return null;
    return {
      snapshot,
      score,
      explanation: score === null ? [] : explainScore(score),
      catalog,
    };
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
      if (run.phase === "catalog") await this.catalogPhase(db, run);
      if (run.phase === "enriching") await this.enrichPhase(db, run);
      if (run.phase === "scoring") await this.scorePhase(db, run);
      if (ACTIVE_PHASES.has(run.phase)) {
        // Unreachable by construction — a phase handler returned without
        // producing a terminal/next phase. Fail closed rather than hang.
        this.addWarnings(run, ["internal_error"]);
        run.phase = "failed";
        this.buildSummary(run);
        await this.checkpoint(db, run);
      }
    } catch (err) {
      this.addWarnings(run, [
        err instanceof ApiError ? err.kind : "internal_error",
      ]);
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
  ): Promise<void> {
    if (run.pending_uuids.every((uuid) => this.itemsByUuid.has(uuid))) {
      return;
    }
    for (const it of await getCatalog(db)) this.itemsByUuid.set(it.uuid, it);
    if (run.pending_uuids.every((uuid) => this.itemsByUuid.has(uuid))) {
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
        await putScore(db, score, this.deps.now(), vector);
      }
      run.scored += 1;
      await this.checkpoint(db, run);
    }
    run.phase = "done";
    this.buildSummary(run);
    await this.checkpoint(db, run);
    await setLatestRunId(db, run.run_id);
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
    };
  }
}
