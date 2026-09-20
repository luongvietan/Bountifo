import { normalizeText } from "../canonical";

/**
 * Semantic DOM helpers shared by the collectors. Extraction relies on roles,
 * headings, aria labels, tables, and stable attributes — never generated CSS
 * classes (spec §7.4).
 */

// DOM filter/tree-walker constants (numeric so no global NodeFilter is needed).
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const SHOW_TEXT = 4;

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

export const HEADING_SEL = "h1,h2,h3,h4,h5,h6,[role='heading']";
export const SECTION_SEL =
  "section,article,details,fieldset,[role='region'],[role='section']";
// Ownership boundaries for section items: real subsection containers.
// article/[role=group] are transparent wrappers — their content still
// belongs to the enclosing section (otherwise article-owned lists vanish).
const OWNER_SEL = "section,details,fieldset,[role='region'],[role='section']";
const TEXT_BLOCK_SEL =
  "p,li,dt,dd,blockquote,figcaption,summary,pre,td,th," +
  "h1,h2,h3,h4,h5,h6,[role='paragraph']";

function isHiddenMarkup(el: Element): boolean {
  // The exporter's own in-page UI is never engagement content. It renders in a
  // shadow root, which these queries already cannot reach; the attribute is
  // the belt to that suspenders.
  if (el.hasAttribute("data-bugcrowd-exporter")) return true;
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  return (
    /display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style)
  );
}

/** True when el or any ancestor up to (and excluding) `boundary` is hidden. */
export function chainHidden(el: Element | null, boundary?: Element): boolean {
  let cur = el;
  while (cur !== null) {
    if (isHiddenMarkup(cur)) return true;
    if (cur === boundary) return false;
    cur = cur.parentElement;
  }
  return false;
}

/** Normalized visible text of an element; hidden subtrees are skipped. */
export function textOf(el: Element | null | undefined): string {
  if (el === null || el === undefined) return "";
  const walker = el.ownerDocument.createTreeWalker(el, SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (parent !== null && chainHidden(parent, el)) return FILTER_REJECT;
      return FILTER_ACCEPT;
    },
  });
  let raw = "";
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    raw += ` ${node.textContent ?? ""}`;
  }
  return normalizeText(raw);
}

/**
 * Locates a section by its heading role/text: finds the first heading matching
 * headingRe and returns the closest semantic container (section, article,
 * fieldset, details, [role=region]). Falls back to the heading's parent, then
 * the heading itself.
 */
export function findSection(root: ParentNode, headingRe: RegExp): Element | null {
  for (const h of root.querySelectorAll(HEADING_SEL)) {
    headingRe.lastIndex = 0;
    if (!headingRe.test(textOf(h))) continue;
    return h.closest(SECTION_SEL) ?? h.parentElement ?? h;
  }
  return null;
}

/** Text of the first heading inside el (null when the section is unlabeled). */
export function sectionHeading(el: Element): string | null {
  const h = el.querySelector(HEADING_SEL);
  const text = textOf(h);
  return text === "" ? null : text;
}

/** thead (or first all-th row) headers plus body-row cell text. */
export function tableToRows(table: Element): {
  headers: string[];
  rows: string[][];
} {
  const cellText = (tr: Element) =>
    [...tr.querySelectorAll("th,td")].map((c) => textOf(c));
  const headRow =
    table.querySelector("thead tr") ??
    [...table.querySelectorAll("tr")].find(
      (tr) => tr.querySelector("th") !== null,
    ) ??
    null;
  const bodyTrs = [...table.querySelectorAll("tr")].filter(
    (tr) => tr !== headRow && tr.closest("thead") === null,
  );
  return {
    headers: headRow === null ? [] : cellText(headRow),
    rows: bodyTrs.map(cellText),
  };
}

/** Body-row <tr> elements (excludes the header row), for cell-level access. */
export function tableBodyRows(table: Element): Element[] {
  const headRow =
    table.querySelector("thead tr") ??
    [...table.querySelectorAll("tr")].find(
      (tr) => tr.querySelector("th") !== null,
    ) ??
    null;
  return [...table.querySelectorAll("tr")].filter(
    (tr) => tr !== headRow && tr.closest("thead") === null,
  );
}

/** A scope verdict as the VRT exclusion table states it. */
const SCOPE_VERDICT_RE = /^(?:out[- ]of[- ]scope|in[- ]scope|conditional)$/i;

