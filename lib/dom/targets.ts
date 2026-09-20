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
  scopeVerdictColumn,
  slugify,
  tableBodyRows,
  tableToRows,
  dlPairs,
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
    p1: number | string | null;
    p2: number | string | null;
    p3: number | string | null;
    p4: number | string | null;
    p5: number | string | null;
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
  /**
   * The target's table advertises a Known Issues column. When true, an absent
   * count *and* an absent control is a collection gap, not a feature the
   * brief never offered — the column's existence is the advertisement.
   */
  kiAdvertised: boolean;
}

export interface DomRule {
  text: string;
  appliesToDomKeys: string[];
  level: SourceLevel;
}

const SCOPE_HEADING_RE = /scope|targets?/i;
const OUT_SCOPE_RE =
  /out[- ]?of[- ]?scope|out[- ]?scope|not in scope|excluded targets?|out of bounds/i;
const SCOPE_GROUP_HEADING_RE =
  /^(?:in[- ]?scope|out[- ]?of[- ]?scope|out[- ]?scope)(?:\s+targets?)?$/i;
/**
 * The badge every scope card carries. It, not the card's title, says which
 * side of the boundary the card is on: a brief names its groups freely
 * ("Database Services Tier 1", "In Scope (Website Console)") and only the
 * badge is constant.
 */
const SCOPE_BADGE_RE = /^(in|out[- ]of)[- ]?scope$/i;
/**
 * Labels that dress a wrapper rather than name a group: the bare scope badge
 * and the "Targets N out of N" counter. A group whose only title is one of
 * these gets a deterministic identity instead of a coincidental wrapper
 * label.
 */
const GENERIC_GROUP_NAME_RE =
  /^(?:in[- ]?scope|out[- ]?of[- ]?scope|out[- ]?scope|scope|targets|targets?\s+\d+\s+out\s+of\s+\d+)$/i;
/**
 * A card holding the VRT scope-exclusion table. Its rows are vulnerability
 * classes, not assets; letting them reach Target[] would put "Physical
 * Security Issues" in the in-scope inventory (spec §4.4 owns this table).
 */
const VRT_CARD_RE = /\bvrt\b|vulnerability rating taxonomy/i;
// Labels arrive split across elements, so "P1" reads as "P 1".
const REWARD_HEADER_RE = /^p\s*[1-5]$/i;
const NOTE_SEL = "[role='note'],aside";

