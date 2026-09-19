# Bugcrowd Engagement Exporter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal Chrome Manifest V3 extension (WXT framework) that exports the bug-bounty-relevant content of the currently open Bugcrowd engagement into one deterministic, evidence-backed Markdown dossier for an AI agent.

**Architecture:** WXT (vanilla TypeScript) MV3 extension. Content script runs DOM collection units on `https://bugcrowd.com/engagements/*`; the background service worker owns the API token, performs the allowlisted Bugcrowd API calls, runs a persisted job-coordinator state machine (chrome.storage.session descriptor + extension-origin IndexedDB intermediate records), builds evidence/normalized facts, renders Markdown, and downloads it. Popup shows progress and can reconnect; options page manages the API token.

**Tech Stack:** WXT 0.21.x, TypeScript 5.x, Vitest + `wxt/testing` (`WxtVitest`, `fakeBrowser`), jsdom (DOM parser tests), fake-indexeddb (store tests), zod (message schema validation), yaml (deterministic YAML emit), idb (IndexedDB wrapper). No UI framework — vanilla TS popup/options.

**Spec:** `design spec.txt` (repo root) — the spec is the binding authority; this plan argues from it.

## Global Constraints

Every task's requirements implicitly include all of the following (verbatim from spec):

- MV3. Permissions exactly: `activeTab`, `scripting`, `storage`, `downloads`. Host permissions exactly: `https://bugcrowd.com/*`, `https://api.bugcrowd.com/*`. No other permissions.
- API requests always include `Accept: application/vnd.bugcrowd+json` and `Authorization: Token <credential>`. `api_major_target: "V1"`, `api_schema_tested: "1.1.0"`; observed API version recorded or `null`, never inferred. Respect 60 req/min/IP.
- `PARSER_VERSION = "2.0.0"`. Evidence `schema_version: 2`. Extraction status ∈ `exact | partial | failed`.
- Permission statuses ∈ `allowed | prohibited | conditional | unspecified`. An asserted status (`allowed|prohibited|conditional`) requires ≥1 evidence object with `extraction.status === "exact"`; partial evidence can never establish an asserted status; `unspecified` is never rewritten as `prohibited`; `unspecified` may have no evidence.
- Safe Harbor states ∈ `present | absent | unclear`.
- Evidence `id` = `ev_` + first 12 hex of SHA-256(EvidenceHashInputV1); `content_hash` = `sha256:` + full hex of same preimage. `quote` = exact normalized source text.
- `source_level` ∈ `page_header | target_specific_rule | explicit_program_rule | announcement | vrt_deviation | default_vrt | known_issue_note | api_field`.
- `collection.status` ∈ `complete | partial | failed`; `api_status` and `dom_status` are independent dimensions; warnings and policy conflicts never create extra status values.
- Output filename `bugcrowd-{engagement-code}-{YYYY-MM-DD}.md` (local date); document contains the 16 sections in spec §16 order.
- Canonicalization: UTF-8, LF, Unicode NFC, canonical JSON (object keys sorted lexicographically), arrays preserve source order; corpus sort = source-type order `api` then `dom`, then `source_key`, then canonical-locator JSON, then evidence id; evidence hash excludes collection time, parser version/runtime, job ID, Promise order, volatile DOM IDs.
- Token: only in `chrome.storage.local`, never synced; `setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})` at install AND every service-worker startup before any credential access; failure → API credential storage and API collection fail closed, DOM-only export remains available; content script must never read the credential; token/Authorization never appear in page content, progress state, logs, errors, or output file.
- Background message API exposes named operations only — `TEST_TOKEN`, `LIST_ENGAGEMENTS`, `GET_ENGAGEMENT` — never a generic fetch; content/extension messages cannot supply URL, hostname, Authorization header, or arbitrary request options; SW constructs every API URL and header.
- Job-scoped messages validated for: schema, sender extension ID, job ID, sender tab ID, sender tab URL under `https://bugcrowd.com/`, expected job phase. Extension-page ops (e.g. `TEST_TOKEN`) use a separate schema and reject tab-derived parameters.
- `chrome.storage.session` descriptor stores only: job ID, tab ID, engagement code, phase, checkpoint, completed/pending units, warning counters, cancellation flag — never token, Authorization, or the dossier.
- No remote JavaScript, CDN dependency, analytics SDK, telemetry, or eval-like code. No private submissions accessed or exported. Errors never include cookies, tokens, Authorization headers, or complete raw HTTP headers.
- Known Issues: every non-zero displayed-count target is opened, paginated (stop at disabled/end control or repeated page signature), exact-duplicate rows deduplicated preserving order, and count-validated; mismatch → warning + section not complete.
- `collection.status` semantics: `complete` = every required unit done + count validations pass; `partial` = ≥1 required advertised unit missing/truncated/failed validation; `failed` = critical prerequisite failed (unsupported URL, session expiry/login redirect, Details collection failure, active tab closure). API unavailability alone does NOT make collection partial. Policy conflicts live under `policy`, never change collection status.
- API `429`: honor `Retry-After`; otherwise bounded exponential backoff with jitter.
- Cancellation: stops before next request/UI action, closes exporter-opened UI, restores initial URL, no partial download. Closing popup ≠ cancel; reopening reconnects. Browser restart cancels the job (no cross-session recovery).
- No AI-written summaries, inferred authorization, or testing recommendations in output. Policy text is not summarized/translated/reinterpreted. Uncalibrated confidence scores are not emitted.
- Fixtures are sanitized: no real tokens, cookies, private submissions, or personal account data.
- Determinism: identical evidence collected in any Promise completion order produces the same `evidence_corpus_hash` and rendered evidence order; `normalized_hash` excludes export timestamp, job ID, progress state, volatile collection metadata.

## Review Focus

Inputs/failure modes the spec implies that are most likely to bite — each has a test pinned to its owning task:

1. Secret leakage: token or `Token <cred>`/`Authorization` appearing in thrown errors, logs, `chrome.storage.session` descriptor, broadcast messages, or the rendered file. → secret-scan assertions in Tasks 2, 3, 9, 11.
2. Nondeterminism from async order: evidence arriving in different Promise completion orders must produce identical `evidence_corpus_hash` and rendered evidence appendix order. → shuffled-order test in Task 6.
3. Service-worker termination mid-job / mid-unit: resume must not duplicate evidence or skip units; checkpoint referencing missing records must be rejected. → Task 9 tests.
4. Partial-only evidence must never yield `allowed`/`prohibited`/`conditional` (even when several partial records agree); content-script messages carrying URL/headers/request options must be rejected. → Task 6 and Task 2 tests.
5. Known Issues count mismatch / truncated pagination and mid-collection auth loss: mismatch → `partial` (section incomplete), auth loss → `failed` and never labeled complete. → Tasks 5, 7, 9, 11 tests.

---

### Task 1: WXT scaffold + shared types + canonical/hash/id/secret foundations

**Files:**
- Create: `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `entrypoints/background.ts`, `entrypoints/content.ts`, `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`, `entrypoints/options/index.html`, `entrypoints/options/main.ts` (minimal stubs; real logic lands in later tasks)
- Create: `lib/constants.ts`, `lib/types.ts`, `lib/canonical.ts`, `lib/hash.ts`, `lib/ids.ts`, `lib/secrets.ts`
- Test: `tests/canonical.test.ts`, `tests/ids.test.ts`, `tests/secrets.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces (later tasks import these exact names — do not rename):

```ts
// lib/constants.ts
export const PARSER_VERSION = "2.0.0";
export const EVIDENCE_SCHEMA_VERSION = 2;
export const DOCUMENT_SCHEMA_VERSION = 2;
export const API_BASE = "https://api.bugcrowd.com";
export const API_ACCEPT = "application/vnd.bugcrowd+json";
export const API_MAJOR_TARGET = "V1";
export const API_SCHEMA_TESTED = "1.1.0";
export const API_RATE_LIMIT_PER_MINUTE = 60;
export const BUGCROWD_SITE = "https://bugcrowd.com";
export const TRACKING_PARAMS: readonly string[]; // utm_*, fbclid, gclid, mc_cid, mc_eid, _ga, _gl
export const SOURCE_TYPE_ORDER: readonly ["api", "dom"];
```

