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
const TEXT_BLOCK_SEL =
  "p,li,dt,dd,blockquote,figcaption,summary,pre,td,th," +
  "h1,h2,h3,h4,h5,h6,[role='paragraph']";

function isHiddenMarkup(el: Element): boolean {
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
    if (valueEl === null) continue;
    const value = textOf(valueEl);
    const small = li.querySelector("small");
    const win =
      small !== null ? textOf(small) : (WINDOW_RE.exec(textOf(li))?.[0] ?? null);
    const label = textExcluding(li, "strong,b,small,time");
    if (label === "" || value === "") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value, window: win === "" ? null : win });
  }
  return out;
}

/**
 * Items of a section: direct li children (deepest only) when the section uses
 * lists, else its text blocks minus headings. Blocks inside nested sections
 * stay with the nested section.
 */
export function sectionItems(
  section: Element,
): { el: Element; text: string }[] {
  const lis = [...section.querySelectorAll("li")].filter(
    (li) =>
      li.closest(SECTION_SEL) === section && li.querySelector("li") === null,
  );
  if (lis.length > 0) {
    return lis
      .map((li) => ({ el: li, text: textOf(li) }))
      .filter((i) => i.text !== "");
  }
  const out: { el: Element; text: string }[] = [];
  for (const block of eachTextBlock(section)) {
    if (block.el.matches(HEADING_SEL)) continue;
    if (block.el.closest(SECTION_SEL) !== section) continue;
    out.push(block);
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
