import "fake-indexeddb/auto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { API_BASE } from "../lib/constants";
import type { CatalogScanResult } from "../lib/radar/catalog";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";
import type {
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Task 18 — end-to-end radar scan against a mocked Bugcrowd API.
//
// A REAL RadarCoordinator is wired to the real enumerate/hydrate functions
// (→ real apiRequest → vi.stubGlobal fetch) and the real IndexedDB store
// (fake-indexeddb). The only fakes are the network itself, the credential in
// fakeBrowser storage, and the injected now/newRunId determinism hooks.
//
// Real timers are used: the 500-exhaustion retry backoff (~4s) runs for real
// inside apiRequest — tests exercising it get an extended timeout.
// ---------------------------------------------------------------------------

const CREDENTIAL = "test-credential-4f8c2b91";
const T0 = "2026-09-21T00:00:00.000Z";

type CatalogModule = typeof import("../lib/radar/catalog");
type EnrichmentModule = typeof import("../lib/radar/enrichment");
type CoordinatorModule = typeof import("../lib/radar/coordinator");
type StoreModule = typeof import("../lib/radar/store");

let catalog: CatalogModule;
let enrichment: EnrichmentModule;
let coordinator: CoordinatorModule;
let store: StoreModule;
let fetchMock: ReturnType<typeof vi.fn>;
let runSeq = 0;

type SetAccessLevelFn = (details: { accessLevel: string }) => Promise<void>;

function stubSetAccessLevel(fn: SetAccessLevelFn | undefined) {
  Object.defineProperty(fakeBrowser.storage.local, "setAccessLevel", {
    value: fn,
    configurable: true,
    writable: true,
  });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/vnd.bugcrowd+json",
      ...(init.headers ?? {}),
    },
  });
}

/** Valid v4-shaped uuid: `…8000-` + zero-padded number. */
function uid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function listRow(uuid: string, code: string): object {
  return {
    type: "engagement",
    id: uuid,
    attributes: {
      code,
      name: `Program ${code}`,
      state: "running",
      engagement_type: "bug_bounty",
    },
  };
}

/** GET_ENGAGEMENT document (JSON:API data + included) for one uuid. */
function engagementDoc(uuid: string, seed: number): object {
  const gid = `g-${uuid.slice(-4)}`;
  const tid = `t-${uuid.slice(-4)}`;
  return {
    data: {
      type: "engagement",
      id: uuid,
      attributes: {
        name: `Program ${seed}`,
        code: `prog-${seed}`,
        engagement_type: "bug_bounty",
        managed: true,
        state: "running",
        updated_at: "2026-09-01T00:00:00.000Z",
        last_transition_at: "2026-08-01T00:00:00.000Z",
        safe_harbor_status: "full_safe_harbor",
        statistics: {
          researchers_participating: {
            value: String(10 + seed * 7),
            window: null,
          },
          vulnerabilities_rewarded: {
            value: String(seed * 3),
            window: "last_90_days",
          },
        },
      },
      relationships: {
        target_groups: { data: [{ type: "target_group", id: gid }] },
        targets: { data: [{ type: "target", id: tid }] },
      },
    },
    included: [
      {
        type: "target_group",
        id: gid,
        attributes: {
          name: "Web scope",
          in_scope: true,
          // seed 28 → p1 29000 clamps the reward curve to 1.0; the tier
          // blend lands at 0.6121 → REWARD_MEDIUM.
          rewards: { p1: 1000 + seed * 1000, p2: 500, p3: 100 },
        },
      },
      {
        type: "target",
        id: tid,
        attributes: {
          uri: `https://t${seed}.example.com`,
          name: `site-${seed}`,
          category: "website",
          tags: [],
          in_scope: true,
        },
        relationships: {
          target_group: { data: { type: "target_group", id: gid } },
        },
      },
    ],
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function until(
  cond: () => Promise<boolean>,
  tries = 2000,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await tick();
  }
  throw new Error("condition not met");
}

/** Fresh radar DB state — clears every object store. */
async function wipeRadarDb(): Promise<void> {
  const db = await store.openRadarStore();
  const tx = db.transaction(
    ["catalog", "snapshots", "scores", "runs", "meta"],
    "readwrite",
  );
  for (const name of ["catalog", "snapshots", "scores", "runs", "meta"]) {
    await tx.objectStore(name).clear();
  }
  await tx.done;
  db.close();
}

type EnumerateMock = Mock<() => Promise<CatalogScanResult>>;
type HydrateMock = Mock<
  (item: RadarCatalogItem) => Promise<RadarProgramSnapshot>
>;

interface RealDeps {
  deps: RadarCoordinatorDeps;
  enumerate: EnumerateMock;
  hydrate: HydrateMock;
}

/** Real enumerate + real hydrate wrapped in spies for call counting. */
function realDeps(): RealDeps {
  const enumerate: EnumerateMock = vi.fn(() =>
    catalog.enumerateEngagementCatalog(T0),
  );
  const hydrate: HydrateMock = vi.fn((item: RadarCatalogItem) =>
    enrichment.hydrateRadarProgram(item),
  );
  return {
    deps: {
      enumerate,
      hydrate,
      openStore: store.openRadarStore,
      now: () => T0,
      concurrency: 2,
      newRunId: () => `run-int-${++runSeq}`,
    },
    enumerate,
    hydrate,
  };
}

function listCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((c) =>
    String(c[0]).includes("/engagements?"),
  );
}

