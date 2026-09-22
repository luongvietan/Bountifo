import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogScanResult } from "../lib/radar/catalog";
import type {
  RadarCoordinatorDeps,
  RadarRunPhase,
} from "../lib/radar/coordinator";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.3 request-budget tests (adversarial).
//
// The site client is the only network sink; it is mocked at the module
// boundary so every outbound request is counted by operation. The REAL
// enumerateEngagementCatalog / hydrateRadarProgram are injected into the
// coordinator's enumerate/hydrate seams — the whole metadata pipeline runs
// for real, only the wire is fake.
//
// BUDGET (per docs/superpowers/plans/2026-09-22-radar-v1.3.md):
//   V1.2 = ~4·N siteRequests + pages            (changelog + brief doc +
//                                                statistics + recently_joined,
//                                                plus 1 LIST_INDEX per page)
//   V1.3 = ~4·N + pages + 3·min(N, DEEP_LIMIT)  (deep stage adds changelog
//                                                re-fetch + previous-version
//                                                brief doc + known-issues JSON
//                                                per SHORTLISTED program only)
//   DEEP_LIMIT (plan: DEEP_ANALYSIS_LIMIT) defaults to 30 eligible best_ev
//   rows.
//
// Because the deep stage lands via merge, assertions are bounds, not
// equalities: every bound is green today (deep calls = 0) and holds the
// merge to the contract. Assertions tagged INTEGRATION ASSERTION pin the
// post-merge deep stage explicitly and are RED on this branch.
//
// If the merged coordinator exposes an injected deep dep, wire it in
// makeDeps below; if it calls siteRequest internally (lib/radar/deep.ts per
// the plan), no change is needed — the module mock already counts it.
// ---------------------------------------------------------------------------

const siteRequest = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequest(...args),
}));

import { enumerateEngagementCatalog } from "../lib/radar/catalog";
import { RadarCoordinator } from "../lib/radar/coordinator";
import { hydrateRadarDeep } from "../lib/radar/deep";
import { hydrateRadarProgram } from "../lib/radar/enrichment";
import { openRadarStore, getRun } from "../lib/radar/store";

const T0 = "2026-09-21T00:00:00.000Z";
const PAGE_LIMIT = 24;
const DEEP_LIMIT = 30; // plan: DEEP_ANALYSIS_LIMIT default

let runSeq = 0;

// -- site payload fixtures (shaped like tests/fixtures/radar/site/*) ---------

function indexEntry(slug: string): Record<string, unknown> {
  return {
    name: `Program ${slug}`,
    tagline: "tagline",
    briefUrl: `/engagements/${slug}`,
    accessStatus: "open",
    productEngagementType: { label: "Bug Bounty", iconVariant: "bug-bounty" },
    isPrivate: false,
  };
}

function indexPage(slugs: string[], totalCount: number): object {
  return {
    engagements: slugs.map(indexEntry),
    paginationMeta: { limit: PAGE_LIMIT, totalCount },
  };
}

function changelogList() {
  // Two versions so the deep differ has a real baseline (plan: the deep
  // stage re-fetches this list — it is not persisted by the metadata stage).
  return {
    changelogs: [
      { id: "ver-1", changelogState: "Latest" },
      { id: "ver-old", changelogState: "Superseded" },
    ],
  };
}

function briefDoc(slug: string) {
  return {
    id: "ver-1",
    publishedAt: "2026-09-11T15:03:27Z",
    lastTransitionAt: "2026-09-01T00:00:00Z",
    statusLabel: "In progress",
    engagementTypeDetail: { productLabel: "Bug Bounty" },
    data: {
      brief: { name: `Program ${slug}`, safeHarborStatus: { status: "full" } },
      engagement: { code: slug, state: "in_progress" },
      scope: [
        {
          id: "g1",
          name: "In scope",
          inScope: true,
          description: null,
          rewardRange: {
            p1MaxCents: 300000,
            p2MaxCents: 150000,
            p3MaxCents: 60000,
          },
          targets: [
            {
              id: "t1",
              uri: "https://app.example.com",
              name: "app.example.com",
              category: "website",
              tags: [{ name: "Website Testing" }],
            },
          ],
        },
      ],
    },
  };
}

