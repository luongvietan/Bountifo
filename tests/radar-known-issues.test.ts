import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type ApiErrorKind } from "../lib/api/errors";
import { BUGCROWD_SITE } from "../lib/constants";
import { radarKnownIssueSummarySchema } from "../lib/radar/deepTypes";
import type { RadarKnownIssueSummary } from "../lib/radar/deepTypes";

// ---------------------------------------------------------------------------
// Known Issues data path (Radar V1.3).
//
// The collector's only sink is siteRequest — mocked at the module boundary so
// EVERY ApiError kind is reachable (the real fetch layer can never produce
// the client.ts-only kinds no_token/storage_locked). The new siteClient op
// itself is covered against the REAL module (vi.importActual) with a stubbed
// fetch, mirroring tests/api-site-client.test.ts.
//
// Fixtures under tests/fixtures/radar/site/*-known-issues.json are byte-shape
// copies of the live 2026-09-22 responses: {"unique":N,"total":N}.
// ---------------------------------------------------------------------------

const siteRequestMock = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequestMock(...args),
}));

import {
  fetchKnownIssueSummary,
  knownIssueDensity,
  parseEngagementKnownIssues,
} from "../lib/radar/knownIssues";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "radar", "site");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function complete(u: number, t: number): RadarKnownIssueSummary {
  return { status: "complete", unique_count: u, total_count: t };
}

const FAILED = {
  status: "failed",
  unique_count: null,
  total_count: null,
} satisfies RadarKnownIssueSummary;

