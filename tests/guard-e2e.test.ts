import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import { JobCoordinator } from "../lib/job/coordinator";
import type { CoordinatorDeps } from "../lib/job/coordinator";
import { collectDetails } from "../lib/dom/details";
import { collectTargets } from "../lib/dom/targets";
import { collectPolicies } from "../lib/dom/policies";
import { decodeMarkdown } from "./integration/helpers";
import { parseAgentFacts } from "../lib/guard/parse";
import { evaluateScopeGuard } from "../lib/guard/index";
import { loadDoc, PAGE_URL } from "./helpers/dom";
import type {
  AgentFacts,
  ContextFact,
  GuardDecision,
  ProposedAction,
} from "../lib/guard/types";

/**
 * End-to-end regression matrix: real DOM fixtures run through the actual
 * collectors + coordinator → dossier Markdown → Agent Facts → Scope Guard.
 * For programs without DOM fixtures (Statuspage, EPAM, Zendesk, OneTrust,
 * SimpliSafe) the facts replicate the documented live-export states (§33).
 */

beforeEach(() => fakeBrowser.reset());

function fixtureDeps(fixture: string): CoordinatorDeps {
  const doc = loadDoc(fixture);
  const details = collectDetails(doc, PAGE_URL);
  const targets = collectTargets(doc, PAGE_URL);
  const policy = collectPolicies(doc, PAGE_URL);
  return {
    getTabUrl: vi.fn(async () => PAGE_URL),
    now: vi.fn(() => "2026-09-20T02:00:00Z"),
    apiEnrich: vi.fn(async () => ({
      ok: false,
      error: { kind: "not_found", message: "not found" },
    }) as never),
    sendToTab: vi.fn(async (_tabId: unknown, raw: unknown) => {
      const msg = raw as {
        kind: string;
        params?: {
          target?: {
            domKey: string;
            displayedKnownIssuesCount: number | null;
            kiAdvertised: boolean;
          };
        };
      };
      switch (msg.kind) {
        case "collect_details":
          return { ok: true, result: details };
        case "collect_targets":
          return { ok: true, result: targets };
        case "collect_policy":
          return { ok: true, result: policy };
        case "collect_activity":
          return {
            ok: true,
            result: {
              records: [],
              announcements: [],
              changelog: [],
              recentActivity: [],
              acceptedReports: [],
              stats: {},
            },
          };
        case "collect_ki": {
          const t = msg.params?.target;
          const count = t?.displayedKnownIssuesCount ?? 0;
          return {
            ok: true,
            result: {
              targetDomKey: t?.domKey ?? "",
              displayedCount: count,
              collectedCount: count,
              columns: [],
              rows: [],
              skipped: false,
              advertised: t?.kiAdvertised ?? false,
              countMatches: true,
              warnings: [],
              records: [],
            },
          };
        }
        case "restore_page":
          return { ok: true, result: {} };
        default:
          throw new Error(`unexpected ${msg.kind}`);
      }
    }),
  };
}

const factCache = new Map<string, AgentFacts>();

async function factsFor(fixture: string): Promise<AgentFacts> {
  const cached = factCache.get(fixture);
  if (cached !== undefined) return cached;
  const download = vi
    .spyOn(browser.downloads, "download")
    .mockResolvedValue(undefined as never);
  const coordinator = new JobCoordinator(fixtureDeps(fixture));
  await coordinator.start(7);
  await coordinator.waitForIdle();
  expect(download).toHaveBeenCalledOnce();
  const md = decodeMarkdown(download.mock.calls[0]![0].url as string);
  const facts = parseAgentFacts(md);
  factCache.set(fixture, facts);
  return facts;
}

function action(
  engagement: string,
  url: string,
  technique: string,
  extra: Partial<ProposedAction> = {},
): ProposedAction {
  return {
    schema_version: 1,
    engagement: { code: engagement },
    target: { url },
    technique: { id: technique },
    operation: { kind: "send", destructive: false },
    ...extra,
  };
}

async function decide(
  facts: AgentFacts,
  a: ProposedAction,
  trustedContext: ContextFact[] = [],
): Promise<GuardDecision> {
  return evaluateScopeGuard({
    agentFacts: facts,
    action: a,
    trustedContext,
    now: "2026-01-01T00:00:00.000Z",
  });
}

