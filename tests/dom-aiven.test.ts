// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectTargets } from "../lib/dom/targets";
import { collectPolicies } from "../lib/dom/policies";
import { loadDoc, PAGE_URL } from "./helpers/dom";

// Aiven's brief is the multi-group form of the same Bugcrowd component: each
// scope card carries its own name and reward chart, and one card holds the VRT
// scope-exclusion table rather than targets.

const targets = collectTargets(loadDoc("aiven-current.html"), PAGE_URL);
const policy = collectPolicies(loadDoc("aiven-current.html"), PAGE_URL);

describe("Aiven scope safety", () => {
  it("never reads a VRT scope-exclusion row as a target", () => {
    const identityless = targets.targets.filter(
      (t) => t.location === null && t.name === null,
    );
    expect(identityless).toEqual([]);
    const names = targets.targets.map((t) => t.name ?? t.location ?? "");
    expect(names.some((n) => n.includes("Denial-of-Service"))).toBe(false);
    expect(names.some((n) => n.includes("Physical Security"))).toBe(false);
  });

  it("counts only the real targets on both sides of the boundary", () => {
    expect(targets.targets.filter((t) => t.inScope)).toHaveLength(4);
    expect(targets.targets.filter((t) => !t.inScope)).toHaveLength(2);
  });

  it("does not emit a target group for the VRT table", () => {
    expect(targets.groups.map((g) => g.name)).toEqual([
      "Database Services Tier 1",
      "In Scope (Website Console)",
      "default_out_of_scope",
    ]);
  });
});

describe("Aiven reward groups", () => {
  it("names each inner group and keeps its own reward chart", () => {
    const tier1 = targets.groups.find((g) => g.name === "Database Services Tier 1");
    expect(tier1?.inScope).toBe(true);
    expect(tier1?.rewards).toEqual({
      p1: "$16500 – $23100",
      p2: "$5280 – $13200",
      p3: "$1650 – $4620",
      p4: "$660 – $990",
      p5: null,
    });
    const console_ = targets.groups.find(
      (g) => g.name === "In Scope (Website Console)",
    );
    expect(console_?.rewards.p1).toBe("$4100 – $4500");
    expect(console_?.rewards.p3).toBeNull();
  });

  it("assigns each target to the group that pays for it", () => {
    const byName = (n: string) => targets.targets.find((t) => t.name === n);
    expect(byName("Aiven for Clickhouse")?.groupDomKey).toBe(
      targets.groups.find((g) => g.name === "Database Services Tier 1")?.domKey,
    );
    expect(byName("console.aiven.io")?.groupDomKey).toBe(
      targets.groups.find((g) => g.name === "In Scope (Website Console)")?.domKey,
    );
  });
});

describe("Aiven VRT scope rules", () => {
  it("keeps the VRT table as VRT policy", () => {
    expect(policy.data.vrt.scopeRules).toEqual([
      {
        category: "Application-Level Denial-of-Service (DoS)",
        vrtVersion: "1.18",
        appliesTo: "All targets",
        status: "out_of_scope",
        note: null,
      },
      {
        category: "Physical Security Issues",
        vrtVersion: "1.18",
        appliesTo: "All targets",
        status: "out_of_scope",
        note: null,
      },
      {
        category: "Broken Access Control (BAC)",
        vrtVersion: "1.19.1",
        appliesTo:
          "Targets: aiven.io console.aiven.io api.aiven.io Target groups: In Scope (Website Console)",
        status: "conditional",
        note: "Where the operations allowed in the web interface and the API differ, it is the API that is considered authoritative.",
      },
    ]);
  });
});

describe("Aiven authorization", () => {
  it("classifies the scope sentence even when another section matched first", () => {
    // "Aiven's Permission Model" matches the authorization heading pattern, so
    // the statement list is non-empty before the scope sentence is reached.
    expect(policy.data.scopeAuthorization).toMatchObject({
      listedTargets: { status: "conditional" },
      unlistedTargets: { status: "prohibited" },
    });
    expect(policy.data.scopeAuthorization?.quote).toContain(
      "Testing is only authorized on the targets listed as in scope.",
    );
  });
});

describe("Aiven technique semantics", () => {
  const tech = (name: string) =>
    policy.data.techniques.find((t) => t.name === name);

  it("reads an explicit prohibition out of a paragraph that names two activities", () => {
    expect(tech("denial of service")?.status).toBe("prohibited");
  });

  it("separates owning-account testing from other customers' data", () => {
    expect(tech("cross-account testing")).toMatchObject({
      status: "conditional",
    });
    expect(tech("cross-account testing")?.conditions.join(" ")).toContain(
      "other accounts that you own",
    );
    expect(tech("other customer data")?.status).toBe("prohibited");
    // One line, one fact each: the exploit-chain sentence is about accounts
    // the researcher owns, so it must not re-assert the customer-data rule
    // and manufacture a conflict.
    expect(
      policy.data.techniques.filter((t) => t.name === "other customer data"),
    ).toHaveLength(1);
    // The generic cross-tenant bucket must not swallow either of them.
    expect(tech("cross-tenant")).toBeUndefined();
  });
});

describe("Aiven exclusions", () => {
  it("keeps the out-of-scope policy list as structured exclusions", () => {
    const texts = policy.data.exclusions.map((e) => e.text);
    expect(texts.some((t) => t.startsWith("Only services you create"))).toBe(true);
    expect(texts.some((t) => t.includes("Rate limiting"))).toBe(true);
    expect(texts.some((t) => t.includes("0day"))).toBe(true);
    expect(
      policy.data.exclusions.every((e) => e.submissionStatus === "excluded"),
    ).toBe(true);
  });
});
