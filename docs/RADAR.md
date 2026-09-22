# Engagement Radar

Deterministic program triage over the Bugcrowd engagement catalog. Radar
enumerates every engagement visible to the browser session, hydrates each
program's structured brief document, reduces it to a fixed 17-signal feature vector, and
ranks programs under six versioned weight profiles. No LLM participates in
collection, extraction, scoring, ranking, or explanation. The output is a
two-stage **Opportunity Score** — V1.3 runs a cheap metadata pass over the
whole catalog, then a bounded deep-enrichment pass (Known Issues aggregate
+ semantic changelog diff) over the top of the best_ev shortlist. Deep
signals stay `null` for programs that were never deep-analyzed — missing
data is never coerced into a favorable or unfavorable value. This is still
a candidate-pool ranking, not a true expected-value estimate; the signals
that would make it EV (duplicate probability, accessibility, real authz
opportunity) remain partially unsourced.

```text
GET /engagements.json?page=N    GET /engagements/<slug>/changelog.json
{paginationMeta.limit,              → version list → "Latest" id
 totalCount}, ≤100 pages            → GET …/changelog/<id>.json brief doc
                                    + GET …/statistics.json (non-fatal)
                                    + GET …/recently_joined_users.json
                                      (non-fatal — competition proxy)
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
               ProgramFeatureVector — 17 signals, 0..1 or null
                                    │
              scoreProgram × 6 profiles (lib/radar/profiles.ts,
              lib/radar/scoring.ts) — pure, deterministic
                                    │
                                    ▼
              ProgramScore {score, confidence, provisional,
                            components, reasons}
                                    │
              ┌─────────────────────┴──────────────────────┐
              │ V1.3 deep stage — Top-N best_ev shortlist  │
              │ (DEEP_ANALYSIS_LIMIT = 30, eligible only): │
              │   GET …/engagement_known_issues.json       │
              │   GET …/changelog.json  (re-fetch)         │
              │   GET …/changelog/<baseline>.json          │
              │     → hydrateRadarDeep (lib/radar/deep.ts) │
              │     → snapshot.deep + joined source_hash   │
              │     → re-score deep-completed uuids        │
              └─────────────────────┬──────────────────────┘
                                    ▼
                  IndexedDB `bce-radar` (lib/radar/store.ts)
                                    │
                                    ▼
              RADAR_* message ops → extension page (radar UI)
```

## Data sources

Radar reads the **researcher site surface**, not `api.bugcrowd.com` (the
organization/program-owner API — a researcher's catalog does not exist
there). All network access goes through `siteRequest`
(`lib/api/siteClient.ts`) — an allowlisted-GET client with the same
transport contract as the API client (rolling-window rate bucket, 429
`Retry-After`, bounded backoff, error payloads without request detail) but
**no stored credential**: requests carry `credentials: "include"` so the
browser's bugcrowd.com session cookies authenticate. A logged-out scan
still sees the public catalog; session-gated content degrades per item
instead of aborting the run.

