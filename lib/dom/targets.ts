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
  // Anchored so qualifiers like "Target type"/"Target status" fall through
  // to category/changes instead of being claimed as the location column.
  {
    key: "location",
    re: /^(?:targets?|locations?|assets?|urls?|uris?|domains?|addresses?|hosts?)$|^in[- ]?scope/i,
  },
  { key: "name", re: /^name$|target name|display name/i },
  { key: "category", re: /categor|type/i },
  { key: "tags", re: /\btags?\b|tagged/i },
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

interface ScopeSection {
  el: Element;
  heading: string;
  inScope: boolean;
}

/**
 * All scope containers: sections whose own heading mentions scope/targets.
 * Wrappers that contain deeper matching sections stay in the list — their
 * direct content is still processed (assigned to an implicit group) via the
 * nearest-candidate ownership test in collectTargets. "Out of scope"
 * headings classify the whole container.
 */
function scopeCandidates(doc: Document): ScopeSection[] {
  return [...doc.querySelectorAll(SECTION_SEL)]
    .filter((el) => {
      const h = el.querySelector(HEADING_SEL);
      if (h === null) return false;
      SCOPE_HEADING_RE.lastIndex = 0;
      return SCOPE_HEADING_RE.test(textOf(h));
    })
    .map((el) => {
      const heading = sectionHeading(el) ?? "";
      OUT_SCOPE_RE.lastIndex = 0;
      return { el, heading, inScope: !OUT_SCOPE_RE.test(heading) };
    });
}

/** Nearest ancestor (exclusive) that is a scope candidate, or null. */
function nearestCandidate(el: Element, candSet: Set<Element>): Element | null {
  let cur = el.parentElement;
  while (cur !== null) {
    if (candSet.has(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

interface ColumnMap {
  [key: string]: number | undefined;
}

function columnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {};
  headers.forEach((h, i) => {
    for (const { key, re } of COLUMN_RES) {
      re.lastIndex = 0;
      if (!re.test(h)) continue;
      // First matching key claims this header — one index, one key.
      if (map[key] === undefined) map[key] = i;
      break;
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

  interface GroupInput {
    name: string;
    inScope: boolean;
    sectionName: string;
    index: number;
    /** Element whose text becomes the group record quote. */
    quoteEl: Element;
    /** Root searched for a description paragraph. */
    descRoot: ParentNode;
    /** Membership test for this group's content (description lookup). */
    owned: (el: Element) => boolean;
    tables: Element[];
    /** Owned, non-row notes → group-level rules. */
    notes: Element[];
  }

  const processGroup = (input: GroupInput) => {
    const {
      name: groupName,
      inScope,
      sectionName,
      index: groupIndex,
      quoteEl,
      descRoot,
      owned,
      tables,
      notes,
    } = input;
    const domKey = `group:${uniqueSlug(
      slugify(groupName || `group-${groupIndex + 1}`),
      takenDomKeys,
    )}`;
    const firstP = [...descRoot.querySelectorAll("p")].find(
      (p) =>
        owned(p) &&
        p.closest("table") === null &&
        p.closest(NOTE_SEL) === null,
    );
    const description = firstP !== undefined ? textOf(firstP) || null : null;

    const rewards: DomTargetGroup["rewards"] = {
      p1: null,
      p2: null,
      p3: null,
      p4: null,
      p5: null,
    };
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
    const groupQuote = textOf(quoteEl);
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
    for (const note of notes) {
      const text = textOf(note);
      if (text === "") continue;
      emitRule(text, [domKey], "explicit_program_rule", sectionName, domKey);
    }
  };

  const scopes = scopeCandidates(doc);
  const candSet = new Set(scopes.map((s) => s.el));
  let groupIndex = 0;
  for (const scope of scopes) {
    // Content owned by this candidate: nearest candidate-section ancestor is
    // this element (nested candidates own their own subtrees).
    const owned = (el: Element): boolean =>
      nearestCandidate(el, candSet) === scope.el;
    // Elements that are themselves candidates self-process (mirroring how
    // nested <section> candidates work) — excluding them here prevents
    // their content being emitted twice.
    const groupEls = [
      ...scope.el.querySelectorAll("article,[role='group']"),
    ].filter((g) => owned(g) && !candSet.has(g));
    // scope.el may itself be an <article> candidate — its own closest match
    // is itself, which must not disqualify its direct content.
    const inNestedGroup = (el: Element): boolean => {
      const g = el.closest("article,[role='group']");
      return g !== null && g !== scope.el;
    };
    const looseTables = [...scope.el.querySelectorAll("table")].filter(
      (t) => owned(t) && !inNestedGroup(t),
    );
    const looseNotes = [...scope.el.querySelectorAll(NOTE_SEL)].filter(
      (n) => owned(n) && !inNestedGroup(n) && n.closest("tr") === null,
    );

    for (const g of groupEls) {
      const name = sectionHeading(g) ?? scope.heading;
      // Direct content only: content inside a nested group or a nested
      // candidate belongs to that element, which processes it separately.
      const direct = (el: Element): boolean =>
        owned(el) && el.closest("article,[role='group']") === g;
      processGroup({
        name,
        inScope: scope.inScope,
        sectionName: scope.heading,
        index: groupIndex++,
        quoteEl: g,
        descRoot: g,
        owned: direct,
        tables: [...g.querySelectorAll("table")].filter(direct),
        notes: [...g.querySelectorAll(NOTE_SEL)].filter(
          (n) => direct(n) && n.closest("tr") === null,
        ),
      });
    }

    if (looseTables.length > 0) {
      // Direct content of this section (leaf or wrapper with own tables)
      // becomes an implicit group; its loose notes apply to that group.
      processGroup({
        name: scope.heading,
        inScope: scope.inScope,
        sectionName: scope.heading,
        index: groupIndex++,
        quoteEl: scope.el,
        descRoot: scope.el,
        owned,
        tables: looseTables,
        notes: looseNotes,
      });
    } else {
      // Section-level notes outside any group: engagement-wide boundaries.
      for (const note of looseNotes) {
        const text = textOf(note);
        if (text === "") continue;
        emitRule(text, [], "explicit_program_rule", scope.heading);
      }
    }
  }

  return { records, groups, targets, rules };
}