```ts
// lib/types.ts (all types the pipeline passes between units)
export type SourceType = "api" | "dom";
export type SourceLevel =
  | "page_header" | "target_specific_rule" | "explicit_program_rule"
  | "announcement" | "vrt_deviation" | "default_vrt"
  | "known_issue_note" | "api_field";
export type ExtractionStatus = "exact" | "partial" | "failed";
export type PermissionStatus = "allowed" | "prohibited" | "conditional" | "unspecified";
export type SafeHarborStatus = "present" | "absent" | "unclear";
export type CollectionStatus = "complete" | "partial" | "failed";
export type ApplicabilityType = "all_targets" | "target_ids" | "target_group_ids" | "engagement";
export type IdentityQuality = "api" | "exact_location" | "name_fallback" | "duplicate_disambiguated";

export interface SourceLocator {
  section?: string; subsection?: string; targetId?: string;
  table?: string; pageIndex?: number; rowIndex?: number;
}
export interface SourceRecord {          // produced by collectors (API client + DOM)
  sourceKey: string;                     // e.g. "dom:details:program-rules:automation"
  sourceType: SourceType;
  sourceLevel: SourceLevel;
  sourceUrl: string;
  authenticated: boolean;
  locator: SourceLocator;
  quote: string;                         // raw text; evidence builder normalizes
  extractionStatus: ExtractionStatus;
  data?: unknown;                        // structured payload for normalizers; NOT hashed
}
export interface Evidence {
  id: string;                            // "ev_" + 12 hex
  source_key: string;
  source: { url: string; type: SourceType; authenticated: boolean };
  locator: SourceLocator;
  source_level: SourceLevel;
  collected_at: string;                  // ISO-8601 with offset; excluded from hash
  quote: string;                         // normalized
  content_hash: string;                  // "sha256:" + 64 hex
  extraction: { status: ExtractionStatus; parser_version: string };
}
export interface Applicability { type: ApplicabilityType; ids?: string[] }
export interface Condition { id: string; text: string }
export interface PermissionFact {
  status: PermissionStatus;
  conditions: Condition[];
  applies_to: Applicability;
  evidence_refs: string[];
  conflict: { detected: boolean; evidence_refs: string[]; asserted_statuses: PermissionStatus[] };
  resolution?: { status: "unresolved" };
  extraction: { status: ExtractionStatus };
}
export interface ApiEngagementData {     // output of Task 3's parser
  uuid: string | null; name: string | null; code: string | null;
  engagementType: string | null; managedBounty: boolean | null;
  lifecycleStatus: string | null; testingStart: string | null; testingEnd: string | null;
  testingPeriodLabel: string | null; lastStatusTransition: string | null; lastBriefUpdate: string | null;
  safeHarborLevel: string | null;
  statistics: Record<string, { value: string; window: string | null }>;
  targetGroups: ApiTargetGroup[]; targets: ApiTarget[];
  observedApiVersion: string | null;
}
export interface ApiTargetGroup {
  id: string; name: string; inScope: boolean; description: string | null;
  rewards: { p1: number | null; p2: number | null; p3: number | null; p4: number | null; p5: number | null };
}
export interface ApiTarget {
  id: string; groupId: string | null; location: string | null; name: string | null;
  category: string | null; tags: string[]; inScope: boolean;
}
```

```ts
// lib/canonical.ts
export function normalizeText(s: string): string;      // NFC, CRLF/CR→LF, trim, collapse interior whitespace runs to single space
export function canonicalJson(value: unknown): string; // recursive key-sorted JSON.stringify; undefined object props dropped
export function canonicalUrl(raw: string): string;     // lower scheme/host, strip default port+fragment+TRACKING_PARAMS, sort remaining query params
export function canonicalLocator(loc: SourceLocator): string; // canonicalJson of defined fields only
```

```ts
// lib/hash.ts
export async function sha256Hex(data: string): Promise<string>;       // globalThis.crypto.subtle, UTF-8 input
export function prefixedId(prefix: string, hexDigest: string, len: number): string; // `${prefix}_${hexDigest.slice(0,len)}`
```

```ts
// lib/ids.ts
export interface ParsedEngagementUrl { code: string; canonicalUrl: string }
export function parseEngagementUrl(raw: string): ParsedEngagementUrl | null;
//   matches https://bugcrowd.com/engagements/<code>(optional subpath/query); null otherwise
export function isSupportedEngagementUrl(raw: string): boolean;
export function exportFileName(engagementCode: string, date: Date): string;
//   `bugcrowd-${code}-${yyyy}-${mm}-${dd}` local time, zero-padded
export interface DerivedTargetIdInput {
  engagementId: string;            // API UUID else canonical engagement URL
  location: string | null; name: string | null; type: string | null; occurrence?: number;
}
export function targetIdPreimage(input: DerivedTargetIdInput): string; // canonicalJson preimage (testable without crypto)
```

```ts
// lib/secrets.ts
export function normalizeTokenInput(raw: string): string | null; // accepts "abc" or "Token abc"; returns bare credential; null if empty/whitespace/invalid shape
export function redactSecrets(text: string, secrets: readonly string[]): string; // replaces every occurrence of each non-empty secret with "[REDACTED]"
```

```ts
// wxt.config.ts manifest (exact)
manifest: {
  permissions: ["activeTab", "scripting", "storage", "downloads"],
  host_permissions: ["https://bugcrowd.com/*", "https://api.bugcrowd.com/*"],
}
```

