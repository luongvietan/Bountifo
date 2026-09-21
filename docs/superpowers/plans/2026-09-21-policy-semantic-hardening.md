# Policy Normalizer Semantic Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false `allowed`/over-broad policy facts in the Bugcrowd engagement exporter so Scope Guard can eventually trust `testing_status`, using the Atlassian/Mastercard/Rapyd/Okta live counterexamples while keeping LastPass and all golden fixtures green.

**Architecture:** All changes are generic semantics in the existing pipeline: sentence classifier (`lib/model/policyText.ts`), technique span narrowing (same file), DOM focus/exclusion lane splitting (`lib/dom/domUtils.ts` + `lib/dom/policies.ts`). No program-name conditionals, no schema redesign. `reward_status` stays `"ineligible" | "unspecified"` (spec §6 V1 fallback explicitly allowed); eligibility text stays in the exclusion record.

**Tech Stack:** TypeScript, vitest + jsdom, WXT.

**Spec:** Task brief §1–§28 (verbatim regression fixtures quoted in the request).

## Global Constraints

- No evidence → no fact; topic mention ≠ permission; eligibility ≠ permission; submission excluded ≠ testing prohibited; reward ineligible ≠ testing prohibited; out-of-scope finding ≠ testing prohibited; unspecified ≠ prohibited; unknown ≠ zero/complete.
- `testing_status: allowed` requires explicit testing-governing permission: never guess ALLOW (uncertain → `unspecified`).
- No `if (engagement === "...")` special-casing anywhere.
- Do not regress: Aiven, SimpliSafe, OneTrust, Zendesk, Statuspage, EPAM, Pinterest, Web.com, LastPass (automated tools conditional ≤5 req/s), KI fail-closed behavior, `agent_facts_schema_version: 1`, `scope_inventory`, `scope_groups`.
- Commit only if all tests pass; one focused commit; no push, no PR.

## Review Focus

- "No X are allowed" polarity inversion (P0) — Atlassian pivoting.
- Account/setup permission masquerading as testing grant (P0) — Mastercard Developer APIs.
- Reward eligibility leaking into `testing_status` (P0) — Atlassian latest-version.
- Mixed in/out-of-scope ranges inside one parent section (P1) — Mastercard vulnerability lists.
- Broad technique buckets swallowing narrow facts or manufacturing conflicts (P1) — Rapyd third-party/PII, Okta port scanning.
- Sentence-level tests passing while live DOM still fails — DOM fixtures are mandatory.

## File Structure

- `lib/model/policyText.ts` — all sentence semantics: negated-subject polarity, permission grant validation, eligibility frame, tolerated-prohibition family, `leverage` verb, noun prefix/suffix narrowing, PII access object-split, context capture.
- `lib/dom/domUtils.ts` — `scopeBlocks(scope)`: document-order block sequence incl. marker-capable headings for bounded and unbounded scopes.
- `lib/dom/policies.ts` — lane-aware focus/exclusion collection; `contexts` passthrough on technique payloads.
- `tests/policy-hardening.test.ts` — new file: unit + DOM regression for every live counterexample + structural invariants.

---

### Task 1: Negated-subject polarity inversion (Atlassian P0)

**Files:**
- Modify: `lib/model/policyText.ts`
- Test: `tests/policy-hardening.test.ts`

**Interfaces:**
- Produces: `negatedPermissionRanges(sentence): {start,end}[]` (internal), used by `hasProhibition` (new evidence family) and `hasPermission` (masks matches inside negated ranges).

- [ ] **Step 1: Write failing tests**

```ts
it.each([
  "No pivoting or post exploitation attacks (i.e. using a vulnerability to find another vulnerability) are allowed on this program.",
  "No automated scans are allowed.",
  "No pivoting is permitted.",
  "No destructive testing is authorized.",
  "No credential stuffing is allowed.",
  "No exploitation beyond PoC is permitted.",
  "Neither scanning nor probing is allowed.",
  "None of these techniques are permitted.",
])("reads negated-subject permission as prohibition: %s", (s) => {
  expect(statusOfSentence(s)).toBe("prohibited");
});

it("never emits allowed from a negated subject", () => {
  expect(testingStatusOf(
    "No pivoting or post exploitation attacks are allowed on this program. " +
    "DO NOT under any circumstance leverage a finding to identify further issues.",
  )).toBe("prohibited");
});

it("does not turn unrelated 'no' phrases into prohibitions", () => {
  expect(statusOfSentence("There is no evidence that scanning is allowed.")).not.toBe("prohibited");
});
```

