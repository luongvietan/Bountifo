// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectPolicies } from "../lib/dom/policies";
import { assertRecordsWellFormed, loadDoc, PAGE_URL } from "./helpers/dom";

const { records, data } = collectPolicies(loadDoc("policies.html"), PAGE_URL);

const ALL_TECHNIQUES = [
  "automation",
  "scanning",
  "brute force",
  "denial of service",
  "social engineering",
  "physical testing",
  "credential testing",
  "multi-account",
  "cross-tenant",
  "third-party",
  "PII access",
  "data exfiltration",
  "persistent access",
];

describe("collectPolicies statements", () => {
  it("collects safe harbor and authorization statements", () => {
    expect(data.safeHarborStatements).toHaveLength(2);
    expect(data.safeHarborStatements[0]).toContain("legal action");
    expect(data.authorizationStatements[0]).toContain("authorize testing");
  });
});

describe("collectPolicies techniques", () => {
  it("covers all spec §4.3 technique names", () => {
    const names = new Set(data.techniques.map((t) => t.name));
    for (const name of ALL_TECHNIQUES) expect(names.has(name)).toBe(true);
  });

  it("only emits allowed/prohibited/conditional statuses", () => {
    for (const t of data.techniques) {
      expect(["allowed", "prohibited", "conditional"]).toContain(t.status);
    }
  });

  it("parses conditional rules and extracts their condition clauses", () => {
    const scanning = data.techniques.find(
      (t) => t.name === "scanning" && t.status === "conditional",
    );
    expect(scanning).toBeDefined();
    expect(scanning?.quote).toContain("permitted only against");
    expect(scanning?.conditions.join(" ")).toContain("explicitly listed targets");
    const cred = data.techniques.find(
      (t) => t.name === "credential testing" && t.status === "conditional",
    );
    expect(cred?.conditions.join(" ")).toContain("Acme-supplied test accounts");
  });

  it("parses allowed and prohibited rules", () => {
    expect(
      data.techniques.some((t) => t.name === "automation" && t.status === "allowed"),
    ).toBe(true);
    for (const name of [
      "brute force",
      "denial of service",
      "social engineering",
      "physical testing",
      "multi-account",
      "cross-tenant",
      "third-party",
      "PII access",
      "data exfiltration",
      "persistent access",
    ]) {
      expect(
        data.techniques.some((t) => t.name === name && t.status === "prohibited"),
      ).toBe(true);
    }
  });
});

describe("collectPolicies rule groups", () => {
  it("collects account, data, focus, non-focus, and reporting groups", () => {
    expect(data.accountRules).toHaveLength(3);
    expect(data.accountRules[0]).toContain("acme.example email domain");
    expect(data.dataRules).toHaveLength(3);
    expect(data.dataRules[1]).toContain("secrets");
    expect(data.focusAreas).toHaveLength(3);
    expect(data.focusAreas[1]).toContain("request forgery");
    expect(data.nonFocusAreas).toHaveLength(3);
    expect(data.nonFocusAreas[1]).toContain("Self-XSS");
    expect(data.reportingRequirements.length).toBeGreaterThanOrEqual(4);
    expect(
      data.reportingRequirements.some((r) =>
        r.includes("through the Bugcrowd platform"),
      ),
    ).toBe(true);
  });
});

describe("collectPolicies VRT", () => {
  it("extracts version, baseline, exclusions, deviations, target-specific, notes", () => {
    expect(data.vrt.version).toBe("1.10");
    expect(data.vrt.baseline).toContain("standard baseline");
    expect(data.vrt.exclusions[0]).toContain("Denial of service");
    expect(data.vrt.deviations[0]).toContain("SSRF");
    expect(data.vrt.targetSpecific[0]).toContain("api.acme.example");
    expect(data.vrt.notes[0]).toContain("reward ranges");
  });
});

describe("collectPolicies records", () => {
  it("emits well-formed records with honest extraction statuses", () => {
    assertRecordsWellFormed(records);
    const tech = records.filter((r) =>
      r.sourceKey.startsWith("dom:details:program-rules:"),
    );
    expect(tech.length).toBeGreaterThan(0);
    // A line naming several techniques is clause-attributed heuristically → partial.
    const multi = tech.filter((r) =>
      r.quote.includes("Automated scanning and brute force"),
    );
    expect(multi.length).toBe(3);
    expect(multi.every((r) => r.extractionStatus === "partial")).toBe(true);
    // A clean single-technique line is exact.
    const single = tech.find((r) => r.quote.startsWith("Denial of service"));
    expect(single?.extractionStatus).toBe("exact");
    expect(single?.sourceLevel).toBe("explicit_program_rule");
    // VRT deviations carry the vrt_deviation level.
    const dev = records.find((r) => r.quote.includes("SSRF is rated"));
    expect(dev?.sourceLevel).toBe("vrt_deviation");
  });
});
