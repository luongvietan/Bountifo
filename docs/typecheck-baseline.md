# TypeScript baseline

`npm run build` (wxt/Vite) transpiles without type checking, so it cannot stand in
for `npm run typecheck` (`tsc --noEmit`). The repository currently does not type
check cleanly; these seven errors predate the exporter hardening work and are
tracked here so a branch can be judged on whether it *adds* errors.

Measured on `feat/exporter` at commit `a363146` (2026-09-20), with the working
tree stashed:

| File | Rule | Summary |
| --- | --- | --- |
| lib/job/coordinator.ts | TS2345 | `JobDescriptor` lacks the index signature `ActiveJobDescriptor` requires |
| lib/job/store.ts | TS2345 | `unknown[]` passed where `IDBValidKey` is required |
| tests/document.test.ts | TS18048 | `m.techniques.automation` possibly undefined |
| tests/download.test.ts | TS2345 | `number` passed to a `void` parameter (vitest mock signature) |
| tests/integration/collection-outcomes.test.ts | TS2345 | same vitest mock signature |
| tests/integration/export-pipeline.test.ts | TS2345 | same vitest mock signature |
| tests/integration/secret-scan.test.ts | TS2345 | same vitest mock signature |

**Baseline: 7 errors.** Line numbers move as files change, so compare by file
and rule, not by position.

Gate for any branch:

```
errors(branch) > 7  ->  fail
```

The list is a debt ledger, not an allowance: each entry should be removed until
the baseline reaches zero, after which the gate becomes `errors > 0`.
