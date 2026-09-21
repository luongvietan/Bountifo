import { describe, expect, it } from "vitest";
import {
  executeAdapter,
  guardWrap,
  prepareExecution,
  runPrepared,
  runWithGuard,
  ScopeGuardBlocked,
  ScopeGuardEvaluationError,
  type ExecutionAdapter,
  type GuardAuditRecord,
  type GuardEnvironment,
  type PreparedExecution,
} from "@/lib/guard/index.ts";
import { compilePolicy } from "@/lib/guard/policy.ts";
import type {
  AgentFacts,
  AgentFactsTarget,
  ContextFact,
  ProposedAction,
} from "@/lib/guard/types.ts";

/**
 * Execution-gate enforcement suite. The invariant under test: no external
 * side effect may occur unless Scope Guard returned ALLOW and
 * execution_allowed === true. REVIEW, DENY, malformed input, and any guard
 * failure all fail closed with zero executor invocations.
 */

const NOW = "2026-01-01T00:00:00.000Z";

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

/** Partial-integrity facts: the dossier cannot be trusted → always REVIEW. */
const partialFacts = (): AgentFacts =>
  makeFacts({
    collection: { status: "partial" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: false,
      required_sections_complete: false,
    },
  });

function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    schema_version: 1,
    engagement: { code: "prog" },
    target: { url: "https://app.example.com/" },
    technique: { id: "xss" },
    operation: { kind: "send", destructive: false },
    ...overrides,
  };
}

const dosAction = (): ProposedAction =>
  makeAction({ technique: { id: "denial_of_service" } });

/** §36 fail-closed test double: counts every invocation. */
class CountingExecutor<T = string> {
  calls = 0;
  payloads: unknown[] = [];
  constructor(
    private readonly impl: (payload?: unknown) => T | Promise<T> = () =>
      "executed" as T,
  ) {}
  run = async (payload?: unknown): Promise<T> => {
    this.calls++;
    this.payloads.push(payload);
    return this.impl(payload);
  };
}

const envFor = async (
  facts: AgentFacts,
  extra: Partial<GuardEnvironment> = {},
): Promise<GuardEnvironment> => ({
  policy: await compilePolicy(facts),
  now: NOW,
  executor_id: "counting-executor",
  ...extra,
});

