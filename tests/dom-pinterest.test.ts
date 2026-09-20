// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectDetails } from "../lib/dom/details";
import { collectPolicies } from "../lib/dom/policies";
import { loadDoc, PAGE_URL } from "./helpers/dom";

// Pinterest's brief has no header block inside main and renders its policy
// sections as h1 *inside* the scope section. Both break identification that
// leans on "the first h1" or on "the heading labels its section".

const details = collectDetails(loadDoc("pinterest-current.html"), PAGE_URL);
const policy = collectPolicies(loadDoc("pinterest-current.html"), PAGE_URL);

describe("Pinterest engagement identity", () => {
  it("never takes a policy heading as the engagement name", () => {
    expect(details.data.name).toBe("Pinterest");
    expect(details.data.engagementType).toBe("Bug Bounty");
  });
});

describe("Pinterest Safe Harbor isolation", () => {
  it("stops at the Safe Harbor block instead of swallowing the section", () => {
    expect(policy.data.safeHarborStatements).toEqual([
      "When conducting vulnerability research according to this policy, we consider this research to be:",
      "Authorized in accordance with the Computer Fraud and Abuse Act.",
    ]);
  });

  it("keeps scope inventory text out of Safe Harbor", () => {
    const joined = policy.data.safeHarborStatements.join(" ");
    expect(joined).not.toContain("Browser Extension");
    expect(joined).not.toContain("Website Testing");
    expect(joined).not.toContain("Testing is only authorized");
  });
});

describe("Pinterest authorization boundary", () => {
  it("classifies the scope sentence that Safe Harbor used to absorb", () => {
    expect(policy.data.scopeAuthorization).toMatchObject({
      listedTargets: { status: "conditional" },
      unlistedTargets: { status: "prohibited" },
    });
  });
});

describe("Pinterest conditional facts", () => {
  it("never states a condition it cannot name", () => {
    for (const technique of policy.data.techniques) {
      if (technique.status !== "conditional") continue;
      expect(technique.conditions.length).toBeGreaterThan(0);
    }
    const pii = policy.data.techniques.find((t) => t.name === "PII access");
    expect(pii?.status).toBe("conditional");
    expect(pii?.conditions.join(" ")).toContain("written approval");
  });
});