/**
 * Index of a table's scope-verdict column, or null when it has none.
 *
 * This is what separates the VRT scope-exclusion table from a target table
 * without trusting headings or card titles: every row of the VRT table carries
 * a verdict ("Out-of-Scope" / "Conditional"), and no target table has a column
 * that does. Both collectors ask the same question, so a table can never be
 * read as targets by one and as policy by the other.
 */
export function scopeVerdictColumn(table: Element): number | null {
  const rows = tableBodyRows(table);
  if (rows.length === 0) return null;
  const width = Math.max(...rows.map((row) => rowCells(row).length));
  for (let i = 0; i < width; i++) {
    let seen = 0;
    let verdicts = 0;
    for (const row of rows) {
      const cell = rowCells(row)[i];
      if (cell === undefined) continue;
      seen++;
      SCOPE_VERDICT_RE.lastIndex = 0;
      if (SCOPE_VERDICT_RE.test(textOf(cell))) verdicts++;
    }
    if (seen > 0 && verdicts === seen) return i;
  }
  return null;
}

/** Cells (td/th) of a row element. */
export function rowCells(tr: Element): Element[] {
  return [...tr.querySelectorAll("td,th")];
}

/**
 * Yields innermost semantic text blocks (p, li, dt/dd, cells, headings, …)
 * with non-empty normalized text. Parents defer to their block descendants so
 * each text unit is yielded once; hidden subtrees are skipped.
 */
export function* eachTextBlock(
  root: ParentNode,
): Generator<{ el: Element; text: string }> {
  for (const el of root.querySelectorAll(TEXT_BLOCK_SEL)) {
    if (el.querySelector(TEXT_BLOCK_SEL) !== null) continue;
    if (chainHidden(el)) continue;
    const text = textOf(el);
    if (text !== "") yield { el, text };
  }
}

/** Heading rank (h1–h6 / aria-level); unlabeled role=heading defaults to 2. */
function headingRank(h: Element): number {
  const aria = (h.getAttribute("aria-level") ?? "").trim();
  if (/^[1-6]$/.test(aria)) return Number(aria);
  const m = /^H([1-6])$/.exec(h.tagName);
  return m === null ? 2 : Number(m[1]);
}

/** True when `section` holds another heading of the same or higher rank. */
function hasRivalHeading(section: Element, h: Element): boolean {
  const rank = headingRank(h);
  for (const other of section.querySelectorAll(HEADING_SEL)) {
    if (other !== h && headingRank(other) <= rank) return true;
  }
  return false;
}

/**
 * Feed/sidebar/meta headings that always close a heading range, whatever their
 * rank. Briefs rank them inconsistently ("What's new" is an h3 under a run of
 * h2 sections), so rank alone cannot tell an activity sidebar from a policy
 * subsection — their vocabulary can.
 */