describe("runWithGuard — enforcement invariant", () => {
  it("ALLOW executes exactly once and returns decision + result", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    const res = await runWithGuard({
      policy,
      action: makeAction(),
      now: NOW,
      execute: exec.run,
    });
    expect(exec.calls).toBe(1);
    expect(res.executed).toBe(true);
    expect(res.result).toBe("executed");
    expect(res.decision.decision).toBe("ALLOW");
    expect(res.decision.execution_allowed).toBe(true);
    expect(res.decision.decision_hash).toMatch(/^sha256:/);
  });

  it("REVIEW throws ScopeGuardBlocked and never executes", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(partialFacts());
    await expect(
      runWithGuard({ policy, action: makeAction(), execute: exec.run }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("DENY throws ScopeGuardBlocked and never executes", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    await expect(
      runWithGuard({ policy, action: dosAction(), execute: exec.run }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("guard evaluation failure throws ScopeGuardEvaluationError — zero executions", async () => {
    const exec = new CountingExecutor();
    // A structurally invalid CompiledPolicy makes evaluateAction throw.
    const brokenPolicy = {} as never;
    await expect(
      runWithGuard({
        policy: brokenPolicy,
        action: makeAction(),
        execute: exec.run,
      }),
    ).rejects.toBeInstanceOf(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });

  it("structurally invalid action → ScopeGuardEvaluationError — zero executions", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    const malformed = {
      schema_version: 1,
      engagement: { code: "prog" },
      // no target / technique / operation
    } as unknown as ProposedAction;
    await expect(
      runWithGuard({ policy, action: malformed, execute: exec.run }),
    ).rejects.toBeInstanceOf(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });

  it.each([
    "force",
    "skip_scope_guard",
    "skipGuard",
    "authorized",
    "override",
    "trusted",
    "unsafe",
  ])("planner bypass field '%s' on the action is rejected — zero executions", async (field) => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    const action = { ...makeAction(), [field]: true } as ProposedAction;
    await expect(
      runWithGuard({ policy, action, execute: exec.run }),
    ).rejects.toBeInstanceOf(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });

  it("ScopeGuardBlocked retains the full GuardDecision (reason codes, hashes, resolution)", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    try {
      await runWithGuard({ policy, action: dosAction(), execute: exec.run });
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeGuardBlocked);
      const d = (err as ScopeGuardBlocked).decision;
      expect(d.decision).toBe("DENY");
      expect(d.execution_allowed).toBe(false);
      expect(d.reason_codes).toContain("TECHNIQUE_PROHIBITED");
      expect(d.decision_hash).toMatch(/^sha256:/);
      expect(d.policy_hash).toMatch(/^sha256:/);
      expect(d.action_hash).toMatch(/^sha256:/);
      expect(d.checks.length).toBeGreaterThan(0);
      expect(d.target_resolution.status).toBe("matched_in_scope");
    }
    expect(exec.calls).toBe(0);
  });

  it("REVIEW and DENY surface distinguishable decisions", async () => {
    const policy = await compilePolicy(makeFacts());
    const reviewPolicy = await compilePolicy(partialFacts());
    const exec = new CountingExecutor();

    const reviewErr = await runWithGuard({
      policy: reviewPolicy,
      action: makeAction(),
      execute: exec.run,
    }).catch((e: unknown) => e);
    const denyErr = await runWithGuard({
      policy,
      action: dosAction(),
      execute: exec.run,
    }).catch((e: unknown) => e);

    expect(reviewErr).toBeInstanceOf(ScopeGuardBlocked);
    expect(denyErr).toBeInstanceOf(ScopeGuardBlocked);
    expect((reviewErr as ScopeGuardBlocked).decision.decision).toBe("REVIEW");
    expect((denyErr as ScopeGuardBlocked).decision.decision).toBe("DENY");
    expect(exec.calls).toBe(0);
  });

  it("executor failure after ALLOW propagates as the executor's own error", async () => {
    const boom = new Error("executor exploded");
    const exec = new CountingExecutor<never>(() => {
      throw boom;
    });
    const policy = await compilePolicy(makeFacts());
    await expect(
      runWithGuard({ policy, action: makeAction(), execute: exec.run }),
    ).rejects.toBe(boom);
    // Authorization was granted and stayed granted — the failure is
    // execution-side, never reclassified as REVIEW/DENY.
    expect(exec.calls).toBe(1);
  });

  it("an executor returning undefined still reports executed", async () => {
    const exec = new CountingExecutor<undefined>(() => undefined);
    const policy = await compilePolicy(makeFacts());
    const res = await runWithGuard({
      policy,
      action: makeAction(),
      execute: exec.run,
    });
    expect(res.executed).toBe(true);
    expect(res.result).toBeUndefined();
    expect(exec.calls).toBe(1);
  });
});

describe("retry composition — retries can never bypass the gate", () => {
  /**
   * Model B: every attempt re-enters the gate. A blocked or failed
   * authorization ends the loop immediately — there is nothing to retry.
   */
  async function retrying<T>(
    attempts: () => Parameters<typeof runWithGuard<T>>[0],
    maxAttempts = 3,
  ): Promise<unknown> {
    let last: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await runWithGuard<T>(attempts());
      } catch (err) {
        if (
          err instanceof ScopeGuardBlocked ||
          err instanceof ScopeGuardEvaluationError
        ) {
          throw err; // authorization failure is terminal — never retried
        }
        last = err; // executor-side failure may retry
      }
    }
    throw last;
  }

  it("ALLOW + flaky executor: bounded retries, each attempt re-authorized", async () => {
    let attempts = 0;
    const exec = new CountingExecutor<string>(() => {
      attempts++;
      if (attempts < 3) throw new Error("flaky");
      return "ok";
    });
    const policy = await compilePolicy(makeFacts());
    const res = await retrying<string>(() => ({
      policy,
      action: makeAction(),
      execute: exec.run,
    }));
    expect((res as { result: string }).result).toBe("ok");
    expect(exec.calls).toBe(3); // bounded by maxAttempts, never unbounded
  });

  it("REVIEW: zero first attempt, zero retries", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(partialFacts());
    await expect(
      retrying(() => ({ policy, action: makeAction(), execute: exec.run })),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("DENY: zero retries", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    await expect(
      retrying(() => ({ policy, action: dosAction(), execute: exec.run })),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("guard error: zero retries", async () => {
    const exec = new CountingExecutor();
    const brokenPolicy = {} as never;
    await expect(
      retrying(() => ({
        policy: brokenPolicy,
        action: makeAction(),
        execute: exec.run,
      })),
    ).rejects.toBeInstanceOf(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });
});

describe("fail-closed semantics — unknowns and planner claims never execute", () => {
  const verified = (
    key: string,
    value: string | number | boolean,
  ): ContextFact => ({
    key,
    value,
    source: "runtime",
    verification: "verified",
  });

  const rapydLikeFacts = makeFacts({
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
  const crossAccount = makeAction({
    technique: { id: "cross_account_testing" },
  });

  it("verified account.ownership='unknown' → REVIEW → zero executions", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(rapydLikeFacts);
    await expect(
      runWithGuard({
        policy,
        action: crossAccount,
        trustedContext: [
          verified("account.ownership", "unknown"),
          verified("data.ownership", "researcher"),
          verified("data.sensitivity", "none"),
        ],
        execute: exec.run,
      }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("planner-asserted authorization → REVIEW → zero executions", async () => {
    const exec = new CountingExecutor();
    const facts = makeFacts({
      scope_inventory: { in_scope: [], out_of_scope: [target("t_oos", "blocked.example.com")] },
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
    const policy = await compilePolicy(facts);
    const action = makeAction({
      target: { url: "https://blocked.example.com/" },
      context_facts: [
        {
          key: "authorization.prior_written_consent",
          value: true,
          source: "planner",
          verification: "asserted",
        },
      ],
    });
    await expect(
      runWithGuard({ policy, action, execute: exec.run }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("unknown technique → REVIEW → zero executions", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    await expect(
      runWithGuard({
        policy,
        action: makeAction({ technique: { id: "quantum_injection" } }),
        execute: exec.run,
      }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("unlisted target → DENY → zero executions", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    await expect(
      runWithGuard({
        policy,
        action: makeAction({ target: { url: "https://elsewhere.org/" } }),
        execute: exec.run,
      }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("engagement mismatch → REVIEW → zero executions", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    await expect(
      runWithGuard({
        policy,
        action: makeAction({ engagement: { code: "other-program" } }),
        execute: exec.run,
      }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });
});

describe("audit hook — every gate outcome is recorded without payload data", () => {
  it("records block and execute outcomes with hashes and ids only", async () => {
    const records: GuardAuditRecord[] = [];
    const audit = (r: GuardAuditRecord) => {
      records.push(r);
    };
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());

    await expect(
      runWithGuard({
        policy,
        action: dosAction(),
        execute: exec.run,
        metadata: {
          audit,
          executor_id: "ex-1",
          correlation_id: "corr-block",
        },
      }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decision: "DENY",
      executed: false,
      executor_id: "ex-1",
      correlation_id: "corr-block",
      target_status: "matched_in_scope",
    });
    expect(records[0]!.decision_hash).toMatch(/^sha256:/);
    expect(records[0]!.policy_hash).toMatch(/^sha256:/);
    expect(records[0]!.action_hash).toMatch(/^sha256:/);
    expect(records[0]!.reason_codes).toContain("TECHNIQUE_PROHIBITED");
    // No action body or executor payload leaks into the audit record —
    // only hashes, codes, and correlation ids.
    expect(JSON.stringify(records[0])).not.toContain("example.com");
    expect(JSON.stringify(records[0])).not.toContain('"result"');

    const res = await runWithGuard({
      policy,
      action: makeAction(),
      execute: exec.run,
      metadata: { audit, executor_id: "ex-1" },
    });
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ decision: "ALLOW", executed: true });
    expect(records[1]!.decision_hash).toBe(res.decision.decision_hash);
    expect(exec.calls).toBe(1);
  });

  it("a failing audit hook fails closed — zero executions even on ALLOW", async () => {
    const exec = new CountingExecutor();
    const policy = await compilePolicy(makeFacts());
    await expect(
      runWithGuard({
        policy,
        action: makeAction(),
        execute: exec.run,
        metadata: {
          audit: () => {
            throw new Error("audit sink down");
          },
        },
      }),
    ).rejects.toBeInstanceOf(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });
});

describe("prepared executions — the authorized action is the executed action", () => {
  interface Input {
    url: string;
    technique: string;
  }

  const mapInput = (input: Input): ProposedAction => ({
    schema_version: 1,
    engagement: { code: "prog" },
    target: { url: input.url },
    technique: { id: input.technique },
    operation: { kind: "send", destructive: false },
  });

  const httpAdapter = (
    exec: CountingExecutor,
  ): ExecutionAdapter<Input, string> => ({
    // prepare() normalizes once — the execute closure captures the same
    // values the ProposedAction was built from (never re-reads `input`).
    prepare: (input) => {
      const url = input.url;
      const technique = input.technique;
      return {
        proposedAction: mapInput({ url, technique }),
        execute: () => exec.run(url),
      };
    },
  });

  it("guardWrap(adapter, env): ALLOW executes through the adapter", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(makeFacts());
    const guarded = guardWrap(httpAdapter(exec), env);
    const res = await guarded({ url: "https://app.example.com/", technique: "xss" });
    expect(res.executed).toBe(true);
    expect(exec.calls).toBe(1);
    expect(exec.payloads).toEqual(["https://app.example.com/"]);
  });

  it("guardWrap(adapter, env): REVIEW blocks before prepare output can execute", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(partialFacts());
    const guarded = guardWrap(httpAdapter(exec), env);
    await expect(
      guarded({ url: "https://app.example.com/", technique: "xss" }),
    ).rejects.toBeInstanceOf(ScopeGuardBlocked);
    expect(exec.calls).toBe(0);
  });

  it("executeAdapter is the one-shot form of guardWrap", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(makeFacts());
    const res = await executeAdapter(
      httpAdapter(exec),
      { url: "https://app.example.com/", technique: "xss" },
      env,
    );
    expect(res.result).toBe("executed");
    expect(exec.calls).toBe(1);
  });

  it("input mutation after prepare cannot change what executes (TOCTOU)", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(makeFacts());
    const input: Input = { url: "https://app.example.com/", technique: "xss" };
    const prepared = prepareExecution(httpAdapter(exec), input);

    // Planner mutates the shared input after preparation — the frozen plan
    // must still evaluate and execute the originally prepared action.
    input.url = "https://elsewhere.org/";

    const res = await runPrepared(prepared, env);
    expect(exec.calls).toBe(1);
    expect(exec.payloads).toEqual(["https://app.example.com/"]);
    expect(res.decision.target_resolution.input).toBe(
      "https://app.example.com/",
    );
    expect(res.decision.decision).toBe("ALLOW");
  });

  it("the prepared ProposedAction is deeply frozen", async () => {
    const exec = new CountingExecutor();
    const prepared = prepareExecution(httpAdapter(exec), {
      url: "https://app.example.com/",
      technique: "xss",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.proposedAction)).toBe(true);
    expect(Object.isFrozen(prepared.proposedAction.target)).toBe(true);
    expect(
      () =>
        ((prepared as { proposedAction: unknown }).proposedAction = {} as never),
    ).toThrow(TypeError);
    expect(
      () =>
        ((prepared.proposedAction.target as { url: string }).url =
          "https://elsewhere.org/"),
    ).toThrow(TypeError);
  });

  it("an adapter that cannot map deterministically fails closed", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(makeFacts());
    const undeterminable: ExecutionAdapter<Input, string> = {
      prepare: () => {
        throw new Error("cannot determine technique for input");
      },
    };
    const prepared_call = () =>
      prepareExecution(undeterminable, {
        url: "https://app.example.com/",
        technique: "xss",
      });
    expect(prepared_call).toThrow(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });

  it("an adapter producing a malformed action fails closed at the gate", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(makeFacts());
    const bad: ExecutionAdapter<Input, string> = {
      prepare: () =>
        ({
          proposedAction: { schema_version: 1 } as ProposedAction,
          execute: () => exec.run(),
        }) as PreparedExecution<string>,
    };
    expect(() =>
      prepareExecution(bad, {
        url: "https://app.example.com/",
        technique: "xss",
      }),
    ).toThrow(ScopeGuardEvaluationError);
    expect(exec.calls).toBe(0);
  });

  it("runPrepared revalidates: a tampered plan is rejected before execution", async () => {
    const exec = new CountingExecutor();
    const env = await envFor(makeFacts());
    // Simulate a plan built by untrusted means — bypasses prepareExecution's
    // own validation, so runPrepared must still catch the malformed action.
    const plan = {
      proposedAction: { schema_version: 1 } as unknown as ProposedAction,
      execute: () => exec.run(),
    } as PreparedExecution<string>;
    await expect(runPrepared(plan, env)).rejects.toBeInstanceOf(
      ScopeGuardEvaluationError,
    );
    expect(exec.calls).toBe(0);
  });
});
