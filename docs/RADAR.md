# Engagement Radar

Deterministic program triage over the Bugcrowd engagement catalog. Radar
enumerates every engagement visible to the stored credential, hydrates
cheap API metadata per program, reduces each to a fixed 13-signal feature
vector, and ranks programs under six versioned weight profiles. No LLM
participates in collection, extraction, scoring, ranking, or explanation.

```text
LIST_ENGAGEMENTS                GET_ENGAGEMENT
page[size]=25, ≤100 pages       ?include=target_groups,targets
      │                               │
      ▼                               ▼
 Catalog (lib/radar/catalog.ts)   Hydrate (lib/radar/enrichment.ts)
      │                               │  ApiError classification
      ▼                               ▼
 RadarCatalogItem            RadarProgramSnapshot (+ source_hash)
                                    │
                                    ▼
              extractProgramFeatures (lib/radar/features.ts)
              pure — `now` passed in, no clock/network/storage
                                    │
                                    ▼
               ProgramFeatureVector — 13 signals, 0..1 or null
                                    │
              scoreProgram × 6 profiles (lib/radar/profiles.ts,
              lib/radar/scoring.ts) — pure, deterministic
                                    │
                                    ▼
              ProgramScore {score, confidence, components, reasons}
                                    │
                                    ▼
                  IndexedDB `bce-radar` (lib/radar/store.ts)
                                    │
                                    ▼
              RADAR_* message ops → extension page (radar UI)
```

## Data sources

All network access goes through `apiRequest` (`lib/api/client.ts`) — the
shared allowlisted-GET client with the rolling-window rate bucket, 429
`Retry-After` handling, bounded exponential backoff (max 4 attempts), and
credential isolation. Radar introduces no raw `fetch`.

| Input | Endpoint | Produces |
|---|---|---|
| Catalog | `GET /engagements?page[number]=N&page[size]=25` | `RadarCatalogItem` — uuid, code, name, lifecycle_status, engagement_type, discovered_at |
| Detail | `GET /engagements/{uuid}?include=target_groups,targets` | `ApiEngagementData` via `parseEngagement` — identity, lifecycle timestamps, safeHarborLevel, statistics, target groups (incl. rewards), targets (incl. tags, inScope) |

The DOM exporter is never run for radar scans. `statistics.*` values
arrive as display strings and are consumed only through a strict parser.
Token/Authorization material never reaches the radar store, score rows, or
message responses.

## Catalog completeness

`enumerateEngagementCatalog` pages `LIST_ENGAGEMENTS` from page 1:

| Condition | Status | Notes |
|---|---|---|
| Raw page < 25 rows | `complete` | First short page is the last page. Fullness is measured on the raw row count — skipped malformed/non-`engagement` rows still count toward it. |
| Page 100 returns full (`MAX_CATALOG_PAGES`) | `partial` | `page_limit_reached` warning. The cap is a safety bound, not an assumption — never reported `complete`. |
| `ApiError` from the client | `failed` | Items collected so far are kept; a warning names the error kind verbatim (`rate_limited`, `forbidden`, …) or `unknown` for a non-ApiError throw. |

Dedupe is by `uuid`, first occurrence wins; item order is first-seen page
order, so enumeration is deterministic for identical responses.

## Enrichment error classification

`hydrateRadarProgram` uses the catalog `uuid` verbatim (never re-resolved)
and always returns a snapshot for program-scoped failures:

| Error | Class | Resulting snapshot |
|---|---|---|
| `unauthorized`, `no_token`, `storage_locked` | Fatal — credential-wide | Original `ApiError` rethrown; aborts the run. |
| `forbidden`, `not_found` | Non-fatal | `detail: null`, `enrichment.status: "unavailable"`, `error_kind` set |
| `invalid_response`, `http`, `network`, `rate_limited` | Non-fatal | `detail: null`, `enrichment.status: "failed"`, `error_kind` set |
| Non-`ApiError` throw | Non-fatal | `detail: null`, `enrichment.status: "failed"`, `error_kind: "unknown"` |

One failed engagement never destroys the run; the coordinator counts it in
`enrichment_failed` and continues the queue.

## `source_hash`

`radarSourceHash` = `"sha256:" + hex` of SHA-256 over the domain-separated
preimage `"radar-source-v1:" + canonicalJson(projection)`.

