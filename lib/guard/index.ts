import { evaluateAction, type EvaluateOptions } from "./evaluator.ts";
import { parseAgentFacts } from "./parse.ts";
import { compilePolicy } from "./policy.ts";
import {
  proposedActionSchema,
  type AgentFacts,
  type ContextFact,
  type GuardDecision,
  type ProposedAction,
} from "./types.ts";

/**
 * Scope Guard — deterministic execution gate between an AI planner and any
 * execution tool. The planner proposes actions; only this gate decides
 * whether execution is allowed. No LLM, no network, no inferred policy.
 */

export { FactsParseError, parseAgentFacts, extractAgentFactsYaml } from "./parse.ts";
export { compilePolicy, type CompiledPolicy, type PolicyIR } from "./policy.ts";
export { evaluateAction, type EvaluateOptions } from "./evaluator.ts";
export { resolveTarget, type TargetResolution } from "./targets.ts";
export { canonicalTechniqueId, techniquesMentionedIn, CANONICAL_TECHNIQUE_IDS } from "./techniques.ts";
export { compileCondition, compileRule, type GuardPredicate, type GuardConstraint } from "./conditions.ts";
export { policyHash, actionHash, decisionHash, decisionPreimage } from "./hash.ts";
export { runWithGuard, guardWrap, ScopeGuardBlocked } from "./harness.ts";
export {
  GUARD_SCHEMA_VERSION,
  GUARD_ENGINE_VERSION,
  proposedActionSchema,
  contextFactSchema,
  type AgentFacts,
  type AgentFactsTarget,
  type AgentFactsScopeGroup,
  type ContextFact,
  type GuardCheck,
  type GuardDecision,
  type GuardDecisionType,
  type GuardPredicateResult,
  type GuardReasonCode,
  type ProposedAction,
  type TargetResolutionStatus,
} from "./types.ts";

/** Input is structurally unusable — never silently coerced to a decision. */
export class ScopeGuardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeGuardInputError";
  }
}

export interface EvaluateScopeGuardInput {
  /** Parsed object, YAML facts text, or a full Markdown dossier. */
  agentFacts: AgentFacts | string;
  action: unknown;
  trustedContext?: ContextFact[];
  now?: string;
}

/**
 * Compile the policy and evaluate one proposed action. For many actions
 * against the same dossier, prefer `compilePolicy` once + `evaluateAction`
 * per action.
 */
export async function evaluateScopeGuard(
  input: EvaluateScopeGuardInput,
): Promise<GuardDecision> {
  const facts =
    typeof input.agentFacts === "string" || typeof input.agentFacts === "object"
      ? parseAgentFacts(input.agentFacts)
      : input.agentFacts;
  const parsed = proposedActionSchema.safeParse(input.action);
  if (!parsed.success) {
    throw new ScopeGuardInputError(
      `invalid ProposedAction: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const policy = await compilePolicy(facts);
  const opts: EvaluateOptions = { now: input.now };
  if (input.trustedContext !== undefined) {
    opts.trustedContext = input.trustedContext;
  }
  return evaluateAction(policy, parsed.data, opts);
}
