# Bountinfo Radar V1.1 — Implementation Plan

Repository: `luongvietan/Bountifo`
Baseline inspected: `9f2b347`
Product: WXT / Chrome MV3 browser extension

## Goal

Thêm Engagement Radar có khả năng:

Discover all Bugcrowd engagements visible to the current account
→ hydrate cheap API metadata
→ convert metadata into deterministic feature vectors
→ score using multiple hunting profiles
→ persist/cache results
→ expose ranked results to extension UI

V1 profiles:

- `best_ev` (default)
- `low_competition`
- `high_reward`
- `authz_api`
- `fresh_programs`
- `easy_entry`

Radar V1.1 không dùng AI.
AI analysis sẽ là consumer của ranked shortlist trong phase sau.

## Non-goals

Không làm trong milestone này:

- full DOM export cho toàn catalog
- Known Issues crawling cho mọi program
- AI ranking
- AI hypothesis generation
- target execution
- browser pentesting automation
- Scope Guard semantic changes
- Exporter policy parser changes
- cloud sync
- HackerOne / Intigriti support

Không thay đổi frozen contracts:

- Exporter V1
- Scope Guard V1
- Execution Guard V1

## Architecture

```
Bugcrowd API
    │
    ▼
Catalog Enumerator
    │
    ▼
Radar Catalog
    │
    ▼
Metadata Hydrator
 GET_ENGAGEMENT
    │
    ▼
Program Snapshot
    │
    ▼
Feature Extractor
    │
    ▼
ProgramFeatureVector
    │
    ├────────────┬─────────────┬─────────────┐
    ▼            ▼             ▼             ▼
 Best EV     Low Comp.    High Reward    AuthZ/API ...
    │
    ▼
Explained ProgramScore
    │
    ▼
IndexedDB
    │
    ▼
Background message API
```

Important separation:

```
collection facts
    ↓
feature extraction
    ↓
scoring
```

NOT

```
LLM
    ↓
"this looks good"
```

## Data semantics

Every scoreable signal must be one of:

```ts
type SignalValue = number | null;
```

`null` means:

- unknown / unavailable

Never:

- null → 0
- null → false
- null → bad program

Each feature carries provenance:

```ts
interface RadarSignal {
  value: number | null;       // normalized 0..1
  source:
    | "engagement_index"
    | "engagement_detail"
    | "statistics"
    | "derived";
  reason_code: string;
}
```

Unknown fields are excluded from the intrinsic score denominator.
Calculate separately:

- score
- confidence

Do not silently multiply score by confidence.
Default ranking requires a minimum confidence threshold before labeling something a strong candidate.

## Task 1 — Create Radar domain model

New file

`lib/radar/types.ts`

Implement:

```ts
export type RadarProfileId =
  | "best_ev"
  | "low_competition"
  | "high_reward"
  | "authz_api"
  | "fresh_programs"
  | "easy_entry";
```

Catalog identity:

```ts
export interface RadarCatalogItem {
  uuid: string;
  code: string | null;
  name: string | null;

  lifecycle_status: string | null;
  engagement_type: string | null;

  discovered_at: string;
}
```

Hydrated record:

```ts
export interface RadarProgramSnapshot {
  schema_version: 1;

  uuid: string;
  code: string | null;

  catalog: RadarCatalogItem;

  detail: ApiEngagementData | null;

  enrichment: {
    status: "complete" | "unavailable" | "failed";
    error_kind?: string;
  };

  source_hash: string;
}
```

Feature vector:

```ts
export interface ProgramFeatureVector {
  schema_version: 1;

  reward_potential: RadarSignal;
  reward_breadth: RadarSignal;

  meaningful_surface: RadarSignal;
  api_surface: RadarSignal;
  web_surface: RadarSignal;

  researcher_competition: RadarSignal;
  rewarded_activity: RadarSignal;

  freshness: RadarSignal;
  safe_harbor: RadarSignal;

  target_data_quality: RadarSignal;

  accessibility: RadarSignal;
  known_issue_density: RadarSignal;
  authz_opportunity: RadarSignal;
}
```

Last three may legitimately be `null` in Radar V1.
Do not fake values for them.

Score:

