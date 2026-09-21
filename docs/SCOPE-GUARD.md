# Scope Guard

A deterministic, machine-readable execution gate that sits between an AI
planner/security agent and any execution tool.

```text
Bugcrowd Engagement
        ↓
Exporter
        ↓
Agent Facts ──→ PolicyIR (compiled once)
        ↓            +
ProposedAction ──→ Guard checks ──→ decision lattice
        ↓
ALLOW / DENY / REVIEW
        ↓
Execution Harness
```

> **REVIEW is a blocking result. Only ALLOW may execute.**

The execution harness must run an action only when:

```ts
decision.decision === "ALLOW" && decision.execution_allowed === true;
```

`DENY` and `REVIEW` both mean `execution_allowed === false`. Never write
`if (decision !== "DENY") execute()` — that inverts the safety property.

## Threat model and trust boundaries

- The **planner** (an AI agent) proposes actions. It is not trusted to decide
  whether its own action is authorized, and it cannot certify facts about the
  world. Only Scope Guard decides.
- **Agent Facts** come from the exporter. They are trusted only when the
  dossier's integrity checks pass (complete collection, valid evidence corpus
  hash, verified known-issues counts, complete required sections, zero
  unresolved policy conflicts). Otherwise the gate returns REVIEW — an
  untrusted policy supports neither ALLOW nor a semantic DENY.
- **Context facts** attest to runtime state (account ownership, credential
  source, prior approval). A fact only *satisfies* a condition when
  `verification: "verified"` **and** `source` is not `"planner"`. A
  planner-asserted value can still *fail* a condition — a declared violation
  is a DENY. A satisfying attestation can never wash out a violating value.
- The gate contains **no LLM and no network access**. Evaluation after policy
  compilation is a pure function of `(policy, action, trustedContext)`.
- Scope Guard never performs security testing: it parses, canonicalizes, and
  evaluates. It does not send requests, scan, log in, or submit reports.

### Error ordering

A false ALLOW is the worst error. A false DENY is undesirable but safer.
REVIEW is the expected outcome whenever permission cannot be established
deterministically. Unknown never becomes DENY — DENY requires an explicit
applicable prohibition or a verified-false/declared-violation condition.

## Agent Facts: additive scope extension

`renderAgentFacts()` emits these additive keys (dossier schema unchanged;
`agent_facts_schema_version` versions independently):

```yaml
agent_facts_schema_version: 1
engagement:
  code: zendesk
scope_inventory:
  in_scope:
    - target_id: target_ab5af1b9
      location: Zendesk Suite https://{subdomain}.zendesk.com/
      name: Zendesk Suite
      category: website
      scope_group_ids: [group:zendesk-suite]
      evidence_refs: [ev_...]
  out_of_scope:
    - target_id: ...
      location: support.zendesk.com
      notes: null
scope_groups:
  - id: group:zendesk-suite
    name: Zendesk Suite
    in_scope: true
    evidence_refs: [ev_...]
account_rules: [{ text, evidence_refs }]
data_rules: [{ text, evidence_refs }]
```

`authorized_scope` additionally carries `exceptions` — written-consent
carve-outs that re-open *evaluation* of otherwise unlisted/out-of-scope
targets:

```yaml
authorized_scope:
  listed_targets: { status: conditional, conditions: [...] }
  unlisted_targets: { status: prohibited }
  exceptions:
    - applies_to: out_of_scope_targets
      condition:
        kind: prior_written_consent        # or source_text (verbatim, review-only)
        issuer: program_security_team
        verification_required: true
      effect: permit_evaluation            # never a permission
      evidence_refs: [ev_...]
```

An exception is never a permission: it can only re-open *evaluation* of a
target the baseline already denies. The evaluator consumes it as follows:

- **No consent claim at all** — the exception is not invoked; the baseline
  `out_of_scope`/`unlisted_targets: prohibited` verdict stands (DENY).
- **Consent claimed but not verified** — a `prior_written_consent` claim
  exists (`authorization.prior_written_consent === true` in `context_facts`
  or `trustedContext`, any source/verification) but is not `verified` +
  non-`planner` → REVIEW (`AUTHORIZATION_EXCEPTION_UNVERIFIED`). A claim
  also REVIEWs when the exception's `applies_to` is unrecognized or its
  condition is an unverifiable kind (`source_text`, unknown kind, or a
  non-`permit_evaluation` effect).