const ASIDE_HEADING_RE =
  /what(?:'|’)s\s+new|announcements?|change\s*log|changelog|recent(?:ly)?\s+(?:activity|changes|submissions?|reports?|joined)|activity|accepted\s+reports?|crowd\s+highlights?|hall\s+of\s+fam\w*|leaderboard|top\s+researchers?|things\s+to\s+know|on\s+this\s+page|meet\s+the\s+team|participation\s+and\s+response/i;

/**
 * The heading itself, or the plain wrapper it opens — so `<div><h2>…</h2></div>`
 * followed by the section body still finds that body. Semantic containers,
 * list items and roles end the climb: their siblings belong to someone else.
 */
function rangeStart(h: Element): Element {
  let node: Element = h;
  for (;;) {
    if (node.nextElementSibling !== null) return node;
    const parent = node.parentElement;
    if (parent === null) return node;
    if (!/^(?:DIV|SPAN)$/.test(parent.tagName)) return node;
    if (parent.firstElementChild !== node) return node;
    if (parent.matches(SECTION_SEL) || parent.hasAttribute("role")) return node;
    node = parent;
  }
}

/**
 * Sibling elements between a heading and the next peer block. A sibling
 * heading of the same or higher rank starts a new block; a deeper-ranked one
 * is a subsection heading and its content belongs to this range (an h2
 * "Testing Guidelines" owns its h3 "API Testing" subsection). Feed/meta
 * headings end the range at any rank — briefs do not rank sidebars
 * consistently. A sibling that merely *contains* a heading ends the range
 * under the same rules, which keeps titled cards inside a feed's range.
 */
function headingRange(h: Element): Element[] {
  const rank = headingRank(h);
  const ends = (el: Element): boolean => {
    if (el.matches(HEADING_SEL)) {
      ASIDE_HEADING_RE.lastIndex = 0;
      return headingRank(el) <= rank || ASIDE_HEADING_RE.test(textOf(el));
    }
    for (const inner of el.querySelectorAll(HEADING_SEL)) {
      ASIDE_HEADING_RE.lastIndex = 0;
      if (headingRank(inner) <= rank || ASIDE_HEADING_RE.test(textOf(inner))) {
        return true;
      }
    }
    return false;
  };
  const out: Element[] = [];
  let sib = rangeStart(h).nextElementSibling;
  while (sib !== null && !ends(sib)) {
    out.push(sib);
    sib = sib.nextElementSibling;
  }
  return out;
}

/** Deepest li / text blocks of one range element (headings excluded). */
function blocksOf(el: Element, out: Element[]): void {
  if (chainHidden(el)) return;
  if (el.matches("ul,ol")) {
    for (const li of el.querySelectorAll("li")) {
      if (li.querySelector("li") === null) out.push(li);
    }
    return;
  }
  if (el.matches(TEXT_BLOCK_SEL) && el.querySelector(TEXT_BLOCK_SEL) === null) {
    if (!el.matches(HEADING_SEL)) out.push(el);
    return;
  }
  for (const li of el.querySelectorAll("li")) {
    if (li.querySelector("li") === null) out.push(li);
  }
  for (const block of eachTextBlock(el)) {
    if (block.el.matches(HEADING_SEL)) continue;
    if (block.el.closest("li") !== null) continue;
    out.push(block.el);
  }
}

/** Document-order sort (Node.DOCUMENT_POSITION_FOLLOWING = 4). */
function inDocumentOrder(els: Element[]): Element[] {
  return [...new Set(els)].sort(
    (a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1) as -1 | 1,
  );
}

export interface SectionScope {
  /** Container for section-level queries: the section, or the heading's parent. */
  el: Element;
  heading: string | null;
  /** The section, or the sibling run the heading owns. */
  members: Element[];
  /** True when the scope is a heading range rather than a whole section. */
  bounded: boolean;
  items: { el: Element; text: string }[];
}

/**
 * Content a heading owns. A heading that labels its own semantic container
 * yields that container (`findSection` behavior); when several same-rank
 * headings share one container — Bugcrowd stacks the whole brief inside a
 * single <section> — the scope is bounded by the next heading instead, so a
 * collector reads its own block and not the entire page.
 */
export function findSectionScope(
  root: ParentNode,
  headingRe: RegExp,
  skip?: (heading: Element, text: string) => boolean,
): SectionScope | null {
  for (const h of root.querySelectorAll(HEADING_SEL)) {
    const text = textOf(h);
    headingRe.lastIndex = 0;
    if (!headingRe.test(text)) continue;
    if (skip?.(h, text) === true) continue;
    const section = h.closest(SECTION_SEL);
    // A semantic container is the heading's block only when it genuinely
    // *starts with* that heading and holds no peer/higher-ranked rival. A
    // heading buried inside a giant wrapper <section> (Bugcrowd puts the
    // whole brief in one) does not own the wrapper — its range ends at the
    // next peer heading instead.
    if (
      section !== null &&
      section.querySelector(HEADING_SEL) === h &&
      !hasRivalHeading(section, h)
    ) {
      return {
        el: section,
        heading: sectionHeading(section),
        members: [section],
        bounded: false,
        items: sectionItems(section),
      };
    }
    const members = headingRange(h);
    const els: Element[] = [];
    for (const member of members) blocksOf(member, els);
    const items: { el: Element; text: string }[] = [];
    for (const el of inDocumentOrder(els)) {
      const itemText = textOf(el);
      if (itemText !== "") items.push({ el, text: itemText });
    }
    return {
      el: h.parentElement ?? h,
      heading: text === "" ? null : text,
      members,
      bounded: true,
      items,
    };
  }
  return null;
}

/**
 * Every heading scope matching the pattern, in document order. A brief may
 * state one kind of rule under several headings ("Program Rules", "Exploit
 * Chain Testing"); taking only the first silently drops the rest.
 */
export function findAllSectionScopes(
  root: ParentNode,
  headingRe: RegExp,
  skip?: (heading: Element, text: string) => boolean,
): SectionScope[] {
  const out: SectionScope[] = [];
  const claimed = new Set<Element>();
  for (const h of root.querySelectorAll(HEADING_SEL)) {
    const text = textOf(h);
    headingRe.lastIndex = 0;
    if (!headingRe.test(text)) continue;
    if (skip?.(h, text) === true) continue;
    const scope = findSectionScope(h.parentElement ?? root, headingRe, (el) =>
      el !== h,
    );
    if (scope === null) continue;
    // A section reached through two matching headings is collected once.
    if (claimed.has(scope.el) && !scope.bounded) continue;
    claimed.add(scope.el);
    out.push(scope);
  }
  return out;
}

/**
 * Text of the heading that most closely precedes `el` in document order —
 * the section label under which the block was authored, independent of which
 * semantic container wraps it. Null when no heading precedes the element.
 */
export function precedingHeadingText(
  root: ParentNode,
  el: Element,
): string | null {
  let out: Element | null = null;
  for (const h of root.querySelectorAll(HEADING_SEL)) {
    if (h === el) break;
    // FOLLOWING (4) ⇒ h comes after el; the list is document-ordered, so the
    // first follower ends the search. Ancestors report PRECEDING|CONTAINED_BY.
    if ((el.compareDocumentPosition(h) & 4) !== 0) break;
    out = h;
  }
  if (out === null) return null;
  const text = textOf(out);
  return text === "" ? null : text;
}

/**
 * The accessible-ish label nearest to el: aria-label, aria-labelledby,
 * wrapping <label>, label[for], then fieldset <legend>. Null when unlabeled.
 */
export function nearestLabeled(el: Element): string | null {
  const aria = normalizeText(el.getAttribute("aria-label") ?? "");
  if (aria !== "") return aria;
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby !== null) {
    const text = normalizeText(
      labelledby
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter((e): e is HTMLElement => e !== null)
        .map((e) => textOf(e))
        .join(" "),
    );
    if (text !== "") return text;
  }
  const wrapping = el.closest("label");
  if (wrapping !== null) {
    const text = textOf(wrapping);
    if (text !== "") return text;
  }
  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    for (const lab of el.ownerDocument.querySelectorAll("label[for]")) {
      if (lab.getAttribute("for") === id) {
        const text = textOf(lab);
        if (text !== "") return text;
      }
    }
  }
  const fieldset = el.closest("fieldset");
  if (fieldset !== null) {
    const legend = fieldset.querySelector("legend");
    if (legend !== null) {
      const text = textOf(legend);
      if (text !== "") return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collector building blocks (shared helpers; not part of the brief's core five)
// ---------------------------------------------------------------------------

/** kebab-case slug from display text; deterministic, word-bounded. */
export function slugify(text: string, maxWords = 8): string {
  const words = normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((w) => w !== "")
    .slice(0, maxWords);
  return words.join("-") || "item";
}

/** Appends a numeric suffix when a slug was already taken. */
export function uniqueSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Resolves href against base; null when either side is unparseable. */
export function resolveUrl(
  href: string | null | undefined,
  base: string,
): string | null {
  if (href === null || href === undefined || href.trim() === "") return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** textOf a clone with every element matching `selector` removed first. */
export function textExcluding(el: Element, selector: string): string {
  const clone = el.cloneNode(true) as Element;
  for (const victim of clone.querySelectorAll(selector)) victim.remove();
  return textOf(clone);
}

/** dt → following dd pairs (supports dl > div > dt+dd markup). */
export function dlPairs(
  container: ParentNode,
): { label: string; dd: Element }[] {
  const out: { label: string; dd: Element }[] = [];
  for (const dt of container.querySelectorAll("dt")) {
    let dd = dt.nextElementSibling;
    while (dd !== null && dd.tagName !== "DD") dd = dd.nextElementSibling;
    if (dd === null) {
      dd = dt.parentElement?.querySelector("dd") ?? null;
    }
    if (dd !== null) out.push({ label: textOf(dt), dd });
  }
  return out;
}

const WINDOW_RE =
  /\b(?:in|within|over|during)\s+the\s+(?:last|past|next)\s+[\w-]+(?:\s+[\w-]+)?|\blast\s+\d+\s+(?:days?|weeks?|months?|years?)|\bpast\s+\d+\s+(?:days?|weeks?|months?|years?)|\ball[\s-]?time\b|\blifetime\b|\bto date\b/i;

/** Splits a value element into value + time window (<small> or a phrase). */
export function splitValueWindow(el: Element): {
  value: string;
  window: string | null;
} {
  const small = el.querySelector("small");
  const full = textOf(el);
  if (small !== null) {
    const w = textOf(small);
    const value = normalizeText(
      w !== "" && full.endsWith(w) ? full.slice(0, full.length - w.length) : full,
    );
    return { value, window: w === "" ? null : w };
  }
  const m = WINDOW_RE.exec(full);
  if (m !== null) {
    return {
      value: normalizeText(full.replace(m[0], "")),
      window: normalizeText(m[0]),
    };
  }
  return { value: full, window: null };
}

export interface StatEntry {
  label: string;
  value: string;
  window: string | null;
}

/**
 * Statistics from labeled markup: dl pairs (dt = label, dd = value + optional
 * <small> window) and list items of the form `<li><strong>value</strong> label
 * <small>window</small></li>`. First label wins on duplicates.
 */
export function extractStats(container: ParentNode): StatEntry[] {
  const out: StatEntry[] = [];
  const seen = new Set<string>();
  for (const { label, dd } of dlPairs(container)) {
    const { value, window } = splitValueWindow(dd);
    if (label === "" || value === "") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value, window });
  }
  for (const li of container.querySelectorAll("li")) {
    const valueEl = li.querySelector("strong,b");
    const small = li.querySelector("small");
    const win =
      small !== null ? textOf(small) : (WINDOW_RE.exec(textOf(li))?.[0] ?? null);
    let value: string;
    let label: string;
    if (valueEl !== null) {
      value = textOf(valueEl);
      label = textExcluding(li, "strong,b,small,time");
    } else {
      // Unemphasized pair markup: `<li><span>label</span><span>value</span>`,
      // label first, with the window in its own trailing element.
      const parts = [...li.children].filter(
        (child) => !child.matches("small,time"),
      );
      if (parts.length < 2) continue;
      label = textOf(parts[0]);
      value = textOf(parts[1]);
    }
    if (label === "" || value === "") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value, window: win === "" ? null : win });
  }
  return out;
}

