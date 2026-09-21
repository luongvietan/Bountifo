# Scope Guard — consume deferred IR dimensions

> **For agentic workers:** Implement inline with TDD (red → green per area). Spec: the Scope Guard spec in the task brief (§1–§72).

**Goal:** Wire the three compiled-but-unconsumed PolicyIR dimensions (`program_state`, `authorized_scope.exceptions`, `conditional_context` applicability) into `evaluateAction`, plus small spec-conformance fixes (rate field, technique ids, target_id resolution, CLI `--json`, API aliases).

**Baseline:** HEAD `2d05c7f`, 45 test files / 666 tests green, `tsc --noEmit` = 0 errors (docs/typecheck-baseline.md — absolute gate).

**Architecture:** Extend `lib/guard/evaluator.ts` (tri-state applicability, exception bypass, program-state axes, eligibility merge), `lib/guard/targets.ts` (target_id match), `lib/guard/types.ts` + `conditions.ts` + `techniques.ts` (schema/conformance), `lib/guard/cli.ts` (`--json`), `lib/guard/index.ts` (aliases). No new modules; no deps.

## Global constraints

- `execution_allowed === (decision === "ALLOW")`. REVIEW is blocking.
- No LLM/fuzzy/network. Verified facts must be `verification:"verified"` AND `source!=="planner"`. Planner-asserted *violations* still fail.
- Invalid integrity → REVIEW only (never semantic DENY from untrusted facts).
- permit_evaluation ≠ ALLOW. Submission/reward axes never decide testing.
- Equal-specificity scope conflict → ambiguous → REVIEW; specific OOS beats wildcard IS.
- `npm test`, `npm run typecheck`, `npm run build` must all stay green.

## Review Focus

- `program_state.testing_state` is always `"unspecified"` from the exporter — emitting `unknown` for it REVIEWs any dossier carrying a state block. Only emit when `program_state` is present (absent → no contribution, §60).
- Verified consent bypass must not leak into ALLOW: subsequent technique/account/data checks still run unchanged.
- `conditional_context` verified-false must read "not applicable", not "unknown" — they differ (REVIEW vs continue).
- `unlisted` + `unlisted_targets: allowed` + target_ids-scoped rule must not silently apply.
- automation overlay must not double-evaluate a rule already checked as the declared technique.

## Tasks

### Task 1 — Tests: conditional_context applicability (Okta)

Test file: `tests/guard-applicability.test.ts` (new). Synthetic complete facts with technique `"Port scanning internal networks"` → `prohibited`, `applies_to: {type:"conditional_context", conditions:[{kind:"phase",value:"post_compromise"}]}`.

- no phase context → REVIEW, `APPLICABILITY_UNRESOLVED`
- verified `context.phase=post_compromise` (non-planner) → DENY
- verified `context.phase=recon` → rule not applicable → `APPLICABILITY_NOT_MATCHED` check `not_applicable`; no other rule → `TECHNIQUE_NO_POLICY` → REVIEW (not DENY)
- planner-asserted `context.phase=post_compromise` → REVIEW
- `antecedent_text` condition → REVIEW
- unknown `applies_to.type` → REVIEW

### Task 2 — Implement tri-state applicability

`evaluator.ts`: replace boolean `appliesTo` with `applicability(): "yes"|"no"|"unknown"`. `conditional_context`: conditions OR'd; `{kind:"phase"}` reads trusted `context.phase`; `{kind:"antecedent_text"}` → unknown; empty conditions → unknown. Unknown `type` → unknown. Technique loop: `no` → skip (emit `applicability`/`not_applicable`/`APPLICABILITY_NOT_MATCHED` for conditional_context only), `unknown` → `applicability`/`unknown`/`APPLICABILITY_UNRESOLVED`, `yes` → `techniqueCheck`. If no applicable rule for the canonical id → `TECHNIQUE_NO_POLICY` (unchanged).

### Task 3 — Tests: authorization exceptions (Barracuda)

Synthetic facts: `authorized_scope` listed conditional-listed-in-scope + unlisted prohibited + exception `{applies_to:"out_of_scope_targets", condition:{kind:"prior_written_consent", issuer:"program_security_team", verification_required:true}, effect:"permit_evaluation"}`; OOS inventory entry; DoS prohibited technique.

- OOS target, no consent → DENY `TARGET_OUT_OF_SCOPE`
- OOS + planner-asserted `authorization.prior_written_consent=true` → REVIEW `AUTHORIZATION_EXCEPTION_UNVERIFIED`
- OOS + verified consent (source `program`) → not DENY on target; technique no-policy → REVIEW, `AUTHORIZATION_EXCEPTION_VERIFIED` present
- OOS + verified consent + DoS → DENY `TECHNIQUE_PROHIBITED`
- OOS + verified consent + allowed technique + all verified → ALLOW is legitimate
- `source_text`/unknown condition kind → REVIEW; unknown `applies_to` → REVIEW
- exception `applies_to:"unlisted_targets"` bypasses unlisted-prohibited baseline when verified

### Task 4 — Implement exceptions

