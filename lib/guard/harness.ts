import { evaluateAction, type EvaluateOptions } from "./evaluator.ts";
import type { CompiledPolicy } from "./policy.ts";
import {
  proposedActionSchema,
  ScopeGuardBlocked,
  type ContextFact,
  type GuardDecision,
  type GuardDecisionType,
  type GuardReasonCode,
  type ProposedAction,
} from "./types.ts";

/**
 * The canonical execution gate — the only sanctioned path from a
 * ProposedAction to a side effect. The invariant lives here and nowhere
 * else:
 *
 *   const decision = evaluateAction(policy, action, trustedContext);
 *   if (decision.execution_allowed !== true) throw new ScopeGuardBlocked(decision);
 *   return execute();
 *
 * REVIEW and DENY are both blocking — never write `decision !== "DENY"`.
 * Guard-side failures (malformed action, evaluation throw, adapter that
 * cannot map an input deterministically, audit-hook failure) raise
 * ScopeGuardEvaluationError. Every failure mode fails closed: zero side
 * effects.
 */

export { ScopeGuardBlocked };

/**
 * A guard-side failure — distinct from a policy decision: the action could
 * not be validated, evaluation itself threw, or the audit hook failed.
 * Carries no decision because none was legitimately produced; blocking
 * behavior is identical to DENY/REVIEW.
 */
export class ScopeGuardEvaluationError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ScopeGuardEvaluationError";
    this.cause = options?.cause;
  }
}

/**
 * One record per gate decision — blocked and executed alike. Hashes, reason
 * codes, and correlation ids only: no action body, no executor payload, no
 * credential material may appear here.
 */
export interface GuardAuditRecord {
  decision_hash: string;
  policy_hash: string;
  action_hash: string;
  decision: GuardDecisionType;
  reason_codes: GuardReasonCode[];
  target_status: string;
  executor_id?: string;
  correlation_id?: string;
  executed: boolean;
}

export interface GuardedExecutionResult<T> {
  decision: GuardDecision;
  /** Always true on return — a blocked decision throws instead. */
  executed: boolean;
  result?: T;
  /** Execution bookkeeping; volatile values live here, never in hashes. */
  execution?: {
    executor_id?: string;
    correlation_id?: string;
    started_at: string;
    completed_at?: string;
  };
}

export interface RunWithGuardParams<T> {
  policy: CompiledPolicy;
  /**
   * The canonical action under authorization. It is re-validated against
   * the strict schema inside the gate — the evaluated object is a fresh
   * copy, so a caller mutating its own reference cannot change what was
   * authorized.
   */
  action: ProposedAction;
  trustedContext?: ContextFact[];
  /** Deterministic evaluation clock (ISO-8601) — tests only. */
  now?: string;
  /**
   * The side effect. Invoked only after an ALLOW decision; the gate never
   * injects parameters — the closure must capture the same values the
   * action was built from (see `prepareExecution`).
   */
  execute: () => T | Promise<T>;
  metadata?: {
    executor_id?: string;
    correlation_id?: string;
    /**
     * Optional audit sink, invoked once per decision — including blocked
     * ones (executed: false). A throwing hook fails closed: the executor
     * is never reached.
     */
    audit?: (record: GuardAuditRecord) => void;
  };
}

