import { siteRequest } from "../api/siteClient";
import { ApiError } from "../api/errors";
import { asObject, asString } from "../api/engagements";
import { parseEngagementUrl } from "../ids";
import { BUGCROWD_SITE } from "../constants";
import type { RadarCatalogItem } from "./types";

const MAX_CATALOG_PAGES = 100;
const DEFAULT_PAGE_LIMIT = 24;

export interface CatalogScanResult {
  status: "complete" | "partial" | "failed";
  items: RadarCatalogItem[];
  pages_fetched: number;
  warnings: string[];
}

/**
 * Pure parser: maps one raw `engagements.json` page to catalog rows stamped
 * with `discoveredAt`. Identity is the brief-URL slug — the engagement's
 * canonical id on the researcher surface (the RadarCatalogItem `uuid` field
 * carries it; there is no org-API uuid on this endpoint).
 *
 * `rawCount` is the unfiltered row count — entries without a parseable slug
 * are skipped in `items` but still count toward page fullness, same
 * convention as the previous API-backed version. `malformed` reports whether
 * the envelope was structurally a page at all — a non-object body, or an
 * object whose `engagements` is absent or not an array, is NOT a short page
 * (its rawCount of 0 must never be read as "the catalog ended here").
 */
export function parseCatalogPage(
  raw: unknown,
  discoveredAt: string,
): { items: RadarCatalogItem[]; rawCount: number; malformed: boolean } {
  const doc = asObject(raw);
  const list = doc?.engagements;
  const malformed = doc === null || !Array.isArray(list);
  const rawCount = Array.isArray(list) ? list.length : 0;
  const items: RadarCatalogItem[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const obj = asObject(entry);
      if (obj === null) continue;
      const briefUrl = asString(obj.briefUrl);
      if (briefUrl === null) continue;
      const slug = parseEngagementUrl(
        briefUrl.startsWith("/") ? `${BUGCROWD_SITE}${briefUrl}` : briefUrl,
      )?.code;
      if (slug === undefined) continue;
      items.push({
        uuid: slug,
        code: slug,
        name: asString(obj.name),
        lifecycle_status: asString(obj.accessStatus),
        engagement_type:
          asString(asObject(obj.productEngagementType)?.label),
        discovered_at: discoveredAt,
      });
    }
  }
  return { items, rawCount, malformed };
}

function pageLimitOf(raw: unknown): number {
  const meta = asObject(asObject(raw)?.paginationMeta);
  const limit = meta?.limit;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_PAGE_LIMIT;
}

function totalCountOf(raw: unknown): number | null {
  const meta = asObject(asObject(raw)?.paginationMeta);
  const total = meta?.totalCount;
  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : null;
}

/**
 * Enumerates every engagement visible to the account's session by paging
 * `GET /engagements.json` through the site client (rate limiting, 429
 * handling, backoff, session cookies included) — never raw fetch.
 *
 * Completion: a page whose raw row count is below the advertised
 * paginationMeta.limit is the last page, and reaching paginationMeta's
 * totalCount likewise ends the scan — both yield "complete". An empty first
 * page is a legitimately empty catalog, not an error.
 *
 * MAX_CATALOG_PAGES is a safety limit, not an assumption: hitting it yields
 * "partial" with a page_limit_reached warning, never "complete". A 200 page
 * whose envelope is malformed (missing/non-array `engagements`, or a
 * non-object body) is likewise never "complete": it stops the scan as
 * "failed" when zero pages parsed cleanly, else "partial", with a
 * "malformed_page" warning. An ApiError out of the client yields "failed"
 * with items collected so far and a warning naming the error kind. Dedupe
 * by slug keeps the first occurrence; ordering is first-seen page order.
 * `pages_fetched` counts cleanly-parsed pages only.
 */
export async function enumerateEngagementCatalog(
  discoveredAt: string = new Date().toISOString(),
): Promise<CatalogScanResult> {
  const items: RadarCatalogItem[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let pagesFetched = 0;
  let rawSeen = 0;

  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    let parsed: {
      items: RadarCatalogItem[];
      rawCount: number;
      malformed: boolean;
    };
    let pageLimit = DEFAULT_PAGE_LIMIT;
    let totalCount: number | null = null;
    try {
      const res = await siteRequest({ operation: "LIST_INDEX", page });
      parsed = parseCatalogPage(res.data, discoveredAt);
      pageLimit = pageLimitOf(res.data);
      totalCount = totalCountOf(res.data);
    } catch (err) {
      // The warning names the ApiError kind verbatim ("rate_limited",
      // "forbidden", ...); a non-ApiError is an unexpected bug → "unknown".
      warnings.push(err instanceof ApiError ? err.kind : "unknown");
      return {
        status: "failed",
        items,
        pages_fetched: pagesFetched,
        warnings,
      };
    }
    if (parsed.malformed) {
      warnings.push("malformed_page");
      return {
        status: pagesFetched === 0 ? "failed" : "partial",
        items,
        pages_fetched: pagesFetched,
        warnings,
      };
    }
    pagesFetched = page;
    rawSeen += parsed.rawCount;
    for (const item of parsed.items) {
      if (seen.has(item.uuid)) continue;
      seen.add(item.uuid);
      items.push(item);
    }
    if (
      parsed.rawCount < pageLimit ||
      (totalCount !== null && rawSeen >= totalCount)
    ) {
      return {
        status: "complete",
        items,
        pages_fetched: pagesFetched,
        warnings,
      };
    }
  }

  warnings.push("page_limit_reached");
  return {
    status: "partial",
    items,
    pages_fetched: pagesFetched,
    warnings,
  };
}
