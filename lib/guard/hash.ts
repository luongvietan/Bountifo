import { canonicalJson } from "../canonical.ts";
import { sha256Hex } from "../hash.ts";
import { GUARD_ENGINE_VERSION, type GuardDecision } from "./types.ts";

/**
 * Deterministic hashes over canonical JSON. `evaluated_at`, runtime ids and
 * other volatile values never enter a preimage — two identical evaluations
 * produce identical hashes.
 */

export async function policyHash(policyPreimage: unknown): Promise<string> {
  return `sha256:${await sha256Hex(`scope-guard-policy-v1:${canonicalJson(policyPreimage)}`)}`;
}

export async function actionHash(action: unknown): Promise<string> {
  return `sha256:${await sha256Hex(`scope-guard-action-v1:${canonicalJson(action)}`)}`;
}

/** Decision-relevant output only — timestamp and transient fields excluded. */
export function decisionPreimage(
  decision: Pick<
    GuardDecision,
    | "decision"
    | "reason_codes"
    | "checks"
    | "target_resolution"
    | "eligibility"
    | "unresolved_requirements"
  >,
  policyHashValue: string,
  actionHashValue: string,
): string {
  return canonicalJson({
    engine: GUARD_ENGINE_VERSION,
    policy_hash: policyHashValue,
    action_hash: actionHashValue,
    decision: decision.decision,
    reason_codes: [...decision.reason_codes].sort(),
    checks: decision.checks,
    target_resolution: decision.target_resolution,
    eligibility: decision.eligibility,
    unresolved_requirements: decision.unresolved_requirements,
  });
}

export async function decisionHash(preimage: string): Promise<string> {
  return `sha256:${await sha256Hex(`scope-guard-decision-v1:${preimage}`)}`;
}
