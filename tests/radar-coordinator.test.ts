import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEngagementData } from "../lib/types";
import type { CatalogScanResult } from "../lib/radar/catalog";
import { RADAR_PROFILE_IDS } from "../lib/radar/types";
import type {
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "../lib/radar/types";

// Coordinator tests use injected deps — no fetch, no fakeBrowser, no fake
// timers. fake-indexeddb backs the real store; the `bce-radar` DB persists for
// the file's duration (same convention as radar-store.test.ts), so every test
// uses unique uuids/run ids and each run is left in a terminal phase.
// Modules are re-imported per test (vi.resetModules) so ApiError identity
// matches the coordinator's own imports.

type CoordinatorModule = typeof import("../lib/radar/coordinator");
type StoreModule = typeof import("../lib/radar/store");
type ErrorsModule = typeof import("../lib/api/errors");

const T0 = "2026-09-21T00:00:00.000Z";

let coordinator: CoordinatorModule;
let store: StoreModule;
let errors: ErrorsModule;
let runSeq = 0;
let snapSeq = 0;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  errors = await import("../lib/api/errors");
  store = await import("../lib/radar/store");
  coordinator = await import("../lib/radar/coordinator");
});

function item(uuid: string, code = `c-${uuid}`): RadarCatalogItem {
  return {
    uuid,
    code,
    name: `Program ${uuid}`,
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: T0,
  };
}

/** Minimal ApiEngagementData that scores non-null on the weighted signals. */
function detail(uuid: string, p1: number | null = 5000): ApiEngagementData {
  return {
    uuid,
    name: `Program ${uuid}`,
    code: `c-${uuid}`,
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: T0,
    lastBriefUpdate: T0,
    safeHarborLevel: "full",
    statistics: {
      researchers_participating: { value: "50", window: "all_time" },
      vulnerabilities_rewarded: { value: "30", window: "90d" },
    },
    targetGroups: [
      {
        id: `g-${uuid}`,
        name: "Web",
        inScope: true,
        description: null,
        rewards: { p1, p2: 500, p3: 100, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: `t-${uuid}`,
        groupId: `g-${uuid}`,
        location: "https://a.example.com",
        name: "site",
        category: "website",
        tags: [],
        inScope: true,
      },
    ],
    observedApiVersion: "2026-09-20",
  };
}

function snap(
  it: RadarCatalogItem,
  opts: {
    status?: "complete" | "unavailable" | "failed";
    error_kind?: string;
    det?: ApiEngagementData | null;
  } = {},
): RadarProgramSnapshot {
  const status = opts.status ?? "complete";
  return {
    schema_version: 1,
    uuid: it.uuid,
    code: it.code,
    catalog: it,
    detail: status === "complete" ? (opts.det ?? detail(it.uuid)) : null,
    enrichment:
      status === "complete"
        ? { status }
        : { status, error_kind: opts.error_kind ?? "forbidden" },
    source_hash: `sha256:${String(++snapSeq).padStart(64, "0")}`,
  };
}

function deferred<T>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function until(cond: () => Promise<boolean>, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await tick();
  }
  throw new Error("condition not met");
}

interface RadarDeps {
  enumerate: () => Promise<CatalogScanResult>;
  hydrate: (it: RadarCatalogItem) => Promise<RadarProgramSnapshot>;
  openStore: () => Promise<import("../lib/radar/store").RadarDb>;
  now: () => string;
  concurrency?: number;
  newRunId: () => string;
}

function makeDeps(
  items: RadarCatalogItem[],
  overrides: Partial<RadarDeps> = {},
): {
  deps: RadarDeps;
  enumerate: ReturnType<typeof vi.fn>;
  hydrate: ReturnType<typeof vi.fn>;
} {
  const enumerate = vi.fn(
    async (): Promise<CatalogScanResult> => ({
      status: "complete",
      items,
      pages_fetched: 1,
      warnings: [],
    }),
  );
  const hydrate = vi.fn(async (it: RadarCatalogItem) => snap(it));
  return {
    deps: {
      enumerate,
      hydrate,
      openStore: store.openRadarStore,
      now: () => T0,
      concurrency: 2,
      newRunId: () => `run-test-${++runSeq}`,
      ...overrides,
    },
    enumerate,
    hydrate,
  };
}

