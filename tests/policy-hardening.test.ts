// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  statusOfSentence,
  techniqueFindingsIn,
  testingStatusOf,
} from "../lib/model/policyText";
import { buildPermissionFact, type AssertionInput } from "../lib/model/facts";
import { collectPolicies } from "../lib/dom/policies";
import { assertRecordsWellFormed, PAGE_URL } from "./helpers/dom";

// ---------------------------------------------------------------------------
// Live-counterexample regression coverage (§3–§18). The sentences below are
// verbatim from Atlassian, Mastercard, Rapyd, Okta, and LastPass briefs; the
// invariants they pin are generic semantics, not program names: negative-
// subject polarity, governed-span permissions, eligibility isolation,
// subsection range boundaries, maximal-span technique identity, and
// no-fake-conflict aggregation. LastPass is the golden control.
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

// ---------------------------------------------------------------------------
// P0: "No X is/are allowed" — the negative determiner on the subject reverses
// the polarity of the affirmative permission predicate.
// ---------------------------------------------------------------------------
describe("negated-subject permission polarity", () => {
  it.each([
    "No pivoting or post exploitation attacks (i.e. using a vulnerability to find another vulnerability) are allowed on this program.",
    "No automated scans are allowed.",
    "No pivoting is permitted.",
    "No destructive testing is authorized.",
    "No credential stuffing is allowed.",
    "No exploitation beyond PoC is permitted.",
    "Neither scanning nor probing is allowed.",
    "None of these techniques are permitted.",
  ])("reads a negated subject as prohibition: %s", (s) => {
    expect(statusOfSentence(s)).toBe("prohibited");
  });

  it("never emits allowed from the Atlassian pivoting text", () => {
    expect(
      testingStatusOf(
        "No pivoting or post exploitation attacks " +
          "(i.e. using a vulnerability to find another vulnerability) " +
          "are allowed on this program. " +
          "DO NOT under any circumstance leverage a finding to identify further issues.",
      ),
    ).toBe("prohibited");
  });

  it("does not turn unrelated 'no' phrases into prohibitions or allowances", () => {
    // Existential "no evidence" neither prohibits nor grants: fail closed.
    expect(
      statusOfSentence("There is no evidence that scanning is allowed."),
    ).toBeNull();
    expect(statusOfSentence("No more than 5 requests are allowed.")).not.toBe(
      "prohibited",
    );
  });
});

// ---------------------------------------------------------------------------
// P0: account/resource setup permission is not a testing grant — a "you may"
// that governs account creation cannot authorize testing the excluded asset.
// ---------------------------------------------------------------------------
describe("account/setup permission veto", () => {
  it("never authorizes an out-of-scope resource via account setup", () => {
    expect(
      testingStatusOf(
        "The APIs for the developer portal are fully out of scope for this. " +
          "You may either use an existing account, " +
          "or create new users as needed using your @bugcrowdninja.com address.",
      ),
    ).toBe("unspecified");
    expect(
      statusOfSentence("You may use your @bugcrowdninja.com email address."),
    ).toBeNull();
    expect(
      statusOfSentence(
        "Each researcher may create one account per in-scope application.",
      ),
    ).toBeNull();
  });

  it("keeps real testing grants allowed", () => {
    expect(statusOfSentence("You may test the listed targets.")).toBe("allowed");
    expect(
      statusOfSentence("Automated tooling is allowed for reconnaissance."),
    ).toBe("allowed");
    expect(
      statusOfSentence("Researchers are permitted to test the API."),
    ).toBe("allowed");
    expect(statusOfSentence("You may use automated tools.")).toBe("allowed");
  });
});

// ---------------------------------------------------------------------------
// P0: reward eligibility is not a testing rule.
// ---------------------------------------------------------------------------
describe("eligibility frame", () => {
  it("reward eligibility never creates a testing status", () => {
    expect(
      statusOfSentence(
        "Only the latest version of a Data Center product is eligible for a reward.",
      ),
    ).toBeNull();
    expect(
      testingStatusOf(
        "Only the latest version of a Data Center product " +
          "is eligible for a reward. " +
          "All vulnerabilities/exploits must be proven to work " +
          "in the latest version of the Atlassian Data Center product.",
      ),
    ).toBe("unspecified");
  });
});