- **Verified consent** — a verified non-planner
  `authorization.prior_written_consent === true` → the baseline target
  denial is lifted and evaluation *continues*
  (`AUTHORIZATION_EXCEPTION_VERIFIED`). Other dimensions still decide: a
  prohibited technique still DENYs, a policy-less technique still REVIEWs,
  and ALLOW only emerges if every dimension passes.

The exporter compiles exceptions only from explicit written-authorization
phrasing ("prior written consent/permission/authorization/approval") with
testing or excluded-system context — never from generic "contact us /
request permission" language. When no program-side issuer is recognizable
the condition stays verbatim `source_text`. Missing `exceptions` on an old
dossier means "no exceptions", not "unverified permission".

`program_state` is the operational axis, separate from testing
authorization:

```yaml
program_state:
  submission_state: open | paused | closed | unknown
  testing_state: unspecified   # a submission pause is not a testing rule
  reward_state: eligible | ineligible | conditional | unknown
  effective_at_text: "Aug 1 at 12:00am Pacific Time"   # verbatim, never computed
  resume_at: null
  evidence_refs: [ev_...]
```

The exporter asserts a state only on explicit operational language
("pausing the program", "stop accepting new bounty submissions",
"no longer accepting", "resumed/reopened"). A negated or future resume
("we do not yet have a date for resuming") is evidence, not a state flip.
Within one brief, the last state assertion in document order wins; the
exporter never derives state from the announcements feed or from the
absence of a resume notice. `program_state: null` (or absent on an old
dossier) means unknown — never inferred, and contributes no check.
Submission availability, reward eligibility, and testing permission stay
three separate axes: `paused` submissions + `ineligible` rewards +
`unspecified` testing is the honest normalization of a pause announcement.

When a `program_state` is present, the gate consumes each axis separately:

- `testing_state` — the only axis that gates execution:
  `prohibited` → DENY (`PROGRAM_TESTING_PROHIBITED`), `allowed` → pass,
  `unspecified`/missing → REVIEW (`PROGRAM_TESTING_UNSPECIFIED`).
- `submission_state` — eligibility only: `paused`/`closed` →
  `eligibility.submission = "excluded"` (`PROGRAM_SUBMISSIONS_PAUSED`),
  `open` → `eligible`, else `unknown`. Never a testing verdict.
- `reward_state` — eligibility only: `ineligible` →
  `eligibility.reward = "ineligible"` (`REWARD_INELIGIBLE`), `eligible` →
  `eligible`, else `unknown`. Never a testing verdict.

So Code.org's `paused`/`unspecified`/`ineligible` state yields REVIEW with
the submission/reward marks on their own axes — never a fabricated
testing prohibition, and never an ALLOW on an unspecified axis.

The inventory is generated from already-normalized `DocumentModel.targets` /
`targetGroups` — no new inference. Old dossiers lacking `scope_inventory`
parse fine; the compiler emits `SCOPE_INVENTORY_UNAVAILABLE` and the
evaluation REVIEWs whenever target scope cannot be proven.

## ProposedAction

```ts
type ProposedAction = {
  schema_version: 1;
  engagement: { code: string };
  target: { url: string; target_id?: string };
  technique: { id: string; label?: string };
  operation: {
    kind: "read" | "write" | "create" | "update" | "delete" | "upload"
        | "send" | "execute" | "authenticate" | "scan" | "other";
    destructive?: boolean;
    external_side_effect?: boolean;
  };
  automation?: {
    automated: boolean;
    scanner?: boolean;
    tool_type?: string;                     // e.g. "intrusive_automation"
    estimated_requests?: number;
    estimated_requests_per_minute?: number;
    requests_per_second?: number;
  };
  credentials?: { source: "none" | "own" | "program_issued" | "public"
                        | "third_party" | "leaked" | "unknown" };
  account?: { ownership: "researcher" | "explicitly_authorized"
                      | "third_party" | "unknown" };
  data?: {
    ownership: "researcher" | "test" | "customer" | "employee"
             | "explicitly_authorized" | "third_party" | "unknown";
    sensitivity?: "none" | "personal" | "credentials" | "financial"
                | "customer" | "confidential" | "unknown";
  };
  context_facts?: ContextFact[];
};

type ContextFact = {
  key: string;                                  // e.g. "account.ownership"
  value: string | number | boolean;
  source: "runtime" | "user" | "program" | "tool" | "planner";
  verification: "verified" | "asserted" | "unknown";
};
```

The schema is `.strict()` — unknown keys are rejected. There are no bypass
fields (`force`, `skip_scope_guard`, `authorized`, `override`): a planner
cannot attach one.