- [ ] **Step 2: Run tests — expect FAIL** (current output: `allowed`)

- [ ] **Step 3: Implement**

Add to `lib/model/policyText.ts`:

```ts
const NEGATED_SUBJ_G =
  /\b(no|none\s+of|neither)\s+(.{1,160}?)\s+(?:(?:is|are|was|were|be|been|being|remains?)\s+)?(?:\w+ly\s+)*(permitted|allowed|authorized|authorised|encouraged|welcomed)\b/gi;
const SUBJECT_VERB_RE =
  /\b(?:is|are|was|were|be|been|being|do|does|did|can|could|will|would|shall|should|may|might|must|has|have|had|seems?|appears?)\b/i;
const SUBJECT_LEAD_STOP_RE =
  /^(?:more|less|fewer|greater|additional|further|longer|evidence|reason|indication|proof|reports?|suggestions?|doubts?|questions?|guarantee|signs?|ways?|means|methods?|possibilit\w+|chance|likelihood)\b/i;

function negatedPermissionRanges(sentence: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  NEGATED_SUBJ_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEGATED_SUBJ_G.exec(sentence)) !== null) {
    const subject = (m[2] ?? "").trim();
    const words = subject.split(/\s+/);
    if (words.length === 0 || words.length > 15) continue;
    if (SUBJECT_VERB_RE.test(subject) || SUBJECT_LEAD_STOP_RE.test(subject)) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}
```

Add prohibition evidence: `hasProhibition` returns true when `negatedPermissionRanges(sentence).length > 0`. In `hasPermission`, collect all `PERMISSION_RES` matches; a match inside a negated range does not count, and a surviving match must pass `isTestingGrant` (Task 2). Add negated-subject to `CLAUSE_SCOPE_RES` handling via the same range check inside `predicateGoverns` (ranges → clause-scope govern).

Also extend `IMPERATIVE_NEG_RE` handling to tolerate adverbial inserts and add `leverage` to `ACTION_VERB`: `do not (under any circumstance[s]|ever|at any time|for any reason) <action-verb>`; keep `attempt`/`try` OUT of the filler list (they are action verbs themselves).

- [ ] **Step 4: Run tests — expect PASS**

---

### Task 2: False-ALLOW validator / account-setup veto (Mastercard P0)

**Files:**
- Modify: `lib/model/policyText.ts`
- Test: `tests/policy-hardening.test.ts`

**Interfaces:**
- Produces: `isTestingGrant(sentence, match): boolean` (internal). A permission match counts only when the governed span names a testing action.

- [ ] **Step 1: Failing tests**

```ts
it("account/setup permission never authorizes an out-of-scope resource", () => {
  expect(testingStatusOf(
    "The APIs for the developer portal are fully out of scope for this. " +
    "You may either use an existing account, or create new users as needed " +
    "using your @bugcrowdninja.com address.",
  )).toBe("unspecified");
  expect(statusOfSentence("You may use your @bugcrowdninja.com email address.")).toBeNull();
  expect(statusOfSentence("Each researcher may create one account per in-scope application.")).toBeNull();
});

it("keeps real testing grants allowed", () => {
  expect(statusOfSentence("You may test the listed targets.")).toBe("allowed");
  expect(statusOfSentence("Automated tooling is allowed for reconnaissance.")).toBe("allowed");
  expect(statusOfSentence("Researchers are permitted to test the API.")).toBe("allowed");
});
```

- [ ] **Step 2: Run — FAIL on the veto cases**

- [ ] **Step 3: Implement**

