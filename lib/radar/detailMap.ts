import { ApiError } from "../api/errors";
import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../types";

/**
 * Maps the structured researcher-site brief document onto ApiEngagementData —
 * the shape the feature extractor and persistence layer speak. The document is
 * the JSON served at GET /engagements/<slug>/changelog/<version>.json, joined
 * with GET /engagements/<slug>/statistics.json.
 *
 * This replaced both the org-API parseEngagement path and the offscreen DOM
 * collector path: the rendered brief is client-side (the HTML shell carries no
 * scope content), while the changelog document carries the same fields
 * structured — scope groups, targets, cent-denominated reward tiers, safe
 * harbor, lifecycle timestamps.
 *
 * `uuid` receives the engagement slug — the canonical researcher-visible id
 * (briefUrl segment); the site surface never exposes an org-API uuid.
 * `observedApiVersion` receives the changelog document id — the versioned
 * identity of the brief payload itself.
 *
 * Pure and deterministic: no Date.now(), no network, no randomness.
 * Unknown/absent fields map to null/absent — never to invented values.
 */

interface BriefDocScopeGroup {
  id: string;
  name: string;
  inScope: boolean;
  description: string | null;
  rewardCents: { p1: number | null; p2: number | null; p3: number | null; p4: number | null; p5: number | null };
  targets: Record<string, unknown>[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function asBool(v: unknown): boolean {
  return v === true;
}

function centsToDollars(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v / 100 : null;
}

function requireData(doc: unknown): Record<string, unknown> {
  const root = asRecord(doc);
  const data = root === null ? null : asRecord(root.data);
  if (data === null || !Array.isArray(data.scope)) {
    throw new ApiError(
      "invalid_response",
      "brief document missing data.scope",
    );
  }
  return data;
}

function scopeGroupOf(raw: unknown): BriefDocScopeGroup {
  const g = asRecord(raw) ?? {};
  const range = asRecord(g.rewardRange) ?? {};
  return {
    id: asString(g.id) ?? "",
    name: asString(g.name) ?? "Scope",
    inScope: asBool(g.inScope),
    description: asString(g.description) ?? asString(g.descriptionHtml),
    rewardCents: {
      p1: centsToDollars(range.p1MaxCents),
      p2: centsToDollars(range.p2MaxCents),
      p3: centsToDollars(range.p3MaxCents),
      p4: centsToDollars(range.p4MaxCents),
      p5: centsToDollars(range.p5MaxCents),
    },
    targets: Array.isArray(g.targets) ? (g.targets as Record<string, unknown>[]) : [],
  };
}

/** Statistics endpoint keys are camelCase; consumers read snake_case keyed on
 *  the DOM stat label order ("Vulnerabilities rewarded" → vulnerabilities_
 *  rewarded). Known keys get explicit aliases; unknown keys fall back to a
 *  mechanical snake_case conversion. Nulls/absent keys are omitted entirely
 *  so consumers see "unknown", never a fabricated value. */
const STAT_KEY_ALIASES: Record<string, { name: string; numeric: boolean }> = {
  rewardedVulnerabilities: { name: "vulnerabilities_rewarded", numeric: true },
  rewardedVulnerabilitiesSaturation: {
    name: "vulnerabilities_rewarded_saturation",
    numeric: true,
  },
  researchersParticipating: { name: "researchers_participating", numeric: true },
  researchersParticipatingSaturation: {
    name: "researchers_participating_saturation",
    numeric: true,
  },
  // Observed in the live schema but shipped null on the researcher surface —
  // mapped anyway so a populated value flows through without a code change.
  validSubmissionCount: { name: "valid_submission_count", numeric: true },
};

function mapStatistics(
  stats: unknown,
): Record<string, { value: string; window: string | null }> {
  const out: Record<string, { value: string; window: string | null }> = {};
  const src = asRecord(stats);
  if (src === null) return out;
  for (const [key, v] of Object.entries(src)) {
    const alias = STAT_KEY_ALIASES[key];
    const name =
      alias?.name ?? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (typeof v === "number" && Number.isFinite(v)) {
      out[name] = { value: String(v), window: null };
    } else if (typeof v === "string" && v !== "" && alias?.numeric !== true) {
      // Count-typed fields never accept display text; other keys
      // (averagePayout, validationWithin) legitimately carry strings.
      out[name] = { value: v, window: null };
    }
  }
  return out;
}

function mapTarget(raw: Record<string, unknown>, group: BriefDocScopeGroup): ApiTarget {
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  return {
    id: asString(raw.id) ?? "",
    groupId: group.id !== "" ? group.id : null,
    location: asString(raw.uri) ?? asString(raw.ipAddress) ?? asString(raw.name),
    name: asString(raw.name),
    category: asString(raw.category),
    tags: tags
      .map((t) => (typeof t === "string" ? t : asString(asRecord(t)?.name)))
      .filter((t): t is string => t !== null),
    inScope: group.inScope,
  };
}

/**
 * `joined` is the parsed body of recently_joined_users.json — its `total` is
 * the recent joiner count for the engagement, the closest thing the site
 * surface has to a participation/crowding figure. It maps onto
 * `statistics.researchers_participating` with window "recent" — documented
 * provenance: recent joiners, not lifetime participants. A missing/non-
 * numeric total leaves the key absent (unknown, never zero).
 */
function joinedParticipation(
  joined: unknown,
): { value: string; window: string | null } | null {
  const total = asRecord(joined)?.total;
  if (
    typeof total === "number" &&
    Number.isFinite(total) &&
    total >= 0
  ) {
    return { value: String(total), window: "recent" };
  }
  return null;
}

export function mapBriefDocument(
  slug: string,
  doc: unknown,
  stats: unknown,
  joined: unknown = null,
): ApiEngagementData {
  const root = asRecord(doc);
  const data = requireData(doc);
  const brief = asRecord(data.brief) ?? {};
  const engagement = asRecord(data.engagement) ?? {};
  const typeDetail = asRecord(root?.engagementTypeDetail) ?? {};
  const safeHarbor = asRecord(brief.safeHarborStatus) ?? {};

  const targetGroups: ApiTargetGroup[] = [];
  const targets: ApiTarget[] = [];
  for (const rawGroup of data.scope as unknown[]) {
    const g = scopeGroupOf(rawGroup);
    targetGroups.push({
      id: g.id,
      name: g.name,
      inScope: g.inScope,
      description: g.description,
      rewards: g.rewardCents,
    });
    for (const rawTarget of g.targets) {
      targets.push(mapTarget(rawTarget, g));
    }
  }

  return {
    uuid: slug,
    name: asString(brief.name),
    code: asString(engagement.code) ?? slug,
    engagementType: asString(typeDetail.productLabel),
    managedBounty: null,
    lifecycleStatus: asString(root?.statusLabel),
    testingStart: asString(engagement.startsAt),
    testingEnd: asString(engagement.endsAt),
    testingPeriodLabel: null,
    lastStatusTransition: asString(root?.lastTransitionAt),
    lastBriefUpdate: asString(root?.publishedAt),
    safeHarborLevel: asString(safeHarbor.status),
    statistics: (() => {
      const statistics = mapStatistics(stats);
      const joinedStat = joinedParticipation(joined);
      if (joinedStat !== null) {
        statistics.researchers_participating = joinedStat;
      }
      return statistics;
    })(),
    targetGroups,
    targets,
    observedApiVersion: asString(root?.id),
  };
}
