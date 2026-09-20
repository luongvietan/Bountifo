// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectDetails } from "../lib/dom/details";
import { collectPolicies } from "../lib/dom/policies";
import { collectTargets } from "../lib/dom/targets";
import { loadDoc, PAGE_URL } from "./helpers/dom";

// Two more brief shapes from the live platform: MATLAB Online (one unnamed
// scope group, a long overview block inside the card, a policy section headed
// "Out of Scope") and OpenAI's Safety Bug Bounty (several named groups whose
// cards argue scope in prose).

describe("MATLAB single-group shape", () => {
  const doc = loadDoc("matlab-current.html");
  const targets = collectTargets(doc, PAGE_URL);
  const policy = collectPolicies(loadDoc("matlab-current.html"), PAGE_URL);
  const details = collectDetails(loadDoc("matlab-current.html"), PAGE_URL);

  it("names the engagement from the header, not from a policy heading", () => {
    expect(details.data.name).toBe(
      "MATLAB Online - Ongoing Bug Bounty Engagement",
    );
  });

  it("treats a card headed 'In Scope' as the default bucket, not a name", () => {
    expect(targets.groups.map((g) => g.name)).toEqual(["default_in_scope"]);
    expect(targets.groups[0]!.rewards.p1).toBe("$3000 – $7000");
  });

  it("keeps the card's own overview heading out of the scope inventory", () => {
    // <h2>Target Overview</h2> lives inside the card; it is content, and the
    // section's <h3> still owns the section around it.
    expect(targets.targets).toHaveLength(1);
    expect(targets.targets[0]!.location).toBe("https://matlab.mathworks.com/");
    expect(targets.targets[0]!.inScope).toBe(true);
  });

  it("reads a policy section headed 'Out of Scope' as exclusions", () => {
    const texts = policy.data.exclusions.map((e) => e.text);
    expect(texts.some((t) => /Denial of Service/i.test(t))).toBe(true);
    expect(policy.data.scopeAuthorization).not.toBeNull();
  });
});

describe("OpenAI prose-scope shape", () => {
  const targets = collectTargets(loadDoc("openai-current.html"), PAGE_URL);
  const policy = collectPolicies(loadDoc("openai-current.html"), PAGE_URL);
  const details = collectDetails(loadDoc("openai-current.html"), PAGE_URL);

  it("names the engagement from the header h2, not a body h1", () => {
    // "Program Rules" and "Safe Harbor" are h1 here; neither is the name.
    expect(details.data.name).toBe("Safety Bug Bounty");
  });

  it("keeps both named groups with their own verdicts", () => {
    expect(targets.groups.map((g) => g.name)).toEqual([
      "Agentic Tools Including MCP",
      "Content Issues",
    ]);
    expect(targets.groups[0]!.rewards.p1).toBe("$5500 – $7500");
    expect(targets.targets.filter((t) => t.inScope)).toHaveLength(1);
    expect(targets.targets.filter((t) => !t.inScope)).toHaveLength(1);
  });

  it("never reads an 'In Scope:' sentence inside a card as a target", () => {
    const names = targets.targets.map((t) => t.name ?? t.location ?? "");
    expect(names.some((n) => /prompt injection/i.test(n))).toBe(false);
    expect(names).toEqual(["Agentic Tools", "Content"]);
  });

  it("records the authorization the brief actually states", () => {
    // This brief never says "testing is authorized"; the closest it comes is
    // a qualifier on authorized testing, and that is the sentence an agent
    // needs.
    const texts = policy.data.authorizationStatements;
    expect(texts.some((t) => /authorized testing does not exempt/i.test(t))).toBe(
      true,
    );
  });

  it("leaves the safe-harbor wording under safe harbor, once", () => {
    // "we cannot authorize your efforts on third-party products" reads as
    // authorization too, but it is one sentence in one place: it stays a
    // safe-harbor statement rather than being copied into a second section.
    const sh = policy.data.safeHarborStatements;
    const thirdParty = sh.filter((t) =>
      /cannot authorize your efforts on third-party/i.test(t),
    );
    expect(thirdParty).toHaveLength(1);
    expect(
      policy.data.authorizationStatements.some((t) =>
        /third-party products/i.test(t),
      ),
    ).toBe(false);
  });
});
