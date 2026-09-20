import { canonicalJson } from "../canonical";
import type {
  ExtractionStatus,
  SourceLevel,
  SourceLocator,
  SourceRecord,
} from "../types";
import {
  chainHidden,
  nearestLabeled,
  tableToRows,
  textOf,
} from "./domUtils";
import type { DomTarget } from "./targets";

// ---------------------------------------------------------------------------
// Known Issues collection (spec §13). The collector drives a dialog/drawer
// through the KiDriver interface so tests can substitute a spy driver; the
// live-DOM implementation (domKiDriver) sits below the collector.
// ---------------------------------------------------------------------------

export interface KiRow {
  cells: string[];
  /** Present only when explicit column labels map to recognized fields. */
  recognized?: Record<string, string>;
}

export interface KiResult {
  targetDomKey: string;
  displayedCount: number | null;
  collectedCount: number;
  columns: string[];
  rows: KiRow[];
  /**
   * True when no dialog was opened: displayedCount === 0, the feature was
   * not exposed at all, or it was advertised but yielded no usable control.
   */
  skipped: boolean;
  /**
   * The brief advertised Known Issues for this target — a count badge, a
   * control, or a Known Issues column on its table. When false the feature
   * is genuinely absent and a null displayedCount is not a gap.
   */
  advertised: boolean;
  countMatches: boolean;
  warnings: string[];
  /** level "known_issue_note"; sourceKey "dom:ki:<targetDomKey>". */
  records: SourceRecord[];
}

export interface KiDriver {
  /** Click/activate the KI control → dialog/drawer element, or null. */
  open(doc: Document, target: DomTarget): Promise<Element | null>;
  /** Semantic ready: table/list role present or an explicit empty state. */
  waitReady(dialog: Element, timeoutMs: number): Promise<boolean>;
  currentPage(dialog: Element): { columns: string[]; rows: string[][] };
  /**
   * Enabled pagination/load-more → "next"; disabled/end → "end"; the control
   * was enabled but produced no observable progress → "stuck".
   */
  advance(dialog: Element): Promise<"next" | "end" | "stuck">;
  close(dialog: Element): Promise<void>;
}

const WAIT_READY_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 2_000;
const ADVANCE_VERIFY_MS = 1_500;
const READY_POLL_MS = 100;
const DOM_POLL_MS = 50;
const MAX_KI_PAGES = 50;

const DIALOG_SEL =
  "[role='dialog'],dialog,[aria-modal='true'],[role='alertdialog']";
const CONTROL_SEL = "button,a,[role='button'],[role='link'],summary";
const TABLEISH_SEL =
  "table,[role='table'],[role='grid'],[role='list'],ul,ol";
const EMPTY_STATE_SEL =
  "[role='status'],[role='note'],[role='alert'],[data-empty-state]";
const KI_NAME_RE = /known issues?/i;
const NEXT_NAME_RE = /\bnext\b|next page|load more|show more|more results|older|›|»/i;
const CLOSE_NAME_RE = /\bclose\b|\bdismiss\b|^[×✕✖]$/i;
const EMPTY_TEXT_RE =
  /no known issues|no results|nothing (?:to show|here)|none (?:found|yet)|empty/i;

