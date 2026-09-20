import { normalizeText } from "../canonical";
import type {
  ExtractionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  HEADING_SEL,
  dlPairs,
  extractStats,
  findSection,
  findSectionScope,
  sectionHeading,
  slugify,
  textExcluding,
  textOf,
} from "./domUtils";

export interface DetailsData {
  name: string | null;
  code: string | null;
  engagementType: string | null;
  managedBounty: boolean | null;
  lifecycleStatus: string | null;
  testingStart: string | null;
  testingEnd: string | null;
  testingPeriodLabel: string | null;
  lastStatusTransition: string | null;
  lastBriefUpdate: string | null;
  safeHarborLevel: string | null;
  disclosurePolicy: string | null;
  statistics: Record<string, { value: string; window: string | null }>;
}

type ScalarField = Exclude<keyof DetailsData, "statistics" | "managedBounty">;

const FIELD_KEYS: Record<keyof DetailsData, string> = {
  name: "name",
  code: "code",
  engagementType: "engagement-type",
  managedBounty: "managed-bounty",
  lifecycleStatus: "lifecycle-status",
  testingStart: "testing-start",
  testingEnd: "testing-end",
  testingPeriodLabel: "testing-period-label",
  lastStatusTransition: "last-status-transition",
  lastBriefUpdate: "last-brief-update",
  safeHarborLevel: "safe-harbor",
  disclosurePolicy: "disclosure-policy",
  statistics: "statistics",
};

/** Label → DetailsData field. Specific labels are checked before generic ones. */
const DETAIL_FIELD_RES: { field: ScalarField | "managedBounty"; re: RegExp }[] = [
  { field: "code", re: /^(engagement|program|bounty)\s+code$|^code$/i },
  { field: "engagementType", re: /^(engagement|program)\s+type$|^type$/i },
  { field: "managedBounty", re: /^managed|managed\s+by|management/i },
  { field: "lastStatusTransition", re: /last\s+status|status\s+(changed|transition)|transitioned/i },
  { field: "lastBriefUpdate", re: /brief.*(updated|modified)|last.*(updated|modified)|updated\s+at/i },
  { field: "lifecycleStatus", re: /^(lifecycle\s+)?status$|^state$|lifecycle/i },
  { field: "testingPeriodLabel", re: /testing\s+period|testing\s+window|duration|schedule/i },
  { field: "testingStart", re: /^testing\s+(starts?|started|begins?|commences?)(\s+date)?$|^starts?(\s+date)?$/i },
  { field: "testingEnd", re: /^testing\s+(ends?|ended|finishes|concludes?|completes?)(\s+date)?$|^ends?(\s+date)?$/i },
  { field: "safeHarborLevel", re: /safe\s*harbor/i },
];

const STATS_SECTION_RE =
  /statistics|metrics|performance|at a glance|key figures?/i;
/**
 * Text that anchors the brief's header region: the engagement name lives in a
 * header carrying engagement metadata (type pill, status, testing period,
 * scope rating), which distinguishes it from section headings anywhere else.
 */
const HEADER_ANCHOR_RE =
  /bug\s+bounty|bounty|status|testing\s+(?:period|window)|scope\s+rating|managed|engagement|rewards?|researcher|vulnerability/i;
/**
 * Heading texts that label a brief *section*, never the engagement. Anchored
 * full match so "Target Corp" stays a name while "Targets 4 out of 4" does
 * not.
 */
