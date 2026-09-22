import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/errors";
import { radarSourceHash } from "../lib/radar/hash";
import { radarProgramSnapshotSchema } from "../lib/radar/types";
import type { RadarCatalogItem } from "../lib/radar/types";

// The enrichment pipeline's only sink is the site client — mocked at the
// module boundary. The changelog/doc/stats payloads below are minimal but
// shaped like the real endpoints (see tests/fixtures/radar/site/*); the mapper
// itself is exercised end-to-end by radar-detail-map.test.ts.

const siteRequest = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequest(...args),
}));

import { hydrateRadarProgram } from "../lib/radar/enrichment";

function catalogItem(
  overrides: Partial<RadarCatalogItem> = {},
): RadarCatalogItem {
  return {
    uuid: "webdotcom",
    code: "webdotcom",
    name: "Web.com Bug Bounty",
    lifecycle_status: "open",
    engagement_type: "Bug Bounty",
    discovered_at: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

function changelogList() {
  return {
    changelogs: [
      { id: "ver-old", changelogState: "Superseded" },
      { id: "ver-1", changelogState: "Latest" },
    ],
  };
}

function briefDoc() {
  return {
    id: "ver-1",
    publishedAt: "2026-09-11T15:03:27Z",
    lastTransitionAt: "2020-01-01T00:00:00Z",
    statusLabel: "In progress",
    engagementTypeDetail: { productLabel: "Bug Bounty" },
    data: {
      brief: {
        name: "Web.com Bug Bounty",
        safeHarborStatus: { status: "full" },
      },
      engagement: { code: "webdotcom", state: "in_progress" },
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
              uri: "https://app.web.com",
              name: "app.web.com",
              category: "website",
              tags: [{ name: "Website Testing" }],
            },
          ],
        },
      ],
    },
  };
}

function statsBody() {
  return { rewardedVulnerabilities: 721, averagePayout: "$2,000" };
}

/** Wires the three-call happy path: changelogs → doc → stats. */
function mockHappyPath(stats: unknown = statsBody()) {
  siteRequest.mockImplementation(async (opts: { operation: string }) => {
    if (opts.operation === "GET_CHANGELOGS") {
      return { data: changelogList(), status: 200 };
    }
    if (opts.operation === "GET_BRIEF_DOC") {
      return { data: briefDoc(), status: 200 };
    }
    if (opts.operation === "GET_BRIEF_STATS") {
      if (stats instanceof Error) throw stats;
      return { data: stats, status: 200 };
    }
    throw new Error(`unexpected op ${opts.operation}`);
  });
}

beforeEach(() => {
  siteRequest.mockReset();
});

describe("hydrateRadarProgram happy path", () => {
  it("resolves changelog → doc → stats into a complete snapshot", async () => {
    mockHappyPath();
    const item = catalogItem();
    const snap = await hydrateRadarProgram(item);

    const ops = siteRequest.mock.calls.map(
      (c) => (c[0] as { operation: string }).operation,
    );
    expect(ops).toEqual([
      "GET_CHANGELOGS",
      "GET_BRIEF_DOC",
      "GET_BRIEF_STATS",
    ]);
    expect(siteRequest).toHaveBeenCalledWith({
      operation: "GET_BRIEF_DOC",
      slug: "webdotcom",
      versionId: "ver-1",
    });

    expect(snap.schema_version).toBe(1);
    expect(snap.uuid).toBe("webdotcom");
    expect(snap.code).toBe("webdotcom");
    expect(snap.catalog).toEqual(item);
    expect(snap.enrichment).toEqual({ status: "complete" });
    expect(snap.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snap.source_hash).toBe(
      await radarSourceHash({ catalog: item, detail: snap.detail }),
    );
    expect(snap.detail?.name).toBe("Web.com Bug Bounty");
    expect(snap.detail?.statistics.vulnerabilities_rewarded?.value).toBe(
      "721",
    );
    expect(snap.detail?.targetGroups[0]?.rewards.p1).toBe(3000);
    expect(snap.detail?.targets[0]?.location).toBe("https://app.web.com");
    expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it("falls back to uuid when the catalog row has no code", async () => {
    mockHappyPath();
    await hydrateRadarProgram(catalogItem({ code: null, uuid: "fallback-slug" }));
    expect(siteRequest).toHaveBeenCalledWith({
      operation: "GET_CHANGELOGS",
      slug: "fallback-slug",
    });
  });

  it("a stats failure degrades to empty statistics, still complete", async () => {
    mockHappyPath(new ApiError("http", "HTTP 500", 500));
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.enrichment).toEqual({ status: "complete" });
    expect(snap.detail).not.toBeNull();
    expect(snap.detail?.statistics).toEqual({});
    expect(snap.detail?.targetGroups.length).toBeGreaterThan(0);
  });
});

describe("hydrateRadarProgram per-item errors (no fatal kinds on the site path)", () => {
  it("unauthorized (login redirect) → unavailable, not a rethrow", async () => {
    siteRequest.mockRejectedValueOnce(
      new ApiError("unauthorized", "unauthorized", 401),
    );
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.detail).toBeNull();
    expect(snap.enrichment).toEqual({
      status: "unavailable",
      error_kind: "unauthorized",
    });
    expect(snap.source_hash).toBe(
      await radarSourceHash({ catalog: catalogItem(), detail: null }),
    );
    expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it("forbidden → unavailable", async () => {
    siteRequest.mockRejectedValueOnce(new ApiError("forbidden", "forbidden", 403));
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.enrichment).toEqual({
      status: "unavailable",
      error_kind: "forbidden",
    });
    expect(snap.detail).toBeNull();
  });

  it("not_found → unavailable", async () => {
    siteRequest.mockRejectedValueOnce(new ApiError("not_found", "not found", 404));
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.enrichment).toEqual({
      status: "unavailable",
      error_kind: "not_found",
    });
  });

  it("http/network/rate_limited → failed", async () => {
    for (const kind of ["http", "network", "rate_limited"] as const) {
      siteRequest.mockReset();
      siteRequest.mockRejectedValueOnce(new ApiError(kind, kind));
      const snap = await hydrateRadarProgram(catalogItem());
      expect(snap.enrichment).toEqual({ status: "failed", error_kind: kind });
    }
  });

  it("a malformed changelog list → failed/invalid_response", async () => {
    siteRequest.mockResolvedValueOnce({
      data: { changelogs: [] },
      status: 200,
    });
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.detail).toBeNull();
    expect(snap.enrichment).toEqual({
      status: "failed",
      error_kind: "invalid_response",
    });
  });

  it("a malformed brief doc → failed/invalid_response", async () => {
    siteRequest.mockImplementation(async (opts: { operation: string }) => {
      if (opts.operation === "GET_CHANGELOGS") {
        return { data: changelogList(), status: 200 };
      }
      if (opts.operation === "GET_BRIEF_DOC") {
        return { data: { id: "ver-1" }, status: 200 }; // no data.scope
      }
      return { data: {}, status: 200 };
    });
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.detail).toBeNull();
    expect(snap.enrichment).toEqual({
      status: "failed",
      error_kind: "invalid_response",
    });
  });

  it("non-ApiError plumbing bugs → failed/unknown", async () => {
    siteRequest.mockRejectedValueOnce(new TypeError("weird"));
    const snap = await hydrateRadarProgram(catalogItem());
    expect(snap.enrichment).toEqual({ status: "failed", error_kind: "unknown" });
  });
});
