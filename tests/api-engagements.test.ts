import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { API_BASE } from "../lib/constants";
import fixture from "./fixtures/api/engagement.json";

// Same fresh-module pattern as api-client.test.ts: lib/api/client.ts keeps a
// module-level rate bucket, so each test re-imports after vi.resetModules().

const CREDENTIAL = "test-credential-4f8c2b91";
const ENGAGEMENT_UUID = fixture.data.id;

type EngagementsModule = typeof import("../lib/api/engagements");
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

/** Index page of `count` engagements whose codes never equal `wantedCode`. */
function indexPage(codes: string[]): object {
  return {
    data: codes.map((code, i) => ({
      type: "engagement",
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      attributes: { code },
    })),
  };
}

let engagements: EngagementsModule;
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
  engagements = await import("../lib/api/engagements");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseEngagement", () => {
  it("maps every engagement field from the JSON:API document", () => {
    const data = engagements.parseEngagement(fixture, "1.1.0");
    expect(data).toEqual({
      uuid: ENGAGEMENT_UUID,
      name: "Acme Corp Bug Bounty",
      code: "acme-corp-bb",
      engagementType: "bug_bounty",
      managedBounty: true,
      lifecycleStatus: "running",
      testingStart: "2026-01-01T00:00:00.000Z",
      testingEnd: "2026-12-31T23:59:59.000Z",
      testingPeriodLabel: "year_round",
      lastStatusTransition: "2026-01-05T12:00:00.000Z",
      lastBriefUpdate: "2026-09-01T08:30:00.000Z",
      safeHarborLevel: "full_safe_harbor",
      statistics: {
        vulnerabilities_rewarded: { value: "1,234", window: "last_90_days" },
        average_payout: { value: "$512.00", window: "last_90_days" },
        researchers_participating: { value: "321", window: null },
      },
      targetGroups: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          name: "Web Applications",
          inScope: true,
          description: "All customer-facing web applications.",
          rewards: { p1: 3000, p2: 1500, p3: 750, p4: 300, p5: 100 },
        },
        {
          id: "aaaaaaaa-0000-4000-8000-000000000002",
          name: "API Endpoints",
          inScope: true,
          description: null,
          // p4/p5 absent in the payload → null, never dropped or invented
          rewards: { p1: 1000, p2: 500, p3: 200, p4: null, p5: null },
        },
      ],
      targets: [
        {
          id: "bbbbbbbb-0000-4000-8000-000000000001",
          groupId: "aaaaaaaa-0000-4000-8000-000000000001",
          location: "https://*.acme-example.com",
          name: "Acme wildcard web property",
          category: "website",
          tags: ["web", "customer-facing"],
          inScope: true,
        },
        {
          id: "bbbbbbbb-0000-4000-8000-000000000002",
          groupId: "aaaaaaaa-0000-4000-8000-000000000002",
          location: "10.20.30.0/24",
          name: null,
          category: "hardware",
          tags: [],
          inScope: false,
        },
      ],
      observedApiVersion: "1.1.0",
    });
  });

  it("observedApiVersion is null when no observed version is supplied", () => {
    const data = engagements.parseEngagement(fixture);
    expect(data.observedApiVersion).toBeNull();
  });

  it("throws invalid_response on malformed documents without leaking body", () => {
    for (const bad of [null, {}, { data: [] }, { data: { type: "program" } }, 42]) {
      try {
        engagements.parseEngagement(bad);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(errors.ApiError);
        expect((err as InstanceType<ErrorsModule["ApiError"]>).kind).toBe(
          "invalid_response",
        );
      }
    }
  });
});

describe("parseEngagementsIndex", () => {
  it("extracts uuid + code pairs, code from attributes or URL slug", () => {
    const entries = engagements.parseEngagementsIndex({
      data: [
        {
          type: "engagement",
          id: "uuid-1",
          attributes: { code: "acme-corp-bb", name: "Acme" },
        },
        {
          type: "engagement",
          id: "uuid-2",
          attributes: { url: "https://bugcrowd.com/engagements/other-prog" },
        },
        { type: "engagement", id: "uuid-3", attributes: { name: "No code" } },
        { type: "program", id: "uuid-4", attributes: { code: "not-eng" } },
        "garbage",
      ],
    });
    expect(entries).toEqual([
      { uuid: "uuid-1", code: "acme-corp-bb" },
      { uuid: "uuid-2", code: "other-prog" },
      { uuid: "uuid-3", code: null },
    ]);
  });

  it("returns [] for malformed or empty documents", () => {
    expect(engagements.parseEngagementsIndex(null)).toEqual([]);
    expect(engagements.parseEngagementsIndex({})).toEqual([]);
    expect(engagements.parseEngagementsIndex({ data: {} })).toEqual([]);
    expect(engagements.parseEngagementsIndex({ data: [] })).toEqual([]);
  });
});