describe("RadarCoordinator happy path", () => {
  it("runs catalog → enrich → score → done and persists every artifact", async () => {
    const items = [item("u-a1"), item("u-a2")];
    const { deps, enumerate, hydrate } = makeDeps(items);
    const coord = new coordinator.RadarCoordinator(deps);

    const run = await coord.start();
    await coord.waitForIdle();

    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(run.run_id).toBe("run-test-1");
    expect(run.phase).toBe("done");
    expect(run.discovered).toBe(2);
    expect(run.enriched).toBe(2);
    expect(run.scored).toBe(2);
    expect(run.pending_uuids).toEqual([]);
    expect([...run.completed_uuids].sort()).toEqual(["u-a1", "u-a2"]);
    expect(run.summary).toMatchObject({
      status: "complete",
      catalog_complete: true,
      discovered: 2,
      enriched: 2,
      enrichment_failed: 0,
      scored: 2,
      warnings: [],
    });

    const db = await store.openRadarStore();
    // Checkpoint persistence: the store copy of the run is fully populated.
    const persisted = await store.getRun(db, run.run_id);
    expect(persisted?.phase).toBe("done");
    expect(persisted?.summary).toMatchObject({ status: "complete" });
    expect(await store.getLatestRunId(db)).toBe(run.run_id);
    // Catalog rows + snapshots persisted.
    const catalog = await store.getCatalog(db);
    expect(catalog.map((i) => i.uuid)).toEqual(
      expect.arrayContaining(["u-a1", "u-a2"]),
    );
    expect((await store.getLatestSnapshot(db, "u-a1"))?.enrichment.status).toBe(
      "complete",
    );
    // One score per profile per program, vector embedded on the score row.
    for (const pid of RADAR_PROFILE_IDS) {
      expect(await store.getScores(db, "u-a1", pid)).toHaveLength(1);
    }
    const scoreRows = await store.getLatestScoreRowsForProfile(
      db,
      "best_ev",
      "1.0.0",
    );
    const rowA1 = scoreRows.find((r) => r.uuid === "u-a1");
    expect(rowA1?.vector?.reward_potential.value).not.toBeNull();
    db.close();
  });

  it("start() during an active run returns the same run (idempotent)", async () => {
    const gate = deferred<void>();
    const items = [item("u-b1"), item("u-b2")];
    const { deps, enumerate } = makeDeps(items);
    deps.hydrate = vi.fn(async (it: RadarCatalogItem) => {
      await gate.promise;
      return snap(it);
    });
    const coord = new coordinator.RadarCoordinator(deps);
    const run1 = await coord.start();
    const run2 = await coord.start();
    expect(run2.run_id).toBe(run1.run_id);
    expect(enumerate).toHaveBeenCalledTimes(1);
    gate.resolve();
    await coord.waitForIdle();
    expect(run1.phase).toBe("done");
  });

  it("start() after a terminal run creates a fresh run", async () => {
    const { deps, enumerate } = makeDeps([item("u-b9")]);
    const coord = new coordinator.RadarCoordinator(deps);
    const first = await coord.start();
    await coord.waitForIdle();
    expect(first.phase).toBe("done");
    const second = await coord.start();
    expect(second.run_id).not.toBe(first.run_id);
    await coord.waitForIdle();
    expect(second.phase).toBe("done");
    expect(enumerate).toHaveBeenCalledTimes(2);
  });
});

