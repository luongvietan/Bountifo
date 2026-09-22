import { API_BASE } from "../constants";
import { parseEngagementUrl } from "../ids";
import type {
  ApiEngagementData,
  ApiTarget,
  ApiTargetGroup,
  SourceRecord,
} from "../types";
import { apiRequest } from "./client";
import { ApiError } from "./errors";

type JsonObject = Record<string, unknown>;

const MAX_INDEX_PAGES = 20;
const INDEX_PAGE_SIZE = 25;

/** Shared with lib/radar/catalog.ts — same row-level guards for index pages. */
export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Engagements index
// ---------------------------------------------------------------------------

/**
 * Extracts `{uuid, code}` from each engagement resource in a LIST_ENGAGEMENTS
 * page. `code` comes from `attributes.code` when present, else from the
 * engagement URL slug (`attributes.url` / `bugcrowd_url` / `engagement_url` /
 * `links.self`) — null when neither exists. Non-engagement entries are
 * skipped; malformed documents yield [].
 */
export function parseEngagementsIndex(
  json: unknown,
): { uuid: string; code: string | null }[] {
  const data = asObject(json)?.data;
  if (!Array.isArray(data)) return [];
  const out: { uuid: string; code: string | null }[] = [];
  for (const item of data) {
    const obj = asObject(item);
    if (obj === null || obj.type !== "engagement") continue;
    const uuid = asString(obj.id);
    if (uuid === null) continue;
    out.push({ uuid, code: indexItemCode(obj) });
  }
  return out;
}

/**
 * `code` for one LIST_ENGAGEMENTS row: `attributes.code` when present, else
 * the slug of the first parseable engagement URL (attributes.url /
 * bugcrowd_url / engagement_url / links.self). Shared with the radar catalog.
 */
export function indexItemCode(item: JsonObject): string | null {
  const attrs = asObject(item.attributes);
  const direct = asString(attrs?.code);
  if (direct !== null) return direct;
  const urlCandidates = [
    attrs?.url,
    attrs?.bugcrowd_url,
    attrs?.engagement_url,
    asObject(item.links)?.self,
  ];
  for (const candidate of urlCandidates) {
    const raw = asString(candidate);
    if (raw === null) continue;
    const parsed = parseEngagementUrl(raw);
    if (parsed !== null) return parsed.code;
  }
  return null;
}

/**
 * Resolves the engagement UUID for a page code (spec §6.1). A page-derived
 * UUID wins when present. Otherwise pages LIST_ENGAGEMENTS (≤20 pages, 25 per
 * page; stops on a short page) matching `code` from attributes or canonical
 * URL slug. No match → null (non-critical per §18). ApiErrors propagate —
 * auth/rate failures are real failures, not "no match".
 */