describe("resolveEngagementUuid", () => {
  it("returns pageUuid immediately without any fetch", async () => {
    const uuid = await engagements.resolveEngagementUuid("acme-corp-bb", ENGAGEMENT_UUID);
    expect(uuid).toBe(ENGAGEMENT_UUID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds the uuid by paging the index until the code matches", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]=1")) {
        // full page (25 items) → paging continues
        return jsonResponse(
          indexPage(Array.from({ length: 25 }, (_, i) => `other-${i}`)),
        );
      }
      return jsonResponse(indexPage(["acme-corp-bb"]));
    });
    const uuid = await engagements.resolveEngagementUuid("acme-corp-bb");
    expect(uuid).toBe("00000000-0000-4000-8000-000000000001");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toContain("page[number]=1");
    expect(fetchMock.mock.calls[1]![0]).toContain("page[number]=2");
  });

  it("stops paging when a page returns fewer than 25 entries", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(indexPage(["nope-1", "nope-2"])),
    );
    const uuid = await engagements.resolveEngagementUuid("acme-corp-bb");
    expect(uuid).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when no page matches (short final page)", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(indexPage([])));
    const uuid = await engagements.resolveEngagementUuid("acme-corp-bb");
    expect(uuid).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps index paging at 20 pages", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        indexPage(
          Array.from({ length: 25 }, (_, i) => `prog-${i}`),
        ),
      ),
    );
    const uuid = await engagements.resolveEngagementUuid("acme-corp-bb");
    expect(uuid).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(20);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain(`${API_BASE}/engagements?page[number]=`);
    }
  });

  it("propagates ApiError (e.g. unauthorized) instead of returning null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    await expect(
      engagements.resolveEngagementUuid("acme-corp-bb"),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

describe("fetchEngagementEnrichment", () => {
  it("resolves via pageUuid, fetches, parses, and emits SourceRecords", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      expect(String(url)).toBe(
        `${API_BASE}/engagements/${ENGAGEMENT_UUID}?include=target_groups,targets`,
      );
      return jsonResponse(fixture, {
        headers: { "x-bugcrowd-version": "1.1.0" },
      });
    });
    const res = await engagements.fetchEngagementEnrichment(
      "acme-corp-bb",
      ENGAGEMENT_UUID,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.uuid).toBe(ENGAGEMENT_UUID);
    expect(res.data.code).toBe("acme-corp-bb");
    expect(res.data.observedApiVersion).toBe("1.1.0");
    expect(res.data.targetGroups).toHaveLength(2);
    expect(res.data.targets).toHaveLength(2);

    const keys = res.records.map((r) => r.sourceKey).sort();
    expect(keys).toEqual(
      [
        "api:engagement:classification",
        "api:engagement:identity",
        "api:engagement:lifecycle",
        "api:engagement:observed_version",
        "api:engagement:safe_harbor",
        "api:engagement:statistics",
        "api:engagement:target_groups",
        "api:engagement:targets",
      ].sort(),
    );
    for (const rec of res.records) {
      expect(rec.sourceType).toBe("api");
      expect(rec.sourceLevel).toBe("api_field");
      expect(rec.authenticated).toBe(true);
      expect(rec.extractionStatus).toBe("exact");
      expect(rec.sourceUrl).toBe(`${API_BASE}/engagements/${ENGAGEMENT_UUID}`);
      expect(typeof rec.quote).toBe("string");
      expect(rec.quote.length).toBeGreaterThan(0);
    }
    const identity = res.records.find(
      (r) => r.sourceKey === "api:engagement:identity",
    );
    expect(identity?.data).toEqual({
      uuid: ENGAGEMENT_UUID,
      name: "Acme Corp Bug Bounty",
      code: "acme-corp-bb",
    });
    const targetsRec = res.records.find(
      (r) => r.sourceKey === "api:engagement:targets",
    );
    expect(targetsRec?.data).toEqual(res.data.targets);
    // No credential anywhere in the emitted evidence.
    expect(JSON.stringify(res.records)).not.toContain(CREDENTIAL);
  });

  it("resolves through the index when no pageUuid is given", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u === `${API_BASE}/engagements?page[number]=1&page[size]=25`) {
        return jsonResponse(indexPage(["acme-corp-bb"]));
      }
      if (u.includes("/engagements/")) return jsonResponse(fixture);
      throw new Error(`unexpected url ${u}`);
    });
    const res = await engagements.fetchEngagementEnrichment("acme-corp-bb");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // index first, then the resolved engagement uuid
    expect(calls[0]).toContain("page[number]=1");
    expect(calls[1]).toBe(
      `${API_BASE}/engagements/00000000-0000-4000-8000-000000000001?include=target_groups,targets`,
    );
  });

  it("returns {ok:false,not_found} when the code matches nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(indexPage([])));
    const res = await engagements.fetchEngagementEnrichment("acme-corp-bb");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("not_found");
  });

  it("returns {ok:false,unauthorized} on 401 without leaking the credential", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const res = await engagements.fetchEngagementEnrichment(
      "acme-corp-bb",
      ENGAGEMENT_UUID,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("unauthorized");
      expect(JSON.stringify(res.error)).not.toContain(CREDENTIAL);
      expect(res.error.message).not.toContain(CREDENTIAL);
    }
  });
});

describe("testToken", () => {
  it("reports ok + 'token valid' on 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const res = await engagements.testToken("candidate-token-1");
    expect(res).toEqual({ ok: true, detail: "token valid" });
    const init = fetchMock.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.Authorization).toBe("Token candidate-token-1");
  });

  it("reports 'unauthorized' on 401/403", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    expect(await engagements.testToken("bad")).toEqual({
      ok: false,
      detail: "unauthorized",
    });
  });

  it("reports 'rate limited, try later' after repeated 429", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    const promise = engagements.testToken("bad");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await promise).toEqual({
      ok: false,
      detail: "rate limited, try later",
    });
  });

  it("reports 'unreachable' on network failure and never echoes the token", async () => {
    fetchMock.mockRejectedValue(new TypeError("boom"));
    const promise = engagements.testToken("secret-candidate-9");
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("unreachable");
    expect(res.detail).not.toContain("secret-candidate-9");
  });
});