- **Included** — every scoring input: catalog `uuid`, `code`, `name`,
  `lifecycle_status`, `engagement_type`; detail identity, `engagementType`,
  `managedBounty`, `lifecycleStatus`, `testingStart`/`testingEnd`/
  `testingPeriodLabel`, `lastStatusTransition`, `lastBriefUpdate`,
  `safeHarborLevel`, `statistics`, target groups (`id`, `name`, `inScope`,
  `description`, `rewards`), targets (`id`, `groupId`, `location`, `name`,
  `category`, `tags`, `inScope`).
- **Excluded** — volatile bookkeeping: `catalog.discovered_at`,
  `detail.observedApiVersion`, scan/run timestamps, runtime progress,
  `stored_at`, error details.
- **Order-independence** — `targetGroups` and `targets` sort by `id` with
  canonical-content tie-break; each target's `tags` sort lexicographically.
  Same semantic metadata → same hash regardless of arrival order.
- A failed snapshot legitimately hashes differently from its later
  hydrated form (`detail: null` vs populated), so a successful re-hydrate
  re-triggers scoring under a new key.

## Feature extraction

`extractProgramFeatures(snapshot, now)` is pure: no network, storage,
`Date.now()`, or randomness. Every emitted value is rounded to 4 decimals;
`null` means unknown and is never fabricated. When `snapshot.detail` is
`null`, the ten detail-derived signals are `null` with reason code
`detail_unavailable` — nothing is inferred from the catalog row — and the
three V1-unavailable signals keep `not_available_v1`.

### Signal definitions

| Signal | Source | Reason code | Derivation |
|---|---|---|---|
| `reward_potential` | `engagement_detail` | `reward_curve_p1_p2_p3` | Per tier p1/p2/p3: max reward over in-scope groups → `normReward`; blend 0.5·P1 + 0.3·P2 + 0.2·P3 renormalized over tiers present. `null` when no tier carries a finite value. |
| `reward_breadth` | `engagement_detail` | `reward_bearing_group_share` | Share of in-scope groups bearing ≥1 positive reward on p1..p5. `null` when zero in-scope groups. |
| `meaningful_surface` | `engagement_detail` | `in_scope_target_saturation` | `c/(c+25)` where `c` = in-scope targets with non-empty location or name. Always defined (0 targets → 0). |
| `api_surface` | `engagement_detail` | `api_token_share` | Share of in-scope targets whose token set intersects `{api, rest, graphql, grpc, webservice, endpoint}`. 0 when no in-scope targets. |
| `web_surface` | `engagement_detail` | `web_token_share` | Share intersecting `{web, website, webapp, webapplication}`; a target matching neither token set whose `location` parses as http(s) counts as web. 0 when no in-scope targets. |
| `researcher_competition` | `statistics` | `researchers_participating_saturation` | `n/(n+500)`, `n` = strict-parsed `statistics.researchers_participating`. `null` when absent/unparseable. |
| `rewarded_activity` | `statistics` | `vulnerabilities_rewarded_saturation` | `n/(n+200)`, `n` = strict-parsed `statistics.vulnerabilities_rewarded`. `null` when absent/unparseable. |
| `freshness` | `engagement_detail` | `age_band` | Newest valid of `lastBriefUpdate`/`lastStatusTransition`, aged in days vs `now`. Bands below; `null` when no valid date (or invalid `now`). |
| `safe_harbor` | `engagement_detail` | `safe_harbor_field` | `safeHarborLevel` field only: contains `full` → 1.0, `partial` → 0.5, `none`/`absent` → 0.0 (case-insensitive); anything else or missing → `null`. |
| `target_data_quality` | `derived` | `field_completeness_mix` | Mean of four parts: fraction of in-scope targets with non-empty `category`; fraction with usable location/name; 1 iff ≥1 in-scope group exists; fraction of in-scope groups carrying ≥1 non-null reward value (a recorded 0 counts). Empty denominators score 0. `null` only when zero in-scope targets AND zero in-scope groups. |
| `accessibility` | `derived` | `not_available_v1` | Always `null` in V1 — setup/account requirements need deep analysis. |
| `known_issue_density` | `derived` | `not_available_v1` | Always `null` in V1 — Known Issues are not fetched at catalog scale. |
| `authz_opportunity` | `derived` | `not_available_v1` | Always `null` in V1 — no deterministic source until deep analysis. |

### Normalization curves

**`normReward`** — piecewise-linear interpolation in `ln(1+amount)`:

