import { normalizeText } from "../canonical";
import type { PermissionStatus } from "../types";

/**
 * Sentence-level semantics for policy text (spec §11).
 *
 * A permission fact needs BOTH a recognized technique/action mention AND an
 * explicit researcher-facing normative predicate in the same sentence. A
 * topic keyword alone — "PII", "automation", "third-party" — never
 * establishes a fact, and a sentence that only states submission or reward
 * eligibility ("will be closed as Not Applicable", "are excluded", "out of
 * scope") says nothing about what may be tested. Ambiguous polarity fails
 * closed: the caller marks the record partial and the fact builder resolves
 * it to `unspecified` (REVIEW), never a guessed ALLOW/DENY.
 */

export interface TechniqueDef {
  name: string;
  slug: string;
  re: RegExp;
}

// Spec §4.3 technique names with semantic keyword patterns. A match only
// marks the topic as present in the sentence; whether the sentence *says*
// anything about it is decided by the normative-predicate classifier below.
export const TECHNIQUES: TechniqueDef[] = [
  { name: "automation", slug: "automation", re: /\bautomat(?:e|es|ed|ing|ion|ic)\b/i },
  { name: "scanning", slug: "scanning", re: /\bscans?\b|\bscanning\b|\bscanners?\b/i },
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
  { name: "cross-account testing", slug: "cross-account-testing", re: /cross[\s-]?account|accounts?\s+(?:that\s+)?you\s+own/i },
  // Subject must be another *party* — "other accounts' services" is the
  // researcher's own second account, which the cross-account rule governs.
  { name: "other customer data", slug: "other-customer-data", re: /(?:other|another)\s+(?:users?|customers?|tenants?)(?:'|’)?s?\s+(?:data|services?|accounts?|information)/i },
  { name: "third-party", slug: "third-party", re: /third[\s-]?part(?:y|ies)/i },
  { name: "PII access", slug: "pii-access", re: /\bpii\b|personally\s+identifiable|personal\s+(?:data|information)|(?:access|accessed|accessing|retain(?:ed|ing)?|cop(?:y|ied|ying)|download(?:ed|ing)?|collect(?:ed|ing)?)\s+(?:any\s+|user\s+|customer\s+|personal\s+)*data\b|\bdata\s+accessed\b/i },
  { name: "data exfiltration", slug: "data-exfiltration", re: /exfiltrat|data\s+theft|dump(?:ing)?\s+(?:data|databases?)/i },
  { name: "persistent access", slug: "persistent-access", re: /persist(?:ent|ence)|backdoor|web\s*shell|maintain(?:ing)?\s+access/i },
];

/** Spec §4.3 techniques a text names, in declaration order (mention only). */
export function techniqueMatches(text: string): TechniqueDef[] {
  return TECHNIQUES.filter((t) => {
    t.re.lastIndex = 0;
    return t.re.test(text);
  });
}

/**
 * Clause-level split: semicolons always separate; periods/question/bang only
 * when followed by a capital/digit/quote — "e.g. phishing" and "1. keep" must
 * not split mid-sentence.
 */
export function sentencesOf(text: string): string[] {
  return normalizeText(text)
    .split(/(?<=;)\s+|(?<=[.!?])\s+(?=[A-Z0-9"“'‘(\[])/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// Normative predicates. A predicate is a permission/prohibition directed at
// researcher activity — modal negations, copula prohibitions, imperatives,
// enforcement consequences — never a bare topic word, a capability statement
// ("can be used"), or eligibility vocabulary ("excluded", "out of scope").
// ---------------------------------------------------------------------------

/** Researcher-facing subjects that can front an imperative directive. */
const DIRECTIVE_SUBJECT =
  "(?:you|researchers?|testers?|hackers?|participants?)";

/**
 * Verbs of testing activity. Submission verbs (submit/report/file) and state
 * verbs (own/belong/demonstrate) are deliberately absent: "do not submit" is
 * a submission rule, "data you do not own" is a scope description.
 */
const ACTION_VERB =
  "(?:test|tests|tested|testing|scan|scans|scanned|scanning|access|accessed|accessing|accesses|exploit|exploits|exploited|exploiting|attack|attacks|attacked|attacking|perform|performs|performed|conduct|conducts|conducted|conducting|target|targets|targeted|targeting|attempt|attempts|attempted|attempting|use|uses|using|probe|probes|probed|probing|fuzz|fuzzes|fuzzed|fuzzing|enumerate|enumerates|enumerated|enumerating|interact|interacts|interacted|interacting|engage|engages|engaged|engaging|initiate|initiates|initiated|initiating|modify|modifies|modified|modifying|delete|deletes|deleted|deleting|disrupt|disrupts|disrupted|disrupting|exfiltrate|exfiltrates|exfiltrated|exfiltrating|dump|dumps|dumped|dumping|download|downloads|downloaded|downloading|copy|copies|copied|copying|collect|collects|collected|collecting|retain|retains|retained|retaining|store|stores|stored|storing|maintain|maintains|maintained|maintaining|install|installs|installed|installing|inject|injects|injected|injecting|impersonate|impersonates|impersonated|impersonating|spoof|spoofs|spoofed|spoofing|phish|phishes|phished|phishing|bypass|bypasses|bypassed|bypassing|circumvent|circumvents|circumvented|circumventing|escalate|escalates|escalated|escalating|automate|automates|automated|automating|create|creates|created|creating|generate|generates|generated|generating|launch|launches|launched|launching|run|runs|running|execute|executes|executed|executing|touch|touches|touched|touching|enter|enters|entered|entering|send|sends|sending|brute[\\s-]?forc\\w*|credential[\\s-]?stuff\\w*|password[\\s-]?spray\\w*)";

const ACTION_VERB_RE = new RegExp(`^${ACTION_VERB}$`, "i");

const PROHIBITION_RES = [
  // Copula prohibition: "X is prohibited", "testing is not permitted",
  // "automated scanners are strictly forbidden", "X is off limits".
  new RegExp(
    "\\b(?:is|are|was|were|be|been|being|remains?)\\s+(?:\\w+ly\\s+|not\\s+|strictly\\s+|explicitly\\s+|generally\\s+|absolutely\\s+|entirely\\s+|wholly\\s+)*" +
      "(?:prohibited|forbidden|disallowed|banned|not\\s+(?:permitted|allowed|authorized|authorised)|off[\\s-]?limits|out\\s+of\\s+bounds|illegal|unlawful)\\b",
    "i",
  ),
  // The prohibit/forbid/disallow verb family wherever it appears.
  /\bprohibit(?:s|ed|ing)?\b|\bforbid(?:s|den|ding)?\b|\bforbidden\b|\bdisallow(?:s|ed|ing)?\b/i,
  // Deontic modal negations are inherently normative.
  /\b(?:must|shall|may)\s+not\b|\bmustn'?t\b|\bshan'?t\b/i,
  // Incapacity on an activity verb: "cannot test", "you can't access". The
  // verb gate keeps "cannot be demonstrated" / "cannot authorize" out —
  // capability and program-side authority are not testing prohibitions.
  new RegExp(`\\b(?:cannot|can't|won't|can\\s+not)\\s+${ACTION_VERB}\\b`, "i"),
  // Program-side refusal: "we do not allow", "the program does not permit".
  // Only "do/does not" qualifies — "cannot authorize" is incapacity, not a
  // refusal (OpenAI's safe-harbor line is a capability statement).
  /\b(?:we|the\s+(?:program|engagement|company|team)|bugcrowd|this\s+(?:program|engagement))\s+(?:do\s+not|does\s+not)\s+(?:allow|permit|authorize|authorise|support|accept)\b/i,
  // Bare "not permitted/allowed/authorized" standing alone ("may not be
  // tested" is covered by the modal above; this catches "X not allowed").
  /\bnot\s+(?:permitted|allowed|authorized|authorised)\b/i,
  // Enforcement consequence: "can lead to a ban", "will result in termination".
  /\b(?:can|could|may|will|would|might|shall|should)?\s*(?:leads?|results?)\s+(?:to|in)\s+[^.;]*?\b(?:ban|banned|termination|removal|suspension|enforcement|account\s+closure)\b|\bgrounds\s+for\s+(?:a\s+|an\s+)?(?:ban|termination|removal)|will\s+be\s+banned|get\s+(?:you\s+)?banned\b/i,
  // Sentence-initial "no <activity>".
  /^\s*no\s+(?:testing|scanning|scans?|automation|automated|brute|denial|dos|ddos|social|phishing|physical|credential|accessing|access|fuzzing|exploitation|exfiltration)\b/i,
];

/** Boundaries before which a "do not"/"never" is still a directive. */
const CLAUSE_BOUNDARY_RE =
  /(?:[.!?;:,()]\s*|^)\s*$|\b(?:and|or|but|also|please|e\.g\.|i\.e\.|for\s+example|for\s+instance|note|additionally|furthermore|otherwise|instead)\s*$/i;
const DIRECTIVE_SUBJECT_RE = new RegExp(`${DIRECTIVE_SUBJECT}\\s*$`, "i");
const IMPERATIVE_NEG_RE = /\b(?:do|does)\s+not\s+([a-z][\w-]*)/gi;
const NEVER_RE = /\bnever\s+([a-z][\w-]*)/gi;

/**
 * "do not <action-verb>" / "never <action-verb>" as a directive. Both must
 * sit at a clause boundary (or a directive subject at one): "do not target
 * other users' data" is a rule, but "forms that do not perform sensitive
 * actions" and "data you do not own" are descriptive clauses — the
 * subordinator/noun binding before them is what makes the difference.
 */
function boundaryBefore(sentence: string, index: number): boolean {
  const prefix = sentence.slice(0, index);
  if (CLAUSE_BOUNDARY_RE.test(prefix)) return true;
  const sm = DIRECTIVE_SUBJECT_RE.exec(prefix);
  if (sm !== null) {
    const beforeSubject = prefix.slice(0, sm.index);
    if (CLAUSE_BOUNDARY_RE.test(beforeSubject) || beforeSubject.trim() === "") {
      return true;
    }
  }
  return false;
}

function directiveProhibition(sentence: string): boolean {
  for (const re of [IMPERATIVE_NEG_RE, NEVER_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      const verb = m[1] ?? "";
      ACTION_VERB_RE.lastIndex = 0;
      if (!ACTION_VERB_RE.test(verb)) continue;
      if (boundaryBefore(sentence, m.index)) return true;
    }
  }
  return false;
}

function hasProhibition(sentence: string): boolean {
  for (const re of PROHIBITION_RES) {
    re.lastIndex = 0;
    if (re.test(sentence)) return true;
  }
  return directiveProhibition(sentence);
}

const PERMISSION_RES = [
  // Copula permission: "testing is permitted", "X is allowed".
  /\b(?:is|are|was|were|be|been|being|remains?)\s+(?:\w+ly\s+)*(?:permitted|allowed|authorized|authorised|encouraged|welcomed)\b/i,
  // Researcher-subject modal grant: "you may test", "researchers are free to".
  new RegExp(
    `\\b${DIRECTIVE_SUBJECT}\\s+(?:may|are\\s+free\\s+to|are\\s+welcome\\s+to|feel\\s+free\\s+to|are\\s+(?:allowed|permitted|authorized|authorised)\\s+to)\\b`,
    "i",
  ),
  // Program-side grant: "we permit", "the program allows", "X authorize
  // testing".
  /\b(?:we|the\s+(?:program|engagement|company|team)|bugcrowd|this\s+(?:program|engagement))\s+(?:allows?|permits?|authorizes?|authorises?|encourages?|welcomes?)\b/i,
  // "X authorize testing" — a program-side grant. The lookbehind excludes
  // incapacity phrasing ("unable to authorize", "cannot authorize"), which
  // states what the program *cannot* grant, never a permission.
  /(?<!(?:unable\s+to|cannot|can\s+not|can't|not\s+able\s+to)\s)\bauthorize[sd]?\s+testing\b/i,
  // Passive grant: "X may be tested/performed/accessed".
  /\bmay\s+(?:be\s+)?(?:tested|used|performed|conducted|attempted|scanned|accessed|targeted|probed|fuzzed|carried\s+out|undertaken)\b/i,
  /\bfree\s+to\s+(?:test|use|access|scan|probe|fuzz)\b/i,
  /\b(?:permitted|allowed|authorized|authorised)\s+to\s+test\b/i,
];

function hasPermission(sentence: string): boolean {
  for (const re of PERMISSION_RES) {
    re.lastIndex = 0;
    if (re.test(sentence)) return true;
  }
  return false;
}

/**
 * Self-contained restrictive forms — a directive that conditions the
 * activity on its own ("use only X", "only test Y", "permitted only against
 * Z", "restricted to W"). These outrank an incidental negation elsewhere in
 * the sentence, which usually describes the attack scenario, not the rule.
 */
const RESTRICTIVE_RES = [
  /\b(?:permitted|allowed|authorized|authorised|encouraged)\s+only\b/i,
  /\bonly\s+(?:permitted|allowed|authorized|authorised)\b/i,
  /\b(?:is|are|be|remains?)\s+(?:restricted|limited|confined)\s+to\b/i,
  /\buse\s+only\b/i,
  /\bonly\s+(?:use|test|target|interact\s+with|access|contact|scan|attack|exploit|submit|through|via|your|the)\b/i,
];

/**
 * Qualifier markers: they condition a permission/prohibition but carry no
 * force alone — "unless approved" without a grant or ban is not a rule.
 */
const QUALIFIER_RES = [
  /\bunless\b/i,
  /\bexcept\s+(?:when|if|for|with|upon|to\s+the\s+extent)\b/i,
  /\bprovided\s+(?:that|you)\b/i,
  /\bas\s+long\s+as\b/i,
  /\bsubject\s+to\b/i,
  /\bwith\s+(?:prior\s+)?(?:written\s+)?(?:approval|authorization|authorisation|permission|consent)\b/i,
  /\brequires?\s+(?:prior\s+)?(?:approval|permission|authorization|authorisation|consent)\b/i,
  /\bapproved\s+in\s+advance\b/i,
  /\bonly\s+(?:against|with|for|if|when|on|to|after|within|from|during|under|by|in|between|per|at|for\s+use)\b/i,
];

/**
 * Sentences that refuse a *report* or state eligibility rather than an
 * activity. A brief may reject a submission type in prohibitive words while
 * saying nothing about testing — so these frames veto a fact unless the
 * sentence also carries a directive aimed at the activity itself.
 */
const SUBMISSION_FRAME_RES = [
  // The submission word must be the refusal's subject — a lookbehind keeps
  // objects like "form submissions" and "of findings" out of the frame.
  /(?<!(?:form|of|for|through|via|against|into|about|in)\s)\b(?:reports?|submissions?|findings?|tickets?|vulnerabilit\w+|issues?)\b[^.;]*?\b(?:not\s+(?:be\s+)?(?:accepted|eligible|rewarded|valid|considered|qualifying|permitted|allowed)|will\s+(?:be|not)\s+(?:closed|rejected|marked|dismissed|accepted)|are\s+(?:excluded|rejected|closed|ineligible)|closed\s+as\b|deemed\s+out)/i,
  /\b(?:do|does|did)\s+not\s+(?:submit|report|file|send\s+in)\b/i,
  /\bnot\s+eligible\s+for\b/i,
  /\b(?:closed|marked|resolved|classified|deemed|treated|handled)\s+as\s+(?:not\s+applicable|n\/a|informative|duplicate|out[\s-]?of[\s-]?scope|invalid|non[\s-]?security)\b/i,
  /\bwill\s+be\s+(?:closed|rejected|marked|dismissed|handled|treated)\s+as\b/i,
  /\b(?:are|is|be|remains?|considered|deemed|treated)\s+(?:as\s+)?(?:excluded|not\s+covered|out[\s-]?of[\s-]?scope|outside\s+(?:the\s+|this\s+|our\s+|their\s+)?(?:scope|program|engagement)|not\s+in\s+scope|ineligible)\b/i,
];

function isSubmissionFramed(sentence: string): boolean {
  for (const re of SUBMISSION_FRAME_RES) {
    re.lastIndex = 0;
    if (re.test(sentence)) return true;
  }
  return false;
}

/**
 * A prohibition aimed at the activity itself ("must not be tested",
 * "do not test", "never scan") — the exception that lets a sentence sitting
 * in a submission/scope frame still carry a testing rule: "…out of scope
 * and must not be tested" forbids the activity; "…will be closed as Not
 * Applicable" does not.
 */
const ACTIVITY_DIRECTIVE_RES = [
  new RegExp(`\\b(?:must|shall|may)\\s+not\\s+(?:be\\s+|to\\s+)?${ACTION_VERB}\\b`, "i"),
  new RegExp(`\\bnever\\s+${ACTION_VERB}\\b`, "i"),
  /\b(?:testing|scanning|access|automation)\s+(?:is|are|was|were)\s+(?:not\s+)?(?:prohibited|forbidden|not\s+permitted|not\s+allowed|not\s+authorized|not\s+authorised)\b/i,
];

function hasActivityDirective(sentence: string): boolean {
  for (const re of ACTIVITY_DIRECTIVE_RES) {
    re.lastIndex = 0;
    if (re.test(sentence)) return true;
  }
  return directiveProhibition(sentence);
}

/**
 * Testing status a single sentence asserts about the activity itself; null
 * when the sentence carries no researcher-facing normative predicate — a
 * topic mention, a capability statement, a scope/eligibility claim, or a
 * submission refusal with no activity directive all fail closed.
 */
export function statusOfSentence(sentence: string): PermissionStatus | null {
  const prohibited = hasProhibition(sentence);
  const permitted = hasPermission(sentence);
  const explicitCond = RESTRICTIVE_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(sentence);
  });
  if (!prohibited && !permitted && !explicitCond) return null;
  if (isSubmissionFramed(sentence) && !hasActivityDirective(sentence)) {
    return null;
  }
  if (explicitCond) return "conditional";
  if (prohibited && permitted) return null; // mixed polarity → ambiguous
  const qualified = QUALIFIER_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(sentence);
  });
  if (prohibited) return qualified ? "conditional" : "prohibited";
  if (permitted) return qualified ? "conditional" : "allowed";
  return null;
}

/**
 * Testing status a text asserts across its sentences; `unspecified` when no
 * sentence carries a normative predicate. The most conservative asserted
 * status wins across sentences (prohibited > conditional > allowed).
 */
export function testingStatusOf(text: string): PermissionStatus {
  let best: PermissionStatus = "unspecified";
  for (const sentence of sentencesOf(text)) {
    const status = statusOfSentence(sentence);
    if (status === "prohibited") return "prohibited";
    if (status === "conditional") best = "conditional";
    else if (status === "allowed" && best === "unspecified") best = "allowed";
  }
  return best;
}

// ---------------------------------------------------------------------------
// Conditions. A conditional fact needs at least one meaningful condition —
// a clause that states the restriction, not a fragment captured because a
// keyword sat nearby.
// ---------------------------------------------------------------------------

const CONDITION_CLAUSE_RES = [
  /\bonly\s+(against|with|for|if|when|on|to|after|within|from|during|under|by|in|between|per)\s+([^.;]+)/i,
  /\bwith\s+(prior\s+)?(written\s+)?(approval|authorization|authorisation|permission|consent)(?:\s+from\s+([^.;]+))?/i,
  /\bprovided\s+(?:that\s+)?([^.;]+)/i,
  /\bas\s+long\s+as\s+([^.;]+)/i,
  /\bsubject\s+to\s+([^.;]+)/i,
  /\brequires?\s+([^.;]+)/i,
  /\bunless\s+([^.;]+)/i,
  /\buse\s+only\s+([^.;]+)/i,
  /\bonly\s+(?:use|test|target|interact)(?:\s*\/\s*\w+)*\s+(?:with\s+|on\s+|against\s+)?([^.;]+)/i,
  /\bexcept\s+(when|if|for|with|upon)\s+([^.;]+)/i,
  /\bexcept\s+to\s+the\s+extent\s+([^.;]+)/i,
  /\b(?:restricted|limited|confined)\s+to\s+([^.;]+)/i,
  /\bif\s+([^.;]+)/i,
];

/**
 * A condition must read like a clause, not a scrape artifact. Rejects URL
 * fragments, mid-relative fragments, dangling connectors, and captures that
 * bled into the sentence's own predicate ("…is prohibited").
 */
export function isMeaningfulCondition(text: string): boolean {
  const t = normalizeText(text).replace(/[.,;:!?]+$/g, "").trim();
  if (t === "") return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 25) return false;
  if (/https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|io|dev|ai|app|co|gov|edu)\b/i.test(t)) {
    return false;
  }
  if (/^(?:that|which|who|whose|whom|and\s+that|or\s+that)\b/i.test(t)) {
    return false;
  }
  if (/\b(?:is|are|was|were)\s+(?:not\s+)?(?:prohibited|forbidden|disallowed|banned)\b/i.test(t)) {
    return false;
  }
  if (/\b(?:and|or|but|to|of|in|on|at|for|with|by|from|as|the|a|an|that|which|not|be|is|are|was|were)$/i.test(t)) {
    return false;
  }
  return true;
}

/** Validated condition clauses lifted from the sentence (normalized). */
export function conditionsOf(sentence: string): string[] {
  const out: string[] = [];
  for (const re of CONDITION_CLAUSE_RES) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = global.exec(sentence)) !== null) {
      const clause = (m.length > 2 ? `${m[1]} ${m[2]}` : (m[1] ?? m[0])).trim();
      const normalized = normalizeText(clause).replace(/[.,;:!?]+$/g, "");
      if (
        normalized !== "" &&
        isMeaningfulCondition(normalized) &&
        !out.includes(normalized)
      ) {
        out.push(normalized);
      }
      if (m[0] === "") global.lastIndex++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Technique findings: matched topics narrowed to what the sentence actually
// rules on. "Automated scanners are prohibited" yields "automated scanners",
// not a blanket "automation" fact; "Automation against form submissions is
// not allowed" yields "automation (against form submissions)".
// ---------------------------------------------------------------------------

export interface TechniqueFinding {
  /** Fact key — the taxonomy name, narrowed by an in-sentence qualifier. */
  name: string;
  slug: string;
  /** The taxonomy entry the sentence named. */
  baseName: string;
  status: PermissionStatus;
  conditions: string[];
  /** The sentence the finding was read from. */
  quote: string;
  /** Both polarities asserted without a restrictive form — unattributable. */
  ambiguous: boolean;
}

interface Span {
  def: TechniqueDef;
  start: number;
  end: number;
  text: string;
  modifier?: string;
}

function techniqueSpans(sentence: string): Span[] {
  const spans: Span[] = [];
  for (const def of TECHNIQUES) {
    const re = new RegExp(def.re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      spans.push({ def, start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0] === "") re.lastIndex++;
    }
  }
  // One span per technique: the first mention stands for them all.
  const seen = new Set<string>();
  return spans
    .sort((a, b) => a.start - b.start)
    .filter((s) => !seen.has(s.def.name) && (seen.add(s.def.name), true));
}

const QUALIFIER_PREP_RE =
  /^\s+(against|of|on|upon|within|via|through|across|targeting|for|in)\s+(\S(?:[^.,;:!?()]*?))(?=\s+(?:is|are|was|were|be|been|being|has|have|had|can|could|will|would|shall|should|may|might|must|do|does|did|us|we|you|they|it|this|these|those|to|and|or|but|that|which|who|unless|provided|except|as|if|when|while|because|since|so)\b|[.,;:!?()]|$)/i;

/** Words that cannot start an adjective complement ("automated tooling"). */
const COMPLEMENT_STOP = new Set([
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "do", "does", "did", "and", "or", "but", "that", "which", "who", "to",
  "for", "with", "in", "on", "at", "by", "from", "as", "not", "no", "if",
  "when", "while", "because", "since", "so", "us", "we", "you", "they", "it",
  "this", "these", "those", "a", "an", "the", "only", "unless", "except",
  "provided", "subject", "required", "requires",
]);

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "item" : slug;
}

/**
 * Narrow a matched span to what the sentence rules on:
 * - adjacent modifier merge: "automated scanning" drops "automation", the
 *   modifier prefixes the activity;
 * - adjective complement: "automated tooling" (automation as modifier);
 * - prepositional qualifier: "automation against form submissions" becomes
 *   "automation (against form submissions)".
 */
function narrowedName(span: Span, sentence: string, spans: Span[]): string {
  const tail = sentence.slice(span.end);
  let base: string;
  if (span.modifier !== undefined) {
    base = normalizeText(`${span.modifier} ${span.text}`).toLowerCase();
  } else if (/^(?:automated|automatic|manual)$/i.test(span.text)) {
    const m = /^\s+([a-zA-Z][\w-]*)/.exec(tail);
    base =
      m !== null && !COMPLEMENT_STOP.has(m[1]!.toLowerCase())
        ? `${span.text.toLowerCase()} ${m[1]!.toLowerCase()}`
        : span.def.name;
  } else {
    base = span.def.name;
  }
  const q = QUALIFIER_PREP_RE.exec(tail);
  if (q !== null) {
    const qualifier = normalizeText(q[2] ?? "");
    const qEnd = span.end + q.index + q[0].length;
    const overlaps = spans.some(
      (s) => s !== span && s.start > span.start && s.start < qEnd,
    );
    if (
      qualifier !== "" &&
      !overlaps &&
      isMeaningfulCondition(`${q[1]} ${qualifier}`)
    ) {
      return `${base} (${q[1]!.toLowerCase()} ${qualifier.toLowerCase()})`;
    }
  }
  return base;
}

/**
 * All technique findings in a text, one per (sentence, technique). Sentences
 * without a normative predicate yield nothing; a sentence asserting both
 * polarities without a restrictive form yields `ambiguous` findings so the
 * caller can record them partial instead of guessing which activity took
 * which polarity.
 */
export function techniqueFindingsIn(text: string): TechniqueFinding[] {
  const out: TechniqueFinding[] = [];
  for (const sentence of sentencesOf(text)) {
    const spans = techniqueSpans(sentence);
    if (spans.length === 0) continue;
    const prohibited = hasProhibition(sentence);
    const permitted = hasPermission(sentence);
    const explicitCond = RESTRICTIVE_RES.some((re) => {
      re.lastIndex = 0;
      return re.test(sentence);
    });
    const ambiguous = prohibited && permitted && !explicitCond;
    const status = statusOfSentence(sentence);
    if (status === null && !ambiguous) continue;
    const conditions =
      status === "conditional" ? conditionsOf(sentence) : [];
    // Drop a matched topic when an adjacent match is its modifier: in
    // "automated scanning", "automated" describes the scanning — it is not a
    // separate "automation" claim.
    const survivors: Span[] = [];
    for (const span of spans) {
      const next = spans.find(
        (s) => s !== span && s.start - span.end <= 1 && s.start > span.start &&
          /^[\s-]*$/.test(sentence.slice(span.end, s.start)),
      );
      if (next !== undefined) {
        next.modifier = normalizeText(
          `${span.modifier ?? ""} ${span.text}`,
        ).toLowerCase();
        continue;
      }
      survivors.push(span);
    }
    for (const span of survivors) {
      const name = narrowedName(span, sentence, survivors);
      out.push({
        name,
        slug: slugifyName(name),
        baseName: span.def.name,
        status: ambiguous ? "unspecified" : status!,
        conditions,
        quote: sentence,
        ambiguous,
      });
    }
  }
  return out;
}

/**
 * Whether the text carries an explicit normative predicate — optionally one
 * matching a claimed status. The hard validator for normalized facts: no
 * predicate in the evidence → no asserted fact (§10).
 */
export function hasNormativePredicate(
  text: string,
  status?: PermissionStatus,
): boolean {
  return sentencesOf(text).some((sentence) => {
    const s = statusOfSentence(sentence);
    return status === undefined ? s !== null : s === status;
  });
}

/**
 * Distinct sentence-level statuses a text asserts — used for rule lines so a
 * text claiming two different things produces two assertions and the fact
 * builder sees the conflict instead of a priority-picked winner.
 */
export function sentenceStatuses(text: string): PermissionStatus[] {
  const out = new Set<PermissionStatus>();
  for (const sentence of sentencesOf(text)) {
    const s = statusOfSentence(sentence);
    if (s !== null) out.add(s);
  }
  return [...out].sort();
}

/** Reward-eligibility axis for excluded findings (separate from testing). */
const REWARD_INELIGIBLE_RE =
  /\bnot\s+eligible\s+for\s+(?:an?\s+)?(?:rewards?|bount(?:y|ies)|payouts?|payments?|compensation)|\bnot\s+(?:be\s+)?rewarded\b|\bno\s+(?:rewards?|bount(?:y|ies)|payouts?|payments?)\b|\bineligible\s+for\s+(?:an?\s+)?(?:rewards?|bount(?:y|ies)|payouts?)|\bnot\s+qualif\w+\s+for\s+(?:an?\s+)?rewards?|\bwithout\s+(?:a\s+|an\s+)?rewards?|\bnon[\s-]?paying\b|\bno\s+payout\b/i;

export function rewardStatusOf(text: string): "ineligible" | "unspecified" {
  REWARD_INELIGIBLE_RE.lastIndex = 0;
  return REWARD_INELIGIBLE_RE.test(text) ? "ineligible" : "unspecified";
}

// ---------------------------------------------------------------------------
// Scope-authorization boundary statements. The exclusive form ("testing is
// only authorized on X") states a fact about listed targets and one about
// everything else; boundary forms ("anything not declared as a target is out
// of scope") state the same boundary from the unlisted side.
// ---------------------------------------------------------------------------

export const SCOPE_AUTHORIZATION_EXCLUSIVE_RE =
  /\btesting\s+is\s+only\s+authorized\s+(?:on|against|for)\s+([^.;]+)/i;

/** Semantic equivalents of the exclusive authorization boundary. */
export const SCOPE_BOUNDARY_RES = [
  // "Only the targets listed above are in scope."
  /\bonly\s+the\s+(?:targets?|assets?|domains?|properties|urls?|uris|hosts?|applications?|services?|systems?|endpoints?)\s+(?:listed|declared|mentioned|specified|defined|described|shown|named|above|in\s+scope)\b[^.;]*?\b(?:are|is|remains?)\s+(?:in[\s-]?scope|authorized|authorised|within\s+scope)\b/i,
  // "Anything not declared as a target or in scope above should be
  // considered out of scope." / "Any asset not explicitly listed in scope
  // above falls outside this program."
  /\b(?:anything|any\s+(?:target|asset|domain|property|host|url|uri|service|system|application|site|subdomain|endpoint|domain\/property)|everything|whatever)\b[^.;]*?\bnot\s+(?:\w+ly\s+)?(?:declared|listed|mentioned|specified|defined|described|shown|covered|included|named|in\s+scope|above)\b[^.;]*?\b(?:is|are|be|should|to\s+be|must\s+be|considered|deemed|treated|falls?|remains?|counts?)\b[^.;]*?\b(?:out[\s-]?of[\s-]?scope|outside\s+(?:the\s+|this\s+|our\s+|their\s+)?(?:scope|program|engagement|bounty)|not\s+authorized|not\s+authorised|prohibited|off[\s-]?limits|excluded)\b/i,
  // "All other assets are out of scope."
  /\ball\s+other\s+(?:targets?|assets?|domains?|properties|hosts?|urls?|uris|services?|systems?|applications?|sites?|subdomains?|infrastructure|endpoints?|resources?)\b[^.;]*?\b(?:is|are|be|should\s+be\s+considered|considered|deemed|treated\s+as|remains?)\s+[^.;]*?\b(?:out[\s-]?of[\s-]?scope|outside\s+(?:the\s+|this\s+|our\s+|their\s+)?(?:scope|program|engagement)|not\s+authorized|not\s+authorised|excluded)\b/i,
];
