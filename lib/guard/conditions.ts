/**
 * Deterministic condition/rule compiler. Exporter conditions arrive as
 * evidence-backed text; the guard recognizes a small set of clause patterns
 * and compiles each to a typed predicate. Anything unrecognized compiles to
 * `unresolved`, which the evaluator reads as REVIEW — never as satisfied.
 */

export type OwnershipValue = "researcher" | "explicitly_authorized" | "test";

export type GuardPredicate =
  | { kind: "target_is_explicitly_listed" }
  | { kind: "account_ownership"; allowed: OwnershipValue[] }
  | { kind: "data_ownership"; allowed: OwnershipValue[] }
  | { kind: "prior_authorization" }
  | { kind: "non_destructive" }
  | { kind: "rate_limit"; max_per_minute: number }
  | { kind: "unresolved"; source_text: string };

export type GuardConstraint = {
  source_text: string;
  evidence_refs: string[];
} & (
  | { kind: "account_ownership"; allowed: OwnershipValue[] }
  | { kind: "credential_source"; denied: string[] }
  | {
      kind: "data_access";
      denied_ownership: string[];
      denied_sensitivity: string[];
    }
  | { kind: "technique_prohibition"; technique: string }
  | { kind: "unresolved" }
);

const TARGET_LISTED_RE =
  /\btargets?\s+(?:must\s+be\s+|are\s+)?(?:explicitly\s+)?(?:declared|listed|specified|defined|shown|named)\s+(?:as\s+)?(?:in[\s-]?scope)?|\btargets?\s+listed\s+(?:as\s+)?in[\s-]?scope|\b(?:listed|in[\s-]?scope|above)\s+targets?\b|\btargets?\s+(?:listed|declared|specified)\b/i;

const ACCOUNT_OWN_RE =
  /\baccounts?\s+(?:that\s+)?you\s+own\b|\byour\s+own\s+accounts?\b|\baccounts?\s+you\s+(?:have\s+)?(?:created|control)\b/i;

const ACCOUNT_OWN_OR_AUTH_RE = /\bauthoriz|authoris|approv|permitted/i;

const DATA_OWN_RE =
  /\b(?:data|information)\s+(?:that\s+)?you\s+own\b|\byour\s+own\s+(?:data|information)\b/i;

const PRIOR_AUTHORIZATION_RE =
  /\bprior\s+(?:written\s+)?(?:approval|authorization|authorisation|consent|permission)\b|\bwritten\s+(?:approval|authorization|authorisation|consent|permission)\b|\bapprov\w+\s+in\s+advance\b|\brequir\w+\s+(?:prior\s+)?(?:written\s+)?(?:approval|authorization|authorisation|permission|consent)\b/i;

const NON_DESTRUCTIVE_RE =
  /\bnon[\s-]?destructive\b|\bnot\s+destructive\b|\bwithout\s+(?:causing\s+)?(?:damage|disruption|destruction|data\s+loss)\b|\bno\s+(?:damage|disruption|destruction|data\s+loss)\b/i;

const RATE_LIMIT_RE =
  /\b(?:no\s+more\s+than|max(?:imum)?(?:\s+of)?|up\s+to|limit(?:ed)?\s+to|cap(?:ped)?\s+(?:at|of)|do\s+not\s+exceed|not\s+exceed)\s*(\d+)\s*(?:requests?|req)\b[^.;]*?\b(?:per|\/|a)\s*(minute|min|second|sec|hour|hr)\b/i;

function rateLimit(text: string): GuardPredicate | null {
  const m = RATE_LIMIT_RE.exec(text);
  if (m === null) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n)) return null;
  const unit = m[2]!.toLowerCase();
  const perMinute =
    unit.startsWith("sec") ? n * 60 : unit.startsWith("h") ? Math.ceil(n / 60) : n;
  return { kind: "rate_limit", max_per_minute: perMinute };
}

/**
 * Compile one condition clause (from a PermissionFact's `conditions` or an
 * `authorized_scope` conditions list) into a typed predicate.
 */
