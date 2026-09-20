import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { exportFileName } from "../lib/ids";
import type { DocumentModel } from "../lib/model/document";
import type { Evidence, PermissionFact } from "../lib/types";
import {
  escapeMd,
  mdTable,
  renderAgentFacts,
  renderMarkdown,
} from "../lib/render/markdown";
import { renderFrontMatter } from "../lib/render/frontMatter";

function evidence(
  id: string,
  sourceKey: string,
  quote: string,
  type: "api" | "dom" = "dom",
): Evidence {
  return {
    id,
    source_key: sourceKey,
    source: {
      url: "https://bugcrowd.com/engagements/acme",
      type,
      authenticated: true,
    },
    locator: { section: "Program Rules" },
    source_level: "explicit_program_rule",
    collected_at: "2026-09-20T01:10:22+07:00",
    quote,
    content_hash: `sha256:${"a".repeat(64)}`,
    extraction: { status: "exact", parser_version: "2.0.0" },
  };
}

function permissionFact(): PermissionFact {
  return {
    status: "conditional",
    conditions: [{ id: "condition_001", text: "Only against listed targets." }],
    applies_to: { type: "target_ids", ids: ["target_1"] },
    evidence_refs: ["ev_rule"],
    conflict: { detected: false, evidence_refs: [], asserted_statuses: [] },
    extraction: { status: "exact" },
  };
}

function model(): DocumentModel {
  return {
    schema_version: 2,
    generated_at: "2026-09-20T02:00:00+07:00",
    job_id: "job_test",
    engagement: {
      name: "Acme *Bounty*",
      code: "acme",
      uuid: "uuid-1",
      canonicalUrl: "https://bugcrowd.com/engagements/acme",
      type: "Bug Bounty",
      managedBounty: true,
      lifecycleStatus: "live",
      testingStart: "2026-01-01",
      testingEnd: null,
      testingPeriodLabel: "Ongoing",
      lastStatusTransition: "2026-01-01",
      lastBriefUpdate: "2026-09-19",
      safeHarbor: {
        status: "present",
        level: "Full",
        evidence_refs: ["ev_safe"],
      },
      disclosurePolicy: "Coordinated disclosure",
    },
    statistics: {
      participants: { value: "10", window: null },
      average_payout: { value: "$500", window: "90d" },
    },
    targets: [
      {
        id: "target_1",
        id_source: "derived",
        identity_quality: "exact_location",
        location: "https://app.example.com/a|b",
        name: "App [prod]",
        category: "website",
        tags: ["prod", "web"],
        docLinks: ["https://docs.example.com/rules"],
        changeFlags: [],
        inScope: true,
        groupId: "group_web",
      },
      {
        id: "target_2",
        id_source: "derived",
        identity_quality: "name_fallback",
        location: null,
        name: "Legacy",
        category: "other",
        tags: [],
        docLinks: [],
        changeFlags: [],
        inScope: false,
        groupId: "group_legacy",
      },
    ],
    targetGroups: [
      {
        id: "group_web",
        name: "Web",
        inScope: true,
        description: "Primary web apps",
        rewards: { p1: 1000, p2: 500, p3: null, p4: 100, p5: 50 },
      },
    ],
    outOfScope: [{ location: null, name: "Legacy", notes: "Do not test" }],
    techniques: { automated_scanning: permissionFact() },
    accountRules: [{ text: "Use `your-own` account.", evidence_refs: ["ev_account"] }],
    dataRules: [
      {
        text: "Read [data handling](https://docs.example.com/data).\n# Keep data minimal",
        evidence_refs: ["ev_data"],
      },
    ],
    focusAreas: ["XSS"],
    nonFocusAreas: ["CSRF", "DoS is not permitted"],
    submissionExclusions: [
      {
        text: "CSRF",
        submission_status: "excluded" as const,
        testing_status: "unspecified" as const,
        reward_status: "unspecified" as const,
        evidence_refs: ["ev_csrf"],
      },
      {
        text: "DoS is not permitted",
        submission_status: "excluded" as const,
        testing_status: "prohibited" as const,
        reward_status: "unspecified" as const,
        evidence_refs: [],
      },
    ],
    scopeAuthorization: {
      listed_targets: {
        status: "conditional" as const,
        conditions: ["the targets listed as in scope"],
      },
      unlisted_targets: { status: "prohibited" as const },
      quote: "Testing is only authorized on the targets listed as in scope.",
      evidence_refs: ["ev_scope_auth"],
    },
    reportingRequirements: ["Include a reproducible PoC"],
    vrt: {
      version: "2.0",
      baseline: "P3",
      scope_rules: [
        {
          category: "Application-Level Denial-of-Service (DoS)",
          vrt_version: "1.18",
          applies_to: "All targets",
          status: "out_of_scope" as const,
          note: null,
          evidence_refs: ["ev_vrt_dos"],
        },
      ],
      exclusions: ["Self-XSS"],
      deviations: [],
      targetSpecific: ["API target uses P2"],
      notes: [],
      evidence_refs: ["ev_vrt"],
    },
    knownIssues: [
      {
        targetId: "target_1",
        displayedCount: 2,
        collectedCount: 1,
        countMatches: false,
        columns: ["Priority", "Variant|Type"],
        rows: [{ cells: ["P1", "Stored XSS"] }],
        evidence_refs: ["ev_ki"],
      },
    ],
    announcements: [
      {
        kind: "announcement",
        title: "New target",
        body: "See [details](https://example.com/notice).",
        timestamp: "2026-09-01",
        sourceUrl: "https://example.com/notice",
      },
    ],
    changelog: [],
    recentActivity: [
      {
        kind: "activity",
        title: null,
        body: "Payout issued",
        timestamp: "2026-09-02",
        sourceUrl: null,
      },
    ],
    acceptedReports: [],
    evidence: [
      evidence("ev_api", "api:engagement:acme", "API value", "api"),
      evidence("ev_safe", "dom:details:safe-harbor", "Safe harbor applies."),
      evidence(
        "ev_auth",
        "dom:details:authorization",
        "Testing is authorized under the listed conditions.",
      ),
      evidence("ev_rule", "dom:details:rule", "Automated scanning is conditional."),
    ],
    collection: {
      status: "partial",
      api_status: "complete",
      dom_status: "partial",
      parser_version: "2.0.0",
      evidence_corpus_hash: `sha256:${"b".repeat(64)}`,
      normalized_hash: `sha256:${"c".repeat(64)}`,
    },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: false,
      required_sections_complete: false,
    },
    quality: { warnings: ["ki_count_mismatch:target_1"] },
    policy: { conflicts_present: false, unresolved_conflicts: 0 },
    api: {
      api_major_target: "1",
      api_schema_tested: "1.1.0",
      observed_version: "1.1.0",
      status: "complete",
    },
    provenance: {
      parser_version: "2.0.0",
      collected_at: "2026-09-20T01:59:00+07:00",
      missing_sections: ["activity"],
      collection_issues: [
        {
          code: "known_issues:incomplete_counts",
          target_id: "target_1",
          displayed_count: 2,
          collected_count: 1,
        },
      ],
      conflicts: [],
    },
  };
}