function getCallsFor(uuid: string): unknown[][] {
  return fetchMock.mock.calls.filter((c) =>
    String(c[0]).includes(`/engagements/${uuid}?`),
  );
}

// ---------------------------------------------------------------------------
// The Task-18 scenario: page 1 = 25 rows, page 2 = 3 rows → 28 unique.
// 25 hydrate OK; uid(10) → 403, uid(11) → malformed doc, uid(12) → 500 always.
// ---------------------------------------------------------------------------

const MAIN_UUIDS = Array.from({ length: 28 }, (_, i) => uid(i + 1));
const FORBIDDEN_UUID = uid(10);
const MALFORMED_UUID = uid(11);
const FLAKY_UUID = uid(12);
const FAILED_UUIDS = [FORBIDDEN_UUID, MALFORMED_UUID, FLAKY_UUID];

/**
 * Router for the 28-program scenario. `flaky500` toggles the uid(12) 500
 * exhaustion — disabled for the determinism test, whose two full runs would
 * otherwise spend the shared 60 req/min rate bucket on retry attempts.
 */
function mainScenarioFetch(
  url: string,
  opts: { flaky500?: boolean } = {},
): Promise<Response> {
  const flaky500 = opts.flaky500 ?? true;
  if (url.startsWith(`${API_BASE}/engagements?`)) {
    const page = Number(/page\[number\]=(\d+)/.exec(url)?.[1] ?? "0");
    if (page === 1) {
      return Promise.resolve(
        jsonResponse({
          data: MAIN_UUIDS.slice(0, 25).map((u, i) =>
            listRow(u, `prog-${i + 1}`),
          ),
        }),
      );
    }
    if (page === 2) {
      return Promise.resolve(
        jsonResponse({
          data: MAIN_UUIDS.slice(25).map((u, i) =>
            listRow(u, `prog-${i + 26}`),
          ),
        }),
      );
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  }
  const uuid = /\/engagements\/([0-9a-f-]{36})\?include=/.exec(url)?.[1] ?? "";
  if (uuid === FORBIDDEN_UUID) {
    return Promise.resolve(jsonResponse({}, { status: 403 }));
  }
  if (uuid === MALFORMED_UUID) {
    // Valid JSON, wrong document shape → parseEngagement rejects it.
    return Promise.resolve(
      jsonResponse({ data: { type: "program", id: uuid } }),
    );
  }
  if (uuid === FLAKY_UUID && flaky500) {
    return Promise.resolve(jsonResponse({}, { status: 500 }));
  }
  const seed = MAIN_UUIDS.indexOf(uuid) + 1;
  return Promise.resolve(jsonResponse(engagementDoc(uuid, seed)));
}

/** Serialized contents of every persisted store — for the credential scan. */
async function persistedBlob(): Promise<string> {
  const db = await store.openRadarStore();
  const rows: unknown[] = [];
  for (const name of ["catalog", "snapshots", "scores", "runs", "meta"]) {
    rows.push(...(await db.getAll(name)));
  }
  db.close();
  return JSON.stringify(rows);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
  await fakeBrowser.storage.local.set({ apiCredential: CREDENTIAL });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  catalog = await import("../lib/radar/catalog");
  enrichment = await import("../lib/radar/enrichment");
  store = await import("../lib/radar/store");
  coordinator = await import("../lib/radar/coordinator");
  await wipeRadarDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("radar scan integration — 28 discovered, 3 program-scoped failures", () => {
  it(
    "runs catalog → enrich → score end to end with a partial summary",
    async () => {
      fetchMock.mockImplementation((input: unknown) =>
        mainScenarioFetch(String(input)),
      );
      const { deps } = realDeps();
      const coord = new coordinator.RadarCoordinator(deps);

      const run = await coord.start();
      await coord.waitForIdle();

      // ---- summary -----------------------------------------------------
      expect(run.phase).toBe("done");
      expect(run.summary).toMatchObject({
        status: "partial",
        catalog_complete: true,
        discovered: 28,
        enriched: 25,
        enrichment_failed: 3,
        // scored counts every completed uuid — the 3 failed enrichments get
        // null-score rows; 25 of them are real scores.
        scored: 28,
      });
      for (const [uuid, kind] of [
        [FORBIDDEN_UUID, "forbidden"],
        [MALFORMED_UUID, "invalid_response"],
        [FLAKY_UUID, "http"],
      ] as const) {
        expect(run.summary?.warnings).toContain(`${uuid}: ${kind}`);
      }

      // ---- catalog ordering + wire calls --------------------------------
      // Exactly two LIST_ENGAGEMENTS calls; 25+? GET calls — the 500 case
      // is retried to MAX_ATTEMPTS (4), the other failures are one-shot.
      expect(listCalls()).toHaveLength(2);
      expect(getCallsFor(FORBIDDEN_UUID)).toHaveLength(1);
      expect(getCallsFor(MALFORMED_UUID)).toHaveLength(1);
      expect(getCallsFor(FLAKY_UUID)).toHaveLength(4);
      // The pipeline really was authenticated…
      for (const call of fetchMock.mock.calls) {
        const init = call[1] as { headers?: Record<string, string> };
        expect(init.headers?.Authorization).toBe(`Token ${CREDENTIAL}`);
      }

      const db = await store.openRadarStore();
      const catalogRows = await store.getCatalog(db);
      // First-seen page order, one row per unique uuid.
      expect(catalogRows.map((i) => i.uuid)).toEqual(MAIN_UUIDS);
      expect(
        new Set(catalogRows.map((i) => i.uuid)).size,
      ).toBe(28);

      // ---- snapshots -----------------------------------------------------
      for (const uuid of MAIN_UUIDS) {
        const snap = await store.getLatestSnapshot(db, uuid);
        expect(snap).not.toBeNull();
        expect(snap!.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        if (FAILED_UUIDS.includes(uuid)) {
          expect(snap!.detail).toBeNull();
          expect(snap!.enrichment.status).not.toBe("complete");
        } else {
          expect(snap!.enrichment).toEqual({ status: "complete" });
          expect(snap!.detail).not.toBeNull();
        }
      }
      expect(
        (await store.getLatestSnapshot(db, FORBIDDEN_UUID))!.enrichment,
      ).toEqual({ status: "unavailable", error_kind: "forbidden" });
      expect(
        (await store.getLatestSnapshot(db, MALFORMED_UUID))!.enrichment,
      ).toEqual({ status: "failed", error_kind: "invalid_response" });
      expect(
        (await store.getLatestSnapshot(db, FLAKY_UUID))!.enrichment,
      ).toEqual({ status: "failed", error_kind: "http" });

      // ---- scores --------------------------------------------------------
      const scoreRows = await store.getLatestScoreRowsForProfile(
        db,
        "best_ev",
        "1.0.0",
      );
      expect(scoreRows).toHaveLength(28);
      const nonNull = scoreRows.filter((r) => r.score.score !== null);
      expect(nonNull).toHaveLength(25); // the brief's "25 scoreable"
      for (const uuid of FAILED_UUIDS) {
        const row = scoreRows.find((r) => r.uuid === uuid);
        expect(row?.score.score).toBeNull();
        expect(row?.score.confidence).toBe(0);
        // Stable reason vocabulary: every gap is an UNKNOWN_<signal> code.
        expect(row?.score.reasons).toHaveLength(10);
        expect(
          row?.score.reasons.every((c) => c.startsWith("UNKNOWN_")),
        ).toBe(true);
      }
      // Stable reason codes on a known-successful program (seed 28 →
      // REWARD_MEDIUM band, recently updated, web surface, full safe harbor).
      const seed28 = scoreRows.find((r) => r.uuid === uid(28));
      expect(seed28?.score.reasons).toEqual([
        "REWARD_MEDIUM",
        "RECENTLY_UPDATED",
        "COMPETITION_LOW",
        "WEB_SURFACE_HIGH",
        "REWARD_BROAD",
        "SAFE_HARBOR_PRESENT",
      ]);

      // ---- results table ---------------------------------------------------
      const results = await coord.getResults("best_ev", 200);
      expect(results).toHaveLength(28);
      const eligible = results.filter((r) => r.eligible);
      expect(eligible).toHaveLength(25);
      // Eligible rows sorted by score DESC; failed programs sink to the end
      // ordered by uuid ASC.
      const eligibleScores = eligible.map((r) => r.score!);
      expect([...eligibleScores].sort((a, b) => b - a)).toEqual(
        eligibleScores,
      );
      expect(results.slice(25).map((r) => r.uuid)).toEqual(
        [...FAILED_UUIDS].sort(),
      );
      expect(results.slice(25).every((r) => r.score === null)).toBe(true);

      // ---- per-program drill-down ------------------------------------------
      const detail = await coord.getProgram(FORBIDDEN_UUID, "best_ev");
      expect(detail?.snapshot?.enrichment.status).toBe("unavailable");
      expect(detail?.score?.score).toBeNull();
      expect(detail?.explanation.every((l) => l.startsWith("? "))).toBe(true);

      // ---- no credentials in persisted state --------------------------------
      const blob = await persistedBlob();
      expect(blob).not.toContain(CREDENTIAL);
      expect(blob).not.toContain("Token ");
      expect(blob.toLowerCase()).not.toContain("authorization");
      // …and nothing credential-shaped leaks into results/drill-down either.
      for (const payload of [
        JSON.stringify(results),
        JSON.stringify(detail),
      ]) {
        expect(payload).not.toContain(CREDENTIAL);
        expect(payload).not.toContain("Token ");
        expect(payload.toLowerCase()).not.toContain("authorization");
      }
      db.close();
    },
    30_000, // the 500-exhaustion retry backoff runs on real timers (~4s)
  );

  it("dedupes a repeated uuid, keeping the first-seen catalog row", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) =>
      listRow(uid(101 + i), `dup-${101 + i}`),
    );
    const dupUuid = uid(101);
    const page2 = [
      listRow(dupUuid, "dup-should-lose"),
      listRow(uid(126), "dup-126"),
      listRow(uid(127), "dup-127"),
    ];
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.startsWith(`${API_BASE}/engagements?`)) {
        const page = /page\[number\]=(\d+)/.exec(url)?.[1];
        return Promise.resolve(
          jsonResponse({ data: page === "1" ? page1 : page2 }),
        );
      }
      const uuid = /\/engagements\/([0-9a-f-]{36})\?include=/.exec(url)?.[1];
      return Promise.resolve(jsonResponse(engagementDoc(uuid ?? "", 1)));
    });
    const { deps } = realDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();

    expect(run.phase).toBe("done");
    expect(run.discovered).toBe(27); // 28 raw rows, 1 duplicate dropped
    expect(run.summary?.status).toBe("complete");

    const db = await store.openRadarStore();
    const rows = await store.getCatalog(db);
    expect(rows).toHaveLength(27);
    // First occurrence wins: position 0 keeps the page-1 code.
    expect(rows[0]?.uuid).toBe(dupUuid);
    expect(rows[0]?.code).toBe("dup-101");
    expect(rows.filter((r) => r.uuid === dupUuid)).toHaveLength(1);
    // First-seen order preserved, the new page-2 uuids appended last.
    expect(rows.map((r) => r.uuid).slice(-2)).toEqual([uid(126), uid(127)]);
    db.close();
  });
});