const VERIFIED: ContextFact[] = [
  {
    key: "account.ownership",
    value: "researcher",
    source: "runtime",
    verification: "verified",
  },
  {
    key: "data.ownership",
    value: "researcher",
    source: "runtime",
    verification: "verified",
  },
  {
    key: "data.sensitivity",
    value: "none",
    source: "runtime",
    verification: "verified",
  },
  {
    key: "credentials.source",
    value: "own",
    source: "runtime",
    verification: "verified",
  },
];

const CODE = "acme-bb"; // fixture URL slug becomes the engagement code

// ---------------------------------------------------------------------------
// Programs with real DOM fixtures — full pipeline e2e.
// ---------------------------------------------------------------------------

describe("Aiven (real fixture)", () => {
  it("Application-Level DoS VRT rule DENYs an in-scope target", async () => {
    const d = await decide(
      await factsFor("aiven-current.html"),
      action(CODE, "https://aiven.io/", "denial_of_service"),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.reason_codes).toContain("TECHNIQUE_PROHIBITED");
    expect(d.reason_codes).toContain("VRT_RULE_PROHIBITED");
    expect(d.target_resolution.status).toBe("matched_in_scope");
  });

  it("unlisted property is prohibited by authorized_scope", async () => {
    const d = await decide(
      await factsFor("aiven-current.html"),
      action(CODE, "https://notlisted.example.com/", "denial_of_service"),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.reason_codes).toContain("UNLISTED_TARGETS_PROHIBITED");
  });

  it("cross-account rule requires verified owned-account context", async () => {
    const facts = await factsFor("aiven-current.html");
    const a = action(CODE, "https://aiven.io/", "cross_account_testing");
    const unverified = await decide(facts, a);
    expect(unverified.decision).toBe("REVIEW");
    expect(unverified.reason_codes).toContain("ACCOUNT_CONTEXT_UNVERIFIED");

    // Verified context satisfies the condition, but Aiven's prose account
    // rules ("@bugcrowdninja email", production warning) cannot be compiled —
    // the gate still REVIEWs rather than guessing at compliance.
    const verified = await decide(facts, a, VERIFIED);
    expect(verified.decision).toBe("REVIEW");
    expect(verified.reason_codes).toContain("RULE_UNRESOLVED");
    expect(verified.reason_codes).not.toContain("ACCOUNT_CONTEXT_UNVERIFIED");
  });

  it("out-of-scope listed target DENYs", async () => {
    const d = await decide(
      await factsFor("aiven-current.html"),
      action(CODE, "https://aquarium.aiven.io/", "xss"),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.reason_codes).toContain("TARGET_OUT_OF_SCOPE");
  });
});

describe("Pinterest (real fixture)", () => {
  it("PII access with unverifiable approval + uncompilable data rule → REVIEW", async () => {
    const d = await decide(
      await factsFor("pinterest-current.html"),
      action(CODE, "https://www.pinterest.com/", "pii_access"),
      VERIFIED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.reason_codes).toContain("CONDITION_UNRESOLVED");
  });
});

describe("Web.com (real fixture)", () => {
  it("exact in-scope listing beats the out-of-scope wildcard", async () => {
    const facts = await factsFor("webdotcom-current.html");
    const d = await decide(
      facts,
      action(CODE, "https://app.web.com/", "xss"),
      VERIFIED,
    );
    // app.web.com is listed exactly; *.web.com is out of scope — the exact
    // listing wins specificity. The decision still REVIEWs: Web.com has no
    // fact for xss and prose rules the compiler cannot read.
    expect(d.target_resolution.status).toBe("matched_in_scope");
    expect(d.reason_codes).toContain("TARGET_IN_SCOPE");
    expect(d.decision).toBe("REVIEW");
  });

  it("unlisted subdomain hits the out-of-scope wildcard → DENY", async () => {
    const d = await decide(
      await factsFor("webdotcom-current.html"),
      action(CODE, "https://foo.web.com/", "xss"),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.reason_codes).toContain("TARGET_OUT_OF_SCOPE");
  });

  it("explicit DoS prohibition → DENY", async () => {
    const d = await decide(
      await factsFor("webdotcom-current.html"),
      action(CODE, "https://www.hostgator.com/", "denial_of_service"),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.reason_codes).toContain("TECHNIQUE_PROHIBITED");
  });
});

