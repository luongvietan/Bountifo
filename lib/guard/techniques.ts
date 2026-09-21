/**
 * Canonical technique ids. The gate never fuzzy-matches natural language:
 * a deterministic alias table maps the technique keys the exporter emits
 * (and the vulnerability classes VRT/exclusion rows name) onto stable ids.
 * Unknown input → null → REVIEW; no embeddings, no inference.
 *
 * Ordering contract: specific/compound phrases precede generic parents, so
 * "automated scanners" resolves to automated_scanners, never to `scanning`.
 */

interface AliasRule {
  re: RegExp;
  id: string;
}

export const CANONICAL_TECHNIQUE_IDS = [
  // testing methods
  "automation",
  "scanning",
  "automated_scanners",
  "automated_scanning",
  "automated_tools",
  "automated_vulnerability_scanning",
  "burp_scanning",
  "port_scanning_internal_networks",
  "form_submission_automation",
  "contact_form_testing",
  "customer_data_validation",
  "brute_force",
  "credential_testing",
  "multi_account",
  "cross_tenant",
  "cross_account_testing",
  "third_party",
  "third_party_file_sharing",
  "pii_access",
  "other_customer_data",
  "other_account_data_access",
  "customer_personal_data_access",
  "credit_card_data_access",
  "confidential_information_access",
  "data_exfiltration",
  "persistent_access",
  "denial_of_service",
  "social_engineering",
  "physical_testing",
  // vulnerability classes (VRT categories, exclusion rows)
  "xss",
  "self_xss",
  "csrf",
  "ssrf",
  "rce",
  "sql_injection",
  "idor",
  "broken_access_control",
  "clickjacking",
  "open_redirect",
  "business_logic",
  "rate_limiting",
  "prompt_injection",
  "account_takeover",
  "xxe",
  "subdomain_takeover",
  "information_disclosure",
  "file_upload",
  "cors_misconfiguration",
] as const;

const KNOWN = new Set<string>(CANONICAL_TECHNIQUE_IDS);

// Specific/compound phrases MUST come before the generic automation/scanning
// entries — first match wins in canonicalTechniqueId.
const ALIASES: AliasRule[] = [
  {
    re: /\bautomation\s*\(\s*against\s+form\s+submissions?\s*\)|\bform[\s-]?submissions?\s+automation\b|\bautomat\w+\s+form\s+submissions?/i,
    id: "form_submission_automation",
  },
  { re: /\bcontact\s+forms?\b/i, id: "contact_form_testing" },
  {
    re: /\bcustomer[\s-]?data[\s-]?(?:access[\s-]?)?validat|validat\w+\s+(?:of\s+)?(?:customer|sensitive)[\s-]?(?:data|access)/i,
    id: "customer_data_validation",
  },
  { re: /\bself[\s-]?xss\b/i, id: "self_xss" },
  {
    re: /\b(?:internal[\s-]?network|internal[\s-]?systems?)[\s-]?scann\w*|\bport[\s-]?scann\w*|\bscann\w*\s+(?:of\s+)?internal[\s-]?network/i,
    id: "port_scanning_internal_networks",
  },
  {
    re: /\bautomated\s+vulnerability\s+scann\w*|\bvulnerability\s+scanners?\b/i,
    id: "automated_vulnerability_scanning",
  },
  { re: /\bburp(?:\s+suite|\s+scann\w*)?\b/i, id: "burp_scanning" },
  { re: /\bautomated\s+(?:tools?|tooling)\b/i, id: "automated_tools" },
  {
    re: /\b(?:automated|automatic)\s+scann\w*/i,
    id: "automated_scanners",
  },
  { re: /\bcross[\s-]?account/i, id: "cross_account_testing" },
  {
    re: /\bcross[\s-]?tenant|cross[\s-]?client|cross[\s-]?organi[sz]ation/i,
    id: "cross_tenant",
  },
  {
    re: /\bdenial[\s-]?of[\s-]?service|\bd?dos\b/i,
    id: "denial_of_service",
  },
  {
    re: /\bsocial[\s-]?engineer|\bphishing\b|\bvishing\b|\bsmishing\b|\bimpersonat/i,
    id: "social_engineering",
  },
  {
    re: /\bphysical(?:ly)?[\s-]?(?:test|access|attack|security|offices?|data\s*cent)/i,
    id: "physical_testing",
  },
  {
    re: /\bbrute[\s-]?force\b|\bcredential[\s-]?stuff/i,
    id: "brute_force",
  },
  {
    re: /\bcredential[\s-]?test|test(?:ing)?\s+(?:of\s+)?credentials?\b|\blogin\s+attempts?/i,
    id: "credential_testing",
  },
  {
    re: /\bmulti(?:ple)?[\s-]?accounts?\b|account\s+sharing|shared\s+accounts?/i,
    id: "multi_account",
  },
  {
    re: /\b(?:other|another)\s+(?:users?|customers?|tenants?)'?s?\s+(?:data|services?|accounts?|information)/i,
    id: "other_customer_data",
  },
  {
    re: /\b(?:anyone|someone)\s+else'?s?\s+account|\bdata\s+(?:from|of)\s+(?:anyone|someone)\s+else|\bother\s+people'?s?\s+accounts?\b/i,
    id: "other_account_data_access",
  },
  {
    re: /\bcredit[\s-]?card/i,
    id: "credit_card_data_access",
  },
  {
    re: /\bcustomer\s+(?:personal\s+|private\s+)?(?:data|information|records?)\b|\bcustomer\s+pii\b/i,
    id: "customer_personal_data_access",
  },
  {
    re: /\bconfidential\s+(?:information|data|records?)\b/i,
    id: "confidential_information_access",
  },
  {
    re: /\bthird[\s-]?party\s+(?:file|data)\s+sharing|\b(?:file|data)\s+sharing\s+(?:with|to|via)\s+third[\s-]?part/i,
    id: "third_party_file_sharing",
  },
  { re: /\bthird[\s-]?part(?:y|ies)\b/i, id: "third_party" },
  {
    re: /\bpii\b|personally\s+identifiable|personal\s+(?:data|information)/i,
    id: "pii_access",
  },
  {
    re: /\bexfiltrat|data\s+theft|dump(?:ing)?\s+(?:data|databases?)/i,
    id: "data_exfiltration",
  },
  {
    re: /\bpersist(?:ent|ence)|backdoor|web\s*shell|maintain(?:ing)?\s+access/i,
    id: "persistent_access",
  },
  { re: /\bxss\b|cross[\s-]?site[\s-]?script/i, id: "xss" },
  {
    re: /\bcsrf\b|cross[\s-]?site[\s-]?request[\s-]?forgery/i,
    id: "csrf",
  },
  {
    re: /\bssrf\b|server[\s-]?side[\s-]?request[\s-]?forgery/i,
    id: "ssrf",
  },
  { re: /\brce\b|remote[\s-]?code[\s-]?execution/i, id: "rce" },
  { re: /\bsqli\b|sql[\s-]?injection/i, id: "sql_injection" },
  { re: /\bidor\b|insecure[\s-]?direct[\s-]?object/i, id: "idor" },
  {
    re: /\bbroken[\s-]?access[\s-]?control|\bbac\b/i,
    id: "broken_access_control",
  },
  { re: /\bclickjack/i, id: "clickjacking" },
  { re: /\bopen[\s-]?redirect/i, id: "open_redirect" },
  { re: /\bbusiness[\s-]?logic/i, id: "business_logic" },
  { re: /\brate[\s-]?limit/i, id: "rate_limiting" },
  { re: /\bprompt[\s-]?injection/i, id: "prompt_injection" },
  {
    re: /\baccount[\s-]?takeover|\bato\b/i,
    id: "account_takeover",
  },
  { re: /\bxxe\b|xml[\s-]?external[\s-]?entit/i, id: "xxe" },
  { re: /\bsubdomain[\s-]?takeover/i, id: "subdomain_takeover" },
  {
    re: /\binformation[\s-]?disclosure|info(?:rmation)?[\s-]?leak/i,
    id: "information_disclosure",
  },
  { re: /\bfile[\s-]?upload/i, id: "file_upload" },
  { re: /\bcors\b/i, id: "cors_misconfiguration" },
  // Generic parents — last.
  { re: /\bautomat\w*\b/i, id: "automation" },
  { re: /\bscans?\b|\bscanning\b|\bscanners?\b/i, id: "scanning" },
];

