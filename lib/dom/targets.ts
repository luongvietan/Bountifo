import type {
  ExtractionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  HEADING_SEL,
  SECTION_SEL,
  nearestLabeled,
  resolveUrl,
  rowCells,
  sectionHeading,
  slugify,
  tableBodyRows,
  tableToRows,
  textExcluding,
  textOf,
  uniqueSlug,
} from "./domUtils";

export interface DomTargetGroup {
  domKey: string;
  name: string;
  inScope: boolean;
  description: string | null;
  rewards: {
    p1: number | null;
    p2: number | null;
    p3: number | null;
    p4: number | null;
    p5: number | null;
  };
}

export interface DomTarget {
  domKey: string;
  groupDomKey: string | null;
  /** Whether the owning scope group is in scope (out-of-scope → false). */
  inScope: boolean;
  location: string | null;
  name: string | null;
  category: string | null;
  tags: string[];
  docLinks: string[];
  changeFlags: string[];
  displayedKnownIssuesCount: number | null;
  kiControlLabel: string | null;
}

export interface DomRule {
  text: string;
  appliesToDomKeys: string[];
  level: SourceLevel;
}

const SCOPE_HEADING_RE = /scope|targets?/i;
const OUT_SCOPE_RE =
  /out[- ]?of[- ]?scope|out[- ]?scope|not in scope|excluded targets?|out of bounds/i;
const REWARD_HEADER_RE = /^p[1-5]$/i;
const NOTE_SEL = "[role='note'],aside";

const COLUMN_RES: { key: string; re: RegExp }[] = [
  { key: "location", re: /target|location|asset|url|uri|domain|address|host/i },
  { key: "name", re: /^name$|target name|display name/i },
  { key: "category", re: /categor|type/i },
  { key: "tags", re: /tag/i },
  { key: "docs", re: /doc|reference|link|resource/i },
  { key: "changes", re: /change|flag|update|status/i },
  { key: "ki", re: /known issues?|^ki$/i },
];

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

function parseReward(text: string): number | null {
  const m = /([\d,]+(?:\.\d+)?)/.exec(text);
  if (m === null) return null;
  const n = Number.parseFloat((m[1] ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** The nearest section-ish ancestor that owns an element (for nesting). */
function ownerSection(el: Element): Element | null {
  return el.parentElement?.closest(SECTION_SEL) ?? null;
}

interface ScopeSection {
  el: Element;
  heading: string;
  inScope: boolean;
}

/**
 * Leaf scope containers: sections whose own heading mentions scope/targets and
 * that do not contain a deeper matching section (avoids processing wrapper
 * sections twice). "Out of scope" headings classify the whole container.
 */
function scopeSections(doc: Document): ScopeSection[] {
  const all = [...doc.querySelectorAll(SECTION_SEL)];
  const candidates = all.filter((el) => {
    const h = el.querySelector(HEADING_SEL);
    if (h === null) return false;
    SCOPE_HEADING_RE.lastIndex = 0;
    return SCOPE_HEADING_RE.test(textOf(h));
  });
  return candidates
    .filter(
      (el) =>
        !candidates.some((other) => other !== el && el.contains(other)),
    )
    .map((el) => {
      const heading = sectionHeading(el) ?? "";
      OUT_SCOPE_RE.lastIndex = 0;
      return { el, heading, inScope: !OUT_SCOPE_RE.test(heading) };
    });
}

interface ColumnMap {
  [key: string]: number | undefined;
}

function columnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  headers.forEach((h, i) => {
    for (const { key, re } of COLUMN_RES) {
      re.lastIndex = 0;
      if (re.test(h) && map[key] === undefined) map[key] = i;
    }
  });
  return map;
}

function cellText(cells: Element[], idx: number | undefined): string {
  if (idx === undefined) return "";
  const cell = cells[idx];
  return cell === undefined ? "" : textExcluding(cell, `${NOTE_SEL},ul,ol`);
}

function knownIssues(cell: Element | undefined): {
  count: number | null;
  control: string | null;
} {
  if (cell === undefined) return { count: null, control: null };
  let count: number | null = null;
  for (const el of cell.querySelectorAll("[aria-label]")) {
    const m = /(\d+)\s*known issues?/i.exec(
      el.getAttribute("aria-label") ?? "",
    );
    if (m !== null) {
      const n = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(n)) {
        count = n;
        break;
      }
    }
  }
  if (count === null) {
    const m = /(\d+)/.exec(textOf(cell));
    const n = m === null ? NaN : Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(n)) count = n;
  }
  const control = cell.querySelector("button,a,[role='button']");
  const controlLabel =
    control === null
      ? null
      : (nearestLabeled(control) ?? (textOf(control) || null));
  return { count, control: controlLabel };
}