Action-declared fields (`account.ownership`, `credentials.source`,
`data.*`) are planner claims — they count as *asserted* context and can fail
a constraint but can never satisfy one alone. Trusted context comes from
`context_facts` / `trustedContext` entries with `verification: "verified"`
and a non-planner `source`.

### Techniques

`technique.id` is canonicalized through a deterministic alias table
(`canonicalTechniqueId`, also exported as `canonicalizeTechnique`):
`denial_of_service`, `automated_scanners`, `automated_scanning`,
`automated_tools`, `form_submission_automation`, `cross_account_testing`,
`customer_data_validation`, `social_engineering`, `physical_testing`,
`rate_limiting`, `application_dos`, `intrusive_automation`, plus the
vulnerability classes VRT rows and exclusion rows name (`xss`,
`broken_access_control`, ...). Unknown ids → `TECHNIQUE_UNKNOWN` → REVIEW.
No fuzzy matching.

## Target resolution

`resolveTarget(url, scope_inventory)` matches a proposed URL against the
declared inventory:

- **Anchored matching only** — never substring. `*.example.com` requires a
  DNS-label boundary: it matches `api.example.com` but never
  `evil-example.com`, `example.com.attacker.tld`, or the apex `example.com`.
- `{subdomain}` placeholders match exactly one DNS label each.
- Bare hosts, scheme-qualified URLs, `:port`, and `/path` forms are all
  supported; a pattern path is a segment-boundary prefix. A row may carry
  multiple URLs; all are extracted.
- **Specificity**: exact host > `{placeholder}` host > `*.wildcard`; within a
  class, more host labels then longer path prefix wins. The top-specificity
  match decides — an exact out-of-scope listing overrides an in-scope
  wildcard, and vice versa.
- Equal-specificity in/out conflicts → `ambiguous` → REVIEW. Array order is
  never consulted.

Resolution outcomes: `matched_in_scope` / `matched_out_of_scope` (with
`target_ids` + `evidence_refs`), `unlisted`, `ambiguous`.

A `target.target_id` on the action resolves top-specificity: the id is
looked up in the inventory and the URL only has to be consistent with that
row; an id absent from the inventory → `TARGET_ID_UNRESOLVED` → REVIEW.

`authorized_scope` then applies: an explicit listed match satisfies
`target_is_explicitly_listed` conditions; `unlisted` falls to
`unlisted_targets.status` (`prohibited` → DENY, anything else → REVIEW
unless `allowed`).

## Conditions

`compileCondition(text)` maps recognized condition clauses to typed
predicates; anything else compiles to `unresolved` → REVIEW (never true):

| predicate | satisfies when |
|---|---|
| `target_is_explicitly_listed` | target resolution is `matched_in_scope` |
| `account_ownership` | verified `account.ownership` ∈ allowed set |
| `data_ownership` | verified `data.ownership` ∈ allowed set |
| `prior_authorization` | verified `authorization.prior_approval === true` |
| `non_destructive` | `operation.destructive === false` declared |
| `rate_limit` | declared rate ≤ rule ceiling; reads `automation.requests_per_second` (converted to rpm) or `automation.estimated_requests_per_minute` — none declared → REVIEW |
| `unresolved` | never — always REVIEW |

`compileRule(text)` handles whole-sentence account/data rules:
account-ownership allow-lists ("only test accounts you own"),
credential-source denials ("do not use leaked credentials"), data-access
denials ("do not access other users' data"), program-issued account
requirements, and technique prohibitions ("do not validate customer data").
Uncompilable prose → `unresolved` → REVIEW on every action.

Conditional evaluation is tri-state: every predicate `true` → continue;
any `false` (verified or declared violation) → DENY; any `unknown` → REVIEW.

## Evaluation pipeline

Deterministic order; no check may convert an existing DENY into ALLOW:

1. **Integrity** — `collection.status === "complete"`,
   `evidence_hash_valid`, `known_issues_counts_valid`,
   `required_sections_complete`, `unresolved_conflicts === 0`.
   Any failure short-circuits to REVIEW. `api_status: "unavailable"` does
   **not** block when the exporter declared the collection complete.
2. **Engagement** — `engagement.code` must match exactly → else REVIEW.
3. **Safe harbor** — `present` continues (`SAFE_HARBOR_PRESENT`);
   `absent`/`unclear`/missing → REVIEW (`SAFE_HARBOR_ABSENT` /
   `SAFE_HARBOR_UNCLEAR`). Never a DENY cause, never an upgrade.
