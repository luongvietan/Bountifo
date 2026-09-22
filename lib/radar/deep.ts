import { siteRequest } from "../api/siteClient";
import type { ApiEngagementData, ApiTargetGroup } from "../types";
import { fetchScopeArc, selectArcBaseline } from "./arc";
import { mapBriefDocument } from "./detailMap";
import { diffBriefDocuments } from "./diff";
import { fetchGroupKiStats } from "./groupStats";
import type { GroupKiCategory } from "./groupStats";
import { radarSourceHash } from "./hash";
import {
  parseChangelogList,
  selectDiffBaseline,
  type RadarChangelogEntry,
} from "./history";
import { fetchKnownIssueSummary } from "./knownIssues";
import type {
  RadarDeepEnrichment,
  RadarGroupStats,
  RadarKnownIssueSummary,
  RadarScopeArc,
  RadarSemanticDiff,
} from "./deepTypes";
import {
  KI_GROUP_MAX_GROUPS,
  KI_GROUP_MIN_UNIQUE,
  type RadarCatalogItem,
  type RadarProgramSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Deep enrichment orchestrator (V1.5): runs once per shortlisted program in
// the coordinator's deep_enriching phase.
//
//   GET /engagements/<slug>/engagement_known_issues.json   → duplicate pressure
//   GET /engagements/<slug>/changelog.json                 → latest + baselines
//   GET /engagements/<slug>/changelog/<baseline>.json      → step baseline doc
//   GET /engagements/<slug>/changelog/<arc-baseline>.json  → arc baseline doc
//     (deduped against the step baseline when selection lands on it)
//   GET /engagements/<slug>/target_groups/<id>/known_issue_stats × ≤6
//     (gated: aggregate complete, unique ≥ KI_GROUP_MIN_UNIQUE,
//      1..KI_GROUP_MAX_GROUPS qualifying in-scope groups)
//
// ≤ 1 + 1 + 1 + 1 + 6 = 10 site requests per program; the coordinator bounds
// the stage at MAX_DEEP_PROGRAMS (60) unique candidates so a catalog scan
// stays ~4·N + 10·≤60 requests.
//
// Contract: NEVER throws. A program-scoped failure lands in the affected
// sub-object's status and the envelope degrades honestly — nothing here is
// fabricated for programs the deep pass could not analyze.
// ---------------------------------------------------------------------------

const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
 * Envelope status from the four sub-source statuses. Terminal-OK covers a
 * deliberate bound too — "no_baseline" and the group-stats "skipped_*"
 * states are completed checks, not missing data — while a clean sweep of
 * failures maps to "failed" only when at least one source actually failed
 * (vs merely being absent for the program).
 */
function envelopeStatus(
  ki: RadarKnownIssueSummary["status"],
  diff: RadarSemanticDiff["status"],
  arc: RadarScopeArc["status"],
  groups: RadarGroupStats["status"],
): RadarDeepEnrichment["status"] {
  const ok =
    (ki === "complete" ? 1 : 0) +
    (diff === "complete" || diff === "no_baseline" ? 1 : 0) +
    (arc === "complete" || arc === "no_baseline" ? 1 : 0) +
    (groups === "complete" || groups.startsWith("skipped_") ? 1 : 0);
  if (ok === 4) return "complete";
  if (ok === 0) {
    return ki === "failed" || groups === "failed" ? "failed" : "unavailable";
  }
  return "partial";
}

interface ChangelogHistory {
  entries: RadarChangelogEntry[];
  latestId: string | null;
}

/**
 * Changelog list for one program — the single fetch shared by the step
 * diff and the arc. null on fetch/parse failure; both history consumers
 * then read "unavailable".
 */
async function fetchChangelogHistory(
  slug: string,
): Promise<ChangelogHistory | null> {
  try {
    const res = await siteRequest({ operation: "GET_CHANGELOGS", slug });
    const entries = parseChangelogList(res.data);
    const latest =
      entries.find((e) => e.state === "Latest") ?? entries[0] ?? null;
    return { entries, latestId: latest?.id ?? null };
  } catch {
    return null;
  }
}

/**
 * One historical brief document mapped for diffing. Statistics/joined
 * lists are signals of the CURRENT version — baseline docs map with them
 * absent; the differ ignores them anyway. Throws on fetch/parse failure.
 */
async function fetchBaselineDetail(
  slug: string,
  versionId: string,
): Promise<ApiEngagementData> {
  const res = await siteRequest({
    operation: "GET_BRIEF_DOC",
    slug,
    versionId,
  });
  return mapBriefDocument(slug, res.data, null, null);
}

/**
 * The V1.3 single-step diff over a prefetched changelog list: immediate
 * predecessor of the current Latest. `baselineDetail` rides back so the
 * arc can reuse the document when its baseline lands on the same version.
 */
async function fetchSemanticDiff(
  slug: string,
  history: ChangelogHistory,
  currentDetail: ApiEngagementData,
): Promise<{
  diff: RadarSemanticDiff;
  baselineId: string | null;
  baselineDetail: ApiEngagementData | null;
}> {
  const latestId = history.latestId;
  const baselineId =
    latestId === null
      ? null
      : selectDiffBaseline(history.entries, latestId);
  if (latestId === null || baselineId === null) {
    return {
      diff: nullDiff("no_baseline", null, latestId),
      baselineId: null,
      baselineDetail: null,
    };
  }
  try {
    const baselineDetail = await fetchBaselineDetail(slug, baselineId);
    return {
      diff: diffBriefDocuments(baselineDetail, currentDetail, {
        from_version: baselineId,
        to_version: latestId,
      }),
      baselineId,
      baselineDetail,
    };
  } catch {
    return {
      diff: nullDiff("unavailable", baselineId, latestId),
      baselineId,
      baselineDetail: null,
    };
  }
}

/**
 * The V1.5 multi-publish arc over the same changelog list. When the arc
 * baseline IS the step baseline already fetched (short histories clamp to
 * the oldest entry), the mapped document is diffed in place — no second
 * request. Otherwise fetchScopeArc owns its own select+fetch (≤1 request).
 */
async function resolveScopeArc(
  slug: string,
  history: ChangelogHistory,
  baselineId: string | null,
  baselineDetail: ApiEngagementData | null,
  currentDetail: ApiEngagementData,
): Promise<RadarScopeArc> {
  const sel = selectArcBaseline(history.entries, history.latestId);
  if (sel === null) {
    return { status: "no_baseline", window_versions: null, diff: null };
  }
  if (sel.id === baselineId && baselineDetail !== null) {
    const diff = diffBriefDocuments(baselineDetail, currentDetail, {
      from_version: sel.id,
      to_version: history.latestId,
    });
    if (diff.status !== "complete") {
      return {
        status: "unavailable",
        window_versions: sel.window,
        diff: null,
      };
    }
    return { status: "complete", window_versions: sel.window, diff };
  }
  return fetchScopeArc(slug, history.entries, history.latestId, currentDetail);
}

/**
 * The gated per-group KI-stats path. The gate runs BEFORE any request:
 * the aggregate summary must have completed with enough volume for a
 * concentration reading to mean anything, the qualifying in-scope group
 * set must be non-empty and bounded, and every group id must be
 * addressable — a group id siteRequest can't route means the sample can
 * never be complete, so the breakdown fails without spending a request.
 * groups_fetched counts requests actually initiated (Promise.all fires
 * them all, even when one rejects).
 */
async function resolveGroupStats(
  slug: string,
  ki: RadarKnownIssueSummary,
  detail: ApiEngagementData,
): Promise<{ groupStats: RadarGroupStats; categories: GroupKiCategory[] | null }> {
  const qualifying: ApiTargetGroup[] = detail.targetGroups.filter(
    (g) => g.inScope === true && g.id !== "",
  );
  const total = qualifying.length;
  const skip = (status: RadarGroupStats["status"]) => ({
    groupStats: {
      status,
      groups_fetched: 0,
      groups_total: total,
    } satisfies RadarGroupStats,
    categories: null,
  });

  if (ki.status !== "complete") return skip("skipped_upstream");
  if ((ki.unique_count ?? 0) < KI_GROUP_MIN_UNIQUE) {
    return skip("skipped_low_volume");
  }
  if (total < 1 || total > KI_GROUP_MAX_GROUPS) {
    return skip("skipped_group_count");
  }
  if (qualifying.some((g) => !GROUP_ID_PATTERN.test(g.id))) {
    return skip("failed");
  }
  const res = await fetchGroupKiStats(
    slug,
    qualifying.map((g) => g.id),
  );
  return {
    groupStats: {
      status: res.status,
      groups_fetched: total,
      groups_total: total,
    },
    categories: res.categories,
  };
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
  const detail = snapshot.detail;
  const [kiBase, history] = await Promise.all([
    fetchKnownIssueSummary(slug),
    fetchChangelogHistory(slug),
  ]);

  const { diff, baselineId, baselineDetail } =
    history === null
      ? {
          diff: nullDiff("unavailable", null, null),
          baselineId: null,
          baselineDetail: null,
        }
      : await fetchSemanticDiff(slug, history, detail);

  const arc: RadarScopeArc =
    history === null
      ? { status: "unavailable", window_versions: null, diff: null }
      : await resolveScopeArc(
          slug,
          history,
          baselineId,
          baselineDetail,
          detail,
        );

  const { groupStats, categories } = await resolveGroupStats(
    slug,
    kiBase,
    detail,
  );
  const ki: RadarKnownIssueSummary = {
    ...kiBase,
    group_stats: groupStats,
    ...(categories !== null ? { categories } : {}),
  };

  const deep: RadarDeepEnrichment = {
    status: envelopeStatus(ki.status, diff.status, arc.status, groupStats.status),
    known_issues: ki,
    semantic_diff: diff,
    scope_arc: arc,
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
