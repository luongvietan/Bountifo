// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { collectPolicies } from "../lib/dom/policies";
import { assertRecordsWellFormed, PAGE_URL } from "./helpers/dom";

// ---------------------------------------------------------------------------
// Regression coverage for the live-tested failure-mode briefs (§21). No
// real EPAM/Statuspage/Zendesk fixtures exist — these embed the documented
// sentences under realistic section headings and assert the semantics
// end-to-end through collectPolicies: a topic mention must never become a
// permission fact, submission exclusions never become testing prohibitions,
// and the scope boundary is recognized in all its phrasings.
// ---------------------------------------------------------------------------

function doc(html: string): Document {
  return new JSDOM(
    `<!doctype html><html><body><main aria-label="Engagement brief">${html}</main></body></html>`,
    { url: PAGE_URL },
  ).window.document;
}

function exclusion(data: ReturnType<typeof collectPolicies>["data"], re: RegExp) {
  return data.exclusions.find((e) => re.test(e.text));
}

describe("EPAM-style brief", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Managed Bug Bounty</h1>
      <section aria-labelledby="env">
        <h2 id="env">Testing Environment</h2>
        <p>*.lab.example.com and *.opensource.example.com are development environments and fake PII data can be used there.</p>
        <p>Our infrastructure is dynamically provisioned through automation and is frequently created and torn down.</p>
      </section>
      <section aria-labelledby="rules">
        <h2 id="rules">Program Rules</h2>
        <ul>
          <li>Automation against form submissions is not allowed and can lead to a ban.</li>
        </ul>
      </section>
      <section aria-labelledby="oosv">
        <h2 id="oosv">Out-of-Scope Vulnerabilities</h2>
        <ul>
          <li>Business Logic Flaws: Issues in business processes that do not have demonstrable security impact.</li>
          <li>External Service Interactions: Interactions with external services that do not demonstrate security impact.</li>
          <li>Self-XSS: Self-inflicted XSS without realistic threat.</li>
          <li>CSRF: On unauthenticated forms or forms that do not perform sensitive actions.</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("creates no PII fact from 'fake PII data can be used'", () => {
    expect(data.techniques.some((t) => t.baseName === "PII access")).toBe(false);
  });

  it("creates no automation fact from the infrastructure lifecycle sentence", () => {
    expect(
      data.techniques.some(
        (t) =>
          t.baseName === "automation" &&
          t.quote.includes("provisioned through automation"),
      ),
    ).toBe(false);
  });

  it("narrows the form-submission automation ban to the scoped activity", () => {
    const form = data.techniques.find((t) =>
      t.quote.includes("form submissions"),
    );
    expect(form).toBeDefined();
    expect(form!.name).toBe("automation (against form submissions)");
    expect(form!.status).toBe("prohibited");
    // Never a blanket automation prohibition.
    expect(
      data.techniques.some(
        (t) => t.baseName === "automation" && t.name === "automation",
      ),
    ).toBe(false);
  });

  it("keeps out-of-scope vulnerability classes excluded-but-unspecified", () => {
    for (const re of [
      /Business Logic Flaws/,
      /External Service Interactions/,
      /Self-XSS/,
      /CSRF/,
    ]) {
      const e = exclusion(data, re);
      expect(e, String(re)).toBeDefined();
      expect(e!.submissionStatus).toBe("excluded");
      expect(e!.testingStatus).toBe("unspecified");
    }
    // None of them produced a technique permission fact.
    for (const e of data.exclusions) {
      expect(
        data.techniques.some((t) => t.quote === e.text),
      ).toBe(false);
    }
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});

describe("Statuspage-style brief", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Statuspage-like Bug Bounty</h1>
      <section aria-labelledby="scope">
        <h2 id="scope">Scope</h2>
        <p>Anything not declared as a target or in scope above should be considered out of scope.</p>
      </section>
      <section aria-labelledby="rules">
        <h2 id="rules">Program Rules</h2>
        <ul>
          <li>The use of automated scanners is strictly prohibited.</li>
        </ul>
      </section>
      <section aria-labelledby="oosv">
        <h2 id="oosv">Out-of-Scope Vulnerabilities</h2>
        <ul>
          <li>Known vulnerabilities in used third-party libraries are excluded unless exploitability can be demonstrated.</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("reads the not-declared boundary as scope authorization", () => {
    expect(data.scopeAuthorization).not.toBeNull();
    expect(data.scopeAuthorization!.listedTargets.status).toBe("conditional");
    expect(
      data.scopeAuthorization!.listedTargets.conditions.join(" "),
    ).toMatch(/declared|listed|in scope/i);
    expect(data.scopeAuthorization!.unlistedTargets.status).toBe("prohibited");
  });

  it("narrows the automated-scanners ban without a blanket automation fact", () => {
    const scanners = data.techniques.find((t) =>
      t.quote.includes("automated scanners"),
    );
    expect(scanners).toBeDefined();
    expect(scanners!.status).toBe("prohibited");
    expect(scanners!.name).toBe("automated scanners");
    expect(
      data.techniques.some(
        (t) => t.baseName === "automation" && t.name === "automation",
      ),
    ).toBe(false);
  });

  it("keeps the third-party library rule an exclusion, not a permission", () => {
    const e = exclusion(data, /third-party libraries/);
    expect(e).toBeDefined();
    expect(e!.submissionStatus).toBe("excluded");
    expect(e!.testingStatus).toBe("unspecified");
    expect(data.techniques.some((t) => t.baseName === "third-party")).toBe(
      false,
    );
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});

describe("Zendesk-style brief", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Zendesk-like Bug Bounty</h1>
      <section aria-labelledby="valid">
        <h2 id="valid">Valid Submissions</h2>
        <ul>
          <li>Indirect &amp; Exploitable Prompt Injection: Using nested, encoded, or third-party data inputs to manipulate the agent.</li>
        </ul>
      </section>
      <section aria-labelledby="rules">
        <h2 id="rules">Program Rules</h2>
        <ul>
          <li>Denial of service attacks are prohibited.</li>
          <li>Social engineering is prohibited.</li>
          <li>Please use only other accounts that you own.</li>
        </ul>
      </section>
      <section aria-labelledby="oosv">
        <h2 id="oosv">Out-of-Scope Vulnerabilities</h2>
        <ul>
          <li>Pure Alignment Quirks — will be closed as Not Applicable.</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("creates no third-party fact from 'third-party data inputs'", () => {
    expect(data.techniques.some((t) => t.baseName === "third-party")).toBe(
      false,
    );
  });

  it("keeps 'closed as Not Applicable' excluded-but-unspecified", () => {
    const e = exclusion(data, /Pure Alignment Quirks/);
    expect(e).toBeDefined();
    expect(e!.submissionStatus).toBe("excluded");
    expect(e!.testingStatus).toBe("unspecified");
  });

  it("keeps the real explicit rules", () => {
    const dos = data.techniques.find((t) => t.baseName === "denial of service");
    expect(dos?.status).toBe("prohibited");
    const se = data.techniques.find((t) => t.baseName === "social engineering");
    expect(se?.status).toBe("prohibited");
    const cross = data.techniques.find(
      (t) => t.baseName === "cross-account testing",
    );
    expect(cross?.status).toBe("conditional");
    expect(cross?.conditions.join(" ")).toContain("accounts that you own");
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});