describe("radar scan integration — checkpoint/resume", () => {
  it("a second coordinator resumes pending uuids without re-enumerating", async () => {
    const resumeUuids = [uid(201), uid(202), uid(203), uid(204)];
    const stuckUuid = uid(204);
    let hangFirstGet = true;
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.startsWith(`${API_BASE}/engagements?`)) {
        return Promise.resolve(
          jsonResponse({
            data: resumeUuids.map((u, i) => listRow(u, `res-${i}`)),
          }),
        );
      }
      const uuid = /\/engagements\/([0-9a-f-]{36})\?include=/.exec(url)?.[1];
      if (uuid === stuckUuid && hangFirstGet) {
        // Simulates the service worker dying mid-enrich: the request never
        // returns, the run record stays "enriching" with uid(204) pending.
        hangFirstGet = false;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(
        jsonResponse(engagementDoc(uuid ?? "", resumeUuids.indexOf(uuid ?? "") + 1)),
      );
    });

    const a = realDeps();
    const coordA = new coordinator.RadarCoordinator(a.deps);
    const run = await coordA.start();
    const db = await store.openRadarStore();

    // Wait until the first three programs checkpointed as complete.
    await until(async () => {
      const rec = await store.getRun(db, run.run_id);
      const done = rec?.completed_uuids;
      return Array.isArray(done) && done.length === 3;
    });
    const mid = await store.getRun(db, run.run_id);
    expect(mid?.phase).toBe("enriching");
    expect(mid?.pending_uuids).toEqual([stuckUuid]);
    expect(listCalls()).toHaveLength(1);

    // Simulated restart: a second coordinator over the same persisted DB.
    const b = realDeps();
    const coordB = new coordinator.RadarCoordinator(b.deps);
    await coordB.resume();

    // No re-enumeration: the persisted catalog covered the pending uuid.
    expect(b.enumerate).not.toHaveBeenCalled();
    expect(listCalls()).toHaveLength(1);
    expect(b.hydrate).toHaveBeenCalledTimes(1);
    expect(b.hydrate.mock.calls[0]![0].uuid).toBe(stuckUuid);
    // The stuck uuid was fetched twice across the "two workers' lifetimes".
    expect(getCallsFor(stuckUuid)).toHaveLength(2);

    const rec = await store.getRun(db, run.run_id);
    expect(rec?.phase).toBe("done");
    expect(rec?.completed_uuids).toEqual(
      expect.arrayContaining(resumeUuids),
    );
    expect((rec?.summary as { status?: string } | undefined)?.status).toBe(
      "complete",
    );
    db.close();
    // coordA's hydrate promise never resolves — it models the dead worker.
  }, 15_000);
});

