# Engagement Radar

Deterministic program triage over the Bugcrowd engagement catalog. Radar
enumerates every engagement visible to the browser session, hydrates each
program's structured brief document, reduces it to a fixed 20-signal feature vector, and
ranks programs under six versioned weight profiles. No LLM participates in
collection, extraction, scoring, ranking, or explanation. The output is a
two-stage **Opportunity Score** — a cheap metadata pass over the
whole catalog, then a bounded deep-enrichment pass (Known Issues aggregate
+ semantic changelog diff + multi-publish scope arc + gated per-group
Known Issues stats) over a **profile-aware candidate union**
(V1.3.1): every profile whose weights consume deep signals contributes its
own metadata Top-N to the shortlist, and an iterative frontier check keeps
deepening until each deep profile's Top-K window is fully analyzed or the
bounded budget runs out. Metadata and deep scores are stored as separate
evidence stages and ranked separately — a metadata-only row never shares
an ordinal rank with a deep-analyzed one. Deep signals stay `null` for
programs that were never deep-analyzed — missing data is never coerced
into a favorable or unfavorable value. This is still a candidate-pool
ranking, not a true expected-value estimate: `accessibility` and
`authz_opportunity` are now sourced (V1.4), but as deterministic rubrics
over stated posture and policy text — not guarantees — and no signal
estimates duplicate probability.

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
               ProgramFeatureVector — 20 signals, 0..1 or null
                                    │
              scoreProgram × 6 profiles (lib/radar/profiles.ts,
              lib/radar/scoring.ts) — pure, deterministic
                                    │
                                    ▼
              ProgramScore {score, confidence, provisional,
                            components, reasons}
                                    │
              ┌─────────────────────┴──────────────────────┐
              │ V1.3.1 deep stage — per-profile candidate  │
              │ union (Top 20 metadata ranks of every deep │
              │ profile, deduped, ≤ MAX_DEEP_PROGRAMS 60): │
              │   GET …/engagement_known_issues.json       │
              │   GET …/changelog.json  (re-fetch, shared) │
              │   GET …/changelog/<step-baseline>.json     │
              │   GET …/changelog/<arc-baseline>.json      │
              │     (deduped when both baselines coincide) │
              │   GET …/target_groups/<gid>/               │
              │     known_issue_stats × ≤6  (gated)        │
              │     → hydrateRadarDeep (lib/radar/deep.ts) │
              │     → snapshot.deep + joined source_hash   │
              │     → deep-stage re-score (deep profiles)  │
              │     → frontier check → next batch until    │
              │       Top-K+10 window all-deep / budget    │
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
| Detail | `GET /engagements/{slug}/changelog/{version}.json` | `ApiEngagementData` via `lib/radar/detailMap.ts`: identity (`data.engagement.code`), `engagementTypeDetail.productLabel`, `statusLabel`, `data.engagement.startsAt`/`endsAt`, `lastTransitionAt`, `publishedAt` → `lastBriefUpdate`, `brief.safeHarborStatus.status`, scope groups (`inScope`, `rewardRange.pNMaxCents` — cents→dollars), targets (`uri`, `category`, `tags`), and the V1.4 brief facts — `engagementConfiguration.participation` (fallback: root `participation`) → `participation`, a non-empty `credentialsUrl` → `credentialsProvided`, and `brief.description` + `brief.targetsOverview` → `briefText` (tag-stripped, entity-decoded plaintext via `lib/radar/briefText.ts`; `null` when both are absent) |
| Stats | `GET /engagements/{slug}/statistics.json` | `statistics` — `rewardedVulnerabilities` → `vulnerabilities_rewarded`, `averagePayout` → `average_payout`, `validationWithin`, `validSubmissionCount` → `valid_submission_count` (present in the schema but currently `null` on every observed program — consumed honestly when Bugcrowd populates it) |
| Joined | `GET /engagements/{slug}/recently_joined_users.json` | `statistics.researchers_participating` ← `total` (recent-joiner count — the recent-crowding proxy, NOT lifetime participation). Absent/`total` missing → key omitted, never invented. |
| Known Issues (deep only) | `GET /engagements/{slug}/engagement_known_issues.json` → `{"unique":int,"total":int}` — verified live | `deep.known_issues` — `total` includes duplicates of the `unique` accepted issues; both exclude out-of-scope and cover P1–P4 in Triaged/Unresolved/Informational. Non-2xx/parse failure → `unavailable`/`failed`, never zero. |
| Baseline brief (deep only) | `GET /engagements/{slug}/changelog/{prevId}.json` — every listed version id is fetchable with the identical document shape (verified live) | `deep.semantic_diff` — structured diff of the previous version vs the current detail (see Semantic diff below). The baseline is the entry immediately preceding `Latest` in the newest-first changelog list. |
| Arc baseline brief (deep only) | same endpoint, version `SCOPE_ARC_DEPTH` (5) publishes back, clamped to the oldest entry | `deep.scope_arc` — the multi-publish diff behind `scope_momentum`; when the arc baseline coincides with the step baseline the already-fetched document is reused (no second request). |
| Per-group KI stats (deep only, gated) | `GET /engagements/{slug}/target_groups/{groupId}/known_issue_stats` → `[{id, knownIssues:{stats:[{name, uniqueCount, duplicateCount}]}}]` — verified live | `deep.known_issues.group_stats` + `deep.known_issues.categories` — per-VRT-category aggregates feeding `ki_concentration`. Runs only when the aggregate completed with `unique ≥ KI_GROUP_MIN_UNIQUE` (10) and 1..`KI_GROUP_MAX_GROUPS` (6) qualifying in-scope groups — all-or-nothing, never a partial sample. |

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
`detail_unavailable` — nothing is inferred from the catalog row. The V1.4
signals keep that honesty on the same path: `accessibility` and
`authz_opportunity` emit `null` under the surviving stub label
`not_available_v1` (the sourced rubrics are never reached, so
`catalog.lifecycle_status` cannot leak in). The four deep
signals read `snapshot.deep`: absent/null deep data → `not_deep_analyzed`;
a sub-source status (`unavailable`, `failed`, `no_baseline`, the
group-stats `skipped_*`/`failed` states) surfaces as
`ki_<status>` / `diff_<status>` / `arc_<status>` / `ki_groups_<status>`
(`ki_groups_absent` when the sub-block is missing entirely — pre-V1.5
payloads); only `status === "complete"` produces a value.