const COLUMN_RES: { key: string; re: RegExp }[] = [
  { key: "nameLocation", re: /^name\s*\/\s*location$/i },
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

/** In/out-of-scope from the card's own badge; null when it carries none. */
function scopeBadge(card: Element): boolean | null {
  for (const el of card.querySelectorAll("*")) {
    if (el.children.length > 0) continue; // leaf text only
    // Tabular data is never chrome: a VRT verdict cell reads exactly like a
    // badge, and a verdict about a vulnerability class says nothing about
    // which side of the boundary a card sits on.
    if (el.closest("table") !== null) continue;
    SCOPE_BADGE_RE.lastIndex = 0;
    const m = SCOPE_BADGE_RE.exec(textOf(el));
    if (m !== null) return !/^out/i.test(m[1] ?? "");
  }
  return null;
}

/** Currency and priority labels arrive split across elements. */
function tidyAmount(text: string): string {
  return text.replace(/([$€£₹])\s+(?=[\d.])/g, "$1");
}

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
    definitionLists: Element[];
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
      definitionLists,
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
    const rewardList = definitionLists.find((list) =>
      dlPairs(list).some(({ label }) => REWARD_HEADER_RE.test(label)),
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
    } else if (rewardList !== undefined) {
      for (const { label, dd } of dlPairs(rewardList)) {
        const match = /^p\s*([1-5])$/i.exec(label);
        if (match === null) continue;
        const key = `p${match[1]}` as keyof DomTargetGroup["rewards"];
        const visible = tidyAmount(textOf(dd));
        rewards[key] = visible === "" ? null : visible;
      }
      records.push(
        record(
          `dom:scope:rewards:${uniqueSlug(slugify(groupName), takenSlugs)}`,
          "explicit_program_rule",
          pageUrl,
          { section: sectionName, subsection: groupName },
          textOf(rewardList),
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
        let location = cellText(cells, cols.location) || null;
        let name = cellText(cells, cols.name) || null;
        if (cols.nameLocation !== undefined) {
          const combined = cells[cols.nameLocation];
          if (combined !== undefined) {
            const link = combined.querySelector("a[href]");
            const linkedName = textOf(link) || null;
            const visibleLocation = textExcluding(
              combined,
              "a,button,[role='button'],ul,ol",
            );
            name = linkedName;
            location = visibleLocation || linkedName;
            if (link === null) name = null;
          }
        }
        let category = cellText(cells, cols.category) || null;
        if (category === null) {
          // Current cards carry the category only as the row icon's tooltip
          // hint — a stable data attribute, not a generated class (§7.4).
          const locIdx = cols.nameLocation ?? cols.location;
          const hint =
            locIdx === undefined
              ? null
              : cells[locIdx]?.querySelector(
                  "[data-tooltip-id='categoryTooltip'][data-tooltip-content]",
                );
          const hintText = (
            hint?.getAttribute("data-tooltip-content") ?? ""
          ).trim();
          if (hintText !== "") category = hintText;
        }
        // A target is an asset, and an asset has an identity. A row with
        // neither a location nor a name belongs to a table that only
        // looks like a scope table, never to the inventory an agent tests.
        if (location === null && name === null) continue;

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
        const kiAdvertised = cols.ki !== undefined;

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
          kiAdvertised,
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
    // A table that states a scope verdict on every row is the VRT exclusion
    // table; so is one whose card title says so. Either way its rows are
    // vulnerability classes, not assets. The policy collector claims tables by
    // the same predicate, so no table can be read as both.
    const vrtTables: Element[] = [...scope.el.querySelectorAll("table")].filter(
      (table) =>
        scopeVerdictColumn(table) !== null ||
        VRT_CARD_RE.test(
          sectionHeading(
            table.closest("li,article,[role='group'],section") ?? table,
          ) ?? "",
        ),
    );
    const isVrtTable = (table: Element): boolean => vrtTables.includes(table);
    /** An element whose only tables are VRT tables is not a scope group. */
    const inVrtCard = (el: Element): boolean => {
      if (el.matches("table")) return isVrtTable(el);
      const tables = [...el.querySelectorAll("table")];
      return tables.length > 0 && tables.every(isVrtTable);
    };

    // A semantic group only exists when it wraps a table — a [role=group]
    // figure holding the reward chart is a chart, not a scope group, and
    // letting it become one splits one reward matrix into two groups.
    const semanticGroups = [
      ...scope.el.querySelectorAll("article,[role='group']"),
    ].filter(
      (g) =>
        owned(g) &&
        !candSet.has(g) &&
        !inVrtCard(g) &&
        g.querySelector("table") !== null,
    );
    // A scope card is recognised by its badge, not by its title: only the
    // badge is constant across briefs that name their groups freely.
    const badgeGroups = [
      ...scope.el.querySelectorAll("li,article,[role='group']"),
    ].filter(
      (g) =>
        !candSet.has(g) &&
        owned(g) &&
        !inVrtCard(g) &&
        g.querySelector("table") !== null &&
        scopeBadge(g) !== null,
    );
    const headingGroups = [...scope.el.querySelectorAll(HEADING_SEL)]
      .filter((h) => SCOPE_GROUP_HEADING_RE.test(textOf(h)))
      .map((h) => h.closest("li,article,[role='group']"))
      .filter(
        (g): g is Element =>
          g !== null &&
          !candSet.has(g) &&
          owned(g) &&
          !inVrtCard(g) &&
          g.querySelector("table") !== null,
      );
    const groupEls = [
      ...new Set([...semanticGroups, ...badgeGroups, ...headingGroups]),
    ];
    const groupSet = new Set(groupEls);
    // scope.el may itself be an <article> candidate — its own closest match
    // is itself, which must not disqualify its direct content.
    const inNestedGroup = (el: Element): boolean => {
      let cur = el.parentElement;
      while (cur !== null && cur !== scope.el) {
        if (groupSet.has(cur)) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const looseTables = [...scope.el.querySelectorAll("table")].filter(
      (t) => owned(t) && !inNestedGroup(t) && !inVrtCard(t),
    );
    const looseNotes = [...scope.el.querySelectorAll(NOTE_SEL)].filter(
      (n) => owned(n) && !inNestedGroup(n) && n.closest("tr") === null,
    );

    for (const g of groupEls) {
      const rawName = sectionHeading(g) ?? scope.heading;
      OUT_SCOPE_RE.lastIndex = 0;
      const badge = scopeBadge(g);
      const groupInScope =
        badge ?? (OUT_SCOPE_RE.test(rawName) ? false : scope.inScope);
      const name = GENERIC_GROUP_NAME_RE.test(rawName)
        ? groupInScope
          ? "default_in_scope"
          : "default_out_of_scope"
        : rawName;
      // Direct content only: content inside a nested group or a nested
      // candidate belongs to that element, which processes it separately.
      const direct = (el: Element): boolean => {
        if (!owned(el)) return false;
        let cur = el.parentElement;
        while (cur !== null && cur !== scope.el) {
          if (groupSet.has(cur)) return cur === g;
          cur = cur.parentElement;
        }
        return false;
      };
      processGroup({
        name,
        inScope: groupInScope,
        sectionName: scope.heading,
        index: groupIndex++,
        quoteEl: g,
        descRoot: g,
        owned: direct,
        tables: [...g.querySelectorAll("table")].filter(direct),
        definitionLists: [...g.querySelectorAll("dl")].filter(direct),
        notes: [...g.querySelectorAll(NOTE_SEL)].filter(
          (n) => direct(n) && n.closest("tr") === null,
        ),
      });
    }

    if (looseTables.length > 0) {
      // Direct content of this section (leaf or wrapper with own tables)
      // becomes an implicit group; its loose notes apply to that group.
      const implicitName = GENERIC_GROUP_NAME_RE.test(scope.heading)
        ? scope.inScope
          ? "default_in_scope"
          : "default_out_of_scope"
        : scope.heading;
      processGroup({
        name: implicitName,
        inScope: scope.inScope,
        sectionName: scope.heading,
        index: groupIndex++,
        quoteEl: scope.el,
        descRoot: scope.el,
        owned,
        tables: looseTables,
        definitionLists: [...scope.el.querySelectorAll("dl")].filter(
          (list) => owned(list) && !inNestedGroup(list),
        ),
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