describe("Matlab / Nubank / OpenAI (real fixtures)", () => {
  it("Matlab: unclear safe harbor blocks every action", async () => {
    const d = await decide(
      await factsFor("matlab-current.html"),
      action(CODE, "https://matlab.mathworks.com/", "xss"),
      VERIFIED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.reason_codes).toContain("SAFE_HARBOR_UNCLEAR");
  });

  it("Nubank: no authorized_scope rule + no technique facts → REVIEW", async () => {
    const d = await decide(
      await factsFor("nubank-current.html"),
      action(CODE, "https://prod-api.nubank.com.br/", "xss"),
      VERIFIED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.execution_allowed).toBe(false);
  });

  it("OpenAI: name-only target rows never resolve a URL → REVIEW", async () => {
    const d = await decide(
      await factsFor("openai-current.html"),
      action(CODE, "https://chatgpt.com/", "xss"),
      VERIFIED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.target_resolution.status).toBe("unlisted");
  });
});

// ---------------------------------------------------------------------------
// Programs without DOM fixtures — facts replicate documented live state.
// ---------------------------------------------------------------------------

function liveFacts(overrides: Partial<AgentFacts>): AgentFacts {
  return {
    agent_facts_schema_version: 1,
    engagement: { code: "live" },
    techniques: {},
    submission_exclusions: [],
    authorized_scope: null,
    scope_inventory: { in_scope: [], out_of_scope: [] },
    scope_groups: [],
    vrt_scope_rules: [],
    safe_harbor: { status: "present", evidence_refs: [] },
    account_rules: [],
    data_rules: [],
    collection: { status: "complete" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: true,
      required_sections_complete: true,
    },
    policy: { unresolved_conflicts: 0 },
    ...overrides,
  };
}

const live = (a: ProposedAction, ctx: ContextFact[] = []) =>
  action("live", a.target.url, a.technique.id, a);