export async function resolveEngagementUuid(
  code: string,
  pageUuid?: string | null,
): Promise<string | null> {
  if (typeof pageUuid === "string" && pageUuid !== "") return pageUuid;
  for (let page = 1; page <= MAX_INDEX_PAGES; page++) {
    const res = await apiRequest<unknown>({
      operation: "LIST_ENGAGEMENTS",
      page,
    });
    const entries = parseEngagementsIndex(res.data);
    const match = entries.find((entry) => entry.code === code);
    if (match !== undefined) return match.uuid;
    // Page fullness is measured on the raw page, not the filtered entries —
    // skipped non-engagement items must not look like a short last page.
    const rawData = asObject(res.data)?.data;
    const rawCount = Array.isArray(rawData) ? rawData.length : 0;
    if (rawCount < INDEX_PAGE_SIZE) return null; // short page → last page
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engagement detail document → ApiEngagementData
// ---------------------------------------------------------------------------

interface EngagementParts {
  dataObj: JsonObject;
  attrs: JsonObject;
  rawGroups: JsonObject[];
  rawTargets: JsonObject[];
}

/**
 * Validates the JSON:API document shape and returns the engagement resource,
 * its attributes, and the included target_group / target objects ordered by
 * the engagement's relationship arrays (falling back to `included` order when
 * relationships are absent). Throws ApiError("invalid_response") on anything
 * that is not an engagement document.
 */
function extractEngagementParts(raw: unknown): EngagementParts {
  const doc = asObject(raw);
  const dataObj = asObject(doc?.data);
  if (dataObj === null || dataObj.type !== "engagement") {
    throw new ApiError("invalid_response", "malformed engagement document");
  }
  const attrs = asObject(dataObj.attributes) ?? {};
  const includedRaw = doc?.included;
  const included = Array.isArray(includedRaw) ? includedRaw : [];

  const byTypeAndId = new Map<string, JsonObject>();
  for (const entry of included) {
    const obj = asObject(entry);
    const type = asString(obj?.type);
    const id = asString(obj?.id);
    if (obj !== null && type !== null && id !== null) {
      byTypeAndId.set(`${type}:${id}`, obj);
    }
  }

  const relIds = (name: string): string[] => {
    const rel = asObject(asObject(dataObj.relationships)?.[name]);
    const data = rel?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((ref) => asString(asObject(ref)?.id))
      .filter((id): id is string => id !== null);
  };

  const orderedIncluded = (type: string, relName: string): JsonObject[] => {
    const ids = relIds(relName);
    if (ids.length > 0) {
      return ids
        .map((id) => byTypeAndId.get(`${type}:${id}`))
        .filter((obj): obj is JsonObject => obj !== undefined);
    }
    return [...byTypeAndId.values()].filter((obj) => obj.type === type);
  };

  return {
    dataObj,
    attrs,
    rawGroups: orderedIncluded("target_group", "target_groups"),
    rawTargets: orderedIncluded("target", "targets"),
  };
}

function parseTargetGroup(obj: JsonObject): ApiTargetGroup {
  const attrs = asObject(obj.attributes) ?? {};
  const rewards = asObject(attrs.rewards) ?? {};
  return {
    id: asString(obj.id) ?? "",
    name: asString(attrs.name) ?? "",
    inScope: attrs.in_scope !== false, // absent → in scope; explicit false only
    description: asString(attrs.description),
    rewards: {
      p1: asNumber(rewards.p1),
      p2: asNumber(rewards.p2),
      p3: asNumber(rewards.p3),
      p4: asNumber(rewards.p4),
      p5: asNumber(rewards.p5),
    },
  };
}

function parseTarget(obj: JsonObject): ApiTarget {
  const attrs = asObject(obj.attributes) ?? {};
  const groupRef = asObject(
    asObject(asObject(obj.relationships)?.target_group)?.data,
  );
  return {
    id: asString(obj.id) ?? "",
    groupId: asString(groupRef?.id),
    location: asString(attrs.uri),
    name: asString(attrs.name),
    category: asString(attrs.category),
    tags: Array.isArray(attrs.tags)
      ? attrs.tags.filter((t): t is string => typeof t === "string")
      : [],
    inScope: attrs.in_scope !== false,
  };
}

function parseStatistics(
  raw: unknown,
): Record<string, { value: string; window: string | null }> {
  const stats: Record<string, { value: string; window: string | null }> = {};
  const obj = asObject(raw);
  if (obj === null) return stats;
  for (const [key, entry] of Object.entries(obj)) {
    const stat = asObject(entry);
    if (stat === null || stat.value === undefined || stat.value === null) {
      continue;
    }
    stats[key] = {
      value:
        typeof stat.value === "string" ? stat.value : String(stat.value),
      window: asString(stat.window),
    };
  }
  return stats;
}

/**
 * Maps a sanitized JSON:API engagement document (data + included) to
 * ApiEngagementData (lib/types.ts). Missing attributes → null; absent
 * p4/p5 rewards → null. `observedApiVersion` is threaded in from the
 * response's observed-version signal (headers); null when absent — never
 * inferred (spec §6.1).
 */
export function parseEngagement(
  json: unknown,
  observedApiVersion: string | null = null,
): ApiEngagementData {
  const { dataObj, attrs, rawGroups, rawTargets } =
    extractEngagementParts(json);
  return {
    uuid: asString(dataObj.id),
    name: asString(attrs.name),
    code: asString(attrs.code),
    engagementType: asString(attrs.engagement_type),
    managedBounty: typeof attrs.managed === "boolean" ? attrs.managed : null,
    lifecycleStatus: asString(attrs.state),
    testingStart: asString(attrs.starts_at),
    testingEnd: asString(attrs.ends_at),
    testingPeriodLabel: asString(attrs.testing_period),
    lastStatusTransition: asString(attrs.last_transition_at),
    lastBriefUpdate: asString(attrs.updated_at),
    safeHarborLevel: asString(attrs.safe_harbor_status),
    statistics: parseStatistics(attrs.statistics),
    targetGroups: rawGroups.map(parseTargetGroup),
    targets: rawTargets.map(parseTarget),
    // V1.4 brief facts have no org-API source — honestly null.
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion,
  };
}

// ---------------------------------------------------------------------------
// Enrichment: resolve → GET → parse → SourceRecords
// ---------------------------------------------------------------------------

/**
 * Emits one SourceRecord per logical field group (spec §9/§6.3):
 * sourceType "api", sourceLevel "api_field", sourceKey
 * `api:engagement:<group>`, quote = exact JSON value text of the raw API
 * field(s), authenticated true, data = parsed group value.
 */
function buildSourceRecords(
  raw: unknown,
  data: ApiEngagementData,
  sourceUrl: string,
): SourceRecord[] {
  const { dataObj, attrs, rawGroups, rawTargets } =
    extractEngagementParts(raw);
  const record = (
    field: string,
    rawValue: unknown,
    parsedValue: unknown,
  ): SourceRecord => ({
    sourceKey: `api:engagement:${field}`,
    sourceType: "api",
    sourceLevel: "api_field",
    sourceUrl,
    authenticated: true,
    locator: {},
    quote: JSON.stringify(rawValue === undefined ? null : rawValue),
    extractionStatus: "exact",
    data: parsedValue,
  });

  return [
    record(
      "identity",
      {
        id: dataObj.id ?? null,
        name: attrs.name ?? null,
        code: attrs.code ?? null,
      },
      { uuid: data.uuid, name: data.name, code: data.code },
    ),
    record(
      "classification",
      {
        engagement_type: attrs.engagement_type ?? null,
        managed: attrs.managed ?? null,
      },
      { engagementType: data.engagementType, managedBounty: data.managedBounty },
    ),
    record(
      "lifecycle",
      {
        state: attrs.state ?? null,
        starts_at: attrs.starts_at ?? null,
        ends_at: attrs.ends_at ?? null,
        testing_period: attrs.testing_period ?? null,
        last_transition_at: attrs.last_transition_at ?? null,
        updated_at: attrs.updated_at ?? null,
      },
      {
        lifecycleStatus: data.lifecycleStatus,
        testingStart: data.testingStart,
        testingEnd: data.testingEnd,
        testingPeriodLabel: data.testingPeriodLabel,
        lastStatusTransition: data.lastStatusTransition,
        lastBriefUpdate: data.lastBriefUpdate,
      },
    ),
    record("safe_harbor", attrs.safe_harbor_status ?? null, data.safeHarborLevel),
    record("statistics", attrs.statistics ?? null, data.statistics),
    record("target_groups", rawGroups, data.targetGroups),
    record("targets", rawTargets, data.targets),
    record("observed_version", data.observedApiVersion, data.observedApiVersion),
  ];
}

/**
 * Full enrichment path (spec §6.1/§6.3): resolve the engagement UUID
 * (pageUuid wins, else index paging), GET the engagement with
 * target_groups/targets includes, parse to ApiEngagementData, and emit
 * api_field SourceRecords. Returns both the structured data and the records;
 * failures surface as {ok:false,error:ApiError} — never raw exceptions, never
 * credential material.
 */
export async function fetchEngagementEnrichment(
  code: string,
  pageUuid?: string | null,
): Promise<
  | { ok: true; data: ApiEngagementData; records: SourceRecord[] }
  | { ok: false; error: ApiError }
> {
  try {
    const uuid = await resolveEngagementUuid(code, pageUuid);
    if (uuid === null) {
      return {
        ok: false,
        error: new ApiError("not_found", "engagement not found by code"),
      };
    }
    const res = await apiRequest<unknown>({
      operation: "GET_ENGAGEMENT",
      uuid,
    });
    const data = parseEngagement(res.data, res.observedVersion);
    const records = buildSourceRecords(
      res.data,
      data,
      `${API_BASE}/engagements/${uuid}`,
    );
    return { ok: true, data, records };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err };
    // Unknown failure: static message only — a thrown value could carry
    // request detail (§18/§19).
    return {
      ok: false,
      error: new ApiError("invalid_response", "unexpected enrichment failure"),
    };
  }
}

/**
 * Token probe for the options page: GET one index record with the candidate
 * token. `detail` is a short static string — never echoes the token, headers,
 * or response body.
 */
export async function testToken(
  tokenOverride?: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await apiRequest({ operation: "TEST_TOKEN", tokenOverride });
    return { ok: true, detail: "token valid" };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.kind === "unauthorized" || err.kind === "forbidden") {
        return { ok: false, detail: "unauthorized" };
      }
      if (err.kind === "rate_limited") {
        return { ok: false, detail: "rate limited, try later" };
      }
    }
    return { ok: false, detail: "unreachable" };
  }
}