describe("renderFrontMatter", () => {
  it("renders the required metadata as valid YAML", () => {
    const rendered = renderFrontMatter(model());
    expect(rendered.startsWith("---\n")).toBe(true);
    expect(rendered.endsWith("---\n")).toBe(true);
    const parsed = parseYaml(rendered.slice(4, -4));
    expect(parsed).toMatchObject({
      schema_version: 2,
      source: {
        canonical_url: "https://bugcrowd.com/engagements/acme",
        api_major_target: "1",
        api_schema_tested: "1.1.0",
        observed_version: "1.1.0",
      },
      engagement: { name: "Acme *Bounty*", code: "acme", uuid: "uuid-1" },
      collection: { status: "partial", api_status: "complete", dom_status: "partial" },
      integrity: { known_issues_counts_valid: false },
      quality: { warnings: ["ki_count_mismatch:target_1"] },
      policy: { conflicts_present: false, unresolved_conflicts: 0 },
    });
  });
});

describe("Markdown primitives", () => {
  it("escapes Markdown metacharacters and a leading heading marker", () => {
    expect(escapeMd("# *bold* [x](y) a|b \\ slash")).toBe(
      "\\# \\*bold\\* \\[x\\]\\(y\\) a\\|b \\\\ slash",
    );
  });

  it("escapes pipes inside table cells without changing column structure", () => {
    expect(mdTable(["A", "B"], [["x|y", "z"]])).toBe(
      "| A | B |\n| --- | --- |\n| x\\|y | z |",
    );
  });
});

describe("renderAgentFacts", () => {
  it("emits parseable YAML with only allowed permission statuses", () => {
    const block = renderAgentFacts(model());
    const parsed = parseYaml(block.replace(/^```yaml\n/, "").replace(/\n```$/, ""));
    const statuses = Object.values(parsed.techniques).map(
      (fact) => (fact as { status: string }).status,
    );
    expect(statuses.every((s) => ["allowed", "prohibited", "conditional", "unspecified"].includes(s))).toBe(true);
    expect(parsed.safe_harbor.status).toBe("present");
    expect(parsed.collection.status).toBe("partial");
  });

  it("separates submission eligibility from testing permission", () => {
    const block = renderAgentFacts(model());
    const parsed = parseYaml(block.replace(/^```yaml\n/, "").replace(/\n```$/, ""));
    expect(parsed.submission_exclusions).toEqual([
      { text: "CSRF", submission_status: "excluded", testing_status: "unspecified", reward_status: "unspecified", evidence_refs: ["ev_csrf"] },
      { text: "DoS is not permitted", submission_status: "excluded", testing_status: "prohibited", reward_status: "unspecified", evidence_refs: [] },
    ]);
    expect(parsed.authorized_scope.listed_targets.status).toBe("conditional");
    expect(parsed.authorized_scope.unlisted_targets.status).toBe("prohibited");
  });

  it("reports validation failures separately from missing sections", () => {
    const block = renderAgentFacts(model());
    const parsed = parseYaml(block.replace(/^```yaml\n/, "").replace(/\n```$/, ""));
    expect(parsed.collection_issues).toEqual([
      {
        code: "known_issues:incomplete_counts",
        target_id: "target_1",
        displayed_count: 2,
        collected_count: 1,
      },
    ]);
  });
});

