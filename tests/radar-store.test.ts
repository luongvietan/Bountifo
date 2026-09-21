import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  getCatalog,
  getLatestRunId,
  getLatestScoresForProfile,
  getLatestSnapshot,
  getRun,
  getScores,
  openRadarStore,
  putCatalogItems,
  putRun,
  putScore,
  putSnapshot,
  setLatestRunId,
} from "../lib/radar/store";
import type {
  ProgramScore,
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "../lib/radar/types";

const T1 = "2026-09-21T00:00:00.000Z";
const T2 = "2026-09-22T00:00:00.000Z";
const T3 = "2026-09-23T00:00:00.000Z";

function catalogItem(uuid: string, code = "acme"): RadarCatalogItem {
  return {
    uuid,
    code,
    name: "Acme",
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: T1,
  };
}

function snapshot(uuid: string, sourceHash: string): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid,
    code: "acme",
    catalog: catalogItem(uuid),
    detail: null,
    enrichment: { status: "unavailable", error_kind: "forbidden" },
    source_hash: sourceHash,
  };
}

function score(
  uuid: string,
  sourceHash: string,
  value: number,
  scoringVersion = "1.0.0",
  profile: ProgramScore["profile"] = "best_ev",
): ProgramScore {
  return {
    schema_version: 1,
    engagement_uuid: uuid,
    profile,
    scoring_version: scoringVersion,
    score: value,
    confidence: 0.9,
    components: {},
    reasons: [],
    source_hash: sourceHash,
  };
}

describe("radar store: catalog", () => {
  it("round-trips catalog items and overwrites by uuid on re-put", async () => {
    const db = await openRadarStore();
    await putCatalogItems(db, [catalogItem("u1"), catalogItem("u2", "beta")]);
    expect((await getCatalog(db)).map((i) => i.uuid).sort()).toEqual([
      "u1",
      "u2",
    ]);
    await putCatalogItems(db, [catalogItem("u1", "acme-renamed")]);
    const rows = await getCatalog(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((i) => i.uuid === "u1")?.code).toBe("acme-renamed");
    db.close();
  });
});

describe("radar store: snapshots", () => {
  it("returns the latest snapshot per uuid by stored_at, not write order", async () => {
    const db = await openRadarStore();
    const older = snapshot("u1", "sha256:" + "a".repeat(64));
    const newer = snapshot("u1", "sha256:" + "b".repeat(64));
    await putSnapshot(db, newer, T2);
    await putSnapshot(db, older, T1); // written later, stored earlier
    expect(await getLatestSnapshot(db, "u1")).toEqual(newer);
    db.close();
  });

  it("keeps snapshots for different uuids isolated; missing uuid → null", async () => {
    const db = await openRadarStore();
    await putSnapshot(db, snapshot("u1", "sha256:" + "a".repeat(64)), T1);
    await putSnapshot(db, snapshot("u2", "sha256:" + "c".repeat(64)), T3);
    expect((await getLatestSnapshot(db, "u1"))?.uuid).toBe("u1");
    expect((await getLatestSnapshot(db, "u2"))?.uuid).toBe("u2");
    expect(await getLatestSnapshot(db, "nope")).toBeNull();
    db.close();
  });

  it("re-putting the same [uuid, source_hash] does not duplicate rows", async () => {
    const db = await openRadarStore();
    // Unique uuid per test — the bce-radar DB persists for the file's
    // duration (same convention as store.test.ts's unique jobIds).
    const uuid = `u-dedupe-${crypto.randomUUID()}`;
    const snap = snapshot(uuid, "sha256:" + "a".repeat(64));
    await putSnapshot(db, snap, T1);
    await putSnapshot(db, snap, T2);
    const all = (await db.getAll("snapshots")) as { uuid: string }[];
    expect(all.filter((r) => r.uuid === uuid)).toHaveLength(1);
    // Latest write wins for the row's bookkeeping timestamp.
    expect((await getLatestSnapshot(db, uuid))?.source_hash).toBe(
      snap.source_hash,
    );
    db.close();
  });
});

describe("radar store: scores", () => {
  it("getScores returns the score history for one uuid+profile", async () => {
    const db = await openRadarStore();
    await putScore(db, score("u1", "sha256:" + "a".repeat(64), 50), T1);
    await putScore(db, score("u1", "sha256:" + "b".repeat(64), 60), T2);
    await putScore(
      db,
      score("u1", "sha256:" + "c".repeat(64), 70, "1.0.0", "high_reward"),
      T3,
    );
    const history = await getScores(db, "u1", "best_ev");
    expect(history.map((s) => s.score).sort()).toEqual([50, 60]);
    db.close();
  });

  it("getLatestScoresForProfile returns latest per uuid at a scoring version", async () => {
    const db = await openRadarStore();
    // u1: two versions of the same profile+version → newest wins.
    await putScore(db, score("u1", "sha256:" + "a".repeat(64), 50), T1);
    await putScore(db, score("u1", "sha256:" + "b".repeat(64), 60), T2);
    // u2: one score at the same profile+version.
    await putScore(db, score("u2", "sha256:" + "c".repeat(64), 70), T1);
    // Noise: different scoring version and different profile.
    await putScore(db, score("u1", "sha256:" + "d".repeat(64), 99, "9.9.9"), T3);
    await putScore(
      db,
      score("u3", "sha256:" + "e".repeat(64), 80, "1.0.0", "high_reward"),
      T3,
    );
    const latest = await getLatestScoresForProfile(db, "best_ev", "1.0.0");
    expect(latest).toHaveLength(2);
    const byUuid = new Map(latest.map((s) => [s.engagement_uuid, s.score]));
    expect(byUuid.get("u1")).toBe(60);
    expect(byUuid.get("u2")).toBe(70);
    db.close();
  });

  it("re-putting the same score key does not duplicate rows", async () => {
    const db = await openRadarStore();
    const uuid = `u-dedupe-${crypto.randomUUID()}`;
    const s = score(uuid, "sha256:" + "a".repeat(64), 50);
    await putScore(db, s, T1);
    await putScore(db, s, T2);
    expect(await getScores(db, uuid, "best_ev")).toHaveLength(1);
    db.close();
  });
});

describe("radar store: runs and latest pointer", () => {
  it("round-trips run records and the latest-run pointer", async () => {
    const db = await openRadarStore();
    const run = {
      run_id: "run-1",
      status: "running",
      started_at: T1,
      progress: { done: 3, total: 10 },
    };
    await putRun(db, run);
    expect(await getRun(db, "run-1")).toEqual(run);
    expect(await getRun(db, "missing")).toBeNull();

    expect(await getLatestRunId(db)).toBeNull();
    await setLatestRunId(db, "run-1");
    expect(await getLatestRunId(db)).toBe("run-1");
    await putRun(db, { run_id: "run-2", status: "complete" });
    await setLatestRunId(db, "run-2");
    expect(await getLatestRunId(db)).toBe("run-2");
    db.close();
  });
});
