import { describe, expect, it } from "vitest";
import { diffBriefDocuments } from "../lib/radar/diff";
import { extractProgramFeatures } from "../lib/radar/features";
import {
  classifyTarget,
  isHttpUrl,
  locationLooksApi,
  tokenSet,
} from "../lib/radar/surface";
import type { ApiEngagementData, ApiTarget } from "../lib/types";
import type { RadarProgramSnapshot } from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Radar V1.4 — URL-shape API surface classification (lib/radar/surface.ts).
//
// Pins the plan's "Surface classifier URL shapes" section verbatim:
//   - `new URL(location.trim())` must parse with http/https protocol else
//     false — bare hostnames ("api.example.com"), mailto:, ftp: → NOT api.
//   - hostname lowercased, split on /[^a-z0-9]+/, ∩ API_HOST_TOKENS → api.
//   - FIRST pathname segment ∈ API_PATH_TOKENS → api.
//   - bare /v\d+/ segments do NOT count; api deeper than segment 1 does NOT
//     count (pinned conservatism).
//   - classifyTarget: api = tokenSet∩API_TOKENS || locationLooksApi; web =
//     tokenSet∩WEB_TOKENS || (!api && isHttpUrl) — the http fallback fires
//     only when neither class matched.
// ---------------------------------------------------------------------------

function makeTarget(partial: Partial<ApiTarget> = {}): ApiTarget {
  return {
    id: "t1",
    groupId: null,
    location: null,
    name: null,
    category: null,
    tags: [],
    inScope: true,
    ...partial,
  };
}

function makeDetail(partial: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "prog",
    name: "Program",
    code: "prog",
    engagementType: null,
    managedBounty: null,
    lifecycleStatus: "In progress",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: null,
    lastBriefUpdate: null,
    safeHarborLevel: null,
    statistics: {},
    targetGroups: [],
    targets: [],
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: null,
    ...partial,
  };
}

const NOW = "2026-09-21T00:00:00.000Z";

function snapshot(detailValue: ApiEngagementData): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: "uuid-1",
    code: "acme",
    catalog: {
      uuid: "uuid-1",
      code: "acme",
      name: "Acme",
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: "2026-09-01T00:00:00.000Z",
    },
    detail: detailValue,
    enrichment: { status: "complete" },
    source_hash: `sha256:${"0".repeat(64)}`,
  };
}

// ---------------------------------------------------------------------------
// locationLooksApi — host token shapes
// ---------------------------------------------------------------------------