export function compileCondition(text: string): GuardPredicate {
  const t = text.trim();
  const rate = rateLimit(t);
  if (rate !== null) return rate;
  if (TARGET_LISTED_RE.test(t)) return { kind: "target_is_explicitly_listed" };
  if (ACCOUNT_OWN_RE.test(t)) {
    const allowed: OwnershipValue[] = ACCOUNT_OWN_OR_AUTH_RE.test(t)
      ? ["researcher", "explicitly_authorized"]
      : ["researcher"];
    return { kind: "account_ownership", allowed };
  }
  if (DATA_OWN_RE.test(t))
    return { kind: "data_ownership", allowed: ["researcher", "test"] };
  if (PRIOR_AUTHORIZATION_RE.test(t)) return { kind: "prior_authorization" };
  if (NON_DESTRUCTIVE_RE.test(t)) return { kind: "non_destructive" };
  return { kind: "unresolved", source_text: t };
}

// ---------------------------------------------------------------------------
// Full-sentence rules from account_rules / data_rules. Each compiles to a
// typed constraint the evaluator can check against the action; anything else
// is `unresolved` → REVIEW.
// ---------------------------------------------------------------------------

const OWN_ACCOUNT_RULE_RES = [
  // "Only test accounts that you own." / "Test only your own accounts."
  /\bonly\s+(?:test|use|access|target|interact\s+with|scan|probe)\b[^.;]*\b(?:your\s+own|accounts?\s+(?:that\s+)?you\s+own|accounts?\s+you\s+(?:created|control))\b/i,
  /\b(?:test|use|access|target|interact\s+with|scan|probe)\s+only\b[^.;]*\b(?:your\s+own|accounts?\s+(?:that\s+)?you\s+own)\b/i,
  /\b(?:test|testing)\s+(?:only\s+)?(?:on|against|your)\s+your\s+own\s+accounts?\b/i,
  /\byour\s+own\s+accounts?\s+only\b/i,
];

const OTHER_PARTY_RULE_RE =
  /\b(?:do\s+not|don't|never|must\s+not|shall\s+not|avoid|refrain\s+from)\s+(?:access|accessing|use|using|modify|modifying|change|alter|delete|test|testing|interact\s+with|target|targeting|view|read|copy|download|retain|store|collect|disrupt|exfiltrate)\b[^.;]*\b(?:other|another|others?|anyone\s+else'?s?|someone\s+else'?s?)\s+(?:users?'?s?\s+|customers?'?s?\s+|tenants?'?s?\s+)?(?:accounts?|data|information|services?)\b/i;

const PROGRAM_ISSUED_ACCOUNTS_RE =
  /\b(?:use|only\s+use|testing\s+with|test\s+with)\s+(?:only\s+)?(?:program|company|researcher|we)[\s-]?(?:issued|provided|assigned|provisioned|supplied)\s+(?:test\s+)?accounts?\b|\b(?:program|company)[\s-]?(?:issued|provided|assigned)\s+(?:test\s+)?accounts?\s+(?:are\s+)?(?:required|only)/i;

const CREDENTIAL_SOURCE_RULE_RE =
  /\b(?:leaked|stolen|breached|compromised|public(?:ly\s+(?:available|leaked))?|third[\s-]?party|other\s+people'?s?)\s+credentials?\b|\bcredentials?\s+(?:that\s+)?(?:you\s+do\s+not\s+own|belonging\s+to\s+(?:others?|third\s+parties)|are\s+leaked|are\s+stolen)|\b(?:do\s+not|don't|never|must\s+not)\s+(?:use|submit|provide|enter|try|test)\b[^.;]*\bcredentials?\b/i;