| Input | Endpoint | Produces |
|---|---|---|
| Catalog | `GET /engagements.json?page=N` → `{engagements, paginationMeta{limit, totalCount}}` | `RadarCatalogItem` — uuid (the brief-URL slug), code (same slug), name, lifecycle_status (`accessStatus`), engagement_type (`productEngagementType.label`), discovered_at |
| Version list | `GET /engagements/{slug}/changelog.json` → `{changelogs[]}` | the `changelogState:"Latest"` entry's `id` (fallback: first entry — the list is newest-first) |
| Detail | `GET /engagements/{slug}/changelog/{version}.json` | `ApiEngagementData` via `lib/radar/detailMap.ts`: identity (`data.engagement.code`), `engagementTypeDetail.productLabel`, `statusLabel`, `data.engagement.startsAt`/`endsAt`, `lastTransitionAt`, `publishedAt` → `lastBriefUpdate`, `brief.safeHarborStatus.status`, scope groups (`inScope`, `rewardRange.pNMaxCents` — cents→dollars), targets (`uri`, `category`, `tags`) |
| Stats | `GET /engagements/{slug}/statistics.json` | `statistics` — `rewardedVulnerabilities` → `vulnerabilities_rewarded`, `averagePayout` → `average_payout`, `validationWithin`, `validSubmissionCount` → `valid_submission_count` (present in the schema but currently `null` on every observed program — consumed honestly when Bugcrowd populates it) |
| Joined | `GET /engagements/{slug}/recently_joined_users.json` | `statistics.researchers_participating` ← `total` (recent-joiner count — the recent-crowding proxy, NOT lifetime participation). Absent/`total` missing → key omitted, never invented. |
| Known Issues (deep only) | `GET /engagements/{slug}/engagement_known_issues.json` → `{"unique":int,"total":int}` — verified live | `deep.known_issues` — `total` includes duplicates of the `unique` accepted issues; both exclude out-of-scope and cover P1–P4 in Triaged/Unresolved/Informational. Non-2xx/parse failure → `unavailable`/`failed`, never zero. |
| Baseline brief (deep only) | `GET /engagements/{slug}/changelog/{prevId}.json` — every listed version id is fetchable with the identical document shape (verified live) | `deep.semantic_diff` — structured diff of the previous version vs the current detail (see Semantic diff below). The baseline is the entry immediately preceding `Latest` in the newest-first changelog list. |

The detail chain is pure JSON end-to-end — the brief's rendered page is a
client-side SPA shell whose markup carries no scope content, so nothing on
this path needs a DOM. `mapBriefDocument` throws `invalid_response` when the
document lacks `data.scope`; a statistics or joined-users failure degrades
to absent secondary data (the dependent signals read unknown) instead of
failing the hydration. `statistics.*` values arrive as numbers or display
strings and are consumed only through a strict parser. No credential
material exists on this path; nothing session-shaped reaches the radar
store, score rows, or message responses.

## Catalog completeness

`enumerateEngagementCatalog` pages `/engagements.json` from page 1:

| Condition | Status | Notes |
|---|---|---|
| Raw page < `paginationMeta.limit` rows (24 live), or cumulative rows reach `paginationMeta.totalCount` | `complete` | First short page is the last page. Fullness is measured on the raw row count — entries without a parseable `briefUrl` slug still count toward it. An empty first page is a legitimately empty catalog. |
| Page 100 returns full (`MAX_CATALOG_PAGES`) | `partial` | `page_limit_reached` warning. The cap is a safety bound, not an assumption — never reported `complete`. |
| `engagements` absent/non-array, or a non-object body, on a 200 page | `failed` (first page) / `partial` (after ≥1 clean page) | `malformed_page` warning — a malformed envelope (e.g. an HTML shell or login page answered where JSON was expected) is never a short page, so it can never report `complete`. Items from earlier clean pages are kept. |
| `ApiError` from the client | `failed` | Items collected so far are kept; a warning names the error kind verbatim (`rate_limited`, `unauthorized`, …) or `unknown` for a non-ApiError throw. A fetch redirected onto the login surface, a 401, or a non-JSON answer maps to `unauthorized`/`invalid_response` — truthful session failures, never a misleading `forbidden`. |

Dedupe is by slug (stored in the `uuid` field), first occurrence wins;
item order is first-seen page order, so enumeration is deterministic for
identical responses.

## Enrichment error classification

`hydrateRadarProgram` uses the catalog slug verbatim (never re-resolved)
and always returns a snapshot for program-scoped failures. The session
surface has **no credential-wide fatal class**: session cookies either ride
along or they don't, and a missing/expired session degrades only the items
that need it (private briefs redirect to login; the public catalog keeps
answering). Every `ApiError` is therefore program-scoped:

