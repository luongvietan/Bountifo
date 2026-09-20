# TypeScript baseline

`npm run build` (wxt/Vite) transpiles without type checking, so it cannot stand
in for `npm run typecheck` (`tsc --noEmit`).

**Baseline: 0 errors.**

```
errors > 0  ->  fail
```

The repository used to carry seven errors. They are gone, so the gate is now
absolute: a branch that introduces an error fails, with no allowance to spend.

For the record, what they were and how each was resolved (2026-09-20):

| File | Rule | Resolution |
| --- | --- | --- |
| lib/messages.ts | TS2345 | `validateJobSender` asked for an `ActiveJobDescriptor`, whose index signature no plain interface satisfies. It now asks for the three fields it actually reads, so any descriptor shape — stored or in-memory — type checks. |
| lib/job/store.ts | TS2345 | `purgeJob` built its composite key from untyped rows. The second half of the key is narrowed to a string where it is built, rather than cast at the call. |
| tests/document.test.ts | TS18048 | Optional-chained the technique lookup instead of assuming the record exists. |
| tests/download.test.ts, tests/integration/*.test.ts (×3) | TS2345 | `browser.downloads.download` is typed as resolving to `void`; the mocks returned a download id no test ever read. They now resolve to `undefined`, matching the declared type. |

None of these were behaviour changes: the two library fixes narrowed types to
what the code already did, and the test fixes stopped asserting a return value
the API does not declare.