/** Enough statistics for research_saturation to form + best_ev eligibility. */
function statsBody() {
  return {
    rewardedVulnerabilities: 721,
    averagePayout: "$2,000",
    validSubmissionCount: 150,
  };
}

function joinedBody() {
  return { users: [{ username: "reactor1" }], total: 349 };
}

/** Known Issues aggregate (verified live: {unique, total}). The operation
 *  name is the merge's — dispatch is name-agnostic so any new deep op is
 *  counted (and budgeted) regardless of its exact label. */
const KNOWN_ISSUES_BODY = { unique: 5, total: 20 };

function mockSite(pages: string[][]): void {
  siteRequest.mockImplementation(
    async (opts: { operation: string; slug?: string; page?: number }) => {
      switch (opts.operation) {
        case "LIST_INDEX": {
          const page = opts.page ?? 1;
          const slugs = pages[page - 1];
          if (slugs === undefined) {
            // Defensive: the enumerator must stop before asking for a page
            // that does not exist — a request for it still counts.
            return { data: { engagements: [] }, status: 200 };
          }
          return { data: indexPage(slugs, totalOf(pages)), status: 200 };
        }
        case "GET_CHANGELOGS":
          return { data: changelogList(), status: 200 };
        case "GET_BRIEF_DOC":
          // Serves ANY version id — latest and the diff baseline alike.
          return { data: briefDoc(opts.slug ?? "?"), status: 200 };
        case "GET_BRIEF_STATS":
          return { data: statsBody(), status: 200 };
        case "GET_RECENTLY_JOINED":
          return { data: joinedBody(), status: 200 };
        default:
          // Post-merge deep ops (e.g. GET_ENGAGEMENT_KNOWN_ISSUES): answer
          // the verified aggregate shape so a landed deep stage can run.
          return { data: KNOWN_ISSUES_BODY, status: 200 };
      }
    },
  );
}

function totalOf(pages: string[][]): number {
  return pages.reduce((n, p) => n + p.length, 0);
}

// -- call accounting ----------------------------------------------------------

interface Call {
  operation: string;
  slug?: string;
  page?: number;
  versionId?: string;
}

function calls(): Call[] {
  return siteRequest.mock.calls.map((c) => c[0] as Call);
}

function countWhere(pred: (c: Call) => boolean): number {
  return calls().filter(pred).length;
}

function perSlug(slug: string): Call[] {
  return calls().filter((c) => c.slug === slug);
}

/**
 * Deep-analyzed slugs = programs carrying any call beyond the four metadata
 * ops: the KI fetch, a second changelog list, or a baseline-version doc.
 * Metadata multiplicity per slug is capped at one of each (changelog list,
 * latest-version doc, stats, recently-joined) — every call beyond that is
 * deep work. Name-agnostic: whatever op name the merge chose, it lands here.
 */
function deepSlugs(all: string[]): Set<string> {
  const out = new Set<string>();
  for (const slug of all) {
    const c = perSlug(slug);
    const metadataCount =
      Math.min(
        c.filter((x) => x.operation === "GET_CHANGELOGS").length,
        1,
      ) +
      Math.min(
        c.filter(
          (x) => x.operation === "GET_BRIEF_DOC" && x.versionId === "ver-1",
        ).length,
        1,
      ) +
      Math.min(
        c.filter((x) => x.operation === "GET_BRIEF_STATS").length,
        1,
      ) +
      Math.min(
        c.filter((x) => x.operation === "GET_RECENTLY_JOINED").length,
        1,
      );
    if (c.length > metadataCount) out.add(slug);
  }
  return out;
}