describe("RadarCoordinator failure semantics", () => {
  it("a program-scoped failure does not kill the run (summary partial)", async () => {
    const items = [item("u-c1"), item("u-c2"), item("u-c3")];
    const { deps } = makeDeps(items);
    const hydrate = vi.fn(async (it: RadarCatalogItem) =>
      it.uuid === "u-c2"
        ? snap(it, { status: "unavailable", error_kind: "forbidden" })
        : snap(it),
    );
    deps.hydrate = hydrate;
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();

    expect(run.phase).toBe("done");
    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(run.enriched).toBe(2);
    expect(run.completed_uuids).toHaveLength(3);
    expect(run.summary?.status).toBe("partial");
    expect(run.summary?.catalog_complete).toBe(true);
    expect(run.summary?.enrichment_failed).toBe(1);
    expect(run.summary?.warnings).toContain("u-c2: forbidden");
  });

  it("a fatal ApiError fails the run and stops dispatching new work", async () => {
    const items = [item("u-d1"), item("u-d2"), item("u-d3")];
    const { deps } = makeDeps(items);
    const hydrate = vi.fn(async (it: RadarCatalogItem) => {
      if (it.uuid === "u-d2") {
        throw new errors.ApiError("unauthorized", "token rejected", 401);
      }
      return snap(it);
    });
    deps.hydrate = hydrate;
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();

    expect(run.phase).toBe("failed");
    expect(run.summary?.status).toBe("failed");
    expect(run.summary?.warnings).toContain("u-d2: unauthorized");
    // u-d3 was never dispatched; the fatal uuid stays pending for inspection.
    expect(hydrate).toHaveBeenCalledTimes(2);
    const db = await store.openRadarStore();
    const persisted = await store.getRun(db, run.run_id);
    expect(persisted?.phase).toBe("failed");
    expect(persisted?.pending_uuids).toEqual(
      expect.arrayContaining(["u-d2", "u-d3"]),
    );
    db.close();
  });

  it("a failed catalog ends the run as failed", async () => {
    const items = [item("u-f0")];
    const { deps, hydrate } = makeDeps(items);
    deps.enumerate = vi.fn(
      async (): Promise<CatalogScanResult> => ({
        status: "failed",
        items,
        pages_fetched: 0,
        warnings: ["forbidden"],
      }),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("failed");
    expect(run.summary?.status).toBe("failed");
    expect(run.summary?.catalog_complete).toBe(false);
    expect(run.summary?.warnings).toContain("forbidden");
    expect(hydrate).not.toHaveBeenCalled();
  });
});

describe("RadarCoordinator cancellation", () => {
  it("cancel() stops dispatching and flips the run to cancelled", async () => {
    const items = [item("u-e1"), item("u-e2"), item("u-e3")];
    const { deps } = makeDeps(items);
    const gates = new Map<
      string,
      ReturnType<typeof deferred<RadarProgramSnapshot>>
    >();
    const hydrate = vi.fn((it: RadarCatalogItem) => {
      const d = deferred<RadarProgramSnapshot>();
      gates.set(it.uuid, d);
      return d.promise;
    });
    deps.hydrate = hydrate;
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await until(async () => hydrate.mock.calls.length === 2);

    const cancelP = coord.cancel();
    gates.get("u-e1")!.resolve(snap(items[0]!));
    gates.get("u-e2")!.resolve(snap(items[1]!));
    const cancelled = await cancelP;

    expect(cancelled?.phase).toBe("cancelled");
    expect(hydrate).toHaveBeenCalledTimes(2);
    const db = await store.openRadarStore();
    const persisted = await store.getRun(db, run.run_id);
    expect(persisted?.phase).toBe("cancelled");
    expect(persisted?.completed_uuids).toEqual(
      expect.arrayContaining(["u-e1", "u-e2"]),
    );
    expect(persisted?.pending_uuids).toEqual(["u-e3"]);
    db.close();
  });
});

describe("RadarCoordinator bounded concurrency", () => {
  it("never exceeds the configured hydration concurrency", async () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`u-cc${i}`));
    const { deps } = makeDeps(items);
    let inflight = 0;
    let maxInflight = 0;
    const hydrate = vi.fn(async (it: RadarCatalogItem) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return snap(it);
    });
    deps.hydrate = hydrate;
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    expect(hydrate).toHaveBeenCalledTimes(5);
    expect(maxInflight).toBe(2);
  });

  it("checkpoints the run record after every program", async () => {
    const items = [item("u-q1"), item("u-q2")];
    const { deps } = makeDeps(items);
    const d1 = deferred<RadarProgramSnapshot>();
    const d2 = deferred<RadarProgramSnapshot>();
    deps.hydrate = vi.fn((it: RadarCatalogItem) =>
      it.uuid === "u-q1" ? d1.promise : d2.promise,
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    const db = await store.openRadarStore();

    d1.resolve(snap(items[0]!));
    await until(async () => {
      const rec = await store.getRun(db, run.run_id);
      return (
        Array.isArray(rec?.completed_uuids) &&
        (rec.completed_uuids as string[]).includes("u-q1")
      );
    });
    const mid = await store.getRun(db, run.run_id);
    expect(mid?.phase).toBe("enriching");
    expect(mid?.enriched).toBe(1);
    expect(mid?.pending_uuids).toEqual(["u-q2"]);

    d2.resolve(snap(items[1]!));
    await coord.waitForIdle();
    const done = await store.getRun(db, run.run_id);
    expect(done?.phase).toBe("done");
    expect(done?.enriched).toBe(2);
    db.close();
  });
});