const RESERVED_NAME_RE =
  /^(?:safe\s*harbor|scope|targets?\s+\d+\s+out\s+of\s+\d+|targets|in[- ]?scope.*|out[- ]?(?:of[- ]?)?scope.*|program\s+rules?|testing\s+(?:guidelines?|requirements?|rules?|period|window)|submission\s+(?:guidelines?|requirements?)|report(?:ing)?\s+(?:guidelines?|requirements?|format(?:ting)?)|credentials?|access(?:\s*\/\s*credentials?|\s+requirements?)?|focus\s+areas?|areas?\s+of\s+(?:interest|focus)|non[- ]?focus.*|excluded\s+.*|disclosure.*|terms?\s+(?:and|&)\s+conditions?|terms\s+of\s+(?:service|use)|announcements?|what(?:'|’)s\s+new|recent\s+.*|activity.*|change\s*log|changelog|crowd\s+highlights?|things\s+to\s+know|on\s+this\s+page|hall\s+of\s+fam\w*|leaderboard|known\s+issues?|vulnerability\s+rating.*|\bvrt\b|vulnerability\s+types?|products?\s*(?:&|and)\s*features?|statistics|metrics|details?|overview|eligibility.*|api\s+testing|latest\s+.*|recently\s+.*)$/i;

/** First heading inside `root` that isn't a reserved section label. */
function firstNamedHeading(root: ParentNode): Element | null {
  for (const h of root.querySelectorAll(HEADING_SEL)) {
    const text = textOf(h);
    if (text === "") continue;
    RESERVED_NAME_RE.lastIndex = 0;
    if (RESERVED_NAME_RE.test(text)) continue;
    return h;
  }
  return null;
}
const SAFE_HARBOR_RE = /safe\s*harbor/i;
const DISCLOSURE_RE = /disclosure|coordinated\s+disclosure/i;
// The brief's header statistics list carries no heading of its own; its id is
// stable markup, unlike the generated CSS classes §7.4 forbids.
const STATS_ID_SEL = "[id='brief_stats']";
/**
 * Engagement types Bugcrowd publishes. The document title is "<type>: <name> -
 * Bugcrowd", so the prefix names the type — but only a known type is read as
 * one, so an arbitrary colon in a title cannot invent a value.
 */
const ENGAGEMENT_TYPE_RE =
  /^(?:managed\s+)?(?:bug\s+bounty|vulnerability\s+disclosure(?:\s+program)?|vdp|pen(?:etration)?\s+test(?:ing)?|attack\s+surface\s+management|asm|flex\s+bounty|next\s+gen\s+pen\s+test)$/i;

const LAST_UPDATE_RE =
  /last\s+(?:updated|modified)|brief\s+(?:last\s+)?updated|updated\s+(?:on|at)/i;
/**
 * A Safe Harbor *level* is a graded value ("Full", "Partial", "None"), not the
 * policy prose that follows it. Anything else in a Safe Harbor block is a
 * statement and belongs to the policy collector (§4.3).
 */
const SAFE_HARBOR_LEVEL_RE = /^(?:full|partial|none|limited|standard)\b/i;

/**
 * Header metadata the brief renders as one list item per pair — label first,
 * then the value: "Status In progress 13 Apr 2017". Nothing else in the header
 * is read as a field.
 */
const HEADER_PAIR_RES: { field: ScalarField; re: RegExp }[] = [
  { field: "lifecycleStatus", re: /^status\s+(.+)$/i },
  { field: "testingPeriodLabel", re: /^testing\s+(?:period|window)\s+(.+)$/i },
];
/**
 * Where a header value ends: the item continues with a timestamp or a
 * "Started at …" clause, which is a separate field rather than part of the
 * value.
 */
const HEADER_VALUE_TAIL_RE =
  /\s+(?:(?:start|end|finish|clos)(?:s|ed|ing)?\s+at\b|\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\b|[A-Za-z]{3,}\s+\d{1,2},\s*\d{4}\b|\d{4}-\d{2}-\d{2}\b).*$/i;
const STARTED_AT_RE = /\bstart(?:s|ed|ing)?\s+at\s+(.+)$/i;

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

function parseManaged(text: string): boolean | null {
  if (/^(yes|true|managed)/i.test(text)) return true;
  if (/^(no|false|self)/i.test(text)) return false;
  return null;
}

/** dt label text → owning section's heading text for the locator. */
function locatorFor(el: Element): SourceLocator {
  const section = el.closest("section,article,[role='region'],[role='section']");
  const heading = section !== null ? sectionHeading(section) : null;
  return heading === null ? {} : { section: heading };
}

/**
 * Collects engagement metadata from the Details page (spec §4.1, §6.2):
 * header stats (page_header level), lifecycle/dl fields, safe harbor and
 * disclosure policy text (explicit_program_rule). Every field is extracted or
 * explicit null; absent fields produce no record.
 */
export function collectDetails(
  doc: Document,
  pageUrl: string,
): { records: SourceRecord[]; data: DetailsData } {
  const records: SourceRecord[] = [];
  const data: DetailsData = {
    name: null,
    code: null,
    engagementType: null,
    managedBounty: null,
    lifecycleStatus: null,
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: null,
    lastBriefUpdate: null,
    safeHarborLevel: null,
    disclosurePolicy: null,
    statistics: {},
  };

  const emit = (
    field: ScalarField | "managedBounty",
    level: SourceLevel,
    quote: string,
    value: unknown,
    locator: SourceLocator,
    status: ExtractionStatus = "exact",
  ) => {
    records.push(
      record(
        `dom:details:${FIELD_KEYS[field]}`,
        level,
        pageUrl,
        locator,
        quote,
        value,
        status,
      ),
    );
  };

  // Name: the engagement's own heading. It lives in the brief's header
  // region — the block anchored by engagement metadata (type pill, status,
  // testing period, scope rating) — and is not always an h1. A heading
  // inside the brief body names a section ("Safe Harbor"), never the
  // engagement; the browser title is the last resort because it carries
  // site chrome.
  const pageHeader = doc.querySelector("main header,[role='main'] header");
  const anchoredHeader =
    pageHeader !== null && HEADER_ANCHOR_RE.test(textOf(pageHeader))
      ? pageHeader
      : null;
  let titleHeading =
    anchoredHeader !== null ? firstNamedHeading(anchoredHeader) : null;
  if (titleHeading === null) {
    for (const h of doc.querySelectorAll(
      "main h1,[role='main'] h1,[role='heading'][aria-level='1'],h1",
    )) {
      const text = textOf(h);
      RESERVED_NAME_RE.lastIndex = 0;
      if (text === "" || RESERVED_NAME_RE.test(text)) continue;
      titleHeading = h;
      break;
    }
  }
  const headingText = textOf(titleHeading);
  if (headingText !== "") {
    data.name = headingText;
    emit(
      "name",
      "page_header",
      headingText,
      headingText,
      locatorFor(titleHeading!),
    );
  } else if (doc.title.trim() !== "") {
    const name = normalizeText(
      doc.title
        .replace(/\s*[-–—|]\s*bugcrowd\s*$/i, "")
        .replace(
          /^(?:bug\s*bounty|bounty|program|engagement|vulnerability\s+disclosure(?:\s+program)?|vdp)\s*[:：]\s*/i,
          "",
        ),
    );
    data.name = name;
    emit("name", "page_header", doc.title, name, {}, "partial");
  }

  // Labeled definition pairs carry lifecycle, code, type, managed, dates.
  for (const { label, dd } of dlPairs(doc)) {
    const def = DETAIL_FIELD_RES.find((f) => {
      f.re.lastIndex = 0;
      return f.re.test(label);
    });
    if (def === undefined) continue;
    const value = textOf(dd);
    if (value === "") continue;
    if (def.field === "managedBounty") {
      const parsed = parseManaged(value);
      if (parsed === null || data.managedBounty !== null) continue;
      data.managedBounty = parsed;
      emit("managedBounty", "page_header", value, parsed, locatorFor(dd));
      continue;
    }
    if (def.field === "safeHarborLevel") {
      if (data.safeHarborLevel === null) {
        data.safeHarborLevel = value;
        emit(
          "safeHarborLevel",
          "explicit_program_rule",
          value,
          value,
          locatorFor(dd),
        );
      }
      continue;
    }
    if (data[def.field] !== null) continue;
    data[def.field] = value;
    emit(def.field, "page_header", value, value, locatorFor(dd));
  }

  // Header region: the type pill, then label-prefixed metadata items.
  const headerRegion = titleHeading?.closest("header") ?? pageHeader ?? null;
  if (headerRegion !== null) {
    const headerLocator: SourceLocator =
      data.name === null ? {} : { section: data.name };
    // The document title repeats the engagement type ("<type>: <name> - …");
    // a header item is read as the type only when the two agree.
    const titleType = normalizeText(doc.title.split(":")[0] ?? "");
    if (
      data.engagementType === null &&
      titleType !== "" &&
      titleType !== data.name
    ) {
      for (const li of headerRegion.querySelectorAll("li")) {
        const text = textOf(li);
        if (text.toLowerCase() !== titleType.toLowerCase()) continue;
        data.engagementType = text;
        emit("engagementType", "page_header", text, text, headerLocator);
        break;
      }
    }
    for (const li of headerRegion.querySelectorAll("li")) {
      const text = textOf(li);
      for (const pair of HEADER_PAIR_RES) {
        pair.re.lastIndex = 0;
        const m = pair.re.exec(text);
        if (m === null) continue;
        const rest = m[1] ?? "";
        const value = normalizeText(rest.replace(HEADER_VALUE_TAIL_RE, ""));
        if (value === "") continue;
        if (data[pair.field] === null) {
          data[pair.field] = value;
          emit(pair.field, "page_header", text, value, headerLocator);
        }
        // What follows the value is a date of its own: the day testing
        // started, or the moment the status last changed.
        const tail = normalizeText(rest.slice(value.length));
        const started = STARTED_AT_RE.exec(tail);
        if (started !== null) {
          const start = normalizeText(started[1] ?? "");
          if (start !== "" && data.testingStart === null) {
            data.testingStart = start;
            emit("testingStart", "page_header", text, start, headerLocator);
          }
        } else if (
          tail !== "" &&
          pair.field === "lifecycleStatus" &&
          data.lastStatusTransition === null
        ) {
          data.lastStatusTransition = tail;
          emit("lastStatusTransition", "page_header", text, tail, headerLocator);
        }
        break;
      }
    }
  }

  // A brief with no header block still names its type in the document title;
  // the vocabulary check keeps that from turning any prefix into a type.
  if (data.engagementType === null) {
    const titleType = normalizeText(doc.title.split(":")[0] ?? "");
    ENGAGEMENT_TYPE_RE.lastIndex = 0;
    if (titleType !== "" && ENGAGEMENT_TYPE_RE.test(titleType)) {
      data.engagementType = titleType;
      emit("engagementType", "page_header", doc.title, titleType, {}, "partial");
    }
  }

  // "Last Updated: <time datetime=…>" sits outside any labeled list.
  if (data.lastBriefUpdate === null) {
    for (const time of doc.querySelectorAll("time[datetime]")) {
      const holder = time.parentElement;
      if (holder === null) continue;
      LAST_UPDATE_RE.lastIndex = 0;
      if (!LAST_UPDATE_RE.test(textExcluding(holder, "time"))) continue;
      const stamp = (time.getAttribute("datetime") ?? "").trim();
      if (stamp === "") continue;
      data.lastBriefUpdate = stamp;
      emit(
        "lastBriefUpdate",
        "page_header",
        textOf(holder),
        stamp,
        locatorFor(holder),
      );
      break;
    }
  }

  // Safe Harbor level may live in its own section rather than the dl — but the
  // block is mostly policy prose, so only a graded level is read as one.
  if (data.safeHarborLevel === null) {
    const scope = findSectionScope(doc, SAFE_HARBOR_RE);
    const first = scope?.items[0];
    if (first !== undefined && SAFE_HARBOR_LEVEL_RE.test(first.text)) {
      data.safeHarborLevel = first.text;
      emit(
        "safeHarborLevel",
        "explicit_program_rule",
        first.text,
        first.text,
        { section: scope?.heading ?? undefined },
      );
    }
  }

  // Coordinated disclosure / collaboration policy text.
  const disclosure = findSectionScope(doc, DISCLOSURE_RE);
  if (disclosure !== null) {
    const text = disclosure.items.map((i) => i.text).join("\n");
    if (text !== "") {
      data.disclosurePolicy = text;
      emit(
        "disclosurePolicy",
        "explicit_program_rule",
        text,
        text,
        { section: disclosure.heading ?? undefined },
      );
    }
  }

  // Header statistics with their attached time windows.
  const statsSection =
    findSection(doc, STATS_SECTION_RE) ?? doc.querySelector(STATS_ID_SEL);
  if (statsSection !== null) {
    const locator: SourceLocator = {
      section: sectionHeading(statsSection) ?? data.name ?? undefined,
    };
    for (const stat of extractStats(statsSection)) {
      const slug = slugify(stat.label);
      data.statistics[slug] = { value: stat.value, window: stat.window };
      const quote = `${stat.label} ${stat.value}${
        stat.window !== null ? ` ${stat.window}` : ""
      }`;
      records.push(
        record(
          `dom:details:statistics:${slug}`,
          "page_header",
          pageUrl,
          { ...locator, subsection: stat.label },
          quote,
          { value: stat.value, window: stat.window, label: stat.label },
        ),
      );
    }
  }

  return { records, data };
}