| Error | Resulting snapshot |
|---|---|
| `unauthorized` (login redirect / 401 — session absent for this brief), `forbidden`, `not_found` | `detail: null`, `enrichment.status: "unavailable"`, `error_kind` set |
| `invalid_response` (non-JSON answer, empty changelog list, malformed brief doc), `http`, `network`, `rate_limited` | `detail: null`, `enrichment.status: "failed"`, `error_kind` set |
| Non-`ApiError` throw | `detail: null`, `enrichment.status: "failed"`, `error_kind: "unknown"` |

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
`null`, the detail-derived signals are `null` with reason code
`detail_unavailable` — nothing is inferred from the catalog row — and
`accessibility`/`authz_opportunity` keep `not_available_v1`. The two deep
signals read `snapshot.deep`: absent/null deep data → `not_deep_analyzed`;
a sub-source status (`unavailable`, `failed`, `no_baseline`) surfaces as
`ki_<status>` / `diff_<status>`; only `status === "complete"` produces a
value.

### Signal definitions

| Signal | Source | Reason code | Derivation |
|---|---|---|---|
| `reward_potential` | `engagement_detail` | `reward_curve_p1_p2_p3` | Per tier p1/p2/p3: max reward over in-scope groups → `normReward`; blend 0.5·P1 + 0.3·P2 + 0.2·P3 renormalized over tiers present. `null` when no tier carries a finite value. |
| `reward_breadth` | `engagement_detail` | `reward_bearing_group_share` | Share of in-scope groups bearing ≥1 positive reward on p1..p5. `null` when zero in-scope groups. |
| `meaningful_surface` | `engagement_detail` | `in_scope_target_saturation` | `c/(c+25)` where `c` = in-scope targets with non-empty location or name. Always defined (0 targets → 0). |
| `api_surface` | `engagement_detail` | `api_token_share` | Share of in-scope targets whose token set intersects `{api, rest, graphql, grpc, webservice, endpoint}`. 0 when no in-scope targets. |
| `api_surface_size` | `engagement_detail` | `api_target_saturation` | `c/(c+10)` where `c` = in-scope API-token targets. The COUNT half of the API signal — a lone API target reads share 1.0 but size 0.09, so it can no longer fake breadth. 0 when no API targets. |
| `web_surface` | `engagement_detail` | `web_token_share` | Share intersecting `{web, website, webapp, webapplication}`; a target matching neither token set whose `location` parses as http(s) counts as web. 0 when no in-scope targets. |
| `researcher_competition` | `statistics` | `researchers_participating_saturation` | `n/(n+500)`, `n` = strict-parsed `statistics.researchers_participating` ← `recently_joined_users.total`. **Recent crowding** — joiners over a recent window, not lifetime participants and not a researcher count. `null` when the endpoint errors or exposes no `total` (managed/invitational briefs often don't). |
| `submission_activity` | `statistics` | `submission_count_saturation` | `n/(n+500)`, `n` = strict-parsed `statistics.valid_submission_count` — a count of valid submissions, NOT a count of researchers. `null` when absent/unparseable (currently always — see Limitations). |
| `research_saturation` | `derived` | `research_saturation_composite` / `insufficient_saturation_components` | Weighted mean over KNOWN components: `recent_crowding` 0.30 (the `researcher_competition` value), `submission_activity` 0.40, `rewarded_activity` 0.30. A missing component drops out of numerator AND denominator — never reads as 0. `null` when fewer than 2 components are known — one noisy metric must not pose as saturation truth. This is observed research attention, not duplicate probability. |
| `rewarded_activity` | `statistics` | `vulnerabilities_rewarded_saturation` | `n/(n+200)`, `n` = strict-parsed `statistics.vulnerabilities_rewarded` — rewarded report volume, NOT unique bugs by unique hunters. `null` when absent/unparseable. |
| `freshness` | `engagement_detail` | `age_band` | Newest valid of `lastBriefUpdate`/`lastStatusTransition`, aged in days vs `now`. Bands below; `null` when no valid date (or invalid `now`). |
| `safe_harbor` | `engagement_detail` | `safe_harbor_field` | `safeHarborLevel` field only: contains `full` → 1.0, `partial` → 0.5, `none`/`absent` → 0.0 (case-insensitive); anything else or missing → `null`. |
| `target_data_quality` | `derived` | `field_completeness_mix` | Mean of four parts: fraction of in-scope targets with non-empty `category`; fraction with usable location/name; 1 iff ≥1 in-scope group exists; fraction of in-scope groups carrying ≥1 non-null reward value (a recorded 0 counts). Empty denominators score 0. `null` only when zero in-scope targets AND zero in-scope groups. |
| `accessibility` | `derived` | `not_available_v1` | Always `null` in V1 — setup/account requirements need deep analysis. |
| `known_issue_density` | `deep_enrichment` | `not_deep_analyzed` / `ki_<status>` / `ki_density` | **Duplicate-pressure proxy** (V1.3): `0.5·(u/(u+50)) + 0.5·(d/(d+5))` where `u` = `unique_count` and `d = u / meaningfulTargetCount` (in-scope targets with usable identity; absent/degenerate surface → volume term only). Monotone nondecreasing in `u`; `u=0` → a real `0`. `null` unless `deep.known_issues.status === "complete"` — missing Known Issues never read as "no issues". NOT a duplicate-probability estimate: `total_count` (which embeds dup share) is captured for display but deliberately excluded from the signal. |
| `opportunity_change` | `deep_enrichment` | `not_deep_analyzed` / `diff_<status>` / `opportunity_score` | **Semantic opportunity gained in the latest publish** (V1.3): `min(1, 0.35·ai/(ai+3) + 0.30·api/(api+2) + 0.10·ag/(ag+1) + 0.15·[reward_increase] + 0.10·mi/(mi+2))` over the diff facts (ai = added in-scope targets, api = added API targets, ag = added groups, mi = moved in-scope). `only_administrative_changes` → a real `0` — a wording edit scores nothing, which is the entire point versus `freshness`. `null` unless `deep.semantic_diff.status === "complete"`. |
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
500 (recent crowding), 500 (submission activity), 200 (rewarded
activity), 10 (API target count).

**Research saturation composite** — `Σ w_i·c_i / Σ w_i` over known
components only, weights `recent_crowding 0.30 / submission_activity
0.40 / rewarded_activity 0.30` (pinned V1.2 calibration). Fewer than 2
known components → `null`. `known_issue_density` is deliberately NOT a
component: the composite stays metadata-only so catalog-wide programs
(never deep-analyzed) remain comparable, and a deep-analyzed program pays
the duplicate-pressure cost exactly once — as a profile weight.

**Semantic diff (V1.3)** — `diffBriefDocuments(prev, curr)` over MAPPED
`ApiEngagementData`: targets match by `id` (fallback composite
`location|name|category`), groups by `id` (fallback `name`). Facts:
added/removed targets (overall and in-scope), `moved_in_scope`/
`moved_out_of_scope` (same key, flipped `inScope` — covers both a group
flip and a relist under another group), `added_api_targets`/
`added_web_targets` (the same token sets as `api_surface`/`web_surface`),
`added_groups`, `reward_increase`/`reward_decrease` (shared in-scope
groups only; null→x and x→null are data gaps, not raises/cuts),
`safe_harbor_changed`, `status_changed`, `only_administrative_changes`.
`prev === null` → `no_baseline` with every fact null. Reductions score
zero opportunity — the signal measures opportunity gained, never
penalizes shrinkage.

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

Six profiles; the four touched by the V1.3 deep signals are version
`1.3.0`, the untouched two keep `1.1.0` — a version asserts the semantics,
not a release train. Retuning requires a version bump.
Weight semantics: every weight is **non-negative** and carries a
`direction` — `benefit` (default; bare-number shorthand) contributes
`w·s`, `cost` contributes `w·(1−s)`. Signals absent from a profile
contribute nothing. `required_any` declares groups of alternative signals
the profile considers essential: a score is `provisional` when every
alternative in a group is null. `minConfidence` is the eligibility floor.

| Signal | `best_ev` 1.3.0 | `low_competition` 1.3.0 | `high_reward` 1.1.0 | `authz_api` 1.3.0 | `fresh_programs` 1.3.0 | `easy_entry` 1.1.0 |
|---|---|---|---|---|---|---|
| `reward_potential` | 3 | 1 | 4 | 1.5 | 0.5 | 1 |
| `reward_breadth` | 1 | — | 3 | — | — | 1.5 |
| `meaningful_surface` | 2 | 1.5 | — | 1.5 | 1 | 1 |
| `api_surface` (share) | 1 | — | — | 1.5 | — | — |
| `api_surface_size` | — | — | — | 3 | — | — |
| `web_surface` | 1 | — | — | — | — | — |
| `research_saturation` | 1.5 cost | 3 cost | — | 0.5 cost | 1 cost | — |
| `researcher_competition` | — | — | — | — | — | — |
| `rewarded_activity` | 1 | — | 1.5 | — | — | — |
| `freshness` | 0.5 | 1.5 | — | 1 | 2.5 | 1.5 |
| `safe_harbor` | 0.5 | — | — | 0.5 | — | 1 |
| `target_data_quality` | 0.5 | 0.5 | 0.5 | — | — | — |
| `accessibility` | — | — | — | — | — | 2 |
| `known_issue_density` | 1 cost | 2 cost | — | — | — | — |
| `opportunity_change` | 1.25 | 1 | — | 0.75 | 3 | — |
| `authz_opportunity` | — | — | — | — | — | — |
| **Σw** | **14.25** | **10.5** | **9** | **10.25** | **8** | **8** |
| **required_any** | `saturation` ∨ `competition` ∨ `known_issue` | `saturation` ∨ `competition` ∨ `known_issue` | `reward_potential` | `api_surface` ∨ `api_size` | `freshness` ∨ `opportunity` | `accessibility` |
| **minConfidence** | **0.6** | **0.5** | **0.5** | **0.5** | **0.4** | **0.3** |

No profile weights `research_saturation` AND its constituent
`researcher_competition` — the composite replaced the raw crowding signal
in the score so crowding evidence is never double-counted. The raw signal
survives only as a `required_any` fallback (a composite with < 2 known
components is null, but crowding alone still proves the group has data).
`known_issue_density` likewise never enters the composite: it is a second,
independent duplicate-pressure read priced as its own profile weight — a
deep-analyzed program pays the cost once, and a metadata-only program is
never penalized for lacking a fetch that never ran.

Intended reading: `best_ev` — balanced opportunity;
`low_competition` (labelled **Low Saturation**) — unsaturated programs by
observed attention AND known-issue pressure, not duplicate probability;
`high_reward` — payout ceiling plus breadth plus proven payment activity;
`authz_api` — API-heavy candidate, measuring share AND size so a lone API
target cannot fake breadth, plus a small semantic-expansion bonus;
`fresh_programs` (labelled **Fresh Opportunity**) — opportunity-dominated,
where `opportunity_change` out-weights raw recency so a text-only publish
can never read as fresh surface; `easy_entry` — onboarding, whose
`accessibility` weight is always unknown in V1, capping achievable
coverage at 6/8 = 0.75 and rendering every score provisional by design.

`freshness` carries a deliberately small `best_ev` weight (0.5): it
measures brief/status recency, not new opportunity — wording fixes and
administrative edits also refresh it. `opportunity_change` is now the
recency-shaped input with real EV weight: it is null for non-deep-analyzed
programs and 0 for text-only diffs, so administrative churn can no longer
masquerade as new hunting surface.

## Score and data coverage

```text
eff_i     = s_i (benefit)  or  1 − s_i (cost)
coverage  = Σw_i over known signals / Σw_i over all profile weights
score     = clamp(Σ w_i·eff_i / Σw_i over known signals, 0, 1) × 100
```

- `confidence` (stored field name) is the **data-coverage** fraction —
  rendered "Coverage" in the UI. It is NOT statistical confidence in the
  score. Rounded to 4 decimals; `score` to 1 decimal.
- `score` is `null` when every weighted signal is unknown (known weight 0).
- The score is never multiplied by coverage — they are reported
  separately, and unknown signals are excluded from the denominator rather
  than coerced to 0 or 0.5.
- **Unknown can never beat known-perfect.** With only positive weights and
  `eff ∈ [0,1]`, a null signal's score sits at the score-its-known-inputs-
  imply bound — at most tied with a provably perfect value, then losing
  the rank tie-break on coverage. V1.0's signed weights violated this: a
  null cost signal dropped its |w| from the denominator, scoring *higher*
  than a known-perfect competitor.
- `provisional` is true when a `required_any` group is entirely unknown —
  the score still reports and ranks, but the UI flags it (score cell
  suffix + amber styling) so incomplete data can never masquerade as a
  final verdict.
- `components` carries one entry per profile-weighted key:
  `{signal, weight, direction, contribution}` with
  `contribution = round4(w_i·eff_i)` or `null`. `scoring_version` records
  the profile version; `source_hash` records the exact input scored.

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
| `api_surface_size` | ≥ 0.5 (c ≥ 10) | `API_SURFACE_LARGE` | `+ large API target count` |
| `web_surface` | ≥ 0.4 | `WEB_SURFACE_HIGH` | `+ substantial web surface` |
| `researcher_competition` | ≤ 0.3 (n ≤ 214) | `COMPETITION_LOW` | `+ low recent crowding` |
| | ≥ 0.7 (n ≥ 1167) | `COMPETITION_HIGH` | `- high recent crowding` |
| `submission_activity` | ≤ 0.25 (n ≤ 167) | `SUBMISSION_ACTIVITY_LOW` | `+ low submission volume` |
| | ≥ 0.7 (n ≥ 1167) | `SUBMISSION_ACTIVITY_HIGH` | `- high submission volume` |
| `research_saturation` | ≤ 0.25 | `SATURATION_LOW` | `+ low observed research saturation` |
| | ≥ 0.7 | `SATURATION_HIGH` | `- high observed research saturation` |
| `rewarded_activity` | ≥ 0.5 (n ≥ 200) | `ACTIVITY_PROVEN` | `+ proven reward activity` |
| `freshness` | ≥ 0.85 | `RECENTLY_UPDATED` | `+ recently updated` |
| | ≤ 0.15 | `STALE_PROGRAM` | `- stale program` |
| `safe_harbor` | = 1 | `SAFE_HARBOR_PRESENT` | `+ safe harbor present` |
| | = 0.5 | `SAFE_HARBOR_PARTIAL` | `+ partial safe harbor` |
| | = 0 | `SAFE_HARBOR_ABSENT` | `- no safe harbor` |
| `target_data_quality` | ≤ 0.4 | `DATA_INCOMPLETE` | `- incomplete program data` |
| `known_issue_density` | ≤ 0.25 | `KI_PRESSURE_LOW` | `+ low known-issue pressure` |
| | ≥ 0.7 | `KI_PRESSURE_HIGH` | `- high known-issue pressure` |
| `opportunity_change` | ≥ 0.5 | `OPPORTUNITY_EXPANDED` | `+ scope expanded in latest diff` |
| | ≤ 0.1 | `OPPORTUNITY_TEXT_ONLY` | `- no scope growth in latest diff` |
| any weighted signal | value `null` | `UNKNOWN_<KEY>` | `? <key> unavailable` |

`explainScore` renders `+ ` for positives, `- ` for cautions
(`REWARD_LOW`, `COMPETITION_HIGH`, `STALE_PROGRAM`, `SAFE_HARBOR_ABSENT`,
`DATA_INCOMPLETE`, `SUBMISSION_ACTIVITY_HIGH`, `SATURATION_HIGH`,
`KI_PRESSURE_HIGH`, `OPPORTUNITY_TEXT_ONLY`),
`? ` for unknowns — in the score's stored `reasons`
order. The always-null signals emit no threshold codes, only
`UNKNOWN_*` when a profile weights them.

## Ranking rules

`rankPrograms` sorts a copy of the scores into a total order:

1. **Eligible first** — `score !== null && confidence ≥ profile.minConfidence`.
2. `score` descending (`null` treated as −1).
3. `confidence` descending.
4. `engagement_uuid` ascending — the tie-break that makes identical inputs
   always rank identically.

`getResults` returns the latest score row per engagement at the profile's
*current* version, **scoped to the discovered set of the run
`meta.latestRunId` points at** — its `completed_uuids ∪ pending_uuids` —
joined with catalog identity and the vector's eight display signals
(reward, surface trio, **research saturation**, freshness,
known-issue density, opportunity change); an
optional `minConfidence` argument filters further, and `limit` is clamped
to 1–200 (default 50). Ineligible rows rank after all eligible ones —
dimmed in the UI, never hidden.

Result scoping is staleness-honest but non-destructive:

- A program absent from the latest run's discovery stops ranking and
  `getProgram` returns `null` for it — yet its catalog/snapshot/score rows
  remain cached, so a later run that re-encounters it reuses them (same
  `source_hash` → same score). Radar never deletes cache rows to make
  results look fresh.
- A latest run that discovered zero programs (e.g. a failed catalog phase
  before any uuid was found) yields zero results, and no latest run at all
  yields empty results / `null` programs — never rows from older runs.

## Scan lifecycle and resume

Phases: `catalog` → `enriching` → `scoring` → `deep_enriching` →
`deep_scoring` → `done` | `failed` | `cancelled`. The deep phases run only
when a `deepHydrate` dependency is wired and the shortlist is non-empty;
otherwise the run ends after `scoring` exactly as before (pre-V1.3
persisted runs resume cleanly). MV3 service workers may die mid-scan, so
every phase transition and every per-program step checkpoints the run
record into the `runs` store; `meta.latestRunId` points at the newest run.

The deep stage (V1.3): after metadata scoring, the top
`DEEP_ANALYSIS_LIMIT` (30) *eligible* `best_ev` rows of THIS run become
`deep_pending_uuids`. The same worker-pool discipline fetches
`engagement_known_issues.json` + re-reads `changelog.json` + fetches the
baseline `changelog/<id>.json` — **3 requests per shortlisted program** —
writes a NEW snapshot whose `deep` payload joins `source_hash`, then
`deep_scoring` re-scores only `deep_completed_uuids` through the identical
deterministic path. A program without a metadata detail is completed
without enrichment; deep signals are never fabricated.

- `start()` is idempotent — an active run (in memory or persisted) is
  adopted and continued, never duplicated.
- `resume()` at service-worker startup adopts the persisted active run.
  A persisted catalog is never re-enumerated; `pending_uuids` is the
  stored truth (a uuid leaves it only after its snapshot checkpoint
  lands). A wiped/partial catalog store triggers `catalog_store_incomplete`
  plus one re-enumeration rather than silently dropping work.
- Enrichment runs as a worker pool over a shared queue, concurrency 2
  (default; clamped to ≥1) — never `Promise.all` over the catalog. HTTP
  retries stay inside `siteRequest`; the coordinator adds none. There is no
  fatal hydration class on the session surface — a cancel request →
  `cancelled`.
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
content-script senders are rejected (`forbidden`). `sender.tab` alone is
NOT a content-script marker — Chrome also sets it for extension pages
hosted in tabs (the radar page itself is one), so the router checks the
sender's document URL against the extension origin instead.

| Op | Fields | Returns |
|---|---|---|
| `RADAR_START_SCAN` | — | `{run}` — starts or adopts the active run |
| `RADAR_CANCEL_SCAN` | — | `{run}` — cancels whichever run is active |
| `RADAR_GET_STATE` | — | `{run}` — current run state or `null` |
| `RADAR_GET_RESULTS` | `profile` (enum), `limit` int 1–200 (default 50), `minConfidence` 0–1 optional | `{rows}` ranked result rows |
| `RADAR_GET_PROGRAM` | `uuid` (the engagement's slug — `[A-Za-z0-9_-]{1,100}`), `profile` optional (router defaults to `best_ev`) | `{program}` — snapshot, score, rendered explanation, catalog row |

## Limitations

- **This is a Metadata Opportunity Score plus a bounded deep pass, not
  expected value.** The ranked list is a candidate pool for deeper human
  analysis. V1.3 sources `known_issue_density` and `opportunity_change`
  for the deep-analyzed shortlist only; `accessibility` and
  `authz_opportunity` remain unsourced, and no signal estimates duplicate
  probability or guarantees undiscovered bugs.
- **`research_saturation` is not duplicate probability.** It is a
  metadata heuristic for *observed research attention*: a fixed-weight
  composite of recent crowding, valid-submission volume, and rewarded
  report volume. A high value says the program looks well-worked; it does
  not prove bugs are gone, and a low value does not prove any remain.
- **`researcher_competition` is recent crowding, not participation.** It
  saturates `recently_joined_users.total` (`n/(n+500)`) — joiners over a
  recent window, not lifetime unique researchers. Programs that don't
  expose a joiner total (managed/invitational briefs) read `null`; the
  composite may still form from its other components, and a fully-empty
  `required_any` group flags the score provisional.
- **`validSubmissionCount` currently reads null on the live site.** The
  field exists in `statistics.json` schema but every program observed
  ships it `null`, so `submission_activity` is honestly unknown until
  Bugcrowd populates it — the composite then forms from the remaining two
  components, or stays `null` itself when they too are missing.
- **`freshness` is brief recency, not opportunity change.** A wording
  fix, contact update, or administrative edit refreshes it exactly like a
  scope expansion — that is why `opportunity_change` now out-weights it in
  every profile where opportunity matters.
- **`authz_api` is not proof of authorization vulnerabilities.** It ranks
  API-heavy candidates by share and target count. `authz_opportunity`
  is unweighted and always `null` in V1 — no deterministic source exists
  until deep program analysis lands.
- **The API classifier under-detects.** Token membership covers
  `api/rest/graphql/grpc/webservice/endpoint`, but URL shapes like
  `api.example.com`, `/api/v1/`, `/graphiql` on generic-category targets
  are not yet parsed. Both `api_surface` and `api_surface_size` inherit
  the gap.
- **`accessibility` may remain unknown.** Account/setup requirements are
  not derivable from cheap metadata; the signal stays `null`, which is why
  `easy_entry` can never exceed 0.75 coverage and always scores
  provisional.
- **Known Issues are deep-stage only.** `engagement_known_issues.json`
  is fetched for the ≤30-program shortlist, never catalog-wide (~1 extra
  request per shortlisted program — verified `{"unique","total"}` shape).
  `known_issue_density` is a duplicate-PRESSURE proxy over `unique`
  counts blended with per-target density; it is not a duplicate
  probability, and a program whose fetch fails reads `null`, never 0.
- **Semantic diff covers the latest publish only.** The baseline is the
  single predecessor of `Latest`; multi-version arcs (gradual scope creep
  over five publishes) are not accumulated, and per-target Known Issues
  (`target_groups/<gid>/known_issue_stats`, verified live) are not yet
  consumed.
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
- **Clamped floor.** The score is clamped to [0, 1] × 100 — a genuinely
  weak signal mix displays as 0, never a negative number.