describe("RadarCoordinator resume", () => {
  it("a second coordinator resumes pending work without re-enumerating", async () => {
    const items = [item("u-g1"), item("u-g2")];
    const a = makeDeps(items);
    const stuck = deferred<RadarProgramSnapshot>();
    a.deps.hydrate = vi.fn((it: RadarCatalogItem) =>
      it.uuid === "u-g1" ? Promise.resolve(snap(it)) : stuck.promise,
    );
    const coordA = new coordinator.RadarCoordinator(a.deps);
    const run = await coordA.start();
    const db = await store.openRadarStore();
    await until(async () => {
      const rec = await store.getRun(db, run.run_id);
      return (
        Array.isArray(rec?.completed_uuids) &&
        (rec.completed_uuids as string[]).includes("u-g1")
      );
    });

    // Simulated SW restart: a fresh coordinator over the same persisted DB.
    const b = makeDeps(items);
    const coordB = new coordinator.RadarCoordinator(b.deps);
    await coordB.resume();

    // The persisted catalog was complete — no re-enumeration; only the still
    // pending uuid is hydrated (u-g2 was in-flight when A "died").
    expect(b.enumerate).not.toHaveBeenCalled();
    expect(b.hydrate).toHaveBeenCalledTimes(1);
    expect(b.hydrate.mock.calls[0]![0].uuid).toBe("u-g2");

    const rec = await store.getRun(db, run.run_id);
    expect(rec?.phase).toBe("done");
    expect(rec?.completed_uuids).toEqual(
      expect.arrayContaining(["u-g1", "u-g2"]),
    );
    expect((rec?.summary as { status?: string } | undefined)?.status).toBe(
      "complete",
    );
    // The resumed uuid was scored, not merely hydrated.
    expect(
      await store.getLatestScoreRow(db, "u-g2", "best_ev", "1.0.0"),
    ).not.toBeNull();
    db.close();
    // coordA is intentionally left hung on `stuck` — it models the dead worker.
  });

  it("resume() re-enumerates when catalog rows for pending uuids are missing", async () => {
    const db = await store.openRadarStore();
    const itX = item("u-j1");
    await store.putRun(db, {
      run_id: "run-seeded-missing-catalog",
      phase: "enriching",
      discovered: 1,
      enriched: 0,
      scored: 0,
      pending_uuids: ["u-j1"],
      completed_uuids: [],
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
    });
    await store.setLatestRunId(db, "run-seeded-missing-catalog");

    const { deps, enumerate, hydrate } = makeDeps([itX]);
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();

    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate.mock.calls[0]![0].uuid).toBe("u-j1");
    const rec = await store.getRun(db, "run-seeded-missing-catalog");
    expect(rec?.phase).toBe("done");
    db.close();
  });

  it("start() kicks off an executor for a run adopted without one", async () => {
    // Regression: getState() adopts a persisted active run into memory
    // WITHOUT starting an executor; a subsequent start() must not just return
    // the run — it must kick off the work (models resume() having failed,
    // e.g. a transient IDB open error under `void radar.resume()`).
    const db = await store.openRadarStore();
    const itX = item("u-exec1");
    await store.putCatalogItems(db, [itX]);
    await store.putRun(db, {
      run_id: "run-seeded-active",
      phase: "enriching",
      discovered: 1,
      enriched: 0,
      scored: 0,
      pending_uuids: ["u-exec1"],
      completed_uuids: [],
      warnings: 0,
      started_at: T0,
      updated_at: T0,
      catalog_complete: true,
      enrichment_failed: 0,
      warning_details: [],
      cancel_requested: false,
    });
    await store.setLatestRunId(db, "run-seeded-active");

    const { deps, enumerate, hydrate } = makeDeps([itX]);
    const coord = new coordinator.RadarCoordinator(deps);
    // Read-only path adopts the run — no executor may start here.
    const state = await coord.getState();
    expect(state?.run_id).toBe("run-seeded-active");
    expect(state?.phase).toBe("enriching");
    expect(hydrate).not.toHaveBeenCalled();

    const run = await coord.start();
    expect(run.run_id).toBe("run-seeded-active");
    await coord.waitForIdle();
    expect(enumerate).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate.mock.calls[0]![0].uuid).toBe("u-exec1");
    const rec = await store.getRun(db, "run-seeded-active");
    expect(rec?.phase).toBe("done");
    db.close();
  });

  it("resume() is a no-op for terminal runs", async () => {
    const db = await store.openRadarStore();
    await store.putRun(db, {
      run_id: "run-seeded-done",
      phase: "done",
      discovered: 1,
      enriched: 1,
      scored: 1,
      pending_uuids: [],
      completed_uuids: ["u-z1"],
      warnings: 0,
      started_at: T0,
      updated_at: T0,
    });
    await store.setLatestRunId(db, "run-seeded-done");
    const { deps, enumerate, hydrate } = makeDeps([item("u-z9")]);
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.resume();
    expect(enumerate).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    // The terminal run is still exposed via getState.
    expect((await coord.getState())?.run_id).toBe("run-seeded-done");
    db.close();
  });
});

