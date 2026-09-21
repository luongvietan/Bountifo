import { apiRequest } from "../api/client";
import { ApiError, type ApiErrorKind } from "../api/errors";
import { parseEngagement } from "../api/engagements";
import type { ApiEngagementData } from "../types";
import { radarSourceHash } from "./hash";
import type { RadarCatalogItem, RadarProgramSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Error classification for a single program's hydration.
//
// FATAL (credential-wide; rethrown — aborts the radar run):
//   unauthorized   token rejected wholesale; every program would fail alike
//   no_token       no credential stored at all
//   storage_locked credential area not locked down — reads must not proceed
//
// NON-FATAL (program-scoped; a snapshot is still produced with detail:null):
//   forbidden, not_found            → enrichment "unavailable"
//   invalid_response, http,
//   network, rate_limited           → enrichment "failed"
//   any non-ApiError (incl. the     → enrichment "failed", error_kind "unknown"
//   TypeError for a missing uuid)
// ---------------------------------------------------------------------------

const FATAL_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  "unauthorized",
  "no_token",
  "storage_locked",
]);

const UNAVAILABLE_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  "forbidden",
  "not_found",
]);

/**
 * Hydrates one catalog row into a RadarProgramSnapshot via GET_ENGAGEMENT
 * (include=target_groups,targets) + parseEngagement — API detail only, never
 * the DOM exporter. The uuid is used verbatim from the catalog item; it is
 * never re-resolved through the catalog.
 *
 * A program-scoped failure never aborts the run: the returned snapshot keeps
 * `detail: null` and an `enrichment` of "unavailable" (forbidden/not_found)
 * or "failed" (invalid_response/http/network/rate_limited, or "unknown" for
 * non-ApiError throws). Credential-wide failures (unauthorized, no_token,
 * storage_locked) are fatal and rethrown as the original ApiError.
 *
 * `source_hash` always hashes `{catalog, detail}` — a failed snapshot's hash
 * legitimately differs from the hash once hydration succeeds.
 */
export async function hydrateRadarProgram(
  catalogItem: RadarCatalogItem,
): Promise<RadarProgramSnapshot> {
  let detail: ApiEngagementData | null = null;
  let enrichment: RadarProgramSnapshot["enrichment"] = { status: "complete" };
  try {
    const res = await apiRequest({
      operation: "GET_ENGAGEMENT",
      uuid: catalogItem.uuid,
    });
    detail = parseEngagement(res.data, res.observedVersion);
  } catch (err) {
    if (err instanceof ApiError) {
      if (FATAL_KINDS.has(err.kind)) throw err;
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
