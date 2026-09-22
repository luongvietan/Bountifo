import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessibilitySignal } from "../lib/radar/accessibility";
import { authzOpportunitySignal } from "../lib/radar/authz";
import { briefTextFromDoc } from "../lib/radar/briefText";
import { mapBriefDocument } from "../lib/radar/detailMap";
import { extractProgramFeatures } from "../lib/radar/features";
import { radarSourceHash } from "../lib/radar/hash";
import { getRadarProfile, RADAR_PROFILES } from "../lib/radar/profiles";
import { explainScore, scoreProgram } from "../lib/radar/scoring";
import { classifyTarget, locationLooksApi } from "../lib/radar/surface";
import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../lib/types";
import type { CatalogScanResult } from "../lib/radar/catalog";
import type { RadarCoordinatorDeps } from "../lib/radar/coordinator";
import {
  programFeatureVectorSchema,
  RADAR_FEATURE_KEYS,
} from "../lib/radar/types";
import type {
  RadarCatalogItem,
  RadarProgramSnapshot,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Agent E — Radar V1.4 adversarial probes against the MERGED code.
//
// Scope: the two newly-sourced signals (lib/radar/accessibility.ts,
// lib/radar/authz.ts), the URL-shape surface classifier
// (lib/radar/surface.ts `locationLooksApi`), the brief-facts plumbing
// (detailMap/briefText/hash), and their consumption by scoreProgram under
// the bumped 1.4.0 profiles (easy_entry, authz_api). Pure extract/score
// level plus one coordinator pass for the results-table columns.
//
// CONVENTION: every assertion pins the merged code's ACTUAL behavior.
// Where a probe lands on a surprising-but-defensible reading it is pinned
// with a comment marking it as observed behavior (not necessarily ideal).
// ---------------------------------------------------------------------------

const NOW = "2026-09-21T00:00:00.000Z";

// -- fixtures ---------------------------------------------------------------

function detail(overrides: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "uuid-1",
    name: "Acme",
    code: "acme",
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
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
    ...overrides,
  };
}

function catalog(
  overrides: Partial<RadarCatalogItem> = {},
): RadarCatalogItem {
  return {
    uuid: "uuid-1",
    code: "acme",
    name: "Acme",
    lifecycle_status: null,
    engagement_type: "bug_bounty",
    discovered_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  detailValue: ApiEngagementData | null,
  catalogValue: RadarCatalogItem = catalog(),
): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: "uuid-1",
    code: "acme",
    catalog: catalogValue,
    detail: detailValue,
    enrichment:
      detailValue === null
        ? { status: "failed", error_kind: "http" }
        : { status: "complete" },
    source_hash: `sha256:${"0".repeat(64)}`,
  };
}

function target(overrides: Partial<ApiTarget> = {}): ApiTarget {
  return {
    id: "t1",
    groupId: null,
    location: null,
    name: null,
    category: null,
    tags: [],
    inScope: true,
    ...overrides,
  };
}

function group(overrides: Partial<ApiTargetGroup> = {}): ApiTargetGroup {
  return {
    id: "g1",
    name: "G",
    inScope: true,
    description: null,
    rewards: { p1: null, p2: null, p3: null, p4: null, p5: null },
    ...overrides,
  };
}

/** Fully-populated detail: open posture + credentials + signup marker +
 *  an authz grant + 12 api-shaped targets + rewards + fresh brief. */
function richDetail(): ApiEngagementData {
  return detail({
    participation: "open",
    credentialsProvided: true,
    briefText:
      "Create an account to begin. You may test across accounts that you own.",
    safeHarborLevel: "full",
    lastBriefUpdate: "2026-09-20T00:00:00.000Z",
    lastStatusTransition: "2020-01-01T00:00:00.000Z",
    targetGroups: [
      group({
        rewards: {
          p1: 5000,
          p2: 2000,
          p3: null,
          p4: null,
          p5: null,
        },
      }),
    ],
    // api-i.example.com — "api" host token via URL SHAPE only (category is
    // the generic "other"), so the V1.4 classifier is what classifies them.
    targets: Array.from({ length: 12 }, (_, i) =>
      target({
        id: `t-api-${i}`,
        location: `https://api-${i}.example.com`,
        category: "other",
      }),
    ),
  });
}