let realSiteClient: typeof import("../lib/api/siteClient");
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  siteRequestMock.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // Bypasses the module mock above: exercises real URL construction.
  realSiteClient = await vi.importActual("../lib/api/siteClient");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseEngagementKnownIssues", () => {
  it.each([
    ["webdotcom-known-issues.json", 165, 409],
    ["tesla-known-issues.json", 111, 766],
    ["launchdarkly-mbb-og-known-issues.json", 44, 590],
  ])("parses the live-shaped fixture %s", (file, unique, total) => {
    const s = parseEngagementKnownIssues(fixture(file));
    expect(s).toEqual({
      status: "complete",
      unique_count: unique,
      total_count: total,
    });
    expect(radarKnownIssueSummarySchema.safeParse(s).success).toBe(true);
  });

  it("a real zero pair parses complete/0 — zeros are data, not absence", () => {
    expect(parseEngagementKnownIssues({ unique: 0, total: 0 })).toEqual({
      status: "complete",
      unique_count: 0,
      total_count: 0,
    });
  });

  it("total < unique still parses — site semantics are kept verbatim", () => {
    expect(parseEngagementKnownIssues({ unique: 10, total: 3 })).toEqual({
      status: "complete",
      unique_count: 10,
      total_count: 3,
    });
  });

  it("tolerates extra keys — a new upstream field must not become an outage", () => {
    const s = parseEngagementKnownIssues({
      unique: 5,
      total: 9,
      future_field: { nested: [1, 2] },
    });
    expect(s).toEqual({ status: "complete", unique_count: 5, total_count: 9 });
  });

  it.each([
    ["a bare string", "lots of issues"],
    ["an empty string", ""],
    ["a bare number", 42],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an array", [165, 409]],
    ["an empty object", {}],
    ["missing total", { unique: 5 }],
    ["missing unique", { total: 9 }],
    ["string counts", { unique: "165", total: "409" }],
    ["float unique", { unique: 1.5, total: 2 }],
    ["float total", { unique: 1, total: 2.5 }],
    ["negative unique", { unique: -1, total: 0 }],
    ["negative total", { unique: 0, total: -2 }],
    ["null unique", { unique: null, total: 0 }],
    ["NaN unique", { unique: Number.NaN, total: 1 }],
    ["Infinity total", { unique: 1, total: Number.POSITIVE_INFINITY }],
    ["nested object", { unique: { value: 1 }, total: 2 }],
  ])("malformed body: %s → failed with null counts", (_label, raw) => {
    expect(parseEngagementKnownIssues(raw)).toEqual(FAILED);
  });

  it("is pure — identical input yields an equal fresh object", () => {
    const a = parseEngagementKnownIssues({ unique: 7, total: 9 });
    const b = parseEngagementKnownIssues({ unique: 7, total: 9 });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("fetchKnownIssueSummary", () => {
  it("issues GET_ENGAGEMENT_KNOWN_ISSUES for the slug and parses the body", async () => {
    siteRequestMock.mockResolvedValue({
      data: { unique: 165, total: 409 },
      status: 200,
    });
    const s = await fetchKnownIssueSummary("webdotcom");
    expect(siteRequestMock).toHaveBeenCalledWith({
      operation: "GET_ENGAGEMENT_KNOWN_ISSUES",
      slug: "webdotcom",
    });
    expect(s).toEqual({
      status: "complete",
      unique_count: 165,
      total_count: 409,
    });
  });

  it.each(["unauthorized", "forbidden", "not_found"] as const)(
    "ApiError %s → unavailable (feature absent / session dead)",
    async (kind) => {
      siteRequestMock.mockRejectedValue(new ApiError(kind, kind));
      const s = await fetchKnownIssueSummary("some-program");
      expect(s).toEqual({
        status: "unavailable",
        unique_count: null,
        total_count: null,
      });
    },
  );

  it.each([
    "invalid_response",
    "http",
    "network",
    "rate_limited",
    "no_token",
    "storage_locked",
  ] as const)("ApiError %s → failed", async (kind) => {
    siteRequestMock.mockRejectedValue(new ApiError(kind, kind));
    const s = await fetchKnownIssueSummary("some-program");
    expect(s).toEqual(FAILED);
  });

  it("a malformed JSON body → failed, never zeroed counts", async () => {
    siteRequestMock.mockResolvedValue({
      data: { unique: "many", total: "lots" },
      status: 200,
    });
    expect(await fetchKnownIssueSummary("some-program")).toEqual(FAILED);
  });

  it("non-ApiError plumbing failures → failed; the call never throws", async () => {
    siteRequestMock.mockRejectedValue(new TypeError("weird"));
    await expect(fetchKnownIssueSummary("some-program")).resolves.toEqual(
      FAILED,
    );
    siteRequestMock.mockRejectedValue("a bare string rejection");
    await expect(fetchKnownIssueSummary("some-program")).resolves.toEqual(
      FAILED,
    );
  });
});

describe("siteRequest GET_ENGAGEMENT_KNOWN_ISSUES (real client, stubbed fetch)", () => {
  it("requests engagement_known_issues.json with session cookies", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unique: 165, total: 409 }));
    const res = await realSiteClient.siteRequest({
      operation: "GET_ENGAGEMENT_KNOWN_ISSUES",
      slug: "webdotcom",
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ unique: 165, total: 409 });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      `${BUGCROWD_SITE}/engagements/webdotcom/engagement_known_issues.json`,
    );
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toContain("application/json");
    // Session auth only — never a stored credential.
    expect(headers.Authorization).toBeUndefined();
  });

  it("accepts the full slug alphabet [A-Za-z0-9_-]", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unique: 1, total: 2 }));
    await realSiteClient.siteRequest({
      operation: "GET_ENGAGEMENT_KNOWN_ISSUES",
      slug: "A-b_c9",
    });
    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      `${BUGCROWD_SITE}/engagements/A-b_c9/engagement_known_issues.json`,
    );
  });

  it.each(["", "bad slug", "a/b", "../escape", "dot.slug", "slug?x=1"])(
    "rejects invalid slug %j before any fetch",
    async (slug) => {
      await expect(
        realSiteClient.siteRequest({
          operation: "GET_ENGAGEMENT_KNOWN_ISSUES",
          slug,
        }),
      ).rejects.toThrow(/requires a slug/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("a 404 on the op surfaces not_found (feature absent for the program)", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      realSiteClient.siteRequest({
        operation: "GET_ENGAGEMENT_KNOWN_ISSUES",
        slug: "no-such-program",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("knownIssueDensity", () => {
  it("returns null unless the summary is complete", () => {
    for (const status of ["unavailable", "failed"] as const) {
      expect(
        knownIssueDensity(
          { status, unique_count: null, total_count: null },
          30,
        ),
      ).toBeNull();
    }
  });

  it("returns null when a complete summary carries a null count", () => {
    expect(
      knownIssueDensity(
        { status: "complete", unique_count: null, total_count: 5 },
        30,
      ),
    ).toBeNull();
    expect(
      knownIssueDensity(
        { status: "complete", unique_count: 5, total_count: null },
        30,
      ),
    ).toBeNull();
  });

  it("unique = 0 → exactly 0 regardless of surface", () => {
    expect(knownIssueDensity(complete(0, 0), null)).toBe(0);
    expect(knownIssueDensity(complete(0, 0), 30)).toBe(0);
  });

  it("pins the calibrated blend: 0.5·u/(u+50) + 0.5·d/(d+5), d=u/targets", () => {
    // Values computed against the live 2026-09-22 sample.
    expect(knownIssueDensity(complete(9, 23), 8)).toBe(0.1681); // matlab-online
    expect(knownIssueDensity(complete(44, 590), 25)).toBe(0.3642); // launchdarkly
    expect(knownIssueDensity(complete(165, 409), 30)).toBe(0.6456); // webdotcom
    expect(knownIssueDensity(complete(264, 574), 40)).toBe(0.7049); // indeed
  });

  it("null, zero, sub-1 or non-finite surfaces fall back to volume-only", () => {
    // webdotcom volume component: 165/(165+50) = 0.7674.
    for (const t of [null, 0, 0.5, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(knownIssueDensity(complete(165, 409), t)).toBe(0.7674);
    }
  });

  it("is monotone nondecreasing in unique for a fixed surface", () => {
    let prev = -1;
    for (let u = 0; u <= 400; u += 3) {
      const v = knownIssueDensity(complete(u, 2 * u), 30);
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThanOrEqual(prev);
      prev = v!;
    }
  });

  it("strictly increases across the 11 sampled programs at a fixed surface", () => {
    const sampledUnique = [9, 26, 28, 44, 52, 69, 90, 111, 165, 173, 264];
    const values = sampledUnique.map(
      (u) => knownIssueDensity(complete(u, 2 * u), 30)!,
    );
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it("a wider surface for the same unique count lowers pressure", () => {
    const dense = knownIssueDensity(complete(165, 409), 10)!;
    const spread = knownIssueDensity(complete(165, 409), 60)!;
    expect(spread).toBeLessThan(dense);
    // And a lone-target worst case still stays under 1.
    const extreme = knownIssueDensity(complete(100_000, 200_000), 1)!;
    expect(extreme).toBeLessThanOrEqual(1);
  });

  it("stays inside [0,1] across the envelope", () => {
    for (const u of [0, 1, 9, 50, 264, 10_000]) {
      for (const t of [null, 1, 7, 30, 500]) {
        const v = knownIssueDensity(complete(u, 2 * u), t)!;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic — same inputs, same output", () => {
    expect(knownIssueDensity(complete(69, 343), 25)).toBe(
      knownIssueDensity(complete(69, 343), 25),
    );
  });
});
