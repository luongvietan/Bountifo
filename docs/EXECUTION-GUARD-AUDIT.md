# Execution Guard Audit

Baseline: `aafa455` (Scope Guard V1 + Exporter V1 frozen). This document is
the call-graph audit required by the execution-enforcement phase: every
production-reachable side-effect surface, its classification, and why the
guard boundary is complete.

## 1. Executive summary

This repository ships a **Bugcrowd engagement exporter**, not a testing
agent. A full sink scan found **no target-execution plane**: no scanner,
no subprocess, no generic tool bridge, no arbitrary-URL fetch, no upload
or mutation API. Every side-effect primitive in production code is one of:

- **Collection plane** — reads from `bugcrowd.com` and the extension's own
  pages to build the dossier/facts that Scope Guard later consumes. These
  calls are *inputs* to authorization, not actions authorized by it.
- **Local bookkeeping** — IndexedDB job state, session-scoped descriptors,
  credential storage, final file download, extension messaging. None
  touches an engagement target.

Because there is no target-facing executor today, the enforcement work is:
(1) one canonical gate — `runWithGuard` — that any future executor must
use, (2) a closed, test-enforced registry of side-effect surfaces so a new
unguarded sink fails CI, and (3) proof that REVIEW/DENY/error paths can
never reach an executor.

## 2. Entrypoints → sinks (forward graph)

```
popup/main.ts ──runtime.sendMessage──▶ background.ts
options/main.ts ──runtime.sendMessage──▶ background.ts
                                         │ op routing
                                         ├─ apiRequest ──▶ api/client.ts ──▶ fetch → bugcrowd.com API (GET only)
                                         ├─ sendToTab ──▶ browser.tabs.sendMessage ──▶ content.ts
                                         ├─ tokenOps ──▶ browser.storage.local
                                         ├─ descriptor ──▶ browser.storage.session
                                         └─ JobCoordinator ──▶ sendToTab / apiRequest /
                                                              job/store (IndexedDB) /
                                                              download (browser.downloads)
content.ts ──sameOriginFetchPage──▶ fetch(engagement page URL, same-origin)
           ├─ browser.storage.session.get("activeJob")
           ├─ browser.runtime.sendMessage (status/results)
           └─ collectors ──▶ dom/activity (fetchPage dep), knownIssues (click/dispatchEvent pagination)
```

The only network egress is `fetch` in `api/client.ts` (allowlisted
Bugcrowd API GETs) and `content.ts` (same-origin dossier page reads).
There are no POST/PUT/DELETE, no uploads, no webhooks, no subprocesses,
no MCP/tool bridges.

## 3. Side-effect sink registry

The closed registry — enforced verbatim by
`tests/guard-architecture.test.ts` ("closed side-effect registry"):

| File | Symbol(s) | Type | Plane |
|---|---|---|---|
| `lib/api/client.ts` | `fetch` in `apiRequest` | network | collection (Bugcrowd API, GET, op-allowlisted) |
| `lib/api/engagements.ts` | `apiRequest` calls | delegated network | collection |
| `entrypoints/content.ts` | `fetch` (same-origin page), `runtime.sendMessage`, `storage.session` | network / browser | collection + bookkeeping |
| `entrypoints/background.ts` | `tabs.sendMessage`, `apiRequest` | browser message / delegated network | routing + collection |
| `entrypoints/options/main.ts` | `runtime.sendMessage` | browser message | UI → background token ops |
| `entrypoints/popup/main.ts` | `runtime.sendMessage` | browser message | UI → background job ops |
| `lib/download.ts` | `browser.downloads.download` | browser | local file save |
| `lib/job/coordinator.ts` | `sendToTab` (injected dep) | delegated message | job orchestration |
| `lib/job/descriptor.ts` | `browser.storage.session` | storage | job bookkeeping |
| `lib/job/store.ts` | `openDB`/IndexedDB | storage | job bookkeeping |
| `lib/storageAccess.ts` | `browser.storage.local` probe | storage | bookkeeping |
| `lib/tokenOps.ts` | `browser.storage.local` | storage | credentials (local) |
| `lib/dom/activity.ts` | `fetchPage` calls (injected dep) | delegated network | collection |
| `lib/dom/knownIssues.ts` | `click`/`dispatchEvent` | DOM effect | collection pagination on the dossier page |

**Absent from production code** (any addition trips the registry test):
`child_process`/`spawn`/`execFile`, `XMLHttpRequest`, `WebSocket`,
`sendBeacon`, `axios`/`got`/`undici`/`superagent`, `http.request`/
`https.request`, Playwright/Puppeteer (`page.goto|click|fill|press`),
fs writes (`writeFile`/`appendFile`/`unlink`/`rename`/`rm`),
`callTool`/`toolCall`/`invokeTool`, MCP bridges.

## 4. The canonical gate

`lib/guard/harness.ts` — the only sanctioned path from action to effect:

```ts
export async function runWithGuard<T>(params: RunWithGuardParams<T>) {
  const parsed = proposedActionSchema.safeParse(params.action);
  if (!parsed.success) throw new ScopeGuardEvaluationError(...);   // malformed → closed

  let decision: GuardDecision;
  try {
    decision = await evaluateAction(params.policy, parsed.data, opts);
  } catch (err) {
    throw new ScopeGuardEvaluationError("guard evaluation failed", { cause: err });
  }

  audit(record);              // once per decision; hook failure → closed

  if (decision.execution_allowed !== true) {
    throw new ScopeGuardBlocked(decision);                        // REVIEW + DENY both
  }

  const result = await params.execute();                          // only reachable on ALLOW
  return { decision, executed: true, result, execution: {...} };
}
```