In `evaluator.ts` target section: on `matched_out_of_scope` (and `unlisted`+`prohibited`), evaluate applicable exceptions first (`out_of_scope_targets`/`unlisted_targets`/`target_ids`/`target_group_ids`; unknown applies_to counts as applicable-unverifiable). Verified = trusted `authorization.prior_written_consent === true`. Verified → `authorization_exception` pass + `AUTHORIZATION_EXCEPTION_VERIFIED`, record target `pass` (detail notes consent), continue. Applicable-but-unverified → exception `unknown` + `AUTHORIZATION_EXCEPTION_UNVERIFIED` + target `unknown` → REVIEW. None → baseline fail.

### Task 5 — Tests: program_state + eligibility (Code.org)

Facts: `program_state:{submission_state:"paused", testing_state:"unspecified", reward_state:"ineligible"}`.

- decision REVIEW (never DENY from submission/reward); `PROGRAM_SUBMISSIONS_PAUSED`, `REWARD_INELIGIBLE`; eligibility `{excluded, ineligible}`
- `testing_state:"prohibited"` → DENY `PROGRAM_TESTING_PROHIBITED`
- `testing_state:"allowed"` + otherwise-ALLOW fixture → ALLOW
- absent `program_state` → no `program_state` check
- `testing_state` unspecified → `PROGRAM_TESTING_UNSPECIFIED`

### Task 6 — Implement program_state

After safe-harbor: if `ir.program_state` present emit `program_state` check (prohibited→fail, allowed→pass, else→unknown). In eligibility block: `paused`/`closed` → submission `excluded` + `not_applicable` check `PROGRAM_SUBMISSIONS_PAUSED`; `open` → `eligible`. `reward_state` `ineligible` → `ineligible` + `REWARD_INELIGIBLE`; `eligible` → `eligible`. Exclusions still override toward excluded/ineligible.

### Task 7 — Tests: LastPass, Rapyd, conformance edges

- LastPass synthetic: `"Automated tools"` conditional `"no more than 5 requests per second"`. `requests_per_second:3`→pass path; `8`→DENY `CONDITION_FAILED`; missing→REVIEW. (Add `requests_per_second`/`tool_type` optional fields to `automation` schema.)
- Rapyd: `cross_account_testing` conditional own-accounts + `data_rules` "do not access data from anyone else's account" → `data.ownership:"third_party"` declared → DENY; verified researcher → passes data rule.
- Integrity isolation: only `known_issues_counts_valid:false` → REVIEW; only `required_sections_complete:false` → REVIEW.
- `technique.id:"quantum replay"` → `TECHNIQUE_UNKNOWN` REVIEW.
- safe_harbor `absent` → `SAFE_HARBOR_ABSENT` (rename from UNCLEAR for that case; unclear/missing keep UNCLEAR).
- `resolveTarget(url, inv, target_id)` matches by id at top specificity.
- context_facts order shuffle → same decision_hash; adding unknown-source facts never improves a REVIEW/DENY.

### Task 8 — Implement conformance items

- `types.ts`: automation `requests_per_second?`, `tool_type?`; data.ownership += `"test"|"customer"|"employee"`; sensitivity += `"confidential"`; reason codes += `SAFE_HARBOR_ABSENT`, `PROGRAM_SUBMISSIONS_PAUSED`, `PROGRAM_TESTING_PROHIBITED`, `PROGRAM_TESTING_UNSPECIFIED`, `APPLICABILITY_MATCHED`, `APPLICABILITY_NOT_MATCHED`, `APPLICABILITY_UNRESOLVED`, `AUTHORIZATION_EXCEPTION_AVAILABLE`, `AUTHORIZATION_EXCEPTION_VERIFIED`, `AUTHORIZATION_EXCEPTION_UNVERIFIED`; GuardCheck.check += `"program_state"|"authorization_exception"|"applicability"`.
- `conditions.ts`: `rate_limit` reads rps (`*60`) else rpm; data_ownership allowed += `"test"`; data_access denied_ownership += `customer`,`employee`; denied_sensitivity += `confidential`.
- `techniques.ts`: add ids `automated_scanning`, `automated_vulnerability_scanning`, `port_scanning_internal_networks`, `burp_scanning`, `other_account_data_access`, `customer_personal_data_access`, `credit_card_data_access`, `confidential_information_access`, `third_party_file_sharing` + deterministic aliases.
- `targets.ts`: `resolveTarget(rawUrl, inventory, targetId?)` — explicit id match outranks URL matches.
- `hash.ts`/`policy.ts`: `policy_hash` preimage = `{engine_version, ir}` (normalized IR content, per spec §41).
- `cli.ts`: accept `--json` (no-op; output already JSON) in usage.
- `index.ts`: export aliases `canonicalizeTechnique`, `hashPolicy`/`hashAction`/`hashDecision`, and `evaluateCondition` (compile + evaluate a predicate standalone).
- Dedupe automation overlay rules already evaluated as the declared technique.

### Task 9 — Docs + verify

Update `docs/SCOPE-GUARD.md`: remove "not yet consumed" limitation; document exceptions semantics, program-state axes, `context.phase`, `requests_per_second`, new reason codes, `--json`. Run `npx vitest run`, `npx tsc --noEmit`, `npm run build`. Commit `feat: consume program state, authorization exceptions, and contextual applicability in scope guard`.
