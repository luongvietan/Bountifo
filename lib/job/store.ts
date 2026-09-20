import { openDB, type IDBPDatabase } from "idb";
import type { Evidence, PermissionFact, SourceRecord } from "../types";

export interface UnitResult {
  unitId: string;
  status: "ok" | "warning" | "failed";
  committedAt: string;
  output?: unknown;
}

type JobDb = IDBPDatabase<unknown>;
const STORES = ["sourceRecords", "evidence", "facts", "unitResults", "blobs"] as const;

export function openStore(): Promise<JobDb> {
  return openDB("bce", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("sourceRecords")) db.createObjectStore("sourceRecords", { keyPath: ["jobId", "sourceKey"] });
      if (!db.objectStoreNames.contains("evidence")) db.createObjectStore("evidence", { keyPath: ["jobId", "evidenceId"] });
      if (!db.objectStoreNames.contains("facts")) db.createObjectStore("facts", { keyPath: ["jobId", "factKey"] });
      if (!db.objectStoreNames.contains("unitResults")) db.createObjectStore("unitResults", { keyPath: ["jobId", "unitId"] });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: ["jobId", "kind"] });
    },
  });
}

export async function commitUnit(
  db: JobDb,
  jobId: string,
  unitId: string,
  writes: {
    records?: SourceRecord[];
    evidence?: Evidence[];
    facts?: Record<string, PermissionFact>;
    blob?: { kind: string; value: unknown };
  },
  result: UnitResult,
): Promise<void> {
  const tx = db.transaction([...STORES], "readwrite");
  for (const record of writes.records ?? []) {
    await tx.objectStore("sourceRecords").put({ jobId, sourceKey: record.sourceKey, value: record });
  }
  for (const item of writes.evidence ?? []) {
    await tx.objectStore("evidence").put({ jobId, evidenceId: item.id, value: item });
  }
  for (const [factKey, fact] of Object.entries(writes.facts ?? {})) {
    await tx.objectStore("facts").put({ jobId, factKey, value: fact });
  }
  if (writes.blob !== undefined) {
    await tx.objectStore("blobs").put({ jobId, kind: writes.blob.kind, value: writes.blob.value });
  }
  await tx.objectStore("unitResults").put({ jobId, ...result, unitId });
  await tx.done;
}

async function rowsFor(db: JobDb, store: string, jobId: string): Promise<Record<string, unknown>[]> {
  const rows = (await db.getAll(store)) as Record<string, unknown>[];
  return rows.filter((row) => row.jobId === jobId);
}

export async function getBlob<T>(db: JobDb, jobId: string, kind: string): Promise<T | null> {
  const row = (await db.get("blobs", [jobId, kind])) as { value?: T } | undefined;
  return row?.value ?? null;
}

export async function getUnitResults(db: JobDb, jobId: string): Promise<UnitResult[]> {
  return (await rowsFor(db, "unitResults", jobId)).map(({ jobId: _job, ...row }) => row as unknown as UnitResult);
}

export async function getAllRecords(db: JobDb, jobId: string): Promise<SourceRecord[]> {
  return (await rowsFor(db, "sourceRecords", jobId)).map((row) => row.value as SourceRecord);
}

export async function getAllEvidence(db: JobDb, jobId: string): Promise<Evidence[]> {
  return (await rowsFor(db, "evidence", jobId)).map((row) => row.value as Evidence);
}

export async function getAllFacts(db: JobDb, jobId: string): Promise<Record<string, PermissionFact>> {
  return Object.fromEntries((await rowsFor(db, "facts", jobId)).map((row) => [String(row.factKey), row.value as PermissionFact]));
}

export async function verifyJobData(
  db: JobDb,
  jobId: string,
  required: string[],
): Promise<{ ok: boolean; missing: string[] }> {
  const units = new Set((await getUnitResults(db, jobId)).map((r) => r.unitId));
  const blobs = new Set((await rowsFor(db, "blobs", jobId)).map((r) => String(r.kind)));
  const missing = required.filter((key) => key.startsWith("u") ? !units.has(key) : !blobs.has(key));
  return { ok: missing.length === 0, missing };
}

export async function purgeJob(db: JobDb, jobId: string): Promise<void> {
  const tx = db.transaction([...STORES], "readwrite");
  for (const store of STORES) {
    const rows = (await tx.objectStore(store).getAll()) as Record<string, unknown>[];
    for (const row of rows) {
      if (row.jobId !== jobId) continue;
      const key =
        store === "sourceRecords" ? [jobId, row.sourceKey] :
        store === "evidence" ? [jobId, row.evidenceId] :
        store === "facts" ? [jobId, row.factKey] :
        store === "unitResults" ? [jobId, row.unitId] : [jobId, row.kind];
      await tx.objectStore(store).delete(key);
    }
  }
  await tx.done;
}

export type { JobDb };