// ---------------------------------------------------------------------------
// detail === null — the new signals stay honestly null, never catalog-inferred
// ---------------------------------------------------------------------------

describe("detail===null — V1.4 signals are never catalog-inferred", () => {
  it.each(["open", "invite-only", "live", null] as const)(
    "catalog.lifecycle_status %j cannot leak into accessibility/authz_opportunity",
    (lifecycle_status) => {
      const v = extractProgramFeatures(
        snapshot(null, catalog({ lifecycle_status })),
        NOW,
      );
      for (const key of RADAR_FEATURE_KEYS) {
        expect(v[key].value).toBeNull();
      }
      // PINNED (observed): the null-detail short-circuit emits the stub-era
      // "not_available_v1" label for these two keys — not "detail_unavailable"
      // like their detail-derived peers, and NOT the new no_*_evidence codes
      // (the sourced functions are never reached). Same pinned contract as
      // radar-features.test.ts. The VALUE is the honest part: null either way.
      for (const key of ["accessibility", "authz_opportunity"] as const) {
        expect(v[key]).toEqual({
          value: null,
          source: "derived",
          reason_code: "not_available_v1",
        });
      }
      expect(programFeatureVectorSchema.safeParse(v).success).toBe(true);
    },
  );

  it("a null-detail snapshot still scores under the bumped profiles — all unknown", () => {
    const snap = snapshot(null, catalog({ lifecycle_status: "open" }));
    const v = extractProgramFeatures(snap, NOW);
    const score = scoreProgram(snap, v, getRadarProfile("easy_entry"));
    expect(score.score).toBeNull();
    expect(score.confidence).toBe(0);
    expect(score.provisional).toBe(true);
    expect(score.reasons).toContain("UNKNOWN_ACCESSIBILITY");
    expect(score.scoring_version).toBe("1.5.0");
  });
});

// ---------------------------------------------------------------------------
// briefText absent — a brief doc with no description/targetsOverview must
// degrade to the no_*_evidence nulls without crashing.
// ---------------------------------------------------------------------------

