// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  collectKnownIssues,
  dedupeRows,
  domKiDriver,
  pageSignature,
  type KiDriver,
} from "../lib/dom/knownIssues";
import type { DomTarget } from "../lib/dom/targets";
import { assertRecordsWellFormed, loadDoc, PAGE_URL } from "./helpers/dom";

// ---------------------------------------------------------------------------
// §13 Known Issues collection. Fixture dialogs carry semantic markup only;
// page behaviors (open/close/paginate) are wired in the tests to simulate the
// site's own JavaScript — fixtures intentionally ship no runnable scripts.
// ---------------------------------------------------------------------------

function makeTarget(over: Partial<DomTarget> = {}): DomTarget {
  return {
    domKey: "target:api-acme-example",
    groupDomKey: "group:web-applications",
    inScope: true,
    location: "api.acme.example",
    name: "Acme API",
    category: "API",
    tags: [],
    docLinks: [],
    changeFlags: [],
    displayedKnownIssuesCount: 3,
    kiControlLabel: "View known issues",
    ...over,
  };
}

function spyDriver(over: Partial<KiDriver> = {}) {
  const dialog = document.createElement("div");
  return {
    open: vi.fn(async (): Promise<Element | null> => dialog),
    waitReady: vi.fn(async (): Promise<boolean> => true),
    currentPage: vi.fn(() => ({
      columns: ["A", "B"],
      rows: [["1", "2"]],
    })),
    advance: vi.fn(async (): Promise<"next" | "end" | "stuck"> => "end"),
    close: vi.fn(async (): Promise<void> => {}),
    ...over,
  };
}

function kiDialog(doc: Document): Element {
  const dialog = doc.querySelector("[role='dialog']");
  expect(dialog).not.toBeNull();
  return dialog!;
}

function buttonByLabel(root: ParentNode, re: RegExp): Element {
  const btn = [...root.querySelectorAll("button,a,[role='button']")].find(
    (b) =>
      re.test(b.getAttribute("aria-label") ?? "") ||
      re.test(b.textContent ?? ""),
  );
  expect(btn).toBeDefined();
  return btn!;
}

/**
 * Simulates the page's own scripts: clicking the KI control reveals the
 * dialog, the close button hides it, and (optionally) the pagination control
 * is wired by the caller.
 */
function wireDialog(
  doc: Document,
  onNext?: (nextBtn: Element, clickCount: number) => void,
): { dialog: Element; openBtn: Element; closeBtn: Element } {
  const dialog = kiDialog(doc);
  const openBtn = buttonByLabel(doc, /view known issues/i);
  const closeBtn = buttonByLabel(dialog, /close/i);
  openBtn.addEventListener("click", () => dialog.removeAttribute("hidden"));
  closeBtn.addEventListener("click", () =>
    dialog.setAttribute("hidden", ""),
  );
  if (onNext !== undefined) {
    const nextBtn = buttonByLabel(dialog, /next/i);
    let clicks = 0;
    nextBtn.addEventListener("click", () => {
      clicks++;
      onNext(nextBtn, clicks);
    });
  }
  return { dialog, openBtn, closeBtn };
}

