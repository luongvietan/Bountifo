import { describe, expect, it } from "vitest";
import { evaluateScopeGuard } from "@/lib/guard/index.ts";
import { resolveTarget } from "@/lib/guard/targets.ts";
import type {
  AgentFacts,
  AgentFactsTarget,
  ContextFact,
  ProposedAction,
} from "@/lib/guard/types.ts";

/**
 * Spec §67 acceptance matrix for the dimensions wired in this pass:
 * conditional_context applicability, authorization exceptions, program
 * state, rate limits, and isolated integrity failures. Every fixture here
 * carries complete, verified integrity unless a test says otherwise — the
 * gate is exercised on policy semantics, not the integrity short-circuit.
 */

function target(id: string, location: string): AgentFactsTarget {
  return {
    target_id: id,
    location,
    name: null,
    category: "website",
    scope_group_ids: [],
    evidence_refs: [`ev_${id}`],
  };
}

function makeFacts(overrides: Partial<AgentFacts> = {}): AgentFacts {
  return {
    agent_facts_schema_version: 1,
    engagement: { code: "prog" },
    techniques: {
      "Cross-Site Scripting (XSS)": {
        status: "allowed",
        evidence_refs: ["ev_xss"],
      },
      "Denial of Service (DoS)": {
        status: "prohibited",
        evidence_refs: ["ev_dos"],
      },
    },
    submission_exclusions: [],
    authorized_scope: {
      listed_targets: { status: "allowed", conditions: [] },
      unlisted_targets: { status: "prohibited" },
      evidence_refs: ["ev_scope"],
    },
    scope_inventory: {
      in_scope: [target("t_in", "*.example.com")],
      out_of_scope: [target("t_oos", "blocked.example.com")],
    },
    scope_groups: [],
    vrt_scope_rules: [],
    safe_harbor: { status: "present", evidence_refs: ["ev_sh"] },
    account_rules: [],
    data_rules: [],
    collection: { status: "complete" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: true,
      required_sections_complete: true,
    },
    policy: { unresolved_conflicts: 0 },
    ...overrides,
  };
}

function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    schema_version: 1,
    engagement: { code: "prog" },
    target: { url: "https://app.example.com/" },
    technique: { id: "xss" },
    operation: { kind: "send", destructive: false },
    ...overrides,
  };
}

function decide(
  facts: AgentFacts,
  a: ProposedAction,
  trustedContext: ContextFact[] = [],
) {
  return evaluateScopeGuard({
    agentFacts: facts,
    action: a,
    trustedContext,
    now: "2026-01-01T00:00:00.000Z",
  });
}

const verified = (key: string, value: string | number | boolean): ContextFact => ({
  key,
  value,
  source: "runtime",
  verification: "verified",
});

const hasReason = (
  d: Awaited<ReturnType<typeof decide>>,
  code: string,
): boolean => d.reason_codes.includes(code as never);

// ---------------------------------------------------------------------------
// §26/§47 — conditional_context applicability (Okta shape)
// ---------------------------------------------------------------------------

const oktaFacts = makeFacts({
  scope_inventory: {
    in_scope: [target("t_okta", "*.okta.com")],
    out_of_scope: [],
  },
  techniques: {
    "Cross-Site Scripting (XSS)": {
      status: "allowed",
      evidence_refs: ["ev_xss"],
    },
    "Port scanning internal networks": {
      status: "prohibited",
      applies_to: {
        type: "conditional_context",
        conditions: [{ kind: "phase", value: "post_compromise" }],
      },
      evidence_refs: ["ev_portscan"],
    },
  },
});

const oktaAction = action({
  target: { url: "https://internal.okta.com/" },
  technique: { id: "port_scanning_internal_networks" },
  operation: { kind: "scan", destructive: false },
});

