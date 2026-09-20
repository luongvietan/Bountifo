import { describe, expect, it } from "vitest";
import {
  assembleDocument,
  stripVolatile,
  type AssembleArgs,
  type DocumentModel,
} from "../lib/model/document";
import type { IntegrityReport } from "../lib/model/integrity";
import { normalizedHash } from "../lib/evidence";
import { DOCUMENT_SCHEMA_VERSION, PARSER_VERSION } from "../lib/constants";
import type { DetailsData } from "../lib/dom/details";
import type { DomRule, DomTarget, DomTargetGroup } from "../lib/dom/targets";
import type { PolicyData } from "../lib/dom/policies";
import type { KiResult } from "../lib/dom/knownIssues";
import type { ActivityItem } from "../lib/dom/activity";
import type { TargetIdentity } from "../lib/model/targetIds";
import type {
  ApiEngagementData,
  ApiTarget,
  ApiTargetGroup,
  Evidence,
  PermissionFact,
  SourceRecord,
} from "../lib/types";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function details(overrides: Partial<DetailsData> = {}): DetailsData {
  return {
    name: "Acme Bounty",
    code: "acme",
    engagementType: "Bug Bounty",
    managedBounty: true,
    lifecycleStatus: "dom-live",
    testingStart: "dom-start",
    testingEnd: "dom-end",
    testingPeriodLabel: "Ongoing",
    lastStatusTransition: "dom-transition",
    lastBriefUpdate: "dom-brief",
    safeHarborLevel: "Full safe harbor",
    disclosurePolicy: "Disclose responsibly",
    statistics: { participants: { value: "10", window: null } },
    ...overrides,
  };
}

function apiGroup(overrides: Partial<ApiTargetGroup> = {}): ApiTargetGroup {
  return {
    id: "api-g1",
    name: "Web",
    inScope: true,
    description: "api group desc",
    rewards: { p1: 500, p2: null, p3: 300, p4: 400, p5: 500 },
    ...overrides,
  };
}

function apiTarget(overrides: Partial<ApiTarget> = {}): ApiTarget {
  return {
    id: "api-t1",
    groupId: "api-g1",
    location: "api-location",
    name: "api name",
    category: "api category",
    tags: ["api-tag"],
    inScope: true,
    ...overrides,
  };
}

function api(overrides: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "uuid-1",
    name: "Acme API Name",
    code: "acme-api",
    engagementType: "api-type",
    managedBounty: false,
    lifecycleStatus: "api-live",
    testingStart: "api-start",
    testingEnd: "api-end",
    testingPeriodLabel: "api-label",
    lastStatusTransition: "api-transition",
    lastBriefUpdate: "api-brief",
    safeHarborLevel: "api-safe-harbor",
    statistics: {
      api_only_stat: { value: "42", window: "30d" },
      participants: { value: "99", window: null },
    },
    targetGroups: [apiGroup()],
    targets: [apiTarget()],
    observedApiVersion: "1.1.0",
    ...overrides,
  };
}

function domGroup(overrides: Partial<DomTargetGroup> = {}): DomTargetGroup {
  return {
    domKey: "group:web",
    name: "Web",
    inScope: true,
    description: "web desc",
    rewards: { p1: 100, p2: 200, p3: null, p4: 400, p5: 500 },
    ...overrides,
  };
}

function domTarget(overrides: Partial<DomTarget> = {}): DomTarget {
  return {
    domKey: "target:example-com",
    groupDomKey: "group:web",
    inScope: true,
    location: "https://example.com",
    name: "Example",
    category: "website",
    tags: ["prod"],
    docLinks: ["https://docs.example.com"],
    changeFlags: ["new"],
    displayedKnownIssuesCount: 1,
    kiControlLabel: "1 known issue",
    ...overrides,
  };
}

