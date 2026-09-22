import { describe, expect, it } from "vitest";
import { accessibilitySignal } from "../lib/radar/accessibility";
import { radarSignalSchema } from "../lib/radar/types";
import type { RadarCatalogItem } from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";

// ---------------------------------------------------------------------------
// V1.4 `accessibility` rubric — pinned semantics (see the plan's Signal
// semantics section). The signal reads three already-fetched sources:
//
//   base  = band over (detail.participation ?? catalog.lifecycle_status ?? "")
//           lowercased: contains "open" → 0.8; GATED_RE → 0.2; other
//           non-empty → 0.5; empty → null ("no_access_evidence")
//   value = clamp01(round4(base + 0.10·signup(briefText)
//                                + 0.10·(credentialsProvided === true)
//                                − 0.20·friction(briefText)))
//
// Every band boundary, modifier, precedence rule and the honest-null path is
// pinned here — the formula is a contract, not a heuristic to tune.
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

function rubric(
  detailOverrides: Partial<ApiEngagementData> = {},
  catalogOverrides: Partial<RadarCatalogItem> = {},
) {
  return accessibilitySignal(detail(detailOverrides), catalog(catalogOverrides));
}

describe("base band — participation posture", () => {
  it.each([
    "open",
    "Open",
    "OPEN TO ALL RESEARCHERS",
    "open to invited researchers", // "open" substring beats the gated token
    "reopened", // pinned substring semantics — no word boundary
  ])("contains 'open' → 0.8: %j", (participation) => {
    expect(rubric({ participation })).toEqual({
      value: 0.8,
      source: "engagement_detail",
      reason_code: "participation_access_rubric",
    });
  });

  it.each([
    "invite-only",
    "invite",
    "Invited researchers only",
    "application required",
    "by application",
    "approval required",
    "waitlist",
    "private",
    "private bug bounty",
    "managed",
    "closed",
  ])("gated family → 0.2: %j", (participation) => {
    expect(rubric({ participation })).toEqual({
      value: 0.2,
      source: "engagement_detail",
      reason_code: "participation_access_rubric",
    });
  });

  it.each([
    "vdp",
    "bug_bounty",
    "live",
    "public", // no "open" substring, no gated token
    " ", // whitespace-only is still a stated value — no trim is pinned
  ])("stated but unclassified → 0.5: %j", (participation) => {
    expect(rubric({ participation })).toEqual({
      value: 0.5,
      source: "engagement_detail",
      reason_code: "participation_access_rubric",
    });
  });

  it("'open' is checked before the gated family", () => {
    // Contains both substrings — the pinned order reads the open band.
    expect(
      rubric({ participation: "open (previously invite-only)" }).value,
    ).toBe(0.8);
  });
});

describe("catalog fallback and precedence", () => {
  it("uses catalog.lifecycle_status when detail.participation is null", () => {
    expect(
      rubric({ participation: null }, { lifecycle_status: "invite" }).value,
    ).toBe(0.2);
    expect(
      rubric({ participation: null }, { lifecycle_status: "Open Program" })
        .value,
    ).toBe(0.8);
    expect(
      rubric({ participation: null }, { lifecycle_status: "live" }).value,
    ).toBe(0.5);
  });

  it("prefers detail.participation over catalog.lifecycle_status", () => {
    expect(
      rubric(
        { participation: "open" },
        { lifecycle_status: "invite" },
      ).value,
    ).toBe(0.8);
    expect(
      rubric(
        { participation: "invite-only" },
        { lifecycle_status: "open" },
      ).value,
    ).toBe(0.2);
  });

  it("empty-string participation suppresses the catalog fallback", () => {
    // `"" ?? lifecycle` is "" — the pinned ?? chain falls through only on
    // null/undefined, so a blank participation field nulls the signal even
    // when the catalog carries a classifiable accessStatus.
    const s = rubric(
      { participation: "" },
      { lifecycle_status: "open" },
    );
    expect(s).toEqual({
      value: null,
      source: "engagement_detail",
      reason_code: "no_access_evidence",
    });
  });
});

describe("honest null — no access evidence", () => {
  it.each([
    [null, null],
    [null, ""],
    ["", null],
    ["", ""],
  ] as const)(
    "participation %j + lifecycle_status %j → null",
    (participation, lifecycle_status) => {
      expect(
        rubric({ participation }, { lifecycle_status }),
      ).toEqual({
        value: null,
        source: "engagement_detail",
        reason_code: "no_access_evidence",
      });
    },
  );
});

