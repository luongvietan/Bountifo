import { siteRequest } from "../api/siteClient";
import type { ApiEngagementData } from "../types";
import { mapBriefDocument } from "./detailMap";
import { diffBriefDocuments } from "./diff";
import { radarSourceHash } from "./hash";
import { parseChangelogList, selectDiffBaseline } from "./history";
import { fetchKnownIssueSummary } from "./knownIssues";
import type {
  RadarDeepEnrichment,
  RadarSemanticDiff,
} from "./deepTypes";
import type { RadarCatalogItem, RadarProgramSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Deep enrichment orchestrator (V1.3): runs once per shortlisted program in
// the coordinator's deep_enriching phase.
//
//   GET /engagements/<slug>/engagement_known_issues.json  → duplicate pressure
//   GET /engagements/<slug>/changelog.json                → latest + baseline id
//   GET /engagements/<slug>/changelog/<baseline>.json     → previous brief doc
//
// 3 site requests per program; the coordinator caps the stage at
// DEEP_ANALYSIS_LIMIT so a catalog scan stays ~4·N + 3·30 requests.
//
// Contract: NEVER throws. A program-scoped failure lands in the affected
// sub-object's status and the envelope degrades honestly — nothing here is
// fabricated for programs the deep pass could not analyze.
// ---------------------------------------------------------------------------

function nullDiff(
  status: RadarSemanticDiff["status"],
  from_version: string | null,
  to_version: string | null,
): RadarSemanticDiff {
  return {
    status,
    from_version,
    to_version,
    added_targets: null,
    removed_targets: null,
    added_in_scope_targets: null,
    removed_in_scope_targets: null,
    moved_in_scope: null,
    moved_out_of_scope: null,
    added_api_targets: null,
    added_web_targets: null,
    added_groups: null,
    reward_increase: null,
    reward_decrease: null,
    safe_harbor_changed: null,
    status_changed: null,
    only_administrative_changes: null,
  };
}

/**
 * Envelope status from the two sub-source statuses. "no_baseline" counts as
 * a completed history check (an honest "there is nothing to diff"), so
 * complete-ki + no_baseline-diff still yields a complete envelope.
 */
function envelopeStatus(
  ki: RadarDeepEnrichment["status"] | "no_baseline",
  diff: RadarSemanticDiff["status"],
): RadarDeepEnrichment["status"] {
  const kiDone = ki === "complete";
  const diffDone = diff === "complete" || diff === "no_baseline";
  if (kiDone && diffDone) return "complete";
  if (kiDone || diffDone) return "partial";
  return ki === "failed" || diff === "unavailable" ? "failed" : "unavailable";
}

/**
 * Semantic diff for one program: refetch the changelog list, pick the
 * current Latest id and its immediate predecessor, fetch that baseline doc,
 * and diff mapped details. Failures → "unavailable" with fact fields null.
 */
async function fetchSemanticDiff(
  slug: string,
  snapshot: RadarProgramSnapshot,
): Promise<RadarSemanticDiff> {
  let baselineId: string | null;
  let latestId: string | null;
  try {
    const res = await siteRequest({ operation: "GET_CHANGELOGS", slug });
    const entries = parseChangelogList(res.data);
    const latest =
      entries.find((e) => e.state === "Latest") ?? entries[0] ?? null;
    latestId = latest?.id ?? null;
    baselineId =
      latestId === null ? null : selectDiffBaseline(entries, latestId);
  } catch {
    return nullDiff("unavailable", null, null);
  }
  if (latestId === null || baselineId === null) {
    return nullDiff("no_baseline", null, latestId);
  }
  let prevDetail: ApiEngagementData;
  try {
    const docRes = await siteRequest({
      operation: "GET_BRIEF_DOC",
      slug,
      versionId: baselineId,
    });
    // Statistics/joined lists are signals of the CURRENT version — the
    // baseline doc maps with them absent; the differ ignores them anyway.
    prevDetail = mapBriefDocument(slug, docRes.data, null, null);
  } catch {
    return nullDiff("unavailable", baselineId, latestId);
  }
  // snapshot.detail is guaranteed non-null by the caller.
  return diffBriefDocuments(prevDetail, snapshot.detail!, {
    from_version: baselineId,
    to_version: latestId,
  });
}

/**
 * Injected into RadarCoordinator as `deepHydrate`. Returns a NEW snapshot
 * carrying `deep` — never mutates, never throws. Programs whose metadata
 * pass found no detail are returned unchanged (the coordinator also skips
 * them before calling, so this is defense-in-depth).
 */
export async function hydrateRadarDeep(
  item: RadarCatalogItem,
  snapshot: RadarProgramSnapshot,
): Promise<RadarProgramSnapshot> {
  if (snapshot.detail === null) return snapshot;
  const slug = item.code ?? item.uuid;
  const [ki, diff] = await Promise.all([
    fetchKnownIssueSummary(slug),
    fetchSemanticDiff(slug, snapshot),
  ]);
  const deep: RadarDeepEnrichment = {
    status: envelopeStatus(ki.status, diff.status),
    known_issues: ki,
    semantic_diff: diff,
  };
  return {
    ...snapshot,
    deep,
    source_hash: await radarSourceHash({
      catalog: snapshot.catalog,
      detail: snapshot.detail,
      deep,
    }),
  };
}
