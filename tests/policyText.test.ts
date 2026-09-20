import { describe, expect, it } from "vitest";
import {
  conditionsOf,
  hasNormativePredicate,
  isMeaningfulCondition,
  sentencesOf,
  statusOfSentence,
  techniqueFindingsIn,
  testingStatusOf,
} from "../lib/model/policyText";

// ---------------------------------------------------------------------------
// §22 semantic invariants: no explicit normative predicate → no fact;
// submission/scope/reward language never implies a testing status; ambiguous
// polarity fails closed.
// ---------------------------------------------------------------------------

describe("sentencesOf", () => {
  it("splits on sentence boundaries without breaking abbreviations", () => {
    expect(
      sentencesOf(
        "Testing is only authorized on the targets listed as in scope. All other assets are out of scope.",
      ),
    ).toEqual([
      "Testing is only authorized on the targets listed as in scope.",
      "All other assets are out of scope.",
    ]);
    expect(
      sentencesOf(
        "Social engineering (e.g. phishing, vishing, smishing) is prohibited.",
      ),
    ).toEqual([
      "Social engineering (e.g. phishing, vishing, smishing) is prohibited.",
    ]);
    expect(
      sentencesOf("Accessing PII is prohibited; report immediately if encountered."),
    ).toEqual([
      "Accessing PII is prohibited;",
      "report immediately if encountered.",
    ]);
  });
});

describe("statusOfSentence — explicit predicates", () => {
  it("reads copula prohibitions", () => {
    for (const s of [
      "Automated scanning is prohibited.",
      "Denial of service testing is not permitted.",
      "Social engineering is not allowed.",
      "Brute force attacks are strictly forbidden.",
      "Physical testing is disallowed.",
    ]) {
      expect(statusOfSentence(s)).toBe("prohibited");
    }
  });

  it("reads modal and imperative prohibitions", () => {
    for (const s of [
      "Third-party services may not be tested.",
      "You must not test production systems.",
      "Do not target other users' data.",
      "Researchers must not access customer records.",
      "For example, do not engage any sort of DoS attack.",
      "Never scan out-of-scope assets.",
      "You cannot test this target.",
    ]) {
      expect(statusOfSentence(s)).toBe("prohibited");
    }
  });

  it("reads enforcement consequences as prohibitions", () => {
    expect(
      statusOfSentence(
        "Automation against form submissions is not allowed and can lead to a ban.",
      ),
    ).toBe("prohibited");
  });

  it("reads explicit permission grants", () => {
    expect(statusOfSentence("Automated tooling is allowed for reconnaissance.")).toBe(
      "allowed",
    );
    expect(statusOfSentence("You may test the listed targets.")).toBe("allowed");
    expect(statusOfSentence("Researchers are permitted to test the API.")).toBe(
      "allowed",
    );
  });

  it("reads qualified permission/prohibition as conditional", () => {
    for (const s of [
      "Automated scanning is permitted only against explicitly listed targets.",
      "Credential testing is allowed only with Acme-supplied test accounts.",
      "Scanning is prohibited unless authorized in writing.",
      "Please use only other accounts that you own, not random customers.",
      "Testing is restricted to the staging environment.",
    ]) {
      expect(statusOfSentence(s)).toBe("conditional");
    }
  });
});

describe("statusOfSentence — no predicate, no status", () => {
  it("ignores topic mentions and capability statements", () => {
    for (const s of [
      "*.lab.epam.com and *.opensource.epam.com are development environments and fake PII data can be used there.",
      "Our infrastructure is dynamically provisioned through automation and is frequently created and torn down.",
      "Using nested, encoded, or third-party data inputs to manipulate the agent.",
      "Known vulnerabilities in used third-party libraries.",
      "Third-Party Dependency Versions",
    ]) {
      expect(statusOfSentence(s)).toBeNull();
    }
  });

  it("ignores descriptive 'do not' inside relative clauses", () => {
    for (const s of [
      "Issues in business processes that do not have demonstrable security impact.",
      "Interactions with external services that do not demonstrate security impact.",
      "CSRF on unauthenticated forms or forms that do not perform sensitive actions.",
      "Testing that requires accessing accounts, tenants, or data you do not own.",
    ]) {
      expect(statusOfSentence(s)).toBeNull();
    }
  });

  it("ignores capability phrasing", () => {
    for (const s of [
      "Exploitability cannot be demonstrated from the outside.",
      "We cannot authorize your efforts on third-party products.",
      "We are unable to authorize testing on third-party services.",
    ]) {
      expect(statusOfSentence(s)).toBeNull();
    }
  });

  it("ignores submission/reward/eligibility framing", () => {
    for (const s of [
      "Self-XSS reports will not be accepted.",
      "Do not submit automated scanner output.",
      "Pure alignment quirks will be closed as Not Applicable.",
      "Known vulnerabilities in used third-party libraries are excluded unless exploitability can be demonstrated.",
      "These findings are not eligible for a reward.",
      "Clickjacking on pages without sensitive actions is out of scope.",
    ]) {
      expect(statusOfSentence(s)).toBeNull();
    }
  });

  it("fails closed on mixed polarity", () => {
    expect(
      statusOfSentence(
        "Automated scanning is allowed, but brute force attacks are prohibited.",
      ),
    ).toBeNull();
  });
});

describe("statusOfSentence — activity directive inside a scope frame", () => {
  it("keeps an explicit testing prohibition that follows an out-of-scope clause", () => {
    expect(
      statusOfSentence(
        "Third-party services, including Acme SaaS providers, are out of scope and must not be tested.",
      ),
    ).toBe("prohibited");
  });
});