4. **Program state** — `testing_state`: `prohibited` → DENY
   (`PROGRAM_TESTING_PROHIBITED`), `allowed` → pass,
   `unspecified` → REVIEW (`PROGRAM_TESTING_UNSPECIFIED`); a missing
   `program_state` contributes no check. `submission_state`/`reward_state`
   never gate — they mark the eligibility axes
   (`PROGRAM_SUBMISSIONS_PAUSED` → `submission: "excluded"`,
   `REWARD_INELIGIBLE` → `reward: "ineligible"`).
5. **Target resolution + authorized scope** — see above. Baseline target
   denials then consult `authorized_scope.exceptions`: unclaimed → DENY
   stands; claimed unverified → REVIEW
   (`AUTHORIZATION_EXCEPTION_UNVERIFIED`); verified → continue
   (`AUTHORIZATION_EXCEPTION_VERIFIED`).
6. **VRT rules** — canonical category match + `applies_to` coverage;
   `out_of_scope` → DENY, `conditional` → REVIEW.
7. **Technique rules** — `prohibited` → DENY; `allowed` → pass;
   `conditional` → predicate tri-state; `unspecified`/absent → REVIEW.
   Applicability respects `target_ids` / `target_group_ids` / `engagement`
   and is tri-state: `yes` → rule applies; `no` → rule skipped
   (`APPLICABILITY_NOT_MATCHED`); `unknown` → REVIEW
   (`APPLICABILITY_UNRESOLVED` — an unrecognized `applies_to` type never
   widens to engagement-wide). `conditional_context` resolves each
   antecedent against trusted context: a verified non-planner
   `context.phase === "post_compromise"` applies the rule, a verified
   different phase skips it, missing/unverified/planner-asserted context
   REVIEWs, and verbatim `antecedent_text` is always `unknown` — the gate
   does not NLP free text.
8. **Automation overlay** — `automation.automated`/`scanner` pulls in the
   automation rule family (`automation`, `automated_scanners`,
   `automated_scanning`, `automated_tools`, `scanning`,
   `intrusive_automation`, `rate_limiting`) regardless of the declared
   technique — but never re-reports a rule the technique pass already
   evaluated.
9. **Credentials / account / data constraints** — typed rule evaluation.
10. **Eligibility** — `submission_exclusions` matching the action's
    canonical technique report `submission`/`reward` on their own axis.
    Only an exclusion with `testing_status: prohibited` DENYs
    (`EXCLUSION_TESTING_PROHIBITED`); `excluded`/`ineligible` alone never
    deny.
11. **Aggregate** — any `fail` → DENY; else any `unknown` → REVIEW; else
    ALLOW.

## Decision output

```ts
type GuardDecision = {
  schema_version: 1;
  decision: "ALLOW" | "DENY" | "REVIEW";
  execution_allowed: boolean;        // === (decision === "ALLOW")
  reason_codes: GuardReasonCode[];   // sorted, stable API contract
  policy_hash: string;               // sha256 over canonical Agent Facts
  action_hash: string;               // sha256 over canonical ProposedAction
  decision_hash: string;             // sha256 over canonical decision preimage
  engagement_code: string;
  target_resolution: { input; status; target_id?; matched_target_ids?; evidence_refs? };
  checks: GuardCheck[];              // per-dimension audit trace
  evidence_refs: string[];           // union of check evidence, sorted
  eligibility: { submission: "eligible"|"excluded"|"unknown";
                 reward: "eligible"|"ineligible"|"unknown" };
  unresolved_requirements: string[]; // human-readable REVIEW causes
  evaluated_at: string;              // ISO-8601; excluded from all hashes
};
```

Each `GuardCheck` records `check` (dimension), `result`
(`pass`/`fail`/`unknown`/`not_applicable`), `reason_code`, `rule_status`,
`detail`, `evidence_refs`, and `predicate_results` for conditional rules.

Hashes use the repo's canonical JSON (recursively sorted keys) + SHA-256.
`evaluated_at` and other volatile values never enter a preimage — identical
inputs produce identical `decision_hash` at any clock.

### Reason codes

