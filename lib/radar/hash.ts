import { canonicalJson } from "../canonical";
import { sha256Hex } from "../hash";
import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../types";
import type { RadarDeepEnrichment } from "./deepTypes";
import type { RadarCatalogItem } from "./types";

/**
 * Deterministic `source_hash` for one catalog item + its parsed detail:
 * `"sha256:" + hex` of SHA-256 over a domain-separated canonical preimage
 * (`radar-source-v1:` + canonicalJson of the projection below).
 *
 * The projection carries every scoring input: catalog uuid/code/name/
 * lifecycle_status/engagement_type and the full parsed detail (identity,
 * lifecycle timestamps, safe harbor, statistics, target groups incl.
 * rewards, targets incl. tags/inScope). Any change to a scoring input must
 * change the hash.
 *
 * Deliberately excluded (volatile bookkeeping, not semantics):
 * `catalog.discovered_at`, `detail.observedApiVersion`, scan/run
 * timestamps, runtime progress, and error details.
 *
 * Order-independence: targetGroups and targets sort by `id` (content
 * canonical form breaks a duplicate-id tie so arrival order can never leak
 * in), and each target's `tags` sort lexicographically. Statistics key
 * order is already normalized by canonicalJson. Same semantic metadata →
 * same hash regardless of async arrival order.
 */
export async function radarSourceHash(input: {
  catalog: RadarCatalogItem;
  detail: ApiEngagementData | null;
  /** V1.3 deep-enrichment payload — a scoring input once present, so it
   *  joins the hash (absent and null hash identically). Its fields are
   *  clock-free by contract, so nothing volatile enters the preimage. */
  deep?: RadarDeepEnrichment | null;
}): Promise<string> {
  const { catalog, detail } = input;
  const projection = {
    catalog: {
      uuid: catalog.uuid,
      code: catalog.code,
      name: catalog.name,
      lifecycle_status: catalog.lifecycle_status,
      engagement_type: catalog.engagement_type,
    },
    detail: detail === null ? null : detailProjection(detail),
    // Only present once a deep pass ran: absent/null deep payloads hash
    // identically to the V1.2 preimage, so a metadata-only snapshot keeps
    // its existing score rows.
    ...(input.deep === undefined || input.deep === null
      ? {}
      : { deep: input.deep }),
  };
  return `sha256:${await sha256Hex(`radar-source-v1:${canonicalJson(projection)}`)}`;
}

function detailProjection(detail: ApiEngagementData) {
  return {
    uuid: detail.uuid,
    name: detail.name,
    code: detail.code,
    engagementType: detail.engagementType,
    managedBounty: detail.managedBounty,
    lifecycleStatus: detail.lifecycleStatus,
    testingStart: detail.testingStart,
    testingEnd: detail.testingEnd,
    testingPeriodLabel: detail.testingPeriodLabel,
    lastStatusTransition: detail.lastStatusTransition,
    lastBriefUpdate: detail.lastBriefUpdate,
    safeHarborLevel: detail.safeHarborLevel,
    statistics: detail.statistics,
    targetGroups: detail.targetGroups
      .map(groupProjection)
      .sort(byIdThenContent),
    targets: detail.targets.map(targetProjection).sort(byIdThenContent),
    // V1.4 brief facts are scoring inputs — they join the preimage.
    participation: detail.participation,
    credentialsProvided: detail.credentialsProvided,
    briefText: detail.briefText,
    // observedApiVersion excluded: volatile response-header bookkeeping.
  };
}

function groupProjection(group: ApiTargetGroup) {
  return {
    id: group.id,
    name: group.name,
    inScope: group.inScope,
    description: group.description,
    rewards: group.rewards,
  };
}

function targetProjection(target: ApiTarget) {
  return {
    id: target.id,
    groupId: target.groupId,
    location: target.location,
    name: target.name,
    category: target.category,
    tags: [...target.tags].sort(),
    inScope: target.inScope,
  };
}

/** Primary key `id`; duplicate ids order by canonical content — never input order. */
function byIdThenContent<T extends { id: string }>(a: T, b: T): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}