```ts
export interface ProgramScore {
  schema_version: 1;

  engagement_uuid: string;
  profile: RadarProfileId;
  scoring_version: string;

  score: number | null;
  confidence: number;

  components: Record<
    string,
    {
      signal: number | null;
      weight: number;
      contribution: number | null;
    }
  >;

  reasons: string[];

  source_hash: string;
}
```

Tests

Create:

`tests/radar-types.test.ts`

Test:

- profile IDs stable
- feature values must stay in 0..1 or null
- score schema deterministic
- no NaN / Infinity accepted

## Task 2 — Add full catalog enumeration

Do NOT reuse the 20-page behavior of:

`resolveEngagementUuid()`

That function has different semantics.

New file

`lib/radar/catalog.ts`

Implement pure parser:

```ts
parseCatalogPage(raw: unknown): {
  items: RadarCatalogItem[];
  rawCount: number;
};
```

Then:

`enumerateEngagementCatalog(...)`

Algorithm:

```
page = 1

while page <= MAX_CATALOG_PAGES:
    LIST_ENGAGEMENTS(page)

    parse records

    dedupe by UUID

    if raw response contains < 25 rows:
        COMPLETE
        stop

    page++
```

Use:

```ts
const MAX_CATALOG_PAGES = 100;
```

This is a safety limit, not an assumption that only 100 pages exist.
If page 100 is full:

```
status = partial
reason = page_limit_reached
```

Never report complete.

Return:

```ts
interface CatalogScanResult {
  status: "complete" | "partial" | "failed";

  items: RadarCatalogItem[];

  pages_fetched: number;

  warnings: string[];
}
```

Important

The existing API client already provides:

- shared rate limiting
- 429 handling
- backoff
- credential isolation
- GET allowlist

Reuse it.
Do not create another raw `fetch()`.

Tests

Create:

`tests/radar-catalog.test.ts`

Cover:

- one short page
- multiple full pages + short final page
- dedupe duplicate UUID
- malformed records ignored safely
- missing code preserved as null
- API error
- 429 propagated correctly
- page 100 full → partial, never complete
- deterministic ordering

## Task 3 — Add Radar metadata hydration

Radar should not run the DOM exporter for every program.
Use API detail only:

```
GET_ENGAGEMENT
include=target_groups,targets
```

New file

`lib/radar/enrichment.ts`

Reuse:

- `apiRequest()`
- `parseEngagement()`

Do not duplicate JSON:API parsing.

Implement:

```ts
hydrateRadarProgram(
  catalogItem: RadarCatalogItem
): Promise<RadarProgramSnapshot>
```

Use UUID directly.
Do not resolve UUID through catalog again.

Expected path:

```
RadarCatalogItem.uuid
        ↓
GET_ENGAGEMENT(uuid)
        ↓
parseEngagement()
        ↓
RadarProgramSnapshot
```

Failure of one program must not fail entire radar run.
Example:

```
program 47
403
→ enrichment unavailable
→ continue program 48
```

Credential-wide errors may abort:

- unauthorized
- storage_locked

Document exact fatal/non-fatal classification.

## Task 4 — Add deterministic source hashing

Radar cache must know whether scoring input changed.

New file

`lib/radar/hash.ts`

Create canonical projection excluding:

- discovered_at
- scan timestamps
- runtime progress
- volatile error timing

Include semantic data:

- uuid
- code
- engagement type
- lifecycle
- safe harbor
- statistics
- target groups
- rewards
- targets
- tags
- scope flags

Generate:

`source_hash`

Invariant:

```
same semantic metadata
→ same source_hash
```

Different async order must not change hash.

Use existing canonical/hash utilities where possible.
Do not create competing canonicalization semantics.

Tests

`tests/radar-hash.test.ts`

Cover:

- ordering independence
- timestamp independence
- reward change changes hash
- target change changes hash
- statistics change changes hash

## Task 5 — Implement Feature Extractor

New file

`lib/radar/features.ts`

This must be a pure deterministic module.

- No network.
- No storage.
- No Date.now() internally.

Pass reference time explicitly:

```ts
extractProgramFeatures(
  snapshot: RadarProgramSnapshot,
  now: string
): ProgramFeatureVector
```

### 5.1 Reward potential

Use in-scope target-group rewards.
Do not only use max P1.

Calculate normalized signals from:

- P1
- P2
- P3
- reward-bearing groups

Use fixed normalization curves.
Do NOT normalize relative to current catalog percentile.

