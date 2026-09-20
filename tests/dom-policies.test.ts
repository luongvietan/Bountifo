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

  it("collects paragraph rule statements mixed with lists", () => {
    // A <p> rule alongside the <ul> was previously dropped whenever any li
    // existed in the section.
    const para = data.techniques.find(
      (t) =>
        t.name === "scanning" &&
        t.quote.startsWith("Scanning of out-of-scope"),
    );
    expect(para).toBeDefined();
    expect(para?.status).toBe("prohibited");
    const rec = records.find(
      (r) =>
        r.sourceKey.startsWith("dom:details:program-rules:") &&
        r.quote.startsWith("Scanning of out-of-scope"),
    );
    expect(rec?.extractionStatus).toBe("exact");
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
  it("collects items from an article-typed section", () => {
    // Account Requirements is authored as <article> — sectionItems must treat
    // the queried element itself as an ownership boundary. Two more rules are
    // found by the corpus-wide scan under Program Rules.
    expect(data.accountRules).toHaveLength(5);
    const rec = records.find((r) =>
      r.sourceKey.startsWith("dom:details:account-rules:"),
    );
    expect(rec?.quote).toContain("acme.example email domain");
  });

  it("collects account, data, focus, non-focus, and reporting groups", () => {
    expect(data.accountRules).toHaveLength(5);
    expect(data.accountRules[0]).toContain("acme.example email domain");
    expect(data.dataRules).toHaveLength(5);
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

describe("collectPolicies attribution", () => {
  it("marks a line asserting both polarities as partial", () => {
    const doc = new DOMParser().parseFromString(
      `<main><section><h2>Program Rules</h2><ul>
        <li>Automated scanning is allowed, but brute force attacks are prohibited.</li>
      </ul></section></main>`,
      "text/html",
    );
    const { records } = collectPolicies(doc, PAGE_URL);
    const emitted = records.filter((r) =>
      r.sourceKey.startsWith("dom:details:program-rules:"),
    );
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((r) => r.extractionStatus === "partial")).toBe(true);
  });
});

describe("collectPolicies submission exclusions", () => {
  const current = collectPolicies(loadDoc("webdotcom-current.html"), PAGE_URL);
  const exclusion = (needle: string) =>
    current.data.exclusions.find((e) => e.text.includes(needle));

  it("marks a bare vulnerability class as excluded without touching testing status", () => {
    expect(exclusion("Clickjacking")).toEqual({
      text: "Clickjacking",
      submissionStatus: "excluded",
      testingStatus: "unspecified",
    });
    expect(exclusion("Open redirect")?.testingStatus).toBe("unspecified");
    expect(exclusion("zero-day")?.testingStatus).toBe("unspecified");
  });

  it("reads an explicit activity prohibition in the same list as a testing rule", () => {
    expect(exclusion("DDoS")?.testingStatus).toBe("prohibited");
    expect(
      current.data.techniques.find((t) => t.name === "denial of service"),
    ).toMatchObject({ status: "prohibited" });
  });

  it("never turns a report-framed prohibition into a testing prohibition", () => {
    // "Do not submit automated scanner output." forbids the submission, not
    // the scanning — §11 keeps the technique unspecified without evidence.
    expect(exclusion("automated scanner output")?.testingStatus).toBe(
      "unspecified",
    );
    for (const name of ["automation", "scanning"]) {
      expect(current.data.techniques.some((t) => t.name === name)).toBe(false);
    }
    expect(exclusion("Self-XSS")?.testingStatus).toBe("unspecified");
  });

  it("records every excluded line as a submission exclusion", () => {
    expect(current.data.exclusions).toHaveLength(6);
    expect(
      current.data.exclusions.every((e) => e.submissionStatus === "excluded"),
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
    // A line that prohibits several named activities supports each of those
    // facts exactly: one polarity, nothing to guess. Attribution is only
    // heuristic when a single line asserts both polarities.
    const multi = tech.filter((r) =>
      r.quote.includes("Automated scanning and brute force"),
    );
    expect(multi.length).toBe(3);
    expect(multi.every((r) => r.extractionStatus === "exact")).toBe(true);
    // A clean single-technique line is exact.
    const single = tech.find((r) => r.quote.startsWith("Denial of service"));
    expect(single?.extractionStatus).toBe("exact");
    expect(single?.sourceLevel).toBe("explicit_program_rule");
    // VRT deviations carry the vrt_deviation level.
    const dev = records.find((r) => r.quote.includes("SSRF is rated"));
    expect(dev?.sourceLevel).toBe("vrt_deviation");
  });
});

describe("collectPolicies heading-bounded current Bugcrowd content", () => {
  const current = collectPolicies(loadDoc("webdotcom-current.html"), PAGE_URL);

  it("keeps Safe Harbor statements inside the Safe Harbor heading range", () => {
    expect(current.data.safeHarborStatements).toEqual([
      "When conducting vulnerability research according to this policy, we consider this research to be:",
      "Authorized in accordance with the Computer Fraud and Abuse Act.",
      "Exempt from the Digital Millennium Copyright Act.",
      "Lawful, helpful, and conducted in good faith.",
      "If you are uncertain whether research is consistent with this policy, contact Bugcrowd Support.",
    ]);
    expect(current.data.safeHarborStatements).not.toContain("Website Testing");
  });

  it("keeps the explicit testing-authorization sentence without an Authorization heading", () => {
    expect(current.data.authorizationStatements).toEqual([
      "Testing is only authorized on the targets listed as in scope. All other assets are out of scope.",
    ]);
  });

  it("splits the scope-authorization sentence into listed and unlisted facts", () => {
    expect(current.data.scopeAuthorization).toEqual({
      listedTargets: {
        status: "conditional",
        conditions: ["the targets listed as in scope"],
      },
      unlistedTargets: { status: "prohibited" },
      quote:
        "Testing is only authorized on the targets listed as in scope. All other assets are out of scope.",
    });
  });

  it("collects current-page account, focus, exclusion, and reporting sections", () => {
    expect(current.data.accountRules).toContain(
      "You may use your @bugcrowdninja.com email address.",
    );
    expect(current.data.focusAreas).toContain("AI Features within");
    expect(current.data.nonFocusAreas).toContain(
      "Self-XSS reports will not be accepted.",
    );
    expect(current.data.reportingRequirements).toContain(
      "Include ordered reproduction steps and a fully working proof of concept.",
    );
  });
});