```ts
const TESTING_ACTION_WORD_RE =
  /\b(?:tests?|testing|scans?|scanning|scanners?|exploits?|exploiting|exploitation|attacks?|probes?|probing|fuzz\w*|pentest\w*|penetrat\w*|intrusions?|payloads?|bypass\w*|escalat\w*|pivot\w*|exfiltrat\w*|brute[\s-]?forc\w*|credential[\s-]?stuff\w*|password[\s-]?spray\w*|enumerat\w*|disrupt\w*|vulnerabilit\w*|intercept\w*|tamper\w*|inject\w*|impersonat\w*|spoof\w*|phish\w*|defac\w*|decompil\w*|reverse[\s-]?engineer\w*|fingerprint\w*|sniff\w*|reconnaissance|recon)\b/i;
const TESTING_NOUN_RE =
  /\b(?:testing|reconnaissance|recon|pentest\w*|penetration\s+testing|techniques?|methodolog\w+|tooling|tools?|scanners?|exploitation|attacks?|security\s+research)\b/i;

function isTestingGrant(sentence: string, m: { index: number; end: number; text: string }): boolean {
  if (TESTING_ACTION_WORD_RE.test(m.text)) return true;
  const after = sentence.slice(m.end);
  const before = sentence.slice(0, m.index);
  return (
    TESTING_ACTION_WORD_RE.test(after) ||
    TESTING_ACTION_WORD_RE.test(before) ||
    TESTING_NOUN_RE.test(before) ||
    techniqueMatches(before).length > 0 ||
    techniqueMatches(after).length > 0
  );
}
```

Rework `hasPermission` to iterate matches (Task 1 masking + this gate). Fail-closed: a grant whose governed text shows no testing action is not a permission.

- [ ] **Step 4: Run — PASS**

---

### Task 3: Eligibility frame + "not tolerated" prohibition (Atlassian P0 / Rapyd P1)

**Files:**
- Modify: `lib/model/policyText.ts`
- Test: `tests/policy-hardening.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it("reward eligibility never creates a testing status", () => {
  expect(statusOfSentence(
    "Only the latest version of a Data Center product is eligible for a reward.",
  )).toBeNull();
  expect(testingStatusOf(
    "Only the latest version of a Data Center product is eligible for a reward. " +
    "All vulnerabilities/exploits must be proven to work in the latest version of the Atlassian Data Center product.",
  )).toBe("unspecified");
});

it("reads 'will not be tolerated' as a prohibition", () => {
  expect(statusOfSentence(
    "Automated scanning against any contact/submission form will not be tolerated",
  )).toBe("prohibited");
  expect(statusOfSentence("Credential stuffing is not tolerated.")).toBe("prohibited");
});
```

- [ ] **Step 2: Run — FAIL** (current: `conditional` and `null`)

- [ ] **Step 3: Implement**

```ts
const ELIGIBILITY_FRAME_RE =
  /\b(?:eligib\w*|qualif\w+)\b[^.;]*\b(?:rewards?|bount\w+|payouts?|payments?|compensation|bonuses?)\b|\b(?:rewards?|bount\w+|payouts?|payments?|compensation)\b[^.;]*\b(?:eligib\w*|qualif\w+)\b/i;
const NOT_TOLERATED_RE = /\bnot\s+(?:be\s+)?tolerated\b/i;
```

In `statusOfSentence`: after the `!prohibited && !permitted && !explicitCond → null` check, add `if (explicitCond && !prohibited && !permitted && ELIGIBILITY_FRAME_RE.test(sentence)) return null;`. Add `NOT_TOLERATED_RE` to `PROHIBITION_RES` and `CLAUSE_SCOPE_RES` (it predicates on the clause subject).

- [ ] **Step 4: Run — PASS**

---

### Task 4: Technique identity specificity — noun prefix/suffix narrowing (Rapyd/Okta P1)

**Files:**
- Modify: `lib/model/policyText.ts` (`narrowedName`)
- Test: `tests/policy-hardening.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it("keeps modifier/complement specificity — no generic third-party fact", () => {
  const findings = techniqueFindingsIn(
    "Submit any necessary screenshots, screen captures, network requests, " +
    "reproduction steps, or similar using the Bugcrowd submission form " +
    "(do not use third-party file-sharing sites).",
  );
  expect(findings.some((f) => f.name === "third-party")).toBe(false);
  expect(findings.some((f) =>
    f.name === "third-party file-sharing sites" && f.status === "prohibited")).toBe(true);
});

it("narrows 'port scanning internal networks' — no blanket scanning fact", () => {
  const findings = techniqueFindingsIn(
    "If you have managed to compromise an Okta-owned server, we do not allow " +
    "escalations such as port scanning internal networks, privilege escalation " +
    "attempts, attempting to pivot to other systems.",
  );
  expect(findings.some((f) => f.name === "scanning")).toBe(false);
  const port = findings.find((f) => f.name === "port scanning internal networks");
  expect(port?.status).toBe("prohibited");
});
```