/**
 * Visible scope: in-scope AND out-of-scope groups (inScope flag), reward
 * ranges, targets (locations, names, categories, tags, doc links, change
 * flags, displayed Known Issues), and boundary/target-specific rules.
 * SourceKeys live under `dom:scope:<section>:<item-slug>`.
 */
export function collectTargets(
  doc: Document,
  pageUrl: string,
): {
  records: SourceRecord[];
  groups: DomTargetGroup[];
  targets: DomTarget[];
  rules: DomRule[];
} {
  const records: SourceRecord[] = [];
  const groups: DomTargetGroup[] = [];
  const targets: DomTarget[] = [];
  const rules: DomRule[] = [];
  const takenDomKeys = new Set<string>();
  const takenSlugs = new Set<string>();

  const emitRule = (
    text: string,
    appliesToDomKeys: string[],
    level: SourceLevel,
    sectionName: string,
    targetId?: string,
  ) => {
    rules.push({ text, appliesToDomKeys, level });
    const locator: SourceLocator = { section: sectionName };
    if (targetId !== undefined) locator.targetId = targetId;
    records.push(
      record(
        `dom:scope:rule:${uniqueSlug(slugify(text), takenSlugs)}`,
        level,
        pageUrl,
        locator,
        text,
        { text, appliesToDomKeys, level },
      ),
    );
  };

  const processGroup = (
    groupEl: Element,
    groupName: string,
    inScope: boolean,
    sectionName: string,
    groupIndex: number,
  ) => {
    const domKey = `group:${uniqueSlug(
      slugify(groupName || `group-${groupIndex + 1}`),
      takenDomKeys,
    )}`;
    const firstP = [...groupEl.querySelectorAll("p")].find(
      (p) => p.closest("table") === null && p.closest(NOTE_SEL) === null,
    );
    const description = firstP !== undefined ? textOf(firstP) || null : null;

    const rewards: DomTargetGroup["rewards"] = {
      p1: null,
      p2: null,
      p3: null,
      p4: null,
      p5: null,
    };
    const tables = [...groupEl.querySelectorAll("table")];
    const rewardTable = tables.find((t) =>
      tableToRows(t).headers.some((h) => {
        REWARD_HEADER_RE.lastIndex = 0;
        return REWARD_HEADER_RE.test(h);
      }),
    );
    if (rewardTable !== undefined) {
      const { headers, rows } = tableToRows(rewardTable);
      const pIndex: Record<string, number> = {};
      headers.forEach((h, i) => {
        const m = /^p([1-5])$/i.exec(h);
        if (m !== null && m[1] !== undefined) pIndex[`p${m[1]}`] = i;
      });
      const valueRow = rows[0] ?? [];
      for (const p of ["p1", "p2", "p3", "p4", "p5"] as const) {
        const idx = pIndex[p];
        rewards[p] = idx === undefined ? null : parseReward(valueRow[idx] ?? "");
      }
      records.push(
        record(
          `dom:scope:rewards:${uniqueSlug(slugify(groupName), takenSlugs)}`,
          "explicit_program_rule",
          pageUrl,
          { section: sectionName, subsection: groupName },
          textOf(rewardTable),
          rewards,
        ),
      );
    }

    const group: DomTargetGroup = {
      domKey,
      name: groupName,
      inScope,
      description,
      rewards,
    };
    groups.push(group);
    const groupQuote = textOf(groupEl);
    if (groupQuote !== "") {
      records.push(
        record(
          `dom:scope:group:${uniqueSlug(slugify(groupName), takenSlugs)}`,
          "explicit_program_rule",
          pageUrl,
          { section: sectionName, subsection: groupName },
          groupQuote,
          group,
        ),
      );
    }

    // Target tables: any non-reward table inside the group.
    let rowIndex = 0;
    for (const table of tables) {
      if (table === rewardTable) continue;
      const { headers } = tableToRows(table);
      if (headers.length === 0) continue;
      const cols = columnMap(headers);
      let lastTargetKey: string | null = null;
      for (const tr of tableBodyRows(table)) {
        const cells = rowCells(tr);
        const isNoteRow =
          cells.length <= 1 && tr.querySelector(NOTE_SEL) !== null;
        if (isNoteRow) {
          for (const note of tr.querySelectorAll(NOTE_SEL)) {
            const text = textOf(note);
            if (text === "") continue;
            emitRule(
              text,
              lastTargetKey !== null ? [lastTargetKey] : [domKey],
              lastTargetKey !== null
                ? "target_specific_rule"
                : "explicit_program_rule",
              sectionName,
              lastTargetKey ?? domKey,
            );
          }
          continue;
        }
        const location = cellText(cells, cols.location) || null;
        const name = cellText(cells, cols.name) || null;
        const category = cellText(cells, cols.category) || null;
        // Skip fully empty rows — no location/name/category and no text.
        if (
          location === null &&
          name === null &&
          category === null &&
          textOf(tr) === ""
        ) {
          continue;
        }

        const tagsCell = cols.tags !== undefined ? cells[cols.tags] : undefined;
        const tags =
          tagsCell === undefined
            ? []
            : [...tagsCell.querySelectorAll("li")].map((li) => textOf(li));
        const tagText = cellText(cells, cols.tags);
        const tagList =
          tags.filter((t) => t !== "").length > 0
            ? tags.filter((t) => t !== "")
            : tagText === ""
              ? []
              : tagText.split(/[,;|•]/).map((t) => t.trim()).filter((t) => t !== "");

        const docsCell = cols.docs !== undefined ? cells[cols.docs] : undefined;
        const docLinks =
          docsCell === undefined
            ? []
            : [...docsCell.querySelectorAll("a[href]")]
                .map((a) => resolveUrl(a.getAttribute("href"), pageUrl))
                .filter((u): u is string => u !== null);

        const changeCell =
          cols.changes !== undefined ? cells[cols.changes] : undefined;
        const changeFlags =
          changeCell === undefined
            ? []
            : (() => {
                const items = [...changeCell.querySelectorAll("li")]
                  .map((li) => textOf(li))
                  .filter((t) => t !== "");
                if (items.length > 0) return items;
                const text = textExcluding(changeCell, NOTE_SEL);
                return text === "" ? [] : [text];
              })();

        const kiCell = cols.ki !== undefined ? cells[cols.ki] : undefined;
        const ki = knownIssues(kiCell);

        const targetKey = `target:${uniqueSlug(
          slugify(location ?? name ?? `target-${rowIndex + 1}`),
          takenSlugs,
        )}`;
        const target: DomTarget = {
          domKey: targetKey,
          groupDomKey: domKey,
          inScope,
          location,
          name,
          category,
          tags: tagList,
          docLinks,
          changeFlags,
          displayedKnownIssuesCount: ki.count,
          kiControlLabel: ki.control,
        };
        targets.push(target);
        lastTargetKey = targetKey;
        records.push(
          record(
            `dom:scope:target:${targetKey.slice("target:".length)}`,
            "explicit_program_rule",
            pageUrl,
            {
              section: sectionName,
              subsection: groupName,
              table: "targets",
              rowIndex,
            },
            textOf(tr),
            target,
          ),
        );
        rowIndex++;

        // Notes embedded inside a target row apply to that target.
        for (const note of tr.querySelectorAll(NOTE_SEL)) {
          const text = textOf(note);
          if (text === "") continue;
          emitRule(text, [targetKey], "target_specific_rule", sectionName, targetKey);
        }
      }
    }

    // Group-level notes (outside tables) apply to the group.
    for (const note of groupEl.querySelectorAll(NOTE_SEL)) {
      if (note.closest("tr") !== null) continue; // row rules handled above
      const text = textOf(note);
      if (text === "") continue;
      emitRule(text, [domKey], "explicit_program_rule", sectionName, domKey);
    }
  };

  let groupIndex = 0;
  for (const scope of scopeSections(doc)) {
    const groupEls = [...scope.el.querySelectorAll("article,[role='group']")]
      .filter((g) => ownerSection(g) === scope.el);

    if (groupEls.length === 0) {
      // Section holds targets directly → one implicit group.
      processGroup(scope.el, scope.heading, scope.inScope, scope.heading, groupIndex++);
    } else {
      for (const g of groupEls) {
        const name = sectionHeading(g) ?? scope.heading;
        processGroup(g, name, scope.inScope, scope.heading, groupIndex++);
      }
    }

    // Section-level notes outside any group: engagement-wide boundaries.
    // (Skipped for implicit groups — processGroup already claims them.)
    if (groupEls.length > 0) {
      for (const note of scope.el.querySelectorAll(NOTE_SEL)) {
        if (note.closest("article,[role='group']") !== null) continue;
        if (note.closest("tr") !== null) continue;
        const text = textOf(note);
        if (text === "") continue;
        emitRule(text, [], "explicit_program_rule", scope.heading);
      }
    }
  }

  return { records, groups, targets, rules };
}
