import { describe, expect, it } from "vitest";
import { authzOpportunitySignal } from "../lib/radar/authz";
import { extractProgramFeatures } from "../lib/radar/features";
import { radarSignalSchema } from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";
import type { RadarProgramSnapshot } from "../lib/radar/types";

// ---------------------------------------------------------------------------
// V1.4 `authz_opportunity` — pinned rubric:
//
//   accountSurface = 1 iff credentialsProvided === true OR a signup marker in
//     briefText; else 0.
//   permScore = most conservative statusOfSentence over sentences naming an
//     authz technique (multi-account / cross-account-testing /
//     other-customer-data / cross-tenant): prohibited→0, conditional→0.5,
//     allowed→1, no normative predicate→not counted.
//   accountSurface===0 && permScore===null → null ("no_authz_evidence").
//   permScore===0 → flat 0.1 (prohibition is a low reading, not "no
//     opportunity").
//   else round4(clamp01(0.5·accountSurface + 0.5·(permScore ?? 0.35))).
//
// All values are pinned to the formula verbatim — the rubric is a contract.
// ---------------------------------------------------------------------------

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

describe("authz_opportunity — prohibition paths", () => {
  it("an explicit cross-account prohibition reads a flat 0.1", () => {
    const s = authzOpportunitySignal(
      detail({ briefText: "Cross-account testing is prohibited." }),
    );
    expect(s).toEqual({
      value: 0.1,
      source: "engagement_detail",
      reason_code: "authz_surface_rubric",
    });
  });

  it("stays flat 0.1 even when the account surface is proven", () => {
    // Prohibition is a LOW reading, not surface-ignorance: credentials +
    // ban must not blend upward.
    const s = authzOpportunitySignal(
      detail({
        credentialsProvided: true,
        briefText: "Cross-account testing is prohibited.",
      }),
    );
    expect(s.value).toBe(0.1);
  });

  it.each([
    "Account sharing is prohibited.", // multi-account
    "Cross-account testing is prohibited.", // cross-account-testing
    "Do not access other customers' data.", // other-customer-data
    "Cross-tenant testing is not permitted.", // cross-tenant
  ])("prohibits via slug coverage: %j", (briefText) => {
    expect(authzOpportunitySignal(detail({ briefText })).value).toBe(0.1);
  });

  it("prohibited beats allowed across sentences (most conservative wins)", () => {
    const s = authzOpportunitySignal(
      detail({
        credentialsProvided: true,
        briefText:
          "You may test across accounts that you own. Cross-tenant access is prohibited.",
      }),
    );
    expect(s.value).toBe(0.1);
  });
});

describe("authz_opportunity — permission paths", () => {
  it("an explicit grant reads permScore 1 → 0.5 without surface evidence", () => {
    const s = authzOpportunitySignal(
      detail({ briefText: "You may test across accounts that you own." }),
    );
    expect(s).toEqual({
      value: 0.5, // 0.5*0 + 0.5*1
      source: "engagement_detail",
      reason_code: "authz_surface_rubric",
    });
  });

  it("grant + proven surface saturates to 1", () => {
    const s = authzOpportunitySignal(
      detail({
        credentialsProvided: true,
        briefText: "You may test across accounts that you own.",
      }),
    );
    expect(s.value).toBe(1); // 0.5*1 + 0.5*1
  });

  it("a conditional status reads permScore 0.5 → 0.25 / 0.75", () => {
    const bare = authzOpportunitySignal(
      detail({
        briefText:
          "Cross-account testing is allowed only with prior written approval.",
      }),
    );
    expect(bare.value).toBe(0.25); // 0.5*0 + 0.5*0.5
    const withSurface = authzOpportunitySignal(
      detail({
        credentialsProvided: true,
        briefText:
          "Cross-account testing is allowed only with prior written approval.",
      }),
    );
    expect(withSurface.value).toBe(0.75); // 0.5*1 + 0.5*0.5
  });

  it("conditional beats allowed across sentences", () => {
    const s = authzOpportunitySignal(
      detail({
        briefText:
          "You may test across accounts that you own. Cross-tenant testing is allowed only with prior approval.",
      }),
    );
    expect(s.value).toBe(0.25); // permScore 0.5, surface 0
  });
});