function swapRows(doc: Document, rows: string[][]): void {
  const tbody = doc.querySelector("[role='dialog'] tbody");
  expect(tbody).not.toBeNull();
  tbody!.replaceChildren(
    ...rows.map((cells) => {
      const tr = doc.createElement("tr");
      for (const text of cells) {
        const td = doc.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      return tr;
    }),
  );
}

describe("pageSignature", () => {
  it("is canonicalJson of {columns, rows} and is stable", () => {
    const a = pageSignature(["P", "V"], [["1", "x"]]);
    const b = pageSignature(["P", "V"], [["1", "x"]]);
    const c = pageSignature(["P", "V"], [["1", "y"]]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe('{"columns":["P","V"],"rows":[["1","x"]]}');
  });
});

describe("dedupeRows", () => {
  it("drops exact duplicates and preserves first-seen order", () => {
    const out = dedupeRows([
      ["a", "1"],
      ["b", "2"],
      ["a", "1"],
      ["c", "3"],
      ["b", "2"],
    ]);
    expect(out).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
  });

  it("keeps order-sensitive near-duplicates distinct", () => {
    const out = dedupeRows([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("collectKnownIssues (§13)", () => {
  it("skips without opening when displayed count is exactly 0", async () => {
    const driver = spyDriver();
    const res = await collectKnownIssues(
      driver,
      loadDoc("ki-zero.html"),
      makeTarget({ displayedKnownIssuesCount: 0 }),
      PAGE_URL,
    );
    expect(res.skipped).toBe(true);
    expect(res.collectedCount).toBe(0);
    expect(res.countMatches).toBe(true);
    expect(res.rows).toEqual([]);
    expect(driver.open).not.toHaveBeenCalled();
  });

  it("skips cleanly when the brief exposes no Known Issues at all", async () => {
    // Some briefs render targets as plain list items with no count badge and
    // no control. Nothing was hidden from us, so there is nothing to warn
    // about - treating it as a failed dialog made every target a fake gap.
    const driver = spyDriver();
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: null, kiControlLabel: null }),
      PAGE_URL,
    );
    expect(driver.open).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
    expect(res.collectedCount).toBe(0);
    expect(res.countMatches).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("does not skip when the count is merely absent (null)", async () => {
    const driver = spyDriver();
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: null }),
      PAGE_URL,
    );
    expect(res.skipped).toBe(false);
    expect(driver.open).toHaveBeenCalledTimes(1);
    // null displayedCount → countMatches true with a recorded warning.
    expect(res.countMatches).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/displayed|unknown|unavailable/i);
  });

  it("collects a single page: columns, 3 rows, count match, records", async () => {
    const doc = loadDoc("ki-one.html");
    wireDialog(doc);
    const target = makeTarget({ displayedKnownIssuesCount: 3 });
    const res = await collectKnownIssues(domKiDriver, doc, target, PAGE_URL);
    expect(res.skipped).toBe(false);
    expect(res.columns).toEqual(["Priority", "Variant", "Count"]);
    expect(res.collectedCount).toBe(3);
    expect(res.countMatches).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.rows.map((r) => r.cells)).toEqual([
      ["P1", "SQL Injection", "4"],
      ["P2", "Broken Access Control", "7"],
      ["P3", "Cross-site Scripting", "12"],
    ]);
    // Explicit column labels map to recognized fields (spec §13).
    expect(res.rows[0]!.recognized).toEqual({
      priority: "P1",
      variant: "SQL Injection",
      total_count: "4",
    });
    assertRecordsWellFormed(res.records);
    expect(res.records).toHaveLength(3);
    for (const [i, rec] of res.records.entries()) {
      expect(rec.sourceKey).toBe(`dom:ki:${target.domKey}`);
      expect(rec.sourceLevel).toBe("known_issue_note");
      expect(rec.locator.targetId).toBe(target.domKey);
      expect(rec.locator.rowIndex).toBe(i);
    }
    // Driver closed the dialog afterwards.
    expect(kiDialog(doc).hasAttribute("hidden")).toBe(true);
  });

  it("aggregates pages, dedupes repeats in order, and stops on a repeated signature", async () => {
    const doc = loadDoc("ki-multi.html");
    // Scripted pagination: click 1 → page 2 (one repeated row + one new);
    // click 2 → back to page-1 content (repeated signature must stop the
    // loop); click 3 → a brand-new row that must never be collected.
    const pages: string[][][] = [
      [
        ["P2", "Broken Access Control", "7"],
        ["P4", "Cross-site Request Forgery", "2"],
      ],
      [
        ["P1", "SQL Injection", "4"],
        ["P2", "Broken Access Control", "7"],
      ],
      [["P5", "Information Disclosure", "1"]],
    ];
    wireDialog(doc, (_btn, clicks) => swapRows(doc, pages[clicks - 1]!));
    const res = await collectKnownIssues(
      domKiDriver,
      doc,
      makeTarget({ displayedKnownIssuesCount: 3 }),
      PAGE_URL,
    );
    expect(res.countMatches).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.rows.map((r) => r.cells)).toEqual([
      ["P1", "SQL Injection", "4"],
      ["P2", "Broken Access Control", "7"],
      ["P4", "Cross-site Request Forgery", "2"],
    ]);
    // Repeated-signature stop happened before the third scripted page.
    expect(res.rows.flat().join(" ")).not.toContain("Information Disclosure");
    expect(kiDialog(doc).hasAttribute("hidden")).toBe(true);
  });

  it("records a count mismatch warning when fewer rows render than displayed", async () => {
    const doc = loadDoc("ki-mismatch.html");
    wireDialog(doc);
    const res = await collectKnownIssues(
      domKiDriver,
      doc,
      makeTarget({ displayedKnownIssuesCount: 5, location: "vpn.acme.example" }),
      PAGE_URL,
    );
    expect(res.collectedCount).toBe(2);
    expect(res.countMatches).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/mismatch/i);
  });

  it("maps recognized fields only when explicit column labels match", async () => {
    const driver = spyDriver({
      currentPage: vi.fn(() => ({
        columns: ["Foo", "Bar"],
        rows: [["x", "y"]],
      })),
    });
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: 1 }),
      PAGE_URL,
    );
    expect(res.rows[0]!.cells).toEqual(["x", "y"]);
    expect(res.rows[0]!.recognized).toBeUndefined();
  });

  it("always closes the dialog even when advance throws", async () => {
    const driver = spyDriver({
      advance: vi.fn(async (): Promise<"next"> => {
        throw new Error("pagination blew up");
      }),
    });
    await expect(
      collectKnownIssues(driver, document, makeTarget(), PAGE_URL),
    ).rejects.toThrow("pagination blew up");
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("stops with a warning when advance reports stuck", async () => {
    const driver = spyDriver({
      advance: vi.fn(async (): Promise<"stuck"> => "stuck"),
    });
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: 2 }),
      PAGE_URL,
    );
    expect(res.collectedCount).toBe(1);
    expect(res.warnings.join(" ")).toMatch(/stuck/i);
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("warns and still captures when the dialog never reaches ready state", async () => {
    const driver = spyDriver({
      waitReady: vi.fn(async (): Promise<boolean> => false),
    });
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: 1 }),
      PAGE_URL,
    );
    expect(res.collectedCount).toBe(1);
    expect(res.warnings.join(" ")).toMatch(/ready/i);
  });

  it("warns and compares counts when the dialog cannot be opened", async () => {
    const driver = spyDriver({
      open: vi.fn(async (): Promise<Element | null> => null),
    });
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: 3 }),
      PAGE_URL,
    );
    expect(res.collectedCount).toBe(0);
    expect(res.countMatches).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/open|dialog/i);
  });

  it("halts at the 50-page guard with a truncation warning", async () => {
    let n = 0;
    const driver = spyDriver({
      currentPage: vi.fn(() => ({ columns: ["A"], rows: [[`row-${n++}`]] })),
      advance: vi.fn(async (): Promise<"next"> => "next"),
    });
    const res = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: null }),
      PAGE_URL,
    );
    expect(res.collectedCount).toBe(50);
    expect(res.warnings.join(" ")).toMatch(/50|cap|limit|truncat/i);
    expect(driver.close).toHaveBeenCalledTimes(1);
  });
});