| Amount | Value |
|---|---|
| ≤ 0 (incl. NaN) | 0 |
| $500 | 0.25 |
| $2,000 | 0.5 |
| $10,000 | 0.8 |
| ≥ $25,000 | 1.0 |

**Saturation** — `n/(n+k)` with fixed `k`: 25 (meaningful surface),
500 (researcher competition), 200 (rewarded activity).

**Freshness bands** — evaluated in order on age in days:

| Age | Value |
|---|---|
| ≤ 7 d | 1.0 |
| ≤ 30 d | 0.85 |
| ≤ 90 d | 0.60 |
| ≤ 180 d | 0.35 |
| older | 0.15 |
| no valid date | `null` |

**Tokenization** — `category`, `name`, and each `tag` are lowercased and
split on non-alphanumeric runs into a token set; membership is exact, never
substring (`capitol` ⊅ `api`, `restaurant` ⊅ `rest`). `location` is not
tokenized — it only feeds the http(s) web fallback.

**`parseStatValue`** — accepts plain digits, strict thousands grouping
(`1,234`, `1,234,567.89`), one optional leading `$`, and surrounding
whitespace. Rejects `1,23,4`, empty, negative-as-text, exponents, and
arbitrary text — never a bare `parseFloat`.

**Not consumed:** `statistics.average_payout` is captured in `source_hash`
(a change re-triggers scoring) but feeds no V1 signal — payout averages
are too noisy for a fixed curve.

## Scoring profiles

Six profiles, all version `1.0.0`; retuning requires a version bump.
Weights are **signed** — negative means *more is worse* (only
`researcher_competition` is ever negative). Signals absent from a profile
contribute nothing. `minConfidence` is the eligibility floor.

| Signal | `best_ev` | `low_competition` | `high_reward` | `authz_api` | `fresh_programs` | `easy_entry` |
|---|---|---|---|---|---|---|
| `reward_potential` | 3 | 1 | 4 | 1.5 | 0.5 | 1 |
| `reward_breadth` | 1 | — | 3 | — | — | 1.5 |
| `meaningful_surface` | 2 | 1.5 | — | 1.5 | 1 | 1 |
| `api_surface` | 1 | — | — | 4 | — | — |
| `web_surface` | 1 | — | — | — | — | — |
| `researcher_competition` | −1.5 | −3 | — | −0.5 | −1 | — |
| `rewarded_activity` | 1 | — | 1.5 | — | — | — |
| `freshness` | 1.5 | 2 | — | 1 | 5 | 1.5 |
| `safe_harbor` | 0.5 | — | — | 0.5 | — | 1 |
| `target_data_quality` | 0.5 | 0.5 | 0.5 | — | — | — |
| `accessibility` | — | — | — | — | — | 2 |
| `known_issue_density` | — | — | — | — | — | — |
| `authz_opportunity` | — | — | — | — | — | — |
| **Σ\|w\|** | **13** | **8** | **9** | **9** | **7.5** | **8** |
| **minConfidence** | **0.6** | **0.5** | **0.5** | **0.5** | **0.4** | **0.3** |

Intended reading: `best_ev` — balanced expected value; `low_competition` —
uncrowded programs (participation proxy, not duplicate probability);
`high_reward` — payout ceiling plus breadth plus proven payment activity;
`authz_api` — API-heavy / authenticated-research-friendly candidate;
`fresh_programs` — recency-dominated; `easy_entry` — onboarding, whose
`accessibility` weight is always unknown in V1, capping achievable
confidence at 6/8 = 0.75 by design.

## Score and confidence

```text
confidence = Σ|w_i| over known signals / Σ|w_i| over all profile weights
score      = clamp(Σ w_i·s_i / Σ|w_i| over known signals, 0, 1) × 100
```

- `confidence` is rounded to 4 decimals; `score` to 1 decimal.
- `score` is `null` when every weighted signal is unknown (known weight 0).
- The score is never multiplied by confidence — they are reported
  separately, and unknown signals are excluded from the denominator rather
  than coerced to 0 or 0.5.
- `components` carries one entry per profile-weighted key:
  `{signal, weight, contribution}` with `contribution = round4(w_i·s_i)` or
  `null`. `scoring_version` records the profile version; `source_hash`
  records the exact input scored.

## Unknown semantics

`null` means *unknown* — never zero, never false, never "bad program":