- [ ] **Step 1: Scaffold the project manually** (dir is non-empty — do NOT run `wxt init`). Write `package.json` with name `bugcrowd-engagement-exporter`, private, type `module`, scripts `{ "dev": "wxt", "build": "wxt build", "test": "vitest run", "prepare": "wxt prepare" }`; devDeps `wxt@^0.21.4 typescript@^5 vitest@^5 jsdom@^30 fake-indexeddb@^6`; deps `zod@^4 yaml@^2 idb@^8`. `npm install`.
- [ ] **Step 2: Config files.** `wxt.config.ts` = `defineConfig({ manifest: {...as above}, outDir: ".output" })`. `tsconfig.json` = `{ "extends": "./.wxt/tsconfig.json" }` (run `npx wxt prepare` once to generate `.wxt/`). `vitest.config.ts` = `defineConfig({ plugins: [WxtVitest()], test: { environment: "node" } })` importing `WxtVitest` from `wxt/testing/vitest-plugin`. `.gitignore`: `node_modules/`, `.output/`, `.wxt/`, `dist/`. Minimal entrypoint stubs: `background.ts` → `export default defineBackground(() => {});`; `content.ts` → `export default defineContentScript({ matches: ["https://bugcrowd.com/*"], runAt: "document_idle", main() {} });`; popup/options index.html shells + empty main.ts.
- [ ] **Step 3: Write the failing tests first** (`tests/canonical.test.ts`, `tests/ids.test.ts`, `tests/secrets.test.ts`) covering: NFC/LF/collapse normalization; canonicalJson sorted nested keys + undefined dropped + array order preserved; canonicalUrl (uppercase host, `:443` strip, `#frag` strip, `utm_source`+`gclid` strip, query sort, path preserved); parseEngagementUrl positive (`https://bugcrowd.com/engagements/aiven-mbb-og`, with subpath `…/known_issues`, with query) and negative (`http://`, other host, `/programs/`, missing code); exportFileName padding + exact format `bugcrowd-aiven-mbb-og-2026-09-20`; targetIdPreimage ignores `occurrence` when undefined and includes it when set; normalizeTokenInput (`"abc"` → `"abc"`, `"Token abc"` → `"abc"`, `"token abc"` → `"abc"` case-insensitive prefix, `""`/`"   "`/`"Token"` → `null`); redactSecrets multi-occurrence + empty-secret no-op.
- [ ] **Step 4: Run tests — expect FAIL** (modules don't exist). `npm test`.
- [ ] **Step 5: Implement** `lib/constants.ts`, `lib/types.ts` (verbatim types above), `lib/canonical.ts`, `lib/hash.ts`, `lib/ids.ts`, `lib/secrets.ts` exactly per signatures. `parseEngagementUrl` must lowercase host via URL parsing, require `https:` + host `bugcrowd.com` (allow `www.`? — NO, exactly `bugcrowd.com`), path `/engagements/<code>` where code = `[A-Za-z0-9_-]+`; canonicalUrl = `https://bugcrowd.com/engagements/<code>` (subpath/query dropped — the engagement root is the canonical source page).
- [ ] **Step 6: `npm test` → PASS, then `npx wxt build` → produces `.output/chrome-mv3` without manifest errors.** Verify generated manifest.json contains exactly the required permissions/host_permissions.
- [ ] **Step 7: Commit** `feat: scaffold WXT extension with canonicalization, hashing, id, and secret foundations`.

### Task 2: Credential storage lockdown + message protocol + background router skeleton

**Files:**
- Create: `lib/storageAccess.ts`, `lib/messages.ts`, `lib/tokenOps.ts`
- Modify: `entrypoints/background.ts` (router skeleton + startup lockdown)
- Test: `tests/storageAccess.test.ts`, `tests/messages.test.ts`

**Interfaces:**
- Consumes: `lib/secrets.ts` (`normalizeTokenInput`, `redactSecrets`), `lib/constants.ts`, `lib/types.ts`.
- Produces:

```ts
// lib/storageAccess.ts
export function ensureTrustedContexts(): Promise<boolean>; // calls browser.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"}); caches the in-flight/resolved promise; false on throw OR method missing; never retries within one SW lifetime
export function credentialStorageUsable(): Promise<boolean>; // === ensureTrustedContexts result
```

```ts
// lib/tokenOps.ts
export function saveCredential(raw: string): Promise<{ ok: true } | { ok: false; reason: "storage_locked" | "invalid" }>; // normalize → ensureTrustedContexts → set {apiCredential}
export function getCredential(): Promise<string | null>;   // null when locked or absent; SERVICE-WORKER-ONLY by contract (never imported by content/popup/options code)
export function clearCredential(): Promise<void>;
export function hasCredential(): Promise<boolean>;
export const CREDENTIAL_STORAGE_KEY = "apiCredential";
```

```ts
// lib/messages.ts — zod schemas + parsed types
export const ApiOperation = z.enum(["TEST_TOKEN", "LIST_ENGAGEMENTS", "GET_ENGAGEMENT"]);
export const ApiRequestMsg = z.object({
  op: ApiOperation,
  params: z.object({
    code: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
    uuid: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional(),
    page: z.number().int().min(1).max(100).optional(),
    token: z.string().optional(),           // TEST_TOKEN only: probe an unsaved candidate
  }).strict(),
}).strict();                                // .strict() rejects url/hostname/headers/options injection
export const PopupMsg = z.discriminatedUnion("op", [
  z.object({ op: z.literal("START_EXPORT"), tabId: z.number().int() }).strict(),
  z.object({ op: z.literal("CANCEL_EXPORT"), jobId: z.string() }).strict(),
  z.object({ op: z.literal("GET_JOB_STATE") }).strict(),
  z.object({ op: z.literal("SAVE_TOKEN"), token: z.string() }).strict(),
  z.object({ op: z.literal("CLEAR_TOKEN") }).strict(),
  z.object({ op: z.literal("GET_TOKEN_STATUS") }).strict(),
]);
export const JobMsg = z.discriminatedUnion("op", [
  z.object({ op: z.literal("PAGE_READY"), jobId: z.string(), url: z.string() }).strict(),
  z.object({ op: z.literal("UNIT_PROGRESS"), jobId: z.string(), unitId: z.string(),
             counters: z.record(z.string(), z.number()) }).strict(),
  z.object({ op: z.literal("UNIT_RESULT"), jobId: z.string(), unitId: z.string(),
             result: z.unknown() }).strict(),
]);
export type ApiRequest = z.infer<typeof ApiRequestMsg>;
export type PopupMessage = z.infer<typeof PopupMsg>;
export type JobMessage = z.infer<typeof JobMsg>;
export function parseApiRequest(msg: unknown): ApiRequest | null;
export function parsePopupMessage(msg: unknown): PopupMessage | null;
export function parseJobMessage(msg: unknown): JobMessage | null;
export interface ActiveJobDescriptor { jobId: string; tabId: number; engagementCode: string; phase: string; [k: string]: unknown }
export type SenderValidation = { ok: true } | { ok: false; reason: string };
export function validateJobSender(sender: { id?: string; tab?: { id?: number; url?: string } },
                                  msg: { jobId: string },
                                  job: ActiveJobDescriptor,
                                  expectedPhase: string): SenderValidation;
//   ok requires: sender.id === browser.runtime.id; sender.tab.id === job.tabId;
//   sender.tab.url starts with "https://bugcrowd.com/"; msg.jobId === job.jobId; job.phase === expectedPhase
```

`entrypoints/background.ts` (skeleton): calls `ensureTrustedContexts()` at top of `main()` and inside `browser.runtime.onInstalled` listener; registers `browser.runtime.onMessage` router that: (a) tries `parseApiRequest` → replies `{ ok:false, error:"not_implemented" }` for now (Task 3 wires it); (b) `parsePopupMessage` → `{ ok:false, error:"not_implemented" }` stub per op (Task 9 wires jobs, Task 10 wires token ops); (c) `parseJobMessage` → requires `validateJobSender` against stored descriptor (Task 9 wires; for now always `{ok:false}`). Router MUST return responses of shape `{ ok: boolean; ... }` and never echo request payloads containing `token`/`Authorization` back. Any message that fails all three parsers → `{ ok:false, error:"unknown_message" }`.

- [ ] **Step 1: Failing tests** (`tests/storageAccess.test.ts`, `tests/messages.test.ts`): setAccessLevel called once + cached; missing `setAccessLevel` → `false` and credential ops fail closed (`saveCredential → {ok:false,reason:"storage_locked"}`, `getCredential → null`); save/get/clear round-trip on fakeBrowser with setAccessLevel stubbed to resolve; normalizeTokenInput applied on save (`"Token x"` stored as `"x"`); message parsers accept listed ops, reject: unknown op, `params.url`, `params.hostname`, `params.headers`, `params.Authorization`, `params.method`/`options`, extra top-level keys, `page: 0`/`page: -1`, malformed uuid; `validateJobSender` each failure mode (wrong sender id, wrong tabId, `http://` url, `sub.bugcrowd.com` ok? — NO, url must start exactly `https://bugcrowd.com/`, wrong jobId, wrong phase) plus the all-valid case; a JobMsg carrying `token` field rejected by `.strict()`.
- [ ] **Step 2: `npm test` → FAIL.**
- [ ] **Step 3: Implement** the three modules + background skeleton per signatures. Use `browser` from `wxt/browser`. In tests, stub `browser.storage.local.setAccessLevel` via `vi.spyOn`/`Object.defineProperty` when fakeBrowser lacks it; document in test comment if so.
- [ ] **Step 4: `npm test` → PASS; `npx wxt build` still clean.**
- [ ] **Step 5: Commit** `feat: credential storage lockdown, message protocol schemas, background router skeleton`.

### Task 3: Bugcrowd API client + engagement enrichment parsing

**Files:**
- Create: `lib/api/errors.ts`, `lib/api/client.ts`, `lib/api/engagements.ts`
- Modify: `entrypoints/background.ts` (wire `ApiRequestMsg` ops to real handlers)
- Test: `tests/api-client.test.ts`, `tests/api-engagements.test.ts`, `tests/fixtures/api/engagement.json` (sanitized JSON:API fixture)

**Interfaces:**
- Consumes: `lib/constants.ts` (API_BASE, API_ACCEPT, API_MAJOR_TARGET, API_SCHEMA_TESTED, API_RATE_LIMIT_PER_MINUTE), `lib/tokenOps.ts` (`getCredential`), `lib/messages.ts` (`ApiRequest`), `lib/types.ts` (`ApiEngagementData`, `ApiTargetGroup`, `ApiTarget`, `SourceRecord`).
- Produces:

```ts
// lib/api/errors.ts
export type ApiErrorKind = "no_token" | "storage_locked" | "unauthorized" | "forbidden"
  | "not_found" | "rate_limited" | "network" | "http" | "invalid_response";
export class ApiError extends Error { kind: ApiErrorKind; status?: number }
//   message/status only — NEVER headers, token, or response body
```

```ts
// lib/api/client.ts
export interface ApiRequestOptions { operation: "LIST_ENGAGEMENTS" | "GET_ENGAGEMENT" | "TEST_TOKEN";
                                     code?: string; uuid?: string; page?: number; tokenOverride?: string }
export interface ApiResponse<T> { data: T; status: number; observedVersion: string | null }
export async function apiRequest<T>(opts: ApiRequestOptions): Promise<ApiResponse<T>>;
//   - resolves credential via getCredential() unless opts.tokenOverride (TEST_TOKEN probe)
//   - no credential → ApiError("no_token"); storage locked → ApiError("storage_locked")
//   - builds URL: LIST_ENGAGEMENTS → `${API_BASE}/engagements?page[number]=${page}&page[size]=25`
//                 GET_ENGAGEMENT → `${API_BASE}/engagements/${uuid}?include=target_groups,targets`
//                 TEST_TOKEN → `${API_BASE}/engagements?page[number]=1&page[size]=1`
//   - headers exactly {Accept: API_ACCEPT, Authorization: `Token ${cred}`}
//   - token bucket: max 60 requests per rolling 60s (module-level queue, awaits capacity)
//   - 429 → honor `Retry-After` seconds once, then bounded backoff; other transient (5xx, network) →
//     exponential backoff base 500ms ×2^n + jitter(0–250ms), max 4 attempts total
//   - maps 401→unauthorized, 403→forbidden, 404→not_found; observedVersion from response
//     header `x-bugcrowd-version`/`x-api-version` if present else null
```

```ts
// lib/api/engagements.ts
export function parseEngagementsIndex(json: unknown): { uuid: string; code: string | null }[];
export function parseEngagement(json: unknown): ApiEngagementData;       // JSON:API data+included → ApiEngagementData (types.ts)
export async function resolveEngagementUuid(code: string, pageUuid?: string | null): Promise<string | null>;
//   pageUuid wins when present; else page LIST_ENGAGEMENTS (≤20 pages) matching code (from attributes or canonical URL slug); no match → null (non-critical)
export async function fetchEngagementEnrichment(code: string, pageUuid?: string | null):
  Promise<{ ok: true; data: ApiEngagementData; records: SourceRecord[] } | { ok: false; error: ApiError }>;
//   resolve → getEngagement → parse → emit SourceRecord[] (sourceType:"api", sourceLevel:"api_field",
//   sourceKey `api:engagement:<field>` per logical field group, quote = exact JSON value text,
//   authenticated:true, data = parsed value) — returns records AND structured data
export function testToken(tokenOverride?: string): Promise<{ ok: boolean; detail: string }>;
//   ok on 200; detail = short safe message ("token valid" | "unauthorized" | "rate limited, try later" | "unreachable") — never echoes token
```

Background wiring: `parseApiRequest` match → `TEST_TOKEN` → `testToken(params.token)`; `LIST_ENGAGEMENTS` → `apiRequest` list page; `GET_ENGAGEMENT` (requires params.uuid XOR params.code; code resolves via `resolveEngagementUuid`, null → `{ok:false,error:"engagement_not_found"}`) → `fetchEngagementEnrichment`. All responses `{ok:true,data}|{ok:false,error:{kind,message}}` — sanitized, no token.

- [ ] **Step 1: Fixtures + failing tests.** Write `tests/fixtures/api/engagement.json`: sanitized JSON:API response with `data` (engagement attributes incl. name/lifecycle timestamps/type/managed flag/safe harbor/statistics) + `included` target_groups (rewards p1–p5, one group missing p4/p5 → null) and targets (uri/name/category/tags/group relationship). Tests: parseEngagement maps every field incl. null rewards + `observedApiVersion`; parseEngagementsIndex extracts uuid+code; resolveEngagementUuid prefers pageUuid, else index match, else null; apiRequest URL/header construction (assert `Authorization: Token <cred>` sent, `Accept` exact); 429 honors Retry-After then succeeds (fake timers); 401/403/404 mapping; exhausted retries → ApiError; TEST_TOKEN with tokenOverride skips storage; **error objects contain no credential substring** (scan `JSON.stringify(err)` and `err.message` for the token); `.strict()` already blocks injected params (rely on Task 2 schemas — assert `apiRequest` is never invoked with a caller-supplied URL by checking fetch mock called only with `api.bugcrowd.com` URLs).
- [ ] **Step 2: `npm test` → FAIL.**
- [ ] **Step 3: Implement** errors/client/engagements + background wiring.
- [ ] **Step 4: `npm test` → PASS; `npx wxt build` clean.**
- [ ] **Step 5: Commit** `feat: Bugcrowd API client with bounded retry, engagement parsing, token probe`.

### Task 4: DOM collectors — details, scope/rewards, policy/VRT, activity, session

**Files:**
- Create: `lib/dom/domUtils.ts`, `lib/dom/session.ts`, `lib/dom/details.ts`, `lib/dom/targets.ts`, `lib/dom/policies.ts`, `lib/dom/activity.ts`
- Test: `tests/dom-details.test.ts`, `tests/dom-targets.test.ts`, `tests/dom-policies.test.ts`, `tests/dom-activity.test.ts`, fixtures `tests/fixtures/dom/*.html` (sanitized, minimal semantic HTML you author to match Bugcrowd's semantic structure — headings, `role`/aria labels, tables — NOT real page dumps)

**Interfaces:**
- Consumes: `lib/types.ts` (`SourceRecord`, `SourceLevel`, `ExtractionStatus`), `lib/canonical.ts` (`normalizeText`), `lib/constants.ts`.
- Produces:

```ts
// lib/dom/domUtils.ts
export function textOf(el: Element | null | undefined): string;           // normalized visible text
export function findSection(root: ParentNode, headingRe: RegExp): Element | null; // locate by heading role/text
export function tableToRows(table: Element): { headers: string[]; rows: string[][] };
export function* eachTextBlock(root: ParentNode): Generator<{ el: Element; text: string }>;
export function nearestLabeled(el: Element): string | null;               // aria-label/labelledby/legend
```

```ts
// lib/dom/session.ts
export function isSessionExpired(doc: Document, url: string): boolean;
//   true when URL redirected to login/auth path or doc has password login form & no engagement content
```

```ts
// lib/dom/details.ts
export interface DetailsData { name: string|null; code: string|null; engagementType: string|null;
  managedBounty: boolean|null; lifecycleStatus: string|null; testingStart: string|null;
  testingEnd: string|null; testingPeriodLabel: string|null; lastStatusTransition: string|null;
  lastBriefUpdate: string|null; safeHarborLevel: string|null; disclosurePolicy: string|null;
  statistics: Record<string,{value:string;window:string|null}>; }
export function collectDetails(doc: Document, pageUrl: string):
  { records: SourceRecord[]; data: DetailsData };
//   sourceKeys "dom:details:<field>", levels: page_header for header stats, explicit_program_rule for policy text
```

```ts
// lib/dom/targets.ts
export interface DomTargetGroup { domKey: string; name: string; inScope: boolean; description: string|null;
  rewards: {p1:number|null;p2:number|null;p3:number|null;p4:number|null;p5:number|null} }
export interface DomTarget { domKey: string; groupDomKey: string|null; location: string|null;
  name: string|null; category: string|null; tags: string[]; docLinks: string[]; changeFlags: string[];
  displayedKnownIssuesCount: number|null; kiControlLabel: string|null }
export interface DomRule { text: string; appliesToDomKeys: string[]; level: SourceLevel }
export function collectTargets(doc: Document, pageUrl: string):
  { records: SourceRecord[]; groups: DomTargetGroup[]; targets: DomTarget[]; rules: DomRule[] };
//   in-scope AND out-of-scope groups (inScope flag), third-party boundaries as rules
```

```ts
// lib/dom/policies.ts
export interface PolicyData { safeHarborStatements: string[]; authorizationStatements: string[];
  techniques: { name: string; status: PermissionStatus; conditions: string[]; quote: string }[];
  accountRules: string[]; dataRules: string[]; focusAreas: string[]; nonFocusAreas: string[];
  reportingRequirements: string[];
  vrt: { version: string|null; baseline: string|null; exclusions: string[]; deviations: string[];
         targetSpecific: string[]; notes: string[] } }
export function collectPolicies(doc: Document, pageUrl: string): { records: SourceRecord[]; data: PolicyData };
```

```ts
// lib/dom/activity.ts
export interface ActivityItem { kind: "announcement"|"changelog"|"activity"|"accepted_report";
  title: string|null; body: string; timestamp: string|null; sourceUrl: string|null }
export interface ParticipationStats { [key: string]: { value: string; window: string|null } }
export function collectActivity(doc: Document, pageUrl: string, fetchPage: (url: string) => Promise<Document | null>):
  Promise<{ records: SourceRecord[]; announcements: ActivityItem[]; changelog: ActivityItem[];
            recentActivity: ActivityItem[]; acceptedReports: ActivityItem[]; stats: ParticipationStats }>;
//   fetchPage = same-origin authenticated fetch→DOM parser provided by caller (content script);
//   exhaust announcements & changelog pagination via fetchPage until next link absent/end
```

All collectors: `records` carry `extractionStatus` (`exact` when the semantic element was found and text fully captured; `partial` when located heuristically/truncated), `authenticated:true`, `sourceUrl:pageUrl`, structured `data` for normalizers. `sourceKey` pattern `dom:<page>:<section>:<item-slug>` where item-slug = normalized label. Techniques list covers the spec §4.3 technique names: automation, scanning, brute force, denial of service, social engineering, physical testing, credential testing, multi-account, cross-tenant, third-party, PII access, data exfiltration, persistent access — plus account/resource/data/focus/reporting groups. Unknown/absent technique → no record (unspecified is emitted by normalizers, not collectors).

- [ ] **Step 1: Author fixtures + failing tests.** Fixtures: `details.html` (header stats + lifecycle + safe harbor + policy section), `targets.html` (one in-scope group w/ p1–p5, one group missing p2/p4, out-of-scope group, target w/ tags+doc links+change flag+KI count badge, third-party boundary note), `policies.html` (program rules list incl. "Automated scanning is permitted only against explicitly listed targets", account/data rules, focus/non-focus, VRT block), `activity.html` (announcements w/ next-page link, changelog, recent activity, accepted reports, participation stats). Tests assert: every spec §4 field extracted or explicit null; rewards missing → null not 0; out-of-scope targets flagged `inScope:false`; technique status parsing allowed/prohibited/conditional; `records` all have non-empty sourceKey/quote + valid level; pagination loop calls fetchPage until exhausted (mock fetchPage returning page2 then null); session-expired fixture → true.
- [ ] **Step 2: `npm test` → FAIL** (add `// @vitest-environment jsdom` pragma atop each DOM test file; fixture loading via `fs.readFileSync` + `new DOMParser()` or jsdom `JSDOM` — pick `JSDOM` for full `Document`).
- [ ] **Step 3: Implement** domUtils/session/details/targets/policies/activity.
- [ ] **Step 4: `npm test` → PASS; `npx wxt build` clean.**
- [ ] **Step 5: Commit** `feat: semantic DOM collectors for details, scope, policy, VRT, activity`.

### Task 5: Known Issues collection flow + content-script orchestrator

**Files:**
- Create: `lib/dom/knownIssues.ts`, `entrypoints/content.ts` (real orchestrator replacing stub)
- Test: `tests/dom-knownIssues.test.ts`, `tests/content-orchestrator.test.ts`, fixtures `tests/fixtures/dom/ki-*.html`

**Interfaces:**
- Consumes: Task 4 collectors + `DomTarget`, `lib/messages.ts` (`JobMsg`), `lib/dom/session.ts`.
- Produces:

```ts
// lib/dom/knownIssues.ts
export interface KiRow { cells: string[]; recognized?: Record<string,string> } // recognized only when explicit column labels map (vrt_category|variant|priority|unique_count|total_count|target|status|notes)
export interface KiResult {
  targetDomKey: string; displayedCount: number|null; collectedCount: number;
  columns: string[]; rows: KiRow[]; skipped: boolean;      // skipped only when displayedCount === 0
  countMatches: boolean; warnings: string[];
  records: SourceRecord[];                                  // level "known_issue_note"; sourceKey "dom:ki:<targetDomKey>"
}
export interface KiDriver {
  open(doc: Document, target: DomTarget): Promise<Element | null>;   // click/activate KI control → dialog/drawer element or null
  waitReady(dialog: Element, timeoutMs: number): Promise<boolean>;   // semantic ready: table/list role present or explicit empty state
  currentPage(dialog: Element): { columns: string[]; rows: string[][] };
  advance(dialog: Element): Promise<"next"|"end"|"stuck">;           // enabled pagination/load-more → "next"; disabled/end → "end"; no progress → "stuck"
  close(dialog: Element): Promise<void>;
}
export function pageSignature(columns: string[], rows: string[][]): string; // canonicalJson({columns,rows})
export function dedupeRows(rows: string[][]): string[][];                    // exact-match dedupe, preserve first-seen order
export async function collectKnownIssues(driver: KiDriver, doc: Document,
                                         target: DomTarget, pageUrl: string): Promise<KiResult>;
//   spec §13 algorithm verbatim: record displayedCount → skip iff exactly 0 → open → waitReady(5s)
//   → capture columns+rows → signature → advance loop until end/stuck or repeated signature (max 50 pages guard)
//   → dedupe → close (always close in finally) → compare counts (null displayedCount → countMatches true, warning recorded)
```

```ts
// entrypoints/content.ts — orchestrator
export default defineContentScript({
  matches: ["https://bugcrowd.com/engagements/*"],
  runAt: "document_idle",
  async main(ctx) {
    // 1. capture initialUrl = location.href on load
    // 2. read browser.storage.session "activeJob" → if present, send PAGE_READY {jobId, url}
    // 3. browser.runtime.onMessage: RUN_UNIT {jobId, unitId, kind, params} →
    //    validate shape → dispatch unit kind:
    //      "collect_details" → collectDetails(document, initialUrl)
    //      "collect_targets" → collectTargets(...)
    //      "collect_policy"  → collectPolicies(...)
    //      "collect_activity"→ collectActivity(..., sameOriginFetchPage)
    //      "collect_ki"      → collectKnownIssues(domKiDriver, document, params.target, initialUrl)
    //      "restore_page"    → restorePage() (history back/location to initialUrl; close exporter-opened dialogs)
    //    session check before every unit: isSessionExpired → reply {ok:false,error:{kind:"session_expired"}}
    //    wrap results {ok:true,result} / {ok:false,error:{kind,message}}; send UNIT_RESULT is implicit via response;
    //    emit UNIT_PROGRESS during KI (counters {kiDone,kiTotal})
    // 4. track every element/dialog the exporter opened in a Set → restorePage() closes them all
  }
});
export function sameOriginFetchPage(url: string): Promise<Document | null>;
//   fetch same-origin only (new URL(url).origin === location.origin && startsWith "https://bugcrowd.com") → DOMParser; null on failure
```

`DomKiDriver` implements `KiDriver` against live DOM: click the KI control (button/link found via accessible name from `target.kiControlLabel`), `waitReady` polls every 100ms for `role=table|grid|list` or labelled empty-state, `advance` clicks enabled pagination/`load more` controls, `close` presses Escape/close button.

- [ ] **Step 1: Fixtures + failing tests.** `ki-zero.html` (count badge "0"), `ki-one.html` (single page, 3 rows, columns Priority/Variant/Count), `ki-multi.html` (dialog whose rows change when a scripted next-button fires — simulate pagination by swapping table body across two pages, second page repeats one row to prove dedupe; then disabled next), `ki-mismatch.html` (displays "5" but only 2 rows ever render). Tests: zero → skipped, no open call (spy driver); single → 3 rows, columns captured, countMatches; multi → pages aggregated, repeated row deduped once, order preserved, signature-stop prevents infinite loop; mismatch → countMatches:false + warning; recognized-field mapping only when labels present; driver close called even when advance throws; orchestrator unit dispatch maps kinds→collectors (mock collectors), session_expired short-circuits, restore_page invokes restorePage, unknown unit kind → `{ok:false}`, PAGE_READY sent only when activeJob exists in storage.session (fakeBrowser).
- [ ] **Step 2: `npm test` → FAIL** (jsdom env).
- [ ] **Step 3: Implement** knownIssues.ts + DomKiDriver + content.ts orchestrator.
- [ ] **Step 4: `npm test` → PASS; `npx wxt build` clean.**
- [ ] **Step 5: Commit** `feat: Known Issues dialog collection with pagination, dedupe, count validation; content orchestrator`.

### Task 6: Evidence builder + derived target IDs + normalizers + conflict detection

**Files:**
- Create: `lib/evidence.ts`, `lib/model/targetIds.ts`, `lib/model/facts.ts`, `lib/model/conflicts.ts`
- Test: `tests/evidence.test.ts`, `tests/targetIds.test.ts`, `tests/facts.test.ts`, `tests/conflicts.test.ts`

**Interfaces:**
- Consumes: `lib/types.ts`, `lib/canonical.ts` (all), `lib/hash.ts`, `lib/constants.ts`, Task 3 `ApiEngagementData`, Task 4 `DetailsData`/`DomTargetGroup`/`DomTarget`/`DomRule`/`PolicyData`/`ActivityItem`, Task 5 `KiResult`.
- Produces:

```ts
// lib/evidence.ts
export function evidenceHashInputV1(rec: SourceRecord, canonicalSourceUrl: string): object;
//   {schema_version:2, source_type, source_authenticated, canonical_source_url, source_key,
//    source_level, canonical_locator:{defined fields only}, normalized_quote}
export async function buildEvidence(records: SourceRecord[], opts: { collectedAt: string }): Promise<Evidence[]>;
//   canonicalizes url+locator+quote → hash → id/content_hash; extraction.status copied; parser_version PARSER_VERSION
export function sortEvidenceForCorpus(evs: Evidence[]): Evidence[];
//   stable sort: SOURCE_TYPE_ORDER(api→dom), then source_key, then canonicalLocator JSON, then id
export async function evidenceCorpusHash(evs: Evidence[]): Promise<string>; // "sha256:"+hex over canonicalJson of sorted evidence minus volatile fields (collected_at excluded — hash the EvidenceHashInput-equivalent projection)
export async function normalizedHash(model: unknown): Promise<string>;      // canonicalJson of model (caller pre-strips volatile fields)
```

```ts
// lib/model/targetIds.ts
export interface TargetIdentity { id: string; id_source: "api" | "derived";
  identity_quality: IdentityQuality; duplicate_disambiguated: boolean }
export async function assignTargetIdentities(targets: { apiId?: string|null; location: string|null;
  name: string|null; type: string|null; groupKey?: string|null }[],
  engagementId: string): Promise<TargetIdentity[]>;
//   apiId present → {id:apiId, id_source:"api", identity_quality:"api"}
//   else derived: preimage {schema_version:1, engagement:engagementId, location:canonical(location)
//   else name, type, occurrence} → "target_"+hex8; location preferred over name (identity_quality
//   exact_location vs name_fallback); duplicates (same canonical location/name+type) sorted
//   canonically then occurrence=1..n → identity_quality "duplicate_disambiguated",
//   duplicate_disambiguated:true. groupKey NEVER in preimage.
```

```ts
// lib/model/facts.ts
export interface AssertionInput { status: PermissionStatus; conditions: string[];
  applies_to: Applicability; evidence: Evidence[] }   // evidence already built
export function buildPermissionFact(assertions: AssertionInput[]): PermissionFact;
//   - only assertions backed by ≥1 evidence with extraction.status==="exact" are "asserted"
//   - zero asserted → status "unspecified", evidence_refs = all (incl. partial for review), extraction.status = worst-of
//   - exactly one distinct asserted status → that status + merged conditions + evidence_refs
//   - >1 distinct asserted statuses → conflict{detected:true, asserted_statuses, evidence_refs:all asserted ev},
//     resolution:{status:"unresolved"}, status:"unspecified" (enum has no conflict value; conflict block
//     preserves every asserted status + evidence — nothing is resolved or dropped)
export function buildSafeHarborFact(signals: { present?: Evidence[]; absent?: Evidence[]; ambiguous?: Evidence[] }):
  { status: SafeHarborStatus; evidence_refs: string[] };
export function mapTechnique(policyTechnique: { name: string; status: PermissionStatus;
  conditions: string[] }, ev: Evidence[], applies_to: Applicability): AssertionInput;
```

```ts
// lib/model/conflicts.ts
export function detectConflicts(facts: Record<string, PermissionFact>):
  { conflicts_present: boolean; unresolved_conflicts: number };
//   counts facts with conflict.detected && resolution unresolved; never mutates facts
```

- [ ] **Step 1: Failing tests.** evidence: preimage identical for same logical source+text (different collectedAt/job context → same id), different source_key → different id, changed quote → different id, `ev_`+12hex + `sha256:`+64hex formats, partial status preserved, locator volatile fields absent; corpus: shuffle same evidence set ×10 random orders → identical corpus hash + identical sorted order (ids may repeat? no — unique set); targetIds: api id passthrough; location-vs-name quality; group move (same target different groupKey) → identical id; two identical location+type → distinct ids, both `duplicate_disambiguated`, deterministic across input order; facts: exact→asserted; partial-only→unspecified (even 3 agreeing partials); mixed exact+partial→asserted w/ partial attached; two different exact statuses→conflict detected, asserted_statuses both listed, status unspecified, resolution unresolved; allowed+prohibited same technique; `unspecified` never becomes `prohibited`; safeHarbor present/absent/unclear mapping.
- [ ] **Step 2: `npm test` → FAIL.**
- [ ] **Step 3: Implement** four modules.
- [ ] **Step 4: `npm test` → PASS.**
- [ ] **Step 5: Commit** `feat: content-addressed evidence, derived target identities, four-state facts, conflict preservation`.

### Task 7: Integrity checker + versioned document model

**Files:**
- Create: `lib/model/integrity.ts`, `lib/model/document.ts`
- Test: `tests/integrity.test.ts`, `tests/document.test.ts`

**Interfaces:**
- Consumes: everything prior (`Evidence`, `PermissionFact`, `TargetIdentity`, `ApiEngagementData`, `DetailsData`, `DomTargetGroup`/`DomTarget`, `PolicyData`, `ActivityItem`, `KiResult`, `detectConflicts`, `normalizedHash`, `evidenceCorpusHash`).
- Produces:

```ts
// lib/model/integrity.ts
export interface UnitOutcome { unitId: string; status: "ok"|"warning"|"failed"|"skipped";
                               required: boolean; critical: boolean; warnings: string[] }
// Unit criticality (set by coordinator): u01_validate_url critical, u02_init_job critical,
// u03_collect_details critical+required, u04_api_enrichment required:false (OPTIONAL — API
// unavailability never makes collection partial, spec §18), u05–u08 required,
// u09–u12 critical (internal failure → output impossible → failed), u13 best-effort.
export interface IntegrityReport {
  collection: { status: CollectionStatus; api_status: CollectionStatus | "unavailable";
                dom_status: CollectionStatus; parser_version: string;
                evidence_corpus_hash: string; normalized_hash: string };
  integrity: { evidence_hash_valid: boolean; known_issues_counts_valid: boolean;
               required_sections_complete: boolean };
  quality: { warnings: string[] };
  policy: { conflicts_present: boolean; unresolved_conflicts: number };
}
export function computeIntegrity(args: {
  outcomes: UnitOutcome[]; kiResults: KiResult[]; apiFailed: boolean; domCriticalFailure: string | null;
  facts: Record<string, PermissionFact>; evidence: Evidence[]; corpusHash: string; normalizedHash: string;
}): IntegrityReport;
//   rules (spec §18): required outcome "failed"/missing → status partial; outcome "critical"
//   failed OR domCriticalFailure (unsupported_url|session_expired|details_failed|tab_closed)
//   → failed (trumps partial); ki countMatches false →
//   partial + warning + known_issues_counts_valid false; apiFailed alone → api_status "unavailable",
//   does NOT force partial; conflicts only set policy.* — never change collection.status;
//   required_sections_complete = all required outcomes ok/warning.
```

```ts
// lib/model/document.ts — the versioned document model the renderer consumes
export interface DocumentModel {
  schema_version: number;                       // DOCUMENT_SCHEMA_VERSION
  generated_at: string;                         // volatile — excluded from normalized_hash
  job_id: string;                               // volatile — excluded
  engagement: { name: string|null; code: string; uuid: string|null; canonicalUrl: string;
    type: string|null; managedBounty: boolean|null; lifecycleStatus: string|null;
    testingStart: string|null; testingEnd: string|null; testingPeriodLabel: string|null;
    lastStatusTransition: string|null; lastBriefUpdate: string|null;
    safeHarbor: { status: SafeHarborStatus; level: string|null; evidence_refs: string[] };
    disclosurePolicy: string|null };
  statistics: Record<string,{value:string;window:string|null}>;
  targets: { id: string; id_source: "api"|"derived"; identity_quality: IdentityQuality;
    location: string|null; name: string|null; category: string|null; tags: string[];
    docLinks: string[]; changeFlags: string[]; inScope: boolean; groupId: string|null }[];
  targetGroups: { id: string; name: string; inScope: boolean; description: string|null;
    rewards: {p1:number|null;p2:number|null;p3:number|null;p4:number|null;p5:number|null} }[];
  //   group id = API relationship id when present, else `group:${domKey}` (domKey is the
  //   deterministic normalized-name key from Task 4 — stable across runs)
  outOfScope: { location: string|null; name: string|null; notes: string|null }[];
  techniques: Record<string, PermissionFact>;   // spec §4.3 technique keys
  accountRules: { text: string; evidence_refs: string[] }[];
  dataRules: { text: string; evidence_refs: string[] }[];
  focusAreas: string[]; nonFocusAreas: string[];
  reportingRequirements: string[];
  vrt: { version: string|null; baseline: string|null; exclusions: string[];
         deviations: string[]; targetSpecific: string[]; notes: string[];
         evidence_refs: string[] };
  knownIssues: { targetId: string; displayedCount: number|null; collectedCount: number;
    countMatches: boolean; columns: string[]; rows: { cells: string[]; recognized?: Record<string,string> }[];
    evidence_refs: string[] }[];
  announcements: ActivityItem[]; changelog: ActivityItem[];
  recentActivity: ActivityItem[]; acceptedReports: ActivityItem[];
  evidence: Evidence[];                          // corpus-sorted
  collection: IntegrityReport["collection"];
  integrity: IntegrityReport["integrity"];
  quality: IntegrityReport["quality"];
  policy: IntegrityReport["policy"];
  api: { api_major_target: string; api_schema_tested: string; observed_version: string|null;
         status: string };
  provenance: { parser_version: string; collected_at: string; missing_sections: string[];
                conflicts: { factKey: string; evidence_refs: string[] }[] };
}
export function stripVolatile(model: DocumentModel): object; // deep-clone minus generated_at, job_id, collected_at — input to normalizedHash
export function assembleDocument(args: { /* every collector output + evidence + facts + integrity */ }): DocumentModel;
//   merges API vs DOM per spec §6.3 precedence: API wins official uuid/lifecycle timestamps/
//   relationship ids/integer rewards; DOM wins policy text/visible scope/locations/tags/KI/
//   page-only stats; material disagreement on a permission → contributes both assertions to
//   buildPermissionFact (conflict path), never silent choice.
```

- [ ] **Step 1: Failing tests.** integrity: all-ok→complete+flags true; apiFailed only→complete+api_status unavailable; KI mismatch→partial+warning+ki flag false; missing required outcome→partial; domCriticalFailure session_expired→failed; conflict fact→policy counts only, status still complete; document: stripVolatile drops exactly the volatile fields (normalizedHash(stripVolatile(m)) identical across two models differing only in generated_at/job_id); assembleDocument precedence — API uuid beats null, DOM location beats API location null? — per §6.3 each wins its own fields, test both directions; rewards integer from API when present else DOM; missing_sections recorded when a required collector returned no records.
- [ ] **Step 2: `npm test` → FAIL.**
- [ ] **Step 3: Implement** integrity.ts + document.ts.
- [ ] **Step 4: `npm test` → PASS.**
- [ ] **Step 5: Commit** `feat: integrity model, versioned document model, source precedence merge`.

### Task 8: Markdown renderer + download

**Files:**
- Create: `lib/render/frontMatter.ts`, `lib/render/markdown.ts`, `lib/download.ts`
- Test: `tests/markdown.test.ts`, `tests/download.test.ts`

**Interfaces:**
- Consumes: `lib/model/document.ts` (`DocumentModel`), `lib/ids.ts` (`exportFileName`), `yaml` package.
- Produces:

```ts
// lib/render/frontMatter.ts
export function renderFrontMatter(model: DocumentModel): string;
//   YAML (via `yaml` pkg stringify, sorted key order as written): schema_version, generated_at,
//   source{canonical_url,api_major_target,api_schema_tested,observed_version}, engagement{name,code,uuid},
//   collection{status,api_status,dom_status,parser_version,evidence_corpus_hash,normalized_hash},
//   integrity{3 flags}, quality{warnings[]}, policy{conflicts_present,unresolved_conflicts}
```

```ts
// lib/render/markdown.ts
export function escapeMd(text: string): string;        // backslash-escape `*_[]()#+-.!|>\ and leading #
export function mdTable(headers: string[], rows: string[][]): string;
export function renderAgentFacts(model: DocumentModel): string;  // fenced ```yaml block: evidence-backed normalized fields (techniques w/ status+applies_to+evidence_refs, safeHarbor, collection, integrity, policy)
export function renderMarkdown(model: DocumentModel): string;
//   sections IN SPEC §16 ORDER, each an H2:
//   (front matter first, then) 1 Agent Facts; 2 Engagement Overview (name/code/uuid/type/managed/
//   lifecycle/dates/statistics table); 3 Authorization and Safe Harbor (status, level, verbatim
//   statements w/ evidence ids); 4 Scope Inventory (in-scope groups+targets table: id/location/
//   category/tags; out-of-scope list); 5 Reward Matrix (group × P1–P5, null → "—"); 6 Known Issues
//   (per target H3: displayed vs collected, columns table, count mismatch ⚠); 7 VRT Policy;
//   8 Testing, Account, Resource, and Data Constraints (verbatim rule texts + evidence refs);
//   9 Focus Areas / Explicit Exclusions; 10 Credentials and Access; 11 Reporting Requirements;
//   12 Announcements and Changelog (source-ordered, timestamps+urls); 13 Recent Activity,
//   Participation, Response Statistics; 14 Evidence Objects (per evidence: id/source_key/level/
//   url/section/status + blockquoted quote — corpus-sorted order); 15 Collection Provenance,
//   Conflicts, Missing Sections, Warnings.
//   Rich policy text: preserve original line structure (split LF → list/paragraph), absolute links
//   ([label](https://…) — never rewritten), code spans. NO summarization/paraphrase. Deterministic:
//   same model → identical bytes.
```

```ts
// lib/download.ts
export async function downloadMarkdown(filename: string, markdown: string): Promise<void>;
//   data URL: "data:text/markdown;charset=utf-8;base64," + base64(TextEncoder bytes)
//   browser.downloads.download({url, filename, saveAs:false, conflictAction:"uniquify"})
```

- [ ] **Step 1: Failing tests.** front matter contains required keys + valid YAML round-trip (`yaml.parse`); renderMarkdown: all 16 sections present in exact order (assert heading index ordering), filename via exportFileName, determinism (render twice → identical), escaping (`*bold*`, `[x](y)`, `#` line-start, pipe in table cell), null reward → `—`, KI mismatch shows ⚠ + counts, evidence section order = corpus-sorted ids, quotes verbatim in blockquotes, absolute link preserved, **no token material**: model built with evidence whose quotes never contain secrets AND renderer never emits `Authorization`/`Token ` strings — assert output lacks them; Agent Facts yaml block parses and statuses ∈ enum.
- [ ] **Step 2: `npm test` → FAIL.**
- [ ] **Step 3: Implement** three modules.
- [ ] **Step 4: `npm test` → PASS.**
- [ ] **Step 5: Commit** `feat: deterministic Markdown renderer with 16-section dossier, data-URL download`.

### Task 9: Job coordinator + IndexedDB persistence + full background orchestration

**Files:**
- Create: `lib/job/descriptor.ts`, `lib/job/store.ts`, `lib/job/coordinator.ts`, `lib/job/units.ts`
- Modify: `entrypoints/background.ts` (full START_EXPORT/CANCEL_EXPORT/GET_JOB_STATE/JobMsg handling)
- Test: `tests/descriptor.test.ts`, `tests/store.test.ts`, `tests/coordinator.test.ts`

**Interfaces:**
- Consumes: ALL prior tasks (messages, tokenOps, api engagements, all collectors via content RUN_UNIT, evidence, targetIds, facts, integrity, document, markdown, download).
- Produces:

```ts
// lib/job/descriptor.ts — chrome.storage.session, key "activeJob"
export interface JobDescriptor { jobId: string; tabId: number; engagementCode: string;
  initialUrl: string; phase: "collecting"|"processing"|"rendering"|"done"|"failed"|"cancelled";
  currentUnit: string|null; completedUnits: string[]; pendingUnits: string[];
  counters: { unitDone: number; unitTotal: number; kiDone: number; kiTotal: number };
  warnings: number; unresolvedConflicts: number; cancelRequested: boolean;
  createdAt: string; updatedAt: string }
export function readDescriptor(): Promise<JobDescriptor | null>;
export function writeDescriptor(d: JobDescriptor): Promise<void>;
export function patchDescriptor(patch: Partial<JobDescriptor>): Promise<JobDescriptor | null>;
export function clearDescriptor(): Promise<void>;
export function newDescriptor(tabId: number, code: string, initialUrl: string): JobDescriptor;
//   jobId = "job_" + crypto.randomUUID().slice(0,8); pendingUnits = UNIT_ORDER copy
```

```ts
// lib/job/units.ts
export const UNIT_ORDER = [
  "u01_validate_url","u02_init_job","u03_collect_details","u04_api_enrichment",
  "u05_collect_targets","u06_collect_policy","u07_collect_activity","u08_known_issues",
  "u09_build_evidence","u10_normalize_facts","u11_integrity_check","u12_render_download",
  "u13_cleanup"] as const;
export type UnitId = (typeof UNIT_ORDER)[number];
export const UNIT_PHASE: Record<UnitId, JobDescriptor["phase"]>;
//   u01–u08 collecting, u09–u11 processing, u12 rendering, u13→done
```

```ts
// lib/job/store.ts — idb wrapper, db "bce", v1
export interface UnitResult { unitId: string; status: "ok"|"warning"|"failed";
                              committedAt: string; output?: unknown }
export function openStore(): Promise<IDBPDatabase>;
//   stores: sourceRecords [jobId+sourceKey], evidence [jobId+evidenceId],
//   facts [jobId+factKey], unitResults [jobId+unitId], blobs [jobId+kind] (detailsData, targetsData,
//   policyData, activityData, apiData, kiResults, document, markdown)
export function commitUnit(db, jobId: string, unitId: string,
                           writes: { records?: SourceRecord[]; evidence?: Evidence[];
                                     facts?: Record<string,PermissionFact>; blob?: {kind:string;value:unknown} },
                           result: UnitResult): Promise<void>;
//   single idb transaction across stores; repeated commit for same unitId overwrites same keys (idempotent)
export function getBlob<T>(db, jobId: string, kind: string): Promise<T | null>;
export function getUnitResults(db, jobId: string): Promise<UnitResult[]>;
export function getAllRecords(db, jobId: string): Promise<SourceRecord[]>;
export function verifyJobData(db, jobId: string, required: string[]): Promise<{ok:boolean;missing:string[]}>;
//   required = blob kinds/units the checkpoint expects; missing → {ok:false}
export function purgeJob(db, jobId: string): Promise<void>;
```

```ts
// lib/job/coordinator.ts
export interface CoordinatorDeps {
  sendToTab(tabId: number, msg: unknown): Promise<unknown>;   // wraps browser.tabs.sendMessage
  apiEnrich(code: string, uuid: string|null): ReturnType<typeof fetchEngagementEnrichment>;
  now(): string;
}
export class JobCoordinator {
  constructor(deps: CoordinatorDeps)
  async start(tabId: number): Promise<{ok:true;jobId:string}|{ok:false;error:string}>;
  async resume(): Promise<void>;                 // SW-startup path: readDescriptor → verifyJobData → run from first pending
  async cancel(): Promise<void>;                 // set cancelRequested; coordinator checks before every unit + before every tab msg
  async handleJobMessage(msg: JobMessage, sender): Promise<unknown>; // PAGE_READY/UNIT_PROGRESS/UNIT_RESULT
  get state(): JobDescriptor | null;
}
// Execution: for unitId of pendingUnits (in UNIT_ORDER):
//   patchDescriptor({currentUnit:unitId, phase:UNIT_PHASE[unitId]})
//   dispatch: SW units run in-process; content units → sendToTab RUN_UNIT → validate UNIT_RESULT
//   commitUnit(...) → patchDescriptor(completedUnits+, pendingUnits−, currentUnit:null)
//   cancellation between units → run u13 cleanup variant (restore page via sendToTab restore_page,
//   clearDescriptor, purgeJob? — NO: keep records until descriptor cleared; spec: cancel → cleanup UI+URL,
//   no download; purge intermediate records at end of cleanup)
// u08_known_issues: per-target loop inside unit; commits each target's KiResult blob to store
//   progressively (sub-checkpoint in unitResults output.kiDone[]); restart → skips targets already in kiDone
// u10_normalize_facts: assignTargetIdentities (apiId from ApiTarget when matched by canonical
//   location, else derived) → map DomRule.appliesToDomKeys through assigned target ids
//   (unmatched domKey → falls back to its group's `group:<domKey>` applicability, then
//   "engagement" when no group) → AssertionInput[] → buildPermissionFact per technique;
//   target-specific rules produce separate applies_to target_ids facts.
// Errors: content unit returns session_expired → domCriticalFailure → u13 cleanup then status failed;
//   tab closed (sendToTab throws / tab gone) → failed; details failed → failed;
//   u04 api error → outcome "warning" required:false + api_status unavailable, CONTINUE;
//   required unit failed → partial; critical unit failed → failed
// u12: assembleDocument → hashes → renderMarkdown → downloadMarkdown(exportFileName)
// u13: send restore_page → clearDescriptor + purgeJob ONLY after download acked (downloads.download resolved)
// resume(): no descriptor → idle; descriptor.phase done/failed/cancelled → clear+purge; else verifyJobData
//   (blobs for completedUnits must exist; missing → restart job as failed-safe: purge, clear, surface error)
// handleJobMessage: validateJobSender(msg, descriptor, descriptor.phase) then route; PAGE_READY during
//   a pending content unit → re-send RUN_UNIT for currentUnit (idempotent content-side)
```

Background wiring (replaces stubs): `START_EXPORT{tabId}` → verify tab.url `isSupportedEngagementUrl` → `new JobCoordinator(deps).start(tabId)` → `{ok,jobId}`; `CANCEL_EXPORT` → cancel; `GET_JOB_STATE` → `{ok,state}`; JobMsg → `handleJobMessage`; on SW load (`main()` start) → `ensureTrustedContexts()` then `new JobCoordinator(deps).resume()`; real `sendToTab` = `browser.tabs.sendMessage`, `apiEnrich` = `fetchEngagementEnrichment`.

- [ ] **Step 1: Failing tests** (`fake-indexeddb/auto` import in store/coordinator tests; fakeBrowser for session storage; CoordinatorDeps.sendToTab + apiEnrich mocked): descriptor round-trip/patch/clear + never accepts token field (assert schema has no credential key — document, not enforce); store commitUnit idempotent (commit twice → one result), cross-store atomicity, verifyJobData missing detection, purgeJob; coordinator: happy path drives all 13 units in order (scripted sendToTab replies), descriptor checkpoints advance AFTER commit (spy order), cancel mid-collect → no further sendToTab, restore_page sent, phase cancelled, no download; resume after "SW death" (new coordinator instance, descriptor left at u06) → resumes u06 not u03, no duplicate evidence (commitUnit idempotent count); verifyJobData missing → clean fail not resume; KI sub-checkpoint: resume inside u08 skips completed targets; session_expired from content → failed + cleanup; tab-closed sendToTab throw → failed; job message validation wired (wrong phase rejected); **descriptor + all messages scanned for token** (set credential, run job, scan JSON of descriptor and every sendToTab/sendMessage payload for the secret).
- [ ] **Step 2: `npm test` → FAIL.**
- [ ] **Step 3: Implement** descriptor/units/store/coordinator + background wiring.
- [ ] **Step 4: `npm test` → PASS; `npx wxt build` clean.**
- [ ] **Step 5: Commit** `feat: persisted job coordinator, IndexedDB intermediate store, orchestrated export pipeline`.

### Task 10: Popup + options UI

**Files:**
- Modify: `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`, `entrypoints/popup/style.css`
- Modify: `entrypoints/options/index.html`, `entrypoints/options/main.ts`, `entrypoints/options/style.css`
- Test: `tests/popup-state.test.ts` (pure view-model logic in `lib/ui/popupState.ts` — keep DOM thin)

**Interfaces:**
- Consumes: `lib/messages.ts` (`PopupMsg`, `ApiRequestMsg`), `lib/ids.ts` (`isSupportedEngagementUrl`), `lib/job/descriptor.ts` (`JobDescriptor` type only — popup never touches storage directly; all state via GET_JOB_STATE).
- Produces:

```ts
// lib/ui/popupState.ts
export interface PopupView { canExport: boolean; job: JobDescriptor | null;
  statusLines: { label: string; value: string }[] }  // collection/API/DOM/warnings/conflicts as INDEPENDENT lines
export function viewFor(url: string | null, job: JobDescriptor | null): PopupView;
//   canExport = isSupportedEngagementUrl(url) && (!job || job.phase done|failed|cancelled)
//   progress text: `${counters.unitDone}/${counters.unitTotal} units`, KI `${kiDone}/${kiTotal}`, phase label
```

Popup (`index.html` + `main.ts`, vanilla, `<meta name="manifest.default_icon">` optional; `manifest.browser_style` false): on open → `browser.tabs.query({active:true,currentWindow:true})` → `GET_JOB_STATE` → render viewFor; `Export full engagement` button (disabled unless canExport) → `START_EXPORT{tabId}`; `Cancel` (visible when job active) → `CANCEL_EXPORT{jobId}`; `Settings` → `browser.runtime.openOptionsPage()`; 1s poll of GET_JOB_STATE while open (reconnect = poll picks up active job automatically).

Options: password input + `Save token` → `SAVE_TOKEN{token}` (normalize happens SW-side); `Test token` → `API TEST_TOKEN{token: input || undefined}` → shows result detail; `Clear token` → `CLEAR_TOKEN`; status line from `GET_TOKEN_STATUS`; disclaimer text verbatim: "Stored in Chrome local storage, which is local to this browser profile but is not an encrypted secret vault." Never displays stored token (input stays empty; only "configured"/"not configured" shown).

- [ ] **Step 1: Failing tests** for `viewFor`: unsupported url → canExport false; supported + no job → true; active job → false + progress lines reflect counters/phase/warnings/conflicts independently; done job → true.
- [ ] **Step 2: `npm test` → FAIL → implement popupState + popup + options → PASS.**
- [ ] **Step 3: `npx wxt build` → load `.output/chrome-mv3` sanity: popup/options render (manual or DOM smoke test in jsdom importing main.ts with browser mocks — keep to smoke level).**
- [ ] **Step 4: Commit** `feat: popup export/progress UI with reconnect, options token management`.

### Task 11: Integration pipeline tests + acceptance hardening + README

**Files:**
- Create: `tests/integration/export-pipeline.test.ts`, `tests/integration/collection-outcomes.test.ts`, `tests/integration/secret-scan.test.ts`
- Create: `README.md`
- Modify: any module where integration exposes a defect (fix-forward with its own commit)

**Interfaces:**
- Consumes: the entire pipeline. Uses `JobCoordinator` with scripted `sendToTab` (feeds canned collector outputs built from Task 4–5 fixture data) + mocked `apiEnrich` + fakeBrowser + fake-indexeddb.
- Produces: acceptance evidence for spec §21 items that are testable in vitest.

- [ ] **Step 1: Integration tests.**
  - `export-pipeline.test.ts`: full job start→download; assert `browser.downloads.download` called once with `bugcrowd-<code>-<date>.md`; rendered file contains YAML front matter + all 15 H2 sections (spec §16 items 1–16) in order; evidence appendix order = corpus sort; identical evidence injected in two different Promise orders → same corpus hash + same evidence order in file.
  - `collection-outcomes.test.ts`: (a) API fails, DOM ok → complete + api_status unavailable; (b) conflicting program-rule vs target-rule evidence → complete + policy.unresolved_conflicts 1, both in file; (c) KI mismatch → partial + warning; (d) session_expired at u05 → failed + NO download; (e) SW "death" between u05/u06 (new coordinator, persisted state) → resumes, no duplicated evidence ids, all units complete; (f) cancel during u07 → cancelled, restore_page sent, no download.
  - `secret-scan.test.ts`: run a full export with credential `hunter2-secret-token`; scan rendered markdown, every sendToTab/sendMessage payload, descriptor JSON, thrown error strings, and console.warn/error spy output for the token and for `Token hunter2`/`Authorization` → zero hits.
- [ ] **Step 2: Fix any defects surfaced** (each fix = own commit referencing the failing test).
- [ ] **Step 3: README.md** — what it does, load-unpacked steps (`npx wxt build` → chrome://extensions → Developer mode → Load unpacked `.output/chrome-mv3`), token setup, export flow, output description, security model summary (token storage, allowlisted ops, no telemetry), manual acceptance checklist mapping spec §20.3 steps 1–7 and §21 items to how each is verified.
- [ ] **Step 4: `npm test` full suite → PASS, pristine output; `npx wxt build` → clean; verify built manifest has exactly the required permissions.**
- [ ] **Step 5: Commit** `test: integration pipeline, collection outcomes, secret scan; docs: README`.
