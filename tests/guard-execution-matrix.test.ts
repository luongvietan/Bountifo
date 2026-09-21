import { describe, expect, it } from "vitest";
import {
  runWithGuard,
  ScopeGuardBlocked,
  type GuardAuditRecord,
} from "@/lib/guard/index.ts";
import { compilePolicy } from "@/lib/guard/policy.ts";
import type {
  AgentFacts,
  AgentFactsTarget,
  ContextFact,
  GuardDecisionType,
  GuardReasonCode,
  ProposedAction,
} from "@/lib/guard/types.ts";

/**
 * End-to-end executor acceptance (§47/§71): the frozen 10-row acceptance
 * matrix — the actions from .guard-matrix/actions verbatim, evaluated against
 * facts reconstructed to the recorded live-export states — driven through a
 * counting executor via runWithGuard. REVIEW and DENY must produce exactly
 * zero executor calls; the single ALLOW row executes once.
 *
 * The .guard-matrix dossiers/decisions stay untracked artifacts; this test is
 * self-contained and asserts the recorded decision + full reason set for
 * every row.
 */

const NOW = "2026-01-01T00:00:00.000Z";

class CountingExecutor {
  calls = 0;
  async run(): Promise<string> {
    this.calls++;
    return "executed";
  }
}

function target(id: string, location: string): AgentFactsTarget {
  return {
    target_id: id,
    location,
    name: null,
    category: "website",
    scope_group_ids: [],
    evidence_refs: [`ev_${id}`],
  };
}

function facts(overrides: Partial<AgentFacts>): AgentFacts {
  return {
    agent_facts_schema_version: 1,
    submission_exclusions: [],
    scope_groups: [],
    vrt_scope_rules: [],
    safe_harbor: { status: "present", evidence_refs: ["ev_sh"] },
    account_rules: [],
    data_rules: [],
    policy: { unresolved_conflicts: 0 },
    ...overrides,
  };
}

/**
 * The recorded live-export state for six of the seven programs: collection
 * was partial and integrity unverifiable — the integrity gate short-circuits
 * to REVIEW before any policy check runs.
 */
function partialIntegrityFacts(code: string): AgentFacts {
  return facts({
    engagement: { code },
    techniques: {},
    authorized_scope: null,
    scope_inventory: { in_scope: [], out_of_scope: [] },
    collection: { status: "partial" },
    integrity: {
      evidence_hash_valid: true,
      known_issues_counts_valid: false,
      required_sections_complete: false,
    },
  });
}

/** Recorded reason sets from .guard-matrix/out/*.json (frozen at aafa455). */
const PARTIAL_REASONS: GuardReasonCode[] = [
  "DOSSIER_PARTIAL",
  "KNOWN_ISSUES_COUNTS_INVALID",
  "REQUIRED_SECTIONS_INCOMPLETE",
];

const CODEORG_REASONS: GuardReasonCode[] = [
  "CONDITION_SATISFIED",
  "PROGRAM_SUBMISSIONS_PAUSED",
  "PROGRAM_TESTING_UNSPECIFIED",
  "REWARD_INELIGIBLE",
  "RULE_UNRESOLVED",
  "SAFE_HARBOR_PRESENT",
  "TARGET_IN_SCOPE",
  "TECHNIQUE_NO_POLICY",
];

const ZENDESK_REASONS: GuardReasonCode[] = [
  "ACCOUNT_CONTEXT_UNVERIFIED",
  "CONDITION_SATISFIED",
  "CREDENTIAL_SOURCE_UNVERIFIED",
  "RULE_UNRESOLVED",
  "SAFE_HARBOR_PRESENT",
  "SUBMISSION_EXCLUDED",
  "TARGET_IN_SCOPE",
  "TECHNIQUE_PROHIBITED",
];

const SYNTHETIC_REASONS: GuardReasonCode[] = [
  "CONDITION_SATISFIED",
  "SAFE_HARBOR_PRESENT",
  "TARGET_IN_SCOPE",
  "TECHNIQUE_ALLOWED",
];

// --- Program reconstructions -------------------------------------------------

/** Code.org live state: complete dossier, program paused, xss has no fact. */
const codeorgFacts = facts({
  engagement: { code: "codeorg" },
  techniques: {},
  authorized_scope: {
    listed_targets: { status: "allowed", conditions: [] },
    unlisted_targets: { status: "prohibited" },
    evidence_refs: ["ev_scope"],
  },
  scope_inventory: {
    in_scope: [target("t_cdn", "*.cdn-code.org")],
    out_of_scope: [],
  },
  account_rules: [
    {
      text: "Submissions must include a detailed writeup.",
      evidence_refs: ["ev_rule"],
    },
  ],
  collection: { status: "complete" },
  integrity: {
    evidence_hash_valid: true,
    known_issues_counts_valid: true,
    required_sections_complete: true,
  },
  program_state: {
    submission_state: "paused",
    testing_state: "unspecified",
    reward_state: "ineligible",
    resume_at: null,
    evidence_refs: ["ev_pause"],
  },
});