describe("locationLooksApi — hostname token shapes", () => {
  it.each([
    "https://api.example.com/",
    "https://api.example.com",
    "https://graphql.example.com",
    "https://grpc.example.com",
    "https://gateway.example.com",
    "https://rest.example.com",
    "https://rpc.example.com",
    "https://ws.example.com",
    "https://webservice.example.com",
    "https://service.example.com",
    "https://apis.example.com",
  ])("api host token → true: %s", (location) => {
    expect(locationLooksApi(location)).toBe(true);
  });

  it("matches an api token anywhere in the dotted/split hostname", () => {
    expect(locationLooksApi("https://internal-api.example.com")).toBe(true);
    expect(locationLooksApi("https://staging-api.acme.example.com")).toBe(
      true,
    );
    expect(locationLooksApi("https://api.internal.example.com")).toBe(true);
  });

  it("is exact-token only: apiserver/capitol/restaurant hosts are NOT api", () => {
    expect(locationLooksApi("https://apiserver.example.com")).toBe(false);
    expect(locationLooksApi("https://capitol.example.com")).toBe(false);
    expect(locationLooksApi("https://restaurant.example.com")).toBe(false);
    // "services" is an API_PATH token but NOT an API_HOST token.
    expect(locationLooksApi("https://services.example.com")).toBe(false);
    expect(locationLooksApi("https://apiary.example.com")).toBe(false);
  });

  it("lowercases the hostname before tokenizing", () => {
    expect(locationLooksApi("https://API.EXAMPLE.COM")).toBe(true);
    expect(locationLooksApi("https://GraphQL.Example.Com")).toBe(true);
  });

  it("a plain web host is NOT api", () => {
    expect(locationLooksApi("https://www.example.com")).toBe(false);
    expect(locationLooksApi("https://app.example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// locationLooksApi — first-path-segment shapes
// ---------------------------------------------------------------------------

describe("locationLooksApi — first pathname segment", () => {
  it.each([
    "https://example.com/api",
    "https://example.com/api/v1",
    "https://example.com/api/v1/users",
    "https://example.com/graphql",
    "https://example.com/graphiql",
    "https://example.com/rest/orders",
    "https://example.com/rpc",
    "https://example.com/webservice",
    "https://example.com/service",
    "https://example.com/services",
    "https://example.com/api/",
  ])("first segment is an api token → true: %s", (location) => {
    expect(locationLooksApi(location)).toBe(true);
  });

  it("bare /v\\d+/ version segments do NOT count", () => {
    expect(locationLooksApi("https://example.com/v2/users")).toBe(false);
    expect(locationLooksApi("https://example.com/v1")).toBe(false);
    expect(locationLooksApi("https://example.com/v10/graphql")).toBe(false);
  });

  it("an api token deeper than segment 1 does NOT count", () => {
    expect(locationLooksApi("https://example.com/docs/api")).toBe(false);
    expect(locationLooksApi("https://example.com/v1/api")).toBe(false);
    expect(locationLooksApi("https://example.com/a/b/graphql")).toBe(false);
  });

  it("root/empty paths and non-token first segments are NOT api", () => {
    expect(locationLooksApi("https://example.com")).toBe(false);
    expect(locationLooksApi("https://example.com/")).toBe(false);
    expect(locationLooksApi("https://example.com/users")).toBe(false);
    expect(locationLooksApi("https://example.com/apiary")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// locationLooksApi — parseability and scheme gates
// ---------------------------------------------------------------------------

describe("locationLooksApi — parseable http(s) only", () => {
  it("non-URL locations are NOT api — even api-shaped bare hostnames", () => {
    expect(locationLooksApi("api.example.com")).toBe(false);
    expect(locationLooksApi("api.example.com/v1")).toBe(false);
    expect(locationLooksApi("10.20.30.0/24")).toBe(false);
    expect(locationLooksApi("capitol Hill")).toBe(false);
    expect(locationLooksApi("")).toBe(false);
    expect(locationLooksApi("   ")).toBe(false);
    expect(locationLooksApi(null)).toBe(false);
  });

  it("non-http(s) schemes are NOT api — even api-shaped ones", () => {
    expect(locationLooksApi("mailto:api@example.com")).toBe(false);
    expect(locationLooksApi("ftp://api.example.com")).toBe(false);
    expect(locationLooksApi("ftp://example.com/api")).toBe(false);
  });

  it("http (not just https) parses for shape detection", () => {
    expect(locationLooksApi("http://api.example.com")).toBe(true);
    expect(locationLooksApi("http://example.com/api")).toBe(true);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(locationLooksApi("  https://api.example.com  ")).toBe(true);
    expect(locationLooksApi("  api.example.com  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyTarget — composition of tokens and URL shape
// ---------------------------------------------------------------------------

describe("classifyTarget — api composition", () => {
  it("api-shaped URL classifies api even with a generic category", () => {
    expect(
      classifyTarget(
        makeTarget({
          category: "other",
          location: "https://api.example.com/v1",
        }),
      ),
    ).toEqual({ api: true, web: false });
    expect(
      classifyTarget(
        makeTarget({ category: "other", location: "https://example.com/api" }),
      ),
    ).toEqual({ api: true, web: false });
    expect(
      classifyTarget(makeTarget({ location: "https://graphql.example.com" })),
    ).toEqual({ api: true, web: false });
  });

  it("an api-shaped URL suppresses the http(s) web fallback — api, not web", () => {
    // Pre-V1.4 this target was web via the fallback; now it is api.
    const surface = classifyTarget(
      makeTarget({ category: "other", location: "https://api.example.com" }),
    );
    expect(surface.api).toBe(true);
    expect(surface.web).toBe(false);
  });

  it("existing token behavior is unchanged: category/name/tags api tokens", () => {
    expect(classifyTarget(makeTarget({ category: "api" }))).toEqual({
      api: true,
      web: false,
    });
    expect(classifyTarget(makeTarget({ name: "GraphQL Endpoint" }))).toEqual({
      api: true,
      web: false,
    });
    expect(classifyTarget(makeTarget({ tags: ["grpc"] }))).toEqual({
      api: true,
      web: false,
    });
    // Token api wins even on a plain web URL — shape never subtracts.
    expect(
      classifyTarget(
        makeTarget({ category: "api", location: "https://www.example.com" }),
      ),
    ).toEqual({ api: true, web: false });
  });

  it("a web token + api-shaped URL counts toward BOTH surfaces", () => {
    expect(
      classifyTarget(
        makeTarget({
          category: "website",
          location: "https://api.example.com",
        }),
      ),
    ).toEqual({ api: true, web: true });
  });
});

describe("classifyTarget — web fallback and non-api shapes", () => {
  it("http(s) fallback still fires when neither class matched", () => {
    expect(
      classifyTarget(
        makeTarget({ category: "other", location: "https://x.example" }),
      ),
    ).toEqual({ api: false, web: true });
    expect(
      classifyTarget(
        makeTarget({ category: "other", location: "http://y.example" }),
      ),
    ).toEqual({ api: false, web: true });
  });

  it("non-api-shaped URLs still fall back to web", () => {
    // NOT api — but the http fallback still counts them as web.
    expect(
      classifyTarget(
        makeTarget({
          category: "other",
          location: "https://example.com/v2/users",
        }),
      ),
    ).toEqual({ api: false, web: true });
    expect(
      classifyTarget(
        makeTarget({
          category: "other",
          location: "https://example.com/docs/api",
        }),
      ),
    ).toEqual({ api: false, web: true });
  });

  it("unparseable/non-http(s) locations classify neither api nor web", () => {
    for (const location of [
      "api.example.com", // no scheme — pinned: not api, and no web fallback
      "bare.example.com",
      "mailto:api@example.com",
      "ftp://api.example.com",
      "10.20.30.0/24",
      "   ",
    ]) {
      expect(
        classifyTarget(makeTarget({ category: "other", location })),
        location,
      ).toEqual({ api: false, web: false });
    }
    expect(
      classifyTarget(makeTarget({ category: "other", location: null })),
    ).toEqual({ api: false, web: false });
  });

  it("web tokens unchanged; dual-token targets count toward both", () => {
    expect(classifyTarget(makeTarget({ category: "website" }))).toEqual({
      api: false,
      web: true,
    });
    expect(classifyTarget(makeTarget({ name: "web api" }))).toEqual({
      api: true,
      web: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Wiring — one classifier feeds features.ts AND diff.ts (no drift).
// ---------------------------------------------------------------------------

describe("shared classifier wiring — no api_surface/added_api_targets drift", () => {
  const apiShaped = makeTarget({
    id: "t-api-shape",
    category: "other", // generic category — ONLY the URL shape says api
    location: "https://api.example.com/v1",
  });

  it("extractProgramFeatures counts an api-shaped target in api_surface", () => {
    const v = extractProgramFeatures(
      snapshot(
        makeDetail({
          targets: [
            apiShaped,
            makeTarget({
              id: "t-web",
              category: "other",
              location: "https://www.example.com",
            }),
          ],
        }),
      ),
      NOW,
    );
    expect(v.api_surface.value).toBe(0.5); // 1/2 via shape alone
    expect(v.api_surface_size.value).toBeCloseTo(1 / 11, 4);
    expect(v.web_surface.value).toBe(0.5); // the www target via fallback
  });

  it("diffBriefDocuments counts an added api-shaped in-scope target identically", () => {
    const diff = diffBriefDocuments(
      makeDetail(),
      makeDetail({ targets: [apiShaped] }),
      { from_version: "v-prev", to_version: "v-curr" },
    );
    expect(diff.added_in_scope_targets).toBe(1);
    expect(diff.added_api_targets).toBe(1); // same classifyTarget as api_surface
    expect(diff.added_web_targets).toBe(0); // NOT double-counted as web
  });
});

// ---------------------------------------------------------------------------
// Helpers still exported and unchanged in contract.
// ---------------------------------------------------------------------------

describe("surface helpers — unchanged contracts", () => {
  it("tokenSet does not tokenize location (shape handles it instead)", () => {
    const tokens = tokenSet(
      makeTarget({ location: "https://api.example.com", name: "Portal" }),
    );
    expect(tokens.has("api")).toBe(false);
    expect(tokens.has("portal")).toBe(true);
  });

  it("isHttpUrl gates on parseable http/https only", () => {
    expect(isHttpUrl("https://a.example")).toBe(true);
    expect(isHttpUrl("http://a.example")).toBe(true);
    expect(isHttpUrl("ftp://a.example")).toBe(false);
    expect(isHttpUrl("bare.example.com")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});
