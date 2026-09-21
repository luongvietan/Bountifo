import {
  actionHash,
  decisionHash,
  decisionPreimage,
} from "./hash.ts";
import { canonicalTechniqueId } from "./techniques.ts";
import {
  resolveTarget,
  type TargetResolution,
} from "./targets.ts";
import type { CompiledPolicy, IrTechniqueRule, PolicyIR } from "./policy.ts";
import { targetGroupIds } from "./policy.ts";
import { compileCondition } from "./conditions.ts";
import type {
  GuardConstraint,
  GuardPredicate,
  OwnershipValue,
} from "./conditions.ts";
import {
  GUARD_SCHEMA_VERSION,
  type ContextFact,
  type GuardCheck,
  type GuardDecision,
  type GuardPredicateResult,
  type GuardReasonCode,
  type ProposedAction,
} from "./types.ts";

/**
 * Deterministic evaluation order (spec §13): integrity → engagement → safe
 * harbor → target resolution → authorized scope → VRT → technique →
 * automation overlay → credentials/account/data → eligibility → aggregate.
 * Integrity and engagement failures short-circuit to REVIEW — an untrusted
 * or misattributed policy can neither allow nor semantically deny.
 * No check may convert an existing DENY into ALLOW.
 */

export interface EvaluateOptions {
  /** Harness-supplied attestations, merged with the action's context_facts. */
  trustedContext?: ContextFact[];
  /** Deterministic clock for tests; ISO-8601. */
  now?: string;
}

interface Context {
  action: ProposedAction;
  resolution: TargetResolution | null;
  /** Verified, non-planner attestations — only these may satisfy. */
  trusted: Map<string, (string | number | boolean)[]>;
  /** Planner claims (action fields + unverified/planner-sourced facts). */
  asserted: Map<string, (string | number | boolean)[]>;
}

function push(map: Map<string, (string | number | boolean)[]>, key: string, value: string | number | boolean): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function contextMaps(
  action: ProposedAction,
  trustedContext: ContextFact[],
): Pick<Context, "trusted" | "asserted"> {
  const trusted = new Map<string, (string | number | boolean)[]>();
  const asserted = new Map<string, (string | number | boolean)[]>();
  for (const f of [...(action.context_facts ?? []), ...trustedContext]) {
    // The planner cannot certify its own claims: a fact only satisfies a
    // condition when verified AND coming from a non-planner source.
    const usable = f.verification === "verified" && f.source !== "planner";
    push(usable ? trusted : asserted, f.key, f.value);
  }
  if (action.account !== undefined) {
    push(asserted, "account.ownership", action.account.ownership);
  }
  if (action.credentials !== undefined) {
    push(asserted, "credentials.source", action.credentials.source);
  }
  if (action.data !== undefined) {
    push(asserted, "data.ownership", action.data.ownership);
    if (action.data.sensitivity !== undefined) {
      push(asserted, "data.sensitivity", action.data.sensitivity);
    }
  }
  return { trusted, asserted };
}

type PredOutcome = "true" | "false" | "unknown";

interface PredEval {
  result: PredOutcome;
  /** More specific reason when the generic condition code is misleading. */
  code?: GuardReasonCode;
  detail?: string;
}

/**
 * Resolve an attested value for `key`. Verified non-planner facts satisfy or
 * fail outright; a planner-asserted value that would violate is a declared
 * violation (false → DENY) while one that would satisfy stays unverified
 * (unknown → REVIEW). Conflicting trusted values are unknown.
 */
function attestedValue(
  key: string,
  ctx: Context,
): { trusted: (string | number | boolean)[]; asserted: (string | number | boolean)[] } {
  return {
    trusted: ctx.trusted.get(key) ?? [],
    asserted: ctx.asserted.get(key) ?? [],
  };
}

function ownershipEval(
  key: string,
  allowed: OwnershipValue[],
  ctx: Context,
  unverifiedCode: GuardReasonCode,
  failedCode: GuardReasonCode,
): PredEval {
  const { trusted, asserted } = attestedValue(key, ctx);
  const distinct = new Set(trusted);
  if (distinct.size > 1) {
    return { result: "unknown", code: unverifiedCode, detail: `conflicting trusted ${key}` };
  }
  // A violating value anywhere — verified fact or the action's own declared
  // field — fails the condition. A satisfying attestation can never wash
  // out a declared violation.
  for (const v of [...trusted, ...asserted]) {
    if (v !== "unknown" && !allowed.includes(v as OwnershipValue)) {
      return {
        result: "false",
        code: failedCode,
        detail: `${trusted.includes(v) ? "verified" : "declared"} ${key}=${String(v)}`,
      };
    }
  }
  if (trusted.length > 0) return { result: "true" };
  // Only claims that would satisfy (or silence) remain — unverified.
  return { result: "unknown", code: unverifiedCode, detail: `${key} not verified` };
}

function deniedValueEval(
  key: string,
  denied: string[],
  ctx: Context,
  prohibitedCode: GuardReasonCode,
  unverifiedCode: GuardReasonCode,
): PredEval {
  const { trusted, asserted } = attestedValue(key, ctx);
  const distinct = new Set(trusted);
  if (distinct.size > 1) {
    return { result: "unknown", code: unverifiedCode, detail: `conflicting trusted ${key}` };
  }
  // Same contract as ownershipEval: any denied value — verified or merely
  // declared by the action itself — fails the constraint outright.
  for (const v of [...trusted, ...asserted]) {
    if (v !== "unknown" && denied.includes(String(v))) {
      return {
        result: "false",
        code: prohibitedCode,
        detail: `${trusted.includes(v) ? "verified" : "declared"} ${key}=${String(v)}`,
      };
    }
  }
  if (trusted.length > 0) return { result: "true" };
  if (asserted.length === 0) {
    return { result: "unknown", code: unverifiedCode, detail: `${key} undeclared` };
  }
  return { result: "unknown", code: unverifiedCode, detail: `${key} not verified` };
}

