import { normalizeText } from "../canonical";
import {
  SCOPE_AUTHORIZATION_EXCLUSIVE_RE,
  SCOPE_BOUNDARY_RES,
  rewardStatusOf,
  techniqueFindingsIn,
  techniqueMatches,
  testingStatusOf,
} from "../model/policyText";
import type {
  ExtractionStatus,
  PermissionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  HEADING_SEL,
  SECTION_SEL,
  dlPairs,
  eachTextBlock,
  findAllSectionScopes,
  findSection,
  findSectionScope,
  rowCells,
  scopeVerdictColumn,
  tableBodyRows,
  itemsUnderHeading,
  precedingHeadingText,
  sectionHeading,
  sectionItems,
  slugify,
  textOf,
  uniqueSlug,
} from "./domUtils";

export interface PolicyData {
  safeHarborStatements: string[];
  authorizationStatements: string[];
  techniques: {
    /** Fact key — the taxonomy name, narrowed by an in-sentence qualifier. */
    name: string;
    /** The taxonomy entry the sentence named (unnarrowed). */
    baseName: string;
    status: PermissionStatus;
    conditions: string[];
    quote: string;
  }[];
  accountRules: string[];
  dataRules: string[];
  focusAreas: string[];
  nonFocusAreas: string[];
  /**
   * Excluded submission types on three independent axes (§11 domain-specific
   * states): the brief refusing a report says nothing about whether the
   * activity may be tested, so `testingStatus` stays `unspecified` unless the
   * line itself forbids the activity, and `rewardStatus` only drops to
   * `ineligible` on explicit reward language.
   */
  exclusions: {
    text: string;
    submissionStatus: "excluded";
    testingStatus: PermissionStatus;
    rewardStatus: "ineligible" | "unspecified";
  }[];
  /**
   * The exclusive authorization form ("testing is only authorized on …"),
   * which states one fact about listed targets and another about everything
   * else, both backed by the same sentence.
   */
  scopeAuthorization: {
    listedTargets: { status: PermissionStatus; conditions: string[] };
    unlistedTargets: { status: PermissionStatus };
    quote: string;
  } | null;
  reportingRequirements: string[];
  vrt: {
    version: string | null;
    baseline: string | null;
    exclusions: string[];
    deviations: string[];
    targetSpecific: string[];
    notes: string[];
    /**
     * The VRT scope-exclusion table (§4.4): vulnerability classes the program
     * rules in or out, with what they apply to. These are policy, never
     * assets — the row "Physical Security Issues" is not a target.
     */
    scopeRules: {
      category: string;
      vrtVersion: string | null;
      appliesTo: string | null;
      status: "out_of_scope" | "in_scope" | "conditional";
      note: string | null;
      /** The row's verbatim text — the record quote evidence resolves to. */
      quote: string;
    }[];
  };
}

const SECTION_RES = {
  safeHarbor: /safe\s*harbor/i,
  authorization: /authoriz|permission|consent|testing\s+authorization/i,
  programRules: /program\s+rules?|testing\s+rules?|rules\s+of\s+engagement|engagement\s+rules?|exploit\s+chain|testing\s+(?:guidelines?|requirements?)/i,
  account: /account|credential|registration|access\s+requirements?/i,
  data: /data|secret|retention|deletion|customer/i,
  focus: /focus\s+areas?|priority\s+(?:areas?|vuln)|areas?\s+of\s+(?:focus|interest)|of\s+particular\s+interest|in[- ]?scope\s+vuln/i,
  nonFocus: /out[- ]?of[- ]?scope|non[- ]?focus|excluded\s+(?:vuln|submission)|not\s+(?:accepted|eligible)/i,
  reporting: /report(?:ing)?\s+(?:requirements?|guidelines?|format(?:ting)?)|submission\s+(?:requirements?|guidelines?)/i,
  vrt: /vulnerability\s+rating\s+taxonomy|\bvrt\b|priority\s+ratings?|severity\s+ratings?/i,
} as const;

/**
 * Explicit authorization sentences, for briefs that state the testing boundary
 * in prose instead of under an Authorization heading. Every entry is a whole
 * phrase: a permission is classified from what a sentence says, never inferred
 * from a keyword appearing somewhere on the page.
 */