Example:

```
$0       → 0
$500     → low
$2,000   → medium
$10,000  → high
$25,000+ → near 1
```

Prefer logarithmic or explicitly segmented normalization.
Freeze curve in tests.

## Task 6 — Surface signals

Derive only from structured target data.

Examples:

- meaningful_surface
- api_surface
- web_surface

Use:

- target.category
- target.tags
- target.name
- location shape
- inScope

No LLM.
No fuzzy semantic classifier.
Canonical deterministic token mappings are acceptable:

```
api
rest
graphql
website
web
mobile
```

Unknown categories stay unknown/other.

Do not label something `authzOpportunity` merely because it has an API.
For Radar V1:

```
authz_opportunity = null
```

unless the metadata contains a deterministic explicit signal.

## Task 7 — Competition/activity signals

Existing `ApiEngagementData.statistics` can expose values such as:

- researchers_participating
- vulnerabilities_rewarded
- average_payout

Implement strict parsers for:

- "1,234"
- "$512.00"
- "321"

Never use `parseFloat()` blindly on arbitrary text.

Derive:

- researcher_competition
- rewarded_activity

Important terminology:

```
researcher_competition
!=
duplicate_probability
```

Do not call it duplicate pressure yet.
Real duplicate intelligence comes later from Known Issues/deep analysis.

## Task 8 — Freshness signal

Input:

- lastBriefUpdate
- lastStatusTransition

Use fixed age bands.

Example initial calibration:

```
≤ 7 days     → 1.00
≤ 30 days    → 0.85
≤ 90 days    → 0.60
≤ 180 days   → 0.35
older        → 0.15
unknown      → null
```

Pass `now` explicitly.
Tests must not depend on wall clock.

## Task 9 — Safe Harbor + data quality

`safe_harbor` signal derives only from API field if available.
Do not infer Safe Harbor from unrelated text.

`target_data_quality` can measure:

- % in-scope targets with category
- % targets with usable location/name
- presence of groups
- usable reward metadata

Name it data quality, not policy clarity.
Actual policy clarity requires full dossier and comes in Radar Deep Analysis later.

## Task 10 — Define scoring profiles

New file

`lib/radar/profiles.ts`

Example:

```ts
export interface RadarProfile {
  id: RadarProfileId;
  version: string;
  label: string;
  weights: Partial<Record<keyof ProgramFeatureVector, number>>;
  minConfidence: number;
}
```

Implement six profiles.

`best_ev`

Emphasize:

- reward
- surface
- competition
- freshness

`low_competition`

Emphasize:

- inverse researcher competition
- freshness
- surface

Do NOT claim this is actual duplicate probability.

`high_reward`

Emphasize:

- reward potential
- reward breadth

`authz_api`

V1 should primarily mean:
API-heavy / authenticated-research-friendly candidate
not:
proven IDOR opportunity

Until deeper program analysis exists.

`fresh_programs`

Emphasize freshness.

`easy_entry`

In V1 this profile will have reduced confidence because:

- accessibility = null

until account/setup requirements are extracted by deep analysis.
That is acceptable.
Do not invent accessibility.

## Task 11 — Implement scoring engine

New file

`lib/radar/scoring.ts`

Main function:

```ts
scoreProgram(
  snapshot: RadarProgramSnapshot,
  vector: ProgramFeatureVector,
  profile: RadarProfile
): ProgramScore
```

Rules:

```
known signal
→ weighted contribution

unknown signal
→ excluded from denominator

confidence
→ known profile-weight / total profile-weight
```

Example:

```
known weight = 75
total profile weight = 100

confidence = 0.75
```

Score:

weighted average of known signals × 100

Do not:

- unknown → 0
- unknown → 0.5
- score *= confidence

Default radar ranking:

```
eligible if confidence >= profile.minConfidence

then:
score DESC
confidence DESC
uuid ASC
```

The UUID tie-break makes ordering deterministic.

Implement:

`rankPrograms(...)`

## Task 12 — Explained scoring

Every non-null component should produce stable reason codes.

Example:

```
REWARD_HIGH
REWARD_BROAD
API_SURFACE_HIGH
COMPETITION_LOW
RECENTLY_UPDATED
SAFE_HARBOR_PRESENT
DATA_INCOMPLETE
```

