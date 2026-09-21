# Execution Guard Integration Plan

> **For agentic workers:** Execute inline with TDD. Spec: the "Harden Bugcrowd
> Engagement Exporter policy and integrity normalization" task brief (items
> 1–74) — the spec is the authority; this file maps it to files and order.

**Goal:** One canonical fail-closed execution gate (`runWithGuard`/`guardWrap`
on a prepared, validated, frozen `ProposedAction`), proof that no
production-reachable path bypasses it, and the 10-row acceptance matrix wired
through a counting executor.

**Architecture finding (pre-flight):** this repo ships no target-facing
executor. Every raw sink hits `bugcrowd.com`/`api.bugcrowd.com` (collection
plane — produces the dossier, is its own trust basis; gating it on the guard
would be circular and would fail closed permanently) or local state. The
guard's execution surface is the harness itself plus whatever external
agent harness consumes `lib/guard` or the CLI. Enforcement therefore =
canonical gate + fail-closed proof + a static architectural test that pins
the sink inventory and guard-module import rules so any future target-facing
executor cannot appear outside the guarded facade.

## Global constraints (verbatim from spec)

- `execution_allowed === (decision === "ALLOW")`; REVIEW and DENY are both
  blocking. Never `decision !== "DENY"` → run.
- Guard failure / malformed input fail closed: zero side effects.
- No planner-controlled bypass fields; no env/feature-flag that disables the
  guard in production; no catch-and-continue to a raw executor.
- Frozen: exporter V1, Scope Guard decision semantics, the 10-row matrix at
  `aafa455`. One focused commit at the end. Do not push. Do not touch
  `.playwright-mcp`.
- `npx vitest run`, `npx tsc --noEmit`, `npm run build` all green.

## File structure

- Modify `lib/guard/harness.ts` — canonical gate: `runWithGuard(params)`,
  `guardWrap(adapter, env)`, `prepareExecution`, `runPrepared`,
  `executeAdapter`, `GuardedExecutionResult`, `GuardEnvironment`,
  `ExecutionAdapter`, `PreparedExecution`, `GuardAuditRecord`,
  `ScopeGuardBlocked` (re-export), `ScopeGuardEvaluationError` (new).
  Replaces the pre-integration `(evaluate, executor, opts)` form — the old
  `guardWrap(decision, executor)` accepted a *precomputed* decision, which is
  the TOCTOU hole spec §8 forbids.
- Modify `lib/guard/index.ts` — export the new surface.
- Modify `tests/guard-evaluator.test.ts` — port the three §27 harness tests
  to the new API.
- Create `tests/guard-execution.test.ts` — §63 enforcement suite.
- Create `tests/guard-execution-matrix.test.ts` — §47/§71 matrix through a
  counting executor + §48 unknown-poison sweep.
- Create `tests/guard-architecture.test.ts` — §52/§64 static scans.
- Create `docs/EXECUTION-GUARD-AUDIT.md` — §65 call-graph artifact.
- Modify `docs/SCOPE-GUARD.md` — programmatic API section.

## Tasks

1. RED: write `tests/guard-execution.test.ts` + port harness block in
   `guard-evaluator.test.ts`; run → fail on missing/mismatched exports.
2. GREEN: rewrite `lib/guard/harness.ts` + `index.ts`; run new + ported
   tests and the full suite.
3. Write `tests/guard-execution-matrix.test.ts` (facts reconstructed to
   reproduce the recorded `.guard-matrix/out/*.json` decisions verbatim;
   embedded — the artifacts are untracked and must stay so).
4. Write `tests/guard-architecture.test.ts` (sink allowlist scan,
   `evaluateAction` importer restriction, bypass-flag scan, single-gateway
   check, no env kill-switch).
5. Write `docs/EXECUTION-GUARD-AUDIT.md`; update `docs/SCOPE-GUARD.md`.
6. Verify: vitest, tsc, wxt build; ledger; one commit.

## Review focus

- `metadata.now`/`trustedContext` must reach `evaluateAction` unchanged —
  decision hash determinism depends on it.
- `ScopeGuardEvaluationError` (guard-side failure) vs `ScopeGuardBlocked`
  (a real REVIEW/DENY decision) — both must carry `cause`/`decision`
  respectively and both must mean zero executions.
- `deepFreeze` runs on the *schema-validated copy* — freeze order vs. zod
  parse matters.
- Matrix fact reconstructions must reproduce recorded decisions for the
  right reasons (e.g. partial-integrity REVIEWs are faithful — recorded
  reason codes confirm the dossiers were partial), not just coincidentally.
- The architectural test's allowlist must match `docs/EXECUTION-GUARD-AUDIT.md`
  exactly — the doc and the test share one source of truth.