// ---------------------------------------------------------------------------
// P1: "will not be tolerated" is an explicit prohibition when it governs
// researcher activity.
// ---------------------------------------------------------------------------
describe("tolerated-prohibition family", () => {
  it("reads 'will not be tolerated' as a prohibition", () => {
    expect(
      statusOfSentence(
        "Automated scanning against any contact/submission form will not be tolerated",
      ),
    ).toBe("prohibited");
    expect(statusOfSentence("Credential stuffing is not tolerated.")).toBe(
      "prohibited",
    );
  });
});

// ---------------------------------------------------------------------------
// P1: technique identity keeps the maximal meaningful span.
// ---------------------------------------------------------------------------
describe("technique identity specificity", () => {
  it("keeps the object noun phrase — no generic third-party fact", () => {
    const findings = techniqueFindingsIn(
      "Submit any necessary screenshots, screen captures, network requests, " +
        "reproduction steps, or similar using the Bugcrowd submission form " +
        "(do not use third-party file-sharing sites).",
    );
    expect(findings.some((f) => f.name === "third-party")).toBe(false);
    const narrow = findings.find(
      (f) => f.name === "third-party file-sharing sites",
    );
    expect(narrow).toBeDefined();
    expect(narrow!.status).toBe("prohibited");
  });

  it("narrows 'port scanning internal networks' — no blanket scanning fact", () => {
    const findings = techniqueFindingsIn(
      "If you have managed to compromise an Okta-owned server, " +
        "we do not allow escalations such as " +
        "port scanning internal networks, " +
        "privilege escalation attempts, " +
        "attempting to pivot to other systems.",
    );
    expect(findings.some((f) => f.name === "scanning")).toBe(false);
    const port = findings.find(
      (f) => f.name === "port scanning internal networks",
    );
    expect(port).toBeDefined();
    expect(port!.status).toBe("prohibited");
  });

  it("preserves the post-compromise context on the narrow fact", () => {
    const findings = techniqueFindingsIn(
      "If you have managed to compromise an Okta-owned server, " +
        "we do not allow escalations such as port scanning internal networks.",
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.contexts.join(" ")).toContain(
      "compromise an Okta-owned server",
    );
    expect(findings[0]!.applicability).toEqual({
      type: "conditional_context",
      conditions: [{ kind: "phase", value: "post_compromise" }],
    });
  });

  it("reads the antecedent through a discourse marker without a comma", () => {
    // Live Okta phrasing: "However, if ... server we do not allow ..."
    const findings = techniqueFindingsIn(
      "However, if you have managed to compromise an Okta owned server " +
        "we do not allow for escalations such as " +
        "port scanning internal networks, privilege escalation attempts, " +
        "attempting to pivot to other systems, etc.",
    );
    const port = findings.find(
      (f) => f.name === "port scanning internal networks",
    );
    expect(port).toBeDefined();
    expect(port!.status).toBe("prohibited");
    expect(port!.applicability).toEqual({
      type: "conditional_context",
      conditions: [{ kind: "phase", value: "post_compromise" }],
    });
  });

  it("preserves an unknown antecedent verbatim instead of widening", () => {
    const findings = techniqueFindingsIn(
      "If the program announces a maintenance window, do not run scanners.",
    );
    const scan = findings.find((f) => f.name === "scanning");
    expect(scan).toBeDefined();
    expect(scan!.applicability).toEqual({
      type: "conditional_context",
      conditions: [
        {
          kind: "antecedent_text",
          text: "the program announces a maintenance window",
        },
      ],
    });
  });

  it("leaves rules without an antecedent engagement-wide", () => {
    const findings = techniqueFindingsIn(
      "The use of any automated tools or scanners is prohibited.",
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every((f) => f.applicability.type === "engagement"),
    ).toBe(true);
  });

  it("determines status per governed clause, not per sentence", () => {
    // The restrictive "only target" conditions its own clause; it must not
    // downgrade the explicit "do not attempt to access" prohibition that
    // governs the data-access span.
    const findings = techniqueFindingsIn(
      "When investigating a vulnerability, please only target your account " +
        "and do not attempt to access data from anyone else's account.",
    );
    const scoped = findings.find((f) =>
      f.name.includes("anyone else's account"),
    );
    expect(scoped).toBeDefined();
    expect(scoped!.status).toBe("prohibited");
    expect(scoped!.conditions).toEqual([]);
    expect(scoped!.applicability.type).toBe("engagement");
    expect(findings.some((f) => f.name === "PII access")).toBe(false);
  });

  it("keeps coordinated object lists in one clause", () => {
    // A list comma never separates the objects from their governing verb.
    const findings = techniqueFindingsIn(
      "Do not access customer or employee personal information, " +
        "credit card data, and Rapyd confidential information.",
    );
    expect(findings.length).toBe(3);
    expect(findings.every((f) => f.status === "prohibited")).toBe(true);
  });

  it("treats generic research framing as engagement-wide", () => {
    // "When investigating…", "during security testing…" restate the
    // activity; they are not antecedents that narrow a rule.
    for (const lead of [
      "When investigating a vulnerability",
      "During security testing",
      "While performing security research",
      "When testing the program",
    ]) {
      const findings = techniqueFindingsIn(
        `${lead}, do not access user data.`,
      );
      const f = findings.find((x) => x.name === "user data access");
      expect(f, lead).toBeDefined();
      expect(f!.status).toBe("prohibited");
      expect(f!.applicability.type, lead).toBe("engagement");
    }
  });

  it("still narrows a real situational antecedent", () => {
    const findings = techniqueFindingsIn(
      "If you compromise a server, do not run scanners.",
    );
    const f = findings.find((x) => x.name === "scanning");
    expect(f).toBeDefined();
    expect(f!.applicability).toEqual({
      type: "conditional_context",
      conditions: [{ kind: "phase", value: "post_compromise" }],
    });
  });

  it("keeps earlier narrowed forms stable", () => {
    expect(
      techniqueFindingsIn("Automated scanning is prohibited.").map((f) => f.name),
    ).toEqual(["automated scanning"]);
    expect(
      techniqueFindingsIn("The use of automated scanners is strictly prohibited.")
        .map((f) => f.name),
    ).toEqual(["automated scanners"]);
    expect(
      techniqueFindingsIn(
        "Automation against form submissions is not allowed and can lead to a ban.",
      ).map((f) => f.name),
    ).toEqual(["automation (against form submissions)"]);
    expect(
      techniqueFindingsIn("Scanning of out-of-scope assets is prohibited.")
        .map((f) => f.name),
    ).toEqual(["scanning (of out-of-scope assets)"]);
  });
});