- [ ] **Step 2: Run — FAIL** (current names: `third-party`, `scanning`)

- [ ] **Step 3: Implement**

In `narrowedName`, before qualifier handling:

```ts
const PREFIX_STOP = new Set([...COMPLEMENT_STOP, "no","not","any","all","such","type","types","kind","sort","perform","performs","performing","use","uses","using","conduct","conducting","run","running","execute","executing","launch","launching","engage","engaging","carry","carrying","against","upon","via","through","across","of","per","within","into","onto","toward","towards","under","over","between","during","about","around","after","before","like","than","then","until","till","off","out","up","down","or","nor","yet","both","either","neither","each","every","some","several","various","including","include","includes","involve","involves","e.g","i.e","etc"]);
const SUFFIX_STOP = new Set([...PREFIX_STOP, "is","are","was","were","reveal","reveals","show","shows","lead","leads","result","results","mean","means","seem","seems","appear","appears","remain","remains","become","becomes","constitute","constitutes","represent","represents","violate","violates","exceed","exceeds","help","helps","allow","allows","make","makes","take","takes","give","gives","indicate","indicates","cover","covers","affect","affects","impact","impacts","contain","contains","remain","remains","target","targets","targeted","targeting","avoid","refrain","abstain","access","accessed","accessing","submit","submits","report","reports","stop","stops","cease","list","lists","see","describe","describes","state","states","note","notes","apply","applies","require","requires","need","needs","want","wants","feel","feels","get","gets","keep","keeps","let","lets","set","sets","put","puts","say","says","tell","tells","ask","asks","call","calls","name","names","term","terms"]);
const NOUNISH_RE = /^[a-z][\w/-]*$/;
```

- Prefix: if `span.modifier === undefined`, take the single word immediately before `span.start` (same clause — gap must be exactly whitespace) when it matches `NOUNISH_RE` and is not in `PREFIX_STOP` and not itself a technique span boundary → `base = "<prev> <span.text-or-def>"`. For `third-party`/`port scanning`/`burp scans`.
- Suffix: when no prepositional qualifier fired, take up to 2 following words each matching `NOUNISH_RE`, not in `SUFFIX_STOP`, lowercase-first-char → `base = "<base> <words>"`. For `file-sharing sites`, `internal networks`.
- Ordering: compute prefix from the original `span.text`; suffix applies to the span tail; qualifier `(against X)` still wraps the result.

- [ ] **Step 4: Run — PASS** (verify `automated scanning`, `automated scanners`, `automation (against form submissions)`, `scanning (of out-of-scope assets)` unchanged)

---

### Task 5: PII access object-split + context capture (Rapyd P1 / Okta §14)

**Files:**
- Modify: `lib/model/policyText.ts`, `lib/dom/policies.ts` (payload `contexts`)
- Test: `tests/policy-hardening.test.ts`

**Interfaces:**
- `TechniqueFinding` gains `contexts: string[]` (leading `if/when/after/once/should` clause text, empty when none).
- `PolicyData.techniques[]` gains `contexts: string[]` passthrough.

- [ ] **Step 1: Failing tests**