function invalidActionMessage(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/**
 * Evaluate-and-maybe-run. Evaluation happens inside the gate, immediately
 * before the effect, on a schema-validated copy of the action — the action
 * that was authorized is the action that runs. Blocks throw; they never
 * return a skippable "not executed" marker.
 */
export async function runWithGuard<T>(
  params: RunWithGuardParams<T>,
): Promise<GuardedExecutionResult<T>> {
  const parsed = proposedActionSchema.safeParse(params.action);
  if (!parsed.success) {
    throw new ScopeGuardEvaluationError(
      `invalid ProposedAction: ${invalidActionMessage(parsed.error.issues)}`,
    );
  }

  const opts: EvaluateOptions = {};
  if (params.trustedContext !== undefined) opts.trustedContext = params.trustedContext;
  if (params.now !== undefined) opts.now = params.now;

  let decision: GuardDecision;
  try {
    decision = await evaluateAction(params.policy, parsed.data, opts);
  } catch (err) {
    throw new ScopeGuardEvaluationError("guard evaluation failed", {
      cause: err,
    });
  }

  const record: GuardAuditRecord = {
    decision_hash: decision.decision_hash,
    policy_hash: decision.policy_hash,
    action_hash: decision.action_hash,
    decision: decision.decision,
    reason_codes: decision.reason_codes,
    target_status: decision.target_resolution.status,
    executed: decision.execution_allowed,
  };
  if (params.metadata?.executor_id !== undefined) {
    record.executor_id = params.metadata.executor_id;
  }
  if (params.metadata?.correlation_id !== undefined) {
    record.correlation_id = params.metadata.correlation_id;
  }
  try {
    params.metadata?.audit?.(record);
  } catch (err) {
    throw new ScopeGuardEvaluationError("guard audit hook failed", {
      cause: err,
    });
  }

  if (decision.execution_allowed !== true) {
    throw new ScopeGuardBlocked(decision);
  }

  const startedAt = new Date().toISOString();
  const result = await params.execute();
  return {
    decision,
    executed: true,
    result,
    execution: {
      executor_id: params.metadata?.executor_id,
      correlation_id: params.metadata?.correlation_id,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Executor adapters. The adapter owns the deterministic mapping from raw
// operation input to ProposedAction — never the planner, never an LLM. If a
// field cannot be determined safely, `prepare` must throw (fail closed) or
// emit a value that evaluates to unknown → REVIEW; it must never guess a
// permission-relevant field.
// ---------------------------------------------------------------------------

/**
 * A normalized operation ready for the gate: the ProposedAction that will be
 * evaluated and the closure that performs exactly that action. Both derive
 * from the same normalized input inside `prepare` — that is what makes the
 * authorized action and the executed action the same one.
 */
export interface PreparedExecution<T> {
  readonly proposedAction: ProposedAction;
  readonly execute: () => T | Promise<T>;
}

export interface ExecutionAdapter<I, T> {
  prepare(input: I): PreparedExecution<T>;
}

/** The fixed environment a guarded executor operates under. */
export interface GuardEnvironment {
  policy: CompiledPolicy;
  trustedContext?: ContextFact[];
  now?: string;
  executor_id?: string;
  audit?: (record: GuardAuditRecord) => void;
}

function deepFreeze(value: unknown, seen: Set<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const v of Object.values(value)) deepFreeze(v, seen);
  Object.freeze(value);
}

/**
 * Build a prepared execution: run the adapter, validate the proposed action
 * against the strict schema, and deep-freeze it. The returned plan is
 * immutable — after `prepareExecution`, nothing the caller does to `input`
 * or the plan can change what the gate evaluates or the closure executes.
 */
export function prepareExecution<I, T>(
  adapter: ExecutionAdapter<I, T>,
  input: I,
): PreparedExecution<T> {
  let prepared: PreparedExecution<T>;
  try {
    prepared = adapter.prepare(input);
  } catch (err) {
    throw new ScopeGuardEvaluationError(
      "execution adapter could not prepare a determinable action",
      { cause: err },
    );
  }
  if (typeof prepared?.execute !== "function") {
    throw new ScopeGuardEvaluationError(
      "execution adapter returned no execute closure",
    );
  }
  const parsed = proposedActionSchema.safeParse(prepared.proposedAction);
  if (!parsed.success) {
    throw new ScopeGuardEvaluationError(
      `adapter produced invalid ProposedAction: ${invalidActionMessage(parsed.error.issues)}`,
    );
  }
  deepFreeze(parsed.data, new Set());
  return Object.freeze({
    proposedAction: parsed.data,
    execute: prepared.execute,
  });
}

/**
 * Run a previously prepared execution through the gate. The plan's action
 * is re-validated (a plan assembled outside `prepareExecution` gets the same
 * checks) and evaluated as-is — exactly what the closure will perform.
 */
export function runPrepared<T>(
  prepared: PreparedExecution<T>,
  env: GuardEnvironment,
  correlation_id?: string,
): Promise<GuardedExecutionResult<T>> {
  return runWithGuard({
    policy: env.policy,
    action: prepared.proposedAction,
    trustedContext: env.trustedContext,
    now: env.now,
    execute: prepared.execute,
    metadata: {
      executor_id: env.executor_id,
      correlation_id,
      audit: env.audit,
    },
  });
}

/**
 * Ergonomic wrapper: `input → prepare → gate → execute` in one call shape.
 *
 *   const guarded = guardWrap(httpAdapter, env);
 *   await guarded({ url, technique: "xss" });  // throws ScopeGuardBlocked
 *                                              // unless ALLOW
 */
export function guardWrap<I, T>(
  adapter: ExecutionAdapter<I, T>,
  env: GuardEnvironment,
): (input: I, correlation_id?: string) => Promise<GuardedExecutionResult<T>> {
  return (input, correlation_id) =>
    runPrepared(prepareExecution(adapter, input), env, correlation_id);
}

/** One-shot form of {@link guardWrap}. */
export function executeAdapter<I, T>(
  adapter: ExecutionAdapter<I, T>,
  input: I,
  env: GuardEnvironment,
  correlation_id?: string,
): Promise<GuardedExecutionResult<T>> {
  return runPrepared(prepareExecution(adapter, input), env, correlation_id);
}
