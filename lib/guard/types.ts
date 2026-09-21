import { z } from "zod";

/**
 * Scope Guard wire contracts. The gate is deterministic: no LLM, no network,
 * no inferred policy. `ProposedAction` is the only input a planner controls;
 * it deliberately carries no bypass fields (`skip_scope_guard`, `force`,
 * `authorized`, `override`, ...) and the schema rejects unknown keys.
 */

export const GUARD_SCHEMA_VERSION = 1;
export const GUARD_ENGINE_VERSION = "scope-guard/1.0.0";

export type GuardDecisionType = "ALLOW" | "DENY" | "REVIEW";

// ---------------------------------------------------------------------------
// Trusted context. A contextual attestation only satisfies a condition when
// it is verified AND does not come from the planner itself; planner-asserted
// values can still fail a condition (a declared violation is a DENY).
// ---------------------------------------------------------------------------

export const contextFactSchema = z
  .object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    source: z.enum(["runtime", "user", "program", "tool", "planner"]),
    verification: z.enum(["verified", "asserted", "unknown"]),
  })
  .strict();
export type ContextFact = z.infer<typeof contextFactSchema>;

export const proposedActionSchema = z
  .object({
    schema_version: z.literal(GUARD_SCHEMA_VERSION),
    engagement: z.object({ code: z.string().min(1) }).strict(),
    target: z
      .object({
        url: z.string().min(1),
        target_id: z.string().min(1).optional(),
      })
      .strict(),
    technique: z
      .object({
        id: z.string().min(1),
        label: z.string().optional(),
      })
      .strict(),
    operation: z
      .object({
        kind: z.enum([
          "read",
          "write",
          "create",
          "update",
          "delete",
          "upload",
          "send",
          "execute",
          "authenticate",
          "scan",
          "other",
        ]),
        destructive: z.boolean().optional(),
        external_side_effect: z.boolean().optional(),
      })
      .strict(),
    automation: z
      .object({
        automated: z.boolean(),
        scanner: z.boolean().optional(),
        tool_type: z.string().optional(),
        estimated_requests: z.number().nonnegative().optional(),
        estimated_requests_per_minute: z.number().nonnegative().optional(),
        requests_per_second: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    credentials: z
      .object({
        source: z.enum([
          "none",
          "own",
          "program_issued",
          "public",
          "third_party",
          "leaked",
          "unknown",
        ]),
      })
      .strict()
      .optional(),
    account: z
      .object({
        ownership: z.enum([
          "researcher",
          "explicitly_authorized",
          "third_party",
          "unknown",
        ]),
      })
      .strict()
      .optional(),
    data: z
      .object({
        ownership: z.enum([
          "researcher",
          "test",
          "customer",
          "employee",
          "explicitly_authorized",
          "third_party",
          "unknown",
        ]),
        sensitivity: z
          .enum([
            "none",
            "personal",
            "credentials",
            "financial",
            "customer",
            "confidential",
            "unknown",
          ])
          .optional(),
      })
      .strict()
      .optional(),
    context_facts: z.array(contextFactSchema).optional(),
  })
  .strict();
export type ProposedAction = z.infer<typeof proposedActionSchema>;

// ---------------------------------------------------------------------------
// Agent Facts (exporter output — parsed, never inferred). Fields that V1
// dossiers may lack are optional; missing scope data degrades to REVIEW.
// ---------------------------------------------------------------------------

export interface AgentFactsTarget {
  target_id: string;
  location: string | null;
  name: string | null;
  category: string | null;
  scope_group_ids: string[];
  evidence_refs: string[];
  notes?: string | null;
}

export interface AgentFactsScopeGroup {
  id: string;
  name: string;
  in_scope: boolean;
  evidence_refs: string[];
}

export interface AgentFactsFact {
  status: "allowed" | "prohibited" | "conditional" | "unspecified";
  conditions?: { id: string; text: string }[];
  applies_to?: {
    // Known values below; `(string & {})` keeps the union suggestible while
    // tolerating future types — the evaluator fails closed on unknown ones.
    type:
      | "all_targets"
      | "target_ids"
      | "target_group_ids"
      | "engagement"
      | "conditional_context"
      | (string & {});
    ids?: string[];
    conditions?: (
      | { kind: "phase"; value: "post_compromise" }
      | { kind: "antecedent_text"; text: string }
    )[];
  };
  evidence_refs?: string[];
  conflict?: {
    detected: boolean;
    evidence_refs?: string[];
    asserted_statuses?: string[];
  };
  resolution?: { status: string };
}

export interface AgentFacts {
  agent_facts_schema_version?: number;
  engagement?: { code?: string };
  techniques?: Record<string, AgentFactsFact>;
  submission_exclusions?: {
    text: string;
    submission_status: string;
    testing_status: string;
    reward_status?: string;
    evidence_refs?: string[];
  }[];
  authorized_scope?: {
    listed_targets: { status: string; conditions?: string[] };
    unlisted_targets: { status: string };
    /**
     * Consent carve-outs for otherwise unlisted/OOS targets. Metadata for
     * evaluation — an exception never asserts permission by itself.
     */
    exceptions?: {
      applies_to:
        | "unlisted_targets"
        | "out_of_scope_targets"
        | "target_ids"
        | "target_group_ids"
        | string;
      ids?: string[];
      condition:
        | {
            kind: "prior_written_consent";
            issuer?: string;
            verification_required?: boolean;
          }
        | { kind: "source_text"; text: string }
        | { kind: string };
      effect: string;
      evidence_refs?: string[];
    }[];
    quote?: string;
    evidence_refs?: string[];
  } | null;
  /**
   * Program/submission operational state, separate from testing
   * authorization. Missing on old dossiers → unknown, never inferred.
   */
  program_state?: {
    submission_state?: string;
    testing_state?: string;
    reward_state?: string;
    effective_at_text?: string | null;
    resume_at?: string | null;
    evidence_refs?: string[];
  } | null;
  scope_inventory?: {
    in_scope?: AgentFactsTarget[];
    out_of_scope?: AgentFactsTarget[];
  };
  scope_groups?: AgentFactsScopeGroup[];
  vrt_scope_rules?: {
    category: string;
    vrt_version?: string | null;
    applies_to?: string | null;
    status: string;
    note?: string | null;
    evidence_refs?: string[];
  }[];
  safe_harbor?: {
    status: string;
    level?: string | null;
    evidence_refs?: string[];
  };
  account_rules?: { text: string; evidence_refs?: string[] }[];
  data_rules?: { text: string; evidence_refs?: string[] }[];
  collection?: {
    status: string;
    api_status?: string;
    dom_status?: string;
    [key: string]: unknown;
  };
  integrity?: {
    evidence_hash_valid?: boolean;
    known_issues_counts_valid?: boolean;
    required_sections_complete?: boolean;
  };
  collection_issues?: unknown[];
  policy?: { conflicts_present?: boolean; unresolved_conflicts?: number };
}

// ---------------------------------------------------------------------------
// Decision output.
// ---------------------------------------------------------------------------

export type GuardReasonCode =
  | "ACTION_INVALID"
  | "FACTS_INVALID"
  | "DOSSIER_PARTIAL"
  | "DOSSIER_FAILED"
  | "EVIDENCE_HASH_INVALID"
  | "KNOWN_ISSUES_COUNTS_INVALID"
  | "REQUIRED_SECTIONS_INCOMPLETE"
  | "POLICY_CONFLICT"
  | "SAFE_HARBOR_PRESENT"
  | "SAFE_HARBOR_ABSENT"
  | "SAFE_HARBOR_UNCLEAR"
  | "ENGAGEMENT_MISMATCH"
  | "PROGRAM_SUBMISSIONS_PAUSED"
  | "PROGRAM_TESTING_PROHIBITED"
  | "PROGRAM_TESTING_UNSPECIFIED"
  | "SCOPE_INVENTORY_UNAVAILABLE"
  | "TARGET_IN_SCOPE"
  | "TARGET_OUT_OF_SCOPE"
  | "TARGET_UNLISTED"
  | "TARGET_AMBIGUOUS"
  | "TARGET_ID_UNRESOLVED"
  | "UNLISTED_TARGETS_PROHIBITED"
  | "LISTED_TARGETS_PROHIBITED"
  | "AUTHORIZATION_EXCEPTION_AVAILABLE"
  | "AUTHORIZATION_EXCEPTION_VERIFIED"
  | "AUTHORIZATION_EXCEPTION_UNVERIFIED"
  | "APPLICABILITY_MATCHED"
  | "APPLICABILITY_NOT_MATCHED"
  | "APPLICABILITY_UNRESOLVED"
  | "TECHNIQUE_ALLOWED"
  | "TECHNIQUE_PROHIBITED"
  | "EXCLUSION_TESTING_PROHIBITED"
  | "TECHNIQUE_CONDITIONAL"
  | "TECHNIQUE_UNSPECIFIED"
  | "TECHNIQUE_UNKNOWN"
  | "TECHNIQUE_NO_POLICY"
  | "CONDITION_SATISFIED"
  | "CONDITION_FAILED"
  | "CONDITION_UNRESOLVED"
  | "ACCOUNT_CONSTRAINT_FAILED"
  | "ACCOUNT_CONTEXT_UNVERIFIED"
  | "DATA_CONSTRAINT_FAILED"
  | "DATA_CONTEXT_UNVERIFIED"
  | "CREDENTIAL_SOURCE_PROHIBITED"
  | "CREDENTIAL_SOURCE_UNVERIFIED"
  | "RULE_UNRESOLVED"
  | "VRT_RULE_PROHIBITED"
  | "VRT_RULE_CONDITIONAL"
  | "VRT_RULE_UNRESOLVED"
  | "SUBMISSION_EXCLUDED"
  | "REWARD_INELIGIBLE";

export interface GuardPredicateResult {
  predicate: string;
  result: "true" | "false" | "unknown";
  detail?: string;
}

export interface GuardCheck {
  check:
    | "integrity"
    | "engagement"
    | "safe_harbor"
    | "program_state"
    | "target"
    | "authorized_scope"
    | "authorization_exception"
    | "applicability"
    | "vrt"
    | "technique"
    | "automation"
    | "credentials"
    | "account"
    | "data"
    | "operation"
    | "eligibility";
  result: "pass" | "fail" | "unknown" | "not_applicable";
  reason_code?: GuardReasonCode;
  rule_status?: string;
  detail?: string;
  evidence_refs: string[];
  predicate_results?: GuardPredicateResult[];
}

export type TargetResolutionStatus =
  | "matched_in_scope"
  | "matched_out_of_scope"
  | "unlisted"
  | "ambiguous";

export interface GuardDecision {
  schema_version: 1;
  decision: GuardDecisionType;
  /** `execution_allowed === (decision === "ALLOW")` — the only execution gate. */
  execution_allowed: boolean;
  reason_codes: GuardReasonCode[];
  policy_hash: string;
  action_hash: string;
  decision_hash: string;
  engagement_code: string;
  target_resolution: {
    input: string;
    status: TargetResolutionStatus | "not_evaluated";
    target_id?: string;
    matched_target_ids?: string[];
    evidence_refs?: string[];
  };
  checks: GuardCheck[];
  evidence_refs: string[];
  eligibility: {
    submission: "eligible" | "excluded" | "unknown";
    reward: "eligible" | "ineligible" | "unknown";
  };
  unresolved_requirements: string[];
  evaluated_at: string;
}

/** Thrown by the execution-gate adapter when a decision does not allow run. */
export class ScopeGuardBlocked extends Error {
  readonly decision: GuardDecision;
  constructor(decision: GuardDecision) {
    super(
      `Scope Guard blocked execution: ${decision.decision} (${decision.reason_codes.join(", ")})`,
    );
    this.name = "ScopeGuardBlocked";
    this.decision = decision;
  }
}
