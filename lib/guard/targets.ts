/**
 * Deterministic target resolution. Every comparison is anchored: wildcard
 * suffixes require a DNS label boundary, `{placeholder}` labels match exactly
 * one DNS label, and exact hosts compare equal after URL canonicalization.
 * No substring matching — `*.example.com` never reaches `evil-example.com`
 * or `example.com.attacker.tld`.
 *
 * Specificity (highest first): exact URL/host > `{placeholder}` host >
 * `*.wildcard` > nothing. Within a class, deeper host labels win, then a
 * longer path prefix. Equal-specificity in/out conflicts are `ambiguous`,
 * never resolved by array order.
 */

export interface ScopeTargetInput {
  target_id: string;
  location: string | null;
  name: string | null;
  category: string | null;
  scope_group_ids: string[];
  evidence_refs: string[];
  notes?: string | null;
}

export interface ScopeInventoryInput {
  in_scope?: ScopeTargetInput[];
  out_of_scope?: ScopeTargetInput[];
}

export type TargetResolution =
  | {
      status: "matched_in_scope";
      target_ids: string[];
      evidence_refs: string[];
    }
  | {
      status: "matched_out_of_scope";
      target_ids: string[];
      evidence_refs: string[];
    }
  | { status: "unlisted" }
  | { status: "ambiguous"; candidate_target_ids: string[] };

type HostPattern =
  | { kind: "exact"; host: string }
  | { kind: "wildcard"; suffix: string }
  | { kind: "placeholder"; regex: RegExp };

interface TargetPattern {
  host: HostPattern;
  /** null matches any scheme. */
  scheme: string | null;
  /** null matches any port; an explicit port must equal the effective port. */
  port: string | null;
  /** null or "/" matches any path; otherwise a segment-boundary prefix. */
  path: string | null;
}