// ---------------------------------------------------------------------------
// P1: coordinated data-access objects are separate facts — different
// resource/action rules must not collide into one bucket and fake a conflict.
// ---------------------------------------------------------------------------
describe("data-access object splitting", () => {
  it("splits a coordinated object list into separate prohibitions", () => {
    const findings = techniqueFindingsIn(
      "Do not access customer or employee personal information, " +
        "credit card data, and Rapyd confidential information.",
    );
    const names = findings.map((f) => f.name);
    expect(names).toContain("customer or employee personal information access");
    expect(names).toContain("credit card data access");
    expect(names).toContain("rapyd confidential information access");
    expect(names).not.toContain("PII access");
    expect(findings.every((f) => f.status === "prohibited")).toBe(true);
  });

  it("keeps a broad PII fact for direct PII language", () => {
    // Suppression applies only when evidence resolves to a narrower,
    // non-equivalent resource or ownership boundary — a rule that
    // directly governs PII keeps the canonical bucket.
    const direct = techniqueFindingsIn(
      "Access to personally identifiable information is prohibited.",
    );
    const pii = direct.find((f) => f.name === "PII access");
    expect(pii).toBeDefined();
    expect(pii!.status).toBe("prohibited");
    const imperative = techniqueFindingsIn("Do not access PII.");
    expect(
      imperative.some((f) => f.name.toLowerCase() === "pii access"),
    ).toBe(true);
    const approval = techniqueFindingsIn(
      "Personal information may be accessed only with prior approval.",
    );
    expect(approval.some((f) => f.name === "PII access")).toBe(true);
  });

  it("own-account and data-access rules never share a fact key", () => {
    const own = techniqueFindingsIn(
      "Only test on accounts you own. " +
        "Do not attempt to access other merchants.",
    );
    const scoped = techniqueFindingsIn(
      "When investigating a vulnerability, please only target your account " +
        "and do not attempt to access data from anyone else's account.",
    );
    const data = techniqueFindingsIn(
      "Do not access customer or employee personal information, " +
        "credit card data, and Rapyd confidential information.",
    );
    const cross = own.find((f) => f.name === "cross-account testing");
    expect(cross).toBeDefined();
    expect(cross!.status).toBe("conditional");
    // Account-scoped data access resolves to its own narrow identity —
    // never the broad PII bucket.
    expect(scoped.some((f) => f.name === "PII access")).toBe(false);
    const accountData = scoped.find((f) =>
      f.name.includes("anyone else's account"),
    );
    expect(accountData).toBeDefined();
    // Status is determined per governed clause: the restrictive "only
    // target" marks its own clause conditional; the "do not attempt to
    // access" clause is an explicit prohibition and keeps it.
    expect(accountData!.status).toBe("prohibited");
    expect(accountData!.conditions).toEqual([]);
    // "When investigating a vulnerability" is research framing — it does
    // not narrow the rule into a conditional context.
    expect(accountData!.applicability.type).toBe("engagement");
    // No fake PII conflict: distinct semantic resources → distinct keys.
    const byName = new Map<string, AssertionInput[]>();
    for (const f of [...own, ...data]) {
      const list = byName.get(f.name) ?? [];
      list.push({
        status: f.status,
        conditions: f.conditions,
        applies_to: { type: "engagement" },
        evidence: [],
      });
      byName.set(f.name, list);
    }
    for (const [name, assertions] of byName) {
      const fact = buildPermissionFact(assertions);
      expect(fact.conflict.detected, name).toBe(false);
    }
    expect(own.some((f) => f.baseName === "PII access")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural invariant: an "allowed" requires an explicit testing-governing
// grant; eligibility/setup/negated subjects can never produce one.
// ---------------------------------------------------------------------------
describe("false-ALLOW structural invariants", () => {
  it("allowed never comes from negation, setup, or eligibility language", () => {
    const neverAllowed = [
      "No pivoting or post exploitation attacks are allowed on this program.",
      "No automated scans are allowed.",
      "You may either use an existing account, or create new users.",
      "You may use your @bugcrowdninja.com email address.",
      "Only the latest version of a Data Center product is eligible for a reward.",
      "These findings are not eligible for a reward.",
      "Self-XSS reports will not be accepted.",
      "Clickjacking on pages without sensitive actions is out of scope.",
    ];
    for (const s of neverAllowed) {
      expect(testingStatusOf(s), s).not.toBe("allowed");
      expect(testingStatusOf(s), s).not.toBe("conditional");
    }
  });

  it("allowed requires the grant to govern a testing action", () => {
    for (const s of [
      "You may test the listed targets.",
      "Automated scanning is allowed.",
      "Third-party tools may be used for testing.",
      "Researchers are permitted to test the API.",
    ]) {
      expect(testingStatusOf(s), s).toBe("allowed");
    }
  });
});

// ---------------------------------------------------------------------------
// Live-shape DOM regression: realistic section markup, not just sentences.
// ---------------------------------------------------------------------------
describe("Atlassian live-shape exclusions", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Atlassian-like Bug Bounty</h1>
      <section aria-labelledby="oosv">
        <h2 id="oosv">Out of Scope</h2>
        <ul>
          <li>No pivoting or post exploitation attacks (i.e. using a vulnerability to find another vulnerability) are allowed on this program. DO NOT under any circumstance leverage a finding to identify further issues.</li>
          <li>Only the latest version of a Data Center product is eligible for a reward. All vulnerabilities/exploits must be proven to work in the latest version of the Atlassian Data Center product.</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("reads the pivoting exclusion as testing-prohibited, never allowed", () => {
    const e = exclusion(data, /pivoting/);
    expect(e).toBeDefined();
    expect(e!.submissionStatus).toBe("excluded");
    expect(e!.testingStatus).toBe("prohibited");
  });

  it("keeps reward eligibility out of the testing axis", () => {
    const e = exclusion(data, /eligible for a reward/);
    expect(e).toBeDefined();
    expect(e!.submissionStatus).toBe("excluded");
    expect(e!.testingStatus).toBe("unspecified");
    expect(e!.rewardStatus).toBe("unspecified");
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});

describe("Mastercard live-shape brief", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Mastercard-like Bug Bounty</h1>
      <section aria-labelledby="oos">
        <h2 id="oos">Out of Scope Targets</h2>
        <ul>
          <li>All Available Mastercard Developer APIs (The APIs for the developer portal are fully out of scope for this. You may either use an existing account, or create new users as needed using your @bugcrowdninja.com address.)</li>
        </ul>
      </section>
      <section aria-labelledby="vulns">
        <h2 id="vulns">In-scope &amp; Out of scope Vulnerabilities:</h2>
        <p>In-scope focused vulnerabilities:</p>
        <ul>
          <li>Cross Site Scripting</li>
          <li>Cross Site Request Forgery</li>
          <li>Insecure direct object references</li>
          <li>Injection Vulnerabilities</li>
          <li>Authentication Vulnerabilities</li>
          <li>Server-side Code Execution</li>
          <li>Privilege Escalation</li>
          <li>Significant Security Misconfiguration</li>
        </ul>
        <p>Out of Scope vulnerabilities specifically excluded from the bounty:</p>
        <ul>
          <li>Pivoting</li>
          <li>scanning</li>
          <li>vulnerability exploitation</li>
          <li>Exfiltration</li>
          <li>Email spoofing</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("account-setup permission never authorizes the excluded Developer APIs", () => {
    const e = exclusion(data, /Developer APIs/);
    expect(e).toBeDefined();
    expect(e!.submissionStatus).toBe("excluded");
    expect(e!.testingStatus).not.toBe("allowed");
    expect(e!.testingStatus).toBe("unspecified");
  });

  it("splits in-scope and out-of-scope ranges by semantic markers", () => {
    for (const f of [
      "Cross Site Scripting",
      "Cross Site Request Forgery",
      "Insecure direct object references",
      "Injection Vulnerabilities",
      "Privilege Escalation",
      "Significant Security Misconfiguration",
    ]) {
      expect(data.focusAreas, f).toContain(f);
    }
    const texts = data.exclusions.map((e) => e.text);
    for (const t of [
      "Pivoting",
      "scanning",
      "vulnerability exploitation",
      "Exfiltration",
      "Email spoofing",
    ]) {
      expect(texts, t).toContain(t);
    }
    for (const f of data.focusAreas) {
      expect(texts, f).not.toContain(f);
    }
  });

  it("focus areas never become testing permissions", () => {
    // In-scope focus items are guidance, not grants: no technique fact may
    // quote them, and no exclusion flips to allowed.
    for (const f of data.focusAreas) {
      expect(data.techniques.some((t) => t.quote === f)).toBe(false);
    }
    expect(data.exclusions.every((e) => e.testingStatus !== "allowed")).toBe(
      true,
    );
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});

describe("Rapyd live-shape brief", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Rapyd-like Bug Bounty</h1>
      <section aria-labelledby="rules">
        <h2 id="rules">Program Rules</h2>
        <ul>
          <li>Only test on accounts you own — do not attempt to access other merchants.</li>
          <li>When investigating a vulnerability, please only target your account and do not attempt to access data from anyone else's account.</li>
          <li>Do not access customer or employee personal information, credit card data, and Rapyd confidential information. If you accidentally access any of these, stop testing and submit the vulnerability.</li>
          <li>Automated scanning against any contact/submission form will not be tolerated.</li>
        </ul>
      </section>
      <section aria-labelledby="reporting">
        <h2 id="reporting">Reporting Requirements</h2>
        <ul>
          <li>Submit any necessary screenshots, screen captures, network requests, reproduction steps, or similar using the Bugcrowd submission form (do not use third-party file-sharing sites).</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("never emits a generic third-party prohibition", () => {
    expect(data.techniques.some((t) => t.name === "third-party")).toBe(false);
    const share = data.techniques.find(
      (t) => t.name === "third-party file-sharing sites",
    );
    expect(share).toBeDefined();
    expect(share!.status).toBe("prohibited");
  });

  it("splits own-account and data-access rules without a fake conflict", () => {
    const cross = data.techniques.find((t) => t.name === "cross-account testing");
    expect(cross).toBeDefined();
    expect(cross!.status).toBe("conditional");
    expect(cross!.conditions.join(" ")).toContain("accounts you own");
    // Ownership/cross-account evidence is not a PII permission — the broad
    // bucket key must not survive when the action resolves to a narrower
    // account-scoped identity.
    expect(data.techniques.some((t) => t.name === "PII access")).toBe(false);
    // The account-scoped access rule is an explicit prohibition in its own
    // clause — never the "only target" clause's conditional, and never
    // narrowed by research framing.
    const accountData = data.techniques.find((t) =>
      t.name.includes("anyone else's account"),
    );
    expect(accountData).toBeDefined();
    expect(accountData!.status).toBe("prohibited");
    expect(accountData!.applicability.type).toBe("engagement");
    const names = data.techniques.map((t) => t.name);
    for (const n of [
      "customer or employee personal information access",
      "credit card data access",
      "rapyd confidential information access",
    ]) {
      expect(names).toContain(n);
      const rows = data.techniques.filter((t) => t.name === n);
      expect(rows.every((r) => r.status === "prohibited")).toBe(true);
    }
    // No fact key carries incompatible asserted statuses.
    const statuses = new Map<string, Set<string>>();
    for (const t of data.techniques) {
      const set = statuses.get(t.name) ?? new Set<string>();
      set.add(t.status);
      statuses.set(t.name, set);
    }
    for (const [name, set] of statuses) {
      expect(set.size, name).toBe(1);
    }
  });

  it("reads 'will not be tolerated' as a narrow prohibition", () => {
    const scan = data.techniques.find((t) =>
      t.name.includes("contact/submission form"),
    );
    expect(scan).toBeDefined();
    expect(scan!.status).toBe("prohibited");
    expect(scan!.name).toContain("automated scanning");
    expect(data.techniques.some((t) => t.name === "scanning")).toBe(false);
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});

describe("Okta live-shape brief", () => {
  const { records, data } = collectPolicies(
    doc(`
      <h1>Okta-like Bug Bounty</h1>
      <section aria-labelledby="rules">
        <h2 id="rules">Program Rules</h2>
        <ul>
          <li>The use of any automated tools or scanners is prohibited.</li>
          <li>No automated scanning.</li>
          <li>Do NOT perform any type of burp scans or scanners.</li>
          <li>Chaining of bugs is not frowned upon in any way, we love to see clever exploit chains! However, if you have managed to compromise an Okta owned server we do not allow for escalations such as port scanning internal networks, privilege escalation attempts, attempting to pivot to other systems, etc.</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("keeps the blanket automated-tool prohibitions engagement-wide", () => {
    const names = data.techniques.map((t) => t.name);
    expect(names).toContain("automated tools");
    expect(names).toContain("automated scanners");
    expect(names).toContain("automated scanning");
    for (const n of [
      "automated tools",
      "automated scanners",
      "automated scanning",
    ]) {
      const row = data.techniques.find((t) => t.name === n)!;
      expect(row.status).toBe("prohibited");
      // The post-compromise antecedent must not bleed into global rules.
      expect(row.applicability.type).toBe("engagement");
    }
  });

  it("narrows post-compromise port scanning — no blanket scanning fact", () => {
    expect(data.techniques.some((t) => t.name === "scanning")).toBe(false);
    const port = data.techniques.find(
      (t) => t.name === "port scanning internal networks",
    );
    expect(port).toBeDefined();
    expect(port!.status).toBe("prohibited");
    expect(port!.contexts.join(" ")).toContain(
      "compromise an Okta owned server",
    );
    // The prohibition is scoped to the post-compromise context — never
    // silently widened to the whole engagement.
    expect(port!.applicability).toEqual({
      type: "conditional_context",
      conditions: [{ kind: "phase", value: "post_compromise" }],
    });
  });

  it("emits only well-formed records", () => {
    assertRecordsWellFormed(records);
  });
});

describe("LastPass golden control", () => {
  const { data } = collectPolicies(
    doc(`
      <h1>LastPass-like Bug Bounty</h1>
      <section aria-labelledby="rules">
        <h2 id="rules">Program Rules</h2>
        <ul>
          <li>When using automated tools, the requests should be limited to a maximum of 5 requests per second.</li>
        </ul>
      </section>
    `),
    PAGE_URL,
  );

  it("keeps the 5 req/s conditional on automated tools", () => {
    const tools = data.techniques.find((t) => t.name === "automated tools");
    expect(tools).toBeDefined();
    expect(tools!.status).toBe("conditional");
    expect(tools!.conditions.join(" ")).toContain(
      "a maximum of 5 requests per second",
    );
  });
});
