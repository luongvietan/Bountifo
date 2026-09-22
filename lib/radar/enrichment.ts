import { siteRequest } from "../api/siteClient";
import { ApiError, type ApiErrorKind } from "../api/errors";
import type { ApiEngagementData } from "../types";
import { mapBriefDocument } from "./detailMap";
import { radarSourceHash } from "./hash";
import type { RadarCatalogItem, RadarProgramSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Error classification for a single program's hydration.
//
// The researcher site surface has no credential-wide failure equivalent to
// the old API's "token rejected": session cookies either ride along or they
// don't, and a missing/expired session degrades ONLY the items that need it
// (private briefs 401/redirect to login; the public catalog keeps answering).
// Every ApiError is therefore program-scoped:
//
//   unauthorized, forbidden, not_found → enrichment "unavailable"
//   invalid_response, http,
//   network, rate_limited             → enrichment "failed"
//   non-ApiError (plumbing bugs)      → enrichment "failed", error_kind
//                                       "unknown"
// ---------------------------------------------------------------------------

const UNAVAILABLE_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
]);

interface ChangelogEntry {
  id: string;
  changelogState?: string;
}

/** Picks the version id of the current brief document from the changelog
 *  list: the entry tagged "Latest", falling back to the first entry (the
 *  list is newest-first). A list with no usable entry is invalid_response. */
function latestChangelogId(data: unknown): string {
  const entries = (
    data !== null && typeof data === "object"
      ? (data as { changelogs?: unknown }).changelogs
      : undefined
  ) as ChangelogEntry[] | undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ApiError("invalid_response", "changelog list empty");
  }
  const latest =
    entries.find((e) => e?.changelogState === "Latest") ?? entries[0];
  const id = latest?.id;
  if (typeof id !== "string" || id === "") {
    throw new ApiError("invalid_response", "changelog entry has no id");
  }
  return id;
}

/**
 * Hydrates one catalog row into a RadarProgramSnapshot over the site JSON
 * surface:
 *
 *   GET /engagements/<slug>/changelog.json          → current version id
 *   GET /engagements/<slug>/changelog/<id>.json     → structured brief doc
 *   GET /engagements/<slug>/statistics.json         → stats (non-fatal: an
 *     errored stats fetch degrades to empty statistics — the affected
 *     signals read unknown — rather than failing a hydrated brief)
 *
 * The slug is the item's canonical identity (`code`, falling back to `uuid`,
 * which carries the same value in V1.2).
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
    const changelogRes = await siteRequest({
      operation: "GET_CHANGELOGS",
      slug,
    });
    const versionId = latestChangelogId(changelogRes.data);
    const docRes = await siteRequest({
      operation: "GET_BRIEF_DOC",
      slug,
      versionId,
    });
    let stats: unknown = null;
    try {
      const statsRes = await siteRequest({
        operation: "GET_BRIEF_STATS",
        slug,
      });
      stats = statsRes.data;
    } catch {
      // Stats are a secondary signal source; a stats failure degrades to
      // empty statistics rather than discarding the hydrated brief.
      stats = null;
    }
    detail = mapBriefDocument(slug, docRes.data, stats);
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
