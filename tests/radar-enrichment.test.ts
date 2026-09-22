import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/errors";
import type { ApiEngagementData } from "../lib/types";
import { radarSourceHash } from "../lib/radar/hash";
import { radarProgramSnapshotSchema } from "../lib/radar/types";
import type { RadarCatalogItem } from "../lib/radar/types";

// The enrichment pipeline's two sinks are mocked at the module boundary:
// siteClient (network) and offscreen (DOM parsing). Both are thin wrappers
// with their own test coverage — hydrateRadarProgram only orchestrates them
// and classifies failures.

const siteRequest = vi.fn();
const parseBriefHtml = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequest(...args),
}));
vi.mock("../lib/radar/offscreen", () => ({
  parseBriefHtml: (...args: unknown[]) => parseBriefHtml(...args),
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

function detailDoc(over: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "webdotcom",
    name: "Web.com Bug Bounty",
    code: "webdotcom",
    engagementType: "Bug Bounty",
    managedBounty: true,
    lifecycleStatus: "In progress",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: "Ongoing",
    lastStatusTransition: "2020-01-01T00:00:00Z",
    lastBriefUpdate: "2026-09-11T15:03:27Z",
    safeHarborLevel: "full",
    statistics: { vulnerabilities_rewarded: { value: "721", window: null } },
    targetGroups: [
      {
        id: "g1",
        name: "In scope",
        inScope: true,
        description: null,
        rewards: { p1: 3000, p2: 1500, p3: 600, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: "t1",
        groupId: "g1",
        location: "https://app.web.com",
        name: "app.web.com",
        category: null,
        tags: ["Website Testing"],
        inScope: true,
      },
    ],
    observedApiVersion: null,
    ...over,
  };
}

beforeEach(() => {
  siteRequest.mockReset();
  parseBriefHtml.mockReset();
});

describe("hydrateRadarProgram happy path", () => {
  it("fetches the brief by slug and parses it into a complete snapshot", async () => {
    siteRequest.mockResolvedValueOnce({ data: "<html>brief</html>", status: 200 });
    parseBriefHtml.mockResolvedValueOnce(detailDoc());
    const item = catalogItem();
    const snap = await hydrateRadarProgram(item);

    expect(siteRequest).toHaveBeenCalledWith({
      operation: "GET_BRIEF",
      slug: "webdotcom",
    });
    expect(parseBriefHtml).toHaveBeenCalledWith(
      "webdotcom",
      "<html>brief</html>",
      "https://bugcrowd.com/engagements/webdotcom",
    );

    expect(snap.schema_version).toBe(1);
    expect(snap.uuid).toBe("webdotcom");
    expect(snap.code).toBe("webdotcom");
    expect(snap.catalog).toEqual(item);
    expect(snap.enrichment).toEqual({ status: "complete" });
    expect(snap.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snap.source_hash).toBe(
      await radarSourceHash({ catalog: item, detail: snap.detail }),
    );
    expect(snap.detail?.statistics.vulnerabilities_rewarded?.value).toBe("721");
    expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it("falls back to uuid when the catalog row has no code", async () => {
    siteRequest.mockResolvedValueOnce({ data: "<html></html>", status: 200 });
    parseBriefHtml.mockResolvedValueOnce(detailDoc());
    await hydrateRadarProgram(catalogItem({ code: null, uuid: "fallback-slug" }));
    expect(siteRequest).toHaveBeenCalledWith({
      operation: "GET_BRIEF",
      slug: "fallback-slug",
    });
  });
});

describe("hydrateRadarProgram per-item errors (no fatal kinds on the site path)", () => {
  it("unauthorized (login redirect) → unavailable, not a rethrow", async () => {
    siteRequest.mockRejectedValueOnce(new ApiError("unauthorized", "unauthorized", 401));
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
      siteRequest.mockRejectedValueOnce(new ApiError(kind, kind));
      const snap = await hydrateRadarProgram(catalogItem());
      expect(snap.enrichment).toEqual({ status: "failed", error_kind: kind });
    }
  });

  it("offscreen parse failure → failed/invalid_response", async () => {
    siteRequest.mockResolvedValueOnce({ data: "<html></html>", status: 200 });
    parseBriefHtml.mockRejectedValueOnce(
      new ApiError("invalid_response", "offscreen parse failed"),
    );
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