/** Explicit column label → recognized field (spec §13 list). First match wins. */
const RECOGNIZED_RES: { key: string; re: RegExp }[] = [
  { key: "vrt_category", re: /\bvrt\b|categor/i },
  { key: "variant", re: /variant/i },
  { key: "priority", re: /priorit|severity|^p[1-5]$/i },
  { key: "unique_count", re: /unique/i },
  { key: "total_count", re: /total|\bcount\b|\breports?\b|submissions|^#$/i },
  { key: "target", re: /^targets?\b|asset|location|\bhost\b|\burl\b/i },
  { key: "status", re: /\bstatus\b|\bstate\b|resolution/i },
  { key: "notes", re: /\bnotes?\b|comment|descript|detail|summary/i },
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

/** canonicalJson({columns, rows}) — §13 step 5 page signature. */
export function pageSignature(columns: string[], rows: string[][]): string {
  return canonicalJson({ columns, rows });
}

/** Exact-match row dedupe preserving first-seen order (§13 step 8). */
export function dedupeRows(rows: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const row of rows) {
    const key = canonicalJson(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Column label → field index map; first matching label claims each field. */
function recognizedFieldMap(columns: string[]): Map<number, string> {
  const map = new Map<number, string>();
  const used = new Set<string>();
  columns.forEach((label, i) => {
    for (const { key, re } of RECOGNIZED_RES) {
      re.lastIndex = 0;
      if (!re.test(label) || used.has(key)) continue;
      used.add(key);
      map.set(i, key);
      break;
    }
  });
  return map;
}

/**
 * Issues represented by a page of rows. A Known Issues table is usually one row
 * per issue, but the brief also serves an aggregate view — one row per VRT
 * category with a "Unique" count — where the target's displayed badge counts
 * unique issues, not categories. Summing that column is then the only honest
 * basis for the §13 count comparison. Null when the table is not an aggregate
 * or any cell in the column is not a whole number.
 */
function aggregateUniqueCount(
  fieldMap: Map<number, string>,
  rows: string[][],
): number | null {
  let index: number | null = null;
  for (const [i, key] of fieldMap) {
    if (key === "unique_count") index = i;
  }
  if (index === null || rows.length === 0) return null;
  let total = 0;
  for (const cells of rows) {
    const cell = (cells[index] ?? "").replace(/[\s,]/g, "");
    if (!/^\d+$/.test(cell)) return null;
    total += Number(cell);
  }
  return total;
}

function recognizedFor(
  fieldMap: Map<number, string>,
  cells: string[],
): Record<string, string> | undefined {
  if (fieldMap.size === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [i, key] of fieldMap) out[key] = cells[i] ?? "";
  return out;
}

/**
 * Spec §13 verbatim: record displayed count → skip iff exactly 0 → open →
 * waitReady(5s) → capture columns+rows → signature → advance until end/stuck
 * or a repeated signature (≤50 pages) → dedupe preserving order → close in
 * finally → compare counts (null displayedCount → countMatches true + a
 * warning). Driver errors propagate; close still runs.
 */
export async function collectKnownIssues(
  driver: KiDriver,
  doc: Document,
  target: DomTarget,
  pageUrl: string,
): Promise<KiResult> {
  // Every warning names the target it belongs to: a bare
  // "ki_dialog_not_opened" in a 19-target export says nothing actionable.
  const warnings: string[] = [];
  const records: SourceRecord[] = [];
  const displayedCount =
    typeof target.displayedKnownIssuesCount === "number"
      ? target.displayedKnownIssuesCount
      : null;
  let columns: string[] = [];
  let skipped = false;
  const allRows: string[][] = [];
  const rowPages: number[] = [];

  // Nothing exposed, nothing to collect: a brief that renders its targets as
  // plain list items carries neither a count badge nor a control nor a Known
  // Issues column. That is an absent feature, not a target we failed to open,
  // so it raises no warning and leaves the count validation intact (spec §13
  // skips only what the page itself reports as empty or does not offer).
  const hasControl =
    target.kiControlLabel !== null &&
    target.kiControlLabel !== undefined &&
    target.kiControlLabel !== "";
  const advertised =
    displayedCount !== null || hasControl || target.kiAdvertised === true;
  const kiNotExposed = !advertised;
  if (displayedCount === 0 || kiNotExposed) {
    skipped = true;
  } else if (displayedCount === null && !hasControl) {
    // The column exists but yields neither a count nor a reliable control.
    // Driving a dialog by name fallback would risk opening an unrelated
    // control, so the target records its verification gap instead: the
    // warning marks the count unverified and the integrity check fails it.
    skipped = true;
    warnings.push(`ki_dialog_not_opened:${target.domKey}`);
  } else {
    let dialog: Element | null = null;
    try {
      dialog = await driver.open(doc, target);
      if (dialog === null) {
        warnings.push(`ki_dialog_not_opened:${target.domKey}`);
      } else {
        const ready = await driver.waitReady(dialog, WAIT_READY_TIMEOUT_MS);
        if (!ready) warnings.push(`ki_dialog_not_ready:${target.domKey}`);
        const seenSignatures = new Set<string>();
        let pages = 0;
        for (;;) {
          if (pages >= MAX_KI_PAGES) {
            warnings.push(`ki_page_cap_50:${target.domKey}`);
            break;
          }
          const page = driver.currentPage(dialog);
          const sig = pageSignature(page.columns, page.rows);
          if (seenSignatures.has(sig)) break; // repeated signature → stop
          seenSignatures.add(sig);
          if (columns.length === 0 && page.columns.length > 0) {
            columns = page.columns;
          }
          for (const row of page.rows) {
            allRows.push(row);
            rowPages.push(pages);
          }
          pages++;
          const step = await driver.advance(dialog);
          if (step === "end") break;
          if (step === "stuck") {
            warnings.push(`ki_pagination_stuck:${target.domKey}`);
            break;
          }
        }
      }
    } finally {
      if (dialog !== null) {
        try {
          await driver.close(dialog);
        } catch {
          warnings.push(`ki_close_failed:${target.domKey}`);
        }
      }
    }
  }

  const deduped = dedupeRows(allRows);
  const firstSeenIndex = new Map<string, number>();
  allRows.forEach((row, i) => {
    const key = canonicalJson(row);
    if (!firstSeenIndex.has(key)) firstSeenIndex.set(key, i);
  });
  const fieldMap = recognizedFieldMap(columns);
  const rows: KiRow[] = deduped.map((cells) => {
    const recognized = recognizedFor(fieldMap, cells);
    return recognized === undefined ? { cells } : { cells, recognized };
  });
  deduped.forEach((cells, rowIndex) => {
    const firstIdx = firstSeenIndex.get(canonicalJson(cells)) ?? 0;
    records.push(
      record(
        `dom:ki:${target.domKey}`,
        "known_issue_note",
        pageUrl,
        {
          section: "Known Issues",
          targetId: target.domKey,
          table: "known_issues",
          pageIndex: rowPages[firstIdx] ?? 0,
          rowIndex,
        },
        cells.join(" "),
        { columns, cells, recognized: recognizedFor(fieldMap, cells) ?? null },
      ),
    );
  });

  const collectedCount =
    aggregateUniqueCount(fieldMap, deduped) ?? deduped.length;
  let countMatches: boolean;
  if (displayedCount === null) {
    // Count comparison impossible. When the page offered a control we still
    // record the gap; when it offered nothing there is no gap to record.
    countMatches = true;
    if (!kiNotExposed) {
      warnings.push(`ki_displayed_count_unavailable:${target.domKey}`);
    }
  } else {
    countMatches = collectedCount === displayedCount;
    if (!countMatches) {
      warnings.push(
        `ki_count_mismatch:${target.domKey}:displayed=${displayedCount},collected=${collectedCount}`,
      );
    }
  }

  return {
    targetDomKey: target.domKey,
    displayedCount,
    collectedCount,
    columns,
    rows,
    skipped,
    advertised,
    countMatches,
    warnings,
    records,
  };
}

// ---------------------------------------------------------------------------
// Live-DOM driver. Extraction relies on roles, accessible names, and stable
// attributes — never generated CSS classes (spec §7.4).
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil<T>(
  check: () => T | null,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

function clickElement(el: Element): void {
  const html = el as HTMLElement;
  if (typeof html.click === "function") {
    html.click();
    return;
  }
  const win = el.ownerDocument.defaultView;
  if (win !== null) {
    el.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  }
}

function dispatchEscape(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (win === null) return;
  el.dispatchEvent(
    new win.KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function isOpenNativeDialog(el: Element): boolean {
  return (
    el.tagName === "DIALOG" &&
    typeof (el as HTMLDialogElement).close === "function" &&
    (el as HTMLDialogElement).open === true
  );
}

function controlName(el: Element): string {
  return nearestLabeled(el) ?? textOf(el);
}

/** First control inside root whose accessible name matches `re`. */
function controlByName(root: ParentNode, re: RegExp): Element | null {
  for (const el of root.querySelectorAll(CONTROL_SEL)) {
    re.lastIndex = 0;
    if (re.test(controlName(el))) return el;
  }
  return null;
}

function controlDisabled(el: Element): boolean {
  if (el.hasAttribute("disabled")) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.closest("[aria-disabled='true']") !== null) return true;
  // An anchor without href is inert — the end of link-based pagination.
  if (el.tagName === "A" && !el.hasAttribute("href")) return true;
  return false;
}

/**
 * The KI control for this target: matched by the recorded accessible name
 * (target.kiControlLabel), then by a "known issues" name fallback. Several
 * targets share identical control labels, so ties break toward the control
 * whose row/group context mentions the target location or name.
 */
function findKiControl(doc: Document, target: DomTarget): Element | null {
  const controls = [...doc.querySelectorAll(CONTROL_SEL)];
  const wanted = (target.kiControlLabel ?? "").trim().toLowerCase();
  const nameOf = (el: Element) => controlName(el).toLowerCase();

  let matches =
    wanted === ""
      ? []
      : controls.filter((el) => nameOf(el) === wanted);
  if (matches.length === 0 && wanted !== "") {
    matches = controls.filter((el) => {
      const n = nameOf(el);
      return n !== "" && (n.includes(wanted) || wanted.includes(n));
    });
  }
  if (matches.length === 0) {
    matches = controls.filter((el) => KI_NAME_RE.test(nameOf(el)));
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  const hints = [target.location, target.name]
    .filter((h): h is string => typeof h === "string" && h.trim() !== "")
    .map((h) => h.toLowerCase());
  for (const el of matches) {
    const ctx = textOf(
      el.closest("tr,[role='row'],li,article") ?? el.parentElement ?? el,
    ).toLowerCase();
    if (hints.some((h) => ctx.includes(h))) return el;
  }
  return matches[0]!;
}

/** Topmost (last) visible dialog/drawer in the document, or null. */
function findOpenDialog(doc: Document): Element | null {
  const dialogs = [...doc.querySelectorAll(DIALOG_SEL)].filter((el) => {
    if (el.tagName === "DIALOG") {
      return (
        (el as HTMLDialogElement).open === true || el.hasAttribute("open")
      );
    }
    return !chainHidden(el);
  });
  return dialogs.length === 0 ? null : dialogs[dialogs.length - 1]!;
}

function isReady(dialog: Element): boolean {
  if (dialog.querySelector(TABLEISH_SEL) !== null) return true;
  for (const el of dialog.querySelectorAll(EMPTY_STATE_SEL)) {
    EMPTY_TEXT_RE.lastIndex = 0;
    if (EMPTY_TEXT_RE.test(textOf(el))) return true;
  }
  return false;
}

/** Rows of a role=table/grid widget (header cells → columns). */
function roleGridToRows(grid: Element): {
  columns: string[];
  rows: string[][];
} {
  const CELL_SEL =
    "[role='columnheader'],[role='rowheader'],[role='cell'],[role='gridcell'],th,td";
  const rowEls = [...grid.querySelectorAll("[role='row'],tr")];
  const headIdx = rowEls.findIndex(
    (r) => r.querySelector("[role='columnheader'],th") !== null,
  );
  const cellTexts = (r: Element) =>
    [...r.querySelectorAll(CELL_SEL)].map((c) => textOf(c));
  const columns = headIdx >= 0 ? cellTexts(rowEls[headIdx]!) : [];
  const rows = rowEls
    .filter((_r, i) => i !== headIdx)
    .map(cellTexts)
    .filter((cells) => cells.some((c) => c !== ""));
  return { columns, rows };
}

/**
 * Closes an exporter-opened element: close control when present, native
 * dialog semantics for open <dialog>, otherwise an Escape keydown. Shared by
 * domKiDriver.close and the orchestrator's restore path.
 */
export async function closeElement(el: Element): Promise<void> {
  const closeBtn = controlByName(el, CLOSE_NAME_RE);
  if (closeBtn !== null) clickElement(closeBtn);
  if (isOpenNativeDialog(el)) {
    try {
      (el as HTMLDialogElement).close();
    } catch {
      // best effort
    }
  } else if (closeBtn === null) {
    dispatchEscape(el);
  }
}

export const domKiDriver: KiDriver = {
  async open(doc: Document, target: DomTarget): Promise<Element | null> {
    const control = findKiControl(doc, target);
    if (control === null) return null;
    clickElement(control);
    return pollUntil(() => findOpenDialog(doc), OPEN_TIMEOUT_MS, DOM_POLL_MS);
  },

  async waitReady(dialog: Element, timeoutMs: number): Promise<boolean> {
    const ready = await pollUntil(
      () => (isReady(dialog) ? true : null),
      timeoutMs,
      READY_POLL_MS,
    );
    return ready === true;
  },

  currentPage(dialog: Element): { columns: string[]; rows: string[][] } {
    const table = dialog.querySelector("table");
    if (table !== null) {
      const { headers, rows } = tableToRows(table);
      return { columns: headers, rows: rows.filter((r) => r.some((c) => c !== "")) };
    }
    const grid = dialog.querySelector("[role='table'],[role='grid']");
    if (grid !== null) return roleGridToRows(grid);
    const list = dialog.querySelector("[role='list'],ul,ol");
    if (list !== null) {
      const rows = [...list.querySelectorAll("li,[role='listitem']")]
        .map((li) => [textOf(li)])
        .filter((r) => r[0] !== "");
      return { columns: [], rows };
    }
    return { columns: [], rows: [] };
  },

  async advance(dialog: Element): Promise<"next" | "end" | "stuck"> {
    const relNext = dialog.querySelector("[rel~='next']");
    const control = relNext ?? controlByName(dialog, NEXT_NAME_RE);
    if (control === null || controlDisabled(control)) return "end";
    const before = textOf(dialog);
    clickElement(control);
    const changed = await pollUntil(
      () => (textOf(dialog) !== before ? true : null),
      ADVANCE_VERIFY_MS,
      DOM_POLL_MS,
    );
    return changed === true ? "next" : "stuck";
  },

  async close(dialog: Element): Promise<void> {
    await closeElement(dialog);
  },
};