- A weighted-but-unknown signal contributes nothing to the score numerator
  or denominator; it only lowers `confidence`.
- Unknowns surface as `UNKNOWN_<KEY>` reason codes, appended after the
  threshold codes in the profile's declared weight order.
- `detail: null` → all detail-derived signals `null`
  (`detail_unavailable`); `accessibility`/`known_issue_density`/
  `authz_opportunity` stay `null` (`not_available_v1`) regardless.
- The UI renders unknown as `—`; it never prints 0.00 for `null`.

## Reason codes

Stable, template-rendered codes — one evaluator per signal, `null` when
the value sits between thresholds (silence is a valid answer):

| Signal | Condition | Code | Rendered |
|---|---|---|---|
| `reward_potential` | ≥ 0.8 | `REWARD_HIGH` | `+ strong P1/P2 reward` |
| | ≥ 0.5 | `REWARD_MEDIUM` | `+ moderate P1/P2 reward` |
| | < 0.5 | `REWARD_LOW` | `- low reward potential` |
| `reward_breadth` | ≥ 0.5 | `REWARD_BROAD` | `+ broad reward coverage` |
| `meaningful_surface` | ≥ 0.5 (c ≥ 25) | `SURFACE_LARGE` | `+ large in-scope surface` |
| `api_surface` | ≥ 0.4 | `API_SURFACE_HIGH` | `+ substantial API surface` |
| `web_surface` | ≥ 0.4 | `WEB_SURFACE_HIGH` | `+ substantial web surface` |
| `researcher_competition` | ≤ 0.3 (n ≤ 214) | `COMPETITION_LOW` | `+ low researcher competition` |
| | ≥ 0.7 (n ≥ 1167) | `COMPETITION_HIGH` | `- high researcher competition` |
| `rewarded_activity` | ≥ 0.5 (n ≥ 200) | `ACTIVITY_PROVEN` | `+ proven reward activity` |
| `freshness` | ≥ 0.85 | `RECENTLY_UPDATED` | `+ recently updated` |
| | ≤ 0.15 | `STALE_PROGRAM` | `- stale program` |
| `safe_harbor` | = 1 | `SAFE_HARBOR_PRESENT` | `+ safe harbor present` |
| | = 0.5 | `SAFE_HARBOR_PARTIAL` | `+ partial safe harbor` |
| | = 0 | `SAFE_HARBOR_ABSENT` | `- no safe harbor` |
| `target_data_quality` | ≤ 0.4 | `DATA_INCOMPLETE` | `- incomplete program data` |
| any weighted signal | value `null` | `UNKNOWN_<KEY>` | `? <key> unavailable` |

`explainScore` renders `+ ` for positives, `- ` for cautions
(`REWARD_LOW`, `COMPETITION_HIGH`, `STALE_PROGRAM`, `SAFE_HARBOR_ABSENT`,
`DATA_INCOMPLETE`), `? ` for unknowns — in the score's stored `reasons`
order. The three always-null signals emit no threshold codes, only
`UNKNOWN_*` when a profile weights them.

## Ranking rules

`rankPrograms` sorts a copy of the scores into a total order:

1. **Eligible first** — `score !== null && confidence ≥ profile.minConfidence`.
2. `score` descending (`null` treated as −1).
3. `confidence` descending.
4. `engagement_uuid` ascending — the tie-break that makes identical inputs
   always rank identically.

`getResults` returns the latest score row per engagement at the profile's
*current* version, joined with catalog identity and the vector's six
display signals; an optional `minConfidence` argument filters further, and
`limit` is clamped to 1–200 (default 50). Ineligible rows rank after all
eligible ones — dimmed in the UI, never hidden.

## Scan lifecycle and resume

Phases: `catalog` → `enriching` → `scoring` → `done` | `failed` |
`cancelled`. MV3 service workers may die mid-scan, so every phase
transition and every per-program step checkpoints the run record into the
`runs` store; `meta.latestRunId` points at the newest run.

- `start()` is idempotent — an active run (in memory or persisted) is
  adopted and continued, never duplicated.
- `resume()` at service-worker startup adopts the persisted active run.
  A persisted catalog is never re-enumerated; `pending_uuids` is the
  stored truth (a uuid leaves it only after its snapshot checkpoint
  lands). A wiped/partial catalog store triggers `catalog_store_incomplete`
  plus one re-enumeration rather than silently dropping work.