```ts
it("splits coordinated data-access objects into separate facts", () => {
  const findings = techniqueFindingsIn(
    "Do not access customer or employee personal information, credit card data, " +
    "and Rapyd confidential information.",
  );
  const names = findings.map((f) => f.name);
  expect(names).toContain("customer or employee personal information access");
  expect(names).toContain("credit card data access");
  expect(names).toContain("rapyd confidential information access");
  expect(names).not.toContain("PII access");
  expect(findings.every((f) => f.status === "prohibited")).toBe(true);
});

it("own-account rule and data-access rule never collide", () => {
  const a = techniqueFindingsIn("Only test on accounts you own. Do not attempt to access other merchants.");
  const b = techniqueFindingsIn("Do not access customer or employee personal information, credit card data, and Rapyd confidential information.");
  const keys = new Set([...a, ...b].map((f) => f.name));
  expect(a.some((f) => f.name === "cross-account testing" && f.status === "conditional")).toBe(true);
  for (const f of b) expect(keys.has(f.name)).toBe(true);
  // no shared fact key → no fake conflict
});

it("preserves post-compromise context on a narrow fact", () => {
  const findings = techniqueFindingsIn(
    "If you have managed to compromise an Okta-owned server, we do not allow escalations such as port scanning internal networks.",
  );
  expect(findings[0]?.contexts.join(" ")).toContain("compromise an Okta-owned server");
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
const ACCESS_VERB_G =
  /\b(?:do|does)\s+not\s+(access|copy|download|collect|retain|exfiltrate|dump|store|share|disclose|read|view)\w*\b|\bnever\s+(access|copy|download|collect|retain|exfiltrate|dump|store|share|disclose|read|view)\w*\b|\b(?:must|shall|may|can|could|will|would|should|might|cannot|can't)\s+not\s+(access|copy|download|collect|retain|exfiltrate|dump|store|share|disclose|read|view)\w*\b/gi;
const OBJECT_BOUNDARY_RE =
  /\bbut\b|\bhowever\b|\bbecause\b|\bsince\b|\bunless\b|\bexcept\b|\bprovided\b|\bif\b|\bwhen\b|\bwhile\b|\bto\b|\bin order\b|[.!?:;()]/i;
const RESOURCE_RE =
  /\b(?:data|information|pii|personal|confidential|credentials?|secrets?|records?|accounts?|customers?|employees?|merchants?|users?|cards?|systems?|servers?|networks?|assets?|content|files?|documents?|property|tokens?|keys?|passwords?|emails?|messages?|communications?|databases?|ips?)\b/i;

function accessObjects(sentence: string, spanStart: number): { verb: string; objects: string[] } | null {
  ACCESS_VERB_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACCESS_VERB_G.exec(sentence)) !== null) {
    if (m.index >= spanStart) continue;
    const cut = OBJECT_BOUNDARY_RE.exec(sentence.slice(m.index + m[0].length));
    const complement = sentence
      .slice(m.index + m[0].length, cut === null ? undefined : m.index + m[0].length + cut.index)
      .trim();
    if (!complement) continue;
    const objects = complement.split(",").map((p) =>
      normalizeText(p.replace(/^(?:and|or)\s+/i, "")).replace(/[.,;:!?]+$/, ""),
    ).filter((p) => p !== "" && RESOURCE_RE.test(p));
    if (objects.length === 0) continue;
    return { verb: (m[1] ?? "access").toLowerCase(), objects };
  }
  return null;
}
```

In `techniqueFindingsIn` survivor loop: when `span.def.name === "PII access"`, call `accessObjects`; on ≥1 objects emit one finding per object named `${obj} ${verb}` (suppress the plain finding). Context: `CONTEXT_LEAD_RE = /^(?:if|when|after|once|in the event(?:\s+that)?|should|assuming|upon)\s+([^,;]{3,160}?)(?:,|\bthen\b)/i` → `contextsOf(sentence)`; attach to every finding of the sentence.

- [ ] **Step 4: Run — PASS**

---

### Task 6: DOM subsection lane splitting (Mastercard P1)

**Files:**
- Modify: `lib/dom/domUtils.ts` (add `scopeBlocks`), `lib/dom/policies.ts`
- Test: `tests/policy-hardening.test.ts` (jsdom)

**Interfaces:**
- `scopeBlocks(scope: SectionScope): { el: Element; text: string; heading: boolean }[]` — document-order blocks incl. non-owning/sub-headings (bounded: heading members + blocks incl. headings; unbounded: owned items + non-first owned headings).

- [ ] **Step 1: Failing DOM test**

