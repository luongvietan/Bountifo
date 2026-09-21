import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { API_BASE } from "../lib/constants";
import { radarSourceHash } from "../lib/radar/hash";
import { radarProgramSnapshotSchema } from "../lib/radar/types";
import type { RadarCatalogItem } from "../lib/radar/types";

// Same fresh-module pattern as radar-catalog.test.ts: the shared API client
// keeps a module-level rate bucket and storageAccess caches the lockdown
// probe, so each test re-imports enrichment (and its deps) after
// vi.resetModules(). errors is imported fresh so instanceof works.

const CREDENTIAL = "test-credential-4f8c2b91";
const UUID = "f2b0fb99-1b2c-45d2-9341-f4a25088ba3a";

type EnrichmentModule = typeof import("../lib/radar/enrichment");
type ErrorsModule = typeof import("../lib/api/errors");

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

function catalogItem(overrides: Partial<RadarCatalogItem> = {}): RadarCatalogItem {
  return {
    uuid: UUID,
    code: "acme",
    name: "Acme",
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

/** Minimal valid GET_ENGAGEMENT document (JSON:API data + included). */
function engagementDoc(uuid: string = UUID) {
  return {
    data: {
      type: "engagement",
      id: uuid,
      attributes: {
        name: "Acme",
        code: "acme-api-code",
        engagement_type: "bug_bounty",
        managed: true,
        state: "live",
        safe_harbor_status: "full",
        statistics: { payouts: { value: "100", window: "90d" } },
      },
      relationships: {
        target_groups: { data: [{ type: "target_group", id: "g1" }] },
        targets: { data: [{ type: "target", id: "t1" }] },
      },
    },
    included: [
      {
        type: "target_group",
        id: "g1",
        attributes: {
          name: "Web",
          in_scope: true,
          rewards: { p1: 100, p3: 500 },
        },
      },
      {
        type: "target",
        id: "t1",
        attributes: {
          uri: "https://a.example.com",
          category: "website",
          tags: ["prod"],
          in_scope: true,
        },
        relationships: {
          target_group: { data: { type: "target_group", id: "g1" } },
        },
      },
    ],
  };
}

let enrichment: EnrichmentModule;
let errors: ErrorsModule;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  vi.useFakeTimers();
  stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
  await fakeBrowser.storage.local.set({ apiCredential: CREDENTIAL });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  errors = await import("../lib/api/errors");
  enrichment = await import("../lib/radar/enrichment");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hydrateRadarProgram happy path", () => {
  it("GETs the engagement by catalog uuid and builds a complete snapshot", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(engagementDoc(), {
        headers: { "x-bugcrowd-version": "2026-09-20" },
      }),
    );
    const item = catalogItem();
    const snap = await enrichment.hydrateRadarProgram(item);

    // UUID comes straight from the catalog item — include query is fixed.
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `${API_BASE}/engagements/${UUID}?include=target_groups,targets`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(snap.schema_version).toBe(1);
    expect(snap.uuid).toBe(UUID);
    // code comes from the catalog item, not the detail payload.
    expect(snap.code).toBe("acme");
    expect(snap.catalog).toEqual(item);
    expect(snap.enrichment).toEqual({ status: "complete" });
    expect(snap.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snap.source_hash).toBe(
      await radarSourceHash({ catalog: item, detail: snap.detail }),
    );

    expect(snap.detail).not.toBeNull();
    expect(snap.detail!.uuid).toBe(UUID);
    expect(snap.detail!.code).toBe("acme-api-code");
    expect(snap.detail!.observedApiVersion).toBe("2026-09-20");
    expect(snap.detail!.targetGroups).toHaveLength(1);
    expect(snap.detail!.targetGroups[0]!.rewards.p3).toBe(500);
    expect(snap.detail!.targets[0]!.location).toBe("https://a.example.com");

    expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});

describe("hydrateRadarProgram non-fatal errors", () => {
  it("403 → unavailable snapshot with detail null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 403 }));
    const snap = await enrichment.hydrateRadarProgram(catalogItem());
    expect(snap.detail).toBeNull();
    expect(snap.enrichment).toEqual({
      status: "unavailable",
      error_kind: "forbidden",
    });
    expect(snap.source_hash).toBe(
      await radarSourceHash({ catalog: catalogItem(), detail: null }),
    );
    expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it("404 → unavailable snapshot", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
    const snap = await enrichment.hydrateRadarProgram(catalogItem());
    expect(snap.enrichment).toEqual({
      status: "unavailable",
      error_kind: "not_found",
    });
    expect(snap.detail).toBeNull();
  });

  it("malformed JSON:API → failed snapshot with invalid_response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { type: "program", id: "x" } }),
    );
    const snap = await enrichment.hydrateRadarProgram(catalogItem());
    expect(snap.enrichment).toEqual({
      status: "failed",
      error_kind: "invalid_response",
    });
    expect(snap.detail).toBeNull();
    expect(radarProgramSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it("persistent 500 → failed snapshot with http after retries exhaust", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    const promise = enrichment.hydrateRadarProgram(catalogItem());
    await vi.advanceTimersByTimeAsync(30_000);
    const snap = await promise;
    expect(snap.enrichment).toEqual({ status: "failed", error_kind: "http" });
    expect(snap.detail).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("persistent 429 → failed snapshot with rate_limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    const promise = enrichment.hydrateRadarProgram(catalogItem());
    await vi.advanceTimersByTimeAsync(60_000);
    const snap = await promise;
    expect(snap.enrichment).toEqual({
      status: "failed",
      error_kind: "rate_limited",
    });
  });

  it("empty uuid → client's own TypeError becomes failed/unknown", async () => {
    const snap = await enrichment.hydrateRadarProgram(catalogItem({ uuid: "" }));
    expect(snap.enrichment).toEqual({ status: "failed", error_kind: "unknown" });
    expect(snap.detail).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hydrateRadarProgram fatal credential errors", () => {
  it("401 → unauthorized ApiError is rethrown, no snapshot", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    const err = await enrichment.hydrateRadarProgram(catalogItem()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(errors.ApiError);
    expect((err as InstanceType<ErrorsModule["ApiError"]>).kind).toBe(
      "unauthorized",
    );
  });

  it("missing credential → no_token ApiError is rethrown", async () => {
    await fakeBrowser.storage.local.remove("apiCredential");
    await expect(
      enrichment.hydrateRadarProgram(catalogItem()),
    ).rejects.toMatchObject({ kind: "no_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("locked credential storage → storage_locked ApiError is rethrown", async () => {
    stubSetAccessLevel(() => {
      throw new Error("setAccessLevel not implemented");
    });
    vi.resetModules();
    const fresh = await import("../lib/radar/enrichment");
    await expect(
      fresh.hydrateRadarProgram(catalogItem()),
    ).rejects.toMatchObject({ kind: "storage_locked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