function evalPredicate(pred: GuardPredicate, ctx: Context): PredEval {
  switch (pred.kind) {
    case "target_is_explicitly_listed": {
      const r = ctx.resolution;
      if (r === null) return { result: "unknown", detail: "target unresolved" };
      if (r.status === "matched_in_scope") return { result: "true" };
      if (r.status === "unlisted") {
        return {
          result: "false",
          detail: "target is not in the declared scope inventory",
        };
      }
      return { result: "unknown", detail: `target resolution ${r.status}` };
    }
    case "account_ownership":
      return ownershipEval(
        "account.ownership",
        pred.allowed,
        ctx,
        "ACCOUNT_CONTEXT_UNVERIFIED",
        "ACCOUNT_CONSTRAINT_FAILED",
      );
    case "data_ownership":
      return ownershipEval(
        "data.ownership",
        pred.allowed,
        ctx,
        "DATA_CONTEXT_UNVERIFIED",
        "DATA_CONSTRAINT_FAILED",
      );
    case "prior_authorization": {
      const { trusted, asserted } = attestedValue(
        "authorization.prior_approval",
        ctx,
      );
      if (trusted.some((v) => v === true)) return { result: "true" };
      if (trusted.some((v) => v === false)) return { result: "false" };
      void asserted; // a planner cannot self-certify an approval
      return { result: "unknown", detail: "no verified prior approval" };
    }
    case "non_destructive": {
      const d = ctx.action.operation.destructive;
      if (d === false) return { result: "true" };
      if (d === true) {
        return { result: "false", detail: "action is destructive" };
      }
      return { result: "unknown", detail: "destructive flag undeclared" };
    }
    case "rate_limit": {
      const rps = ctx.action.automation?.requests_per_second;
      const rpm = ctx.action.automation?.estimated_requests_per_minute;
      const effectiveRpm = rps !== undefined ? rps * 60 : rpm;
      if (effectiveRpm === undefined) {
        return { result: "unknown", detail: "request rate undeclared" };
      }
      return effectiveRpm <= pred.max_per_minute
        ? { result: "true" }
        : {
            result: "false",
            detail: `${effectiveRpm} rpm > ${pred.max_per_minute} rpm ceiling`,
          };
    }
    case "unresolved":
      return { result: "unknown", detail: pred.source_text };
  }
}

function predicateResults(
  predicates: GuardPredicate[],
  ctx: Context,
): { results: GuardPredicateResult[]; outcome: PredOutcome; code?: GuardReasonCode } {
  const results: GuardPredicateResult[] = [];
  let outcome: PredOutcome = "true";
  let code: GuardReasonCode | undefined;
  for (const pred of predicates) {
    const r = evalPredicate(pred, ctx);
    results.push({ predicate: pred.kind, result: r.result, detail: r.detail });
    if (r.result === "false") {
      outcome = "false";
      code = r.code;
    } else if (r.result === "unknown" && outcome === "true") {
      outcome = "unknown";
      code = r.code;
    }
  }
  return { results, outcome, code };
}

/** Tri-state: does this rule's applies_to scope cover the action? */
type Applicability = "yes" | "no" | "unknown";

/**
 * One `conditional_context` antecedent. `phase` is decided by a verified,
 * non-planner `context.phase` fact; `antecedent_text` is never evaluable —
 * the guard does not NLP free text, so it stays `unknown`.
 */
function evalContextCondition(cond: {
  kind: string;
  value?: string;
  text?: string;
}, ctx: Context): PredOutcome {
  if (cond.kind === "phase") {
    const { trusted } = attestedValue("context.phase", ctx);
    if (trusted.length === 0) return "unknown";
    // Conflicting trusted phase attestations resolve nothing.
    if (new Set(trusted).size > 1) return "unknown";
    return trusted[0] === cond.value ? "true" : "false";
  }
  return "unknown";
}

/**
 * A rule's applicability. `conditional_context` conditions OR (the exporter
 * unions antecedents): any verified-true applies the rule, all
 * verified-false leaves it inapplicable, anything else is unresolved —
 * including a missing context signal, since applicability could change
 * authorization. Unknown `applies_to` types fail closed to `unknown`.
 */