describe("radar scan integration — determinism", () => {
  it(
    "identical fixture input → identical scores and rank order on a fresh DB",
    async () => {
      // The 500-exhaustion case is disabled here: 30 requests per run stay
      // inside the 60 req/min bucket, and no retry backoff is spent.
      fetchMock.mockImplementation((input: unknown) =>
        mainScenarioFetch(String(input), { flaky500: false }),
      );

      const runScan = async () => {
        const { deps } = realDeps();
        const coord = new coordinator.RadarCoordinator(deps);
        await coord.start();
        await coord.waitForIdle();
        const db = await store.openRadarStore();
        const results = await coord.getResults("best_ev", 200);
        const rows = await store.getLatestScoreRowsForProfile(
          db,
          "best_ev",
          "1.0.0",
        );
        const scoreByUuid = new Map(
          rows.map((r) => [r.uuid, r.score] as const),
        );
        const hashes = (
          await Promise.all(
            MAIN_UUIDS.map(
              async (u) => (await store.getLatestSnapshot(db, u))!.source_hash,
            ),
          )
        ).sort();
        db.close();
        return { results, scoreByUuid, hashes };
      };

      const first = await runScan();
      await wipeRadarDb(); // "fresh DB each" — no state carries over
      const second = await runScan();

      // Identical rank order + identical result rows.
      expect(second.results).toEqual(first.results);
      expect(second.results.map((r) => r.uuid)).toEqual(
        first.results.map((r) => r.uuid),
      );
      // Identical full score objects (score, confidence, components, reasons,
      // source_hash) for every discovered uuid.
      for (const uuid of MAIN_UUIDS) {
        expect(second.scoreByUuid.get(uuid)).toEqual(
          first.scoreByUuid.get(uuid),
        );
      }
      // Identical source hashes — same semantic input, same hash.
      expect(second.hashes).toEqual(first.hashes);
    },
    30_000,
  );
});