describe("Okta conditional_context applicability", () => {
  it("missing phase context → REVIEW, never silently (in)applicable", async () => {
    const d = await decide(oktaFacts, oktaAction);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "APPLICABILITY_UNRESOLVED")).toBe(true);
    const app = d.checks.find((c) => c.check === "applicability");
    expect(app?.result).toBe("unknown");
  });

  it("verified post_compromise phase → rule applies → DENY", async () => {
    const d = await decide(oktaFacts, oktaAction, [
      verified("context.phase", "post_compromise"),
    ]);
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "TECHNIQUE_PROHIBITED")).toBe(true);
  });

  it("verified non-post_compromise phase → rule not applicable, other rules continue", async () => {
    const d = await decide(oktaFacts, oktaAction, [
      verified("context.phase", "external_recon"),
    ]);
    expect(d.decision).not.toBe("DENY");
    const app = d.checks.find((c) => c.check === "applicability");
    expect(app?.result).toBe("not_applicable");
    // No applicable rule for the technique → unresolved, not invented.
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "TECHNIQUE_NO_POLICY")).toBe(true);
  });

  it("planner-asserted phase cannot make a prohibition apply → REVIEW", async () => {
    const a: ProposedAction = {
      ...oktaAction,
      context_facts: [
        {
          key: "context.phase",
          value: "post_compromise",
          source: "planner",
          verification: "verified", // planner cannot self-certify
        },
      ],
    };
    const d = await decide(oktaFacts, a);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "APPLICABILITY_UNRESOLVED")).toBe(true);
  });

  it("antecedent_text conditions stay unresolved → REVIEW", async () => {
    const facts = makeFacts({
      scope_inventory: { in_scope: [target("t_okta", "*.okta.com")], out_of_scope: [] },
      techniques: {
        "Port scanning internal networks": {
          status: "prohibited",
          applies_to: {
            type: "conditional_context",
            conditions: [{ kind: "antecedent_text", text: "if you obtain credentials" }],
          },
          evidence_refs: ["ev_portscan"],
        },
      },
    });
    const d = await decide(facts, oktaAction, [
      verified("context.phase", "post_compromise"),
    ]);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "APPLICABILITY_UNRESOLVED")).toBe(true);
  });

  it("unknown applies_to type → REVIEW", async () => {
    const facts = makeFacts({
      techniques: {
        "Cross-Site Scripting (XSS)": {
          status: "allowed",
          applies_to: { type: "galaxy_wide" },
          evidence_refs: ["ev_xss"],
        },
      },
    });
    const d = await decide(facts, action());
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "APPLICABILITY_UNRESOLVED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §18/§47 — authorization exceptions (Barracuda shape)
// ---------------------------------------------------------------------------

const barracudaFacts = makeFacts({
  scope_inventory: {
    in_scope: [target("t_cuda", "*.barracuda.com")],
    out_of_scope: [target("t_oos_cuda", "phishing.barracuda.com")],
  },
  authorized_scope: {
    listed_targets: {
      status: "conditional",
      conditions: ["Target must be explicitly declared in scope"],
    },
    unlisted_targets: { status: "prohibited" },
    exceptions: [
      {
        applies_to: "out_of_scope_targets",
        condition: {
          kind: "prior_written_consent",
          issuer: "program_security_team",
          verification_required: true,
        },
        effect: "permit_evaluation",
        evidence_refs: ["ev_consent"],
      },
    ],
    evidence_refs: ["ev_scope"],
  },
});

const oosAction = action({
  target: { url: "https://phishing.barracuda.com/" },
});

const consent = (
  source: ContextFact["source"],
  verification: ContextFact["verification"],
): ContextFact => ({
  key: "authorization.prior_written_consent",
  value: true,
  source,
  verification,
});

describe("Barracuda authorization exceptions", () => {
  it("out-of-scope target with no consent → DENY (baseline unchanged)", async () => {
    const d = await decide(barracudaFacts, oosAction);
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "TARGET_OUT_OF_SCOPE")).toBe(true);
  });

  it("planner-asserted consent does not bypass → REVIEW", async () => {
    const a: ProposedAction = {
      ...oosAction,
      context_facts: [consent("planner", "asserted")],
    };
    const d = await decide(barracudaFacts, a);
    expect(d.decision).toBe("REVIEW");
    expect(d.execution_allowed).toBe(false);
    expect(hasReason(d, "AUTHORIZATION_EXCEPTION_UNVERIFIED")).toBe(true);
  });

  it("planner-flagged-as-verified consent still does not bypass → REVIEW", async () => {
    const a: ProposedAction = {
      ...oosAction,
      context_facts: [consent("planner", "verified")],
    };
    const d = await decide(barracudaFacts, a);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "AUTHORIZATION_EXCEPTION_UNVERIFIED")).toBe(true);
  });

  it("verified consent + technique with no policy → REVIEW (evaluation continues)", async () => {
    const d = await decide(
      barracudaFacts,
      action({
        target: { url: "https://phishing.barracuda.com/" },
        technique: { id: "ssrf" },
      }),
      [consent("program", "verified")],
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "AUTHORIZATION_EXCEPTION_VERIFIED")).toBe(true);
    expect(hasReason(d, "TECHNIQUE_NO_POLICY")).toBe(true);
  });

  it("verified consent + allowed technique → ALLOW is legitimate", async () => {
    const d = await decide(barracudaFacts, oosAction, [
      consent("program", "verified"),
    ]);
    expect(d.decision).toBe("ALLOW");
    expect(d.execution_allowed).toBe(true);
    expect(hasReason(d, "AUTHORIZATION_EXCEPTION_VERIFIED")).toBe(true);
    expect(d.target_resolution.status).toBe("matched_out_of_scope");
  });

  it("verified consent does not lift a technique prohibition → DENY", async () => {
    const d = await decide(
      barracudaFacts,
      action({
        target: { url: "https://phishing.barracuda.com/" },
        technique: { id: "denial_of_service" },
      }),
      [consent("program", "verified")],
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "TECHNIQUE_PROHIBITED")).toBe(true);
  });

  it("verbatim source_text exception conditions cannot be verified → REVIEW", async () => {
    const facts = makeFacts({
      scope_inventory: {
        in_scope: [target("t_cuda", "*.barracuda.com")],
        out_of_scope: [target("t_oos_cuda", "phishing.barracuda.com")],
      },
      authorized_scope: {
        listed_targets: { status: "allowed", conditions: [] },
        unlisted_targets: { status: "prohibited" },
        exceptions: [
          {
            applies_to: "out_of_scope_targets",
            condition: {
              kind: "source_text",
              text: "with permission from the security team",
            },
            effect: "permit_evaluation",
            evidence_refs: ["ev_consent"],
          },
        ],
        evidence_refs: [],
      },
    });
    const d = await decide(facts, oosAction, [consent("program", "verified")]);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "AUTHORIZATION_EXCEPTION_UNVERIFIED")).toBe(true);
  });

  it("unknown exception applies_to fails closed → REVIEW", async () => {
    const facts = makeFacts({
      scope_inventory: {
        in_scope: [target("t_cuda", "*.barracuda.com")],
        out_of_scope: [target("t_oos_cuda", "phishing.barracuda.com")],
      },
      authorized_scope: {
        listed_targets: { status: "allowed", conditions: [] },
        unlisted_targets: { status: "prohibited" },
        exceptions: [
          {
            applies_to: "moon_targets",
            condition: {
              kind: "prior_written_consent",
              issuer: "program_security_team",
              verification_required: true,
            },
            effect: "permit_evaluation",
            evidence_refs: ["ev_consent"],
          },
        ],
        evidence_refs: [],
      },
    });
    const d = await decide(facts, oosAction, [consent("program", "verified")]);
    expect(d.decision).toBe("REVIEW");
  });

  it("unlisted_targets exception bypasses the unlisted-prohibited baseline only when verified", async () => {
    const facts = makeFacts({
      scope_inventory: {
        in_scope: [target("t_cuda", "*.barracuda.com")],
        out_of_scope: [],
      },
      authorized_scope: {
        listed_targets: { status: "allowed", conditions: [] },
        unlisted_targets: { status: "prohibited" },
        exceptions: [
          {
            applies_to: "unlisted_targets",
            condition: {
              kind: "prior_written_consent",
              verification_required: true,
            },
            effect: "permit_evaluation",
            evidence_refs: ["ev_consent"],
          },
        ],
        evidence_refs: [],
      },
    });
    const unlisted = action({ target: { url: "https://other-host.org/" } });
    const noConsent = await decide(facts, unlisted);
    expect(noConsent.decision).toBe("DENY");

    const withConsent = await decide(
      facts,
      { ...unlisted, technique: { id: "ssrf" } },
      [consent("program", "verified")],
    );
    expect(withConsent.decision).toBe("REVIEW");
    expect(hasReason(withConsent, "AUTHORIZATION_EXCEPTION_VERIFIED")).toBe(true);
    expect(hasReason(withConsent, "UNLISTED_TARGETS_PROHIBITED")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §20/§21/§47 — program state (Code.org shape)
// ---------------------------------------------------------------------------

const codeOrgFacts = makeFacts({
  program_state: {
    submission_state: "paused",
    testing_state: "unspecified",
    reward_state: "ineligible",
    resume_at: null,
    evidence_refs: ["ev_pause"],
  },
});

describe("Code.org program-state axes", () => {
  it("paused + testing unspecified + reward ineligible → REVIEW, never DENY", async () => {
    const d = await decide(codeOrgFacts, action());
    expect(d.decision).toBe("REVIEW");
    expect(d.decision).not.toBe("DENY");
    expect(d.execution_allowed).toBe(false);
    expect(hasReason(d, "PROGRAM_TESTING_UNSPECIFIED")).toBe(true);
    expect(hasReason(d, "PROGRAM_SUBMISSIONS_PAUSED")).toBe(true);
    expect(hasReason(d, "REWARD_INELIGIBLE")).toBe(true);
    expect(d.eligibility.submission).toBe("excluded");
    expect(d.eligibility.reward).toBe("ineligible");
  });

  it("testing_state prohibited is a real testing denial → DENY", async () => {
    const facts = makeFacts({
      program_state: {
        submission_state: "open",
        testing_state: "prohibited",
        reward_state: "eligible",
        resume_at: null,
        evidence_refs: ["ev_state"],
      },
    });
    const d = await decide(facts, action());
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "PROGRAM_TESTING_PROHIBITED")).toBe(true);
  });

  it("testing_state allowed + eligible program → ALLOW", async () => {
    const facts = makeFacts({
      program_state: {
        submission_state: "open",
        testing_state: "allowed",
        reward_state: "eligible",
        resume_at: null,
        evidence_refs: ["ev_state"],
      },
    });
    const d = await decide(facts, action());
    expect(d.decision).toBe("ALLOW");
    expect(d.eligibility.submission).toBe("eligible");
    expect(d.eligibility.reward).toBe("eligible");
  });

  it("absent program_state contributes nothing (old dossiers)", async () => {
    const d = await decide(makeFacts(), action());
    expect(d.decision).toBe("ALLOW");
    expect(d.checks.some((c) => c.check === "program_state")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §30 — LastPass request-rate condition
// ---------------------------------------------------------------------------

const lastpassFacts = makeFacts({
  scope_inventory: {
    in_scope: [target("t_lp", "*.lastpass.com")],
    out_of_scope: [],
  },
  techniques: {
    "Automated tools": {
      status: "conditional",
      conditions: [{ id: "c1", text: "no more than 5 requests per second" }],
      evidence_refs: ["ev_rate"],
    },
  },
});

const lpAction = (automation?: ProposedAction["automation"]): ProposedAction =>
  action({
    target: { url: "https://vault.lastpass.com/" },
    technique: { id: "automated_tools" },
    operation: { kind: "scan", destructive: false },
    ...(automation === undefined ? {} : { automation }),
  });

describe("LastPass automation rate limit", () => {
  it("3 req/s under a 5 req/s ceiling → condition satisfied", async () => {
    const d = await decide(
      lastpassFacts,
      lpAction({ automated: true, requests_per_second: 3 }),
    );
    expect(d.decision).toBe("ALLOW");
    expect(d.execution_allowed).toBe(true);
  });

  it("8 req/s exceeds a 5 req/s ceiling → DENY", async () => {
    const d = await decide(
      lastpassFacts,
      lpAction({ automated: true, requests_per_second: 8 }),
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "CONDITION_FAILED")).toBe(true);
  });

  it("automated action with no declared rate → REVIEW", async () => {
    const d = await decide(lastpassFacts, lpAction({ automated: true }));
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "CONDITION_UNRESOLVED")).toBe(true);
  });

  it("requests_per_minute remains an equivalent declaration", async () => {
    const d = await decide(
      lastpassFacts,
      lpAction({ automated: true, estimated_requests_per_minute: 240 }),
    );
    expect(d.decision).toBe("ALLOW");
  });
});

// ---------------------------------------------------------------------------
// §31/§33 — Rapyd account + data separation
// ---------------------------------------------------------------------------

const rapydFacts = makeFacts({
  scope_inventory: {
    in_scope: [target("t_rapyd", "*.rapyd.net")],
    out_of_scope: [],
  },
  techniques: {
    "Cross-account testing": {
      status: "conditional",
      conditions: [{ id: "c1", text: "accounts you own" }],
      evidence_refs: ["ev_cross"],
    },
  },
  data_rules: [
    {
      text: "Do not access data from anyone else's account.",
      evidence_refs: ["ev_else"],
    },
  ],
});

const rapydAction = action({
  target: { url: "https://sandbox.rapyd.net/" },
  technique: { id: "cross_account_testing" },
});

describe("Rapyd account/data constraints", () => {
  it("verified own-account + clean data context → ALLOW", async () => {
    const d = await decide(rapydFacts, rapydAction, [
      verified("account.ownership", "researcher"),
      verified("data.ownership", "researcher"),
      verified("data.sensitivity", "none"),
    ]);
    expect(d.decision).toBe("ALLOW");
  });

  it("declared third-party account fails the own-account condition → DENY", async () => {
    const d = await decide(
      rapydFacts,
      action({
        target: { url: "https://sandbox.rapyd.net/" },
        technique: { id: "cross_account_testing" },
        account: { ownership: "third_party" },
      }),
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "ACCOUNT_CONSTRAINT_FAILED")).toBe(true);
  });

  it("declared access to someone else's account data → DENY", async () => {
    const d = await decide(
      rapydFacts,
      action({
        target: { url: "https://sandbox.rapyd.net/" },
        technique: { id: "xss" },
        data: { ownership: "third_party" },
      }),
      [verified("account.ownership", "researcher")],
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "DATA_CONSTRAINT_FAILED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Isolated integrity dimensions + safe-harbor granularity + unknowns
// ---------------------------------------------------------------------------

describe("integrity gate — isolated failures", () => {
  it("known-issues invalid alone → REVIEW", async () => {
    const d = await decide(
      makeFacts({
        integrity: {
          evidence_hash_valid: true,
          known_issues_counts_valid: false,
          required_sections_complete: true,
        },
      }),
      action(),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "KNOWN_ISSUES_COUNTS_INVALID")).toBe(true);
  });

  it("required sections incomplete alone → REVIEW", async () => {
    const d = await decide(
      makeFacts({
        integrity: {
          evidence_hash_valid: true,
          known_issues_counts_valid: true,
          required_sections_complete: false,
        },
      }),
      action(),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "REQUIRED_SECTIONS_INCOMPLETE")).toBe(true);
  });
});

describe("residual unknowns", () => {
  it("unrecognized technique id → TECHNIQUE_UNKNOWN REVIEW", async () => {
    const d = await decide(
      makeFacts(),
      action({ technique: { id: "quantum replay" } }),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "TECHNIQUE_UNKNOWN")).toBe(true);
  });

  it("safe harbor absent → SAFE_HARBOR_ABSENT REVIEW", async () => {
    const d = await decide(
      makeFacts({ safe_harbor: { status: "absent", evidence_refs: ["ev_sh"] } }),
      action(),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "SAFE_HARBOR_ABSENT")).toBe(true);
  });

  it("safe harbor unclear → SAFE_HARBOR_UNCLEAR REVIEW", async () => {
    const d = await decide(
      makeFacts({ safe_harbor: { status: "unclear", evidence_refs: [] } }),
      action(),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "SAFE_HARBOR_UNCLEAR")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// target_id as a supported resolution form (§12/§15)
// ---------------------------------------------------------------------------

describe("target_id resolution", () => {
  const inv = {
    in_scope: [target("t_exact", "api.example.com")],
    out_of_scope: [target("t_bad", "evil.example.com")],
  };

  it("a declared target_id resolves directly at top specificity", () => {
    const r = resolveTarget("https://unrelated.example.org/", inv, "t_exact");
    expect(r).toMatchObject({
      status: "matched_in_scope",
      target_ids: ["t_exact"],
    });
  });

  it("target_id can resolve to an out-of-scope listing", () => {
    const r = resolveTarget("https://unrelated.example.org/", inv, "t_bad");
    expect(r.status).toBe("matched_out_of_scope");
  });

  it("unknown target_id falls back to URL matching", () => {
    const r = resolveTarget("https://api.example.com/", inv, "t_missing");
    expect(r).toMatchObject({
      status: "matched_in_scope",
      target_ids: ["t_exact"],
    });
  });
});

// ---------------------------------------------------------------------------
// §58/§59 — determinism properties
// ---------------------------------------------------------------------------

describe("determinism properties", () => {
  it("context fact order never changes the decision preimage", async () => {
    const ctxA = [
      verified("account.ownership", "researcher"),
      verified("data.ownership", "researcher"),
      verified("data.sensitivity", "none"),
    ];
    const ctxB = [...ctxA].reverse();
    const a = await decide(rapydFacts, rapydAction, ctxA);
    const b = await decide(rapydFacts, rapydAction, ctxB);
    expect(a.decision_hash).toBe(b.decision_hash);
  });

  it("extra unknown-source context never improves a blocked decision", async () => {
    const noise: ContextFact[] = [
      { key: "context.phase", value: "post_compromise", source: "planner", verification: "unknown" },
      { key: "authorization.prior_written_consent", value: true, source: "planner", verification: "asserted" },
    ];
    const denied = await decide(barracudaFacts, oosAction, noise);
    expect(denied.decision).toBe("REVIEW"); // exception present but unverified
    expect(denied.execution_allowed).toBe(false);

    const deniedHard = await decide(
      makeFacts(),
      action({ technique: { id: "denial_of_service" } }),
      noise,
    );
    expect(deniedHard.decision).toBe("DENY");
    expect(deniedHard.execution_allowed).toBe(false);
  });
});