/** Normalize to canonical-id spelling (`Automated Scanners` → `automated_scanners`). */
function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Canonical id for a fact key, action `technique.id`, or short phrase. Exact
 * canonical spellings pass through; otherwise the first matching alias wins.
 * Returns null for anything unrecognized — callers must treat null as
 * "unknown", never as permission.
 */
export function canonicalTechniqueId(name: string): string | null {
  const slug = slugOf(name);
  if (KNOWN.has(slug)) return slug;
  for (const { re, id } of ALIASES) {
    re.lastIndex = 0;
    if (re.test(name)) return id;
  }
  return null;
}

/** Bare modifier words describe — never name — the activity after them. */
const BARE_MODIFIER_RE = /^(?:automated|automatic|manual)$/i;
/**
 * A modifier adjective followed by coordinated noun items — the prefix
 * "automated tools/" or "automated tools, scripts and " before "scanners".
 */
const MODIFIER_COORD_PREFIX_RE =
  /(automated|automatic|manual)\s+(?:[a-z][\w-]*\s*(?:\/|,|\band\b|\bor\b)\s*)+$/i;

interface Mention {
  id: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Canonical technique ids a text mentions. Used to decide whether an
 * exclusion or account/data rule speaks to the proposed action. A modifier
 * governs its whole coordinated noun phrase ("automated tools/scanners" →
 * automated_scanners, never bare `scanning`); mentions strictly inside a
 * more specific match are absorbed by it.
 */
export function techniquesMentionedIn(text: string): string[] {
  const mentions: Mention[] = [];
  for (const { re, id } of ALIASES) {
    const global = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      mentions.push({ id, start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0] === "") global.lastIndex++;
    }
  }
  const out = new Set<string>();
  for (const mention of mentions) {
    // "automated" alone is a modifier, not a claim about automation.
    if (BARE_MODIFIER_RE.test(mention.text)) continue;
    // A generic match governed by a coordinated modifier re-canonicalizes:
    // "... automated tools/scanners" → "automated scanners".
    const prefix = text.slice(0, mention.start);
    const coord = MODIFIER_COORD_PREFIX_RE.exec(prefix);
    if (coord !== null) {
      const remapped = canonicalTechniqueId(`${coord[1]} ${mention.text}`);
      if (remapped !== null) {
        out.add(remapped);
        continue;
      }
    }
    // Absorbed by a more specific overlapping mention ("automated scanning"
    // already covers the inner "scanning").
    const absorbed = mentions.some(
      (other) =>
        other.id !== mention.id &&
        other.start <= mention.start &&
        other.end >= mention.end &&
        (other.end - other.start) > mention.end - mention.start,
    );
    if (!absorbed) out.add(mention.id);
  }
  return [...out].sort();
}
