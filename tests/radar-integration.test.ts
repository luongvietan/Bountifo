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
import { BUGCROWD_SITE } from "../lib/constants";
import type { ApiEngagementData } from "../lib/types";
import type { CatalogScanResult } from "../lib/radar/catalog";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";
import type {
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Radar scan integration — end to end against a mocked researcher site.
//
// A REAL RadarCoordinator is wired to the real enumerate/hydrate functions
// (→ real siteRequest → vi.stubGlobal fetch) and the real IndexedDB store
// (fake-indexeddb). The only fakes are the network itself, the offscreen
// parser bridge (no DOM/offscreen document exists in the service-worker-like
// test env — the DOM collectors are covered end-to-end by
// radar-detail-map.test.ts), and the injected now/newRunId determinism hooks.
//
// Real timers are used: the 500-exhaustion retry backoff (~4s) runs for real
// inside siteRequest — tests exercising it get an extended timeout.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";

vi.mock("../lib/radar/offscreen", () => ({
  parseBriefHtml: vi.fn(),
}));

type CatalogModule = typeof import("../lib/radar/catalog");
type EnrichmentModule = typeof import("../lib/radar/enrichment");
type CoordinatorModule = typeof import("../lib/radar/coordinator");
type StoreModule = typeof import("../lib/radar/store");
type OffscreenModule = typeof import("../lib/radar/offscreen");
type ErrorsModule = typeof import("../lib/api/errors");

let catalog: CatalogModule;
let enrichment: EnrichmentModule;
let coordinator: CoordinatorModule;
let store: StoreModule;
let offscreen: OffscreenModule;
// ApiError must come from the SAME module graph enrichment got after
// resetModules() — a top-level import's class would fail its instanceof.
let ApiError: ErrorsModule["ApiError"];
let parseBrief: Mock<OffscreenModule["parseBriefHtml"]>;
let fetchMock: ReturnType<typeof vi.fn>;
let runSeq = 0;

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(
  init: { status?: number } = {},
): Response {
  return new Response("<html><body>brief</body></html>", {
    status: init.status ?? 200,
    headers: { "content-type": "text/html" },
  });
}

/** Brief-URL slug for the nth synthetic program. */
function slug(n: number): string {
  return `prog-${n}`;
}

/** One engagements.json row — the site envelope item shape. */
function listRow(s: string, code: string): object {
  return {
    name: `Program ${code}`,
    tagline: "",
    briefUrl: `/engagements/${s}`,
    accessStatus: "open",
    isPrivate: false,
    industryName: "Technology",
    productEngagementType: { label: "Bug Bounty", iconVariant: "bug-bounty" },
  };
}

/** The ApiEngagementData the offscreen parser would produce for one slug. */
function detailData(s: string, seed: number): ApiEngagementData {
  const gid = `g-${s}`;
  return {
    uuid: s,
    code: s,
    name: `Program ${seed}`,
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "running",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastBriefUpdate: "2026-09-01T00:00:00.000Z",
    lastStatusTransition: "2026-08-01T00:00:00.000Z",
    safeHarborLevel: "full_safe_harbor",
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
    targetGroups: [
      {
        id: gid,
        name: "Web scope",
        inScope: true,
        description: null,
        // seed 28 → p1 29000 clamps the reward curve to 1.0; the tier blend
        // lands at 0.6121 → REWARD_MEDIUM.
        rewards: { p1: 1000 + seed * 1000, p2: 500, p3: 100, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: `t-${s}`,
        groupId: gid,
        location: `https://t${seed}.example.com`,
        name: `site-${seed}`,
        category: "website",
        tags: [],
        inScope: true,
      },
    ],
    observedApiVersion: null,
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
    String(c[0]).includes("/engagements.json?"),
  );
}

function briefCallsFor(s: string): unknown[][] {
  return fetchMock.mock.calls.filter((c) =>
    String(c[0]).endsWith(`/engagements/${s}`),
  );
}

// ---------------------------------------------------------------------------
// The scenario: page 1 = 25 rows, page 2 = 3 rows → 28 unique.
// 25 hydrate OK; slug(10) → 403, slug(11) → offscreen parse failure,
// slug(12) → 500 always.
// ---------------------------------------------------------------------------

const MAIN_SLUGS = Array.from({ length: 28 }, (_, i) => slug(i + 1));
const FORBIDDEN_SLUG = slug(10);
const MALFORMED_SLUG = slug(11);
const FLAKY_SLUG = slug(12);
const FAILED_SLUGS = [FORBIDDEN_SLUG, MALFORMED_SLUG, FLAKY_SLUG];

/**
 * Router for the 28-program scenario. `flaky500` toggles the slug(12) 500
 * exhaustion — disabled for the determinism test, whose two full runs would
 * otherwise spend the shared 60 req/min rate bucket on retry attempts.
 */
function mainScenarioFetch(
  url: string,
  opts: { flaky500?: boolean } = {},
): Promise<Response> {
  const flaky500 = opts.flaky500 ?? true;
  if (url.startsWith(`${BUGCROWD_SITE}/engagements.json?`)) {
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? "0");
    if (page === 1) {
      return Promise.resolve(
        jsonResponse({
          engagements: MAIN_SLUGS.slice(0, 25).map((s, i) =>
            listRow(s, `prog-${i + 1}`),
          ),
          paginationMeta: { limit: 25, totalCount: 28 },
        }),
      );
    }
    if (page === 2) {
      return Promise.resolve(
        jsonResponse({
          engagements: MAIN_SLUGS.slice(25).map((s, i) =>
            listRow(s, `prog-${i + 26}`),
          ),
          paginationMeta: { limit: 25, totalCount: 28 },
        }),
      );
    }
    return Promise.resolve(
      jsonResponse({ engagements: [], paginationMeta: { limit: 25 } }),
    );
  }
  const s = /\/engagements\/([A-Za-z0-9_-]+)$/.exec(url)?.[1] ?? "";
  if (s === FORBIDDEN_SLUG) {
    return Promise.resolve(htmlResponse({ status: 403 }));
  }
  if (s === FLAKY_SLUG && flaky500) {
    return Promise.resolve(htmlResponse({ status: 500 }));
  }
  return Promise.resolve(htmlResponse());
}

/**
 * parseBriefHtml behavior for the scenario: slug(11)'s document parses as a
 * malformed brief (the offscreen bridge reports invalid_response), every
 * other slug maps to its seeded detail.
 */
function mainScenarioParse(s: string): Promise<ApiEngagementData> {
  if (s === MALFORMED_SLUG) {
    return Promise.reject(
      new ApiError("invalid_response", "offscreen parse failed"),
    );
  }
  const seed = MAIN_SLUGS.indexOf(s) + 1;
  return Promise.resolve(detailData(s, seed));
}

/** Serialized contents of every persisted store — for the secret scan. */
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
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  catalog = await import("../lib/radar/catalog");
  enrichment = await import("../lib/radar/enrichment");
  store = await import("../lib/radar/store");
  coordinator = await import("../lib/radar/coordinator");
  offscreen = await import("../lib/radar/offscreen");
  ApiError = (await import("../lib/api/errors")).ApiError;
  parseBrief = offscreen.parseBriefHtml as Mock<
    OffscreenModule["parseBriefHtml"]
  >;
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
      parseBrief.mockImplementation((s) => mainScenarioParse(s));
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
      for (const [s, kind] of [
        [FORBIDDEN_SLUG, "forbidden"],
        [MALFORMED_SLUG, "invalid_response"],
        [FLAKY_SLUG, "http"],
      ] as const) {
        expect(run.summary?.warnings).toContain(`${s}: ${kind}`);
      }

      // ---- catalog ordering + wire calls --------------------------------
      // Exactly two LIST_INDEX calls; 25+? brief fetches — the 500 case is
      // retried to MAX_ATTEMPTS (4), the other failures are one-shot.
      expect(listCalls()).toHaveLength(2);
      expect(briefCallsFor(FORBIDDEN_SLUG)).toHaveLength(1);
      expect(briefCallsFor(MALFORMED_SLUG)).toHaveLength(1);
      expect(briefCallsFor(FLAKY_SLUG)).toHaveLength(4);
      // The pipeline really was session-authenticated: every request carries
      // cookies and there is no credential header at all.
      for (const call of fetchMock.mock.calls) {
        const init = call[1] as {
          credentials?: string;
          headers?: Record<string, string>;
        };
        expect(init.credentials).toBe("include");
        expect(Object.keys(init.headers ?? {})).not.toContain(
          "Authorization",
        );
      }

      const db = await store.openRadarStore();
      const catalogRows = await store.getCatalog(db);
      // One row per unique slug (getAll returns key order — first-seen
      // page order isn't a read-back contract).
      expect(catalogRows.map((i) => i.uuid).sort()).toEqual(
        [...MAIN_SLUGS].sort(),
      );
      expect(new Set(catalogRows.map((i) => i.uuid)).size).toBe(28);

      // ---- snapshots -----------------------------------------------------
      for (const s of MAIN_SLUGS) {
        const snap = await store.getLatestSnapshot(db, s);
        expect(snap).not.toBeNull();
        expect(snap!.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        if (FAILED_SLUGS.includes(s)) {
          expect(snap!.detail).toBeNull();
          expect(snap!.enrichment.status).not.toBe("complete");
        } else {
          expect(snap!.enrichment).toEqual({ status: "complete" });
          expect(snap!.detail).not.toBeNull();
        }
      }
      expect(
        (await store.getLatestSnapshot(db, FORBIDDEN_SLUG))!.enrichment,
      ).toEqual({ status: "unavailable", error_kind: "forbidden" });
      expect(
        (await store.getLatestSnapshot(db, MALFORMED_SLUG))!.enrichment,
      ).toEqual({ status: "failed", error_kind: "invalid_response" });
      expect(
        (await store.getLatestSnapshot(db, FLAKY_SLUG))!.enrichment,
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
      for (const s of FAILED_SLUGS) {
        const row = scoreRows.find((r) => r.uuid === s);
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
      const seed28 = scoreRows.find((r) => r.uuid === slug(28));
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
        [...FAILED_SLUGS].sort(),
      );
      expect(results.slice(25).every((r) => r.score === null)).toBe(true);

      // ---- per-program drill-down ------------------------------------------
      const detail = await coord.getProgram(FORBIDDEN_SLUG, "best_ev");
      expect(detail?.snapshot?.enrichment.status).toBe("unavailable");
      expect(detail?.score?.score).toBeNull();
      expect(detail?.explanation.every((l) => l.startsWith("? "))).toBe(true);

      // ---- no credentials in persisted state --------------------------------
      // The session surface stores no credential; the scan asserts no
      // header-shaped secret leaks into snapshots/results either way.
      const blob = await persistedBlob();
      expect(blob).not.toContain("Token ");
      expect(blob.toLowerCase()).not.toContain("authorization");
      for (const payload of [
        JSON.stringify(results),
        JSON.stringify(detail),
      ]) {
        expect(payload).not.toContain("Token ");
        expect(payload.toLowerCase()).not.toContain("authorization");
      }
      db.close();
    },
    30_000, // the 500-exhaustion retry backoff runs on real timers (~4s)
  );

  it("dedupes a repeated slug, keeping the first-seen catalog row", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) =>
      listRow(slug(101 + i), `dup-${101 + i}`),
    );
    const dupSlug = slug(101);
    const page2 = [
      listRow(dupSlug, "dup-should-lose"),
      listRow(slug(126), "dup-126"),
      listRow(slug(127), "dup-127"),
    ];
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.startsWith(`${BUGCROWD_SITE}/engagements.json?`)) {
        const page = /page=(\d+)/.exec(url)?.[1];
        return Promise.resolve(
          jsonResponse({
            engagements: page === "1" ? page1 : page2,
            paginationMeta: { limit: 25 },
          }),
        );
      }
      return Promise.resolve(htmlResponse());
    });
    parseBrief.mockImplementation((s) => Promise.resolve(detailData(s, 1)));
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
    // First occurrence wins: position 0 keeps the page-1 name (the code
    // field carries the slug itself on the site surface, so `name` is the
    // marker that distinguishes the two duplicate rows).
    expect(rows[0]?.uuid).toBe(dupSlug);
    expect(rows[0]?.name).toBe("Program dup-101");
    expect(rows.filter((r) => r.uuid === dupSlug)).toHaveLength(1);
    // Both new page-2 slugs are present alongside the kept first-seen row.
    expect(rows.map((r) => r.uuid).sort().slice(-2)).toEqual([
      slug(126),
      slug(127),
    ]);
    db.close();
  });
});

