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
 * URL-shape API detection — V1.4 contract STUB (`return false`). Agent C
 * implements the pinned host/path token rules (API_HOST_TOKENS /
 * API_PATH_TOKENS over parseable http(s) URLs). Until then classification is
 * identical to the pre-V1.4 semantics: only exact token membership counts.
 */
export function locationLooksApi(location: string | null): boolean {
  return false;
}

/**
 * One target → {api, web} flags: api = API token match (the
 * `locationLooksApi` URL-shape term lands with Agent C — stubbed false, so
 * today api = token match only); web = WEB token match OR the http(s)
 * fallback, which fires only when NEITHER class matched.
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
    web: isWeb || (!isApi && !isWeb && isHttpUrl(target.location)),
  };
}
