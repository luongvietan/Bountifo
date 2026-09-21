import { describe, expect, it } from "vitest";
import {
  extractAgentFactsYaml,
  FactsParseError,
  parseAgentFacts,
} from "@/lib/guard/parse.ts";
import { compilePolicy } from "@/lib/guard/policy.ts";

describe("parseAgentFacts", () => {
  it("parses a bare YAML facts document", () => {
    const facts = parseAgentFacts(
      "agent_facts_schema_version: 1\nengagement:\n  code: acme\ntechniques: {}\n",
    );
    expect(facts.engagement?.code).toBe("acme");
    expect(facts.agent_facts_schema_version).toBe(1);
  });

  it("extracts the fenced Agent Facts block from a Markdown dossier", () => {
    const dossier = [
      "# Engagement: acme",
      "",
      "## Scope",
      "",
      "stuff",
      "",
      "## Agent Facts",
      "",
      "```yaml",
      "agent_facts_schema_version: 1",
      "engagement:",
      "  code: acme",
      "scope_inventory:",
      "  in_scope:",
      "    - target_id: t_1",
      "      location: https://a.example.com",
      "```",
      "",
      "## Appendix",
    ].join("\n");
    const facts = parseAgentFacts(dossier);
    expect(facts.engagement?.code).toBe("acme");
    expect(facts.scope_inventory?.in_scope?.[0]?.target_id).toBe("t_1");
  });

  it("accepts an already-parsed object", () => {
    const facts = parseAgentFacts({ engagement: { code: "x" } });
    expect(facts.engagement?.code).toBe("x");
  });

  it("accepts JSON text", () => {
    const facts = parseAgentFacts('{"engagement": {"code": "j"}}');
    expect(facts.engagement?.code).toBe("j");
  });

  it("throws FactsParseError on empty input", () => {
    expect(() => parseAgentFacts("")).toThrow(FactsParseError);
    expect(() => parseAgentFacts("   \n  ")).toThrow(FactsParseError);
  });

  it("throws FactsParseError on malformed YAML", () => {
    expect(() => parseAgentFacts("{{{{")).toThrow(FactsParseError);
  });

  it("throws FactsParseError on non-mapping YAML", () => {
    expect(() => parseAgentFacts("- a\n- b\n")).toThrow(FactsParseError);
    expect(() => parseAgentFacts("just a string")).toThrow(FactsParseError);
  });

  it("old dossiers without scope_inventory parse and compile with a diagnostic", async () => {
    const facts = parseAgentFacts({
      engagement: { code: "old" },
      techniques: {},
      collection: { status: "complete" },
    });
    const policy = await compilePolicy(facts);
    expect(policy.ir.diagnostics).toContain("SCOPE_INVENTORY_UNAVAILABLE");
    expect(policy.ir.inventory).toBeNull();
  });

  it("extractAgentFactsYaml returns null when no block exists", () => {
    expect(extractAgentFactsYaml("# no facts here")).toBeNull();
  });
});
