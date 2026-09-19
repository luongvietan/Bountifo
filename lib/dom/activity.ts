import type {
  ExtractionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  HEADING_SEL,
  SECTION_SEL,
  extractStats,
  findSection,
  resolveUrl,
  sectionHeading,
  sectionItems,
  slugify,
  textOf,
  uniqueSlug,
} from "./domUtils";

export interface ActivityItem {
  kind: "announcement" | "changelog" | "activity" | "accepted_report";
  title: string | null;
  body: string;
  timestamp: string | null;
  sourceUrl: string | null;
}

export interface ParticipationStats {
  [key: string]: { value: string; window: string | null };
}

const MAX_PAGES = 10;
const NEXT_LINK_TEXT_RE = /^(next|next page|older|show more|load more|see more|more)$/i;
const NEXT_LINK_LABEL_RE = /next|older|more pages|load more|show more/i;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ][\d:.-]+Z?)?/;

const BUCKETS: {
  kind: ActivityItem["kind"];
  key: string;
  re: RegExp;
  paginate: boolean;
  level: SourceLevel;
}[] = [
  { kind: "announcement", key: "announcements", re: /announcements?/i, paginate: true, level: "announcement" },
  { kind: "changelog", key: "changelog", re: /change\s*log|changelog|what(?:'|’)s new|recent changes/i, paginate: true, level: "announcement" },
  { kind: "activity", key: "recent-activity", re: /recent activity|activity feed|engagement activity/i, paginate: false, level: "page_header" },
  { kind: "accepted_report", key: "accepted-reports", re: /accepted reports?|accepted submissions?|resolved reports?|recently accepted/i, paginate: false, level: "page_header" },
];

const STATS_SECTION_RE = /participation|response|statistics|performance|metrics/i;

function record(
  sourceKey: string,
  sourceLevel: SourceLevel,
  sourceUrl: string,
  locator: SourceLocator,
  quote: string,
  data: unknown,
  extractionStatus: ExtractionStatus = "exact",
): SourceRecord {
  return {
    sourceKey,
    sourceType: "dom",
    sourceLevel,
    sourceUrl,
    authenticated: true,
    locator,
    quote,
    extractionStatus,
    data,
  };
}

/** Item elements of a feed section: articles, else list items, else rows. */
function itemElements(section: Element): Element[] {
  // Ownership starts at the parent — an article/tr itself matches SECTION_SEL.
  const owned = (el: Element) =>
    (el.parentElement?.closest(SECTION_SEL) ?? null) === section;
  const articles = [...section.querySelectorAll("article")].filter(owned);
  if (articles.length > 0) return articles;
  const lis = [...section.querySelectorAll("li")].filter(
    (li) => owned(li) && li.querySelector("li") === null,
  );
  if (lis.length > 0) return lis;
  const trs = [...section.querySelectorAll("tbody tr")].filter(owned);
  if (trs.length > 0) return trs;
  return sectionItems(section).map((i) => i.el);
}

function itemTimestamp(el: Element): string | null {
  const time = el.querySelector("time");
  if (time !== null) {
    const dt = time.getAttribute("datetime");
    if (dt !== null && dt.trim() !== "") return dt.trim();
    const text = textOf(time);
    if (text !== "") return text;
  }
  for (const d of el.querySelectorAll("[datetime]")) {
    const dt = d.getAttribute("datetime");
    if (dt !== null && dt.trim() !== "") return dt.trim();
  }
  const m = ISO_DATE_RE.exec(textOf(el));
  return m === null ? null : m[0];
}

function toItem(
  el: Element,
  kind: ActivityItem["kind"],
  pageUrl: string,
): ActivityItem {
  const heading = el.querySelector(HEADING_SEL);
  const headingText = textOf(heading);
  const link = el.querySelector("a[href]");
  const linkText = textOf(link);
  const title = headingText !== "" ? headingText : linkText || null;
  return {
    kind,
    title,
    body: textOf(el),
    timestamp: itemTimestamp(el),
    sourceUrl:
      (link !== null ? resolveUrl(link.getAttribute("href"), pageUrl) : null) ??
      pageUrl,
  };
}

/** First pagination control inside a section (rel=next or next-ish label). */
function nextPageUrl(section: Element, base: string): string | null {
  const anchors = [...section.querySelectorAll("a[href]")];
  const isNext = (a: Element): boolean => {
    const rel = (a.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("next")) return true;
    const label = a.getAttribute("aria-label") ?? "";
    if (NEXT_LINK_LABEL_RE.test(label)) return true;
    return NEXT_LINK_TEXT_RE.test(textOf(a));
  };
  for (const a of anchors) {
    if (!isNext(a)) continue;
    const url = resolveUrl(a.getAttribute("href"), base);
    if (url !== null && url !== base) return url;
  }
  return null;
}

async function safeFetch(
  fetchPage: (url: string) => Promise<Document | null>,
  url: string,
): Promise<Document | null> {
  try {
    return await fetchPage(url);
  } catch {
    return null;
  }
}

interface BucketResult {
  items: ActivityItem[];
  /** Item → page URL it was collected from (for record sourceUrls). */
  pageUrls: string[];
  sectionName: string | null;
  pageDepths: number[];
}

/**
 * Collects one feed bucket; for announcements/changelog, follows the next-page
 * link inside the section via fetchPage until absent, a null/failed fetch, a
 * page cap, or a repeated item signature (spec §6.2, §15 step 6).
 */
async function collectBucket(
  bucket: (typeof BUCKETS)[number],
  startDoc: Document,
  startUrl: string,
  fetchPage: (url: string) => Promise<Document | null>,
): Promise<BucketResult> {
  const items: ActivityItem[] = [];
  const pageUrls: string[] = [];
  const pageDepths: number[] = [];
  const seenSigs = new Set<string>();
  const seenPages = new Set<string>([startUrl]);
  let sectionName: string | null = null;
  let doc = startDoc;
  let url = startUrl;

  for (let depth = 0; depth < MAX_PAGES; depth++) {
    const section = findSection(doc, bucket.re);
    if (section === null) break;
    sectionName = sectionName ?? sectionHeading(section);
    for (const el of itemElements(section)) {
      const item = toItem(el, bucket.kind, url);
      if (item.body === "") continue;
      const sig = `${item.kind}|${item.title}|${item.timestamp}|${item.body}`;
      if (seenSigs.has(sig)) continue;
      seenSigs.add(sig);
      items.push(item);
      pageUrls.push(url);
      pageDepths.push(depth);
    }
    if (!bucket.paginate) break;
    const next = nextPageUrl(section, url);
    if (next === null || seenPages.has(next)) break;
    seenPages.add(next);
    const nextDoc = await safeFetch(fetchPage, next);
    if (nextDoc === null) break;
    doc = nextDoc;
    url = next;
  }
  return { items, pageUrls, sectionName, pageDepths };
}

/**
 * Changes and activity (spec §4.5): announcements + changelog (pagination
 * exhausted through the caller-provided authenticated fetchPage), recent
 * activity, accepted reports, and participation/response statistics.
 * Records live under `dom:activity:<bucket>:<item-slug>`; paginated items
 * carry the page URL they were fetched from.
 */
export async function collectActivity(
  doc: Document,
  pageUrl: string,
  fetchPage: (url: string) => Promise<Document | null>,
): Promise<{
  records: SourceRecord[];
  announcements: ActivityItem[];
  changelog: ActivityItem[];
  recentActivity: ActivityItem[];
  acceptedReports: ActivityItem[];
  stats: ParticipationStats;
}> {
  const records: SourceRecord[] = [];
  const taken = new Set<string>();
  const result = {
    announcements: [] as ActivityItem[],
    changelog: [] as ActivityItem[],
    recentActivity: [] as ActivityItem[],
    acceptedReports: [] as ActivityItem[],
    stats: {} as ParticipationStats,
  };

  for (const bucket of BUCKETS) {
    const bucketRes = await collectBucket(bucket, doc, pageUrl, fetchPage);
    const sink =
      bucket.kind === "announcement"
        ? result.announcements
        : bucket.kind === "changelog"
          ? result.changelog
          : bucket.kind === "activity"
            ? result.recentActivity
            : result.acceptedReports;
    sink.push(...bucketRes.items);
    bucketRes.items.forEach((item, i) => {
      const slug = slugify(item.title ?? item.timestamp ?? `item-${i + 1}`);
      const url = bucketRes.pageUrls[i] ?? pageUrl;
      const locator: SourceLocator = {
        section: bucketRes.sectionName ?? bucket.key,
        pageIndex: bucketRes.pageDepths[i] ?? 0,
      };
      records.push(
        record(
          `dom:activity:${bucket.key}:${uniqueSlug(slug, taken)}`,
          bucket.level,
          url,
          locator,
          item.body,
          item,
        ),
      );
    });
  }

  const statsSection = findSection(doc, STATS_SECTION_RE);
  if (statsSection !== null) {
    const sectionName = sectionHeading(statsSection) ?? "statistics";
    for (const stat of extractStats(statsSection)) {
      const slug = slugify(stat.label);
      result.stats[slug] = { value: stat.value, window: stat.window };
      const quote = `${stat.label} ${stat.value}${
        stat.window !== null ? ` ${stat.window}` : ""
      }`;
      records.push(
        record(
          `dom:activity:participation:${uniqueSlug(slug, taken)}`,
          "page_header",
          pageUrl,
          { section: sectionName, subsection: stat.label },
          quote,
          { label: stat.label, value: stat.value, window: stat.window },
        ),
      );
    }
  }

  return { records, ...result };
}
