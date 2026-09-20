// @vitest-environment jsdom
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { collectDetails } from "../lib/dom/details";
import {
  eachTextBlock,
  findSection,
  nearestLabeled,
  tableToRows,
  textOf,
} from "../lib/dom/domUtils";
import { assertRecordsWellFormed, loadDoc, PAGE_URL } from "./helpers/dom";

describe("domUtils", () => {
  const doc = new JSDOM(`<main>
    <section aria-labelledby="h"><h2 id="h">Scope</h2>
      <p>Visible <span hidden>secret</span> text</p>
      <table><thead><tr><th>A</th><th>B</th></tr></thead>
      <tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>
      <fieldset><legend>Creds</legend><input id="i1"></fieldset>
      <label>Wrap<input id="i2"></label>
      <input id="i3" aria-label="aria name">
    </section></main>`).window.document;

  it("textOf normalizes and skips hidden markup", () => {
    expect(textOf(doc.querySelector("p"))).toBe("Visible text");
    expect(textOf(null)).toBe("");
    expect(textOf(undefined)).toBe("");
  });

  it("findSection locates a section by heading text", () => {
    const sec = findSection(doc, /scope/i);
    expect(sec?.tagName).toBe("SECTION");
    expect(findSection(doc, /nonexistent/)).toBeNull();
  });

  it("tableToRows returns headers and body rows", () => {
    const t = tableToRows(doc.querySelector("table")!);
    expect(t.headers).toEqual(["A", "B"]);
    expect(t.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("eachTextBlock yields deepest non-empty blocks", () => {
    const texts = [...eachTextBlock(doc)].map((b) => b.text);
    expect(texts).toContain("Scope");
    expect(texts).toContain("Visible text");
  });

  it("nearestLabeled resolves legend, wrapping label, and aria-label", () => {
    expect(nearestLabeled(doc.querySelector("#i1")!)).toBe("Creds");
    expect(nearestLabeled(doc.querySelector("#i2")!)).toBe("Wrap");
    expect(nearestLabeled(doc.querySelector("#i3")!)).toBe("aria name");
  });
});

describe("collectDetails", () => {
  const { records, data } = collectDetails(loadDoc("details.html"), PAGE_URL);

  it("extracts every spec §4.1 field", () => {
    expect(data.name).toBe("Acme Corp Bug Bounty");
    expect(data.code).toBe("acme-bb");
    expect(data.engagementType).toBe("Bug Bounty");
    expect(data.managedBounty).toBe(true);
    expect(data.lifecycleStatus).toBe("Running");
    expect(data.testingStart).toBe("2026-08-01");
    expect(data.testingEnd).toBe("Ongoing");
    expect(data.testingPeriodLabel).toBe("Ongoing");
    expect(data.lastStatusTransition).toBe("2026-08-15T04:22:00Z");
    expect(data.lastBriefUpdate).toBe("2026-09-10");
    expect(data.safeHarborLevel).toBe("Full Safe Harbor");
    expect(data.disclosurePolicy).toContain("coordinated vulnerability disclosure");
  });

  it("extracts statistics with their time windows; absent window stays null", () => {
    expect(data.statistics["vulnerabilities-rewarded"]).toEqual({
      value: "312",
      window: "in the last 90 days",
    });
    expect(data.statistics["average-payout"]).toEqual({
      value: "$1,240",
      window: "in the last 90 days",
    });
    expect(data.statistics["participants"]).toEqual({
      value: "1,024",
      window: null,
    });
  });

  it("emits well-formed records under dom:details with honest levels", () => {
    assertRecordsWellFormed(records);
    for (const r of records) expect(r.sourceKey.startsWith("dom:details:")).toBe(true);
    const name = records.find((r) => r.sourceKey === "dom:details:name");
    expect(name?.sourceLevel).toBe("page_header");
    const harbor = records.find((r) => r.sourceKey === "dom:details:safe-harbor");
    expect(harbor?.sourceLevel).toBe("explicit_program_rule");
    const stat = records.find(
      (r) => r.sourceKey === "dom:details:statistics:average-payout",
    );
    expect(stat?.sourceLevel).toBe("page_header");
    expect(stat?.quote).toContain("$1,240");
  });

  it("returns explicit nulls and no records for absent fields", () => {
    const bare = new JSDOM("<main><h1>Lonely Program</h1></main>").window.document;
    const res = collectDetails(bare, PAGE_URL);
    expect(res.data.name).toBe("Lonely Program");
    expect(res.data.code).toBeNull();
    expect(res.data.managedBounty).toBeNull();
    expect(res.data.lifecycleStatus).toBeNull();
    expect(res.data.safeHarborLevel).toBeNull();
    expect(res.data.disclosurePolicy).toBeNull();
    expect(res.data.statistics).toEqual({});
    expect(res.records.every((r) => r.sourceKey === "dom:details:name")).toBe(true);
  });
});

describe("collectDetails current Bugcrowd header cards", () => {
  const current = collectDetails(loadDoc("webdotcom-current.html"), PAGE_URL);

  it("uses the engagement heading instead of the browser title", () => {
    expect(current.data.name).toBe("Web.com Bug Bounty");
  });

  it("extracts DOM metadata and statistics without API enrichment", () => {
    expect(current.data.engagementType).toBe("Bug Bounty");
    expect(current.data.lifecycleStatus).toBe("In progress");
    expect(current.data.testingPeriodLabel).toBe("Ongoing");
    expect(current.data.lastBriefUpdate).toBe("2026-09-11T15:03:27Z");
    expect(current.data.statistics["vulnerabilities-rewarded"]?.value).toBe("721");
    expect(current.data.statistics["average-payout"]).toEqual({
      value: "$2,000",
      window: "last 3 months",
    });
  });

  it("does not invent a Safe Harbor level from unrelated section text", () => {
    expect(current.data.safeHarborLevel).toBeNull();
  });
});