/**
 * Items of a section: the union of its owned leaf `li`s and its owned non-li
 * text blocks, so sections mixing paragraphs and lists lose neither. "Owned"
 * means the nearest OWNER_SEL ancestor is this section — article/[role=group]
 * wrappers are transparent; nested sections keep their own content. Blocks
 * inside an li are already covered by that li's text.
 */
export function sectionItems(
  section: Element,
): { el: Element; text: string }[] {
  // "Owned" = nearest boundary ancestor is `section`. `section` itself is
  // always a boundary — an <article> (not in OWNER_SEL) legitimately returned
  // by findSection must own its own contents. A nearer OWNER_SEL ancestor
  // wins, so nested sections keep their own items.
  const ownedBy = (el: Element): boolean => {
    let cur = el.parentElement;
    while (cur !== null) {
      if (cur === section) return true;
      if (cur.matches(OWNER_SEL)) return false;
      cur = cur.parentElement;
    }
    return false;
  };
  const els: Element[] = [];
  for (const li of section.querySelectorAll("li")) {
    if (!ownedBy(li)) continue;
    if (li.querySelector("li") !== null) continue; // deepest li only
    els.push(li);
  }
  for (const block of eachTextBlock(section)) {
    if (block.el.matches(HEADING_SEL)) continue;
    if (block.el.closest("li") !== null) continue; // covered by the li itself
    if (!ownedBy(block.el)) continue;
    els.push(block.el);
  }
  // Restore document order (Node.DOCUMENT_POSITION_FOLLOWING = 4).
  els.sort(
    (a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1) as -1 | 1,
  );
  const out: { el: Element; text: string }[] = [];
  for (const el of els) {
    const text = textOf(el);
    if (text !== "") out.push({ el, text });
  }
  return out;
}

/**
 * Text-block elements that sit under a subheading inside a container: finds
 * the first heading matching `re`, then walks its following siblings until the
 * next heading, collecting li / paragraph-ish blocks.
 */
export function itemsUnderHeading(
  container: ParentNode,
  re: RegExp,
): Element[] {
  for (const h of container.querySelectorAll(HEADING_SEL)) {
    re.lastIndex = 0;
    if (!re.test(textOf(h))) continue;
    const out: Element[] = [];
    let sib = h.nextElementSibling;
    while (sib !== null && !sib.matches(HEADING_SEL)) {
      if (sib.matches("ul,ol")) {
        out.push(...sib.querySelectorAll("li"));
      } else if (sib.matches(TEXT_BLOCK_SEL)) {
        out.push(sib);
      } else {
        out.push(...sib.querySelectorAll(TEXT_BLOCK_SEL));
      }
      sib = sib.nextElementSibling;
    }
    return out.filter((el) => textOf(el) !== "");
  }
  return [];
}