Companion surface (same file):

- `ExecutionAdapter<I,T>` — `prepare(input) → { proposedAction, execute }`.
  The adapter owns the deterministic input→action mapping; never a planner.
- `prepareExecution(adapter, input)` — runs `prepare`, schema-validates the
  action, **deep-freezes** it and the plan → the authorized action is the
  executed action (TOCTOU, §9/P9).
- `runPrepared(prepared, env)` — re-runs a plan through the gate; the
  action is re-validated, so a hand-assembled plan gets identical checks.
- `guardWrap(adapter, env)` / `executeAdapter(...)` — ergonomic forms.
- `ScopeGuardBlocked` — REVIEW/DENY; carries the full `GuardDecision`.
- `ScopeGuardEvaluationError` — malformed action, evaluation throw,
  adapter failure, audit-hook failure. Same blocking behavior.
- `GuardAuditRecord` — `decision_hash`, `policy_hash`, `action_hash`,
  decision, reason codes, target status, `executed`, executor/correlation
  ids. Never action bodies, payloads, or credentials.

## 5. Proof obligations

| Obligation | Evidence |
|---|---|
| P1 every production sink has a guarded ancestor | Registry is closed and classified: all sinks are collection-plane or local bookkeeping — none is a target-executing path. A future target executor can only appear by touching a registered sink pattern or adding a file, both of which fail `guard-architecture.test.ts` until routed through `runWithGuard` or documented. |
| P2 no entrypoint reaches a raw target executor | None exist to reach. The registry test enforces the invariant going forward. |
| P3 REVIEW reaches zero sinks | `execution_allowed === false` → `ScopeGuardBlocked` before `params.execute()`. Tests: matrix rows 1–7 (0 calls), poison sweep (0 calls), `guard-execution.test.ts` REVIEW cases. |
| P4 DENY reaches zero sinks | Same gate. Tests: Zendesk DoS/SE rows (0 calls), DENY cases. |
| P5 guard exception reaches zero sinks | Malformed action → `ScopeGuardEvaluationError` before evaluation; evaluation throw → same; audit-hook throw → same; executor never invoked. Tests: "guard evaluation error executes zero times", malformed-action/adapter cases. |
| P6 only ALLOW reaches a sink | `await params.execute()` sits textually after the `execution_allowed !== true` throw — verified by the ordering test and 35 harness tests. |
| P7 planner input cannot disable the guard | Strict `proposedActionSchema` rejects `skipGuard`/`trusted`/`authorized`/`force`/… as parse errors (fail-closed); source scan finds no bypass flags, env gates, or feature flags in `lib/`/`entrypoints/`. |
| P8 direct imports of raw executors restricted | `evaluateAction` referenced only inside `lib/guard/**` (test-enforced). Sink files are registry-pinned; a new sink module fails tests. There is no exported raw executor to import. |
| P9 authorized action == executed action | `runWithGuard` evaluates `parsed.data` — a fresh schema copy. `prepareExecution` deep-freezes `proposedAction`; the `execute` closure captures the same normalized input. Mutation tests in `guard-execution.test.ts` prove post-prepare tampering can't alter what runs. |
| P10 retries/concurrency can't expand scope | `apiRequest` retries the identical GET (same URL/op) — collection plane. No target executor exists; `guardWrap` evaluates per call — concurrency gets one decision per action, and an `automation.requests_per_second` action field carries rate into authorization. |

## 6. How a future bypass fails (verified)

The registry test was probed with a temporary `lib/__tripwire_probe.ts`
containing a bare `await fetch(url)`. Result: two test failures
(`undeclared sink 'network:fetch'` in both registry tests), removed after
verification. A bypass can also trip:

- **Gateway exclusivity** — calling `evaluateAction` outside `lib/guard/`.
- **Forbidden gating** — `decision !== "DENY"`/`!== "REVIEW"` anywhere in
  production source.
- **Bypass flags** — `skipGuard`, `trusted: true`, `authorized: true`,
  `DISABLE_*` env gates, `process.env.*GUARD*` references.
- **Schema bypass** — unknown keys on `ProposedAction` rejected by the
  strict schema (asserted per-flag in the test).

## 7. Documented exceptions

Every registered sink is a deliberate non-target exception; rationale per
file is in §3. Notable ones:

- `lib/dom/knownIssues.ts` dispatches clicks on the **dossier page** during
  collection — DOM-effect on `bugcrowd.com`, not on an engagement target.
- `lib/tokenOps.ts` writes credentials to `storage.local` — local-only;
  the token authorizes collection-plane reads.
- `lib/guard/cli.ts` maps decisions to process exit codes — a consumer of
  decisions, not an executor.

## 8. Known limitations

- **Runtime capability tokens are not used.** `runWithGuard` is a wrapper
  gate; nothing cryptographically prevents a *new* module from shipping a
  raw sink — the static registry + review is the enforcement mechanism.
  If target executors are added, adopt the capability pattern
  (executor requires a token only the gate can mint).
- **Queue/worker re-evaluation is N/A today** (no deferred executor). If a
  job queue ever feeds an executor, the worker must re-evaluate at
  execution time — stale ALLOW is not a capability.
- **Registry is syntax-level**, not a sandbox: it detects declared
  primitives, not obfuscated ones. It is a review gate, not a runtime
  boundary.
- **Rate semantics are advisory**: `requests_per_second` is carried into
  the ProposedAction but enforcement of the rate itself is the executor's
  contract.
- `evaluateScopeGuard` remains a public evaluation entrypoint — it returns
  a decision only; callers that wire `execute` around it must use
  `runWithGuard`, which the architecture tests enforce at the source level.
