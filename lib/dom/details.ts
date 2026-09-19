import { normalizeText } from "../canonical";
import type {
  ExtractionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  dlPairs,
  extractStats,
  findSection,
  sectionHeading,
  sectionItems,
  slugify,
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
const SAFE_HARBOR_RE = /safe\s*harbor/i;
const DISCLOSURE_RE = /disclosure|coordinated\s+disclosure/i;

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

  // Name: the page's main heading.
  const h1 = doc.querySelector(
    "main h1,[role='main'] h1,[role='heading'][aria-level='1'],h1",
  );
  const h1Text = textOf(h1);
  if (h1Text !== "") {
    data.name = h1Text;
    emit("name", "page_header", h1Text, h1Text, locatorFor(h1!));
  } else if (doc.title.trim() !== "") {
    const name = normalizeText(doc.title.split(/[|–—]/)[0] ?? "");
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

  // Safe Harbor level may live in its own section rather than the dl.
  if (data.safeHarborLevel === null) {
    const section = findSection(doc, SAFE_HARBOR_RE);
    const first = section !== null ? sectionItems(section)[0] : undefined;
    if (first !== undefined) {
      data.safeHarborLevel = first.text;
      emit(
        "safeHarborLevel",
        "explicit_program_rule",
        first.text,
        first.text,
        { section: sectionHeading(section!) ?? undefined },
      );
    }
  }

  // Coordinated disclosure / collaboration policy text.
  const disclosure = findSection(doc, DISCLOSURE_RE);
  if (disclosure !== null) {
    const text = sectionItems(disclosure)
      .map((i) => i.text)
      .join("\n");
    if (text !== "") {
      data.disclosurePolicy = text;
      emit(
        "disclosurePolicy",
        "explicit_program_rule",
        text,
        text,
        { section: sectionHeading(disclosure) ?? undefined },
      );
    }
  }

  // Header statistics with their attached time windows.
  const statsSection = findSection(doc, STATS_SECTION_RE);
  if (statsSection !== null) {
    const locator: SourceLocator = {
      section: sectionHeading(statsSection) ?? undefined,
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