describe("collectKnownIssues aggregate category tables", () => {
  it("validates displayed issues against the sum of the Unique column", async () => {
    const rows = [
      ["Cross-Site Scripting (XSS)", "80", "215"],
      ["Unvalidated Redirects and Forwards", "11", "15"],
      ["Server Security Misconfiguration", "10", "15"],
      ["Server-Side Injection", "8", "25"],
      ["Cross-Site Request Forgery (CSRF)", "8", "10"],
      ["Broken Authentication and Session Management", "7", "22"],
      ["Other", "7", "12"],
      ["Broken Access Control (BAC)", "5", "6"],
      ["Sensitive Data Exposure", "0", "6"],
      ["Application-Level Denial-of-Service (DoS)", "0", "1"],
    ];
    const dialog = document.createElement("div");
    const driver: KiDriver = {
      open: async () => dialog,
      waitReady: async () => true,
      currentPage: () => ({
        columns: ["VRT Category", "Unique", "Total"],
        rows,
      }),
      advance: async () => "end",
      close: async () => undefined,
    };
    const result = await collectKnownIssues(
      driver,
      document,
      makeTarget({ displayedKnownIssuesCount: 136 }),
      PAGE_URL,
    );
    expect(result.rows).toHaveLength(10);
    expect(result.collectedCount).toBe(136);
    expect(result.countMatches).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