Reason text is rendered from templates.
Never ask AI to explain V1 scores.

Example result:

```
84.7 · confidence 0.88

+ strong P1/P2 reward
+ substantial API surface
+ recently updated
+ moderate researcher competition

? accessibility unavailable
? duplicate density unavailable
```

## Task 13 — Radar IndexedDB store

Do NOT mix Radar lifecycle into the existing exporter job tables unless reuse is clearly clean.

Preferred new module:

`lib/radar/store.ts`

Stores:

- catalog
- snapshots
- scores
- runs

Suggested keys:

```
catalog: uuid
snapshots: [uuid, source_hash]
scores: [uuid, profile, scoring_version, source_hash]
runs: run_id
```

Current result pointer can live in:

`runs.latest`

Avoid storing duplicate large API bodies.
Persist normalized metadata.

## Task 14 — Make Radar scan resumable

MV3 service workers may terminate.

Create:

`lib/radar/coordinator.ts`

State:

```ts
interface RadarRunState {
  run_id: string;

  phase:
    | "catalog"
    | "enriching"
    | "scoring"
    | "done"
    | "failed"
    | "cancelled";

  discovered: number;
  enriched: number;
  scored: number;

  pending_uuids: string[];
  completed_uuids: string[];

  warnings: number;

  started_at: string;
  updated_at: string;
}
```

Checkpoint after every engagement or small deterministic batch.
On service-worker restart:

```
read active radar run
→ resume pending UUID
```

Do not restart catalog from zero if complete cached discovery exists for that run.

## Task 15 — Bounded enrichment

Do not fire:

`Promise.all(400 programs)`

Use a small worker pool or sequential processing.
Initial recommendation:

```
concurrency = 2
```

Existing API rate bucket remains the ultimate request limiter.
Retries belong in `apiRequest`, not Radar.
Radar coordinator should not add another HTTP retry layer.

## Task 16 — Background message protocol

Modify:

- `lib/messages.ts`
- `entrypoints/background.ts`

Add strict extension-page operations:

- RADAR_START_SCAN
- RADAR_CANCEL_SCAN
- RADAR_GET_STATE
- RADAR_GET_RESULTS
- RADAR_GET_PROGRAM

Schemas `.strict()`.
No arbitrary:

- url
- headers
- method
- API operation

Radar messages should be available to trusted extension pages.
Do not expose an authenticated generic API proxy to content scripts.

Suggested result query:

```json
{
  "op": "RADAR_GET_RESULTS",
  "profile": "best_ev",
  "limit": 50,
  "minConfidence": 0.7
}
```

Bound:

```
limit <= 200
```

## Task 17 — Scan lifecycle semantics

Radar scan result needs its own integrity status.

Example:

```ts
interface RadarScanSummary {
  status: "complete" | "partial" | "failed";

  catalog_complete: boolean;

  discovered: number;
  enriched: number;
  enrichment_failed: number;

  scored: number;

  warnings: string[];
}
```

Example:

```
300 discovered
297 hydrated
3 inaccessible

→ scan can be partial
```

Do not silently call it complete.
Per-program failures remain inspectable.

## Task 18 — Integration tests

Create:

`tests/radar-integration.test.ts`

Use mocked Bugcrowd API only.

Scenario:

```
page 1 = 25 engagements
page 2 = 3 engagements

28 discovered

25 hydrate successfully
1 = 403
1 = malformed response
1 = 500 exhaustion

25 scoreable
3 partial/unavailable
```

Verify:

- catalog ordering
- dedupe
- checkpoint/resume
- partial status
- profiles deterministic
- stable reason codes
- stable hashes
- no credentials in persisted state
- no Authorization headers in result

## Task 19 — Scoring regression fixtures

Create:

`tests/fixtures/radar/`

At least:

- high-reward-api.json
- low-reward-low-competition.json
- fresh-program.json
- stale-program.json
- partial-program.json
- mixed-target-program.json

Expected profile relationships:

```
High Reward preset
→ high-reward-api > low-reward-low-competition

Low Competition
→ low-reward-low-competition may outrank high-reward-api

Fresh Programs
→ fresh > stale

AuthZ/API
→ API-heavy > marketing-web-only

Partial program
→ confidence lower
```

Do not hardcode arbitrary catalog rank beyond fixture semantics.

