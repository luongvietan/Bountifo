// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectTargets } from "../lib/dom/targets";
import { assertRecordsWellFormed, loadDoc, PAGE_URL } from "./helpers/dom";

const { records, groups, targets, rules } = collectTargets(
  loadDoc("targets.html"),
  PAGE_URL,
);

describe("collectTargets groups", () => {
  it("collects in-scope and out-of-scope groups", () => {
    expect(groups).toHaveLength(3);
    const web = groups.find((g) => g.name === "Web Applications");
    const infra = groups.find((g) => g.name === "Infrastructure");
    const third = groups.find((g) => g.name === "Third-party properties");
    expect(web?.inScope).toBe(true);
    expect(infra?.inScope).toBe(true);
    expect(third?.inScope).toBe(false);
    expect(web?.description).toContain("Production web applications");
    expect(infra?.description).toBeNull();
  });

  it("parses P1–P5 reward ranges; missing priorities stay null, not 0", () => {
    const web = groups.find((g) => g.name === "Web Applications")!;
    expect(web.rewards).toEqual({ p1: 2500, p2: 1000, p3: 500, p4: 250, p5: 100 });
    const infra = groups.find((g) => g.name === "Infrastructure")!;
    expect(infra.rewards).toEqual({ p1: 1500, p2: null, p3: 300, p4: null, p5: 50 });
    const third = groups.find((g) => g.name === "Third-party properties")!;
    expect(third.rewards).toEqual({ p1: null, p2: null, p3: null, p4: null, p5: null });
  });
});

describe("collectTargets targets", () => {
  it("extracts location, name, category, tags, doc links, change flags, KI display", () => {
    const api = targets.find((t) => t.location === "api.acme.example")!;
    const web = groups.find((g) => g.name === "Web Applications")!;
    expect(api.groupDomKey).toBe(web.domKey);
    expect(api.name).toBe("Acme API");
    expect(api.category).toBe("API");
    expect(api.tags).toEqual(["api", "production"]);
    expect(api.docLinks).toEqual(["https://docs.acme.example/api"]);
    expect(api.changeFlags).toEqual(["New", "Reward updated"]);
    expect(api.displayedKnownIssuesCount).toBe(2);
    expect(api.kiControlLabel).toBe("View known issues");
    expect(api.inScope).toBe(true);
  });

  it("handles link locations, empty cells, and a zero KI count", () => {
    const app = targets.find((t) => t.location === "app.acme.example")!;
    expect(app.name).toBe("Customer portal");
    expect(app.docLinks).toEqual([]);
    expect(app.changeFlags).toEqual([]);
    expect(app.displayedKnownIssuesCount).toBe(0);
  });

  it("flags out-of-scope targets with inScope false", () => {
    const out = targets.filter((t) => !t.inScope);
    expect(out.map((t) => t.location).sort()).toEqual([
      "acme.saasprovider.example",
      "status.acme.example",
    ]);
    const third = groups.find((g) => g.name === "Third-party properties")!;
    expect(out.every((t) => t.groupDomKey === third.domKey)).toBe(true);
  });
});

describe("collectTargets rules", () => {
  it("collects third-party boundaries and target-specific rules", () => {
    const boundary = rules.find((r) => r.text.includes("Third-party services"));
    expect(boundary).toBeDefined();
    expect(boundary?.level).toBe("explicit_program_rule");
    const vpn = rules.find((r) => r.text.includes("VPN profile"));
    expect(vpn?.level).toBe("target_specific_rule");
    const api = targets.find((t) => t.location === "api.acme.example")!;
    expect(vpn?.appliesToDomKeys).toEqual([api.domKey]);
  });
});

describe("collectTargets records", () => {
  it("emits well-formed records under dom:scope", () => {
    assertRecordsWellFormed(records);
    for (const r of records) expect(r.sourceKey.startsWith("dom:scope:")).toBe(true);
    const ruleRecord = records.find(
      (r) => r.sourceLevel === "target_specific_rule",
    );
    expect(ruleRecord?.quote).toContain("VPN");
  });
});
