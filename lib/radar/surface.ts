import type { ApiTarget } from "../types";

// ---------------------------------------------------------------------------
// Shared target surface classifier (extracted for V1.4 — previously a
// verbatim copy in both features.ts and diff.ts). One implementation feeds
// `classifySurfaces` (api_surface / api_surface_size / web_surface) AND
// `diffBriefDocuments` (added_api_targets / added_web_targets), so the two
// can never drift.
//
// Deterministic surface token sets — exact token membership only, so
// substring traps ("capitol"⊅"api", "restaurant"⊅"rest") never match.
// ---------------------------------------------------------------------------

export const API_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "rest",
  "graphql",
  "grpc",
  "webservice",
  "endpoint",
]);
export const WEB_TOKENS: ReadonlySet<string> = new Set([
  "web",
  "website",
  "webapp",
  "webapplication",
]);

/**
 * Token set of a target: category, name and each tag, lowercased and split on
 * non-alphanumeric runs. Exact set membership only — never substring match.
 * `location` is deliberately NOT tokenized: the web fallback reads it as a
 * URL instead.
 */
export function tokenSet(target: ApiTarget): Set<string> {
  const out = new Set<string>();
  const fields: unknown[] = [
    target.category,
    target.name,
    ...(Array.isArray(target.tags) ? target.tags : []),
  ];
  for (const field of fields) {
    if (typeof field !== "string") continue;
    for (const token of field.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token !== "") out.add(token);
    }
  }
  return out;
}

export function intersects(a: Set<string>, b: ReadonlySet<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/** True iff `location` parses as an http(s) URL — a web target absent other
 *  info. */
export function isHttpUrl(location: string | null): boolean {
  if (location === null) return false;
  try {
    const protocol = new URL(location.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * URL-shape token sets — V1.4. Exact membership only (same discipline as
 * tokenSet): `api.example.com` matches on host token "api", while
 * `apiserver.example.com` and `capitol.example.com` never can.
 * API_PATH_TOKENS includes the plurals API_HOST_TOKENS lacks — "/services"
 * is an api path even though a "services." host is ambiguous.
 */
const API_HOST_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "apis",
  "graphql",
  "grpc",
  "gateway",
  "rest",
  "rpc",
  "ws",
  "webservice",
  "service",
]);
const API_PATH_TOKENS: ReadonlySet<string> = new Set([
  "api",
  "graphql",
  "graphiql",
  "rest",
  "rpc",
  "webservice",
  "service",
  "services",
]);

/**
 * URL-shape API detection — V1.4. True iff `location` parses (`new URL` on
 * the trimmed string) with an http/https protocol AND either:
 *   - the lowercased hostname, split on /[^a-z0-9]+/, contains an
 *     API_HOST_TOKENS token ("api.acme.com", "internal-api.acme.com"), or
 *   - the FIRST pathname segment — percent-decoded and lowercased (V1.5:
 *     "/API" and "/%61pi" classify like "/api"; malformed escapes fall back
 *     to the raw segment) — is an API_PATH_TOKENS token
 *     ("example.com/api/v1").
 * Pinned conservatism: a bare version segment ("/v2/users") does NOT count,
 * and an api token deeper than path segment 1 ("/docs/api") does NOT count.
 * Non-URL locations ("api.example.com" with no scheme), non-http(s) schemes
 * (mailto:, ftp:) and null all read false — shape only ever ADDS api
 * classifications on top of tokenSet.
 */
export function locationLooksApi(location: string | null): boolean {
  if (location === null) return false;
  let url: URL;
  try {
    url = new URL(location.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  for (const token of url.hostname.toLowerCase().split(/[^a-z0-9]+/)) {
    if (API_HOST_TOKENS.has(token)) return true;
  }
  const firstSegment = url.pathname
    .split("/")
    .find((segment) => segment !== "");
  if (firstSegment === undefined) return false;
  let segment = firstSegment;
  try {
    segment = decodeURIComponent(firstSegment);
  } catch {
    // Malformed escape — compare the raw segment rather than dropping it.
  }
  return API_PATH_TOKENS.has(segment.toLowerCase());
}

/**
 * One target → {api, web} flags: api = API token match OR an api-shaped
 * http(s) `location` (V1.4 `locationLooksApi`); web = WEB token match OR the
 * http(s) fallback, which fires only when NEITHER class matched — so an
 * api-shaped URL counts as api, never double-counted as fallback web.
 */
export function classifyTarget(target: ApiTarget): {
  api: boolean;
  web: boolean;
} {
  const tokens = tokenSet(target);
  const isApi =
    intersects(tokens, API_TOKENS) || locationLooksApi(target.location);
  const isWeb = intersects(tokens, WEB_TOKENS);
  return {
    api: isApi,
    web: isWeb || (!isApi && isHttpUrl(target.location)),
  };
}