/** Zendesk live state: complete dossier; DoS and staff-SE both prohibited. */
const zendeskFacts = facts({
  engagement: { code: "zendesk" },
  techniques: {
    "Denial of Service (DoS)": {
      status: "prohibited",
      evidence_refs: ["ev_zt_dos"],
    },
    "Social Engineering (Zendesk staff)": {
      status: "prohibited",
      evidence_refs: ["ev_zt_se"],
    },
  },
  submission_exclusions: [
    {
      text: "Denial of Service (DoS) findings are excluded",
      submission_status: "excluded",
      testing_status: "unspecified",
      reward_status: "unspecified",
      evidence_refs: ["ev_x_dos"],
    },
    {
      text: "Social Engineering Zendesk staff is excluded",
      submission_status: "excluded",
      testing_status: "unspecified",
      reward_status: "unspecified",
      evidence_refs: ["ev_x_se"],
    },
  ],
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
    out_of_scope: [target("t_zoos", "support.zendesk.com")],
  },
  scope_groups: [
    { id: "g_z", name: "Zendesk Suite", in_scope: true, evidence_refs: ["ev_zg"] },
  ],
  account_rules: [
    { text: "Only test accounts that you own.", evidence_refs: ["ev_acct"] },
  ],
  data_rules: [
    {
      text: "Do not use leaked or stolen credentials.",
      evidence_refs: ["ev_cred"],
    },
    {
      text: "Submissions must include full reproduction steps.",
      evidence_refs: ["ev_prose"],
    },
  ],
  collection: { status: "complete" },
  integrity: {
    evidence_hash_valid: true,
    known_issues_counts_valid: true,
    required_sections_complete: true,
  },
});

/** Synthetic trusted dossier — .guard-matrix/synthetic.yaml as an object. */
const syntheticFacts = facts({
  engagement: { code: "synth" },
  techniques: {
    "Cross-Site Scripting (XSS)": {
      status: "allowed",
      conditions: [],
      evidence_refs: ["ev_xss_allowed"],
    },
  },
  authorized_scope: {
    listed_targets: { status: "allowed", conditions: [] },
    unlisted_targets: { status: "prohibited" },
    evidence_refs: ["ev_scope"],
  },
  scope_inventory: {
    in_scope: [target("t_in", "*.example.com")],
    out_of_scope: [target("t_oos", "blocked.example.com")],
  },
  collection: { status: "complete" },
  integrity: {
    evidence_hash_valid: true,
    known_issues_counts_valid: true,
    required_sections_complete: true,
  },
});

// --- The frozen matrix: actions verbatim from .guard-matrix/actions -----------

const action = (
  code: string,
  url: string,
  technique: string,
  operation: ProposedAction["operation"],
  extra: Partial<ProposedAction> = {},
): ProposedAction => ({
  schema_version: 1,
  engagement: { code },
  target: { url },
  technique: { id: technique },
  operation,
  ...extra,
});

const READ = { kind: "read", destructive: false, external_side_effect: false } as const;
const SEND = { kind: "send", destructive: false, external_side_effect: false } as const;
const SCAN = { kind: "scan", destructive: false, external_side_effect: false } as const;

const OKTA_CONTEXT: ContextFact[] = [
  {
    key: "context.phase",
    value: "post_compromise",
    source: "runtime",
    verification: "verified",
  },
];

interface Row {
  name: string;
  facts: AgentFacts;
  action: ProposedAction;
  context?: ContextFact[];
  decision: GuardDecisionType;
  reasons: GuardReasonCode[];
  calls: number;
}