describe("Statuspage (live state: partial collection)", () => {
  const statuspageFacts = liveFacts({
    collection: { status: "partial", dom_status: "partial" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: false,
      required_sections_complete: false,
    },
    authorized_scope: {
      listed_targets: { status: "allowed", conditions: [] },
      unlisted_targets: { status: "prohibited" },
      evidence_refs: [],
    },
    scope_inventory: {
      in_scope: [
        {
          target_id: "t_manage",
          location: "https://manage.statuspage.io",
          name: null,
          category: "website",
          scope_group_ids: [],
          evidence_refs: ["ev_s1"],
        },
        {
          target_id: "t_wild",
          location: "*.statuspage.io",
          name: null,
          category: "website",
          scope_group_ids: [],
          evidence_refs: ["ev_s2"],
        },
      ],
      out_of_scope: [],
    },
    techniques: {
      "Automated scanners": { status: "prohibited", evidence_refs: ["ev_ts1"] },
      "Automated tools": { status: "prohibited", evidence_refs: ["ev_ts2"] },
    },
    data_rules: [
      {
        text: "Do not attempt to validate whether customer data access works.",
        evidence_refs: ["ev_sd1"],
      },
    ],
  });

  it("global integrity gate forces REVIEW regardless of technique", async () => {
    const d = await decide(
      statuspageFacts,
      live(action("live", "https://manage.statuspage.io/", "xss")),
      VERIFIED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.execution_allowed).toBe(false);
    expect(d.reason_codes).toContain("DOSSIER_PARTIAL");
    expect(d.reason_codes).toContain("KNOWN_ISSUES_COUNTS_INVALID");
  });

  it("the same rules under a complete dossier DENY automated scanners", async () => {
    const complete = liveFacts({
      ...statuspageFacts,
      collection: { status: "complete" },
      integrity: {
        evidence_hash_valid: true,
        known_issues_counts_valid: true,
        required_sections_complete: true,
      },
    });
    const d = await decide(
      complete,
      live(
        action("live", "https://manage.statuspage.io/", "xss", {
          automation: { automated: true, scanner: true },
        }),
      ),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    // The automation overlay fires even though the declared technique is xss.
    expect(d.reason_codes).toContain("TECHNIQUE_PROHIBITED");
    const autoCheck = d.checks.find((c) => c.check === "automation");
    expect(autoCheck?.result).toBe("fail");
  });

  it("no bare `scanning` fact is invented — declared scanner action still DENYs via automation rules", async () => {
    const complete = liveFacts({
      ...statuspageFacts,
      collection: { status: "complete" },
      integrity: {
        evidence_hash_valid: true,
        known_issues_counts_valid: true,
        required_sections_complete: true,
      },
    });
    expect(
      Object.keys(complete.techniques ?? {}).some((k) => /scanning$/i.test(k)),
    ).toBe(false);
    const d = await decide(
      complete,
      live(action("live", "https://manage.statuspage.io/", "automated_scanners")),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
  });
});

describe("EPAM (live state: partial, KI unverifiable)", () => {
  const epamFacts = liveFacts({
    collection: { status: "partial" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: false,
      required_sections_complete: true,
    },
    scope_inventory: {
      in_scope: [
        {
          target_id: "t_epam",
          location: "*.epam.com",
          name: null,
          category: "website",
          scope_group_ids: [],
          evidence_refs: ["ev_e1"],
        },
      ],
      out_of_scope: [],
    },
    authorized_scope: {
      listed_targets: { status: "allowed", conditions: [] },
      unlisted_targets: { status: "prohibited" },
      evidence_refs: [],
    },
    techniques: {
      "Automation (against form submissions)": {
        status: "prohibited",
        evidence_refs: ["ev_ep1"],
      },
    },
    submission_exclusions: [
      {
        text: "Avoid testing any contact forms on epam.com *.epam.com",
        submission_status: "excluded",
        testing_status: "prohibited",
        reward_status: "unspecified",
        evidence_refs: ["ev_ep2"],
      },
    ],
  });

  it("partial dossier → REVIEW globally", async () => {
    const d = await decide(
      epamFacts,
      live(action("live", "https://www.epam.com/", "xss")),
      VERIFIED,
    );
    expect(d.decision).toBe("REVIEW");
    expect(d.reason_codes).toContain("DOSSIER_PARTIAL");
  });

  it("isolated rules DENY under a complete copy", async () => {
    const complete = liveFacts({
      ...epamFacts,
      collection: { status: "complete" },
      integrity: {
        evidence_hash_valid: true,
        known_issues_counts_valid: true,
        required_sections_complete: true,
      },
    });
    const formAutomation = await decide(
      complete,
      live(
        action("live", "https://www.epam.com/", "form_submission_automation"),
      ),
      VERIFIED,
    );
    expect(formAutomation.decision).toBe("DENY");

    const contactForm = await decide(
      complete,
      live(action("live", "https://www.epam.com/", "contact_form_testing")),
      VERIFIED,
    );
    expect(contactForm.decision).toBe("DENY");
    expect(contactForm.reason_codes).toContain("EXCLUSION_TESTING_PROHIBITED");
  });
});

describe("Zendesk (live state: complete)", () => {
  const zendeskFacts = liveFacts({
    authorized_scope: {
      listed_targets: { status: "allowed", conditions: [] },
      unlisted_targets: { status: "prohibited" },
      evidence_refs: ["ev_z_scope"],
    },
    scope_inventory: {
      in_scope: [
        {
          target_id: "t_zsuite",
          location: "Zendesk Suite https://{subdomain}.zendesk.com/",
          name: "Zendesk Suite",
          category: "website",
          scope_group_ids: ["g_z"],
          evidence_refs: ["ev_z1"],
        },
      ],
      out_of_scope: [
        {
          target_id: "t_zoos",
          location: "support.zendesk.com",
          name: null,
          category: "website",
          scope_group_ids: [],
          evidence_refs: ["ev_z2"],
        },
      ],
    },
    scope_groups: [
      {
        id: "g_z",
        name: "Zendesk Suite",
        in_scope: true,
        evidence_refs: ["ev_zg"],
      },
    ],
    techniques: {
      "Denial of Service (DoS)": {
        status: "prohibited",
        evidence_refs: ["ev_zt1"],
      },
      "Social Engineering": {
        status: "prohibited",
        evidence_refs: ["ev_zt2"],
      },
    },
  });

  it("no third-party fact is inferred from `third-party data inputs`", async () => {
    const keys = Object.keys(zendeskFacts.techniques ?? {});
    expect(keys.some((k) => /third[\s-]?part/i.test(k))).toBe(false);
  });

  it("{subdomain} placeholder resolves a tenant host in scope", async () => {
    const d = await decide(
      zendeskFacts,
      live(action("live", "https://acme.zendesk.com/", "xss")),
      VERIFIED,
    );
    expect(d.target_resolution.status).toBe("matched_in_scope");
    expect(d.target_resolution.target_id).toBe("t_zsuite");
    // xss has no fact → REVIEW, not an invented permission.
    expect(d.decision).toBe("REVIEW");
    expect(d.reason_codes).toContain("TECHNIQUE_NO_POLICY");
  });

  it("explicit DoS/social-engineering prohibitions DENY", async () => {
    for (const technique of ["denial_of_service", "social_engineering"]) {
      const d = await decide(
        zendeskFacts,
        live(action("live", "https://acme.zendesk.com/", technique)),
        VERIFIED,
      );
      expect(d.decision).toBe("DENY");
      expect(d.reason_codes).toContain("TECHNIQUE_PROHIBITED");
    }
  });

  it("explicitly out-of-scope support.zendesk.com DENYs", async () => {
    const d = await decide(
      zendeskFacts,
      live(action("live", "https://support.zendesk.com/", "xss")),
      VERIFIED,
    );
    expect(d.decision).toBe("DENY");
    expect(d.reason_codes).toContain("TARGET_OUT_OF_SCOPE");
  });
});

describe("OneTrust / SimpliSafe (live-state shapes)", () => {
  it("OneTrust: conditional prior-approval technique REVIEWs without verification", async () => {
    const facts = liveFacts({
      authorized_scope: {
        listed_targets: { status: "allowed", conditions: [] },
        unlisted_targets: { status: "prohibited" },
        evidence_refs: [],
      },
      scope_inventory: {
        in_scope: [
          {
            target_id: "t_ot",
            location: "https://*.onetrust.com",
            name: null,
            category: "website",
            scope_group_ids: [],
            evidence_refs: ["ev_o1"],
          },
        ],
        out_of_scope: [],
      },
      techniques: {
        "Cross-Site Scripting (XSS)": {
          status: "conditional",
          conditions: [
            { id: "c1", text: "Prior written approval is required" },
          ],
          evidence_refs: ["ev_ot"],
        },
      },
    });
    const a = live(action("live", "https://app.onetrust.com/", "xss"));
    const d = await decide(facts, a, VERIFIED);
    expect(d.decision).toBe("REVIEW");
    expect(d.reason_codes).toContain("CONDITION_UNRESOLVED");
    // A verified prior approval satisfies the condition → ALLOW.
    const approved = await decide(facts, a, [
      ...VERIFIED,
      {
        key: "authorization.prior_approval",
        value: true,
        source: "program",
        verification: "verified",
      },
    ]);
    expect(approved.decision).toBe("ALLOW");
    expect(approved.execution_allowed).toBe(true);
  });

  it("SimpliSafe: *.prd.platform.simplisafe.com wildcard scope + DoS prohibition", async () => {
    const facts = liveFacts({
      authorized_scope: {
        listed_targets: { status: "allowed", conditions: [] },
        unlisted_targets: { status: "prohibited" },
        evidence_refs: [],
      },
      scope_inventory: {
        in_scope: [
          {
            target_id: "t_ss",
            location: "*.prd.platform.simplisafe.com",
            name: null,
            category: "website",
            scope_group_ids: [],
            evidence_refs: ["ev_ss"],
          },
        ],
        out_of_scope: [],
      },
      techniques: {
        "Denial of Service": {
          status: "prohibited",
          evidence_refs: ["ev_st"],
        },
      },
    });
    const inScope = await decide(
      facts,
      live(action("live", "https://node1.prd.platform.simplisafe.com/", "xss")),
      VERIFIED,
    );
    expect(inScope.target_resolution.status).toBe("matched_in_scope");

    const dos = await decide(
      facts,
      live(
        action(
          "live",
          "https://node1.prd.platform.simplisafe.com/",
          "denial_of_service",
        ),
      ),
      VERIFIED,
    );
    expect(dos.decision).toBe("DENY");

    // Wildcard boundary: apex and look-alike hosts do not match.
    const apex = await decide(
      facts,
      live(action("live", "https://prd.platform.simplisafe.com/", "xss")),
      VERIFIED,
    );
    expect(apex.target_resolution.status).toBe("unlisted");
  });
});