/** Specificity tuple: [host class, host label count, path length]. */
type Specificity = [number, number, number];

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostPattern(authority: string): HostPattern | null {
  const host = authority.toLowerCase();
  if (host.includes("*")) {
    const m = /^\*\.(.+)$/.exec(host);
    if (m === null) return null; // `*` not in the leading label → unmatchable
    return { kind: "wildcard", suffix: m[1]! };
  }
  if (host.includes("{") || host.includes("}")) {
    // Each `{name}` label matches exactly one DNS label.
    const parts = host.split(/{[^}]*}/);
    const regex = new RegExp(
      `^${parts.map(escapeRegExp).join(DNS_LABEL)}$`,
      "i",
    );
    return { kind: "placeholder", regex };
  }
  if (!new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`, "i").test(host)) {
    return null;
  }
  return { kind: "exact", host };
}

/**
 * Split a token into authority + path without URL parsing — `{subdomain}` and
 * `*.` hosts are not valid URL input. Returns null when the token is not
 * host-shaped at all.
 */
function parseAuthority(
  token: string,
): { host: string; port: string | null; path: string | null } | null {
  let rest = token;
  let path: string | null = null;
  const slash = rest.indexOf("/");
  if (slash !== -1) {
    path = rest.slice(slash);
    rest = rest.slice(0, slash);
  }
  let port: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const candidate = rest.slice(colon + 1);
    if (/^\d{1,5}$/.test(candidate)) {
      port = candidate;
      rest = rest.slice(0, colon);
    }
  }
  if (rest === "") return null;
  return { host: rest, port, path };
}

const SCHEME_TOKEN_RE = /(https?|ftp|wss?):\/\/[^\s,;'"<>\]()]*/gi;
// Bare hosts, wildcard hosts, and placeholder hosts, optionally with
// :port and /path. Requires a dot so prose words never become targets.
const HOST_TOKEN_RE =
  /(?:\*\.|\{[^}\s]*\}\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s,;'"<>\]()]*)?/gi;

/** Every matchable pattern a target row's location/name carries. */
function patternsOf(target: ScopeTargetInput): TargetPattern[] {
  const patterns: TargetPattern[] = [];
  for (const field of [target.location, target.name]) {
    if (field === null || field === undefined) continue;
    const consumed: string[] = [];
    for (const m of field.matchAll(SCHEME_TOKEN_RE)) {
      const raw = m[0];
      consumed.push(raw);
      const scheme = raw.slice(0, raw.indexOf("://")).toLowerCase();
      const authority = parseAuthority(raw.slice(raw.indexOf("://") + 3));
      if (authority === null) continue;
      const host = hostPattern(authority.host);
      if (host === null) continue;
      patterns.push({
        host,
        scheme,
        port: authority.port,
        path: authority.path,
      });
    }
    const remainder = field.replace(SCHEME_TOKEN_RE, " ");
    for (const m of remainder.matchAll(HOST_TOKEN_RE)) {
      const authority = parseAuthority(m[0]);
      if (authority === null) continue;
      const host = hostPattern(authority.host);
      if (host === null) continue;
      patterns.push({
        host,
        scheme: null,
        port: authority.port,
        path: authority.path,
      });
    }
  }
  return patterns;
}

const HOST_CLASS: Record<HostPattern["kind"], number> = {
  exact: 3,
  placeholder: 2,
  wildcard: 1,
};

function hostLabelCount(host: HostPattern): number {
  const text =
    host.kind === "wildcard"
      ? host.suffix
      : host.kind === "exact"
        ? host.host
        : host.regex.source;
  return text.split(".").length;
}

function specificity(pattern: TargetPattern): Specificity {
  return [
    HOST_CLASS[pattern.host.kind],
    hostLabelCount(pattern.host),
    pattern.path !== null && pattern.path !== "/" ? pattern.path.length : 0,
  ];
}

function cmpSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

interface ParsedActionUrl {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

/** Parse the proposed URL; a bare host is accepted as https. */
function parseActionUrl(raw: string): ParsedActionUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    try {
      url = new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }
  if (url.hostname === "") return null;
  return {
    scheme: url.protocol.slice(0, -1).toLowerCase(),
    host: url.hostname.toLowerCase(),
    port: url.port,
    path: url.pathname,
  };
}

function hostMatches(pattern: HostPattern, host: string): boolean {
  switch (pattern.kind) {
    case "exact":
      return host === pattern.host;
    case "wildcard":
      // Label-boundary: the action host must be strictly beneath the suffix —
      // at least one extra leading label, never the apex itself.
      return host.endsWith(`.${pattern.suffix}`);
    case "placeholder":
      pattern.regex.lastIndex = 0;
      return pattern.regex.test(host);
  }
}

function pathMatches(pattern: TargetPattern, path: string): boolean {
  const p = pattern.path;
  if (p === null || p === "/") return true;
  return path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function patternMatches(pattern: TargetPattern, url: ParsedActionUrl): boolean {
  if (pattern.scheme !== null && pattern.scheme !== url.scheme) return false;
  if (pattern.port !== null && pattern.port !== url.port) return false;
  return hostMatches(pattern.host, url.host) && pathMatches(pattern, url.path);
}

interface Match {
  target: ScopeTargetInput;
  scope: "in" | "out";
  specificity: Specificity;
}

/**
 * Resolve the proposed URL against the declared scope inventory. The most
 * specific matching pattern decides; ties between in-scope and out-of-scope
 * listings at top specificity are `ambiguous`, never silently ordered.
 *
 * An explicit `targetId` is the most specific selector of all: when it
 * names a declared inventory row it wins outright, whatever the URL would
 * have matched. An unknown `targetId` falls back to URL matching (the
 * evaluator then flags it TARGET_ID_UNRESOLVED).
 */
export function resolveTarget(
  rawUrl: string,
  inventory: ScopeInventoryInput,
  targetId?: string,
): TargetResolution {
  if (targetId !== undefined) {
    for (const [scope, list] of [
      ["in", inventory.in_scope ?? []],
      ["out", inventory.out_of_scope ?? []],
    ] as const) {
      const hit = list.find((t) => t.target_id === targetId);
      if (hit !== undefined) {
        return {
          status:
            scope === "in" ? "matched_in_scope" : "matched_out_of_scope",
          target_ids: [hit.target_id],
          evidence_refs: [...hit.evidence_refs].sort(),
        };
      }
    }
  }

  const url = parseActionUrl(rawUrl);
  if (url === null) return { status: "unlisted" };

  const matches: Match[] = [];
  for (const [scope, list] of [
    ["in", inventory.in_scope ?? []],
    ["out", inventory.out_of_scope ?? []],
  ] as const) {
    for (const target of list) {
      let best: Specificity | null = null;
      for (const pattern of patternsOf(target)) {
        if (!patternMatches(pattern, url)) continue;
        const spec = specificity(pattern);
        if (best === null || cmpSpecificity(spec, best) > 0) best = spec;
      }
      if (best !== null) matches.push({ target, scope, specificity: best });
    }
  }

  if (matches.length === 0) return { status: "unlisted" };

  const top = matches.reduce((a, b) =>
    cmpSpecificity(a.specificity, b.specificity) >= 0 ? a : b,
  ).specificity;
  const winners = matches.filter(
    (m) => cmpSpecificity(m.specificity, top) === 0,
  );
  const scopes = new Set(winners.map((m) => m.scope));
  const ids = [...new Set(winners.map((m) => m.target.target_id))].sort();

  if (scopes.size > 1) {
    return { status: "ambiguous", candidate_target_ids: ids };
  }
  const evidence = [
    ...new Set(winners.flatMap((m) => m.target.evidence_refs)),
  ].sort();
  return {
    status: winners[0]!.scope === "in" ? "matched_in_scope" : "matched_out_of_scope",
    target_ids: ids,
    evidence_refs: evidence,
  };
}