```ts
const { data } = collectPolicies(doc(`
  <section><h2>In-scope & Out of scope Vulnerabilities:</h2>
    <p>In-scope focused vulnerabilities:</p>
    <ul><li>Cross Site Scripting</li><li>Cross Site Request Forgery</li>
        <li>Insecure direct object references</li><li>Injection Vulnerabilities</li></ul>
    <p>Out of Scope vulnerabilities specifically excluded from the bounty:</p>
    <ul><li>Pivoting</li><li>scanning</li><li>vulnerability exploitation</li><li>Exfiltration</li></ul>
  </section>`), PAGE_URL);
expect(data.focusAreas).toEqual(expect.arrayContaining([
  "Cross Site Scripting", "Cross Site Request Forgery",
  "Insecure direct object references", "Injection Vulnerabilities",
]));
const texts = data.exclusions.map((e) => e.text);
for (const t of ["Pivoting", "scanning", "vulnerability exploitation", "Exfiltration"])
  expect(texts).toContain(t);
for (const t of ["Cross Site Scripting", "Injection Vulnerabilities"])
  expect(texts).not.toContain(t);
// focus areas never become testing permissions
for (const f of data.focusAreas) expect(f).toBeTruthy();
```

- [ ] **Step 2: Run — FAIL** (in-scope list currently lands in exclusions)

- [ ] **Step 3: Implement**

`domUtils.ts`: `blocksOfMarked` (like `blocksOf` but emits `{el, heading}` incl. headings) + `scopeBlocks(scope)` (bounded: `blocksOfMarked` over members; unbounded: owned headings except the first + `scope.items`; document-order via `inDocumentOrder`).

`policies.ts`:

```ts
type AreaLane = "focus" | "exclusion";
const LANE_RES: { lane: AreaLane; re: RegExp }[] = [
  { lane: "exclusion", re: /^(?:out[- ]?of[- ]?scope|out[- ]?scope|excluded|exclusions?|not\s+(?:eligible|accepted|covered|in\s+scope)|prohibited|disallowed|forbidden|banned|ineligible|non[- ]?qualifying)\b/i },
  { lane: "focus", re: /^(?:in[- ]?scope|focus(?:ed)?|priority|preferred|allowed|permitted|valid|accepted|eligible|qualifying|of\s+particular\s+interest)\b/i },
];
```

`subsectionLane(text, heading)`: heading → lane RE directly; else colon-ending → lane RE; else ≤8 words AND lane-prefix match AND verb-free label tail → lane. In `collectScope`, for `exclusions || keyPrefix === "focus-areas"` iterate `scopeBlocks(scope)`; a marker sets `lane`; items route to focus (`data.focusAreas` + `focus-areas` record) or exclusion (`data.nonFocusAreas` + `data.exclusions` + technique pass) regardless of which pass is running; default lane = the pass's own.

- [ ] **Step 4: Run — PASS**

---

### Task 7: Live-shape DOM regression — Atlassian/Rapyd/Okta/LastPass + structural invariants

**Files:**
- Test: `tests/policy-hardening.test.ts`

- [ ] DOM fixtures (jsdom `doc()` helper) asserting:
  - Atlassian exclusion `<li>` with the pivoting text → `testingStatus === "prohibited"`, `submissionStatus === "excluded"`.
  - Atlassian reward eligibility `<li>` → `testingStatus === "unspecified"`, `rewardStatus === "unspecified"`.
  - Mastercard exclusion `<li>` Developer APIs → `testingStatus !== "allowed"` (`unspecified`).
  - Rapyd third-party line → no `third-party` technique; `third-party file-sharing sites` prohibited.
  - Rapyd own-account + data-access lines → `cross-account testing` conditional; three separate `* access` prohibitions; zero same-name different-status pairs (no fake conflict).
  - Rapyd `will not be tolerated` line → narrow `automated scanning (against any contact/submission form)` prohibited; exclusion `testingStatus === "prohibited"`.
  - Okta post-compromise → `port scanning internal networks` prohibited; no `scanning` name; context preserved on the record.
  - Okta blanket lines → `automated tools`/`automated scanners`/`automated scanning` prohibited still emitted.
  - LastPass → `automated tools` conditional with `a maximum of 5 requests per second`.
  - Structural: for every `collectPolicies` result, `testingStatus === "allowed"` only when an explicit testing-governing grant exists (assert none of the new fixtures emits `allowed`).

- [ ] Run full suite + `npx tsc --noEmit` + `npm run build`; fix regressions.

- [ ] Commit `fix: harden permission polarity and policy scope parsing`.