const MATRIX: Row[] = [
  {
    name: "Code.org",
    facts: codeorgFacts,
    action: action("codeorg", "https://adhoc-bugcrowd.cdn-code.org", "xss", READ),
    decision: "REVIEW",
    reasons: CODEORG_REASONS,
    calls: 0,
  },
  {
    name: "Barracuda",
    facts: partialIntegrityFacts("barracuda"),
    action: action(
      "barracuda",
      "https://www.barracuda.com/products/messagearchiver",
      "xss",
      READ,
    ),
    decision: "REVIEW",
    reasons: PARTIAL_REASONS,
    calls: 0,
  },
  {
    name: "Bitdefender",
    facts: partialIntegrityFacts("bitdefender"),
    action: action("bitdefender", "https://api.bitdefender.com/", "xss", READ),
    decision: "REVIEW",
    reasons: PARTIAL_REASONS,
    calls: 0,
  },
  {
    name: "Statuspage",
    facts: partialIntegrityFacts("statuspage"),
    action: action(
      "statuspage",
      "https://manage.statuspage.io",
      "denial_of_service",
      SEND,
    ),
    decision: "REVIEW",
    reasons: PARTIAL_REASONS,
    calls: 0,
  },
  {
    name: "Rapyd",
    facts: partialIntegrityFacts("rapyd"),
    action: action(
      "rapyd",
      "https://verify.rapyd.net/",
      "other_account_data_access",
      READ,
    ),
    decision: "REVIEW",
    reasons: PARTIAL_REASONS,
    calls: 0,
  },
  {
    name: "Okta",
    facts: partialIntegrityFacts("okta"),
    action: action(
      "okta",
      "https://support.okta.com",
      "port_scanning_internal_networks",
      SCAN,
    ),
    context: OKTA_CONTEXT,
    decision: "REVIEW",
    reasons: PARTIAL_REASONS,
    calls: 0,
  },
  {
    name: "LastPass",
    facts: partialIntegrityFacts("lastpass"),
    action: action(
      "lastpass",
      "https://auth.lastpass.com",
      "automated_tools",
      SEND,
      { automation: { automated: true, requests_per_second: 3 } },
    ),
    decision: "REVIEW",
    reasons: PARTIAL_REASONS,
    calls: 0,
  },
  {
    name: "Zendesk DoS",
    facts: zendeskFacts,
    action: action(
      "zendesk",
      "https://researchco.zendesk.com/",
      "denial_of_service",
      SEND,
    ),
    decision: "DENY",
    reasons: ZENDESK_REASONS,
    calls: 0,
  },
  {
    name: "Zendesk SE-staff",
    facts: zendeskFacts,
    action: action(
      "zendesk",
      "https://researchco.zendesk.com/",
      "social_engineering_zendesk_staff",
      SEND,
    ),
    decision: "DENY",
    reasons: ZENDESK_REASONS,
    calls: 0,
  },
  {
    name: "Synthetic trusted",
    facts: syntheticFacts,
    action: action("synth", "https://app.example.com/", "xss", SEND),
    decision: "ALLOW",
    reasons: SYNTHETIC_REASONS,
    calls: 1,
  },
];

describe("execution acceptance matrix — §47/§71", () => {
  for (const row of MATRIX) {
    it(`${row.name}: ${row.decision} → ${row.calls} executor call(s)`, async () => {
      const exec = new CountingExecutor();
      const audit: GuardAuditRecord[] = [];
      const policy = await compilePolicy(row.facts);

      let decision: import("@/lib/guard/types.ts").GuardDecision | undefined;
      let blocked: ScopeGuardBlocked | undefined;
      try {
        const res = await runWithGuard({
          policy,
          action: row.action,
          trustedContext: row.context ?? [],
          now: NOW,
          execute: () => exec.run(),
          metadata: {
            audit: (r) => audit.push(r),
            executor_id: "counting-executor",
          },
        });
        decision = res.decision;
        expect(res.executed).toBe(true);
        expect(res.result).toBe("executed");
      } catch (err) {
        expect(err).toBeInstanceOf(ScopeGuardBlocked);
        blocked = err as ScopeGuardBlocked;
        decision = blocked.decision;
      }

      expect(decision).toBeDefined();
      expect(decision!.decision).toBe(row.decision);
      expect(decision!.execution_allowed).toBe(row.decision === "ALLOW");
      expect([...decision!.reason_codes].sort()).toEqual(
        [...row.reasons].sort(),
      );
      expect(exec.calls).toBe(row.calls);
      // The audit hook saw exactly one decision — blocked or executed.
      expect(audit).toHaveLength(1);
      expect(audit[0]!.executed).toBe(row.decision === "ALLOW");
      expect(audit[0]!.decision_hash).toBe(decision!.decision_hash);
    });
  }
});

// ---------------------------------------------------------------------------
// §48 unknown-poison integration sweep — no semantic "unknown" and no
// planner assertion may ever reach the executor.
// ---------------------------------------------------------------------------

const vf = (key: string, value: string | number | boolean): ContextFact => ({
  key,
  value,
  source: "runtime",
  verification: "verified",
});

const poisonBase = facts({
  engagement: { code: "prog" },
  authorized_scope: {
    listed_targets: { status: "allowed", conditions: [] },
    unlisted_targets: { status: "prohibited" },
    evidence_refs: ["ev_scope"],
  },
  scope_inventory: {
    in_scope: [target("t_in", "*.example.com")],
    out_of_scope: [],
  },
  collection: { status: "complete" },
  integrity: {
    evidence_hash_valid: true,
    known_issues_counts_valid: true,
    required_sections_complete: true,
  },
});