const CREDENTIAL_DENIED_TERMS: [RegExp, string][] = [
  [/\bleaked|stolen|breached|compromised/i, "leaked"],
  [/\bthird[\s-]?party|other\s+people'?s?|belonging\s+to\s+others?/i, "third_party"],
  [/\bpublic(?:ly)?\b/i, "public"],
];

const CUSTOMER_DATA_VALIDATION_RE =
  /\b(?:do\s+not|don't|never|must\s+not|stop|avoid|refrain)\b[^.;]*\b(?:validat|verif|confirm)\w*\b[^.;]*\b(?:customer|sensitive|personal|credential|user)\s+data\b|\b(?:customer|sensitive|personal|credential|user)\s+data\b[^.;]*\b(?:do\s+not|don't|never|must\s+not|stop|avoid|refrain)\b[^.;]*\b(?:validat|verif|confirm)\w*\b|\b(?:do\s+not|stop|never)\s+(?:attempt(?:ing)?\s+to\s+|try(?:ing)?\s+to\s+)?(?:successfully\s+)?(?:validat|verif|confirm)\w*\b[^.;]*(?:data|access)\s+(?:works?|is\s+valid|functions?)/i;

const THIRD_PARTY_DATA_RE =
  /\b(?:do\s+not|don't|never|must\s+not|shall\s+not|avoid|refrain\s+from)\s+(?:access|accessing|read|reading|copy|copying|download|downloading|retain|retaining|store|storing|collect|collecting|exfiltrat\w+|modify|modifying|delete|deleting|disrupt\w*|use|using|view|viewing|share|sharing|disclos\w+)\b[^.;]*\b(?:other\s+(?:users?|customers?|tenants?)|another\s+(?:user|customer)|customer|customers|sensitive|personal|third[\s-]?party|user|confidential)\b[^.;]*\b(?:data|information|accounts?|content|records?|pii)\b|\b(?:do\s+not|never|must\s+not)\b[^.;]*\b(?:access|copy|exfiltrat\w+|download|retain|collect|store)\b[^.;]*\b(?:customer|user|third[\s-]?party|confidential)\s+(?:data|information)\b/i;

/** Sensitivities a foreign-data prohibition denies; "confidential" joins
 * only when the rule text names it. */
function deniedSensitivity(text: string): string[] {
  const out = ["customer", "personal"];
  if (/\bconfidential\b/i.test(text)) out.push("confidential");
  return out;
}

/**
 * Compile one account/data rule sentence into a typed constraint. The
 * source text and its evidence refs always ride along for the audit trail.
 */
export function compileRule(
  text: string,
  evidenceRefs: string[] = [],
): GuardConstraint {
  const t = text.trim();
  const base = { source_text: t, evidence_refs: [...evidenceRefs] };

  if (CUSTOMER_DATA_VALIDATION_RE.test(t)) {
    return { ...base, kind: "technique_prohibition", technique: "customer_data_validation" };
  }

  if (CREDENTIAL_SOURCE_RULE_RE.test(t)) {
    const denied = CREDENTIAL_DENIED_TERMS.filter(([re]) => re.test(t)).map(
      ([, v]) => v,
    );
    return {
      ...base,
      kind: "credential_source",
      denied: denied.length > 0 ? denied : ["leaked", "third_party"],
    };
  }

  if (PROGRAM_ISSUED_ACCOUNTS_RE.test(t)) {
    return {
      ...base,
      kind: "account_ownership",
      allowed: ["researcher", "explicitly_authorized"],
    };
  }

  if (OTHER_PARTY_RULE_RE.test(t)) {
    // "Do not access data from anyone else's account" — the prohibited
    // object is the data; the foreign account is only a qualifier. "Do not
    // modify another user's account" — only own/authorized allowed.
    const dataIsObject =
      /\b(?:data|information)\s+(?:from|of|in|on|belonging\s+to)\b/i.test(t) ||
      (/\b(?:data|information)\b/i.test(t) && !/\baccounts?\b/i.test(t));
    if (dataIsObject) {
      return {
        ...base,
        kind: "data_access",
        denied_ownership: ["third_party", "customer", "employee"],
        denied_sensitivity: deniedSensitivity(t),
      };
    }
    return {
      ...base,
      kind: "account_ownership",
      allowed: ["researcher", "explicitly_authorized"],
    };
  }

  if (THIRD_PARTY_DATA_RE.test(t)) {
    return {
      ...base,
      kind: "data_access",
      denied_ownership: ["third_party", "customer", "employee"],
      denied_sensitivity: deniedSensitivity(t),
    };
  }

  for (const re of OWN_ACCOUNT_RULE_RES) {
    if (re.test(t)) {
      return { ...base, kind: "account_ownership", allowed: ["researcher"] };
    }
  }

  return { ...base, kind: "unresolved" };
}
