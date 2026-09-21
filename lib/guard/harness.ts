import type { GuardDecision } from "./types.ts";
import { ScopeGuardBlocked } from "./types.ts";

/**
 * Execution-gate abstraction. The hard invariant lives here and nowhere
 * else: `decision === "ALLOW" && execution_allowed === true`. DENY and
 * REVIEW are both blocking — never write `if (decision !== "DENY")`.
 */

export { ScopeGuardBlocked };

export interface GateResult<T> {
  decision: GuardDecision;
  /** Present only when the decision was ALLOW and the executor ran. */
  value?: T;
  executed: boolean;
}

/**
 * Evaluate-and-maybe-run: `executor` is invoked only when the decision
 * allows execution. The decision is always returned for the audit trail.
 * Throws nothing on block by default — callers see `executed: false`.
 */
export async function runWithGuard<T>(
  evaluate: () => GuardDecision | Promise<GuardDecision>,
  executor: () => T | Promise<T>,
  opts: { throwOnBlock?: boolean } = {},
): Promise<GateResult<T>> {
  const decision = await evaluate();
  if (decision.decision !== "ALLOW" || decision.execution_allowed !== true) {
    if (opts.throwOnBlock === true) throw new ScopeGuardBlocked(decision);
    return { decision, executed: false };
  }
  return { decision, value: await executor(), executed: true };
}

/**
 * Wrap an executor behind a fixed decision source — the call shape the
 * harness uses per action:
 *
 *   const guarded = guardWrap(decision, executor);
 *   await guarded(); // throws ScopeGuardBlocked unless ALLOW
 */
export function guardWrap<T>(
  decision: GuardDecision,
  executor: () => T | Promise<T>,
): () => Promise<T> {
  return async () => {
    if (decision.decision !== "ALLOW" || decision.execution_allowed !== true) {
      throw new ScopeGuardBlocked(decision);
    }
    return executor();
  };
}