describe("techniqueFindingsIn", () => {
  it("creates no fact from a topic mention without a predicate", () => {
    expect(
      techniqueFindingsIn(
        "fake PII data can be used in development environments.",
      ),
    ).toEqual([]);
    expect(
      techniqueFindingsIn(
        "Our infrastructure is provisioned through automation and frequently torn down.",
      ),
    ).toEqual([]);
    expect(
      techniqueFindingsIn(
        "Indirect prompt injection using nested, encoded, or third-party data inputs.",
      ),
    ).toEqual([]);
  });

  it("narrows 'automated scanners' instead of asserting blanket automation", () => {
    const findings = techniqueFindingsIn(
      "The use of automated scanners is strictly prohibited.",
    );
    expect(findings.map((f) => f.name)).toEqual(["automated scanners"]);
    expect(findings[0]!.status).toBe("prohibited");
    expect(
      findings.some((f) => f.baseName === "automation" && f.name === "automation"),
    ).toBe(false);
  });

  it("narrows 'automation against form submissions' to the scoped activity", () => {
    const findings = techniqueFindingsIn(
      "Automation against form submissions is not allowed and can lead to a ban.",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.name).toBe("automation (against form submissions)");
    expect(findings[0]!.status).toBe("prohibited");
  });

  it("emits each named activity for a single-polarity multi-technique rule", () => {
    const findings = techniqueFindingsIn(
      "Automated scanning and brute force testing are prohibited.",
    );
    const names = findings.map((f) => f.name);
    expect(names).toContain("automated scanning");
    expect(names).toContain("brute force");
    expect(findings.every((f) => f.status === "prohibited")).toBe(true);
    expect(findings.every((f) => !f.ambiguous)).toBe(true);
  });

  it("marks mixed-polarity sentences ambiguous with unspecified status", () => {
    const findings = techniqueFindingsIn(
      "Automated scanning is allowed, but brute force attacks are prohibited.",
    );
    expect(findings.length).toBeGreaterThan(1);
    expect(findings.every((f) => f.ambiguous)).toBe(true);
    expect(findings.every((f) => f.status === "unspecified")).toBe(true);
  });

  it("extracts conditions only for conditional sentences", () => {
    const findings = techniqueFindingsIn(
      "Automated scanning is permitted only against explicitly listed targets.",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe("conditional");
    expect(findings[0]!.conditions.join(" ")).toContain(
      "explicitly listed targets",
    );
  });

  it("produces a cross-account conditional from an own-accounts rule", () => {
    const findings = techniqueFindingsIn(
      "We are interested in avenues to make authenticated access to other accounts' services where the other account has not allowed this access - please use only other accounts that you own, not random customers.",
    );
    const cross = findings.find((f) => f.name === "cross-account testing");
    expect(cross?.status).toBe("conditional");
    expect(cross?.conditions.join(" ")).toContain("accounts that you own");
    // "other accounts' services" is the researcher's own accounts — never the
    // other-customer-data rule.
    expect(findings.some((f) => f.baseName === "other customer data")).toBe(false);
  });
});

describe("testingStatusOf", () => {
  it("keeps out-of-scope vulnerability classes unspecified", () => {
    for (const line of [
      "Business Logic Flaws: Issues in business processes that do not have demonstrable security impact.",
      "External Service Interactions: Interactions with external services that do not demonstrate security impact.",
      "Self-XSS: Self-inflicted XSS without realistic threat.",
      "CSRF: On unauthenticated forms or forms that do not perform sensitive actions.",
      "Pure Alignment Quirks — will be closed as Not Applicable.",
      "Clickjacking",
    ]) {
      expect(testingStatusOf(line)).toBe("unspecified");
    }
  });

  it("keeps an explicit activity prohibition prohibited", () => {
    expect(testingStatusOf("DDoS and Application DoS are not permitted.")).toBe(
      "prohibited",
    );
    expect(
      testingStatusOf(
        "Interacting with real customers or real customer accounts is forbidden.",
      ),
    ).toBe("prohibited");
  });
});

describe("isMeaningfulCondition", () => {
  it("rejects fragments and artifacts", () => {
    for (const bad of [
      "in those vulnerabilities in https://aiven.io",
      "a",
      "the",
      "that are not",
      "of",
      "targets and",
    ]) {
      expect(isMeaningfulCondition(bad)).toBe(false);
    }
  });

  it("accepts real condition clauses", () => {
    for (const good of [
      "against explicitly listed targets",
      "with Acme-supplied test accounts",
      "other accounts that you own, not random customers",
      "authorized in writing",
    ]) {
      expect(isMeaningfulCondition(good)).toBe(true);
    }
  });
});

describe("conditionsOf", () => {
  it("never emits a conditional without a meaningful condition", () => {
    // "only" + nothing extractable → empty; the caller downgrades.
    expect(conditionsOf("Testing is permitted only.")).toEqual([]);
  });
});

describe("hasNormativePredicate", () => {
  it("is the validator's hard gate for asserted facts", () => {
    expect(hasNormativePredicate("Automated scanning is prohibited.")).toBe(true);
    expect(hasNormativePredicate("fake PII data can be used there.")).toBe(false);
    expect(
      hasNormativePredicate(
        "Automated scanning is prohibited.",
        "prohibited",
      ),
    ).toBe(true);
    expect(
      hasNormativePredicate("Automated scanning is prohibited.", "allowed"),
    ).toBe(false);
    expect(
      hasNormativePredicate(
        "Third-party libraries are excluded unless exploitability is shown.",
        "prohibited",
      ),
    ).toBe(false);
  });
});