function makeDeps(): { deps: RadarCoordinatorDeps } {
  return {
    deps: {
      // REAL pipeline functions — the mock boundary is siteRequest only.
      enumerate: (): Promise<CatalogScanResult> =>
        enumerateEngagementCatalog(T0),
      hydrate: (item) => hydrateRadarProgram(item),
      // The landed deep stage: real orchestrator over the mocked wire —
      // its siteRequest calls land in the same accounting.
      deepHydrate: (item, snapshot) => hydrateRadarDeep(item, snapshot),
      openStore: openRadarStore,
      now: () => T0,
      concurrency: 2,
      newRunId: () => `run-budget-${++runSeq}`,
    },
  };
}

async function runScan(slugs: string[]): Promise<RadarRunPhase> {
  const { deps } = makeDeps();
  const coord = new RadarCoordinator(deps);
  const run = await coord.start();
  await coord.waitForIdle();
  return run.phase;
}

beforeEach(() => {
  siteRequest.mockReset();
});

describe("metadata request budget (V1.2 floor — green today and post-merge)", () => {
  it("catalog = 1 LIST_INDEX per page; metadata = exactly 4 requests/program", async () => {
    const slugs = ["b-a", "b-b", "b-c", "b-d", "b-e"];
    mockSite([slugs]);
    const phase = await runScan(slugs);
    expect(phase).toBe("done");

    // Catalog: one page, one request.
    expect(countWhere((c) => c.operation === "LIST_INDEX")).toBe(1);

    // Metadata ops exactly once per program — the 4-request floor.
    for (const slug of slugs) {
      const c = perSlug(slug);
      expect(
        countWhere((x) => x.operation === "GET_BRIEF_STATS" && x.slug === slug),
        `${slug} GET_BRIEF_STATS`,
      ).toBe(1);
      expect(
        countWhere(
          (x) => x.operation === "GET_RECENTLY_JOINED" && x.slug === slug,
        ),
        `${slug} GET_RECENTLY_JOINED`,
      ).toBe(1);
      expect(
        countWhere(
          (x) =>
            x.operation === "GET_BRIEF_DOC" &&
            x.slug === slug &&
            x.versionId === "ver-1",
        ),
        `${slug} GET_BRIEF_DOC@latest`,
      ).toBe(1);
      // Changelog list: once for metadata; a deep stage may re-fetch once.
      const changelogs = c.filter(
        (x) => x.operation === "GET_CHANGELOGS",
      ).length;
      expect(changelogs).toBeGreaterThanOrEqual(1);
      expect(changelogs).toBeLessThanOrEqual(2);
      // Total per program: exactly 4 metadata calls, or ≤7 with a deep pass.
      expect(c.length).toBeLessThanOrEqual(7);
      if (c.length === 4) {
        expect(c.map((x) => x.operation).sort()).toEqual(
          [
            "GET_BRIEF_DOC",
            "GET_BRIEF_STATS",
            "GET_CHANGELOGS",
            "GET_RECENTLY_JOINED",
          ].sort(),
        );
      }
    }

    // Global bound: V1.2 floor + V1.3 deep allowance.
    const bound = 4 * slugs.length + 1 + 3 * Math.min(slugs.length, DEEP_LIMIT);
    expect(calls().length).toBeLessThanOrEqual(bound);
  });

  it("multi-page catalog: one LIST_INDEX per fetched page, never more", async () => {
    // 24 (full page) + 11 (short page) = 35 programs over 2 requests.
    const page1 = Array.from({ length: PAGE_LIMIT }, (_, i) => `b-p1-${i}`);
    const page2 = Array.from({ length: 11 }, (_, i) => `b-p2-${i}`);
    mockSite([page1, page2]);
    const phase = await runScan([...page1, ...page2]);
    expect(phase).toBe("done");

    expect(countWhere((c) => c.operation === "LIST_INDEX")).toBe(2);
    const n = page1.length + page2.length;
    const bound = 4 * n + 2 + 3 * Math.min(n, DEEP_LIMIT);
    expect(calls().length).toBeLessThanOrEqual(bound);
    // Metadata floor is exact: stats + joined are fetched exactly once each
    // per program, deep stage or not.
    expect(countWhere((c) => c.operation === "GET_BRIEF_STATS")).toBe(n);
    expect(countWhere((c) => c.operation === "GET_RECENTLY_JOINED")).toBe(n);
  });
});