function identity(overrides: Partial<TargetIdentity> = {}): TargetIdentity {
  return {
    id: "api-t1",
    id_source: "api",
    identity_quality: "api",
    duplicate_disambiguated: false,
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyData> = {}): PolicyData {
  return {
    safeHarborStatements: ["We provide safe harbor"],
    authorizationStatements: ["Testing is authorized"],
    techniques: [],
    accountRules: ["Use your own account"],
    dataRules: ["Do not exfiltrate data"],
    focusAreas: ["XSS"],
    nonFocusAreas: ["CSRF"],
    exclusions: [
      {
        text: "CSRF",
        submissionStatus: "excluded" as const,
        testingStatus: "unspecified" as const,
      },
    ],
    scopeAuthorization: {
      listedTargets: {
        status: "conditional" as const,
        conditions: ["the targets listed as in scope"],
      },
      unlistedTargets: { status: "prohibited" as const },
      quote: "Testing is only authorized on the targets listed as in scope.",
    },
    reportingRequirements: ["Include a PoC"],
    vrt: {
      version: "2.0",
      baseline: "P3 default",
      exclusions: ["vrt exclusion"],
      deviations: ["vrt deviation"],
      targetSpecific: ["vrt target rule"],
      notes: ["vrt note"],
      scopeRules: [
        {
          category: "Application-Level Denial-of-Service (DoS)",
          vrtVersion: "1.18",
          appliesTo: "All targets",
          status: "out_of_scope" as const,
          note: null,
        },
      ],
    },
    ...overrides,
  };
}

function activityItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    kind: "announcement",
    title: "Announcement A",
    body: "body",
    timestamp: "2026-09-01",
    sourceUrl: "https://bugcrowd.com/engagements/acme",
    ...overrides,
  };
}

function kiResult(overrides: Partial<KiResult> = {}): KiResult {
  return {
    targetDomKey: "target:example-com",
    displayedCount: 1,
    collectedCount: 1,
    columns: ["Priority", "Variant"],
    rows: [{ cells: ["P1", "xss"], recognized: { priority: "P1" } }],
    skipped: false,
    countMatches: true,
    warnings: [],
    records: [],
    ...overrides,
  };
}

function fact(overrides: Partial<PermissionFact> = {}): PermissionFact {
  return {
    status: "allowed",
    conditions: [],
    applies_to: { type: "engagement" },
    evidence_refs: [],
    conflict: { detected: false, evidence_refs: [], asserted_statuses: [] },
    extraction: { status: "exact" },
    ...overrides,
  };
}

function ev(
  id: string,
  sourceKey: string,
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
    locator: {},
    source_level: "explicit_program_rule",
    collected_at: "2026-09-20T01:10:22+07:00",
    quote: `quote ${id}`,
    content_hash: `sha256:${id.padStart(8, "0").slice(0, 8)}${"a".repeat(56)}`,
    extraction: { status: "exact", parser_version: PARSER_VERSION },
  };
}

function rec(sourceKey: string, data: unknown): SourceRecord {
  return {
    sourceKey,
    sourceType: "dom",
    sourceLevel: "explicit_program_rule",
    sourceUrl: "https://bugcrowd.com/engagements/acme",
    authenticated: true,
    locator: {},
    quote: typeof data === "string" ? data : "q",
    extractionStatus: "exact",
    data,
  };
}

function integrityReport(
  overrides: Partial<IntegrityReport> = {},
): IntegrityReport {
  return {
    collection: {
      status: "complete",
      api_status: "complete",
      dom_status: "complete",
      parser_version: PARSER_VERSION,
      evidence_corpus_hash: `sha256:${"c".repeat(64)}`,
      normalized_hash: `sha256:${"d".repeat(64)}`,
    },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: true,
      required_sections_complete: true,
    },
    quality: { warnings: [] },
    policy: { conflicts_present: false, unresolved_conflicts: 0 },
    ...overrides,
  };
}

const VRT_RECS: SourceRecord[] = [
  rec("dom:details:vrt:version", "2.0"),
  rec("dom:details:vrt:baseline", "P3 default"),
  rec("dom:details:vrt:exclusion", "vrt exclusion"),
];