const AUTHORIZATION_SENTENCE_RES = [
  /\btesting\s+is\s+only\s+authoriz(?:ed|ation)\b/i,
  /\btesting\s+is\s+(?:not\s+)?(?:authorized|permitted|allowed)\b/i,
  /\btesting\s+is\s+restricted\s+to\b/i,
  /\btesting\s+is\s+permitted\b/i,
  /\bonly\s+authoriz(?:ed|ation)\s+(?:on|against|for|to)\b/i,
  /\bonly\s+permitted\s+(?:on|against|for|to)\b/i,
  /\bauthorized\s+to\s+test\b/i,
  /\bnot\s+authorized\b/i,
  /\bonly\s+test\b/i,
  /\bdo\s+not\s+test\b/i,
  // The grant stated from the program's side. OpenAI's brief never says
  // "testing is authorized"; it says what it can and cannot authorize, and
  // that boundary — research on its own systems, not on third parties — is
  // exactly the fact an agent needs before it touches anything.
  /\b(?:can|cannot|can\s?not|are\s+unable\s+to)\s+authorize\b/i,
  /\bauthorize\s+(?:your|any)\s+(?:research|testing|efforts?|activities)\b/i,
  /\bauthorized\s+testing\b/i,
];

/**
 * Record-dedupe key. Two records are duplicates only when the same normalized
 * text comes from the same canonical location; the same sentence under another
 * heading keeps its own record, so provenance is never collapsed away.
 */
function sectionKey(section: string, text: string): string {
  return JSON.stringify([section, text]);
}

/**
 * Scope-group headings ("In Scope", "Out of Scope Targets") label the target
 * inventory, which the targets collector owns. They are never policy sections,
 * so a policy pattern that happens to match one keeps looking.
 */
/** Cards/sections whose table is the VRT scope-exclusion table, not targets. */
const VRT_CARD_RE = /\bvrt\b|vulnerability rating taxonomy/i;
/** The scope verdict column of that table. */
const VRT_STATUS_RE = /^(?:out[- ]of[- ]scope|in[- ]scope|conditional)\b/i;

const SCOPE_GROUP_HEADING_RE =
  /^(?:in[- ]?scope|out[- ]?of[- ]?scope|out[- ]?scope)(?:\s+targets?)?$/i;

/**
 * List lead-ins ("Out of scope findings include (but are not limited to):",
 * "The following are excluded:") introduce the items; they are not items.
 */
const LEAD_IN_RE = /[:：]\s*$|^(?:the\s+)?following\b/i;

/** Keyword bucket for program-rule lines that match no technique. */
const FALLBACK_BUCKETS: { bucket: keyof PolicyData; re: RegExp }[] = [
  { bucket: "reportingRequirements", re: /submission|report|proof\s+of\s+concept|poc|evidence|attachment|duplicate/i },
  { bucket: "accountRules", re: /account|credential|email|password|register/i },
  { bucket: "dataRules", re: /data|secret|retention|delet|customer|pii/i },
];

/**
 * Corpus-wide rule classification. A statement is an account/data rule when it
 * names the domain AND reads like a rule — the gate keeps prose that merely
 * mentions "account" or "data" out of the constraint lists.
 */
const CORPUS_ACCOUNT_RE =
  /accounts?|credentials?|passwords?|@\S+|register|enroll|sign\s*up|log\s*in|authenticat/i;
const CORPUS_DATA_RE =
  /personal\s+(?:data|information)|\bpii\b|customer\s+data|user\s+data|access(?:ed|ing)?\s+(?:any\s+|of\s+|to\s+)?data|\bdata\s+access|secrets?|tokens?|private\s+keys?|retention|retain|delet|destroy|disclos|exfiltrat|clear(?:ed|ing)?\s+immediately|minimal(?:ly)?\s+(?:required|necessary)/i;
const RULE_SENTENCE_RE =
  /\bmust\b|\bshall\b|\bonly\b|prohibit|not\s+permitted|not\s+allowed|do(?:es)?\s+not|cannot|can't|never|require|permission|authoriz|allowed|forbidden|immediately|\bcease\b|\bstop\b|limited?\s+to|enroll|register|\buse\b/i;

function record(
  sourceKey: string,
  sourceLevel: SourceLevel,
  sourceUrl: string,
  locator: SourceLocator,
  quote: string,
  data: unknown,
  extractionStatus: ExtractionStatus = "exact",
): SourceRecord {
  return {
    sourceKey,
    sourceType: "dom",
    sourceLevel,
    sourceUrl,
    authenticated: true,
    locator,
    quote,
    extractionStatus,
    data,
  };
}