```
ACTION_INVALID  FACTS_INVALID
DOSSIER_PARTIAL  DOSSIER_FAILED  EVIDENCE_HASH_INVALID
KNOWN_ISSUES_COUNTS_INVALID  REQUIRED_SECTIONS_INCOMPLETE  POLICY_CONFLICT
SAFE_HARBOR_PRESENT  SAFE_HARBOR_ABSENT  SAFE_HARBOR_UNCLEAR  ENGAGEMENT_MISMATCH
PROGRAM_SUBMISSIONS_PAUSED  PROGRAM_TESTING_PROHIBITED
PROGRAM_TESTING_UNSPECIFIED
SCOPE_INVENTORY_UNAVAILABLE
TARGET_IN_SCOPE  TARGET_OUT_OF_SCOPE  TARGET_UNLISTED  TARGET_AMBIGUOUS
TARGET_ID_UNRESOLVED  UNLISTED_TARGETS_PROHIBITED  LISTED_TARGETS_PROHIBITED
AUTHORIZATION_EXCEPTION_AVAILABLE  AUTHORIZATION_EXCEPTION_VERIFIED
AUTHORIZATION_EXCEPTION_UNVERIFIED
APPLICABILITY_MATCHED  APPLICABILITY_NOT_MATCHED  APPLICABILITY_UNRESOLVED
TECHNIQUE_ALLOWED  TECHNIQUE_PROHIBITED  TECHNIQUE_CONDITIONAL
TECHNIQUE_UNSPECIFIED  TECHNIQUE_UNKNOWN  TECHNIQUE_NO_POLICY
EXCLUSION_TESTING_PROHIBITED
CONDITION_SATISFIED  CONDITION_FAILED  CONDITION_UNRESOLVED
ACCOUNT_CONSTRAINT_FAILED  ACCOUNT_CONTEXT_UNVERIFIED
DATA_CONSTRAINT_FAILED  DATA_CONTEXT_UNVERIFIED
CREDENTIAL_SOURCE_PROHIBITED  CREDENTIAL_SOURCE_UNVERIFIED
RULE_UNRESOLVED
VRT_RULE_PROHIBITED  VRT_RULE_CONDITIONAL  VRT_RULE_UNRESOLVED
SUBMISSION_EXCLUDED  REWARD_INELIGIBLE
```

## CLI

```bash
node lib/guard/cli.ts check \
  --dossier ./bugcrowd-zendesk.md \
  --action ./action.json \
  [--context ./context.json] [--compact] [--json]
```

- `--dossier` accepts a full Markdown dossier (the fenced `## Agent Facts`
  block is extracted) or a bare Agent Facts YAML/JSON file.
- `--action` is a ProposedAction in JSON or YAML.
- `--context` is an optional `ContextFact[]` file (trusted attestations).
- `--compact` emits the decision as one JSON line; `--json` is an explicit
  alias for the default JSON output.

Exit codes: `0` ALLOW, `10` REVIEW, `20` DENY, `2` invalid input/runtime.
The decision JSON goes to stdout; diagnostics to stderr.

## Programmatic API

```ts
import {
  evaluateScopeGuard,   // one-shot: parse + compile + evaluate
  compilePolicy,        // compile once
  evaluateAction,       // evaluate many actions against a CompiledPolicy
  evaluateCondition,    // evaluate a single compiled condition (tri-state)

  // canonical execution gate — the ONLY sanctioned path to a side effect
  runWithGuard,         // validate → evaluate → audit → execute iff ALLOW
  guardWrap,            // adapter → prepared plan → gate, one call shape
  executeAdapter,       // one-shot form of guardWrap
  prepareExecution,     // adapter → validated, deep-frozen PreparedExecution
  runPrepared,          // run a prepared plan through the gate
  ScopeGuardBlocked,    // thrown on REVIEW/DENY — carries the GuardDecision
  ScopeGuardEvaluationError,  // guard-side failure — also fail-closed
  ScopeGuardInputError,
  // deterministic helpers + aliases
  canonicalTechniqueId, // also exported as canonicalizeTechnique
  compileCondition, compileRule,
  resolveTarget,
  policyHash, actionHash, decisionHash,   // also hashPolicy/hashAction/hashDecision
} from "@/lib/guard/index.ts";

// one-shot
const decision = await evaluateScopeGuard({ agentFacts, action, trustedContext });

// reused policy
const policy = await compilePolicy(agentFacts);
const d2 = await evaluateAction(policy, action, { trustedContext });

// canonical gate — the executor closure is invoked only when
// decision === "ALLOW" && execution_allowed === true
const res = await runWithGuard({
  policy,
  action,
  trustedContext,
  execute: () => executor.run(action),
  metadata: { executor_id: "http-executor", correlation_id, audit: sink.write },
});
// res = { decision, executed: true, result, execution: { executor_id,
//         correlation_id, started_at, completed_at } }
// throws ScopeGuardBlocked on REVIEW/DENY — never returns "not executed"

// adapter path — the adapter owns the deterministic input→ProposedAction
// mapping; prepareExecution validates the action and deep-freezes it, so
// the evaluated action IS the executed action (no TOCTOU)
const adapter: ExecutionAdapter<Req, Resp> = {
  prepare: (input) => ({
    proposedAction: toProposedAction(input),
    execute: () => rawExecutor(input),
  }),
};
const env: GuardEnvironment = { policy, trustedContext, executor_id: "http" };
const guarded = guardWrap(adapter, env);
await guarded(req);          // throws ScopeGuardBlocked unless ALLOW
await runPrepared(prepareExecution(adapter, req), env);  // equivalent
```

