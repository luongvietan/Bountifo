import { siteRequest } from "../api/siteClient";
import { ApiError, type ApiErrorKind } from "../api/errors";
import { BUGCROWD_SITE } from "../constants";
import type { ApiEngagementData } from "../types";
import { radarSourceHash } from "./hash";
import { parseBriefHtml } from "./offscreen";
import type { RadarCatalogItem, RadarProgramSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Error classification for a single program's hydration.
//
// The researcher site surface has no credential-wide failure equivalent to
// the old API's "token rejected": session cookies either ride along or they
// don't, and a missing/expired session degrades ONLY the items that need it
// (private briefs redirect to login; the public catalog keeps answering).
// Every ApiError is therefore program-scoped:
//
//   unauthorized, forbidden, not_found → enrichment "unavailable"
//   invalid_response, http,
//   network, rate_limited             → enrichment "failed"
//   non-ApiError (incl. offscreen     → enrichment "failed", error_kind
//   plumbing bugs)                       "unknown"
// ---------------------------------------------------------------------------

const UNAVAILABLE_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
]);

/**
 * Hydrates one catalog row into a RadarProgramSnapshot: GET the brief page
 * HTML via the site client, then parse it into ApiEngagementData through the
 * offscreen document (the exporter's DOM collectors — service workers have
 * no DOM). The slug is the item's canonical identity (`code`, falling back
 * to `uuid`, which carries the same value in V1.2).
 *
 * A program-scoped failure never aborts the run: the returned snapshot keeps
 * `detail: null` and an `enrichment` of "unavailable" or "failed" per the
 * classification above.
 *
 * `source_hash` always hashes `{catalog, detail}` — a failed snapshot's hash
 * legitimately differs from the hash once hydration succeeds.
 */
export async function hydrateRadarProgram(
  catalogItem: RadarCatalogItem,
): Promise<RadarProgramSnapshot> {
  const slug = catalogItem.code ?? catalogItem.uuid;
  let detail: ApiEngagementData | null = null;
  let enrichment: RadarProgramSnapshot["enrichment"] = { status: "complete" };
  try {
    const res = await siteRequest({ operation: "GET_BRIEF", slug });
    detail = await parseBriefHtml(
      slug,
      res.data,
      `${BUGCROWD_SITE}/engagements/${slug}`,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      enrichment = {
        status: UNAVAILABLE_KINDS.has(err.kind) ? "unavailable" : "failed",
        error_kind: err.kind,
      };
    } else {
      enrichment = { status: "failed", error_kind: "unknown" };
    }
  }
  return {
    schema_version: 1,
    uuid: catalogItem.uuid,
    code: catalogItem.code,
    catalog: catalogItem,
    detail,
    enrichment,
    source_hash: await radarSourceHash({ catalog: catalogItem, detail }),
  };
}