function baseArgs(overrides: Partial<AssembleArgs> = {}): AssembleArgs {
  return {
    jobId: "job_ab12cd34",
    generatedAt: "2026-09-20T02:00:00+07:00",
    collectedAt: "2026-09-20T01:59:00+07:00",
    canonicalUrl: "https://bugcrowd.com/engagements/acme",
    api: api(),
    details: details(),
    groups: [{ dom: domGroup(), api: apiGroup() }],
    targets: [{ dom: domTarget(), api: apiTarget(), identity: identity() }],
    rules: [
      {
        text: "do not touch the admin panel",
        appliesToDomKeys: ["target:admin"],
        level: "target_specific_rule",
      } satisfies DomRule,
    ],
    policy: policy(),
    activity: {
      announcements: [activityItem()],
      changelog: [activityItem({ kind: "changelog", title: "Change 1" })],
      recentActivity: [activityItem({ kind: "activity", title: null })],
      acceptedReports: [activityItem({ kind: "accepted_report" })],
      stats: { response_time: { value: "2d", window: null } },
    },
    kiResults: [{ result: kiResult(), targetId: "api-t1" }],
    techniques: { automation: fact() },
    safeHarbor: { status: "present", evidence_refs: ["ev_sh1"] },
    records: [
      rec("dom:details:account-rules:use-your-own-account", "Use your own account"),
      rec("dom:details:program-rules:do-not-exfiltrate", "Do not exfiltrate data"),
      ...VRT_RECS,
      rec("dom:ki:target:example-com", { columns: [], cells: ["P1"] }),
    ],
    evidence: [
      ev("ev_dom2", "dom:details:program-rules:do-not-exfiltrate"),
      ev("ev_api1", "api:engagement:acme", "api"),
      ev("ev_dom1", "dom:details:account-rules:use-your-own-account"),
      ev("ev_ki1", "dom:ki:target:example-com"),
      ev("ev_vrt", "dom:details:vrt:version"),
    ],
    integrity: integrityReport(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// stripVolatile
// ---------------------------------------------------------------------------

describe("stripVolatile", () => {
  it("drops exactly generated_at, job_id, and provenance.collected_at", async () => {
    const model = assembleDocument(baseArgs());
    const stripped = stripVolatile(model) as Record<string, unknown>;
    expect(stripped.generated_at).toBeUndefined();
    expect(stripped.job_id).toBeUndefined();
    expect(
      (stripped.provenance as Record<string, unknown>).collected_at,
    ).toBeUndefined();
    // Nothing else is removed — evidence stays, minus its own volatile
    // collected_at stamp (excluded from normalized_hash like the evidence
    // corpus hash projection).
    expect(stripped.schema_version).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(stripped.engagement).toEqual(model.engagement);
    expect(stripped.evidence).toEqual(
      model.evidence.map(({ collected_at: _drop, ...rest }) => rest),
    );
    expect(stripped.collection).toEqual(model.collection);
    expect(stripped.provenance).toEqual({
      parser_version: PARSER_VERSION,
      missing_sections: model.provenance.missing_sections,
      collection_issues: model.provenance.collection_issues,
      conflicts: model.provenance.conflicts,
    });
    // The input model is not mutated.
    expect(model.job_id).toBe("job_ab12cd34");
    expect(model.generated_at).toBe("2026-09-20T02:00:00+07:00");
    expect(model.provenance.collected_at).toBe("2026-09-20T01:59:00+07:00");
  });

  it("normalizedHash is identical for models differing only in volatile fields", async () => {
    const a = assembleDocument(baseArgs());
    const b = assembleDocument(
      baseArgs({
        jobId: "job_zz99yy88",
        generatedAt: "2030-01-01T00:00:00Z",
        collectedAt: "2030-01-01T00:00:01Z",
      }),
    );
    const hashA = await normalizedHash(stripVolatile(a));
    const hashB = await normalizedHash(stripVolatile(b));
    expect(hashA).toBe(hashB);
  });

  it("normalizedHash is identical when only evidence collected_at differs", async () => {
    const earlier = assembleDocument(baseArgs());
    const later = assembleDocument(
      baseArgs({
        jobId: "job_qq77rr88",
        generatedAt: "2031-05-05T05:05:05Z",
        collectedAt: "2031-05-05T05:05:00Z",
        evidence: [
          ev("ev_dom2", "dom:details:program-rules:do-not-exfiltrate"),
          ev("ev_api1", "api:engagement:acme", "api"),
          ev("ev_dom1", "dom:details:account-rules:use-your-own-account"),
          ev("ev_ki1", "dom:ki:target:example-com"),
          ev("ev_vrt", "dom:details:vrt:version"),
        ].map((e) => ({ ...e, collected_at: "2031-05-05T05:00:00Z" })),
      }),
    );
    expect(later.evidence[0]!.collected_at).toBe("2031-05-05T05:00:00Z");
    expect(await normalizedHash(stripVolatile(earlier))).toBe(
      await normalizedHash(stripVolatile(later)),
    );
  });

  it("normalizedHash differs when a non-volatile field differs", async () => {
    const a = assembleDocument(baseArgs());
    const b = assembleDocument(
      baseArgs({ details: details({ name: "Different Name" }) }),
    );
    expect(await normalizedHash(stripVolatile(a))).not.toBe(
      await normalizedHash(stripVolatile(b)),
    );
  });
});

// ---------------------------------------------------------------------------
// assembleDocument — shape
// ---------------------------------------------------------------------------

describe("assembleDocument — shape", () => {
  it("produces the versioned document model the renderer consumes", () => {
    const m = assembleDocument(baseArgs());
    expect(m.schema_version).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(m.generated_at).toBe("2026-09-20T02:00:00+07:00");
    expect(m.job_id).toBe("job_ab12cd34");
    expect(m.collection.status).toBe("complete");
    expect(m.integrity.required_sections_complete).toBe(true);
    expect(m.quality.warnings).toEqual([]);
    expect(m.policy.unresolved_conflicts).toBe(0);
    expect(m.api).toEqual({
      api_major_target: "V1",
      api_schema_tested: "1.1.0",
      observed_version: "1.1.0",
      status: "complete",
    });
    expect(m.provenance.parser_version).toBe(PARSER_VERSION);
    expect(m.provenance.collected_at).toBe("2026-09-20T01:59:00+07:00");
    expect(m.provenance.missing_sections).toEqual([]);
  });

  it("sorts evidence into corpus order (api before dom)", () => {
    const m = assembleDocument(baseArgs());
    expect(m.evidence.map((e) => e.id)).toEqual([
      "ev_api1",
      "ev_dom1",
      "ev_dom2",
      "ev_vrt",
      "ev_ki1",
    ]);
  });

  it("embeds integrity report blocks by reference of value", () => {
    const report = integrityReport({
      quality: { warnings: ["w"] },
      policy: { conflicts_present: true, unresolved_conflicts: 2 },
    });
    const m = assembleDocument(baseArgs({ integrity: report }));
    expect(m.quality.warnings).toEqual(["w"]);
    expect(m.policy).toEqual({
      conflicts_present: true,
      unresolved_conflicts: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// assembleDocument — §6.3 source precedence
// ---------------------------------------------------------------------------

describe("assembleDocument — spec §6.3 precedence", () => {
  it("API wins official uuid; null when enrichment absent", () => {
    const withApi = assembleDocument(baseArgs());
    expect(withApi.engagement.uuid).toBe("uuid-1");
    const noApi = assembleDocument(baseArgs({ api: null }));
    expect(noApi.engagement.uuid).toBeNull();
    expect(noApi.api.observed_version).toBeNull();
  });

  it("API wins lifecycle timestamps; DOM wins status/label fields", () => {
    const m = assembleDocument(baseArgs());
    // API-won fields (§6.3: lifecycle timestamps).
    expect(m.engagement.testingStart).toBe("api-start");
    expect(m.engagement.testingEnd).toBe("api-end");
    expect(m.engagement.lastStatusTransition).toBe("api-transition");
    expect(m.engagement.lastBriefUpdate).toBe("api-brief");
    // DOM-won fields (not in the §6.3 API list → researcher-visible DOM wins).
    expect(m.engagement.lifecycleStatus).toBe("dom-live");
    expect(m.engagement.testingPeriodLabel).toBe("Ongoing");
    expect(m.engagement.name).toBe("Acme Bounty");
    expect(m.engagement.type).toBe("Bug Bounty");
    expect(m.engagement.managedBounty).toBe(true);
    expect(m.engagement.disclosurePolicy).toBe("Disclose responsibly");
    expect(m.engagement.safeHarbor.level).toBe("Full safe harbor");
  });

  it("API fields fall back to DOM when the API value is null", () => {
    const m = assembleDocument(
      baseArgs({
        api: api({ testingStart: null, lastBriefUpdate: null }),
      }),
    );
    expect(m.engagement.testingStart).toBe("dom-start");
    expect(m.engagement.lastBriefUpdate).toBe("dom-brief");
  });

  it("DOM wins target location/tags; API fills only when DOM is empty", () => {
    const m = assembleDocument(baseArgs());
    const t = m.targets[0]!;
    expect(t.id).toBe("api-t1");
    expect(t.id_source).toBe("api");
    expect(t.location).toBe("https://example.com"); // DOM beats api-location
    expect(t.name).toBe("Example"); // DOM beats "api name"
    expect(t.category).toBe("website"); // DOM beats "api category"
    expect(t.tags).toEqual(["prod"]); // DOM beats ["api-tag"]
    expect(t.docLinks).toEqual(["https://docs.example.com"]);
    expect(t.changeFlags).toEqual(["new"]);
    expect(t.inScope).toBe(true);
    expect(t.groupId).toBe("api-g1"); // API relationship id
  });

  it("uses API target fields only as fallback for empty DOM fields", () => {
    const m = assembleDocument(
      baseArgs({
        targets: [
          {
            dom: domTarget({ location: null, name: null, tags: [] }),
            api: apiTarget(),
            identity: identity(),
          },
        ],
      }),
    );
    const t = m.targets[0]!;
    expect(t.location).toBe("api-location");
    expect(t.name).toBe("api name");
    expect(t.tags).toEqual(["api-tag"]);
  });

  it("maps a DOM-only target's groupId through the emitted group id", () => {
    const m = assembleDocument(
      baseArgs({
        targets: [
          {
            dom: domTarget({ groupDomKey: "group:web" }),
            api: null,
            identity: identity({
              id: "target_ab12cd34",
              id_source: "derived",
              identity_quality: "exact_location",
            }),
          },
        ],
      }),
    );
    // group:web was paired with api-g1 → emitted group id is api-g1.
    expect(m.targets[0]!.groupId).toBe("api-g1");
    expect(m.targets[0]!.id).toBe("target_ab12cd34");
  });

  it("API wins integer reward amounts per-field; DOM fills the gaps", () => {
    const m = assembleDocument(baseArgs());
    const g = m.targetGroups[0]!;
    expect(g.id).toBe("api-g1"); // API relationship id
    expect(g.name).toBe("Web"); // DOM wins visible scope naming
    expect(g.inScope).toBe(true);
    expect(g.rewards).toEqual({
      p1: 500, // api wins (integer)
      p2: 200, // api null → DOM fills
      p3: 300, // api 300 wins over dom null
      p4: 400,
      p5: 500,
    });
  });

  it("group id falls back to the deterministic domKey without an API match", () => {
    const m = assembleDocument(
      baseArgs({ groups: [{ dom: domGroup(), api: null }] }),
    );
    expect(m.targetGroups[0]!.id).toBe("group:web");
    expect(m.targetGroups[0]!.rewards.p1).toBe(100);
  });

  it("merges statistics with DOM winning page-exposed stats over API", () => {
    const m = assembleDocument(baseArgs());
    expect(m.statistics.api_only_stat).toEqual({ value: "42", window: "30d" });
    expect(m.statistics.participants).toEqual({ value: "10", window: null }); // DOM wins
    expect(m.statistics.response_time).toEqual({ value: "2d", window: null });
  });
});

// ---------------------------------------------------------------------------
// assembleDocument — sections
// ---------------------------------------------------------------------------

describe("assembleDocument — sections", () => {
  it("resolves accountRules/dataRules evidence_refs through source records", () => {
    const m = assembleDocument(baseArgs());
    expect(m.accountRules).toEqual([
      { text: "Use your own account", evidence_refs: ["ev_dom1"] },
    ]);
    // Bucketed under program-rules: still resolved via the data payload.
    expect(m.dataRules).toEqual([
      { text: "Do not exfiltrate data", evidence_refs: ["ev_dom2"] },
    ]);
  });

  it("emits empty evidence_refs when no backing record exists", () => {
    const m = assembleDocument(
      baseArgs({ policy: policy({ accountRules: ["phantom rule"] }) }),
    );
    expect(m.accountRules).toEqual([
      { text: "phantom rule", evidence_refs: [] },
    ]);
  });

  it("collects vrt evidence_refs from every vrt source record", () => {
    const m = assembleDocument(baseArgs());
    expect(m.vrt.version).toBe("2.0");
    expect(m.vrt.baseline).toBe("P3 default");
    expect(m.vrt.exclusions).toEqual(["vrt exclusion"]);
    expect(m.vrt.deviations).toEqual(["vrt deviation"]);
    expect(m.vrt.targetSpecific).toEqual(["vrt target rule"]);
    expect(m.vrt.notes).toEqual(["vrt note"]);
    expect(m.vrt.evidence_refs).toContain("ev_vrt");
  });

  it("maps knownIssues rows and resolves evidence refs per target", () => {
    const m = assembleDocument(baseArgs());
    expect(m.knownIssues).toHaveLength(1);
    const k = m.knownIssues[0]!;
    expect(k.targetId).toBe("api-t1"); // assigned id, not the domKey
    expect(k.displayedCount).toBe(1);
    expect(k.collectedCount).toBe(1);
    expect(k.countMatches).toBe(true);
    expect(k.columns).toEqual(["Priority", "Variant"]);
    expect(k.rows).toEqual([
      { cells: ["P1", "xss"], recognized: { priority: "P1" } },
    ]);
    expect(k.evidence_refs).toEqual(["ev_ki1"]);
  });

  it("separates out-of-scope targets and attaches applying rule notes", () => {
    const m = assembleDocument(
      baseArgs({
        targets: [
          { dom: domTarget(), api: apiTarget(), identity: identity() },
          {
            dom: domTarget({
              domKey: "target:admin",
              inScope: false,
              location: "https://admin.example.com",
              name: "Admin",
            }),
            api: null,
            identity: identity({
              id: "target_ff00ff00",
              id_source: "derived",
              identity_quality: "exact_location",
            }),
          },
        ],
      }),
    );
    expect(m.targets).toHaveLength(2);
    const oos = m.outOfScope;
    expect(oos).toHaveLength(1);
    expect(oos[0]!.location).toBe("https://admin.example.com");
    expect(oos[0]!.name).toBe("Admin");
    expect(oos[0]!.notes).toBe("do not touch the admin panel");
  });

  it("passes activity buckets through in source order", () => {
    const m = assembleDocument(baseArgs());
    expect(m.announcements.map((a) => a.title)).toEqual(["Announcement A"]);
    expect(m.changelog.map((a) => a.title)).toEqual(["Change 1"]);
    expect(m.recentActivity).toHaveLength(1);
    expect(m.acceptedReports).toHaveLength(1);
  });

  it("records provenance.conflicts for conflicted technique facts", () => {
    const conflicted = fact({
      status: "unspecified",
      conflict: {
        detected: true,
        evidence_refs: ["ev_a", "ev_b"],
        asserted_statuses: ["allowed", "prohibited"],
      },
      resolution: { status: "unresolved" },
    });
    const m = assembleDocument(
      baseArgs({ techniques: { automation: conflicted, scanning: fact() } }),
    );
    expect(m.techniques.automation?.conflict.detected).toBe(true);
    expect(m.provenance.conflicts).toEqual([
      { factKey: "automation", evidence_refs: ["ev_a", "ev_b"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// assembleDocument — missing sections
// ---------------------------------------------------------------------------

describe("assembleDocument — VRT scope rules", () => {
  it("carries the VRT scope table as policy, never as targets", () => {
    const m = assembleDocument(baseArgs());
    expect(m.vrt.scope_rules).toEqual([
      {
        category: "Application-Level Denial-of-Service (DoS)",
        vrt_version: "1.18",
        applies_to: "All targets",
        status: "out_of_scope",
        note: null,
      },
    ]);
    expect(m.targets.some((t) => (t.name ?? "").includes("Denial"))).toBe(false);
  });
});

describe("assembleDocument — policy projection", () => {
  it("carries submission exclusions and scope authorization as typed facts", () => {
    const m = assembleDocument(baseArgs());
    expect(m.submissionExclusions).toEqual([
      { text: "CSRF", submission_status: "excluded", testing_status: "unspecified", evidence_refs: [] },
    ]);
    expect(m.scopeAuthorization).toMatchObject({
      listed_targets: {
        status: "conditional",
        conditions: ["the targets listed as in scope"],
      },
      unlisted_targets: { status: "prohibited" },
    });
  });
});

describe("assembleDocument — provenance.missing_sections", () => {
  it("records every required collector that produced no records", () => {
    const m = assembleDocument(
      baseArgs({
        details: null,
        groups: [],
        targets: [],
        policy: null,
        activity: null,
        kiResults: [],
      }),
    );
    expect(m.provenance.missing_sections).toEqual([
      "details",
      "scope",
      "policy",
      "activity",
      "known_issues",
    ]);
  });

  it("reports a Known Issues count failure as a collection issue, not a missing section", () => {
    // The section was collected; it failed validation. Naming it "missing"
    // would overload that vocabulary, so it lands in collection_issues.
    const m = assembleDocument(
      baseArgs({
        kiResults: [
          {
            result: kiResult({
              displayedCount: 5,
              collectedCount: 1,
              countMatches: false,
            }),
            targetId: "api-t1",
          },
        ],
      }),
    );
    expect(m.provenance.missing_sections).toEqual([]);
    expect(m.provenance.collection_issues).toEqual([
      {
        code: "known_issues:incomplete_counts",
        target_id: "api-t1",
        displayed_count: 5,
        collected_count: 1,
      },
    ]);
  });

  it("names a target whose dialog never opened as its own collection issue", () => {
    const m = assembleDocument(
      baseArgs({
        kiResults: [
          {
            result: kiResult({
              displayedCount: null,
              warnings: ["ki_dialog_not_opened:target:example-com"],
            }),
            targetId: "api-t1",
          },
        ],
      }),
    );
    expect(m.provenance.collection_issues).toEqual([
      {
        code: "known_issues:dialog_not_opened",
        target_id: "api-t1",
        displayed_count: null,
        collected_count: 1,
      },
    ]);
  });

  it("records no collection issue when every count validated", () => {
    expect(assembleDocument(baseArgs()).provenance.collection_issues).toEqual([]);
  });

  it("flags an empty activity collection while keeping populated sections", () => {
    const m = assembleDocument(
      baseArgs({
        activity: {
          announcements: [],
          changelog: [],
          recentActivity: [],
          acceptedReports: [],
          stats: {},
        },
      }),
    );
    expect(m.provenance.missing_sections).toContain("activity");
    expect(m.provenance.missing_sections).not.toContain("details");
    expect(m.provenance.missing_sections).not.toContain("scope");
  });

  it("empty detail scalars count as a missing details section", () => {
    const m = assembleDocument(
      baseArgs({
        details: {
          name: null,
          code: null,
          engagementType: null,
          managedBounty: null,
          lifecycleStatus: null,
          testingStart: null,
          testingEnd: null,
          testingPeriodLabel: null,
          lastStatusTransition: null,
          lastBriefUpdate: null,
          safeHarborLevel: null,
          disclosurePolicy: null,
          statistics: {},
        },
      }),
    );
    expect(m.provenance.missing_sections).toContain("details");
  });

  it("derives engagement.code from the canonical URL as a last resort", () => {
    const m = assembleDocument(
      baseArgs({ details: null, api: null }),
    );
    expect(m.engagement.code).toBe("acme");
    expect(m.engagement.canonicalUrl).toBe(
      "https://bugcrowd.com/engagements/acme",
    );
  });
});