Blocking semantics: `REVIEW` and `DENY` throw `ScopeGuardBlocked` (which
carries the full `GuardDecision` — hashes, reason codes, evidence refs).
Guard-side failures — malformed `ProposedAction`, evaluation throw, adapter
that cannot map deterministically, audit-hook failure — throw
`ScopeGuardEvaluationError`. Every failure mode fails closed: the executor
closure is never invoked. The audit hook fires exactly once per decision,
before the executor, with hashes + reason codes only — never action bodies
or payloads.

Invalid `ProposedAction` input throws `ScopeGuardInputError` at the
`evaluateScopeGuard` boundary (CLI exit 2) and `ScopeGuardEvaluationError`
inside the gate — it is never coerced into a decision.

## Shadow mode

Call `evaluateScopeGuard`/`evaluateAction` and log the decision without
wiring the executor gate. The returned decision is identical — shadow mode
is an integration choice, not a different evaluation.

## Examples

`ALLOW` — listed target, explicitly allowed technique, clean integrity:

```json
{ "decision": "ALLOW", "execution_allowed": true,
  "reason_codes": ["CONDITION_SATISFIED", "TARGET_IN_SCOPE", "TECHNIQUE_ALLOWED"] }
```

`DENY` — out-of-scope target: `["TARGET_OUT_OF_SCOPE"]`; unlisted target
under `unlisted_targets: prohibited`: `["UNLISTED_TARGETS_PROHIBITED"]`;
prohibited technique: `["TECHNIQUE_PROHIBITED"]`.

`REVIEW` — partial dossier: `["DOSSIER_PARTIAL"]`; unresolved condition:
`["CONDITION_UNRESOLVED"]`; planner-only attestation:
`["ACCOUNT_CONTEXT_UNVERIFIED"]`; ambiguous target: `["TARGET_AMBIGUOUS"]`.

## Known limitations

- **ALLOW is rare by design.** `unspecified` techniques and uncompilable
  prose rules REVIEW. Programs whose rules are natural-language sentences
  outside the compiled patterns will always REVIEW — that is the safe
  answer, not a bug to optimize away.
- The condition/rule compiler covers the patterns present in validated
  fixtures; new phrasings compile to `unresolved`. Extending coverage means
  adding deterministic patterns to `lib/guard/conditions.ts`, never an LLM.
- `data_rules`/`account_rules` are evaluated per-action as blanket
  constraints; a rule that genuinely applies only to some action kinds may
  over-block to REVIEW.
- VRT `applies_to` matching is token/label-based against resolved target
  names, locations, and group names; exotic apply-lists may evaluate as
  `unknown` → REVIEW.
- `{placeholder}` labels match exactly one DNS label; targets expressed only
  as names (no URL/host) cannot resolve a proposed URL → `unlisted`.
- Authorization exceptions only model *written consent from the program*:
  the evaluator recognizes exactly the `authorization.prior_written_consent`
  context key. Other consent artifacts (`source_text`, unrecognized
  `applies_to`, non-`permit_evaluation` effects) always REVIEW when invoked.
- `program_state` gates only `testing_state`; there is no submission action
  kind, so `submission_state`/`reward_state` surface as eligibility marks
  rather than verdicts.
- Exception coverage is limited to explicit written-authorization phrasing;
  other consent forms compile to verbatim `source_text` or nothing.
- Trusted context provenance is modeled by `source`/`verification`; the gate
  does not verify signatures — authenticating the runtime channel is the
  harness's job.
- There is no human override path. If one is ever needed it must be a
  separate, auditable mechanism — not an action field.