describe("renderMarkdown", () => {
  it("shows both exclusion axes and the scope authorization", () => {
    const rendered = renderMarkdown(model());
    expect(rendered).toContain(
      "| CSRF | excluded | unspecified |",
    );
    expect(rendered).toContain("| DoS is not permitted | excluded | prohibited |");
    expect(rendered).toContain("Listed targets: conditional");
    expect(rendered).toContain("Unlisted targets: prohibited");
  });

  it("renders VRT scope rules as a table and exposes them to agents", () => {
    const rendered = renderMarkdown(model());
    expect(rendered).toContain("### Scope rules");
    expect(rendered).toContain("| All targets | out\_of\_scope |");
    const block = renderAgentFacts(model());
    const parsed = parseYaml(block.replace(/^```yaml\n/, "").replace(/\n```$/, ""));
    expect(parsed.vrt_scope_rules[0].status).toBe("out_of_scope");
  });

  it("gives each evidence object what an independent check needs", () => {
    // Recomputing the corpus hash from the file requires every field the hash
    // covers: the quote, where it came from, when, and under which parser.
    const rendered = renderMarkdown(model());
    const item = model().evidence[0]!;
    const block = rendered.slice(rendered.indexOf(`### ${item.id}`));
    expect(block).toContain(`- Content hash: ${escapeMd(item.content_hash)}`);
    expect(block).toContain(`- Collected at: ${escapeMd(item.collected_at)}`);
    expect(block).toContain(`- Source type: ${item.source.type}`);
    expect(block).toContain("- Authenticated: true");
    expect(block).toContain(
      `- Extraction: ${item.extraction.status} (parser ${escapeMd(item.extraction.parser_version)})`,
    );
  });

  it("lists collection issues under provenance", () => {
    const rendered = renderMarkdown(model());
    expect(rendered).toContain("### Collection issues");
    expect(rendered).toContain(
      `${escapeMd("known_issues:incomplete_counts")} — ${escapeMd("target_1")} (displayed 2, collected 1)`,
    );
  });

  it("renders the full dossier in spec order and deterministically", () => {
    const rendered = renderMarkdown(model());
    const headings = [
      "## Agent Facts",
      "## Engagement Overview",
      "## Authorization and Safe Harbor",
      "## Scope Inventory",
      "## Reward Matrix",
      "## Known Issues",
      "## VRT Policy",
      "## Testing, Account, Resource, and Data Constraints",
      "## Focus Areas / Explicit Exclusions",
      "## Credentials and Access",
      "## Reporting Requirements",
      "## Announcements and Changelog",
      "## Recent Activity, Participation, Response Statistics",
      "## Evidence Objects",
      "## Collection Provenance, Conflicts, Missing Sections, Warnings",
    ];
    let last = -1;
    for (const heading of headings) {
      const at = rendered.indexOf(heading);
      expect(at, heading).toBeGreaterThan(last);
      last = at;
    }
    expect(renderMarkdown(model())).toBe(rendered);
  });

  it("renders rewards, Known Issues mismatch, sorted evidence, and verbatim quotes", () => {
    const rendered = renderMarkdown(model());
    expect(rendered).toContain("| 1,000 | 500 | — | 100 | 50 |");
    expect(rendered).toContain("⚠ Count mismatch: displayed 2, collected 1");
    expect(rendered.indexOf("### ev_api")).toBeLessThan(rendered.indexOf("### ev_safe"));
    expect(rendered).toContain("> Testing is authorized under the listed conditions.");
    expect(rendered).toContain("[details](https://example.com/notice)");
    expect(rendered).toContain("Variant\\|Type");
  });

  it("does not emit credential-bearing authorization headers or token values", () => {
    const rendered = renderMarkdown(model());
    expect(rendered).not.toMatch(/Authorization\s*:/i);
    expect(rendered).not.toMatch(/Token\s+[A-Za-z0-9._~+\/-]{8,}/i);
  });

  it("uses the deterministic export filename contract", () => {
    expect(exportFileName(model().engagement.code, new Date(2026, 8, 20))).toBe(
      "bugcrowd-acme-2026-09-20.md",
    );
  });
});
