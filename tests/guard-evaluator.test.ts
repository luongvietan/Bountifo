import { describe, expect, it } from "vitest";
import { evaluateScopeGuard } from "@/lib/guard/index.ts";
import { compilePolicy } from "@/lib/guard/policy.ts";
import { evaluateAction } from "@/lib/guard/evaluator.ts";
import {
  guardWrap,
  runWithGuard,
  ScopeGuardBlocked,
} from "@/lib/guard/harness.ts";
import type {
  AgentFacts,
  ContextFact,
  ProposedAction,
} from "@/lib/guard/types.ts";

/**
 * A complete, trusted dossier fixture. Every gate input is explicit: real
 * inventory, verified integrity, no conflicts, safe harbor present.
 */
function makeFacts(overrides: Partial<AgentFacts> = {}): AgentFacts {
  return {
    agent_facts_schema_version: 1,
    engagement: { code: "zendesk" },
    techniques: {
      "Cross-Site Scripting (XSS)": {
        status: "allowed",
        evidence_refs: ["ev_t_xss"],
      },
      "Denial of Service (DoS)": {
        status: "prohibited",
        evidence_refs: ["ev_t_dos"],
      },
      "Cross-account testing": {
        status: "conditional",
        conditions: [{ id: "c1", text: "Only test accounts that you own" }],
        evidence_refs: ["ev_t_cross"],
      },
      Scanning: { status: "unspecified", evidence_refs: ["ev_t_scan"] },
    },
    submission_exclusions: [
      {
        text: "Avoid testing any contact forms",
        submission_status: "excluded",
        testing_status: "prohibited",
        reward_status: "ineligible",
        evidence_refs: ["ev_ex_contact"],
      },
      {
        text: "Self-XSS findings are not eligible for reward",
        submission_status: "excluded",
        testing_status: "unspecified",
        reward_status: "ineligible",
        evidence_refs: ["ev_ex_selfxss"],
      },
    ],
    authorized_scope: {
      listed_targets: {
        status: "conditional",
        conditions: ["Target must be explicitly listed in scope"],
      },
      unlisted_targets: { status: "prohibited" },
      evidence_refs: ["ev_scope"],
    },
    scope_inventory: {
      in_scope: [
        {
          target_id: "t_suite",
          location: "Zendesk Suite https://{subdomain}.zendesk.com/",
          name: "Zendesk Suite",
          category: "website",
          scope_group_ids: ["g_suite"],
          evidence_refs: ["ev_i_suite"],
        },
        {
          target_id: "t_api",
          location: "https://api.zendesk.com",
          name: null,
          category: "api",
          scope_group_ids: [],
          evidence_refs: ["ev_i_api"],
        },
      ],
      out_of_scope: [
        {
          target_id: "t_oos",
          location: "support.zendesk.com",
          name: null,
          category: "website",
          scope_group_ids: [],
          evidence_refs: ["ev_i_oos"],
        },
      ],
    },
    scope_groups: [
      {
        id: "g_suite",
        name: "Zendesk Suite",
        in_scope: true,
        evidence_refs: ["ev_g_suite"],
      },
    ],
    vrt_scope_rules: [
      {
        category: "Application-Level DoS",
        vrt_version: null,
        applies_to: "All targets",
        status: "out_of_scope",
        note: null,
        evidence_refs: ["ev_vrt_dos"],
      },
    ],
    safe_harbor: { status: "present", evidence_refs: ["ev_sh"] },
    account_rules: [
      { text: "Only test accounts that you own.", evidence_refs: ["ev_acct"] },
    ],
    data_rules: [
      {
        text: "Do not use leaked or stolen credentials.",
        evidence_refs: ["ev_cred"],
      },
    ],
    collection: { status: "complete", api_status: "unavailable" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: true,
      required_sections_complete: true,
    },
    policy: { conflicts_present: false, unresolved_conflicts: 0 },
    ...overrides,
  };
}

function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    schema_version: 1,
    engagement: { code: "zendesk" },
    target: { url: "https://acme.zendesk.com/" },
    technique: { id: "xss" },
    operation: { kind: "send", destructive: false },
    ...overrides,
  };
}

const VERIFIED_OWNED: ContextFact[] = [
  {
    key: "account.ownership",
    value: "researcher",
    source: "runtime",
    verification: "verified",
  },
  {
    key: "credentials.source",
    value: "own",
    source: "runtime",
    verification: "verified",
  },
];

