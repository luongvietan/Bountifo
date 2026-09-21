import {
  compileCondition,
  compileRule,
  type GuardConstraint,
  type GuardPredicate,
} from "./conditions.ts";
import { policyHash } from "./hash.ts";
import { canonicalTechniqueId, techniquesMentionedIn } from "./techniques.ts";
import type { AgentFacts, AgentFactsTarget } from "./types.ts";
import type { ScopeInventoryInput } from "./targets.ts";

/**
 * PolicyIR — the compiled, evaluation-friendly form of Agent Facts. Agent
 * Facts stay the source of truth; this is a deterministic projection that
 * resolves technique keys to canonical ids and conditions to typed
 * predicates. Nothing speculative is persisted here.
 */

export interface IrTechniqueRule {
  key: string;
  canonical: string | null;
  status: "allowed" | "prohibited" | "conditional" | "unspecified";
  predicates: GuardPredicate[];
  applies_to: {
    type: "all_targets" | "target_ids" | "target_group_ids" | "engagement";
    ids?: string[];
  };
  evidence_refs: string[];
  conflict_detected: boolean;
}

export interface IrVrtRule {
  category: string;
  canonical: string | null;
  applies_to: string | null;
  status: string;
  note: string | null;
  evidence_refs: string[];
}

export interface IrExclusion {
  text: string;
  techniques: string[];
  submission_status: string;
  testing_status: string;
  reward_status: string;
  evidence_refs: string[];
}

export interface PolicyIR {
  engagement_code: string | null;
  integrity: {
    collection_status: string | null;
    evidence_hash_valid: boolean | null;
    known_issues_counts_valid: boolean | null;
    required_sections_complete: boolean | null;
    unresolved_conflicts: number | null;
  };
  safe_harbor: { status: string | null; evidence_refs: string[] };
  inventory: Required<ScopeInventoryInput> | null;
  groups: Record<
    string,
    { name: string; in_scope: boolean; evidence_refs: string[] }
  >;
  authorized_scope: {
    listed_status: string;
    listed_predicates: GuardPredicate[];
    unlisted_status: string;
    evidence_refs: string[];
  } | null;
  techniques: IrTechniqueRule[];
  vrt_rules: IrVrtRule[];
  exclusions: IrExclusion[];
  account_constraints: GuardConstraint[];
  data_constraints: GuardConstraint[];
  /** Diagnostics emitted during compilation (e.g. SCOPE_INVENTORY_UNAVAILABLE). */
  diagnostics: string[];
}

export interface CompiledPolicy {
  ir: PolicyIR;
  policy_hash: string;
}

/** Compile Agent Facts into PolicyIR + a canonical policy hash. */
export async function compilePolicy(facts: AgentFacts): Promise<CompiledPolicy> {
  const diagnostics: string[] = [];

  const inventory =
    facts.scope_inventory === undefined
      ? null
      : {
          in_scope: facts.scope_inventory.in_scope ?? [],
          out_of_scope: facts.scope_inventory.out_of_scope ?? [],
        };
  if (inventory === null) diagnostics.push("SCOPE_INVENTORY_UNAVAILABLE");

  const groups: PolicyIR["groups"] = {};
  for (const g of facts.scope_groups ?? []) {
    groups[g.id] = {
      name: g.name,
      in_scope: g.in_scope,
      evidence_refs: g.evidence_refs ?? [],
    };
  }

  const techniques: IrTechniqueRule[] = Object.entries(facts.techniques ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, fact]) => ({
      key,
      canonical: canonicalTechniqueId(key),
      status: fact.status,
      predicates: (fact.conditions ?? []).map((c) => compileCondition(c.text)),
      applies_to: fact.applies_to ?? { type: "engagement" },
      evidence_refs: fact.evidence_refs ?? [],
      conflict_detected: fact.conflict?.detected === true,
    }));

  const vrtRules: IrVrtRule[] = (facts.vrt_scope_rules ?? []).map((rule) => ({
    category: rule.category,
    canonical: canonicalTechniqueId(rule.category),
    applies_to: rule.applies_to ?? null,
    status: rule.status,
    note: rule.note ?? null,
    evidence_refs: rule.evidence_refs ?? [],
  }));

  const exclusions: IrExclusion[] = (facts.submission_exclusions ?? []).map(
    (e) => ({
      text: e.text,
      techniques: techniquesMentionedIn(e.text),
      submission_status: e.submission_status,
      testing_status: e.testing_status,
      reward_status: e.reward_status ?? "unspecified",
      evidence_refs: e.evidence_refs ?? [],
    }),
  );

  const accountConstraints = (facts.account_rules ?? []).map((rule) =>
    compileRule(rule.text, rule.evidence_refs ?? []),
  );
  const dataConstraints = (facts.data_rules ?? []).map((rule) =>
    compileRule(rule.text, rule.evidence_refs ?? []),
  );

  const scope = facts.authorized_scope;
  const authorizedScope: PolicyIR["authorized_scope"] =
    scope === null || scope === undefined
      ? null
      : {
          listed_status: scope.listed_targets.status,
          listed_predicates: (scope.listed_targets.conditions ?? []).map(
            compileCondition,
          ),
          unlisted_status: scope.unlisted_targets.status,
          evidence_refs: scope.evidence_refs ?? [],
        };

  const ir: PolicyIR = {
    engagement_code: facts.engagement?.code ?? null,
    integrity: {
      collection_status: facts.collection?.status ?? null,
      evidence_hash_valid: facts.integrity?.evidence_hash_valid ?? null,
      known_issues_counts_valid:
        facts.integrity?.known_issues_counts_valid ?? null,
      required_sections_complete:
        facts.integrity?.required_sections_complete ?? null,
      unresolved_conflicts: facts.policy?.unresolved_conflicts ?? null,
    },
    safe_harbor: {
      status: facts.safe_harbor?.status ?? null,
      evidence_refs: facts.safe_harbor?.evidence_refs ?? [],
    },
    inventory,
    groups,
    authorized_scope: authorizedScope,
    techniques,
    vrt_rules: vrtRules,
    exclusions,
    account_constraints: accountConstraints,
    data_constraints: dataConstraints,
    diagnostics,
  };

  return { ir, policy_hash: await policyHash(facts) };
}

/** Group ids a resolved target belongs to (for `target_group_ids` rules). */
export function targetGroupIds(
  ir: PolicyIR,
  targetId: string | undefined,
): string[] {
  if (targetId === undefined || ir.inventory === null) return [];
  const all: AgentFactsTarget[] = [
    ...ir.inventory.in_scope,
    ...ir.inventory.out_of_scope,
  ];
  return all.find((t) => t.target_id === targetId)?.scope_group_ids ?? [];
}