## Task 20 — Preserve existing security architecture

Update:

`tests/guard-architecture.test.ts`

Radar introduces no new raw network primitive.
It must use:

`apiRequest()`

Therefore Radar files should not contain:

- fetch(
- XMLHttpRequest
- axios
- undici

except existing approved API client.
This keeps the closed side-effect registry intact.

Radar is still:

- collection plane
- not target execution.

## Task 21 — Minimal UI entrypoint after engine is proven

Only after catalog/scoring tests are green.

Create:

```
entrypoints/radar/
  index.html
  main.ts
  style.css
```

For V1 UI only needs:

- Scan programs
- Refresh
- Profile selector
- Status/progress
- Ranked table

Columns:

- Rank
- Program
- Score
- Confidence
- Reward
- Surface
- Competition
- Freshness

Profiles:

- Best EV
- Low Competition
- High Reward
- AuthZ/API
- Fresh Programs
- Easy Entry

Clicking a row shows deterministic component breakdown.
No AI button yet.

## Task 22 — Entry point from popup / launcher

Add:

`Open Radar`

Do not cram Radar into popup.
Popup should open the dedicated extension page.

## Task 23 — Documentation

Create:

`docs/RADAR.md`

Document:

- data sources
- catalog completeness
- feature definitions
- normalization curves
- profile weights
- confidence calculation
- unknown semantics
- ranking rules
- limitations

Explicit limitations:

- researcher competition is not duplicate probability
- API-heavy is not proof of authz vulnerabilities
- accessibility may remain unknown
- Known Issues are not yet included in cheap scoring
- AI does not participate in V1 ranking

Also add:

`docs/superpowers/plans/2026-09-21-engagement-radar-v1.md`

containing this implementation plan.

## Recommended commit sequence

Commit 1

`feat: add engagement radar catalog discovery`

Task 1–2

Commit 2

`feat: add radar metadata hydration and cache`

Task 3–4 + store foundations

Commit 3

`feat: add deterministic radar feature extraction`

Task 5–9

Commit 4

`feat: add multi-profile radar scoring`

Task 10–12

Commit 5

`feat: add resumable radar scan coordinator`

Task 13–17

Commit 6

`test: add radar integration and scoring regressions`

Task 18–20

Commit 7

`feat: add engagement radar interface`

Task 21–22

Commit 8

`docs: document radar scoring model`

Task 23

Do not collapse everything into one giant commit.

## Verification after every implementation batch

Run:

```
npm test
npm run typecheck
npm run build
```

Final acceptance should additionally prove:

- existing Exporter tests unchanged
- existing Scope Guard matrix unchanged
- Execution Guard tests unchanged
- architecture sink registry unchanged
- no new credential leakage

## Final acceptance criteria

Radar V1.1 is complete when:

- ✓ enumerates every engagement exposed by LIST_ENGAGEMENTS until a short final page
- ✓ page safety cap produces PARTIAL, never false COMPLETE
- ✓ UUID dedupe is deterministic
- ✓ metadata hydration uses existing allowlisted API client
- ✓ one failed engagement does not destroy entire scan
- ✓ scan survives MV3 service-worker restart
- ✓ semantic input hashes are stable
- ✓ feature extraction is deterministic
- ✓ unknown != zero
- ✓ six scoring profiles exist
- ✓ scoring does not use catalog-relative percentile
- ✓ score and confidence remain separate
- ✓ every score has component breakdown
- ✓ ranking has deterministic tie-break
- ✓ profile weights are versioned
- ✓ no LLM is used
- ✓ no raw fetch is introduced outside existing approved client
- ✓ token/Authorization data never reaches Radar DB or UI
- ✓ exporter remains unchanged semantically
- ✓ Scope Guard remains unchanged semantically
- ✓ full existing test suite stays green

## After V1.1

The next phase should be:

```
Radar V1.2
──────────
semantic snapshot diff
Known Issues density
real duplicate-pressure signals
setup/accessibility extraction
deep-analyze Top N only
```

Then:

```
Radar V1.3
──────────
Top N deterministic shortlist
        ↓
AI analyst
        ↓
attack-surface map
hypothesis generation
uncertainties
supporting fact IDs
```

The boundary remains:

```
Code discovers facts
Code computes ranking
AI analyzes shortlist
Human selects program
```
