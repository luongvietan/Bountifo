import { normalizeText } from "../canonical";
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
    name: string;
    status: PermissionStatus;
    conditions: string[];
    quote: string;
  }[];
  accountRules: string[];
  dataRules: string[];
  focusAreas: string[];
  nonFocusAreas: string[];
  /**
   * Excluded submission types as two independent axes (§11 domain-specific
   * states): the brief refusing a report says nothing about whether the
   * activity may be tested, so `testingStatus` stays `unspecified` unless the
   * line itself forbids the activity.
   */
  exclusions: {
    text: string;
    submissionStatus: "excluded";
    testingStatus: PermissionStatus;
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
    }[];
  };
}

// Spec §4.3 technique names with semantic keyword patterns.
const TECHNIQUES: { name: string; slug: string; re: RegExp }[] = [
  { name: "automation", slug: "automation", re: /\bautomat(?:ed|ion|ic)\b/i },
  { name: "scanning", slug: "scanning", re: /\bscans?\b|\bscanning\b|\bscanner/i },
  { name: "brute force", slug: "brute-force", re: /brute[\s-]?force|credential\s*stuff/i },
  { name: "denial of service", slug: "denial-of-service", re: /denial[\s-]?of[\s-]?service|\b(?:d?dos)\b/i },
  { name: "social engineering", slug: "social-engineering", re: /social[\s-]?engineer|phishing|vishing|smishing|impersonat/i },
  { name: "physical testing", slug: "physical-testing", re: /physical(?:ly)?[\s-]?(?:test|access|attack|security|offices?|data\s*cent)/i },
  { name: "credential testing", slug: "credential-testing", re: /credential[\s-]?test|test(?:ing)?\s+(?:of\s+)?credentials?|login\s+attempts?/i },
  { name: "multi-account", slug: "multi-account", re: /multi(?:ple)?[\s-]?accounts?|multiple\s+accounts?|account\s+sharing|shared\s+accounts?/i },
  // "cross-tenant" stays the generic bucket. The two rules below are the
  // distinction a brief actually draws: testing between accounts you own is
  // usually invited, touching another customer's data never is.
  { name: "cross-tenant", slug: "cross-tenant", re: /cross[\s-]?tenant|cross[\s-]?client|cross[\s-]?organi[sz]ation/i },
  { name: "cross-account testing", slug: "cross-account-testing", re: /cross[\s-]?account|accounts?\s+that\s+you\s+own/i },
  // Subject must be another *party* — "other accounts' services" is the
  // researcher's own second account, which the cross-account rule governs.
  { name: "other customer data", slug: "other-customer-data", re: /(?:other|another)\s+(?:users?|customers?|tenants?)(?:'|’)?s?\s+(?:data|services?|accounts?|information)/i },
  { name: "third-party", slug: "third-party", re: /third[\s-]?part(?:y|ies)/i },
  { name: "PII access", slug: "pii-access", re: /\bpii\b|personally\s+identifiable|personal\s+(?:data|information)|(?:access|accessed|accessing|retain(?:ed|ing)?|cop(?:y|ied|ying)|download(?:ed|ing)?|collect(?:ed|ing)?)\s+(?:any\s+|user\s+|customer\s+|personal\s+)*data\b|\bdata\s+accessed\b/i },
  { name: "data exfiltration", slug: "data-exfiltration", re: /exfiltrat|data\s+theft|dump(?:ing)?\s+(?:data|databases?)/i },
  { name: "persistent access", slug: "persistent-access", re: /persist(?:ent|ence)|backdoor|web\s*shell|maintain(?:ing)?\s+access/i },
];

/** Spec §4.3 techniques a rule line names, in declaration order. */
function techniqueMatches(text: string): typeof TECHNIQUES {
  return TECHNIQUES.filter((t) => {
    t.re.lastIndex = 0;
    return t.re.test(text);
  });
}

const PROHIBITED_RE =
  /prohibit|forbidden|not\s+permitted|not\s+allowed|may\s+not|must\s+not|do(?:es)?\s+not|cannot|can't|won't|never|banned|disallowed|not\s+authorized/i;
const QUALIFIED_PROHIBITION_RE =
  /(?:prohibit|forbidden|not\s+permitted|may\s+not|must\s+not|do(?:es)?\s+not|cannot)[^.;]*\b(?:unless|except\s+(?:when|if|for|with|upon)|except\s+to\s+the\s+extent|only\s+(?:on|during|when|if))\b/i;
const CONDITIONAL_RE =
  /permitted\s+only|allowed\s+only|authorized\s+only|\bonly\s+(?:against|with|for|if|when|on|to|after|within|from|during|under|by|in)\b|with\s+(?:prior\s+)?(?:written\s+)?(?:approval|authorization|permission|consent)|requires?\s+(?:prior\s+)?(?:approval|permission|authorization|consent)|provided\s+(?:that|you)|as\s+long\s+as|subject\s+to|limited\s+to|approved\s+in\s+advance|except\s+(?:when|if|for|with|upon)|except\s+to\s+the\s+extent|\bunless\b/i;
const ALLOWED_RE =
  /(?:is|are)\s+(?:permitted|allowed|authorized|encouraged|welcomed)|may\s+(?:be\s+)?(?:tested|used|performed|conducted)|\bpermitted\b|\ballowed\b|\bauthorized\b|\bencouraged\b|\bwelcomed\b/i;

const CONDITION_CLAUSE_RES = [
  /\bonly\s+(against|with|for|if|when|on|to|after|within|from|during|under|by|in)\s+([^.;]+)/i,
  /\bwith\s+(prior\s+)?(written\s+)?(approval|authorization|permission|consent)(?:\s+from\s+([^.;]+))?/i,
  /\bprovided\s+(?:that\s+)?([^.;]+)/i,
  /\bas\s+long\s+as\s+([^.;]+)/i,
  /\bsubject\s+to\s+([^.;]+)/i,
  /\brequires?\s+([^.;]+)/i,
  /\bunless\s+([^.;]+)/i,
  /\buse\s+only\s+([^.;]+)/i,
  /\bonly\s+(?:use|test|target|interact)(?:\s*\/\s*\w+)*\s+(?:with\s+|on\s+|against\s+)?([^.;]+)/i,
  /\bexcept\s+(when|if|for|with|upon)\s+([^.;]+)/i,
  /\bexcept\s+to\s+the\s+extent\s+([^.;]+)/i,
  /\blimited\s+to\s+([^.;]+)/i,
  /\bif\s+([^.;]+)/i,
  /\bmust\s+not\s+(?:be\s+)?([^.;]+)/i,
];

/**
 * "Use only X" / "only test X" states a condition on the activity itself. It
 * outranks an incidental negation elsewhere in the sentence, which usually
 * describes the attack scenario rather than the rule.
 */
const EXPLICIT_CONDITION_RE =
  /\buse\s+only\s+[^.;]+|\bonly\s+(?:use|test|target|interact)(?:\s*\/\s*\w+)*(?:\s+with|\s+on|\s+against)?\b[^.;]+/i;

/** allowed/prohibited/conditional from rule text; null → unspecified. */
function statusOf(text: string): PermissionStatus | null {
  EXPLICIT_CONDITION_RE.lastIndex = 0;
  if (EXPLICIT_CONDITION_RE.test(text)) return "conditional";
  const prohibited = PROHIBITED_RE.test(text);
  const qualified = QUALIFIED_PROHIBITION_RE.test(text);
  if (prohibited && !qualified) return "prohibited";
  if (qualified || CONDITIONAL_RE.test(text)) return "conditional";
  if (prohibited) return "prohibited";
  if (ALLOWED_RE.test(text)) return "allowed";
  return null;
}

/** Condition clauses lifted from the rule text (normalized). */
function conditionsOf(text: string): string[] {
  const out: string[] = [];
  for (const re of CONDITION_CLAUSE_RES) {
    // Every occurrence of each clause shape is a distinct condition — a
    // sentence may carry two "if …" clauses.
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      const clause = (m.length > 2 ? `${m[1]} ${m[2]}` : (m[1] ?? m[0])).trim();
      const normalized = clause.replace(/\s+/g, " ");
      if (normalized !== "" && !out.includes(normalized)) out.push(normalized);
      if (m[0] === "") global.lastIndex++;
    }
  }
  return out;
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
];

/**
 * The exclusive form of an authorization sentence. "Only authorized on X"
 * asserts two things at once — X is testable under that condition, and
 * anything outside X is not — so it yields two facts over one evidence object.
 */
const SCOPE_AUTHORIZATION_RE =
  /\btesting\s+is\s+only\s+authorized\s+(?:on|against|for)\s+([^.;]+)/i;

/**
 * Sentences that refuse a *report* rather than an activity. A brief may reject
 * a submission type in prohibitive words ("do not submit …", "reports … will
 * not be accepted") while saying nothing about testing, so these lines never
 * establish a testing status (§11: no asserted status without explicit
 * evidence).
 */
const SUBMISSION_EXCLUSION_RES = [
  /\b(?:reports?|submissions?|findings?)\b[^.;]*\b(?:not\s+(?:be\s+)?(?:accepted|eligible|rewarded|valid)|will\s+be\s+closed|are\s+excluded)/i,
  /\bdo(?:es)?\s+not\s+(?:submit|report)\b/i,
  /\bnot\s+eligible\s+for\s+(?:an?\s+)?(?:reward|bounty|payout|payment)/i,
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
 * Testing status a line asserts about the activity itself; `unspecified` when
 * the line is framed around what the program will accept.
 */
function testingStatusOf(text: string): PermissionStatus {
  for (const re of SUBMISSION_EXCLUSION_RES) {
    re.lastIndex = 0;
    if (re.test(text)) return "unspecified";
  }
  return statusOf(text) ?? "unspecified";
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
   * Per-technique permission statements in one rule line. Returns false when
   * the line names no technique or states no status, leaving the caller to
   * record the line as plain text.
   */
  const emitTechniques = (
    text: string,
    keyPrefix: string,
    locator: SourceLocator,
  ): boolean => {
    const matched = techniqueMatches(text);
    if (matched.length === 0) return false;
    const status = testingStatusOf(text);
    if (status === "unspecified") return false; // normalizers' job
    const conditions = status === "conditional" ? conditionsOf(text) : [];
    // One line may back several facts and still be exact evidence: a brief
    // that forbids three named activities in one sentence has said so about
    // each of them. Attribution is only guesswork when the same line asserts
    // opposite polarities without naming which activity takes which.
    EXPLICIT_CONDITION_RE.lastIndex = 0;
    const mixed =
      ALLOWED_RE.test(text) &&
      PROHIBITED_RE.test(text) &&
      !EXPLICIT_CONDITION_RE.test(text);
    // A "conditional" assertion whose condition could not be extracted is not
    // exact evidence — downstream treats conditional with an empty condition
    // list as vacuously satisfied. Emit it partial so the fact stays
    // unspecified and reviewable rather than falsely permissive.
    const unconditioned = status === "conditional" && conditions.length === 0;
    emittedTechniqueTexts.add(normalizeText(text));
    for (const tech of matched) {
      const technique = { name: tech.name, status, conditions, quote: text };
      data.techniques.push(technique);
      emit(
        keyPrefix,
        tech.slug,
        text,
        technique,
        "explicit_program_rule",
        mixed || unconditioned ? "partial" : "exact",
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
    const classified = AUTHORIZATION_SENTENCE_RES.some((re) => {
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
  // else — two facts over one sentence, neither a blanket "allowed".
  for (const statement of authorizationCorpus) {
    if (data.scopeAuthorization !== null) break;
    SCOPE_AUTHORIZATION_RE.lastIndex = 0;
    const m = SCOPE_AUTHORIZATION_RE.exec(statement);
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
      const named = techniqueMatches(item.text).length > 0;
      const emitted = emitTechniques(item.text, "program-rules", {
        section: heading,
        rowIndex,
      });
      if (!emitted && !named) {
        // Rule line naming no known technique: bucket it by keywords so the
        // statement is preserved; record keeps its real section.
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
