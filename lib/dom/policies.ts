import type {
  ExtractionStatus,
  PermissionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  dlPairs,
  findSection,
  itemsUnderHeading,
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
  reportingRequirements: string[];
  vrt: {
    version: string | null;
    baseline: string | null;
    exclusions: string[];
    deviations: string[];
    targetSpecific: string[];
    notes: string[];
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
  { name: "cross-tenant", slug: "cross-tenant", re: /cross[\s-]?tenant|other\s+(?:customers?|tenants?|organizations?|orgs?|users?)\b/i },
  { name: "third-party", slug: "third-party", re: /third[\s-]?part(?:y|ies)/i },
  { name: "PII access", slug: "pii-access", re: /\bpii\b|personally\s+identifiable|personal\s+(?:data|information)/i },
  { name: "data exfiltration", slug: "data-exfiltration", re: /exfiltrat|data\s+theft|dump(?:ing)?\s+(?:data|databases?)/i },
  { name: "persistent access", slug: "persistent-access", re: /persist(?:ent|ence)|backdoor|web\s*shell|maintain(?:ing)?\s+access/i },
];

const PROHIBITED_RE =
  /prohibit|forbidden|not\s+permitted|not\s+allowed|may\s+not|must\s+not|do(?:es)?\s+not|cannot|can't|won't|never|banned|disallowed|not\s+authorized/i;
const QUALIFIED_PROHIBITION_RE =
  /(?:prohibit|forbidden|not\s+permitted|may\s+not|must\s+not|do(?:es)?\s+not|cannot)[^.;]*\b(?:unless|except\s+(?:when|if|for|with|upon)|only\s+(?:on|during|when|if))\b/i;
const CONDITIONAL_RE =
  /permitted\s+only|allowed\s+only|authorized\s+only|\bonly\s+(?:against|with|for|if|when|on|to|after|within|from|during|under|by|in)\b|with\s+(?:prior\s+)?(?:written\s+)?(?:approval|authorization|permission|consent)|requires?\s+(?:prior\s+)?(?:approval|permission|authorization|consent)|provided\s+(?:that|you)|as\s+long\s+as|subject\s+to|limited\s+to|approved\s+in\s+advance|except\s+(?:when|if|for|with|upon)|\bunless\b/i;
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
  /\bexcept\s+(when|if|for|with|upon)\s+([^.;]+)/i,
  /\blimited\s+to\s+([^.;]+)/i,
];

/** allowed/prohibited/conditional from rule text; null → unspecified. */
function statusOf(text: string): PermissionStatus | null {
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
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m === null) continue;
    const clause = (m.length > 2 ? `${m[1]} ${m[2]}` : (m[1] ?? m[0])).trim();
    const normalized = clause.replace(/\s+/g, " ");
    if (normalized !== "" && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

const SECTION_RES = {
  safeHarbor: /safe\s*harbor/i,
  authorization: /authoriz|permission|consent|testing\s+authorization/i,
  programRules: /program\s+rules?|testing\s+rules?|rules\s+of\s+engagement|engagement\s+rules?/i,
  account: /account|credential|registration|access\s+requirements?/i,
  data: /data|secret|retention|deletion|customer/i,
  focus: /focus\s+areas?|priority\s+(?:areas?|vuln)|areas?\s+of\s+focus|in[- ]?scope\s+vuln/i,
  nonFocus: /out[- ]?of[- ]?scope|non[- ]?focus|excluded\s+vuln|not\s+(?:accepted|eligible)/i,
  reporting: /reporting\s+requirements?|submission\s+requirements?|report\s+guidelines?|submission\s+guidelines?/i,
  vrt: /vulnerability\s+rating\s+taxonomy|\bvrt\b|priority\s+ratings?|severity\s+ratings?/i,
} as const;

/** Keyword bucket for program-rule lines that match no technique. */
const FALLBACK_BUCKETS: { bucket: keyof PolicyData; re: RegExp }[] = [
  { bucket: "reportingRequirements", re: /submission|report|proof\s+of\s+concept|poc|evidence|attachment|duplicate/i },
  { bucket: "accountRules", re: /account|credential|email|password|register/i },
  { bucket: "dataRules", re: /data|secret|retention|delet|customer|pii/i },
];

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
    reportingRequirements: [],
    vrt: {
      version: null,
      baseline: null,
      exclusions: [],
      deviations: [],
      targetSpecific: [],
      notes: [],
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

  const collectList = (
    sectionRe: RegExp,
    keyPrefix: string,
    sink: string[],
    level: SourceLevel = "explicit_program_rule",
    seen?: Set<string>,
  ): Element | null => {
    const section = findSection(doc, sectionRe);
    if (section === null) return null;
    const heading = sectionHeading(section) ?? keyPrefix;
    for (const item of sectionItems(section)) {
      if (seen !== null && seen !== undefined && seen.has(item.text)) continue;
      seen?.add(item.text);
      sink.push(item.text);
      emit(keyPrefix, slugify(item.text), item.text, item.text, level, "exact", {
        section: heading,
      });
    }
    return section;
  };

  const seenTexts = new Set<string>();

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

  // Program rules: per-technique permission statements.
  const rulesSection = findSection(doc, SECTION_RES.programRules);
  if (rulesSection !== null) {
    const heading = sectionHeading(rulesSection) ?? "Program Rules";
    let rowIndex = 0;
    for (const item of sectionItems(rulesSection)) {
      const matched = TECHNIQUES.filter((t) => {
        t.re.lastIndex = 0;
        return t.re.test(item.text);
      });
      const status = matched.length > 0 ? statusOf(item.text) : null;
      const multi = matched.length > 1;
      let anyEmitted = false;
      for (const tech of matched) {
        if (status === null) continue; // unspecified → normalizers' job
        const conditions =
          status === "conditional" ? conditionsOf(item.text) : [];
        const technique = {
          name: tech.name,
          status,
          conditions,
          quote: item.text,
        };
        data.techniques.push(technique);
        // Clause attribution is heuristic when one line names several
        // techniques → partial; clean single-technique lines are exact.
        emit(
          "program-rules",
          tech.slug,
          item.text,
          technique,
          "explicit_program_rule",
          multi ? "partial" : "exact",
          { section: heading, rowIndex },
        );
        anyEmitted = true;
      }
      if (!anyEmitted && matched.length === 0) {
        // Rule line naming no known technique: bucket it by keywords so the
        // statement is preserved; record keeps its real section.
        const bucket = FALLBACK_BUCKETS.find((b) => {
          b.re.lastIndex = 0;
          return b.re.test(item.text);
        });
        if (bucket !== undefined && Array.isArray(data[bucket.bucket])) {
          if (!seenTexts.has(item.text)) {
            seenTexts.add(item.text);
            (data[bucket.bucket] as string[]).push(item.text);
          }
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
  collectList(SECTION_RES.nonFocus, "non-focus-areas", data.nonFocusAreas, "explicit_program_rule", seenTexts);
  collectList(SECTION_RES.reporting, "reporting-requirements", data.reportingRequirements, "explicit_program_rule", seenTexts);

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

  return { records, data };
}