describe("briefText absent — honest no-evidence degradation", () => {
  it("all three V1.4 fields null + null catalog → both honest nulls", () => {
    const v = extractProgramFeatures(snapshot(detail()), NOW);
    expect(v.accessibility).toEqual({
      value: null,
      source: "engagement_detail",
      reason_code: "no_access_evidence",
    });
    expect(v.authz_opportunity).toEqual({
      value: null,
      source: "engagement_detail",
      reason_code: "no_authz_evidence",
    });
  });

  it("briefText null does not null a stated participation posture", () => {
    // The base band reads participation/lifecycle — briefText only feeds
    // modifiers, so its absence is neutral, not a downgrade.
    const v = extractProgramFeatures(
      snapshot(detail({ participation: "open", briefText: null }), catalog()),
      NOW,
    );
    expect(v.accessibility.value).toBe(0.8); // base band only, no modifiers
    expect(v.accessibility.reason_code).toBe("participation_access_rubric");
  });

  it("credentialsProvided true + briefText null → authz 0.675 (surface-only)", () => {
    const v = extractProgramFeatures(
      snapshot(detail({ credentialsProvided: true, briefText: null })),
      NOW,
    );
    // 0.5*1 + 0.5*0.35 — the permission half sits at the pinned midpoint.
    expect(v.authz_opportunity.value).toBe(0.675);
    expect(v.authz_opportunity.reason_code).toBe("authz_surface_rubric");
  });

  it("a real doc without brief.description/targetsOverview flows through cleanly", () => {
    // mapBriefDocument → extractProgramFeatures: the whole pipeline, no crash.
    const doc = {
      id: "v1",
      statusLabel: "Live",
      engagementTypeDetail: { productLabel: "Bug Bounty" },
      data: {
        engagement: { code: "x", startsAt: "2026-01-01T00:00:00Z" },
        brief: { name: "X" }, // NO description, NO targetsOverview
        engagementConfiguration: { participation: "open" },
        scope: [{ id: "g1", name: "S", inScope: true, targets: [] }],
      },
    };
    const mapped = mapBriefDocument("x", doc, null);
    expect(mapped.briefText).toBeNull();
    expect(mapped.participation).toBe("open");
    expect(mapped.credentialsProvided).toBeNull();
    const v = extractProgramFeatures(snapshot(mapped), NOW);
    expect(v.accessibility.value).toBe(0.8); // posture carries it alone
    expect(v.authz_opportunity).toEqual({
      value: null,
      source: "engagement_detail",
      reason_code: "no_authz_evidence",
    });
  });

  it("briefTextFromDoc strips tags/decodes entities — signup survives HTML", () => {
    expect(
      briefTextFromDoc({
        data: {
          brief: { description: "<p>Sign&nbsp;up <b>now</b> &amp; hack.</p>" },
        },
      }),
    ).toBe("Sign up now & hack.");
    // Non-string/absent both-sources → null, never a fabricated "".
    expect(briefTextFromDoc({ data: { brief: {} } })).toBeNull();
    expect(briefTextFromDoc({ data: {} })).toBeNull();
    expect(briefTextFromDoc(null)).toBeNull();
    expect(
      briefTextFromDoc({
        data: { brief: { description: 42, targetsOverview: null } },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// participation strings — the pinned ?? fallback semantics and band edges.
// ---------------------------------------------------------------------------

describe("participation posture — adversarial strings", () => {
  const rubric = (d: Partial<ApiEngagementData>, c: Partial<RadarCatalogItem>) =>
    accessibilitySignal(detail(d), catalog(c));

  it("arbitrary non-empty postures read the honest 0.5 midpoint", () => {
    for (const participation of [
      "vdp",
      "bug_bounty",
      "live",
      "public",
      "by-invitation", // hyphenated: contains "invitation" not "invite"
      "invitation only", // GATED_RE has "invite", NOT "invitation" — pinned gap
    ]) {
      // OBSERVED: "invitation only" does NOT match the gated family —
      // /invite/ is not a substring of "invitation". An invitation-gated
      // program reads the unclassified midpoint 0.5, not 0.2. Pinned as the
      // rubric's honest output (the regex family is a frozen contract).
      expect(rubric({ participation }, {}).value, participation).toBe(0.5);
      expect(rubric({ participation }, {}).reason_code).toBe(
        "participation_access_rubric",
      );
    }
  });

  it.each([
    ["open", 0.8],
    ["invite-only", 0.2],
    ["application required", 0.2],
    ["closed", 0.2],
  ])(
    "participation %j reads base %s even with a hostile catalog row",
    (participation, base) => {
      // detail.participation wins outright — the catalog never moderates a
      // stated posture.
      expect(
        rubric({ participation }, { lifecycle_status: "open" }).value,
      ).toBe(base);
      expect(
        rubric({ participation }, { lifecycle_status: "private" }).value,
      ).toBe(base);
    },
  );

  it("empty-string participation SUPPRESSES the catalog fallback (pinned ?? semantics)", () => {
    // "" ?? "open" is "" — the ?? chain only falls through on null/undefined.
    // A blank stated field thus nulls the signal even when the catalog row
    // carries a classifiable accessStatus.
    expect(
      rubric({ participation: "" }, { lifecycle_status: "open" }),
    ).toEqual({
      value: null,
      source: "engagement_detail",
      reason_code: "no_access_evidence",
    });
    expect(
      rubric({ participation: "" }, { lifecycle_status: "invite" }).value,
    ).toBeNull();
    // null behaves differently: the fallback fires.
    expect(
      rubric({ participation: null }, { lifecycle_status: "open" }).value,
    ).toBe(0.8);
  });

  it("whitespace-only participation is a stated value, not empty (no trim pinned)", () => {
    expect(rubric({ participation: " " }, {}).value).toBe(0.5);
  });

  it("the real mapper can never emit the suppressing empty string", () => {
    // detailMap.asString normalizes ""→null BEFORE the signal sees it, so at
    // the pipeline level "" does NOT suppress the root participation field —
    // the two layers disagree on "" by design; both are pinned.
    const mapped = mapBriefDocument(
      "x",
      {
        participation: "invite", // root fallback
        data: {
          engagement: { code: "x" },
          brief: {},
          engagementConfiguration: { participation: "" }, // → null upstream
          scope: [],
        },
      },
      null,
    );
    expect(mapped.participation).toBe("invite");
  });
});

// ---------------------------------------------------------------------------
// authz_opportunity — polarity wars and the submission-frame veto.
// ---------------------------------------------------------------------------

describe("authz_opportunity — mixed polarity and submission frames", () => {
  const authz = (d: Partial<ApiEngagementData>) =>
    authzOpportunitySignal(detail(d));

  it("mixed-polarity brief: permitted multi-account + prohibited other-customer-data → 0.1", () => {
    const s = authz({
      credentialsProvided: true,
      briefText:
        "You may test using multiple accounts. Do not access other customers' data.",
    });
    // Most conservative status wins across sentences: prohibited → flat 0.1
    // even though a grant sentence AND proven account surface exist.
    expect(s).toEqual({
      value: 0.1,
      source: "engagement_detail",
      reason_code: "authz_surface_rubric",
    });
  });

  it.each([
    "IDOR reports will be closed as not applicable.",
    "Reports of access to other customers' data will be closed as not applicable.",
    "Cross-account submissions are not permitted.",
    "Reports about other customers' data are out of scope.",
    "IDOR and other customer data findings will be marked as out of scope.",
  ])("submission-framed exclusion does not read as testing prohibition: %j", (briefText) => {
    // The statusOfSentence veto: a refusal of REPORTS/scope says nothing about
    // what may be TESTED — these read as no authz-policy evidence at all.
    expect(authz({ briefText })).toEqual({
      value: null,
      source: "engagement_detail",
      reason_code: "no_authz_evidence",
    });
    // And they don't drag down a proven account surface either — the mention
    // contributes nothing, so the reading stays the surface-only 0.675.
    expect(authz({ briefText, credentialsProvided: true }).value).toBe(0.675);
  });

  it("OBSERVED: 'Reports of cross-account access are not permitted' reads 0.1", () => {
    // The submission-frame veto is bypassed here: "access are not permitted"
    // matches the activity-directive exception (an activity noun directly
    // before the negated permission), so statusOfSentence → "prohibited".
    // Conservative direction — a pessimistic 0.1, never a fabricated grant —
    // pinned as the merged code's honest output.
    const s = authz({
      briefText: "Reports of cross-account access are not permitted.",
    });
    expect(s.value).toBe(0.1);
    expect(s.reason_code).toBe("authz_surface_rubric");
  });

  it("enforcement consequences count as prohibition: 'may result in a ban' → 0.1", () => {
    expect(
      authz({ briefText: "Cross-tenant testing may result in a ban." }).value,
    ).toBe(0.1);
    expect(
      authz({ briefText: "Multi-account testing will lead to account closure." })
        .value,
    ).toBe(0.1);
  });

  it("an authz grant beside real surface evidence saturates to 1.0", () => {
    expect(
      authz({
        credentialsProvided: true,
        briefText: "You may test across accounts that you own.",
      }).value,
    ).toBe(1);
    // Without the surface half the same grant reads 0.5 — permission alone
    // cannot fake the account surface.
    expect(
      authz({ briefText: "You may test across accounts that you own." }).value,
    ).toBe(0.5);
  });

  it("a restrictive grant reads conditional: 'only test accounts you own' → 0.25", () => {
    expect(
      authz({ briefText: "You may only test accounts that you own." }).value,
    ).toBe(0.25); // permScore 0.5, surface 0
  });

  it("no crash on hostile briefText shapes", () => {
    for (const briefText of ["", "   ", "\n\n", ".", ";;;"]) {
      expect(authz({ briefText }).reason_code).toBe("no_authz_evidence");
    }
  });
});

// ---------------------------------------------------------------------------
// Surface classifier — adversarial locations.
// ---------------------------------------------------------------------------

describe("locationLooksApi — adversarial URL shapes", () => {
  it.each([
    // OBSERVED: host-token membership is not suffix-aware — an "api" token
    // ANYWHERE in the dotted hostname classifies, including lookalike and
    // attacker-shaped domains. Pinned token semantics, same rule that admits
    // "internal-api.acme.example.com".
    ["https://api.example.com.evil.com", true],
    ["https://example.com@api.evil.com", true], // real host IS api.evil.com
    ["https://api.localhost", true],
    ["https://API.EXAMPLE.COM", true], // hostname is lowercased
    ["HTTPS://API.EXAMPLE.COM", true], // scheme + host both normalized
    ["https://api.example.com   ", true], // trimmed
    ["   https://api.example.com", true],
    ["https://example.com./api", true], // trailing-dot host + api first segment
    ["https://example.com:8443/api", true], // port doesn't matter
    ["https://example.com/api?x=1", true],
    ["https://example.com//api", true], // first NON-EMPTY segment is "api"
    ["https://example.com/api", true],
    ["https://example.com/x/api", false], // api deeper than segment 1
    ["https://example.com/#/api", false], // fragment is not a path segment
    ["https://example.com/%61pi", true], // V1.5: percent-decoded → "api"
    ["https://EXAMPLE.COM/API", true], // V1.5: pathname segment lowercased
    ["https://api2.example.com", false], // exact token only
    ["https://2api.example.com", false],
    ["https://api@example.com", false], // "api" is userinfo, not hostname
    ["https://api:key@example.com", false],
    ["//api.example.com", false], // protocol-relative — new URL throws
    ["//example.com/api", false],
    ["api.example.com", false], // no scheme — pinned: shape needs a real URL
  ])("locationLooksApi(%j) → %s", (location, expected) => {
    expect(locationLooksApi(location)).toBe(expected);
  });

  it("classifyTarget: userinfo 'api' cannot fake api — but the URL still counts as web", () => {
    expect(
      classifyTarget(
        target({ category: "other", location: "https://api@example.com" }),
      ),
    ).toEqual({ api: false, web: true });
    // A protocol-relative api host is neither api (unparseable) nor web
    // (no http(s) fallback without a parseable URL).
    expect(
      classifyTarget(
        target({ category: "other", location: "//api.example.com" }),
      ),
    ).toEqual({ api: false, web: false });
  });

  it("an api-suffix-lookalike host classifies api via tokens — and suppresses web fallback", () => {
    // Same verdict whether the host is real or evil-shaped: "api" is a host
    // token either way; web only fires when NEITHER class matched.
    expect(
      classifyTarget(
        target({
          category: "other",
          location: "https://api.example.com.evil.com",
        }),
      ),
    ).toEqual({ api: true, web: false });
  });
});

// ---------------------------------------------------------------------------
// End-to-end — extractProgramFeatures + scoreProgram under the 1.4.0 profiles.
// ---------------------------------------------------------------------------

describe("end-to-end — sourced signals through extract and score", () => {
  it("a fully-populated detail produces both V1.4 signals valued", () => {
    const v = extractProgramFeatures(
      snapshot(richDetail(), catalog({ lifecycle_status: "open" })),
      NOW,
    );
    expect(v.accessibility).toEqual({
      value: 1, // 0.8 + 0.1 signup + 0.1 credentials, clamped
      source: "engagement_detail",
      reason_code: "participation_access_rubric",
    });
    expect(v.authz_opportunity).toEqual({
      value: 1, // 0.5·surface 1 + 0.5·permScore 1
      source: "engagement_detail",
      reason_code: "authz_surface_rubric",
    });
    // URL shape alone classified every target api — no token categories used.
    expect(v.api_surface.value).toBe(1);
    expect(v.api_surface_size.value).toBe(0.5455); // 12/(12+10)
    expect(programFeatureVectorSchema.safeParse(v).success).toBe(true);
  });

  it("easy_entry can now score non-provisional with full coverage", () => {
    const snap = snapshot(richDetail(), catalog({ lifecycle_status: "open" }));
    const v = extractProgramFeatures(snap, NOW);
    const profile = getRadarProfile("easy_entry");
    const score = scoreProgram(snap, v, profile);
    expect(score.scoring_version).toBe("1.5.0");
    expect(score.provisional).toBe(false); // accessibility known → required met
    // V1.5: payout_realized is a seventh weight (0.5) still honestly null —
    // coverage 8/8.5. The score denominator only counts known weights, so
    // 86.6 is unchanged.
    expect(score.confidence).toBe(0.9412);
    expect(score.score).toBe(86.6);
    expect(score.reasons).toEqual([
      "ACCESS_OPEN",
      "RECENTLY_UPDATED",
      "REWARD_BROAD",
      "SAFE_HARBOR_PRESENT",
      "REWARD_MEDIUM",
      "UNKNOWN_PAYOUT_REALIZED",
    ]);
    expect(score.reasons).not.toContain("UNKNOWN_ACCESSIBILITY");
    expect(score.components.accessibility).toEqual({
      signal: 1,
      weight: 2,
      direction: "benefit",
      contribution: 2,
    });
    expect(explainScore(score)).toContain("+ open access program");
  });

  it("easy_entry stays provisional when accessibility is honestly unknown", () => {
    // participation null + catalog lifecycle null → no_access_evidence.
    // Every OTHER easy_entry signal is known except the still-stubbed
    // payout_realized, so the cap is 6/8.5 = 0.7059.
    const snap = snapshot(
      detail({
        safeHarborLevel: "full",
        lastBriefUpdate: "2026-09-20T00:00:00.000Z",
        targetGroups: [
          group({
            rewards: { p1: 5000, p2: null, p3: null, p4: null, p5: null },
          }),
        ],
        targets: [target({ location: "https://app.example.com" })],
      }),
      catalog(),
    );
    const v = extractProgramFeatures(snap, NOW);
    expect(v.accessibility.value).toBeNull();
    const score = scoreProgram(snap, v, getRadarProfile("easy_entry"));
    expect(score.provisional).toBe(true);
    expect(score.reasons).toContain("UNKNOWN_ACCESSIBILITY");
    expect(score.confidence).toBe(0.7059);
  });

  it("a gated catalog row alone can de-provisional easy_entry — the fallback is real", () => {
    // PINNED: catalog.lifecycle_status is a declared fallback source, so a
    // program with no stated participation still reads a value (0.2 gated)
    // and leaves provisional — a LOW known value, not an unknown.
    const snap = snapshot(
      detail({ safeHarborLevel: "full", lastBriefUpdate: "2026-09-20T00:00:00.000Z" }),
      catalog({ lifecycle_status: "invite" }),
    );
    const v = extractProgramFeatures(snap, NOW);
    expect(v.accessibility.value).toBe(0.2);
    const score = scoreProgram(snap, v, getRadarProfile("easy_entry"));
    expect(score.provisional).toBe(false);
    expect(score.reasons).toContain("ACCESS_GATED");
    expect(explainScore(score)).toContain("- restricted or gated access");
  });

  it("authz_api consumes authz_opportunity in components and declared-order reasons", () => {
    const snap = snapshot(richDetail(), catalog({ lifecycle_status: "open" }));
    const v = extractProgramFeatures(snap, NOW);
    const profile = getRadarProfile("authz_api");
    const score = scoreProgram(snap, v, profile);
    expect(score.scoring_version).toBe("1.5.0");
    // Weight 2 sits directly after api_surface_size — declared order is
    // component order AND reason order. V1.5 appends scope_momentum +
    // payout_realized at the end.
    expect(Object.keys(score.components)).toEqual([
      "api_surface",
      "api_surface_size",
      "authz_opportunity",
      "meaningful_surface",
      "reward_potential",
      "freshness",
      "opportunity_change",
      "safe_harbor",
      "research_saturation",
      "scope_momentum",
      "payout_realized",
    ]);
    expect(score.components.authz_opportunity).toEqual({
      signal: 1,
      weight: 2,
      direction: "benefit",
      contribution: 2,
    });
    // Threshold codes precede unknowns; AUTHZ_SURFACE lands in declared order
    // right behind the two api-surface codes.
    expect(score.reasons).toEqual([
      "API_SURFACE_HIGH",
      "API_SURFACE_LARGE",
      "AUTHZ_SURFACE",
      "REWARD_MEDIUM",
      "RECENTLY_UPDATED",
      "SAFE_HARBOR_PRESENT",
      "UNKNOWN_OPPORTUNITY_CHANGE",
      "UNKNOWN_RESEARCH_SATURATION",
      "UNKNOWN_SCOPE_MOMENTUM",
      "UNKNOWN_PAYOUT_REALIZED",
    ]);
    expect(score.reasons).not.toContain("UNKNOWN_AUTHZ_OPPORTUNITY");
    // Σw 13.5; known weight 11.0 (opportunity_change + research_saturation
    // + V1.5 stubbed scope_momentum + payout_realized unknown) → 11/13.5.
    expect(score.confidence).toBe(0.8148);
    expect(score.score).toBe(73);
    expect(explainScore(score)).toContain(
      "+ authenticated authz test surface",
    );
  });

  it("authz_api reads a prohibited brief as a caution, not a missing signal", () => {
    const snap = snapshot(
      detail({
        ...richDetail(),
        briefText: "Cross-account testing is prohibited.",
      }),
      catalog({ lifecycle_status: "open" }),
    );
    const v = extractProgramFeatures(snap, NOW);
    expect(v.authz_opportunity.value).toBe(0.1);
    const score = scoreProgram(snap, v, getRadarProfile("authz_api"));
    expect(score.reasons).toContain("AUTHZ_PROHIBITED");
    expect(score.reasons).not.toContain("UNKNOWN_AUTHZ_OPPORTUNITY");
    expect(explainScore(score)).toContain(
      "- cross-account testing prohibited",
    );
    expect(score.components.authz_opportunity?.contribution).toBe(0.2);
  });

  it("authz_api emits UNKNOWN_AUTHZ_OPPORTUNITY when the signal is honestly null", () => {
    const snap = snapshot(
      detail({
        targets: [target({ category: "api", location: "https://a" })],
        targetGroups: [group()],
      }),
      catalog(),
    );
    const v = extractProgramFeatures(snap, NOW);
    const score = scoreProgram(snap, v, getRadarProfile("authz_api"));
    expect(score.reasons).toContain("UNKNOWN_AUTHZ_OPPORTUNITY");
    expect(score.components.authz_opportunity?.contribution).toBeNull();
  });

  it("profile versions and weight sums pin the V1.5 contract", () => {
    const sum = (id: keyof typeof RADAR_PROFILES): number =>
      Object.values(RADAR_PROFILES[id].weights).reduce<number>(
        (acc: number, w) =>
          acc + (typeof w === "number" ? w : (w?.weight ?? 0)),
        0,
      );
    // V1.5: every profile gained a weighted signal → all bump to 1.5.0.
    expect(RADAR_PROFILES.authz_api.version).toBe("1.5.0");
    expect(RADAR_PROFILES.easy_entry.version).toBe("1.5.0");
    expect(sum("authz_api")).toBeCloseTo(13.5, 10); // 12.25 + 0.75 + 0.5
    expect(sum("easy_entry")).toBeCloseTo(8.5, 10);
    expect(RADAR_PROFILES.best_ev.version).toBe("1.5.0");
    expect(sum("best_ev")).toBeCloseTo(17.25, 10); // 14.25 + 3
    expect(RADAR_PROFILES.low_competition.version).toBe("1.5.0");
    expect(sum("low_competition")).toBeCloseTo(13, 10); // 10.5 + 2.5
    expect(RADAR_PROFILES.fresh_programs.version).toBe("1.5.0");
    expect(sum("fresh_programs")).toBeCloseTo(9.5, 10);
    expect(RADAR_PROFILES.high_reward.version).toBe("1.5.0");
    expect(sum("high_reward")).toBeCloseTo(11, 10);
  });
});

// ---------------------------------------------------------------------------
// Determinism + hash — same input must always produce the identical output.
// ---------------------------------------------------------------------------

describe("determinism and source-hash coverage", () => {
  it("extractProgramFeatures is a pure function of the snapshot", () => {
    const snap = snapshot(richDetail(), catalog({ lifecycle_status: "open" }));
    const a = extractProgramFeatures(snap, NOW);
    const b = extractProgramFeatures(snap, NOW);
    expect(a).toEqual(b);
    const s1 = scoreProgram(snap, a, getRadarProfile("authz_api"));
    const s2 = scoreProgram(snap, b, getRadarProfile("authz_api"));
    expect(s1).toEqual(s2);
  });

  it("signal rubrics are repeat-stable (no regex lastIndex drift)", () => {
    const d = detail({
      participation: "open",
      credentialsProvided: true,
      briefText:
        "Sign up now. Cross-account testing is allowed only with prior approval. VPN required.",
    });
    const c = catalog({ lifecycle_status: "invite" });
    for (let i = 0; i < 3; i++) {
      expect(accessibilitySignal(d, c)).toEqual({
        value: 0.8, // 0.8 open + 0.1 signup + 0.1 credentials − 0.2 VPN
        source: "engagement_detail",
        reason_code: "participation_access_rubric",
      });
      expect(authzOpportunitySignal(d)).toEqual({
        value: 0.75, // surface 1 + conditional 0.5
        source: "engagement_detail",
        reason_code: "authz_surface_rubric",
      });
    }
  });

  it("locationLooksApi is repeat-stable across the same input", () => {
    for (let i = 0; i < 3; i++) {
      expect(locationLooksApi("https://api.example.com")).toBe(true);
      expect(locationLooksApi("https://example.com/x/api")).toBe(false);
    }
  });

  it("the V1.4 brief facts are scoring inputs — each one moves source_hash", async () => {
    const base = richDetail();
    const h0 = await radarSourceHash({ catalog: catalog(), detail: base });
    const hParticipation = await radarSourceHash({
      catalog: catalog(),
      detail: { ...base, participation: "invite" },
    });
    const hCredentials = await radarSourceHash({
      catalog: catalog(),
      detail: { ...base, credentialsProvided: false },
    });
    const hBrief = await radarSourceHash({
      catalog: catalog(),
      detail: { ...base, briefText: "Different brief text." },
    });
    for (const h of [hParticipation, hCredentials, hBrief]) {
      expect(h).not.toBe(h0);
    }
    // Identical input → identical hash.
    expect(
      await radarSourceHash({ catalog: catalog(), detail: richDetail() }),
    ).toBe(h0);
  });
});

// ---------------------------------------------------------------------------
// Results-table plumbing — the Access/AuthZ columns are populated from the
// embedded vector by getResults (coordinator-level, one scan).
// ---------------------------------------------------------------------------

describe("results-table plumbing — Access/AuthZ columns", () => {
  type CoordinatorModule = typeof import("../lib/radar/coordinator");
  type StoreModule = typeof import("../lib/radar/store");
  let coordinator: CoordinatorModule;
  let store: StoreModule;
  let seq = 0;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    store = await import("../lib/radar/store");
    coordinator = await import("../lib/radar/coordinator");
  });

  function item(uuid: string): RadarCatalogItem {
    return {
      uuid,
      code: `c-${uuid}`,
      name: `Program ${uuid}`,
      lifecycle_status: "open",
      engagement_type: "bug_bounty",
      discovered_at: NOW,
    };
  }

  it("getResults rows carry real accessibility/authz_opportunity values", async () => {
    const items = [item("rich"), item("bare")];
    const details = new Map<string, ApiEngagementData>([
      ["rich", richDetail()],
      ["bare", detail()],
    ]);
    const deps: RadarCoordinatorDeps = {
      enumerate: async (): Promise<CatalogScanResult> => ({
        status: "complete",
        items,
        pages_fetched: 1,
        warnings: [],
      }),
      // Snapshots persist under snapshot.uuid — it must be the item's uuid
      // or the scoring phase reads a missing_snapshot.
      hydrate: async (it: RadarCatalogItem) => ({
        ...snapshot(details.get(it.uuid)!, it),
        uuid: it.uuid,
        code: it.code,
        source_hash: `sha256:${String(++seq).padStart(64, "0")}`,
      }),
      // no deepHydrate — metadata stage only; authz_api stays metadata-ranked.
      openStore: store.openRadarStore,
      now: () => NOW,
      concurrency: 2,
      newRunId: () => `run-v14-adv-${++seq}`,
    };
    const coord = new coordinator.RadarCoordinator(deps);
    const run = await coord.start();
    await coord.waitForIdle();
    expect(run.phase).toBe("done");

    const easy = await coord.getResults("easy_entry", 50);
    const rich = easy.find((r) => r.uuid === "rich")!;
    const bare = easy.find((r) => r.uuid === "bare")!;
    expect(rich.signals.accessibility).toBe(1);
    expect(rich.provisional).toBe(false);
    // "bare" has no stated posture but the catalog row is "open" → the
    // declared fallback still produces a value (never the old always-null).
    expect(bare.signals.accessibility).toBe(0.8);

    const authzRows = await coord.getResults("authz_api", 50);
    expect(
      authzRows.find((r) => r.uuid === "rich")!.signals.authz_opportunity,
    ).toBe(1);
    expect(
      authzRows.find((r) => r.uuid === "bare")!.signals.authz_opportunity,
    ).toBeNull(); // no_authz_evidence → honest null column, never 0
  });
});