### Signal definitions

| Signal | Source | Reason code | Derivation |
|---|---|---|---|
| `reward_potential` | `engagement_detail` | `reward_curve_p1_p2_p3` | Per tier p1/p2/p3: max reward over in-scope groups → `normReward`; blend 0.5·P1 + 0.3·P2 + 0.2·P3 renormalized over tiers present. `null` when no tier carries a finite value. |
| `reward_breadth` | `engagement_detail` | `reward_bearing_group_share` | Share of in-scope groups bearing ≥1 positive reward on p1..p5. `null` when zero in-scope groups. |
| `meaningful_surface` | `engagement_detail` | `in_scope_target_saturation` | `c/(c+25)` where `c` = in-scope targets with non-empty location or name. Always defined (0 targets → 0). |
| `api_surface` | `engagement_detail` | `api_token_share` | Share of in-scope targets whose token set intersects `{api, rest, graphql, grpc, webservice, endpoint}` OR whose `location` is an api-shaped http(s) URL (V1.4 `locationLooksApi`: a hostname token in `{api, apis, graphql, grpc, gateway, rest, rpc, ws, webservice, service}`, or a FIRST path segment in `{api, graphql, graphiql, rest, rpc, webservice, service, services}` — percent-decoded and lowercased in V1.5 (`/API`, `/%61pi` classify like `/api`; malformed escapes fall back to the raw segment) — bare `/v\d+/` and deeper-than-segment-1 tokens do not count). 0 when no in-scope targets. |
| `api_surface_size` | `engagement_detail` | `api_target_saturation` | `c/(c+10)` where `c` = in-scope API-classified targets (token OR URL shape). The COUNT half of the API signal — a lone API target reads share 1.0 but size 0.09, so it can no longer fake breadth. 0 when no API targets. |
| `web_surface` | `engagement_detail` | `web_token_share` | Share intersecting `{web, website, webapp, webapplication}`; a target matching neither token set whose `location` parses as http(s) counts as web — unless it is api-shaped, in which case it counted as api and the fallback never fires. 0 when no in-scope targets. |
| `researcher_competition` | `statistics` | `researchers_participating_saturation` | `n/(n+500)`, `n` = strict-parsed `statistics.researchers_participating` ← `recently_joined_users.total`. **Recent crowding** — joiners over a recent window, not lifetime participants and not a researcher count. `null` when the endpoint errors or exposes no `total` (managed/invitational briefs often don't). |
| `submission_activity` | `statistics` | `submission_count_saturation` | `n/(n+500)`, `n` = strict-parsed `statistics.valid_submission_count` — a count of valid submissions, NOT a count of researchers. `null` when absent/unparseable (currently always — see Limitations). |
| `research_saturation` | `derived` | `research_saturation_composite` / `insufficient_saturation_components` | Weighted mean over KNOWN components: `recent_crowding` 0.30 (the `researcher_competition` value), `submission_activity` 0.40, `rewarded_activity` 0.30. A missing component drops out of numerator AND denominator — never reads as 0. `null` when fewer than 2 components are known — one noisy metric must not pose as saturation truth. This is observed research attention, not duplicate probability. |
| `rewarded_activity` | `statistics` | `vulnerabilities_rewarded_saturation` | `n/(n+200)`, `n` = strict-parsed `statistics.vulnerabilities_rewarded` — rewarded report volume, NOT unique bugs by unique hunters. `null` when absent/unparseable. |
| `freshness` | `engagement_detail` | `age_band` | Newest valid of `lastBriefUpdate`/`lastStatusTransition`, aged in days vs `now`. Bands below; `null` when no valid date (or invalid `now`). |
| `safe_harbor` | `engagement_detail` | `safe_harbor_field` | `safeHarborLevel` field only: contains `full` → 1.0, `partial` → 0.5, `none`/`absent` → 0.0 (case-insensitive); anything else or missing → `null`. |
| `target_data_quality` | `derived` | `field_completeness_mix` | Mean of four parts: fraction of in-scope targets with non-empty `category`; fraction with usable location/name; 1 iff ≥1 in-scope group exists; fraction of in-scope groups carrying ≥1 non-null reward value (a recorded 0 counts). Empty denominators score 0. `null` only when zero in-scope targets AND zero in-scope groups. |
| `accessibility` | `engagement_detail` | `no_access_evidence` / `participation_access_rubric` | **Entry-friction rubric** (V1.4, `lib/radar/accessibility.ts`). Base band over `(detail.participation ?? catalog.lifecycle_status ?? "")` lowercased: contains `open` → 0.8; matches the gated family (`invite`/`application`/`approval`/`waitlist`/`private`/`managed`/`closed`) → 0.2; any other non-empty posture → 0.5; empty → `null`. The `??` order is pinned: `detail.participation` wins outright and an empty string suppresses the catalog fallback. Modifiers over the base: +0.10 for a signup marker in `briefText` (`@bugcrowdninja`, `sign up`, `self-serve`, `create/register … account(s)`), +0.10 for `credentialsProvided === true` (the brief ships a `credentialsUrl`), −0.20 for a friction marker in `briefText` (VPN, IP whitelist, NDA, identity verification, background check, citizenship); result clamped to 0..1. A rubric over stated posture, not a guarantee of access. |
| `known_issue_density` | `deep_enrichment` | `not_deep_analyzed` / `ki_<status>` / `ki_density` | **Duplicate-pressure proxy** (V1.3): `0.5·(u/(u+50)) + 0.5·(d/(d+5))` where `u` = `unique_count` and `d = u / meaningfulTargetCount` (in-scope targets with usable identity; absent/degenerate surface → volume term only). Monotone nondecreasing in `u`; `u=0` → a real `0`. `null` unless `deep.known_issues.status === "complete"` — missing Known Issues never read as "no issues". NOT a duplicate-probability estimate: `total_count` (which embeds dup share) is captured for display but deliberately excluded from the signal. |
| `opportunity_change` | `deep_enrichment` | `not_deep_analyzed` / `diff_<status>` / `opportunity_score` | **Semantic opportunity gained in the latest publish** (V1.3): `min(1, 0.35·ai/(ai+3) + 0.30·api/(api+2) + 0.10·ag/(ag+1) + 0.15·[reward_increase] + 0.10·mi/(mi+2))` over the diff facts (ai = added in-scope targets, api = added API targets, ag = added groups, mi = moved in-scope). `only_administrative_changes` → a real `0` — a wording edit scores nothing, which is the entire point versus `freshness`. `null` unless `deep.semantic_diff.status === "complete"`. |
| `authz_opportunity` | `engagement_detail` | `no_authz_evidence` / `authz_surface_rubric` | **Authz test-surface rubric** (V1.4, `lib/radar/authz.ts`). Two halves from the brief: `accountSurface` = 1 iff `credentialsProvided === true` or a signup marker (same regex as `accessibility`, deliberately a separate copy) appears in `briefText`; `permScore` = the most conservative `statusOfSentence` (`lib/model/policyText.ts`) over sentences naming an authz-relevant technique (`multi-account`, `cross-account-testing`, `other-customer-data`, `cross-tenant`): prohibited → 0, conditional → 0.5, allowed → 1, no normative predicate → not counted. `accountSurface === 0` and no authz-policy sentence → `null`. A prohibition reads a flat **0.1** — a LOW reading, never "no opportunity" and never blended upward by surface evidence. Otherwise `round4(clamp01(0.5·accountSurface + 0.5·(permScore ?? 0.35)))`. Submission-framed exclusions ("IDOR reports will be closed as not applicable") carry no testing predicate and count for nothing. This is a policy-text proxy — what the brief permits or forbids — not proof of an exploitable authz surface. |
| `payout_realized` | `statistics` | `average_payout_curve` | **Realized average payout** (V1.5): `normReward(strict-parsed statistics.average_payout)` — the measured counterpart to `reward_potential`'s advertised ceiling. `$2,000` → 0.5, `$25,000` → 1.0; the stat's `window` is ignored (any window's average is payment evidence). A parsed `$0` is a REAL `0`, not unknown. `null` when absent, malformed, or negative-as-text. |
| `scope_momentum` | `deep_enrichment` | `not_deep_analyzed` / `arc_<status>` / `arc_momentum` | **Multi-publish scope growth** (V1.5): `min(1, 0.35·ai/(ai+8) + 0.25·api/(api+4) + 0.10·ag/(ag+2) + 0.15·[reward_increase] + 0.15·mi/(mi+4))` over the ARC diff — same fact names as `opportunity_change` with window-scaled half-saturations (a 5-publish window accumulates more, so each term saturates slower). Growth-only: reductions contribute nothing; `only_administrative_changes` → a real `0`. `null` unless `deep.scope_arc.status === "complete"`. |
| `ki_concentration` | `deep_enrichment` | `not_deep_analyzed` / `ki_groups_absent` / `ki_groups_<status>` / `ki_concentration` | **VRT-class concentration of known issues** (V1.5): `max(unique) / Σ unique` over the gated per-group category table — high means pressure concentrated in one class, leaving the rest of the taxonomy relatively unmined (a BENEFIT under `low_competition`/`best_ev`). `null` unless `deep.known_issues.group_stats.status === "complete"`; a complete payload summing to 0 against a nonzero aggregate is a contradiction → `null`, never 0. |

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
tokenized — it feeds `locationLooksApi` (V1.4: `new URL` on the trimmed
string must parse as http(s); the lowercased hostname is split on
non-alphanumeric runs and matched against the API host-token set, or the
FIRST pathname segment — percent-decoded and lowercased (V1.5) — matched
against the API path-token set; a bare
`/v\d+/` segment and an api token deeper than segment 1 never count) and
the http(s) web fallback, which fires only when neither class matched. One
shared `classifyTarget` (`lib/radar/surface.ts`) feeds both
`api_surface`/`web_surface` and the semantic diff's `added_api_targets`/
`added_web_targets`, so the two can never drift.

**`parseStatValue`** — accepts plain digits, strict thousands grouping
(`1,234`, `1,234,567.89`), one optional leading `$`, and surrounding
whitespace. Rejects `1,23,4`, empty, negative-as-text, exponents, and
arbitrary text — never a bare `parseFloat`.

**`average_payout`** (V1.5) feeds `payout_realized` through the frozen
`normReward` curve — a realized $0 average is a real 0, never an unknown;
absent/malformed values stay `null`.

## Scoring profiles

Six profiles; the V1.3 deep signals bumped their consumers to `1.3.0`,
the V1.4 sourced signals bumped `authz_api` and `easy_entry` to `1.4.0`,
and the V1.5 signals bumped every consumer to `1.5.0` — `best_ev`,
`low_competition`, `high_reward`, `authz_api`, `fresh_programs` — leaving
`easy_entry` at `1.4.0` (no V1.5 signal is onboarding evidence). A
version asserts the semantics, not a release train. Retuning requires a
version bump.
Weight semantics: every weight is **non-negative** and carries a
`direction` — `benefit` (default; bare-number shorthand) contributes
`w·s`, `cost` contributes `w·(1−s)`. Signals absent from a profile
contribute nothing. `required_any` declares groups of alternative signals
the profile considers essential: a score is `provisional` when every
alternative in a group is null. `minConfidence` is the eligibility floor.

| Signal | `best_ev` 1.5.0 | `low_competition` 1.5.0 | `high_reward` 1.5.0 | `authz_api` 1.5.0 | `fresh_programs` 1.5.0 | `easy_entry` 1.4.0 |
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
| `authz_opportunity` | — | — | — | 2 | — | — |
| `payout_realized` | 0.5 | — | 2 | — | — | — |
| `scope_momentum` | 1 | 0.75 | — | 0.75 | 2 | — |
| `ki_concentration` | 0.75 | 1 | — | — | — | — |
| **Σw** | **16.5** | **12.25** | **11** | **13** | **10** | **8** |
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
target cannot fake breadth, plus the brief-derived `authz_opportunity`
rubric (weight 2 — a cross-account prohibition actively lowers the score
via `AUTHZ_PROHIBITED`) and a small semantic-expansion bonus;
`fresh_programs` (labelled **Fresh Opportunity**) — opportunity-dominated,
where `opportunity_change` out-weights raw recency so a text-only publish
can never read as fresh surface; `easy_entry` — onboarding, whose
`accessibility` weight is sourced in V1.4: a stated posture (or the
catalog `accessStatus` fallback) now de-provisionals the score and can
lift coverage to 8/8 = 1.0, while a program with no access evidence at
all still scores provisional at 0.75 coverage.

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
  (`detail_unavailable`); `accessibility`/`authz_opportunity` also emit
  `null` on that path under the surviving `not_available_v1` stub label —
  the sourced rubrics are never reached, so nothing is catalog-inferred.
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
| `accessibility` | ≥ 0.7 | `ACCESS_OPEN` | `+ open access program` |
| | ≤ 0.3 | `ACCESS_GATED` | `- restricted or gated access` |
| `known_issue_density` | ≤ 0.25 | `KI_PRESSURE_LOW` | `+ low known-issue pressure` |
| | ≥ 0.7 | `KI_PRESSURE_HIGH` | `- high known-issue pressure` |
| `opportunity_change` | ≥ 0.5 | `OPPORTUNITY_EXPANDED` | `+ scope expanded in latest diff` |
| | ≤ 0.1 | `OPPORTUNITY_TEXT_ONLY` | `- no scope growth in latest diff` |
| `authz_opportunity` | ≥ 0.5 | `AUTHZ_SURFACE` | `+ authenticated authz test surface` |
| | ≤ 0.15 | `AUTHZ_PROHIBITED` | `- cross-account testing prohibited` |
| `payout_realized` | ≥ 0.7 (~$6k+ avg) | `PAYOUT_HIGH` | `+ high average payout` |
| | ≤ 0.2 (~$300 avg) | `PAYOUT_LOW` | `- low average payout` |
| `scope_momentum` | ≥ 0.5 | `SCOPE_GROWING` | `+ sustained scope growth` |
| | ≤ 0.1 | `SCOPE_FLAT` | `- no net scope growth` |
| `ki_concentration` | ≥ 0.7 | `KI_CONCENTRATED` | `+ known issues concentrated in one class` |
| | ≤ 0.3 | `KI_SPREAD` | `- known issues spread across classes` |
| any weighted signal | value `null` | `UNKNOWN_<KEY>` | `? <key> unavailable` |

`explainScore` renders `+ ` for positives, `- ` for cautions
(`REWARD_LOW`, `COMPETITION_HIGH`, `STALE_PROGRAM`, `SAFE_HARBOR_ABSENT`,
`DATA_INCOMPLETE`, `SUBMISSION_ACTIVITY_HIGH`, `SATURATION_HIGH`,
`KI_PRESSURE_HIGH`, `OPPORTUNITY_TEXT_ONLY`, `ACCESS_GATED`,
`AUTHZ_PROHIBITED`, `PAYOUT_LOW`, `SCOPE_FLAT`, `KI_SPREAD`),
`? ` for unknowns — in the score's stored `reasons`
order. Every signal can emit its threshold codes once it has a value;
a weighted-but-null signal emits `UNKNOWN_*` instead.

## Ranking rules

`rankPrograms` sorts a copy of the scores into a total order:

1. **Eligible first** — `score !== null && confidence ≥ profile.minConfidence`.
2. `score` descending (`null` treated as −1).
3. `confidence` descending.
4. `engagement_uuid` ascending — the tie-break that makes identical inputs
   always rank identically.

`getResults(profile, limit, minConfidence, mode)` returns the latest score
rows per engagement at the profile's *current* version, **scoped to the
discovered set of the run `meta.latestRunId` points at** — its
`completed_uuids ∪ pending_uuids` — joined with catalog identity and the
vector's thirteen display signals (reward, surface trio, **research
saturation**, freshness, known-issue density, opportunity change, the
V1.4 access/authz readings, and the V1.5 payout/momentum/concentration
readings); an
optional `minConfidence` argument filters further, and `limit` is clamped
to 1–200 (default 50). Ineligible rows rank after all eligible ones —
dimmed in the UI, never hidden.

Each row also carries `percentile` (V1.5) — `round1(100·(E−pos)/E)` over
the **eligible ∧ minConfidence-passing** cohort, computed before `limit`
truncates the page, so paging cannot inflate it. The bottom eligible row
reads a real `0.0`; ineligible rows carry `null` (rendered `—`).
Percentile is rank context, never a scored signal.

`mode` selects the evidence level (V1.3.1):

- `"metadata"` — every in-scope program ranked by its metadata-stage
  score. Rows the latest run also deep-analyzed carry
  `evidence_level: "deep"`, a `deep_score`, and a `score_delta` — both
  scores are visible without overwriting the metadata value.
- `"deep"` — **only** programs the latest run deep-analyzed
  (`deep_completed_uuids`), ranked among themselves. Metadata-only rows
  never appear here: an ordinal rank shared across evidence levels would
  imply a comparability that does not exist. For the two profiles that
  weight no deep signal (`high_reward`, `easy_entry`) this mode is
  honestly empty — no deep rows are ever written for them.

Every result row carries `evidence_level` (`"metadata"` | `"deep"`),
`metadata_score`, `deep_score`, `score_delta` (deep − metadata, null
when either endpoint is missing), and `percentile` (null for ineligible
rows).

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

Phases: `catalog` → `enriching` → `scoring` → (`deep_enriching` ⇄
`deep_scoring`)* → `done` | `failed` | `cancelled`. The deep phases run
only when a `deepHydrate` dependency is wired and the candidate union is
non-empty; otherwise the run ends after `scoring` exactly as before
(pre-V1.3 persisted runs resume cleanly). The two deep phases form a
bounded loop: `deep_scoring` re-scores the batch just enriched, then the
stabilization frontier decides whether another `deep_enriching` round is
needed. MV3 service workers may die mid-scan, so every phase transition
and every per-program step checkpoints the run record into the `runs`
store; `meta.latestRunId` points at the newest run.

The deep stage (V1.3.1) has three steps:

1. **Candidate union** — after metadata scoring, each deep-dependent
   profile (`best_ev`, `low_competition`, `authz_api`, `fresh_programs`)
   contributes its Top `PROFILE_CANDIDATE_DEPTH` (20) *eligible* metadata
   ranks of THIS run. `selectDeepCandidates` dedupes the union by uuid
   (provenance: every contributing profile + the metadata rank it earned)
   and orders candidates by earliest contributing profile → best metadata
   rank → uuid. The run records the FULL union in `deep_candidates`; the
   `MAX_DEEP_PROGRAMS` (60) budget caps only the pending queue, so
   `deep_analyzed` vs `deep_candidates` in the summary honestly shows the
   shortfall when the union exceeds the budget. No profile consumes budget
   before the union forms, and `high_reward`/`easy_entry` contribute
   nothing — their scores cannot move under deep evidence.
2. **Deep enrich** — the same worker-pool discipline fetches
   `engagement_known_issues.json` + re-reads `changelog.json` once +
   fetches the step-baseline `changelog/<id>.json` + (V1.5) the arc
   baseline `changelog/<id>.json` when it differs from the step baseline,
   plus the gated per-group `target_groups/<gid>/known_issue_stats` calls
   — **≤10 requests per candidate** (1 KI + 1 changelog + ≤2 baseline
   docs + ≤6 group stats) — writes a NEW snapshot whose `deep` payload
   joins `source_hash`. A program without a metadata detail is completed
   without enrichment; deep signals are never fabricated.
3. **Deep score + frontier** — `deep_scoring` re-scores the just-enriched
   uuids for the four deep profiles only, writing score rows under
   `stage: "deep"` (the metadata-stage row is never overwritten).
   `evaluateFrontier` then takes each deep profile's Top
   `STABLE_TOP_K + STABILITY_BUFFER` (20 + 10) metadata-ranked window and
   counts the uuids still lacking deep analysis; up to `DEEP_BATCH_SIZE`
   (10) of them form the next batch and the loop returns to step 2. The
   run records `deep_stabilization`: `"stable"` (every window fully
   analyzed), `"budget_limited"` (the 60-program cap hit first), or
   `"incomplete"` (cancelled/failed mid-loop). "Stable" is honest about
   its bound: it asserts the bounded Top-K+buffer frontier, not a global
   fixpoint.

   Budget arithmetic, stated plainly: the union can reach
   `depth × profiles` = 20 × 4 = 80 while `MAX_DEEP_PROGRAMS` is 60 — so
   at full-catalog scale with low cross-profile overlap, round 1 alone
   exhausts the budget and the truthful verdict is `budget_limited`.
   Iterative rounds engage when the union fits inside the budget (high
   overlap, smaller catalog) or when deep-dropped rows pull frontier
   members forward. This is deliberate: the request ceiling is the
   product constraint, and the verdict reports what was actually
   stabilized rather than implying completeness that wasn't paid for.

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
  `putScore` upserts by key, so re-scoring is idempotent. Metadata scores
  are written at `stage: "metadata"`; deep re-scores write separate
  `stage: "deep"` rows (same key shape plus the stage discriminator) —
  deep analysis never destroys the metadata baseline it was computed on.
  Deep-stage rows are written only for the four deep-dependent profiles.
- Run records persist the deep orchestration state — `deep_pending_uuids`,
  `deep_completed_uuids`, `deep_candidates` (uuid → contributing profiles
  + metadata ranks), `deep_enriched`, `deep_round`, `deep_budget`,
  `deep_stabilization` — so a service-worker restart mid-deep resumes the
  pending queue without repeating completed fetches.
- `RadarScanSummary` verdict on termination: `failed` when the run failed;
  otherwise `complete` iff `catalog_complete` AND `enrichment_failed === 0`;
  anything else is honestly `partial`. Deep progress surfaces as
  `deep_candidates` / `deep_analyzed` / `deep_enriched` / `deep_rounds` /
  `deep_budget` / `deep_stabilization` on the same summary. Warning
  details cap at 50
  entries plus a `…and N more` overflow line.

## Persistence

Separate `bce-radar` IndexedDB (version 1) — never the exporter's `bce`
job tables:

| Store | Key path | Index | Row |
|---|---|---|---|
| `catalog` | `uuid` | — | `RadarCatalogItem` |
| `snapshots` | `[uuid, source_hash]` | `byUuid` | `{uuid, source_hash, stored_at, snapshot}` |
| `scores` | `[uuid, profile, scoring_version, source_hash]` | `byUuidProfile` | `{uuid, profile, scoring_version, source_hash, stage?, stored_at, score, vector?}` — `stage` `"metadata"`/`"deep"` (V1.3.1); legacy rows without it resolve lazily from their snapshot's deep payload |
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
| `RADAR_GET_RESULTS` | `profile` (enum), `limit` int 1–200 (default 50), `minConfidence` 0–1 optional, `mode` `"metadata"`/`"deep"` (default `"metadata"`) | `{rows}` ranked result rows — rows carry `evidence_level`, `metadata_score`, `deep_score`, `score_delta` |
| `RADAR_GET_PROGRAM` | `uuid` (the engagement's slug — `[A-Za-z0-9_-]{1,100}`), `profile` optional (router defaults to `best_ev`) | `{program}` — snapshot, score, rendered explanation, catalog row |
| `RADAR_EXPORT_REPORT` | `format` `"markdown"`/`"json"`/`"csv"`, `scope` `"current"`/`"all"`, `profile` (required when `scope` is `"current"`), `limit` `20`/`50`/`"all"` (default `50`), `detail` bool (default true), `diagnostics` bool (default true) | `{export}` — `{filename, mime, body, content_hash, generated_at}`; `{error:"no_scan"}` when no run is persisted, `invalid_params` for a profile-less current scope |

## Report export

The **Export report** button on the radar page opens a dialog and serializes
the **latest persisted run** into a local download — Markdown, JSON, or CSV,
one profile or all six, Top 20 / Top 50 / the whole ranked cohort, with
optional detailed evidence and diagnostics. It is strictly read-only: no
scan is started, no API request is made, no stored state is modified, and
the body is assembled entirely inside the browser.

Three invariants hold across every format:

- **One snapshot.** Every section reads the same `run_id` — rows, digests,
  and diagnostics never mix runs or scoring versions. Deep rows are gated by
  that run's `deep_completed_uuids`, so a metadata-only program is never
  presented as deep-enriched. One honest caveat: persisted score rows are
  content-addressed, not run-keyed — for a run with no terminal verdict
  (still in progress), exported rows can include score evidence written by
  an earlier scan for still-pending programs, and the report's executive
  summary says so explicitly.
- **Full-cohort percentile.** `percentile` is computed over the complete
  eligible cohort *before* the Top-N limit truncates the export — truncating
  the report never recalculates rank context.
- **Deterministic body.** For identical persisted data and options the
  report is byte-identical. `content_hash` is `sha256` of the canonical JSON
  export model — format-independent, and independent of the wall-clock
  `generated_at` carried in the message envelope only.

Markdown renders an executive summary, one results table per profile
(exact `profile_id` + version, metadata vs deep scores kept explicit), a
detailed-evidence block with weights/contributions/reason codes/source
hashes, and a diagnostics table distinguishing `complete`, `unavailable`,
`failed`, `no_baseline`, `skipped`, and `absent` deep sub-source outcomes —
a `0` signal cell is a real observed zero, never conflated with missing
evidence. JSON is a versioned `bce-radar-export` envelope for downstream
agents, with `null` for every unavailable value. CSV is flat columns
(`profile_id`, `profile_version`, `rank`, `evidence_level`,
`engagement_slug`, …) with formula-injection escaping on untrusted text.

The stored API credential is redacted from the serialized body as
defense-in-depth, and reports containing rows from gated/invitation-only
programs carry an authenticated-content notice. Samples are checked in at
`docs/samples/radar-report.{md,json,csv}` and guarded by
`tests/radar-samples.test.ts`; regenerate after intentional format changes
with `WRITE_SAMPLES=1 npx vitest run tests/radar-samples.test.ts`.

## Limitations

- **This is a Metadata Opportunity Score plus a bounded deep pass, not
  expected value.** The ranked list is a candidate pool for deeper human
  analysis. `known_issue_density`, `opportunity_change`,
  `scope_momentum`, and `ki_concentration` are sourced for
  the deep-analyzed candidate union only (≤ 60 programs);
  `accessibility` and `authz_opportunity` are sourced metadata rubrics
  (V1.4) but remain proxies — the first reads stated participation
  posture, the second reads policy text — and no signal estimates
  duplicate probability or guarantees undiscovered bugs.
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
  API-heavy candidates by share and target count plus the
  `authz_opportunity` rubric (weight 2, V1.4) — which reads the brief's
  *normative policy text* on cross-account techniques: a prohibition reads
  a flat 0.1, a grant reads high, and silence contributes a conservative
  midpoint only when an account surface is proven. A grant is the
  program's own claim about what may be tested, not evidence of an
  exploitable authz surface.
- **`accessibility` is a stated-posture rubric, not a guarantee.** V1.4
  sources it from `participation` (with the catalog `accessStatus` as the
  declared fallback), shipped credentials, and signup/friction markers in
  the brief — a program can still gate access in ways neither field
  states, and a brief with no access evidence at all reads `null`
  (`no_access_evidence`), keeping `easy_entry` provisional.
- **Known Issues are deep-stage only.** `engagement_known_issues.json`
  is fetched for the ≤60-program candidate union, never catalog-wide
  (verified `{"unique","total"}` shape). The V1.5 per-group breakdown
  (`target_groups/<gid>/known_issue_stats`, verified live) is gated: it
  runs only when the aggregate completed with `unique ≥ 10` and 1–6
  qualifying in-scope groups, and fails all-or-nothing — never a partial
  sample. Deep cost is bounded: ≤ 10 requests × ≤ 60 programs = ≤ 600
  requests per scan, on top of ~4 metadata requests per program + 1 per
  catalog page.
  `known_issue_density` is a duplicate-PRESSURE proxy over `unique`
  counts blended with per-target density; it is not a duplicate
  probability, and a program whose fetch fails reads `null`, never 0.
- **Scope history spans two windows.** The step diff covers the latest
  publish; the V1.5 scope arc diffs the current document against the
  version `SCOPE_ARC_DEPTH` (5) publishes back (clamped to the oldest
  entry, one extra fetch — deduped when both baselines coincide), so
  gradual creep spread over several publishes feeds `scope_momentum`.
  Anything older than the changelog's retained history is still
  invisible, and an arc baseline that fails to fetch reads `unavailable`,
  never fabricated.
- **No AI participates in V1 ranking.** Collection, feature extraction,
  scoring, ranking, and reason text are deterministic code. AI analysis is
  a downstream consumer of the ranked shortlist, not an input to it.
- **Scores are absolute; percentile is context, not evidence.** Fixed
  curves decide the score — a score moves only when that program's inputs
  move. The V1.5 `percentile` adds catalog-relative rank context on the
  result row (share of the eligible cohort outranked), deliberately NOT a
  scored signal — a crowded cohort cannot manufacture opportunity.
- **`average_payout` is a realized-average, not a price tag.** V1.5
  consumes it as `payout_realized` through the frozen reward curve — it
  is the program's measured mean payout across whatever window the site
  reports, which mixes severity tiers; a high ceiling with a low realized
  average is exactly the discrepancy `high_reward` prices.
- **Surface classifiers are token membership plus URL shape.** A target
  matching neither token set with a non-URL location counts toward neither
  `api_surface` nor `web_surface`, and the shape pass is deliberately
  conservative: only parseable http(s) locations classify, only host
  tokens and the FIRST path segment are consulted (a bare `/v2/` or
  `/x/api` does not count). V1.5 decodes percent-escapes and lowercases
  that first segment — `example.com/API` and `/%61pi` classify like
  `/api`; a malformed escape falls back to the raw segment.
  Taxonomy drift in API metadata is not learned.
- **Statistics are self-reported API strings.** Missing, renamed, or
  unparseable statistics keys degrade to `null` signals, not zero.
- **Clamped floor.** The score is clamped to [0, 1] × 100 — a genuinely
  weak signal mix displays as 0, never a negative number.
