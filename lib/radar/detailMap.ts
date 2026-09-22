import type { DetailsData } from "../dom/details";
import type { DomTarget, DomTargetGroup } from "../dom/targets";
import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../types";

/**
 * Maps the DOM collectors' brief output (collectDetails + collectTargets on
 * /engagements/<slug>) onto ApiEngagementData — the shape the feature
 * extractor and persistence layer already speak. This is the researcher-side
 * replacement for the org-API parseEngagement path: the site brief carries
 * the same fields in markup.
 *
 * `uuid` receives the engagement slug — the canonical researcher-visible id
 * (briefUrl segment); the site surface never exposes an org-API uuid.
 * `observedApiVersion` is always null: no API produced this document.
 *
 * Pure and deterministic: no Date.now(), no network, no randomness.
 */

/** "$2,000 – $3,000" → 3000. Reward strings can be ranges; the tier's
 *  potential is its ceiling, so the maximum amount wins. Non-monetary text
 *  ("Points", "Kudos") and junk → null. */
function rewardAmount(raw: number | string | null): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== "string") return null;
  let max: number | null = null;
  for (const m of raw.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

/** DOM stats keys are slugified with dashes ("vulnerabilities-rewarded");
 *  ApiEngagementData/statistics consumers expect snake_case. */
function normalizeStatistics(
  stats: Record<string, { value: string; window: string | null }>,
): Record<string, { value: string; window: string | null }> {
  const out: Record<string, { value: string; window: string | null }> = {};
  for (const [key, entry] of Object.entries(stats)) {
    out[key.replace(/-/g, "_")] = entry;
  }
  return out;
}

function mapGroup(group: DomTargetGroup): ApiTargetGroup {
  return {
    id: group.domKey,
    name: group.name,
    inScope: group.inScope,
    description: group.description,
    rewards: {
      p1: rewardAmount(group.rewards.p1),
      p2: rewardAmount(group.rewards.p2),
      p3: rewardAmount(group.rewards.p3),
      p4: rewardAmount(group.rewards.p4),
      p5: rewardAmount(group.rewards.p5),
    },
  };
}

function mapTarget(target: DomTarget): ApiTarget {
  return {
    id: target.domKey,
    groupId: target.groupDomKey,
    location: target.location,
    name: target.name,
    category: target.category,
    tags: [...target.tags],
    inScope: target.inScope,
  };
}

export function mapBriefToEngagement(
  slug: string,
  details: DetailsData,
  groups: DomTargetGroup[],
  targets: DomTarget[],
): ApiEngagementData {
  return {
    uuid: slug,
    name: details.name,
    code: details.code ?? slug,
    engagementType: details.engagementType,
    managedBounty: details.managedBounty,
    lifecycleStatus: details.lifecycleStatus,
    testingStart: details.testingStart,
    testingEnd: details.testingEnd,
    testingPeriodLabel: details.testingPeriodLabel,
    lastStatusTransition: details.lastStatusTransition,
    lastBriefUpdate: details.lastBriefUpdate,
    safeHarborLevel: details.safeHarborLevel,
    statistics: normalizeStatistics(details.statistics),
    targetGroups: groups.map(mapGroup),
    targets: targets.map(mapTarget),
    observedApiVersion: null,
  };
}
