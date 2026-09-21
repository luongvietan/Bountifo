import { describe, expect, it } from "vitest";
import {
  canonicalTechniqueId,
  techniquesMentionedIn,
} from "../lib/guard/techniques";

describe("canonicalTechniqueId", () => {
  it("passes through known canonical ids", () => {
    expect(canonicalTechniqueId("denial_of_service")).toBe("denial_of_service");
    expect(canonicalTechniqueId("automated_scanners")).toBe("automated_scanners");
  });

  it("maps the exporter's emitted fact keys", () => {
    expect(canonicalTechniqueId("denial of service")).toBe("denial_of_service");
    expect(canonicalTechniqueId("DoS")).toBe("denial_of_service");
    expect(canonicalTechniqueId("dos")).toBe("denial_of_service");
    expect(canonicalTechniqueId("social engineering")).toBe("social_engineering");
    expect(canonicalTechniqueId("automated scanning")).toBe("automated_scanning");
    expect(canonicalTechniqueId("automated scanners")).toBe("automated_scanners");
    expect(canonicalTechniqueId("automated tools")).toBe("automated_tools");
    expect(canonicalTechniqueId("scanning")).toBe("scanning");
    expect(canonicalTechniqueId("automation")).toBe("automation");
    expect(canonicalTechniqueId("PII access")).toBe("pii_access");
    expect(canonicalTechniqueId("third-party")).toBe("third_party");
    expect(canonicalTechniqueId("cross-account testing")).toBe(
      "cross_account_testing",
    );
    expect(canonicalTechniqueId("other customer data")).toBe(
      "other_customer_data",
    );
    expect(canonicalTechniqueId("automation (against form submissions)")).toBe(
      "form_submission_automation",
    );
    expect(canonicalTechniqueId("physical testing")).toBe("physical_testing");
    expect(canonicalTechniqueId("brute force")).toBe("brute_force");
    expect(canonicalTechniqueId("data exfiltration")).toBe("data_exfiltration");
    expect(canonicalTechniqueId("persistent access")).toBe("persistent_access");
    expect(canonicalTechniqueId("multi-account")).toBe("multi_account");
    expect(canonicalTechniqueId("cross-tenant")).toBe("cross_tenant");
    expect(canonicalTechniqueId("credential testing")).toBe("credential_testing");
  });

  it("never maps a more specific name down to a generic parent", () => {
    expect(canonicalTechniqueId("automated scanners")).not.toBe("scanning");
    expect(canonicalTechniqueId("automated tools")).not.toBe("automation");
  });

  it("maps vulnerability-class phrases used by VRT and exclusions", () => {
    expect(canonicalTechniqueId("Application-Level Denial-of-Service (DoS)")).toBe(
      "denial_of_service",
    );
    expect(canonicalTechniqueId("Physical Security Issues")).toBe(
      "physical_testing",
    );
    expect(canonicalTechniqueId("Broken Access Control (BAC)")).toBe(
      "broken_access_control",
    );
    expect(canonicalTechniqueId("CSRF")).toBe("csrf");
    expect(canonicalTechniqueId("Self-XSS")).toBe("self_xss");
    expect(canonicalTechniqueId("contact forms")).toBe("contact_form_testing");
  });

  it("returns null for unknown techniques instead of guessing", () => {
    expect(canonicalTechniqueId("quantum replay")).toBeNull();
    expect(canonicalTechniqueId("")).toBeNull();
  });
});

describe("techniquesMentionedIn", () => {
  it("returns the most specific mention, not its generic parent", () => {
    const ids = techniquesMentionedIn(
      "Use of any automated tools/scanners is strictly prohibited",
    );
    expect(ids).toContain("automated_tools");
    expect(ids).toContain("automated_scanners");
    expect(ids).not.toContain("scanning");
    expect(ids).not.toContain("automation");
  });

  it("finds governed activities inside imperative text", () => {
    expect(
      techniquesMentionedIn("Avoid testing any contact forms on epam.com"),
    ).toEqual(["contact_form_testing"]);
  });

  it("does not treat a topic mention as every related technique", () => {
    const ids = techniquesMentionedIn("third-party data inputs");
    expect(ids).toContain("third_party");
    expect(ids).not.toContain("pii_access");
  });
});