describe("deep-stage request budget (V1.3)", () => {
  it("deep analysis adds ≤3 requests per shortlisted program and only touches the shortlist", async () => {
    const slugs = ["b-d1", "b-d2", "b-d3", "b-d4", "b-d5"];
    mockSite([slugs]);
    const phase = await runScan(slugs);
    expect(phase).toBe("done");

    const deep = deepSlugs(slugs);
    // The shortlist is bounded by DEEP_ANALYSIS_LIMIT and by the catalog.
    expect(deep.size).toBeLessThanOrEqual(Math.min(slugs.length, DEEP_LIMIT));
    for (const slug of deep) {
      const c = perSlug(slug);
      const extra = c.length - 4;
      // Contract: changelog re-fetch + previous-version doc + known-issues.
      expect(extra, `${slug} deep calls`).toBeLessThanOrEqual(3);
      expect(extra).toBeGreaterThan(0);
      // A deep pass never re-fetches stats or recently-joined.
      expect(
        c.filter((x) => x.operation === "GET_BRIEF_STATS"),
      ).toHaveLength(1);
      expect(
        c.filter((x) => x.operation === "GET_RECENTLY_JOINED"),
      ).toHaveLength(1);
    }
    // Slugs outside the shortlist got the metadata 4 and nothing else.
    for (const slug of slugs.filter((s) => !deep.has(s))) {
      expect(perSlug(slug)).toHaveLength(4);
    }

    // INTEGRATION ASSERTION (red today — no deep stage exists yet):
    // with five fully-eligible programs the shortlist is min(5, 30) = 5.
    expect(deep.size).toBe(Math.min(slugs.length, DEEP_LIMIT));
  });

  it("the deep shortlist is capped at DEEP_ANALYSIS_LIMIT (30) for large catalogs", async () => {
    const page1 = Array.from({ length: PAGE_LIMIT }, (_, i) => `b-c1-${i}`);
    const page2 = Array.from({ length: 11 }, (_, i) => `b-c2-${i}`);
    const slugs = [...page1, ...page2]; // 35 > DEEP_LIMIT
    mockSite([page1, page2]);
    const phase = await runScan(slugs);
    expect(phase).toBe("done");

    const deep = deepSlugs(slugs);
    expect(deep.size).toBeLessThanOrEqual(DEEP_LIMIT);
    // INTEGRATION ASSERTION (red today): with all 35 programs eligible the
    // shortlist saturates the cap — min(35, 30) = 30 deep passes.
    expect(deep.size).toBe(DEEP_LIMIT);
  });

  it("deep bookkeeping lands on the persisted run record", async () => {
    const slugs = ["b-r1", "b-r2"];
    mockSite([slugs]);
    const { deps } = makeDeps();
    const coord = new RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");

    const db = await openRadarStore();
    const rec = await getRun(db, run.run_id);
    db.close();
    const deepPending = (rec?.deep_pending_uuids ?? []) as string[];
    const deepDone = (rec?.deep_completed_uuids ?? []) as string[];
    // INTEGRATION ASSERTION (red today — the phases exist in the type union
    // but nothing populates them): a landed deep stage must record its
    // shortlist, and every deep-completed uuid must be a metadata-completed
    // program (deep analysis only touches the shortlisted subset of the
    // hydrated catalog).
    expect(deepPending.length + deepDone.length).toBeGreaterThan(0);
    const completed = new Set((rec?.completed_uuids ?? []) as string[]);
    for (const uuid of [...deepPending, ...deepDone]) {
      expect(completed.has(uuid)).toBe(true);
      expect(slugs).toContain(uuid);
    }
  });
});
