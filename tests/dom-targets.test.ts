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

describe("collectTargets wrapper sections", () => {
  const wrapped = collectTargets(loadDoc("targets-wrapper.html"), PAGE_URL);

  it("collects a wrapper section's own direct tables as an implicit group", () => {
    // Previously the "Scope" wrapper was leaf-filtered out and its direct
    // targets were silently lost. The bare "Scope" label is a wrapper badge,
    // so the implicit group gets the deterministic generic name.
    const implicit = wrapped.groups.find((g) => g.name === "default_in_scope");
    expect(implicit).toBeDefined();
    expect(implicit?.inScope).toBe(true);
    const direct = wrapped.targets.find(
      (t) => t.location === "direct.acme.example",
    );
    expect(direct).toBeDefined();
    expect(direct?.inScope).toBe(true);
    expect(direct?.groupDomKey).toBe(implicit?.domKey);
    // The wrapper's loose note applies to its implicit group.
    const note = wrapped.rules.find((r) =>
      r.text.includes("authenticated session"),
    );
    expect(note?.level).toBe("explicit_program_rule");
    expect(note?.appliesToDomKeys).toEqual([implicit?.domKey]);
  });

  it("still collects the nested out-of-scope section", () => {
    const partner = wrapped.groups.find((g) => g.name === "Partner systems");
    expect(partner?.inScope).toBe(false);
    const target = wrapped.targets.find((t) => t.location === "partner.example");
    expect(target?.inScope).toBe(false);
    expect(target?.groupDomKey).toBe(partner?.domKey);
  });

  it("collects an article-typed scope candidate's direct content", () => {
    // An <article> that is itself the scope candidate must own its own
    // direct tables/notes — its closest("article") is itself.
    const implicit = wrapped.groups.find((g) => g.name === "In-scope targets");
    expect(implicit).toBeDefined();
    expect(implicit?.inScope).toBe(true);
    const target = wrapped.targets.find(
      (t) => t.location === "article-scope.acme.example",
    );
    expect(target).toBeDefined();
    expect(target?.category).toBe("Web application");
    expect(target?.inScope).toBe(true);
    expect(target?.groupDomKey).toBe(implicit?.domKey);
    const note = wrapped.rules.find((r) => r.text.includes("scope approval"));
    expect(note?.appliesToDomKeys).toEqual([implicit?.domKey]);
  });

  it("maps ambiguous headers once: 'Target type' → category, 'Target status' → changes", () => {
    const direct = wrapped.targets.find(
      (t) => t.location === "direct.acme.example",
    );
    expect(direct?.category).toBe("Web application");
    expect(direct?.changeFlags).toEqual(["New"]);
    const api = wrapped.targets.find(
      (t) => t.location === "api-direct.acme.example",
    );
    expect(api?.category).toBe("API");
    expect(api?.changeFlags).toEqual(["Reward updated"]);
  });
});

describe("collectTargets nested candidates", () => {
  const nested = collectTargets(
    loadDoc("targets-nested-candidate.html"),
    PAGE_URL,
  );

  it("emits a heading-matching <article> nested in a candidate <section> once", () => {
    // The article is a scope candidate itself — it self-processes as an
    // implicit group; the outer section must not also emit it via groupEls.
    const inScopeGroups = nested.groups.filter(
      (g) => g.name === "In-scope targets",
    );
    expect(inScopeGroups).toHaveLength(1);
    const hits = nested.targets.filter(
      (t) => t.location === "nested.acme.example",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.groupDomKey).toBe(inScopeGroups[0]?.domKey);
    expect(hits[0]?.inScope).toBe(true);
    const notes = nested.rules.filter((r) => r.text.includes("VPN access"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.appliesToDomKeys).toEqual([inScopeGroups[0]?.domKey]);
    // The outer "Scope" candidate has no direct content → no group.
    expect(nested.groups.find((g) => g.name === "Scope")).toBeUndefined();
    // One target record, not a -2-suffixed duplicate.
    const recs = nested.records.filter((r) =>
      r.sourceKey.startsWith("dom:scope:target:nested-acme-example"),
    );
    expect(recs).toHaveLength(1);
  });

  it("does not let a non-candidate group reach into a nested candidate", () => {
    // <div role="group"> wrapping a candidate <article>: the article owns
    // its table; the group emits without stealing the candidate's content.
    const apiGroups = nested.groups.filter((g) => g.name === "API targets");
    expect(apiGroups).toHaveLength(1);
    const deep = nested.targets.filter(
      (t) => t.location === "deep.acme.example",
    );
    expect(deep).toHaveLength(1);
    expect(deep[0]?.groupDomKey).toBe(apiGroups[0]?.domKey);
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

describe("collectTargets current Bugcrowd scope cards", () => {
  const current = collectTargets(loadDoc("webdotcom-current.html"), PAGE_URL);

  it("keeps nested in-scope and out-of-scope groups separate", () => {
    expect(current.targets.filter((t) => t.inScope)).toHaveLength(4);
    expect(current.targets.filter((t) => !t.inScope)).toHaveLength(6);
    expect(current.targets.find((t) => t.name === "*.web.com")?.inScope).toBe(false);
  });

  it("parses the combined Name / Location column", () => {
    const app = current.targets.find((t) => t.name === "app.web.com");
    expect(app?.location).toBe("https://app.web.com");
    expect(app?.displayedKnownIssuesCount).toBe(1);
    const gator = current.targets.find(
      (t) => t.location === "https://app.gator.com/",
    );
    expect(gator?.name).toBeNull();
    expect(gator?.inScope).toBe(false);
  });

  it("preserves visible reward ranges from a definition list", () => {
    const inScope = current.groups.find((g) => g.name === "default_in_scope");
    expect(inScope?.rewards).toEqual({
      p1: "$2000 – $3000",
      p2: "$1000 – $1500",
      p3: "$250 – $600",
      p4: null,
      p5: null,
    });
  });
});