async function decide(
  facts: AgentFacts,
  action: ProposedAction,
  trustedContext: ContextFact[] = [],
) {
  return evaluateScopeGuard({
    agentFacts: facts,
    action,
    trustedContext,
    now: "2026-01-01T00:00:00.000Z",
  });
}

const hasReason = (
  d: Awaited<ReturnType<typeof decide>>,
  code: string,
): boolean => d.reason_codes.includes(code as never);

describe("decision lattice — §30", () => {
  it("explicit in-scope target + prohibited technique → DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "denial_of_service" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.execution_allowed).toBe(false);
    expect(hasReason(d, "TECHNIQUE_PROHIBITED")).toBe(true);
    expect(hasReason(d, "VRT_RULE_PROHIBITED")).toBe(true);
    expect(d.evidence_refs).toContain("ev_t_dos");
  });

  it("explicit out-of-scope target → DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ target: { url: "https://support.zendesk.com/" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "TARGET_OUT_OF_SCOPE")).toBe(true);
    expect(d.target_resolution.target_id).toBe("t_oos");
  });

  it("unlisted target + unlisted_targets prohibited → DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ target: { url: "https://attacker.example.com/" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "UNLISTED_TARGETS_PROHIBITED")).toBe(true);
  });

  it("unlisted target with no unlisted rule → REVIEW", async () => {
    const facts = makeFacts();
    facts.authorized_scope = {
      listed_targets: { status: "allowed", conditions: [] },
      unlisted_targets: { status: "unspecified" },
      evidence_refs: [],
    };
    const d = await decide(
      facts,
      makeAction({ target: { url: "https://other.example.com/" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "TARGET_UNLISTED")).toBe(true);
  });

  it("ambiguous equal-specificity in/out listings → REVIEW", async () => {
    const facts = makeFacts();
    facts.scope_inventory = {
      in_scope: [
        {
          target_id: "t_in",
          location: "dup.example.com",
          name: null,
          category: null,
          scope_group_ids: [],
          evidence_refs: ["ev_dup_in"],
        },
      ],
      out_of_scope: [
        {
          target_id: "t_out",
          location: "dup.example.com",
          name: null,
          category: null,
          scope_group_ids: [],
          evidence_refs: ["ev_dup_out"],
        },
      ],
    };
    const d = await decide(
      facts,
      makeAction({ target: { url: "https://dup.example.com/" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "TARGET_AMBIGUOUS")).toBe(true);
    expect(d.target_resolution.matched_target_ids).toEqual(["t_in", "t_out"]);
  });

  it("partial dossier → REVIEW even when technique is allowed", async () => {
    const d = await decide(
      makeFacts({ collection: { status: "partial" } }),
      makeAction(),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "DOSSIER_PARTIAL")).toBe(true);
    expect(d.target_resolution.status).toBe("not_evaluated");
  });

  it("invalid evidence hash → REVIEW", async () => {
    const d = await decide(
      makeFacts({
        integrity: {
          evidence_hash_valid: false,
          known_issues_counts_valid: true,
          required_sections_complete: true,
        },
      }),
      makeAction(),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "EVIDENCE_HASH_INVALID")).toBe(true);
  });

  it("unresolved policy conflict → REVIEW", async () => {
    const d = await decide(
      makeFacts({ policy: { conflicts_present: true, unresolved_conflicts: 1 } }),
      makeAction(),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "POLICY_CONFLICT")).toBe(true);
  });

  it("technique unspecified → REVIEW", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "scanning" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "TECHNIQUE_UNSPECIFIED")).toBe(true);
  });

  it("technique with no policy fact → REVIEW", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "csrf" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "TECHNIQUE_NO_POLICY")).toBe(true);
  });

  it("conditional technique + verified true condition → ALLOW path continues", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "cross_account_testing" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("ALLOW");
    expect(d.execution_allowed).toBe(true);
    expect(hasReason(d, "TECHNIQUE_CONDITIONAL")).toBe(true);
  });

  it("conditional technique + verified false condition → DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "cross_account_testing" } }),
      [
        {
          key: "account.ownership",
          value: "third_party",
          source: "runtime",
          verification: "verified",
        },
      ],
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "ACCOUNT_CONSTRAINT_FAILED")).toBe(true);
  });

  it("conditional technique + missing context → REVIEW", async () => {
    const facts = makeFacts({ account_rules: [] });
    const d = await decide(
      facts,
      makeAction({ technique: { id: "cross_account_testing" } }),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "ACCOUNT_CONTEXT_UNVERIFIED")).toBe(true);
  });

  it("planner-asserted context cannot satisfy a condition → REVIEW", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({
        technique: { id: "cross_account_testing" },
        account: { ownership: "researcher" },
        context_facts: [
          {
            key: "account.ownership",
            value: "researcher",
            source: "planner",
            verification: "verified",
          },
        ],
      }),
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "ACCOUNT_CONTEXT_UNVERIFIED")).toBe(true);
  });

  it("a declared violation fails even without verification → DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({
        technique: { id: "cross_account_testing" },
        account: { ownership: "third_party" },
      }),
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "ACCOUNT_CONSTRAINT_FAILED")).toBe(true);
  });

  it("condition the compiler cannot read → REVIEW", async () => {
    const facts = makeFacts();
    facts.techniques = {
      Widgets: {
        status: "conditional",
        conditions: [{ id: "c", text: "The moon must be full" }],
        evidence_refs: ["ev_w"],
      },
    };
    const d = await decide(facts, makeAction({ technique: { id: "idor" } }), [
      ...VERIFIED_OWNED,
    ]);
    // 'idor' isn't 'Widgets' — rename the key to the action's technique.
    void d;
    facts.techniques = {
      "Cross-Site Scripting (XSS)": {
        status: "conditional",
        conditions: [{ id: "c", text: "The moon must be full" }],
        evidence_refs: ["ev_w"],
      },
    };
    const d2 = await decide(facts, makeAction(), VERIFIED_OWNED);
    expect(d2.decision).toBe("REVIEW");
    expect(hasReason(d2, "CONDITION_UNRESOLVED")).toBe(true);
  });

  it("old dossier without scope_inventory → REVIEW", async () => {
    const facts = makeFacts();
    delete facts.scope_inventory;
    const d = await decide(facts, makeAction(), VERIFIED_OWNED);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "SCOPE_INVENTORY_UNAVAILABLE")).toBe(true);
  });

  it("engagement mismatch → REVIEW", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ engagement: { code: "other-program" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "ENGAGEMENT_MISMATCH")).toBe(true);
  });

  it("safe harbor absent → REVIEW (never a DENY, never ignored)", async () => {
    const d = await decide(
      makeFacts({ safe_harbor: { status: "absent", evidence_refs: [] } }),
      makeAction(),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "SAFE_HARBOR_UNCLEAR")).toBe(true);
  });

  it("leaked credentials trigger the credential rule → DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ credentials: { source: "leaked" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "CREDENTIAL_SOURCE_PROHIBITED")).toBe(true);
  });

  it("undeclared credential source under a credential rule → REVIEW", async () => {
    const d = await decide(makeFacts(), makeAction(), [
      VERIFIED_OWNED[0]!,
    ]);
    expect(d.decision).toBe("REVIEW");
    expect(hasReason(d, "CREDENTIAL_SOURCE_UNVERIFIED")).toBe(true);
  });

  it("full fixture ALLOW: every gate satisfied deterministically", async () => {
    const d = await decide(makeFacts(), makeAction(), VERIFIED_OWNED);
    expect(d.decision).toBe("ALLOW");
    expect(d.execution_allowed).toBe(true);
    expect(d.target_resolution.status).toBe("matched_in_scope");
    expect(d.target_resolution.target_id).toBe("t_suite");
    expect(d.evidence_refs).toContain("ev_i_suite");
    expect(d.evidence_refs).toContain("ev_t_xss");
    expect(d.policy_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.action_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.decision_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("eligibility axes — §31", () => {
  it("testing_prohibited exclusion → DENY (contact forms)", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "contact_form_testing" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("DENY");
    expect(hasReason(d, "EXCLUSION_TESTING_PROHIBITED")).toBe(true);
    expect(d.eligibility.submission).toBe("excluded");
    expect(d.eligibility.reward).toBe("ineligible");
  });

  it("submission excluded + testing unspecified → NOT DENY", async () => {
    const d = await decide(
      makeFacts(),
      makeAction({ technique: { id: "self_xss" } }),
      VERIFIED_OWNED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.decision).not.toBe("DENY");
    expect(hasReason(d, "SUBMISSION_EXCLUDED")).toBe(true);
    expect(hasReason(d, "REWARD_INELIGIBLE")).toBe(true);
    expect(d.eligibility.submission).toBe("excluded");
    expect(d.eligibility.reward).toBe("ineligible");
  });
});

describe("determinism + hashing — §24", () => {
  it("identical inputs produce identical decision_hash despite different clocks", async () => {
    const a = await evaluateScopeGuard({
      agentFacts: makeFacts(),
      action: makeAction(),
      trustedContext: VERIFIED_OWNED,
      now: "2026-01-01T00:00:00.000Z",
    });
    const b = await evaluateScopeGuard({
      agentFacts: makeFacts(),
      action: makeAction(),
      trustedContext: VERIFIED_OWNED,
      now: "2030-06-15T12:00:00.000Z",
    });
    expect(a.decision_hash).toBe(b.decision_hash);
    expect(a.policy_hash).toBe(b.policy_hash);
    expect(a.action_hash).toBe(b.action_hash);
    expect(a.evaluated_at).not.toBe(b.evaluated_at);
  });

  it("fact key order does not change policy_hash", async () => {
    const a = await compilePolicy(makeFacts());
    const reordered = makeFacts();
    reordered.techniques = Object.fromEntries(
      Object.entries(reordered.techniques ?? {}).reverse(),
    );
    const b = await compilePolicy(reordered);
    expect(a.policy_hash).toBe(b.policy_hash);
  });

  it("a changed input changes the action_hash and decision_hash", async () => {
    const a = await decide(makeFacts(), makeAction(), VERIFIED_OWNED);
    const b = await decide(
      makeFacts(),
      makeAction({ target: { url: "https://api.zendesk.com/x" } }),
      VERIFIED_OWNED,
    );
    expect(a.action_hash).not.toBe(b.action_hash);
    expect(a.decision_hash).not.toBe(b.decision_hash);
  });
});

describe("execution gate — §27", () => {
  it("runWithGuard executes only on ALLOW", async () => {
    let ran = false;
    const allow = await runWithGuard(
      () => decide(makeFacts(), makeAction(), VERIFIED_OWNED),
      () => {
        ran = true;
        return "ok";
      },
    );
    expect(ran).toBe(true);
    expect(allow.executed).toBe(true);
    expect(allow.value).toBe("ok");

    ran = false;
    const deny = await runWithGuard(
      () =>
        decide(
          makeFacts(),
          makeAction({ technique: { id: "denial_of_service" } }),
          VERIFIED_OWNED,
        ),
      () => {
        ran = true;
        return "bad";
      },
    );
    expect(ran).toBe(false);
    expect(deny.executed).toBe(false);
    expect(deny.decision.decision).toBe("DENY");
  });

  it("REVIEW blocks execution — never `!== DENY`", async () => {
    let ran = false;
    const res = await runWithGuard(
      () => decide(makeFacts({ collection: { status: "partial" } }), makeAction()),
      () => {
        ran = true;
      },
      { throwOnBlock: true },
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(res).toBeInstanceOf(ScopeGuardBlocked);
    expect(ran).toBe(false);
  });

  it("guardWrap throws ScopeGuardBlocked carrying the decision", async () => {
    const review = await decide(
      makeFacts({ collection: { status: "partial" } }),
      makeAction(),
    );
    const guarded = guardWrap(review, () => "never");
    await expect(guarded()).rejects.toBeInstanceOf(ScopeGuardBlocked);
    try {
      await guarded();
    } catch (err) {
      expect((err as ScopeGuardBlocked).decision.decision).toBe("REVIEW");
    }
  });
});

describe("schema validation", () => {
  it("rejects planner bypass fields on the action", async () => {
    await expect(
      evaluateScopeGuard({
        agentFacts: makeFacts(),
        action: { ...makeAction(), force: true },
      }),
    ).rejects.toThrow(/ProposedAction/);
  });

  it("rejects an action missing required fields", async () => {
    await expect(
      evaluateScopeGuard({
        agentFacts: makeFacts(),
        action: { schema_version: 1, engagement: { code: "zendesk" } },
      }),
    ).rejects.toThrow(/ProposedAction/);
  });
});

describe("compiled-policy reuse", () => {
  it("evaluateAction on a shared CompiledPolicy agrees with evaluateScopeGuard", async () => {
    const facts = makeFacts();
    const policy = await compilePolicy(facts);
    const action = makeAction();
    const direct = await evaluateAction(policy, action, {
      trustedContext: VERIFIED_OWNED,
      now: "2026-01-01T00:00:00.000Z",
    });
    const wrapped = await decide(facts, action, VERIFIED_OWNED);
    expect(direct.decision_hash).toBe(wrapped.decision_hash);
  });
});
