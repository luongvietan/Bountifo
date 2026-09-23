# Radar Report Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the persisted Radar scan as a consolidated report — Markdown, JSON, or CSV — across one or all six scoring profiles, from the Radar page.

**Architecture:** A new pure serializer module (`lib/radar/export.ts`) renders a coordinator-assembled `RadarExportData` snapshot. The background exposes a `RADAR_EXPORT_REPORT` message op that assembles + serializes + hashes; the radar page downloads the returned body via a Blob object URL. No network, no scan mutation — read-only over the persisted `bce-radar` store.

**Tech Stack:** TypeScript, WXT extension (MV3), zod message schemas, fake-indexeddb + vitest tests, existing `canonicalJson`/`sha256Hex`/`escapeMd`/`mdTable`/`redactSecrets` helpers.

**Spec:** the V1.5 Radar Report Export brief (this session's task description) + `docs/RADAR.md`.

## Global Constraints

- Read-only over the persisted store: no Bugcrowd requests, no scan-state writes.
- `null` stays `null`/empty/`—`; unknown is never coerced to 0; stored scores are never recomputed.
- One coherent snapshot: pin `meta.latestRunId` → that run record once; scope = `completed_uuids ∪ pending_uuids`; deep rows gated by `deep_completed_uuids` — same rule as `getResults`.
- Report body is deterministic for identical persisted data + options; wall-clock `generated_at` lives only in the message response, never in the body or content hash.
- `content_hash` = `"sha256:" + sha256Hex(canonicalJson(exportData))` — over the assembled data model, so it is format-independent and may be embedded inside MD/JSON bodies.
- Percentile = `cohortPercentile(pos, eligibleCohortSize)` over the FULL ranked cohort, computed before the row limit truncates (same semantics as `getResults`).
- Evidence levels stay explicit: `evidence_level`, `metadata_score`, `deep_score`, `score_delta` per row; metadata-only rows never masquerade as deep.
- Untrusted strings (name/code/url) are `escapeMd`'d in Markdown, formula-guarded in CSV, and never rendered as HTML.
- No cookies/tokens/Authorization/session material — export data is built only from normalized radar rows; `redactSecrets` runs over the final body with the stored credential (when one exists) as defense in depth.
- Preserve Exporter V1, Scope Guard V1, Execution Guard V1 — untouched by this feature.
- `npm run typecheck` baseline is 0 errors; keep it there.

## File structure

- `lib/radar/export.ts` (new) — types + pure serializers + filename + content hash + CSV escaping.
- `lib/radar/coordinator.ts` (modify) — extract shared row-collection into `collectProfileRows`; add `getExportData`.
- `lib/version.ts` (new) — `appVersion()` / `sourceCommit()` (manifest version; `import.meta.env.VITE_COMMIT_SHA`).
- `lib/messages.ts` (modify) — `RADAR_EXPORT_REPORT` op schema.
- `entrypoints/background.ts` (modify) — route op, provenance + credential redaction, response envelope.
- `entrypoints/radar/index.html` (modify) — Export button + `<dialog>` options form.
- `entrypoints/radar/main.ts` (modify) — dialog wiring + Blob download.
- `entrypoints/radar/style.css` (modify) — dialog styling.
- `wxt.config.ts` (modify) — `import.meta.env.VITE_COMMIT_SHA` define from `BOUNTIFO_COMMIT_SHA` env.
- `tests/radar-export.test.ts` (new) — the suite below.
- `docs/samples/radar-report.{md,json,csv}` (new) — deterministic golden samples.
- `docs/RADAR.md`, `README.md` (modify) — feature docs.

## Interfaces

- `RadarExportData` (produced by `RadarCoordinator.getExportData`, consumed by serializers):

```ts
export interface RadarExportQuery {
  profiles: RadarProfileId[];            // resolved: 1 id or all six (pinned order)
  limit: number | null;                  // null = all ranked rows
  detail: boolean;                       // per-row components/reasons/deep digest
  diagnostics: boolean;                  // run-level deep sub-source tallies
  provenance: { app_version: string | null; commit_sha: string | null };
}

interface RadarExportData {
  run: { run_id, phase, started_at, updated_at, status|null, catalog_complete,
         discovered, enriched, enrichment_failed, scored, warnings,
         warning_details: string[], deep_candidates|null, deep_analyzed|null,
         deep_enriched|null, deep_rounds|null, deep_budget|null,
         deep_stabilization|null };
  provenance: { app_version, commit_sha, schema:"bce-radar-export", schema_version:1 };
  restricted_access: { count:number, programs:string[] };  // gated-posture programs in export
  sections: { profile_id, profile_version, profile_label, min_confidence,
              total_ranked, eligible_count, exported_count, rows: RadarExportRow[] }[];
  diagnostics: RadarDeepDiagnostics | null;
}

interface RadarExportRow {
  rank:number; uuid:string; slug:string; engagement_url:string|null;
  name:string|null; score:number|null; metadata_score:number|null;
  deep_score:number|null; score_delta:number|null;
  evidence_level:"metadata"|"deep"; coverage:number; percentile:number|null;
  eligible:boolean; provisional:boolean; restricted_access:boolean;
  signals: Record<RadarFeatureKey, number|null>;   // all 20, fixed key order
  detail?: {   // only when query.detail
    enrichment: {status:string, error_kind:string|null}|null;
    stages: { stage:"metadata"|"deep"; scoring_version:string; source_hash:string;
              score:number|null; confidence:number; provisional:boolean;
              components:ProgramScore["components"]; reasons:string[] }[];
    signal_meta: Record<RadarFeatureKey,{source:string; reason_code:string}>;
    deep: { status:string; known_issues:{status:string;unique_count:number|null;
            total_count:number|null; group_stats:{status:string;groups_fetched:number|null;
            groups_total:number|null}|"absent"}|null;
            semantic_diff:{status:string;from_version:string|null;to_version:string|null}|null;
            scope_arc:{status:string;window_versions:number|null}|"absent"|null }|null;
  };
}

interface RadarDeepDiagnostics {
  deep_candidates:number; deep_analyzed:number; not_analyzed:number;
  sub_sources: { known_issues: SubSourceCounts; semantic_diff: SubSourceCounts;
                 scope_arc: SubSourceCounts; group_stats: SubSourceCounts };
}
type SubSourceCounts = { complete:number; unavailable:number; failed:number;
                         no_baseline:number; skipped:number; absent:number };
```

- Serializers: `renderRadarMarkdown(data): string`, `renderRadarCsv(data): string`, `renderRadarJson(data): {report:object}` — the JSON body wraps it: `{schema, schema_version, content_sha256, report}`.
- `serializeRadarExport(data, format): {body:string; mime:string; ext:string}` (async — computes hash first for embedding).
- `radarExportFileName(data, ext): string` → `radar-report-<run_id>-<profile|all>-<top20|top50|all>.<ext>`.
- `radarExportContentHash(data): Promise<string>` → `"sha256:"+sha256Hex(canonicalJson(data))`.
- `csvEscape(s: string): string` — double quotes, formula-guard `'` prefix for `^[ \t\r]*[=+\-@]` and leading tab/CR.
- Message op `RADAR_EXPORT_REPORT {format, scope:"current"|"all", profile?, limit:20|50|"all"=50, detail=true, diagnostics=true}` → `{ok, export:{filename, mime, body, content_hash, generated_at}}` or `{ok:false, error:"no_scan"|"invalid_params"}`.

## Tasks

### Task 1: Export module types + CSV serializer + escaping

**Files:** Create `lib/radar/export.ts`, `tests/radar-export.test.ts`.

- [ ] Failing tests: CSV header/column order, null→empty vs `0`→`0` distinction, `""` escaping, formula-injection guard (`=`, `+`, `-`, `@`, leading tab), `profile_id`/`profile_version`/`rank`/`evidence_level`/`engagement_slug` present on every row of an all-profile export.
- [ ] Implement types + `csvEscape` + `renderRadarCsv` + `radarExportFileName`.
- [ ] Green; commit.

### Task 2: Markdown + JSON serializers + content hash

- [ ] Failing tests: executive-summary fields present; per-profile table with correct columns; metadata-only row shows `—`/evidence `metadata`, deep row shows deep score + `Δ`; percentile printed is the stored cohort value; detail section emits components/weights/contributions/reasons/source_hash/deep sub-source statuses only when persisted; diagnostics table tallies complete/failed/unavailable/skipped/no_baseline/absent; zero-warning run still shows failed sub-sources; restricted-access notice appears only when gated rows exist; JSON `null` (not 0) for unavailable; `content_sha256` embedded equals `radarExportContentHash`; determinism (two calls → identical body).
- [ ] Implement `renderRadarMarkdown`, `renderRadarJson`, `serializeRadarExport`, `radarExportContentHash`.
- [ ] Green; commit.

### Task 3: Coordinator `getExportData` + `collectProfileRows` refactor

- [ ] Failing tests (fake-indexeddb seeded store): single vs all six profiles; stage isolation (deep-analyzed row gets both stage scores, metadata-only does not); Top-20/Top-50/all caps with percentile over the FULL cohort; no latest run → `null`; missing snapshot/partial deep payload → honest `absent` tallies; rows never mix a second run's uuids.
- [ ] Refactor `getResults` onto `collectProfileRows` (no behavior change — existing tests stay green); add `getExportData` + deep diagnostics collection + restricted-access flags.
- [ ] Green; commit.

### Task 4: Message op + router + version helpers

- [ ] Failing tests: schema accepts/rejects shapes (strict, injection keys rejected); router returns `no_scan` on empty store, `invalid_params` for `scope:"current"` w/o profile, and a full `{filename,mime,body,content_hash,generated_at}` envelope otherwise; secret redaction — a stored credential appearing in program data renders `[REDACTED]`; content-script sender rejected.
- [ ] Add `RADAR_EXPORT_REPORT` to `RadarMsg`; `lib/version.ts`; route in `background.ts` (provenance + `getCredential` → `secrets`).
- [ ] `wxt.config.ts` define for `VITE_COMMIT_SHA`.
- [ ] Green; commit.

### Task 5: Radar page UI

- [ ] Failing tests: view-helper coverage for export option state read/defaults where testable (pure parts only).
- [ ] `index.html`: `Export report` button + `<dialog>` with format/scope/limit/detail/diagnostics controls (defaults: markdown, all, top 50, both on).
- [ ] `main.ts`: open dialog, send op, Blob download (`URL.createObjectURL` + `browser.downloads.download`, `saveAs:false`, `uniquify`), disable button when no run, feedback lines.
- [ ] `style.css`: dialog styling consistent with the page theme.
- [ ] Green; commit.

### Task 6: Golden samples + docs + full verification

- [ ] Deterministic fixture → `docs/samples/radar-report.{md,json,csv}` via `UPDATE_RADAR_SAMPLES=1` guarded writer test (otherwise asserts equality).
- [ ] `docs/RADAR.md` export section; `README.md` feature paragraph.
- [ ] `npm test`, `npm run typecheck`, `npm run build` — record actual outcomes.
- [ ] Final review pass; commit.

## Review Focus

- A scan with zero warnings but failed deep sub-sources — diagnostics must still report the failures (test in Task 3/2).
- `limit:"all"` must not hit the 200-cap `getResults` enforces — export has its own uncapped path.
- `group_stats` `skipped_*` states count as terminal/skipped, never as failures.
- The JSON's embedded `content_sha256` must cover the `report` payload — not the wrapper — or it self-references.
- A deep score row existing for `high_reward`/`easy_entry` would be stale evidence — the `deep_completed_uuids` gate still applies.