describe("RadarCoordinator summary status rules", () => {
  it("partial catalog alone makes the summary partial", async () => {
    const items = [item("u-k1")];
    const { deps } = makeDeps(items);
    deps.enumerate = vi.fn(
      async (): Promise<CatalogScanResult> => ({
        status: "partial",
        items,
        pages_fetched: 100,
        warnings: ["page_limit_reached"],
      }),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");
    expect(run.summary?.status).toBe("partial");
    expect(run.summary?.catalog_complete).toBe(false);
    expect(run.summary?.enrichment_failed).toBe(0);
    expect(run.summary?.warnings).toContain("page_limit_reached");
  });
});

describe("RadarCoordinator queries", () => {
  it("getResults joins latest scores with catalog rows in rank order", async () => {
    const low = item("u-r-low");
    const high = item("u-r-high");
    const { deps } = makeDeps([low, high]);
    deps.hydrate = vi.fn(async (it: RadarCatalogItem) =>
      snap(it, { det: detail(it.uuid, it.uuid === "u-r-high" ? 20000 : 100) }),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.start();
    await coord.waitForIdle();

    const rows = await coord.getResults("best_ev", 50);
    // Other tests' rows may coexist in the shared DB — assert on this test's
    // subset and its relative order.
    const mine = rows.filter((r) =>
      ["u-r-low", "u-r-high"].includes(r.uuid),
    );
    expect(mine.map((r) => r.uuid)).toEqual(["u-r-high", "u-r-low"]);
    const highRow = mine[0]!;
    expect(highRow.code).toBe(high.code);
    expect(highRow.name).toBe(high.name);
    expect(highRow.eligible).toBe(true);
    expect(highRow.score).not.toBeNull();
    expect(highRow.signals.reward_potential).not.toBeNull();
    expect(Object.keys(highRow.signals).sort()).toEqual([
      "api_surface",
      "freshness",
      "meaningful_surface",
      "researcher_competition",
      "reward_potential",
      "web_surface",
    ]);

    // limit clamp + minConfidence filter.
    expect((await coord.getResults("best_ev", 1)).length).toBeLessThanOrEqual(1);
    const huge = await coord.getResults("best_ev", 500);
    expect(huge.length).toBeLessThanOrEqual(200);
    const filtered = await coord.getResults("best_ev", 50, 1.0);
    for (const r of filtered) expect(r.confidence).toBeGreaterThanOrEqual(1.0);
  });

  it("getResults for a profile returns that profile's scores", async () => {
    const { deps } = makeDeps([item("u-rp1")]);
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.start();
    await coord.waitForIdle();
    const rows = await coord.getResults("fresh_programs", 50);
    const mine = rows.find((r) => r.uuid === "u-rp1");
    expect(mine).toBeDefined();
    // fresh_programs weights freshness ×5; fixture is brand-new → high score.
    expect(mine!.signals.freshness).toBe(1);
  });

  it("getProgram returns snapshot, score, explanation and catalog", async () => {
    const { deps } = makeDeps([item("u-p1")]);
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.start();
    await coord.waitForIdle();

    const prog = await coord.getProgram("u-p1", "best_ev");
    expect(prog?.snapshot?.uuid).toBe("u-p1");
    expect(prog?.score?.profile).toBe("best_ev");
    expect(prog?.explanation.length).toBeGreaterThan(0);
    expect(prog?.catalog?.uuid).toBe("u-p1");
    // Default profile is best_ev.
    const defaulted = await coord.getProgram("u-p1");
    expect(defaulted?.score?.profile).toBe("best_ev");
    // Unknown uuid → null envelope.
    expect(await coord.getProgram("u-p-absent")).toBeNull();
  });
});

describe("RadarCoordinator latest-run scoping", () => {
  it("a program absent from the latest run stops ranking, rows kept", async () => {
    const first = [item("u-s-old"), item("u-s-keep")];
    const second = [item("u-s-keep"), item("u-s-new")];
    const { deps } = makeDeps([]);
    deps.enumerate = vi
      .fn()
      .mockResolvedValueOnce({
        status: "complete",
        items: first,
        pages_fetched: 1,
        warnings: [],
      } satisfies CatalogScanResult)
      .mockResolvedValueOnce({
        status: "complete",
        items: second,
        pages_fetched: 1,
        warnings: [],
      } satisfies CatalogScanResult);
    const coord = new coordinator.RadarCoordinator(deps);

    const run1 = await coord.start();
    await coord.waitForIdle();
    expect(run1.phase).toBe("done");
    const rows1 = (await coord.getResults("best_ev", 50)).map((r) => r.uuid);
    expect(rows1).toEqual(expect.arrayContaining(["u-s-old", "u-s-keep"]));
    expect(rows1).not.toContain("u-s-new");

    // Second scan: u-s-old disappeared from the catalog.
    const run2 = await coord.start();
    await coord.waitForIdle();
    expect(run2.phase).toBe("done");
    const rows2 = (await coord.getResults("best_ev", 50)).map((r) => r.uuid);
    expect(rows2).toEqual(expect.arrayContaining(["u-s-keep", "u-s-new"]));
    expect(rows2).not.toContain("u-s-old");

    const db = await store.openRadarStore();
    // Non-destructive: the dropped program's cache rows are still stored…
    expect(await store.getCatalogItem(db, "u-s-old")).not.toBeNull();
    expect(
      await store.getLatestScoreRow(db, "u-s-old", "best_ev", "1.0.0"),
    ).not.toBeNull();
    db.close();
    // …but neither results nor drill-down surface it anymore.
    expect(await coord.getProgram("u-s-old", "best_ev")).toBeNull();
    expect(await coord.getProgram("u-s-keep", "best_ev")).not.toBeNull();
  });

  it("returns empty results when no latest run exists but scores persist", async () => {
    const { deps } = makeDeps([item("u-norun1")]);
    const coord = new coordinator.RadarCoordinator(deps);
    await coord.start();
    await coord.waitForIdle();
    const db = await store.openRadarStore();
    // Score rows really are in the DB…
    expect(
      (await store.getLatestScoreRowsForProfile(db, "best_ev", "1.0.0"))
        .length,
    ).toBeGreaterThan(0);
    // …but with no run to scope them to, nothing ranks.
    await db.delete("meta", "latestRunId");
    expect(await store.getLatestRunId(db)).toBeNull();
    expect(await coord.getResults("best_ev", 50)).toEqual([]);
    expect(await coord.getProgram("u-norun1", "best_ev")).toBeNull();
    db.close();
  });

  it("a latest run that discovered zero uuids yields zero results", async () => {
    // Seed a real score row first so the empty result is attributable to
    // scoping, not an empty store.
    const seeded = makeDeps([item("u-empty-seed")]);
    const seedCoord = new coordinator.RadarCoordinator(seeded.deps);
    await seedCoord.start();
    await seedCoord.waitForIdle();
    const db = await store.openRadarStore();
    expect(
      await store.getLatestScoreRow(db, "u-empty-seed", "best_ev", "1.0.0"),
    ).not.toBeNull();

    // The new latest run fails catalog discovery with zero uuids.
    const { deps } = makeDeps([]);
    deps.enumerate = vi.fn(
      async (): Promise<CatalogScanResult> => ({
        status: "failed",
        items: [],
        pages_fetched: 0,
        warnings: ["forbidden"],
      }),
    );
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("failed");
    expect(await coord.getResults("best_ev", 50)).toEqual([]);
    expect(await coord.getProgram("u-empty-seed", "best_ev")).toBeNull();
    db.close();
  });
});
