import { openDB, type IDBPDatabase } from "idb";
import type {
  ProgramFeatureVector,
  ProgramScore,
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "./types";

/**
 * Radar persistence — its own `bce-radar` database (v1), never the exporter's
 * `bce` job tables. Layout:
 *
 *   catalog    keyPath "uuid"                                    RadarCatalogItem
 *   snapshots  keyPath ["uuid","source_hash"], index byUuid      SnapshotRow
 *   scores     keyPath ["uuid","profile","scoring_version",
 *                       "source_hash"], index byUuidProfile      ScoreRow
 *   runs       keyPath "run_id"                                  RadarRunRecord
 *   meta       keyPath "key"                                     {key, value}
 *
 * Snapshots and scores are stored inside bookkeeping wrappers that carry the
 * key fields plus `stored_at` (ISO-8601). The wrapper is bookkeeping only —
 * `stored_at` is never part of any hash. Only normalized radar objects are
 * persisted: never raw API bodies, never tokens or headers.
 */

export type RadarDb = IDBPDatabase<unknown>;

/** Bookkeeping wrapper around a stored snapshot row. */
export interface SnapshotRow {
  uuid: string;
  source_hash: string;
  stored_at: string;
  snapshot: RadarProgramSnapshot;
}

/** Bookkeeping wrapper around a stored score row. */
export interface ScoreRow {
  uuid: string;
  profile: string;
  scoring_version: string;
  source_hash: string;
  stored_at: string;
  score: ProgramScore;
  /**
   * The full feature vector the score was computed from. Embedded on the row
   * so the results table can render per-signal columns for any profile
   * without a separate vectors store. Absent on rows written before the
   * coordinator landed.
   */
  vector?: ProgramFeatureVector;
}

/**
 * Minimal run record — Task 14 formalizes RadarRunState; the store keeps this
 * loose (`run_id` + arbitrary fields) so the shape can tighten later.
 */
export interface RadarRunRecord {
  run_id: string;
  [key: string]: unknown;
}

const META_LATEST_RUN_ID = "latestRunId";

export function openRadarStore(): Promise<RadarDb> {
  return openDB("bce-radar", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("catalog")) {
        db.createObjectStore("catalog", { keyPath: "uuid" });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        const store = db.createObjectStore("snapshots", {
          keyPath: ["uuid", "source_hash"],
        });
        store.createIndex("byUuid", "uuid");
      }
      if (!db.objectStoreNames.contains("scores")) {
        const store = db.createObjectStore("scores", {
          keyPath: ["uuid", "profile", "scoring_version", "source_hash"],
        });
        store.createIndex("byUuidProfile", ["uuid", "profile"]);
      }
      if (!db.objectStoreNames.contains("runs")) {
        db.createObjectStore("runs", { keyPath: "run_id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    },
  });
}

/** Bulk-upsert catalog rows; a repeated uuid overwrites in place. */
export async function putCatalogItems(
  db: RadarDb,
  items: RadarCatalogItem[],
): Promise<void> {
  const tx = db.transaction("catalog", "readwrite");
  for (const item of items) {
    await tx.objectStore("catalog").put(item);
  }
  await tx.done;
}

/** Every catalog row, in uuid key order. */
export async function getCatalog(db: RadarDb): Promise<RadarCatalogItem[]> {
  return (await db.getAll("catalog")) as RadarCatalogItem[];
}

/** Single catalog row by uuid, or null. */
export async function getCatalogItem(
  db: RadarDb,
  uuid: string,
): Promise<RadarCatalogItem | null> {
  return ((await db.get("catalog", uuid)) as RadarCatalogItem | undefined) ??
    null;
}

/**
 * Stores one snapshot under [uuid, source_hash] — a repeated key overwrites,
 * so re-hydrating unchanged metadata never duplicates rows. `storedAt` is
 * bookkeeping (ISO-8601), excluded from hashing.
 */
export async function putSnapshot(
  db: RadarDb,
  snapshot: RadarProgramSnapshot,
  storedAt: string = new Date().toISOString(),
): Promise<void> {
  const row: SnapshotRow = {
    uuid: snapshot.uuid,
    source_hash: snapshot.source_hash,
    stored_at: storedAt,
    snapshot,
  };
  await db.put("snapshots", row);
}

/**
 * Newest stored snapshot for `uuid` by `stored_at` (ties break on
 * `source_hash` for determinism — write order is never consulted), or null.
 */
export async function getLatestSnapshot(
  db: RadarDb,
  uuid: string,
): Promise<RadarProgramSnapshot | null> {
  const rows = (await db.getAllFromIndex(
    "snapshots",
    "byUuid",
    uuid,
  )) as SnapshotRow[];
  let latest: SnapshotRow | null = null;
  for (const row of rows) {
    if (latest === null || compareBookkeeping(row, latest) > 0) latest = row;
  }
  return latest?.snapshot ?? null;
}

/**
 * Stores one score under [uuid, profile, scoring_version, source_hash]; the
 * wrapper lifts ProgramScore's `engagement_uuid` into the `uuid` key field.
 * `vector` embeds the feature vector the score was computed from so result
 * queries can render per-signal columns without a vectors store.
 */
export async function putScore(
  db: RadarDb,
  score: ProgramScore,
  storedAt: string = new Date().toISOString(),
  vector?: ProgramFeatureVector,
): Promise<void> {
  const row: ScoreRow = {
    uuid: score.engagement_uuid,
    profile: score.profile,
    scoring_version: score.scoring_version,
    source_hash: score.source_hash,
    stored_at: storedAt,
    score,
    ...(vector === undefined ? {} : { vector }),
  };
  await db.put("scores", row);
}

/** All stored score ROWS for one engagement under one profile (any version). */
export async function getScoreRows(
  db: RadarDb,
  uuid: string,
  profile: string,
): Promise<ScoreRow[]> {
  return (await db.getAllFromIndex("scores", "byUuidProfile", [
    uuid,
    profile,
  ])) as ScoreRow[];
}

/** All stored scores for one engagement under one profile (any version). */
export async function getScores(
  db: RadarDb,
  uuid: string,
  profile: string,
): Promise<ProgramScore[]> {
  return (await getScoreRows(db, uuid, profile)).map((row) => row.score);
}

/**
 * The newest score row for one engagement under `profile` at
 * `scoringVersion`, or null when none exists.
 */
export async function getLatestScoreRow(
  db: RadarDb,
  uuid: string,
  profile: string,
  scoringVersion: string,
): Promise<ScoreRow | null> {
  const rows = await getScoreRows(db, uuid, profile);
  let latest: ScoreRow | null = null;
  for (const row of rows) {
    if (row.scoring_version !== scoringVersion) continue;
    if (latest === null || compareBookkeeping(row, latest) > 0) latest = row;
  }
  return latest;
}

/**
 * The results-table query as score ROWS (vector included): the latest row
 * per engagement uuid for `profile` at `scoringVersion`. Row count is small
 * (one score per scored source per program), so a filtered scan keeps this
 * simple.
 */
export async function getLatestScoreRowsForProfile(
  db: RadarDb,
  profile: string,
  scoringVersion: string,
): Promise<ScoreRow[]> {
  const rows = (await db.getAll("scores")) as ScoreRow[];
  const latest = new Map<string, ScoreRow>();
  for (const row of rows) {
    if (row.profile !== profile || row.scoring_version !== scoringVersion) {
      continue;
    }
    const current = latest.get(row.uuid);
    if (current === undefined || compareBookkeeping(row, current) > 0) {
      latest.set(row.uuid, row);
    }
  }
  return [...latest.values()];
}

/**
 * The results-table query: the latest score per engagement uuid for
 * `profile` at `scoringVersion`.
 */
export async function getLatestScoresForProfile(
  db: RadarDb,
  profile: string,
  scoringVersion: string,
): Promise<ProgramScore[]> {
  return (await getLatestScoreRowsForProfile(db, profile, scoringVersion)).map(
    (row) => row.score,
  );
}

/** Latest-write ordering: stored_at first, then key fields for stability. */
function compareBookkeeping(
  a: { stored_at: string; source_hash: string },
  b: { stored_at: string; source_hash: string },
): number {
  if (a.stored_at !== b.stored_at) return a.stored_at < b.stored_at ? -1 : 1;
  return a.source_hash < b.source_hash
    ? -1
    : a.source_hash > b.source_hash
      ? 1
      : 0;
}

/** Upsert a run record; `run_id` is the key. */
export async function putRun(db: RadarDb, run: RadarRunRecord): Promise<void> {
  await db.put("runs", run);
}

export async function getRun(
  db: RadarDb,
  runId: string,
): Promise<RadarRunRecord | null> {
  return ((await db.get("runs", runId)) as RadarRunRecord | undefined) ?? null;
}

/** The "runs.latest" pointer — meta row {key: "latestRunId", value: runId}. */
export async function setLatestRunId(
  db: RadarDb,
  runId: string,
): Promise<void> {
  await db.put("meta", { key: META_LATEST_RUN_ID, value: runId });
}

export async function getLatestRunId(db: RadarDb): Promise<string | null> {
  const row = (await db.get("meta", META_LATEST_RUN_ID)) as
    | { value?: unknown }
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}