/**
 * Policy and safety content of the engagement brief (spec §4.3/§4.4):
 * safe harbor + authorization statements, per-technique permission rules
 * (allowed/prohibited/conditional only — normalizers emit unspecified),
 * account/data/focus/non-focus/reporting groups, and the VRT block.
 * SourceKeys follow the spec example `dom:details:<section>:<item-slug>`.
 */
export function collectPolicies(
  doc: Document,
  pageUrl: string,
): { records: SourceRecord[]; data: PolicyData } {
  const records: SourceRecord[] = [];
  const taken = new Set<string>();
  const data: PolicyData = {
    safeHarborStatements: [],
    authorizationStatements: [],
    techniques: [],
    accountRules: [],
    dataRules: [],
    focusAreas: [],
    nonFocusAreas: [],
    exclusions: [],
    scopeAuthorization: null,
    reportingRequirements: [],
    vrt: {
      version: null,
      baseline: null,
      exclusions: [],
      deviations: [],
      targetSpecific: [],
      notes: [],
      scopeRules: [],
    },
  };

  const emit = (
    section: string,
    slug: string,
    quote: string,
    payload: unknown,
    level: SourceLevel = "explicit_program_rule",
    status: ExtractionStatus = "exact",
    locator?: SourceLocator,
  ) => {
    records.push(
      record(
        `dom:details:${section}:${uniqueSlug(slug, taken)}`,
        level,
        pageUrl,
        locator ?? { section },
        quote,
        payload,
        status,
      ),
    );
  };

  // Only a heading that labels a scope *card* is the targets collector's; a
  // policy section may legitimately be called "Out of Scope" and still hold
  // vulnerability classes rather than assets.
  const skipScopeGroup = (h: Element, text: string): boolean => {
    if (!SCOPE_GROUP_HEADING_RE.test(text)) return false;
    const card = h.closest("li,article,[role='group']");
    return card !== null && card.querySelector("table") !== null;
  };

  /**
   * Per-sentence technique findings in one rule line (§11): a finding needs a
   * technique mention AND an explicit normative predicate in the same
   * sentence. Returns false when the line yields no findings, leaving the
   * caller to record it as plain text — a topic mention alone is evidence of
   * a subject, never of a permission.
   */
  const emitTechniques = (
    text: string,
    keyPrefix: string,
    locator: SourceLocator,
  ): boolean => {
    const findings = techniqueFindingsIn(text);
    if (findings.length === 0) return false;
    emittedTechniqueTexts.add(normalizeText(text));
    for (const finding of findings) {
      // A "conditional" assertion whose condition could not be extracted is
      // not exact evidence — downstream treats an empty condition list as
      // vacuously satisfied. Emit it partial so the fact stays unspecified
      // and reviewable rather than falsely permissive.
      const unconditioned =
        finding.status === "conditional" && finding.conditions.length === 0;
      const technique = {
        name: finding.name,
        baseName: finding.baseName,
        status: finding.status,
        conditions: finding.conditions,
        quote: text,
      };
      data.techniques.push(technique);
      emit(
        keyPrefix,
        finding.slug,
        text,
        technique,
        "explicit_program_rule",
        finding.ambiguous || unconditioned ? "partial" : "exact",
        locator,
      );
    }
    return true;
  };

  const collectList = (
    sectionRe: RegExp,
    keyPrefix: string,
    sink: string[],
    level: SourceLevel = "explicit_program_rule",
    seen?: Set<string>,
    /** Lines here are excluded submission types, not plain prose (§4.3). */
    exclusions = false,
  ): void => {
    const scopes = exclusions
      ? findAllSectionScopes(doc, sectionRe, skipScopeGroup)
      : [findSectionScope(doc, sectionRe, skipScopeGroup)].filter(
          (s): s is NonNullable<typeof s> => s !== null,
        );
    for (const scope of scopes) collectScope(scope, keyPrefix, sink, level, seen, exclusions);
  };

  const collectScope = (
    scope: ReturnType<typeof findSectionScope> & object,
    keyPrefix: string,
    sink: string[],
    level: SourceLevel,
    seen: Set<string> | undefined,
    exclusions: boolean,
  ): void => {
    const heading = scope.heading ?? keyPrefix;
    for (const item of scope.items) {
      if (seen !== null && seen !== undefined && seen.has(sectionKey(heading, item.text))) {
        continue;
      }
      // A list lead-in ("Out of scope findings include (but are not limited
      // to):") introduces the items; it is not itself an exclusion or a focus
      // area.
      if ((exclusions || keyPrefix === "focus-areas") && LEAD_IN_RE.test(item.text)) {
        continue;
      }
      seen?.add(sectionKey(heading, item.text));
      if (!sink.includes(item.text)) sink.push(item.text);
      if (exclusions) {
        const textKey = normalizeText(item.text);
        if (seenExclusionTexts.has(textKey)) continue;
        seenExclusionTexts.add(textKey);
        data.exclusions.push({
          text: item.text,
          submissionStatus: "excluded",
          testingStatus: testingStatusOf(item.text),
          rewardStatus: rewardStatusOf(item.text),
        });
      }
      if (exclusions && emitTechniques(item.text, keyPrefix, { section: heading })) {
        continue;
      }
      emit(keyPrefix, slugify(item.text), item.text, item.text, level, "exact", {
        section: heading,
      });
    }
  };

  const seenTexts = new Set<string>();
  // Exclusions dedupe on text, not (section, text): nested out-of-scope
  // subsections must not emit the same excluded finding twice.
  const seenExclusionTexts = new Set<string>();
  // Rule lines already emitted as technique assertions — the corpus-wide pass
  // below must not double-count them under a different section label.
  const emittedTechniqueTexts = new Set<string>();

  collectList(
    SECTION_RES.safeHarbor,
    "safe-harbor",
    data.safeHarborStatements,
    "explicit_program_rule",
    seenTexts,
  );
  collectList(
    SECTION_RES.authorization,
    "authorization",
    data.authorizationStatements,
    "explicit_program_rule",
    seenTexts,
  );

  // The classifier runs over the whole exact evidence corpus, not only the
  // Authorization-headed statements: an Authorization heading may describe a
  // product's permission model while the sentence that actually grants
  // testing sits in the scope block. The corpus list is kept separate from
  // the deduped statement sink so a record claimed under another section can
  // never starve the boundary classification.
  const authorizationCorpus: string[] = [];
  for (const { el, text } of eachTextBlock(doc)) {
    if (el.matches(HEADING_SEL)) continue;
    const classified =
      AUTHORIZATION_SENTENCE_RES.some((re) => {
        re.lastIndex = 0;
        return re.test(text);
      }) ||
      // Boundary phrasings ("anything not declared as a target is out of
      // scope") state the same authorization limit from the unlisted side.
      SCOPE_BOUNDARY_RES.some((re) => {
        re.lastIndex = 0;
        return re.test(text);
      });
    if (!classified) continue;
    authorizationCorpus.push(text);
    const section = precedingHeadingText(doc, el) ?? "Authorization";
    if (seenTexts.has(sectionKey(section, text))) continue;
    seenTexts.add(sectionKey(section, text));
    if (!data.authorizationStatements.includes(text)) {
      data.authorizationStatements.push(text);
    }
    emit(
      "authorization",
      slugify(text),
      text,
      text,
      "explicit_program_rule",
      "exact",
      { section },
    );
  }

  // One sentence can carry more than one policy class. The exclusive form
  // states a condition on the listed targets and a prohibition on everything
  // else — two facts over one sentence, neither a blanket "allowed". It takes
  // precedence over boundary phrasings, which state the same limit without
  // naming the listed side.
  for (const statement of authorizationCorpus) {
    if (data.scopeAuthorization !== null) break;
    SCOPE_AUTHORIZATION_EXCLUSIVE_RE.lastIndex = 0;
    const m = SCOPE_AUTHORIZATION_EXCLUSIVE_RE.exec(statement);
    if (m === null) continue;
    const listed = (m[1] ?? "").trim();
    // No record of its own: the sentence is already evidence, and both facts
    // resolve to that one evidence object rather than duplicating the quote.
    data.scopeAuthorization = {
      listedTargets: {
        status: "conditional",
        conditions: listed === "" ? [] : [listed],
      },
      unlistedTargets: { status: "prohibited" },
      quote: statement,
    };
  }
  if (data.scopeAuthorization === null) {
    for (const statement of authorizationCorpus) {
      const boundary = SCOPE_BOUNDARY_RES.some((re) => {
        re.lastIndex = 0;
        return re.test(statement);
      });
      if (!boundary) continue;
      data.scopeAuthorization = {
        listedTargets: {
          status: "conditional",
          conditions: ["target must be explicitly declared in scope"],
        },
        unlistedTargets: { status: "prohibited" },
        quote: statement,
      };
      break;
    }
  }

  // Program rules: per-technique permission statements. Every matching
  // section is read — a brief splits its testing rules across headings.
  for (const rulesScope of findAllSectionScopes(
    doc,
    SECTION_RES.programRules,
    skipScopeGroup,
  )) {
    const heading = rulesScope.heading ?? "Program Rules";
    let rowIndex = 0;
    for (const item of rulesScope.items) {
      const emitted = emitTechniques(item.text, "program-rules", {
        section: heading,
        rowIndex,
      });
      if (!emitted) {
        // Rule line stating no permission fact — whether it names a known
        // technique or not. A mention without a normative predicate is still
        // evidence worth keeping, just never as a technique assertion.
        const bucket = FALLBACK_BUCKETS.find((b) => {
          b.re.lastIndex = 0;
          return b.re.test(item.text);
        });
        if (bucket !== undefined && Array.isArray(data[bucket.bucket])) {
          const list = data[bucket.bucket] as string[];
          if (!list.includes(item.text)) list.push(item.text);
        }
        emit(
          "program-rules",
          slugify(item.text),
          item.text,
          item.text,
          "explicit_program_rule",
          "exact",
          { section: heading, rowIndex },
        );
      }
      rowIndex++;
    }
  }

  collectList(SECTION_RES.account, "account-rules", data.accountRules, "explicit_program_rule", seenTexts);
  collectList(SECTION_RES.data, "data-rules", data.dataRules, "explicit_program_rule", seenTexts);
  collectList(SECTION_RES.focus, "focus-areas", data.focusAreas, "explicit_program_rule", seenTexts);
  // Excluded submission types carry two axes: every line is a submission
  // exclusion, and only a line that forbids the activity itself also states a
  // testing rule.
  collectList(SECTION_RES.nonFocus, "non-focus-areas", data.nonFocusAreas, "explicit_program_rule", seenTexts, true);
  collectList(SECTION_RES.reporting, "reporting-requirements", data.reportingRequirements, "explicit_program_rule", seenTexts);

  // VRT scope-exclusion tables (§4.4), wherever the brief renders them. On a
  // multi-group brief this table sits among the scope cards, which is exactly
  // why the targets collector must leave it alone.
  const vrtTables = [...doc.querySelectorAll("table")].filter((table) => {
    if (scopeVerdictColumn(table) !== null) return true;
    const card = table.closest("li,article,[role='group'],section");
    return card !== null && VRT_CARD_RE.test(sectionHeading(card) ?? "");
  });
  for (const table of vrtTables) {
    for (const [rowIndex, tr] of tableBodyRows(table).entries()) {
      const cells = rowCells(tr).map((cell) => textOf(cell));
      if (cells.length === 0) continue;
      const statusIndex =
        scopeVerdictColumn(table) ??
        cells.findIndex((cell) => VRT_STATUS_RE.test(cell));
      const first = cells[0] ?? "";
      if (first === "" || statusIndex <= 0) continue;
      const version = /\(\s*(\d+(?:\.\d+)*)\s*\)\s*$/.exec(first);
      const category = normalizeText(
        version === null ? first : first.slice(0, version.index),
      );
      const appliesTo = normalizeText(
        cells.slice(1, statusIndex).join(" "),
      );
      const note = normalizeText(cells.slice(statusIndex + 1).join(" "));
      const statusText = cells[statusIndex] ?? "";
      const rule = {
        category,
        vrtVersion: version?.[1] ?? null,
        appliesTo: appliesTo === "" ? null : appliesTo,
        status: /conditional/i.test(statusText)
          ? ("conditional" as const)
          : /^in[- ]scope/i.test(statusText)
            ? ("in_scope" as const)
            : ("out_of_scope" as const),
        note: note === "" || note === "-" || note === "—" ? null : note,
        quote: cells.join(" "),
      };
      data.vrt.scopeRules.push(rule);
      emit(
        "vrt",
        `scope-rule-${slugify(category)}`,
        cells.join(" "),
        rule,
        rule.status === "conditional" ? "vrt_deviation" : "default_vrt",
        "exact",
        {
          section: sectionHeading(
            table.closest("li,article,[role='group'],section")!,
          ) ?? "VRT",
          table: "vrt_scope_rules",
          rowIndex,
        },
      );
    }
  }

  // VRT block (spec §4.4).
  const vrtSection = findSection(doc, SECTION_RES.vrt);
  if (vrtSection !== null) {
    const vrtHeading = sectionHeading(vrtSection) ?? "Vulnerability Rating Taxonomy";
    const pairs = dlPairs(vrtSection);
    const versionPair = pairs.find((p) => /version|vrt/i.test(p.label));
    const baselinePair = pairs.find((p) => /baseline|default/i.test(p.label));
    if (versionPair !== undefined) {
      data.vrt.version = textOf(versionPair.dd) || null;
    }
    if (data.vrt.version === null) {
      const m =
        /vrt[^\d]*(\d+\.\d+(?:\.\d+)?)/i.exec(textOf(vrtSection)) ??
        /version\s*[:=]?\s*(\d+(?:\.\d+)*)/i.exec(textOf(vrtSection));
      if (m !== null) data.vrt.version = m[1] ?? null;
    }
    if (baselinePair !== undefined) {
      data.vrt.baseline = textOf(baselinePair.dd) || null;
    }
    if (data.vrt.baseline === null) {
      const block = sectionItems(vrtSection).find((i) =>
        /baseline|default/i.test(i.text),
      );
      if (block !== undefined) data.vrt.baseline = block.text;
    }
    if (data.vrt.version !== null) {
      emit("vrt", "version", String(data.vrt.version), data.vrt.version, "default_vrt", "exact", {
        section: vrtHeading,
      });
    }
    if (data.vrt.baseline !== null) {
      emit("vrt", "baseline", data.vrt.baseline, data.vrt.baseline, "default_vrt", "exact", {
        section: vrtHeading,
      });
    }

    const vrtGroups: {
      key: "exclusions" | "deviations" | "targetSpecific" | "notes";
      re: RegExp;
      subsection: string;
      level: SourceLevel;
    }[] = [
      { key: "exclusions", re: /exclusions?|not\s+covered|does\s+not\s+apply/i, subsection: "Exclusions", level: "default_vrt" },
      { key: "deviations", re: /deviations?|exceptions?|overrides?|differs/i, subsection: "Deviations", level: "vrt_deviation" },
      { key: "targetSpecific", re: /target[- ]?specific|per[- ]?target|specific\s+targets?/i, subsection: "Target-specific", level: "vrt_deviation" },
      { key: "notes", re: /notes?|additional|remarks?/i, subsection: "Notes", level: "default_vrt" },
    ];
    for (const g of vrtGroups) {
      for (const el of itemsUnderHeading(vrtSection, g.re)) {
        const text = textOf(el);
        if (text === "") continue;
        data.vrt[g.key].push(text);
        emit("vrt", slugify(text), text, text, g.level, "exact", {
          section: vrtHeading,
          subsection: g.subsection,
        });
      }
    }
  }

  // Corpus-wide passes. Heading-bounded collection misses rules authored in
  // sections a heading pattern does not know (Pinterest puts its account and
  // data rules under "Testing Guidelines"/"Terms and Conditions"). A rule is
  // a rule wherever it sits, so the whole text corpus is scanned; provenance
  // is the nearest preceding heading, not a guessed section name.
  for (const { el, text } of eachTextBlock(doc)) {
    if (el.matches(HEADING_SEL)) continue;
    if (techniqueMatches(text).length === 0) continue;
    if (emittedTechniqueTexts.has(normalizeText(text))) continue;
    if (testingStatusOf(text) === "unspecified") continue;
    emitTechniques(text, "program-rules", {
      section: precedingHeadingText(doc, el) ?? "Program Rules",
    });
  }

  for (const { el, text } of eachTextBlock(doc)) {
    if (el.matches(HEADING_SEL)) continue;
    const isAccount = CORPUS_ACCOUNT_RE.test(text);
    const isData = CORPUS_DATA_RE.test(text);
    if (!isAccount && !isData) continue;
    RULE_SENTENCE_RE.lastIndex = 0;
    if (!RULE_SENTENCE_RE.test(text)) continue;
    const section = precedingHeadingText(doc, el) ?? "Program Rules";
    if (isAccount && !data.accountRules.includes(text)) {
      data.accountRules.push(text);
      emit("account-rules", slugify(text), text, text, "explicit_program_rule", "exact", {
        section,
      });
    }
    if (isData && !data.dataRules.includes(text)) {
      data.dataRules.push(text);
      emit("data-rules", slugify(text), text, text, "explicit_program_rule", "exact", {
        section,
      });
    }
  }

  return { records, data };
}
