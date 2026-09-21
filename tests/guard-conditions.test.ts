import { describe, expect, it } from "vitest";
import {
  compileCondition,
  compileRule,
} from "../lib/guard/conditions";

describe("compileCondition", () => {
  it("compiles explicit-scope-listing conditions", () => {
    expect(compileCondition("target must be explicitly declared in scope")).toEqual(
      { kind: "target_is_explicitly_listed" },
    );
    expect(compileCondition("the targets listed as in scope")).toEqual({
      kind: "target_is_explicitly_listed",
    });
    expect(compileCondition("only against the targets listed in scope")).toEqual(
      { kind: "target_is_explicitly_listed" },
    );
  });

  it("compiles account-ownership conditions", () => {
    expect(compileCondition("other accounts that you own")).toEqual({
      kind: "account_ownership",
      allowed: ["researcher"],
    });
    expect(compileCondition("your own accounts")).toEqual({
      kind: "account_ownership",
      allowed: ["researcher"],
    });
    expect(
      compileCondition("accounts you own or are explicitly authorized to test"),
    ).toEqual({
      kind: "account_ownership",
      allowed: ["researcher", "explicitly_authorized"],
    });
  });

  it("compiles prior-approval conditions", () => {
    expect(compileCondition("with prior written approval")).toEqual({
      kind: "prior_authorization",
    });
    expect(compileCondition("requires written authorization")).toEqual({
      kind: "prior_authorization",
    });
  });

  it("compiles non-destructive conditions", () => {
    expect(compileCondition("non-destructive testing only")).toEqual({
      kind: "non_destructive",
    });
    expect(compileCondition("without causing disruption")).toEqual({
      kind: "non_destructive",
    });
  });

  it("compiles rate limits into requests per minute", () => {
    expect(compileCondition("no more than 10 requests per second")).toEqual({
      kind: "rate_limit",
      max_per_minute: 600,
    });
    expect(compileCondition("limited to 60 requests per minute")).toEqual({
      kind: "rate_limit",
      max_per_minute: 60,
    });
  });

  it("fails closed on anything unrecognized", () => {
    for (const text of [
      "frequent creation and teardown",
      "in https://aiven.io",
      "during business hours in UTC",
      "the quick brown fox",
    ]) {
      expect(compileCondition(text).kind).toBe("unresolved");
    }
  });
});

describe("compileRule", () => {
  const ev = ["ev_x"];

  it("compiles own-account rules", () => {
    expect(compileRule("Only test accounts that you own.", ev)).toMatchObject({
      kind: "account_ownership",
      allowed: ["researcher"],
    });
    expect(compileRule("Do not modify another user's account.", ev)).toMatchObject(
      { kind: "account_ownership", allowed: ["researcher", "explicitly_authorized"] },
    );
  });

  it("compiles credential-source prohibitions", () => {
    expect(
      compileRule("Do not use leaked or third-party credentials.", ev),
    ).toMatchObject({
      kind: "credential_source",
      denied: expect.arrayContaining(["leaked", "third_party"]),
    });
    expect(
      compileRule("Leaked credentials are prohibited.", ev),
    ).toMatchObject({ kind: "credential_source", denied: ["leaked"] });
  });

  it("compiles customer-data validation prohibitions", () => {
    const rule = compileRule(
      "If you find sensitive customer data, do not attempt to validate whether it works — report it.",
      ev,
    );
    expect(rule).toMatchObject({
      kind: "technique_prohibition",
      technique: "customer_data_validation",
    });
  });

  it("compiles third-party data access prohibitions", () => {
    expect(
      compileRule("Do not access, modify, or delete other customers' data.", ev),
    ).toMatchObject({
      kind: "data_access",
      denied_ownership: expect.arrayContaining(["third_party"]),
    });
  });

  it("compiles program-issued account requirements", () => {
    expect(
      compileRule("Use only program-issued test accounts.", ev),
    ).toMatchObject({
      kind: "account_ownership",
      allowed: expect.arrayContaining(["explicitly_authorized"]),
    });
  });

  it("fails closed on prose it cannot type", () => {
    const rule = compileRule(
      "Reports must include a screenshot and a CVSS score.",
      ev,
    );
    expect(rule.kind).toBe("unresolved");
    expect(rule).toMatchObject({
      source_text: "Reports must include a screenshot and a CVSS score.",
      evidence_refs: ["ev_x"],
    });
  });
});
