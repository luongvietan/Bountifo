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
// (fake-indexeddb). The only fakes are the network itself and the injected
// now/newRunId determinism hooks — the brief-doc mapper runs for real on the
// same JSON shapes the live endpoints serve.
//
// Real timers are used: the 500-exhaustion retry backoff (~4s) runs for real
// inside siteRequest — tests exercising it get an extended timeout.
// ---------------------------------------------------------------------------

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

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
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

/** Changelog list for a slug — one "Latest" version. */
function changelogList(s: string): object {
  return {
    changelogs: [
      {
        id: `v-${s}`,
        changelogState: "Latest",
        publishedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  };
}

/**
 * The structured changelog document for one slug, shaped like the real
 * endpoint (fixtures/radar/site/webdotcom-brief-doc.json). `seed` parameterizes
 * the reward tiers — seed 28 → p1 $29,000 clamps the reward curve to 1.0 and
 * the tier blend lands at 0.6121 → REWARD_MEDIUM.
 */
function briefDoc(s: string, seed: number): object {
  return {
    id: `v-${s}`,
    publishedAt: "2026-09-01T00:00:00.000Z",
    lastTransitionAt: "2026-08-01T00:00:00.000Z",
    statusLabel: "In progress",
    participation: "open",
    engagementTypeDetail: { productLabel: "Bug Bounty" },
    data: {
      brief: {
        name: `Program ${seed}`,
        safeHarborStatus: { status: "full_safe_harbor" },
      },
      engagement: {
        code: s,
        state: "in_progress",
        startsAt: "2020-01-01T00:00:00Z",
        endsAt: null,
      },
      scope: [
        {
          id: `g-${s}`,
          name: "Web scope",
          inScope: true,
          description: null,
          rewardRange: {
            p1MaxCents: (1000 + seed * 1000) * 100,
            p2MaxCents: 500 * 100,
            p3MaxCents: 100 * 100,
          },
          targets: [
            {
              id: `t-${s}`,
              uri: `https://t${seed}.example.com`,
              name: `site-${seed}`,
              category: "website",
              tags: [],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Statistics endpoint body — rewarded counts only. The participant-count
 * proxy lives on the separate recently_joined_users endpoint.
 */
function statsBody(seed: number): object {
  return {
    rewardedVulnerabilities: seed * 3,
    averagePayout: "$2,000",
    validationWithin: "12 days",
  };
}

/**
 * Recently-joined endpoint body — `total` is the recent-crowding proxy.
 * Slug(1) gets total 100 → crowding 100/600 ≈ 0.1667; with rewarded_activity
 * (3/203) the composite lands ≈ 0.0908 → SATURATION_LOW and a
 * non-provisional best_ev score.
 */
const JOINED_SLUG = slug(1);
function joinedBody(s: string): object | null {
  return s === JOINED_SLUG ? { users: [], total: 100 } : null;
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

/** Changelog-list calls for a slug — the first of the three detail fetches. */
function changelogCallsFor(s: string): unknown[][] {
  return fetchMock.mock.calls.filter((c) =>
    String(c[0]).endsWith(`/engagements/${s}/changelog.json`),
  );
}

// ---------------------------------------------------------------------------
// The scenario: page 1 = 10 rows, page 2 = 2 rows → 12 unique.
// 9 hydrate OK; slug(10) → 403, slug(11) → malformed doc, slug(12) → 500
// always. 12 programs × 3 fetches stays inside the 60 req/min rate bucket.
// ---------------------------------------------------------------------------

const MAIN_SLUGS = Array.from({ length: 12 }, (_, i) => slug(i + 1));
const FORBIDDEN_SLUG = slug(10);
const MALFORMED_SLUG = slug(11);
const FLAKY_SLUG = slug(12);
const FAILED_SLUGS = [FORBIDDEN_SLUG, MALFORMED_SLUG, FLAKY_SLUG];
// The reward-band pinning slug gets seed 28 (p1 $29k → curve clamp 1.0 →
// blend 0.6121 → REWARD_MEDIUM) regardless of its catalog position.
const PINNED_SLUG = slug(9);
const seedFor = (s: string): number =>
  s === PINNED_SLUG ? 28 : MAIN_SLUGS.indexOf(s) + 1;

/**
 * Router for the 12-program scenario. `flaky500` toggles the slug(12) 500
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
          engagements: MAIN_SLUGS.slice(0, 10).map((s, i) =>
            listRow(s, `prog-${i + 1}`),
          ),
          paginationMeta: { limit: 10, totalCount: 12 },
        }),
      );
    }
    if (page === 2) {
      return Promise.resolve(
        jsonResponse({
          engagements: MAIN_SLUGS.slice(10).map((s, i) =>
            listRow(s, `prog-${i + 11}`),
          ),
          paginationMeta: { limit: 10, totalCount: 12 },
        }),
      );
    }
    return Promise.resolve(
      jsonResponse({ engagements: [], paginationMeta: { limit: 10 } }),
    );
  }

  const listSlug = /\/engagements\/([A-Za-z0-9_-]+)\/changelog\.json$/.exec(
    url,
  )?.[1];
  if (listSlug !== undefined) {
    if (listSlug === FORBIDDEN_SLUG) {
      return Promise.resolve(jsonResponse({ error: "forbidden" }, { status: 403 }));
    }
    if (listSlug === FLAKY_SLUG && flaky500) {
      return Promise.resolve(jsonResponse({ error: "boom" }, { status: 500 }));
    }
    return Promise.resolve(jsonResponse(changelogList(listSlug)));
  }

  const docMatch =
    /\/engagements\/([A-Za-z0-9_-]+)\/changelog\/[A-Za-z0-9_-]+\.json$/.exec(
      url,
    );
  if (docMatch !== null) {
    const s = docMatch[1]!;
    if (s === MALFORMED_SLUG) {
      // Doc missing data.scope — the mapper reports invalid_response.
      return Promise.resolve(jsonResponse({ id: `v-${s}` }));
    }
    return Promise.resolve(jsonResponse(briefDoc(s, seedFor(s))));
  }

  const statsMatch = /\/engagements\/([A-Za-z0-9_-]+)\/statistics\.json$/.exec(
    url,
  );
  if (statsMatch !== null) {
    return Promise.resolve(jsonResponse(statsBody(seedFor(statsMatch[1]!))));
  }

  const joinedMatch =
    /\/engagements\/([A-Za-z0-9_-]+)\/recently_joined_users\.json$/.exec(url);
  if (joinedMatch !== null) {
    const body = joinedBody(joinedMatch[1]!);
    if (body !== null) return Promise.resolve(jsonResponse(body));
    return Promise.resolve(
      jsonResponse({ error: "not found" }, { status: 404 }),
    );
  }

  return Promise.resolve(jsonResponse({ error: "not found" }, { status: 404 }));
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
  await wipeRadarDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("radar scan integration — 12 discovered, 3 program-scoped failures", () => {
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
        discovered: 12,
        enriched: 9,
        enrichment_failed: 3,
        // scored counts every completed uuid — the 3 failed enrichments get
        // null-score rows; 9 of them are real scores.
        scored: 12,
      });
      for (const [s, kind] of [
        [FORBIDDEN_SLUG, "forbidden"],
        [MALFORMED_SLUG, "invalid_response"],
        [FLAKY_SLUG, "http"],
      ] as const) {
        expect(run.summary?.warnings).toContain(`${s}: ${kind}`);
      }

      // ---- catalog ordering + wire calls --------------------------------
      // Exactly two LIST_INDEX calls. The flaky slug's changelog list is
      // retried to MAX_ATTEMPTS (4); other failures are one-shot.
      expect(listCalls()).toHaveLength(2);
      expect(changelogCallsFor(FORBIDDEN_SLUG)).toHaveLength(1);
      expect(changelogCallsFor(MALFORMED_SLUG)).toHaveLength(1);
      expect(changelogCallsFor(FLAKY_SLUG)).toHaveLength(4);
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
      expect(new Set(catalogRows.map((i) => i.uuid)).size).toBe(12);

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
        "1.5.0",
      );
      expect(scoreRows).toHaveLength(12);
      const nonNull = scoreRows.filter((r) => r.score.score !== null);
      expect(nonNull).toHaveLength(9); // the scenario's "9 scoreable"
      for (const s of FAILED_SLUGS) {
        const row = scoreRows.find((r) => r.uuid === s);
        expect(row?.score.score).toBeNull();
        expect(row?.score.confidence).toBe(0);
        // Stable reason vocabulary: every gap is an UNKNOWN_<signal> code —
        // 15 weighted signals in best_ev v1.5.0.
        expect(row?.score.reasons).toHaveLength(15);
        expect(
          row?.score.reasons.every((c) => c.startsWith("UNKNOWN_")),
        ).toBe(true);
      }
      // Stable reason codes on the pinned program (seed 28 → REWARD_MEDIUM
      // band, recently updated, web surface, full safe harbor). Its joined
      // endpoint 404s, so only rewarded_activity is known — one component is
      // below the composite floor → research_saturation is honestly UNKNOWN
      // and the required_any group is empty → provisional.
      const pinned = scoreRows.find((r) => r.uuid === PINNED_SLUG);
      expect(pinned?.score.reasons).toEqual([
        "REWARD_MEDIUM",
        "RECENTLY_UPDATED",
        "WEB_SURFACE_HIGH",
        "REWARD_BROAD",
        "SAFE_HARBOR_PRESENT",
        // V1.3: no deep pass ran in this scenario — both deep signals are
        // honestly unknown and appear in profile-declared order. V1.5 adds
        // the two new deep signals; payout_realized reads a real mid-band
        // value from the fixture's statistics, so it emits no code.
        "UNKNOWN_OPPORTUNITY_CHANGE",
        "UNKNOWN_RESEARCH_SATURATION",
        "UNKNOWN_KNOWN_ISSUE_DENSITY",
        "UNKNOWN_SCOPE_MOMENTUM",
        "UNKNOWN_KI_CONCENTRATION",
      ]);
      expect(pinned?.score.provisional).toBe(true);
      // The joined-users slug carries real crowding (total 100 → 0.1667) and
      // a rewarded count → 2 known components → composite ≈ 0.0908, flagged
      // SATURATION_LOW, non-provisional, recorded as a cost contribution.
      const joined = scoreRows.find((r) => r.uuid === JOINED_SLUG);
      expect(joined?.score.provisional).toBe(false);
      expect(joined?.score.reasons).toContain("SATURATION_LOW");
      expect(
        joined?.score.components.research_saturation?.direction,
      ).toBe("cost");

      // ---- results table ---------------------------------------------------
      const results = await coord.getResults("best_ev", 200);
      expect(results).toHaveLength(12);
      const eligible = results.filter((r) => r.eligible);
      expect(eligible).toHaveLength(9);
      // Eligible rows sorted by score DESC; failed programs sink to the end
      // ordered by uuid ASC.
      const eligibleScores = eligible.map((r) => r.score!);
      expect([...eligibleScores].sort((a, b) => b - a)).toEqual(
        eligibleScores,
      );
      expect(results.slice(9).map((r) => r.uuid)).toEqual(
        [...FAILED_SLUGS].sort(),
      );
      expect(results.slice(9).every((r) => r.score === null)).toBe(true);

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
    const page1 = Array.from({ length: 8 }, (_, i) =>
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
            paginationMeta: { limit: 8 },
          }),
        );
      }
      return Promise.resolve(mainScenarioFetch(url, { flaky500: false }));
    });
    const { deps } = realDeps();
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();

    expect(run.phase).toBe("done");
    expect(run.discovered).toBe(10); // 11 raw rows, 1 duplicate dropped
    expect(run.summary?.status).toBe("complete");

    const db = await store.openRadarStore();
    const rows = await store.getCatalog(db);
    expect(rows).toHaveLength(10);
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
      const s = /\/engagements\/([A-Za-z0-9_-]+)\/changelog\.json$/.exec(
        url,
      )?.[1];
      if (s === stuckSlug && hangFirstGet) {
        // Simulates the service worker dying mid-enrich: the request never
        // returns, the run record stays "enriching" with prog-204 pending.
        hangFirstGet = false;
        return new Promise<Response>(() => {});
      }
      return mainScenarioFetch(url, { flaky500: false });
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
    // The stuck slug's changelog was fetched twice across the "two workers'
    // lifetimes".
    expect(changelogCallsFor(stuckSlug)).toHaveLength(2);

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
      // A small dedicated scenario: 5 programs × 3 fetches + 1 list call =
      // 16 requests per run — two runs stay inside the 60 req/min bucket
      // and no retry backoff is spent.
      const DET_SLUGS = Array.from({ length: 5 }, (_, i) => slug(i + 50));
      fetchMock.mockImplementation((input: unknown) => {
        const url = String(input);
        if (url.startsWith(`${BUGCROWD_SITE}/engagements.json?`)) {
          return Promise.resolve(
            jsonResponse({
              engagements: DET_SLUGS.map((s, i) => listRow(s, `det-${i}`)),
              paginationMeta: { limit: 25 },
            }),
          );
        }
        const listSlug = /\/engagements\/([A-Za-z0-9_-]+)\/changelog\.json$/.exec(
          url,
        )?.[1];
        if (listSlug !== undefined) {
          return Promise.resolve(jsonResponse(changelogList(listSlug)));
        }
        const docMatch =
          /\/engagements\/([A-Za-z0-9_-]+)\/changelog\/[A-Za-z0-9_-]+\.json$/.exec(
            url,
          );
        if (docMatch !== null) {
          const s = docMatch[1]!;
          return Promise.resolve(
            jsonResponse(briefDoc(s, DET_SLUGS.indexOf(s) + 1)),
          );
        }
        const statsMatch = /\/engagements\/([A-Za-z0-9_-]+)\/statistics\.json$/.exec(
          url,
        );
        if (statsMatch !== null) {
          return Promise.resolve(
            jsonResponse(statsBody(DET_SLUGS.indexOf(statsMatch[1]!) + 1)),
          );
        }
        return Promise.resolve(
          jsonResponse({ error: "not found" }, { status: 404 }),
        );
      });

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
          "1.5.0",
        );
        const scoreByUuid = new Map(
          rows.map((r) => [r.uuid, r.score] as const),
        );
        const hashes = (
          await Promise.all(
            DET_SLUGS.map(
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
      for (const s of DET_SLUGS) {
        expect(second.scoreByUuid.get(s)).toEqual(
          first.scoreByUuid.get(s),
        );
      }
      // Identical source hashes — same semantic input, same hash.
      expect(second.hashes).toEqual(first.hashes);
    },
    60_000,
  );
});