describe("radar scan integration — checkpoint/resume", () => {
  it("a second coordinator resumes pending slugs without re-enumerating", async () => {
    const resumeSlugs = [slug(201), slug(202), slug(203), slug(204)];
    const stuckSlug = slug(204);
    let hangFirstGet = true;
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.startsWith(`${BUGCROWD_SITE}/engagements.json?`)) {
        return Promise.resolve(
          jsonResponse({
            engagements: resumeSlugs.map((s, i) => listRow(s, `res-${i}`)),
            paginationMeta: { limit: 25 },
          }),
        );
      }
      const s = /\/engagements\/([A-Za-z0-9_-]+)$/.exec(url)?.[1];
      if (s === stuckSlug && hangFirstGet) {
        // Simulates the service worker dying mid-enrich: the request never
        // returns, the run record stays "enriching" with prog-204 pending.
        hangFirstGet = false;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(htmlResponse());
    });
    parseBrief.mockImplementation((s) =>
      Promise.resolve(detailData(s, resumeSlugs.indexOf(s) + 1)),
    );

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
    expect(mid?.pending_uuids).toEqual([stuckSlug]);
    expect(listCalls()).toHaveLength(1);

    // Simulated restart: a second coordinator over the same persisted DB.
    const b = realDeps();
    const coordB = new coordinator.RadarCoordinator(b.deps);
    await coordB.resume();

    // No re-enumeration: the persisted catalog covered the pending slug.
    expect(b.enumerate).not.toHaveBeenCalled();
    expect(listCalls()).toHaveLength(1);
    expect(b.hydrate).toHaveBeenCalledTimes(1);
    expect(b.hydrate.mock.calls[0]![0].uuid).toBe(stuckSlug);
    // The stuck slug was fetched twice across the "two workers' lifetimes".
    expect(briefCallsFor(stuckSlug)).toHaveLength(2);

    const rec = await store.getRun(db, run.run_id);
    expect(rec?.phase).toBe("done");
    expect(rec?.completed_uuids).toEqual(
      expect.arrayContaining(resumeSlugs),
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
      parseBrief.mockImplementation((s) => mainScenarioParse(s));

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
            MAIN_SLUGS.map(
              async (s) =>
                (await store.getLatestSnapshot(db, s))!.source_hash,
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
      // source_hash) for every discovered slug.
      for (const s of MAIN_SLUGS) {
        expect(second.scoreByUuid.get(s)).toEqual(
          first.scoreByUuid.get(s),
        );
      }
      // Identical source hashes — same semantic input, same hash.
      expect(second.hashes).toEqual(first.hashes);
    },
    30_000,
  );
});