describe("modifiers over the base band", () => {
  it("signup marker in briefText adds +0.10", () => {
    expect(
      rubric({
        participation: "open",
        briefText: "Sign up and start hacking today.",
      }).value,
    ).toBe(0.9);
  });

  it("credentialsProvided === true adds +0.10", () => {
    expect(
      rubric({ participation: "open", credentialsProvided: true }).value,
    ).toBe(0.9);
  });

  it("open + signup + credentials clamps to 1.0", () => {
    // 0.8 + 0.1 + 0.1 = 1.0000000000000002 in doubles — round4 then clamp01.
    expect(
      rubric({
        participation: "open",
        credentialsProvided: true,
        briefText: "Create an account to begin.",
      }).value,
    ).toBe(1);
  });

  it("friction marker in briefText subtracts −0.20", () => {
    expect(
      rubric({
        participation: "open",
        briefText: "A VPN is required to reach the targets.",
      }).value,
    ).toBe(0.6);
    // 0.5 − 0.2 = 0.30000000000000004 raw — the pin only holds because
    // round4 is applied.
    expect(
      rubric({
        participation: "vdp",
        briefText: "Testing requires an NDA.",
      }).value,
    ).toBe(0.3);
  });

  it("friction floors at 0 — clamped, never negative", () => {
    expect(
      rubric({
        participation: "invite-only",
        briefText: "VPN and identity verification required.",
      }).value,
    ).toBe(0);
  });

  it("signup and friction on the same brief net −0.10", () => {
    expect(
      rubric({
        participation: "vdp",
        briefText: "Sign up, then complete identity verification.",
      }).value,
    ).toBe(0.4);
  });

  it("a gated program with credentials and no friction stays low", () => {
    // 0.2 + 0.10 = 0.3 — shipped credentials soften but never reach "open".
    expect(
      rubric({
        participation: "private",
        credentialsProvided: true,
      }).value,
    ).toBe(0.3);
  });

  it.each([null, false] as const)(
    "credentialsProvided %j contributes nothing",
    (credentialsProvided) => {
      expect(
        rubric({ participation: "open", credentialsProvided }).value,
      ).toBe(0.8);
      expect(
        rubric({
          participation: "vdp",
          credentialsProvided,
          briefText: "sign up",
        }).value,
      ).toBe(0.6);
    },
  );

  it("null briefText contributes neither bonus nor penalty", () => {
    expect(
      rubric({
        participation: "open",
        credentialsProvided: true,
        briefText: null,
      }).value,
    ).toBe(0.9);
    expect(rubric({ participation: "vdp", briefText: null }).value).toBe(0.5);
  });
});

describe("SIGNUP_RE coverage (pinned alternations)", () => {
  it.each([
    "Reach us at researcher@bugcrowdninja.com for access.",
    "sign up to participate",
    "sign-up required first",
    "This program is signup only.",
    "self-serve onboarding",
    "self serve program",
    "create an account on the target",
    "you may create a account per policy",
    "create your own accounts",
    "created an account before testing",
    "register an account to test",
    "registering your own account",
    "registered an account",
  ])("+0.10 for %j", (briefText) => {
    expect(rubric({ participation: "vdp", briefText }).value).toBe(0.6);
  });

  it.each([
    "sign in to your existing account", // sign-in ≠ sign-up
    "set up an account first", // "set up" is not "sign up"
    "account takeover is in scope", // bare "account" is no marker
    "self service portal", // space-separated "self service" ≠ self-serve
  ])("no bonus for %j", (briefText) => {
    expect(rubric({ participation: "vdp", briefText }).value).toBe(0.5);
  });
});

describe("FRICTION_RE coverage (pinned alternations)", () => {
  it.each([
    "vpn required",
    "connect via VPN first",
    "ip whitelist applies",
    "ip-whitelist only",
    "whitelisted ip ranges",
    "whitelisting ip addresses",
    "an NDA must be signed",
    "non-disclosure agreement",
    "non disclosure terms",
    "identity verification step",
    "background check required",
    "citizenship requirement applies",
  ])("−0.20 for %j", (briefText) => {
    expect(rubric({ participation: "vdp", briefText }).value).toBe(0.3);
  });

  it.each([
    "virtual private network access", // spelled out — only "vpn" matches
    "private program", // "private" is a GATED token, not a friction marker
    "apply for access", // application ≠ friction
  ])("no penalty for %j", (briefText) => {
    expect(rubric({ participation: "vdp", briefText }).value).toBe(0.5);
  });
});

describe("field scoping — markers never cross fields", () => {
  it("gated vocabulary in briefText does not lower the band", () => {
    // GATED_RE reads the participation string only.
    expect(
      rubric({
        participation: "open",
        briefText: "This is a private, invite-only managed program.",
      }).value,
    ).toBe(0.8);
  });

  it("signup vocabulary in participation does not earn the bonus", () => {
    // "open" still sets the band, but SIGNUP_RE reads briefText only.
    expect(rubric({ participation: "open signup" }).value).toBe(0.8);
  });
});

describe("output contract", () => {
  it("emits engagement_detail source and the pinned reason codes", () => {
    expect(rubric({ participation: null }).reason_code).toBe(
      "no_access_evidence",
    );
    expect(rubric({ participation: "vdp" }).reason_code).toBe(
      "participation_access_rubric",
    );
    for (const s of [
      rubric({ participation: null }),
      rubric({ participation: "open" }),
    ]) {
      expect(s.source).toBe("engagement_detail");
    }
  });

  it("every band × modifier combination is schema-valid and 4-decimal", () => {
    const briefs = [
      null,
      "sign up",
      "vpn required",
      "sign up then vpn",
    ];
    for (const participation of ["open", "invite", "vdp", null] as const) {
      for (const credentialsProvided of [null, false, true] as const) {
        for (const briefText of briefs) {
          const s = rubric({ participation, credentialsProvided, briefText });
          expect(radarSignalSchema.safeParse(s).success).toBe(true);
          if (s.value !== null) {
            expect(s.value).toBe(Number(s.value.toFixed(4)));
            expect(s.value).toBeGreaterThanOrEqual(0);
            expect(s.value).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("is deterministic — repeated calls over the same input are deep-equal", () => {
    const d = detail({
      participation: "open",
      credentialsProvided: true,
      briefText: "Sign up, but an NDA applies.",
    });
    const c = catalog({ lifecycle_status: "invite" });
    // Also guards against accidental /g-regex lastIndex drift.
    expect(accessibilitySignal(d, c)).toEqual(accessibilitySignal(d, c));
    expect(accessibilitySignal(d, c)).toEqual(accessibilitySignal(d, c));
  });
});