describe("authz_opportunity — account surface without policy evidence", () => {
  it("credentialsProvided alone reads 0.675 (permission half at 0.35)", () => {
    const s = authzOpportunitySignal(
      detail({ credentialsProvided: true, briefText: null }),
    );
    expect(s).toEqual({
      value: 0.675, // 0.5*1 + 0.5*0.35
      source: "engagement_detail",
      reason_code: "authz_surface_rubric",
    });
  });

  it.each([
    "Sign up at @bugcrowdninja to get started.",
    "You can sign up for an account and begin testing.",
    "Self-serve onboarding is available.",
    "Create your own account to begin.",
    "Register an account before testing.",
  ])("a signup marker alone reads 0.675: %j", (briefText) => {
    const s = authzOpportunitySignal(detail({ briefText }));
    expect(s.value).toBe(0.675); // 0.5*1 + 0.5*0.35
    expect(s.reason_code).toBe("authz_surface_rubric");
  });
});

describe("authz_opportunity — honesty: no evidence stays null", () => {
  it("is null when neither surface nor authz policy evidence exists", () => {
    for (const d of [
      detail(), // briefText null + credentialsProvided null
      detail({ credentialsProvided: false }),
      detail({ credentialsProvided: null, briefText: "" }),
      detail({ briefText: "The program targets a web application." }),
    ]) {
      expect(authzOpportunitySignal(d)).toEqual({
        value: null,
        source: "engagement_detail",
        reason_code: "no_authz_evidence",
      });
    }
  });

  it("a topic mention without a normative predicate is not counted", () => {
    // "multiple accounts" names the multi-account technique but asserts
    // nothing about what may be tested — statusOfSentence → null.
    const mention = authzOpportunitySignal(
      detail({ briefText: "Our platform uses multiple accounts internally." }),
    );
    expect(mention.value).toBeNull();
    expect(mention.reason_code).toBe("no_authz_evidence");

    // Same mention beside real surface evidence changes nothing: identical
    // to the surface-only reading (0.675), never a fabricated permission.
    const withSurface = authzOpportunitySignal(
      detail({
        credentialsProvided: true,
        briefText: "Our platform uses multiple accounts internally.",
      }),
    );
    expect(withSurface.value).toBe(0.675);
  });

  it("a prohibition on a NON-authz technique never reads 0.1", () => {
    const s = authzOpportunitySignal(
      detail({ briefText: "Automated scanning is prohibited." }),
    );
    expect(s.value).toBeNull();
    expect(s.reason_code).toBe("no_authz_evidence");
  });
});

describe("authz_opportunity — contract shape", () => {
  it("always emits a schema-valid signal (value in 0..1 or null)", () => {
    for (const d of [
      detail(),
      detail({ credentialsProvided: true }),
      detail({ briefText: "Cross-account testing is prohibited." }),
      detail({ briefText: "You may test across accounts that you own." }),
      detail({
        credentialsProvided: true,
        briefText: "Sign up now. You may test across accounts that you own.",
      }),
    ]) {
      const s = authzOpportunitySignal(d);
      expect(radarSignalSchema.safeParse(s).success).toBe(true);
    }
  });

  it("is deterministic — same detail, deep-equal signal", () => {
    const d = detail({
      credentialsProvided: true,
      briefText: "Cross-tenant testing is allowed only with prior approval.",
    });
    const a = authzOpportunitySignal(d);
    const b = authzOpportunitySignal(d);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("flows through extractProgramFeatures wired as authz_opportunity", () => {
    const v = extractProgramFeatures(
      snapshot(
        detail({ briefText: "Cross-account testing is prohibited." }),
      ),
      "2026-09-21T00:00:00.000Z",
    );
    expect(v.authz_opportunity).toEqual({
      value: 0.1,
      source: "engagement_detail",
      reason_code: "authz_surface_rubric",
    });
  });
});