- Enrichment runs as a worker pool over a shared queue, concurrency 2
  (default; clamped to ≥1) — never `Promise.all` over the catalog. HTTP
  retries stay inside `apiRequest`; the coordinator adds none. A fatal
  hydration error stops the pool → `failed`; a cancel request → `cancelled`.
- Scoring recomputes all completed uuids × all six profiles on entry;
  `putScore` upserts by key, so re-scoring is idempotent.
- `RadarScanSummary` verdict on termination: `failed` when the run failed;
  otherwise `complete` iff `catalog_complete` AND `enrichment_failed === 0`;
  anything else is honestly `partial`. Warning details cap at 50 entries
  plus a `…and N more` overflow line.

## Persistence

Separate `bce-radar` IndexedDB (version 1) — never the exporter's `bce`
job tables:

| Store | Key path | Index | Row |
|---|---|---|---|
| `catalog` | `uuid` | — | `RadarCatalogItem` |
| `snapshots` | `[uuid, source_hash]` | `byUuid` | `{uuid, source_hash, stored_at, snapshot}` |
| `scores` | `[uuid, profile, scoring_version, source_hash]` | `byUuidProfile` | `{uuid, profile, scoring_version, source_hash, stored_at, score, vector?}` |
| `runs` | `run_id` | — | run record incl. checkpoint bookkeeping |
| `meta` | `key` | — | `{key, value}` — holds `latestRunId` |

`stored_at` is bookkeeping only — excluded from every hash. "Latest" means
max `stored_at`, ties broken on `source_hash`; write order is never
consulted. Score rows embed the feature vector so result queries render
per-signal columns without a vectors store. Only normalized radar objects
are persisted — never raw API bodies, tokens, or headers.

## Message surface

`RadarMsg` (lib/messages.ts) is a strict discriminated union — named ops
only, no url/headers/method/API-operation fields. Extension pages only:
any sender with `sender.tab` set is rejected (`forbidden`), the same rule
as the named API ops.

| Op | Fields | Returns |
|---|---|---|
| `RADAR_START_SCAN` | — | `{run}` — starts or adopts the active run |
| `RADAR_CANCEL_SCAN` | — | `{run}` — cancels whichever run is active |
| `RADAR_GET_STATE` | — | `{run}` — current run state or `null` |
| `RADAR_GET_RESULTS` | `profile` (enum), `limit` int 1–200 (default 50), `minConfidence` 0–1 optional | `{rows}` ranked result rows |
| `RADAR_GET_PROGRAM` | `uuid` (36-char hex-dash regex), `profile` optional (router defaults to `best_ev`) | `{program}` — snapshot, score, rendered explanation, catalog row |

## Limitations

- **`researcher_competition` is not duplicate probability.** It is a
  participation-count saturation (`n/(n+500)`) — a crowd proxy only. Real
  duplicate pressure requires Known Issues / deep analysis (V1.2).
- **`authz_api` is not proof of authorization vulnerabilities.** It ranks
  API-heavy, authenticated-research-friendly candidates. `authz_opportunity`
  is unweighted and always `null` in V1 — no deterministic source exists
  until deep program analysis lands.
- **`accessibility` may remain unknown.** Account/setup requirements are
  not derivable from cheap metadata; the signal stays `null`, which is why
  `easy_entry` can never exceed 0.75 confidence.
- **Known Issues are not in cheap scoring.** `known_issue_density` is
  always `null`; the exporter's per-program Known Issues pipeline does not
  run at catalog scale.
- **No AI participates in V1 ranking.** Collection, feature extraction,
  scoring, ranking, and reason text are deterministic code. AI analysis is
  a downstream consumer of the ranked shortlist, not an input to it.
- **`average_payout` is hashed but unscored** — captured in `source_hash`
  yet consumed by no V1 signal.
- **Scores are absolute, not relative.** Fixed curves only — no
  catalog-relative percentile; a score moves only when that program's
  inputs move.
- **Surface classifiers are token membership.** A target matching neither
  token set with a non-URL location counts toward neither `api_surface`
  nor `web_surface`; taxonomy drift in API metadata is not learned.
- **Statistics are self-reported API strings.** Missing, renamed, or
  unparseable statistics keys degrade to `null` signals, not zero.
- **Clamped floor.** The score is clamped to [0, 1] × 100 — a dominant
  negative weighted sum (e.g. extreme competition) displays as 0, never a
  negative number.
