import { apiRequest } from "../api/client";
import { ApiError } from "../api/errors";
import { asObject, asString, indexItemCode } from "../api/engagements";
import type { RadarCatalogItem } from "./types";

const MAX_CATALOG_PAGES = 100;
const CATALOG_PAGE_SIZE = 25;

export interface CatalogScanResult {
  status: "complete" | "partial" | "failed";
  items: RadarCatalogItem[];
  pages_fetched: number;
  warnings: string[];
}

/**
 * Pure parser: maps one raw LIST_ENGAGEMENTS page to catalog rows stamped
 * with `discoveredAt`. `rawCount` is the unfiltered row count — malformed or
 * non-engagement entries are skipped in `items` but still count toward page
 * fullness, same convention as resolveEngagementUuid. `malformed` reports
 * whether the envelope was structurally a page at all — a non-object body,
 * or an object whose `data` is absent or not an array, is NOT a short page
 * (its rawCount of 0 must never be read as "the catalog ended here").
 */
export function parseCatalogPage(
  raw: unknown,
  discoveredAt: string,
): { items: RadarCatalogItem[]; rawCount: number; malformed: boolean } {
  const doc = asObject(raw);
  const data = doc?.data;
  const malformed = doc === null || !Array.isArray(data);
  const rawCount = Array.isArray(data) ? data.length : 0;
  const items: RadarCatalogItem[] = [];
  if (Array.isArray(data)) {
    for (const entry of data) {
      const obj = asObject(entry);
      if (obj === null || obj.type !== "engagement") continue;
      const uuid = asString(obj.id);
      if (uuid === null || uuid === "") continue;
      const attrs = asObject(obj.attributes);
      items.push({
        uuid,
        code: indexItemCode(obj),
        name: asString(attrs?.name),
        lifecycle_status: asString(attrs?.state),
        engagement_type: asString(attrs?.engagement_type),
        discovered_at: discoveredAt,
      });
    }
  }
  return { items, rawCount, malformed };
}

/**
 * Enumerates every engagement visible to the account by paging
 * LIST_ENGAGEMENTS through the shared API client (rate limiting, 429
 * handling, backoff, credential isolation included) — never raw fetch.
 * Stops on the first short page (<25 raw rows → "complete"). MAX_CATALOG_PAGES
 * is a safety limit, not an assumption: a full page 100 yields "partial" with
 * a page_limit_reached warning, never "complete". A 200 page whose envelope
 * is malformed (missing/non-array `data`, or a non-object body) is likewise
 * never "complete": it stops the scan as "failed" when zero pages parsed
 * cleanly, else "partial", with a "malformed_page" warning. An ApiError out
 * of the client yields "failed" with items collected so far and a warning
 * naming the error kind. Dedupe by uuid keeps the first occurrence; ordering
 * is first-seen page order. `pages_fetched` counts cleanly-parsed pages only.
 */
export async function enumerateEngagementCatalog(
  discoveredAt: string = new Date().toISOString(),
): Promise<CatalogScanResult> {
  const items: RadarCatalogItem[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
    let parsed: {
      items: RadarCatalogItem[];
      rawCount: number;
      malformed: boolean;
    };
    try {
      const res = await apiRequest({
        operation: "LIST_ENGAGEMENTS",
        page,
      });
      parsed = parseCatalogPage(res.data, discoveredAt);
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
    for (const item of parsed.items) {
      if (seen.has(item.uuid)) continue;
      seen.add(item.uuid);
      items.push(item);
    }
    if (parsed.rawCount < CATALOG_PAGE_SIZE) {
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