function applicability(
  applies: IrTechniqueRule["applies_to"],
  targetId: string | undefined,
  ir: PolicyIR,
  ctx: Context,
): Applicability {
  switch (applies.type) {
    case "engagement":
    case "all_targets":
      return "yes";
    case "target_ids":
      return targetId !== undefined && (applies.ids ?? []).includes(targetId)
        ? "yes"
        : "no";
    case "target_group_ids": {
      const groups = targetGroupIds(ir, targetId);
      return (applies.ids ?? []).some((id) => groups.includes(id))
        ? "yes"
        : "no";
    }
    case "conditional_context": {
      const conditions = applies.conditions ?? [];
      if (conditions.length === 0) return "unknown";
      let sawUnknown = false;
      for (const c of conditions) {
        const r = evalContextCondition(c, ctx);
        if (r === "true") return "yes";
        if (r === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : "no";
    }
    default:
      return "unknown";
  }
}

type IrException = NonNullable<PolicyIR["authorized_scope"]>["exceptions"][number];

/**
 * Does the exception's `applies_to` cover this baseline failure? An
 * unrecognized `applies_to` returns `unknown` — the exception might cover
 * the action, so the baseline cannot stand unchallenged (REVIEW, not DENY).
 */
function exceptionCoverage(
  e: IrException,
  baseline: "out_of_scope" | "unlisted",
  targetId: string | undefined,
  ir: PolicyIR,
): "yes" | "no" | "unknown" {
  switch (e.applies_to) {
    case "out_of_scope_targets":
      return baseline === "out_of_scope" ? "yes" : "no";
    case "unlisted_targets":
      return baseline === "unlisted" ? "yes" : "no";
    case "target_ids":
      return targetId !== undefined && (e.ids ?? []).includes(targetId)
        ? "yes"
        : "no";
    case "target_group_ids": {
      const groups = targetGroupIds(ir, targetId);
      return (e.ids ?? []).some((id) => groups.includes(id)) ? "yes" : "no";
    }
    default:
      return "unknown";
  }
}

/**
 * A `permit_evaluation` exception is honored only on verified, non-planner
 * proof of prior written consent (`authorization.prior_written_consent`).
 * Planner-asserted consent, unknown condition kinds, and unrecognized
 * effects never bypass the baseline.
 */
function exceptionVerified(e: IrException, ctx: Context): boolean {
  if (e.effect !== "permit_evaluation") return false;
  if (e.condition.kind !== "prior_written_consent") return false;
  const { trusted } = attestedValue("authorization.prior_written_consent", ctx);
  return trusted.some((v) => v === true);
}

/**
 * Whether a VRT rule's `applies_to` text covers the resolved target.
 * "All targets" applies everywhere; a "Targets:/Target groups:" listing
 * applies when it names the resolved target's location/name or a scope
 * group it belongs to. Unlisted targets can only take the blanket rules.
 */
function vrtApplies(
  appliesTo: string | null,
  resolution: TargetResolution | null,
  ir: PolicyIR,
): "yes" | "no" | "unknown" {
  const text = (appliesTo ?? "").trim();
  if (text === "" || /^(?:all|any|every)\s+targets?$/i.test(text)) return "yes";
  if (resolution === null || resolution.status !== "matched_in_scope") {
    return "unknown";
  }
  const target = ir.inventory?.in_scope.find(
    (t) => t.target_id === resolution.target_ids[0],
  );
  if (target === undefined) return "unknown";
  const candidates = new Set<string>();
  for (const v of [target.location, target.name, target.target_id]) {
    if (v !== null && v !== undefined && v !== "") candidates.add(v.toLowerCase());
  }
  for (const gid of target.scope_group_ids) {
    const name = ir.groups[gid]?.name;
    if (name !== undefined) candidates.add(name.toLowerCase());
  }
  const haystack = text.toLowerCase();
  for (const c of candidates) {
    if (c.length >= 3 && new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack)) {
      return "yes";
    }
  }
  return "no";
}

export async function evaluateAction(
  policy: CompiledPolicy,
  action: ProposedAction,
  opts: EvaluateOptions = {},
): Promise<GuardDecision> {
  const ir = policy.ir;
  const checks: GuardCheck[] = [];
  const reasons = new Set<GuardReasonCode>();
  const unresolvedReqs = new Set<string>();
  const evidence = new Set<string>();

  const record = (c: GuardCheck): void => {
    checks.push(c);
    if (c.reason_code !== undefined) reasons.add(c.reason_code);
    for (const ref of c.evidence_refs) evidence.add(ref);
    if (c.result === "unknown" && c.detail !== undefined) {
      unresolvedReqs.add(c.detail);
    }
  };

  const finish = async (
    decision: GuardDecision["decision"],
    resolution: TargetResolution | null,
    eligibility: GuardDecision["eligibility"],
  ): Promise<GuardDecision> => {
    const aHash = await actionHash(action);
    const targetResolution: GuardDecision["target_resolution"] = {
      input: action.target.url,
      status: resolution?.status ?? "not_evaluated",
      target_id:
        resolution !== null && "target_ids" in resolution
          ? resolution.target_ids[0]
          : undefined,
      matched_target_ids:
        resolution !== null && "target_ids" in resolution
          ? resolution.target_ids
          : resolution?.status === "ambiguous"
            ? resolution.candidate_target_ids
            : undefined,
      evidence_refs:
        resolution !== null && "evidence_refs" in resolution
          ? resolution.evidence_refs
          : undefined,
    };
    const dHash = await decisionHash(
      decisionPreimage(
        {
          decision,
          reason_codes: [...reasons].sort(),
          checks,
          target_resolution: targetResolution,
          eligibility,
          unresolved_requirements: [...unresolvedReqs].sort(),
        },
        policy.policy_hash,
        aHash,
      ),
    );
    return {
      schema_version: GUARD_SCHEMA_VERSION,
      decision,
      execution_allowed: decision === "ALLOW",
      reason_codes: [...reasons].sort(),
      policy_hash: policy.policy_hash,
      action_hash: aHash,
      decision_hash: dHash,
      engagement_code: ir.engagement_code ?? "",
      target_resolution: targetResolution,
      checks,
      evidence_refs: [...evidence].sort(),
      eligibility,
      unresolved_requirements: [...unresolvedReqs].sort(),
      evaluated_at: opts.now ?? new Date().toISOString(),
    };
  };

  const noEligibility: GuardDecision["eligibility"] = {
    submission: "unknown",
    reward: "unknown",
  };

  // --- B. Dossier integrity -------------------------------------------------
  const integrity = ir.integrity;
  let integrityFailed = false;
  if (integrity.collection_status !== "complete") {
    integrityFailed = true;
    record({
      check: "integrity",
      result: "fail",
      reason_code:
        integrity.collection_status === "failed" ||
        integrity.collection_status === null
          ? "DOSSIER_FAILED"
          : "DOSSIER_PARTIAL",
      rule_status: integrity.collection_status ?? "missing",
      detail: "collection.status is not complete",
      evidence_refs: [],
    });
  }
  if (integrity.evidence_hash_valid !== true) {
    integrityFailed = true;
    record({
      check: "integrity",
      result: "fail",
      reason_code: "EVIDENCE_HASH_INVALID",
      detail: "evidence corpus hash is not verified",
      evidence_refs: [],
    });
  }
  if (integrity.known_issues_counts_valid !== true) {
    integrityFailed = true;
    record({
      check: "integrity",
      result: "fail",
      reason_code: "KNOWN_ISSUES_COUNTS_INVALID",
      detail: "known issues counts are not verified",
      evidence_refs: [],
    });
  }
  if (integrity.required_sections_complete !== true) {
    integrityFailed = true;
    record({
      check: "integrity",
      result: "fail",
      reason_code: "REQUIRED_SECTIONS_INCOMPLETE",
      detail: "required sections are incomplete",
      evidence_refs: [],
    });
  }
  if (integrity.unresolved_conflicts !== 0) {
    integrityFailed = true;
    record({
      check: "integrity",
      result: "fail",
      reason_code: "POLICY_CONFLICT",
      detail: `unresolved policy conflicts: ${integrity.unresolved_conflicts ?? "unknown"}`,
      evidence_refs: [],
    });
  }
  if (integrityFailed) {
    // Untrusted facts support neither ALLOW nor a semantic DENY.
    return finish("REVIEW", null, noEligibility);
  }
  record({
    check: "integrity",
    result: "pass",
    reason_code: "CONDITION_SATISFIED",
    detail: "collection complete; integrity verified",
    evidence_refs: [],
  });

  // --- C. Engagement identity ------------------------------------------------
  if (ir.engagement_code === null || ir.engagement_code !== action.engagement.code) {
    record({
      check: "engagement",
      result: "fail",
      reason_code: "ENGAGEMENT_MISMATCH",
      detail: `action engagement '${action.engagement.code}' vs policy '${ir.engagement_code ?? "unavailable"}'`,
      evidence_refs: [],
    });
    return finish("REVIEW", null, noEligibility);
  }
  record({
    check: "engagement",
    result: "pass",
    detail: ir.engagement_code,
    evidence_refs: [],
  });

  // --- Safe harbor ------------------------------------------------------------
  if (ir.safe_harbor.status === "present") {
    record({
      check: "safe_harbor",
      result: "pass",
      rule_status: "present",
      evidence_refs: ir.safe_harbor.evidence_refs,
    });
  } else {
    record({
      check: "safe_harbor",
      result: "unknown",
      reason_code:
        ir.safe_harbor.status === "absent"
          ? "SAFE_HARBOR_ABSENT"
          : "SAFE_HARBOR_UNCLEAR",
      rule_status: ir.safe_harbor.status ?? "missing",
      detail: "safe harbor is not present",
      evidence_refs: ir.safe_harbor.evidence_refs,
    });
  }

  // --- C2. Program state -------------------------------------------------------
  // The operational axis is separate from testing authorization: only a
  // stated `testing_state` gates execution. `unspecified` is unresolved →
  // REVIEW; a paused submission state alone never decides testing. An
  // absent program_state contributes nothing (old dossiers).
  const ps = ir.program_state;
  if (ps !== null) {
    if (ps.testing_state === "prohibited") {
      record({
        check: "program_state",
        result: "fail",
        reason_code: "PROGRAM_TESTING_PROHIBITED",
        rule_status: ps.testing_state,
        detail: "program state prohibits testing",
        evidence_refs: ps.evidence_refs,
      });
    } else if (ps.testing_state === "allowed") {
      record({
        check: "program_state",
        result: "pass",
        rule_status: ps.testing_state,
        detail: "program state allows testing",
        evidence_refs: ps.evidence_refs,
      });
    } else {
      record({
        check: "program_state",
        result: "unknown",
        reason_code: "PROGRAM_TESTING_UNSPECIFIED",
        rule_status: ps.testing_state ?? "missing",
        detail: "program testing authorization is unspecified",
        evidence_refs: ps.evidence_refs,
      });
    }
  }

  // --- D. Target resolution + authorized scope --------------------------------
  if (ir.inventory === null) {
    record({
      check: "target",
      result: "unknown",
      reason_code: "SCOPE_INVENTORY_UNAVAILABLE",
      detail: "dossier has no machine-readable scope inventory",
      evidence_refs: [],
    });
    return finish("REVIEW", null, noEligibility);
  }

  const resolution = resolveTarget(
    action.target.url,
    ir.inventory,
    action.target.target_id,
  );
  const ctx: Context = { action, resolution, ...contextMaps(action, opts.trustedContext ?? []) };
  const primaryTargetId =
    resolution.status === "matched_in_scope" ||
    resolution.status === "matched_out_of_scope"
      ? resolution.target_ids[0]
      : undefined;

  if (
    action.target.target_id !== undefined &&
    "target_ids" in resolution &&
    !resolution.target_ids.includes(action.target.target_id)
  ) {
    record({
      check: "target",
      result: "unknown",
      reason_code: "TARGET_ID_UNRESOLVED",
      detail: `declared target_id '${action.target.target_id}' not among resolved ids`,
      evidence_refs: [],
    });
  }

  const scopeEvidence =
    resolution.status === "matched_in_scope" ||
    resolution.status === "matched_out_of_scope"
      ? resolution.evidence_refs
      : [];
  const scope = ir.authorized_scope;

  /**
   * Evaluate consent carve-outs against a baseline scope failure. Returns
   * "verified" (evaluation may continue — never an ALLOW by itself),
   * "unverified" (an applicable exception exists but its proof is missing
   * or untrusted → REVIEW), or "none" (baseline stands → DENY).
   */
  const exceptionOutcome = (
    baseline: "out_of_scope" | "unlisted",
  ): { outcome: "verified" | "unverified" | "none"; verified?: IrException; candidates: IrException[] } => {
    const exceptions = scope?.exceptions ?? [];
    const candidates: IrException[] = [];
    let verified: IrException | undefined;
    for (const e of exceptions) {
      const cov = exceptionCoverage(e, baseline, primaryTargetId, ir);
      if (cov === "no") continue;
      candidates.push(e);
      if (cov === "yes" && exceptionVerified(e, ctx)) verified = e;
    }
    if (verified !== undefined) return { outcome: "verified", verified, candidates };
    // An exception only engages when consent is actually claimed — a bare
    // `true` attestation, verified or merely asserted. With no claim at all
    // the baseline prohibition simply stands (DENY); a claim that cannot be
    // verified — planner-asserted, unknown coverage, unverifiable condition
    // kind — re-opens nothing and forces REVIEW.
    const claimed =
      attestedValue("authorization.prior_written_consent", ctx).asserted.some(
        (v) => v === true,
      ) ||
      attestedValue("authorization.prior_written_consent", ctx).trusted.some(
        (v) => v === true,
      );
    return candidates.length > 0 && claimed
      ? { outcome: "unverified", candidates }
      : { outcome: "none", candidates };
  };

  switch (resolution.status) {
    case "matched_out_of_scope": {
      const ex = exceptionOutcome("out_of_scope");
      if (ex.outcome === "verified" && ex.verified !== undefined) {
        record({
          check: "target",
          result: "pass",
          rule_status: "exception",
          detail: `resolved to out-of-scope target ${primaryTargetId}; verified consent permits continued evaluation`,
          evidence_refs: [...scopeEvidence, ...ex.verified.evidence_refs],
        });
        record({
          check: "authorization_exception",
          result: "pass",
          reason_code: "AUTHORIZATION_EXCEPTION_VERIFIED",
          rule_status: ex.verified.condition.kind,
          detail:
            "prior written consent verified — evaluation continues; all other prohibitions still apply",
          evidence_refs: ex.verified.evidence_refs,
        });
      } else if (ex.outcome === "unverified") {
        record({
          check: "target",
          result: "unknown",
          reason_code: "TARGET_OUT_OF_SCOPE",
          detail: `resolved to out-of-scope target ${primaryTargetId}; consent exception present but unverified`,
          evidence_refs: scopeEvidence,
        });
        record({
          check: "authorization_exception",
          result: "unknown",
          reason_code: "AUTHORIZATION_EXCEPTION_UNVERIFIED",
          detail:
            "prior written consent requires a verified, non-planner attestation",
          evidence_refs: ex.candidates.flatMap((e) => e.evidence_refs),
        });
      } else {
        record({
          check: "target",
          result: "fail",
          reason_code: "TARGET_OUT_OF_SCOPE",
          detail: `resolved to out-of-scope target ${primaryTargetId}`,
          evidence_refs: scopeEvidence,
        });
      }
      break;
    }
    case "ambiguous":
      record({
        check: "target",
        result: "unknown",
        reason_code: "TARGET_AMBIGUOUS",
        detail: `equally specific conflicting listings: ${resolution.candidate_target_ids.join(", ")}`,
        evidence_refs: [],
      });
      break;
    case "unlisted": {
      const status = scope?.unlisted_status;
      if (status === "prohibited") {
        const ex = exceptionOutcome("unlisted");
        if (ex.outcome === "verified" && ex.verified !== undefined) {
          record({
            check: "target",
            result: "pass",
            rule_status: "exception",
            detail:
              "unlisted target; verified consent permits continued evaluation",
            evidence_refs: ex.verified.evidence_refs,
          });
          record({
            check: "authorization_exception",
            result: "pass",
            reason_code: "AUTHORIZATION_EXCEPTION_VERIFIED",
            rule_status: ex.verified.condition.kind,
            detail:
              "prior written consent verified — evaluation continues; all other prohibitions still apply",
            evidence_refs: ex.verified.evidence_refs,
          });
        } else if (ex.outcome === "unverified") {
          record({
            check: "target",
            result: "unknown",
            reason_code: "TARGET_UNLISTED",
            detail:
              "target is unlisted; consent exception present but unverified",
            evidence_refs: scope?.evidence_refs ?? [],
          });
          record({
            check: "authorization_exception",
            result: "unknown",
            reason_code: "AUTHORIZATION_EXCEPTION_UNVERIFIED",
            detail:
              "prior written consent requires a verified, non-planner attestation",
            evidence_refs: ex.candidates.flatMap((e) => e.evidence_refs),
          });
        } else {
          record({
            check: "target",
            result: "fail",
            reason_code: "UNLISTED_TARGETS_PROHIBITED",
            detail: "target is unlisted and unlisted targets are prohibited",
            evidence_refs: scope?.evidence_refs ?? [],
          });
        }
      } else if (status === "allowed") {
        record({
          check: "target",
          result: "pass",
          reason_code: "TARGET_UNLISTED",
          detail: "unlisted but policy allows unlisted targets",
          evidence_refs: scope?.evidence_refs ?? [],
        });
      } else {
        record({
          check: "target",
          result: "unknown",
          reason_code: "TARGET_UNLISTED",
          rule_status: status ?? "absent",
          detail: "no deterministic rule for unlisted targets",
          evidence_refs: scope?.evidence_refs ?? [],
        });
      }
      break;
    }
    case "matched_in_scope": {
      const listedStatus = scope?.listed_status;
      if (listedStatus === "prohibited") {
        record({
          check: "target",
          result: "fail",
          reason_code: "LISTED_TARGETS_PROHIBITED",
          detail: "listed targets are prohibited by authorized_scope",
          evidence_refs: scopeEvidence,
        });
      } else if (listedStatus === "conditional") {
        const { results, outcome, code } = predicateResults(
          scope!.listed_predicates,
          ctx,
        );
        record({
          check: "authorized_scope",
          result:
            outcome === "true" ? "pass" : outcome === "false" ? "fail" : "unknown",
          reason_code:
            outcome === "true"
              ? "CONDITION_SATISFIED"
              : outcome === "false"
                ? (code ?? "CONDITION_FAILED")
                : (code ?? "CONDITION_UNRESOLVED"),
          rule_status: "conditional",
          evidence_refs: [...scopeEvidence, ...(scope!.evidence_refs ?? [])],
          predicate_results: results,
        });
        record({
          check: "target",
          result: "pass",
          reason_code: "TARGET_IN_SCOPE",
          detail: `resolved to listed target ${primaryTargetId}`,
          evidence_refs: scopeEvidence,
        });
      } else {
        // allowed or absent: the listing itself is the scope declaration.
        record({
          check: "target",
          result: listedStatus === "unspecified" ? "unknown" : "pass",
          reason_code: "TARGET_IN_SCOPE",
          rule_status: listedStatus ?? "absent",
          detail: `resolved to listed target ${primaryTargetId}`,
          evidence_refs: scopeEvidence,
        });
      }
      break;
    }
  }

  // --- E. VRT scope rules ------------------------------------------------------
  const canonical = canonicalTechniqueId(action.technique.id);
  for (const rule of ir.vrt_rules) {
    if (rule.canonical === null || rule.canonical !== canonical) continue;
    const applies = vrtApplies(rule.applies_to, resolution, ir);
    if (applies === "no") continue;
    if (applies === "unknown") {
      record({
        check: "vrt",
        result: "unknown",
        reason_code: "VRT_RULE_UNRESOLVED",
        rule_status: rule.status,
        detail: `VRT '${rule.category}' applicability undetermined`,
        evidence_refs: rule.evidence_refs,
      });
      continue;
    }
    if (rule.status === "out_of_scope") {
      record({
        check: "vrt",
        result: "fail",
        reason_code: "VRT_RULE_PROHIBITED",
        rule_status: rule.status,
        detail: `VRT '${rule.category}' is out of scope`,
        evidence_refs: rule.evidence_refs,
      });
    } else if (rule.status === "conditional") {
      record({
        check: "vrt",
        result: "unknown",
        reason_code: "VRT_RULE_CONDITIONAL",
        rule_status: rule.status,
        detail: `VRT '${rule.category}' conditional${rule.note ? `: ${rule.note}` : ""}`,
        evidence_refs: rule.evidence_refs,
      });
    } else {
      record({
        check: "vrt",
        result: "pass",
        rule_status: rule.status,
        detail: `VRT '${rule.category}' in scope`,
        evidence_refs: rule.evidence_refs,
      });
    }
  }

  // --- F. Technique rules -------------------------------------------------------
  const evaluatedRules = new Set<IrTechniqueRule>();
  if (canonical === null) {
    record({
      check: "technique",
      result: "unknown",
      reason_code: "TECHNIQUE_UNKNOWN",
      detail: `unrecognized technique '${action.technique.id}'`,
      evidence_refs: [],
    });
  } else {
    let sawApplicable = false;
    let sawUnknownApplicability = false;
    for (const rule of ir.techniques) {
      if (rule.canonical !== canonical) continue;
      const app = applicability(rule.applies_to, primaryTargetId, ir, ctx);
      if (app === "no") {
        if (rule.applies_to.type === "conditional_context") {
          record({
            check: "applicability",
            result: "not_applicable",
            reason_code: "APPLICABILITY_NOT_MATCHED",
            rule_status: rule.applies_to.type,
            detail: `'${rule.key}' context conditions verified not met`,
            evidence_refs: rule.evidence_refs,
          });
        }
        continue;
      }
      if (app === "unknown") {
        sawUnknownApplicability = true;
        record({
          check: "applicability",
          result: "unknown",
          reason_code: "APPLICABILITY_UNRESOLVED",
          rule_status: rule.applies_to.type,
          detail: `'${rule.key}' applicability cannot be verified`,
          evidence_refs: rule.evidence_refs,
        });
        continue;
      }
      sawApplicable = true;
      evaluatedRules.add(rule);
      if (rule.applies_to.type === "conditional_context") {
        record({
          check: "applicability",
          result: "pass",
          reason_code: "APPLICABILITY_MATCHED",
          rule_status: rule.applies_to.type,
          detail: `'${rule.key}' context conditions verified`,
          evidence_refs: rule.evidence_refs,
        });
      }
      record(techniqueCheck(rule, ctx));
    }
    if (!sawApplicable && !sawUnknownApplicability) {
      record({
        check: "technique",
        result: "unknown",
        reason_code: "TECHNIQUE_NO_POLICY",
        detail: `no applicable policy fact for technique '${canonical}'`,
        evidence_refs: [],
      });
    }
  }

  // --- Automation overlay: an automated action takes the automation rules -----
  // regardless of the declared technique label.
  if (action.automation?.automated === true || action.automation?.scanner === true) {
    const family = new Set([
      "automation",
      "automated_scanners",
      "automated_scanning",
      "automated_tools",
      "automated_vulnerability_scanning",
      "burp_scanning",
      "port_scanning_internal_networks",
      "scanning",
    ]);
    let sawUnknownApplicability = false;
    let familyRuleExists = false;
    for (const rule of ir.techniques) {
      if (rule.canonical === null || !family.has(rule.canonical)) continue;
      familyRuleExists = true;
      if (evaluatedRules.has(rule)) continue;
      const app = applicability(rule.applies_to, primaryTargetId, ir, ctx);
      if (app === "no") continue;
      if (app === "unknown") {
        sawUnknownApplicability = true;
        record({
          check: "applicability",
          result: "unknown",
          reason_code: "APPLICABILITY_UNRESOLVED",
          rule_status: rule.applies_to.type,
          detail: `automation rule '${rule.key}' applicability cannot be verified`,
          evidence_refs: rule.evidence_refs,
        });
        continue;
      }
      evaluatedRules.add(rule);
      record({ ...techniqueCheck(rule, ctx), check: "automation" });
    }
    if (!familyRuleExists && !sawUnknownApplicability) {
      record({
        check: "automation",
        result: "unknown",
        reason_code: "TECHNIQUE_NO_POLICY",
        detail: "action is automated but no automation-family rule exists",
        evidence_refs: [],
      });
    }
  }

  // --- G/H. Credentials, account, data constraints ------------------------------
  for (const c of ir.account_constraints) {
    record(constraintCheck("account", c, ctx, canonical));
  }
  for (const c of ir.data_constraints) {
    record(constraintCheck("data", c, ctx, canonical));
  }

  // --- J. Submission / reward eligibility (never silently a testing denial) ---
  let submission: GuardDecision["eligibility"]["submission"] = "unknown";
  let reward: GuardDecision["eligibility"]["reward"] = "unknown";
  // Program operational state feeds the eligibility axes only.
  if (ps !== null) {
    if (ps.submission_state === "paused" || ps.submission_state === "closed") {
      submission = "excluded";
      record({
        check: "eligibility",
        result: "not_applicable",
        reason_code: "PROGRAM_SUBMISSIONS_PAUSED",
        rule_status: ps.submission_state,
        detail: `submissions ${ps.submission_state} — eligibility axis, not a testing denial`,
        evidence_refs: ps.evidence_refs,
      });
    } else if (ps.submission_state === "open") {
      submission = "eligible";
    }
    if (ps.reward_state === "ineligible") {
      reward = "ineligible";
      record({
        check: "eligibility",
        result: "not_applicable",
        reason_code: "REWARD_INELIGIBLE",
        rule_status: ps.reward_state,
        detail: "rewards ineligible — eligibility axis, not a testing denial",
        evidence_refs: ps.evidence_refs,
      });
    } else if (ps.reward_state === "eligible") {
      reward = "eligible";
    }
  }
  if (canonical !== null) {
    const matched = ir.exclusions.filter((e) => e.techniques.includes(canonical));
    for (const e of matched) {
      if (e.testing_status === "prohibited") {
        record({
          check: "eligibility",
          result: "fail",
          reason_code: "EXCLUSION_TESTING_PROHIBITED",
          rule_status: e.testing_status,
          detail: `exclusion '${e.text}' prohibits testing`,
          evidence_refs: e.evidence_refs,
        });
      }
    }
    if (matched.length > 0) {
      submission = "excluded";
      reasons.add("SUBMISSION_EXCLUDED");
      if (matched.some((e) => e.reward_status === "ineligible")) {
        reward = "ineligible";
        reasons.add("REWARD_INELIGIBLE");
      } else {
        reward = "unknown";
      }
      record({
        check: "eligibility",
        result: "pass",
        reason_code: "SUBMISSION_EXCLUDED",
        detail: `${matched.length} exclusion(s) match; eligibility reported on its own axis`,
        evidence_refs: matched.flatMap((e) => e.evidence_refs),
      });
    }
  }

  // --- K. Aggregate -------------------------------------------------------------
  const decision = checks.some((c) => c.result === "fail")
    ? "DENY"
    : checks.some((c) => c.result === "unknown")
      ? "REVIEW"
      : "ALLOW";
  return finish(decision, resolution, { submission, reward });
}

/**
 * Compile one condition clause and evaluate it standalone — against an
 * action plus trusted context, with no target resolution (target-bound
 * predicates come back `unknown`). Convenience wrapper for harnesses that
 * need a single predicate verdict.
 */
export function evaluateCondition(
  text: string,
  action: ProposedAction,
  trustedContext: ContextFact[] = [],
): PredOutcome {
  const pred = compileCondition(text);
  const ctx: Context = {
    action,
    resolution: null,
    ...contextMaps(action, trustedContext),
  };
  return evalPredicate(pred, ctx).result;
}

function techniqueCheck(
  rule: {
    key: string;
    status: string;
    predicates: GuardPredicate[];
    evidence_refs: string[];
    conflict_detected: boolean;
  },
  ctx: Context,
): GuardCheck {
  if (rule.conflict_detected) {
    return {
      check: "technique",
      result: "unknown",
      reason_code: "POLICY_CONFLICT",
      rule_status: rule.status,
      detail: `conflicting assertions for '${rule.key}'`,
      evidence_refs: rule.evidence_refs,
    };
  }
  switch (rule.status) {
    case "prohibited":
      return {
        check: "technique",
        result: "fail",
        reason_code: "TECHNIQUE_PROHIBITED",
        rule_status: rule.status,
        detail: `'${rule.key}' is prohibited`,
        evidence_refs: rule.evidence_refs,
      };
    case "unspecified":
      return {
        check: "technique",
        result: "unknown",
        reason_code: "TECHNIQUE_UNSPECIFIED",
        rule_status: rule.status,
        detail: `'${rule.key}' has no asserted permission`,
        evidence_refs: rule.evidence_refs,
      };
    case "conditional": {
      const { results, outcome, code } = predicateResults(rule.predicates, ctx);
      return {
        check: "technique",
        result:
          outcome === "true" ? "pass" : outcome === "false" ? "fail" : "unknown",
        reason_code:
          outcome === "true"
            ? "TECHNIQUE_CONDITIONAL"
            : outcome === "false"
              ? (code ?? "CONDITION_FAILED")
              : (code ?? "CONDITION_UNRESOLVED"),
        rule_status: rule.status,
        detail: `'${rule.key}' is conditional`,
        evidence_refs: rule.evidence_refs,
        predicate_results: results,
      };
    }
    case "allowed":
      return {
        check: "technique",
        result: "pass",
        reason_code: "TECHNIQUE_ALLOWED",
        rule_status: rule.status,
        detail: `'${rule.key}' is allowed`,
        evidence_refs: rule.evidence_refs,
      };
    default:
      return {
        check: "technique",
        result: "unknown",
        reason_code: "TECHNIQUE_UNSPECIFIED",
        rule_status: rule.status,
        evidence_refs: rule.evidence_refs,
      };
  }
}

function constraintCheck(
  axis: "account" | "data",
  c: GuardConstraint,
  ctx: Context,
  actionCanonical: string | null,
): GuardCheck {
  const check = (
    name: GuardCheck["check"],
    result: GuardCheck["result"],
    reason_code: GuardReasonCode | undefined,
    detail: string,
  ): GuardCheck => ({
    check: name,
    result,
    reason_code,
    rule_status: c.kind,
    detail,
    evidence_refs: c.evidence_refs,
  });

  switch (c.kind) {
    case "account_ownership": {
      const r = ownershipEval(
        "account.ownership",
        c.allowed,
        ctx,
        "ACCOUNT_CONTEXT_UNVERIFIED",
        "ACCOUNT_CONSTRAINT_FAILED",
      );
      return check(
        "account",
        r.result === "true" ? "pass" : r.result === "false" ? "fail" : "unknown",
        r.code,
        r.detail ?? `account ownership must be one of ${c.allowed.join(", ")}`,
      );
    }
    case "credential_source": {
      const r = deniedValueEval(
        "credentials.source",
        c.denied,
        ctx,
        "CREDENTIAL_SOURCE_PROHIBITED",
        "CREDENTIAL_SOURCE_UNVERIFIED",
      );
      return check(
        "credentials",
        r.result === "true" ? "pass" : r.result === "false" ? "fail" : "unknown",
        r.code,
        r.detail ?? `credential source must not be ${c.denied.join(", ")}`,
      );
    }
    case "data_access": {
      const own = deniedValueEval(
        "data.ownership",
        c.denied_ownership,
        ctx,
        "DATA_CONSTRAINT_FAILED",
        "DATA_CONTEXT_UNVERIFIED",
      );
      const sens = deniedValueEval(
        "data.sensitivity",
        c.denied_sensitivity,
        ctx,
        "DATA_CONSTRAINT_FAILED",
        "DATA_CONTEXT_UNVERIFIED",
      );
      const result: GuardCheck["result"] =
        own.result === "false" || sens.result === "false"
          ? "fail"
          : own.result === "unknown" || sens.result === "unknown"
            ? "unknown"
            : "pass";
      return check(
        "data",
        result,
        result === "fail"
          ? "DATA_CONSTRAINT_FAILED"
          : result === "unknown"
            ? "DATA_CONTEXT_UNVERIFIED"
            : undefined,
        `rule: ${c.source_text}`,
      );
    }
    case "technique_prohibition":
      return actionCanonical === c.technique
        ? check(
            axis,
            "fail",
            "TECHNIQUE_PROHIBITED",
            `rule prohibits '${c.technique}'`,
          )
        : check(axis, "not_applicable", undefined, `rule governs '${c.technique}'`);
    case "unresolved":
      return check(
        axis,
        "unknown",
        "RULE_UNRESOLVED",
        `uncompiled rule: ${c.source_text}`,
      );
  }
}