const poisonAction = (o: Partial<ProposedAction> = {}): ProposedAction =>
  action("prog", "https://app.example.com/", "xss", SEND, o);

const rapydFacts = facts({
  ...poisonBase,
  engagement: { code: "prog" },
  techniques: {
    "Cross-account testing": {
      status: "conditional",
      conditions: [{ id: "c1", text: "accounts you own" }],
      evidence_refs: ["ev_cross"],
    },
  },
  data_rules: [
    {
      text: "Do not access data from anyone else's account.",
      evidence_refs: ["ev_d"],
    },
  ],
});
const rapydAction = poisonAction({
  technique: { id: "cross_account_testing" },
});

const credFacts = facts({
  ...poisonBase,
  engagement: { code: "prog" },
  techniques: {
    "Cross-Site Scripting (XSS)": { status: "allowed", evidence_refs: ["ev_x"] },
  },
  account_rules: [
    {
      text: "Do not use leaked or third-party credentials.",
      evidence_refs: ["ev_c"],
    },
  ],
});

const oktaFacts = facts({
  ...poisonBase,
  engagement: { code: "prog" },
  techniques: {
    "Port scanning internal networks": {
      status: "prohibited",
      applies_to: {
        type: "conditional_context",
        conditions: [{ kind: "phase", value: "post_compromise" }],
      },
      evidence_refs: ["ev_ps"],
    },
  },
});
const oktaAction = poisonAction({
  technique: { id: "port_scanning_internal_networks" },
  operation: SCAN,
});

const cudaFacts = facts({
  ...poisonBase,
  engagement: { code: "prog" },
  scope_inventory: {
    in_scope: [],
    out_of_scope: [target("t_oos", "phishing.example.com")],
  },
  authorized_scope: {
    listed_targets: {
      status: "conditional",
      conditions: ["Target must be explicitly declared in scope"],
    },
    unlisted_targets: { status: "prohibited" },
    exceptions: [
      {
        applies_to: "out_of_scope_targets",
        condition: {
          kind: "prior_written_consent",
          issuer: "program_security_team",
          verification_required: true,
        },
        effect: "permit_evaluation",
        evidence_refs: ["ev_consent"],
      },
    ],
    evidence_refs: ["ev_scope"],
  },
  techniques: {
    "Cross-Site Scripting (XSS)": { status: "allowed", evidence_refs: ["ev_x"] },
  },
});
const cudaAction = poisonAction({
  target: { url: "https://phishing.example.com/" },
});

const POISON: {
  name: string;
  facts: AgentFacts;
  action: ProposedAction;
  context: ContextFact[];
}[] = [
  {
    name: "verified account.ownership='unknown'",
    facts: rapydFacts,
    action: rapydAction,
    context: [
      vf("account.ownership", "unknown"),
      vf("data.ownership", "researcher"),
      vf("data.sensitivity", "none"),
    ],
  },
  {
    name: "verified data.ownership='unknown'",
    facts: rapydFacts,
    action: rapydAction,
    context: [
      vf("account.ownership", "researcher"),
      vf("data.ownership", "unknown"),
      vf("data.sensitivity", "none"),
    ],
  },
  {
    name: "verified credentials.source='unknown'",
    facts: credFacts,
    action: poisonAction(),
    context: [vf("credentials.source", "unknown")],
  },
  {
    name: "missing phase context",
    facts: oktaFacts,
    action: oktaAction,
    context: [],
  },
  {
    name: "verified context.phase='unknown'",
    facts: oktaFacts,
    action: oktaAction,
    context: [vf("context.phase", "unknown")],
  },
  {
    name: "planner-asserted consent",
    facts: cudaFacts,
    action: cudaAction,
    context: [
      {
        key: "authorization.prior_written_consent",
        value: true,
        source: "planner",
        verification: "asserted",
      },
    ],
  },
];

describe("unknown-poison integration sweep — §48", () => {
  for (const c of POISON) {
    it(`${c.name} → blocked, zero executor calls`, async () => {
      const exec = new CountingExecutor();
      const policy = await compilePolicy(c.facts);
      await expect(
        runWithGuard({
          policy,
          action: c.action,
          trustedContext: c.context,
          now: NOW,
          execute: () => exec.run(),
        }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ScopeGuardBlocked &&
          e.decision.decision !== "ALLOW" &&
          e.decision.execution_allowed === false,
      );
      expect(exec.calls).toBe(0);
    });
  }
});
