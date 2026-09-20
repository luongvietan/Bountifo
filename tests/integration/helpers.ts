import { vi } from "vitest";
import type { CoordinatorDeps } from "../../lib/job/coordinator";

export const URL = "https://bugcrowd.com/engagements/acme";
export const TARGET = {
  domKey: "target:example-com",
  groupDomKey: "group:web",
  inScope: true,
  location: "https://example.com",
  name: "Example",
  category: "website",
  tags: ["prod"],
  docLinks: [],
  changeFlags: [],
  displayedKnownIssuesCount: 1,
  kiControlLabel: "Known Issues",
};

function record(sourceKey: string, quote: string, data: unknown, level: "explicit_program_rule" | "target_specific_rule" = "explicit_program_rule") {
  return {
    sourceKey,
    sourceType: "dom" as const,
    sourceLevel: level,
    sourceUrl: URL,
    authenticated: true,
    locator: { section: "Rules" },
    quote,
    extractionStatus: "exact" as const,
    data,
  };
}

export interface HarnessOptions {
  reverseRecords?: boolean;
  conflict?: boolean;
  kiMismatch?: boolean;
  fatalKind?: string;
}

export function harness(options: HarnessOptions = {}) {
  const messages: unknown[] = [];
  const programText = "Automated scanning is allowed.";
  const targetText = "Automated scanning is prohibited.";
  const policyRecord = record("dom:details:program-rules:automation", programText, {
    name: "automation",
    status: "allowed",
    conditions: [],
    quote: programText,
  });
  const targetRecord = record(
    "dom:scope:rule:automation",
    targetText,
    { text: targetText, appliesToDomKeys: [TARGET.domKey], level: "target_specific_rule" },
    "target_specific_rule",
  );
  const deps: CoordinatorDeps = {
    getTabUrl: vi.fn(async () => URL),
    now: vi.fn(() => "2026-09-20T02:00:00Z"),
    apiEnrich: vi.fn(async () => ({ ok: false, error: { kind: "not_found", message: "not found" } } as never)),
    sendToTab: vi.fn(async (_tabId, raw) => {
      messages.push(raw);
      const msg = raw as { kind: string; params?: { target?: typeof TARGET } };
      if (msg.kind === options.fatalKind) {
        return { ok: false, error: { kind: "session_expired", message: "expired" } };
      }
      if (msg.kind === "collect_details") {
        return { ok: true, result: { records: [], data: { name: "Acme", code: "acme", engagementType: "Bug Bounty", managedBounty: true, lifecycleStatus: "live", testingStart: null, testingEnd: null, testingPeriodLabel: "Ongoing", lastStatusTransition: null, lastBriefUpdate: null, safeHarborLevel: "Full", disclosurePolicy: null, statistics: {} } } };
      }
      if (msg.kind === "collect_targets") {
        const records = options.conflict ? [targetRecord] : [];
        return { ok: true, result: { records, groups: [{ domKey: "group:web", name: "Web", inScope: true, description: null, rewards: { p1: 1000, p2: 500, p3: null, p4: 100, p5: null } }], targets: [TARGET], rules: options.conflict ? [targetRecord.data] : [] } };
      }
      if (msg.kind === "collect_policy") {
        const records = [policyRecord];
        if (options.reverseRecords) records.reverse();
        return { ok: true, result: { records, data: { safeHarborStatements: [], authorizationStatements: [], techniques: [{ name: "automation", status: "allowed", conditions: [], quote: programText }], accountRules: [], dataRules: [], focusAreas: ["XSS"], nonFocusAreas: [], reportingRequirements: ["Include PoC"], vrt: { version: "2.0", baseline: "P3", exclusions: [], deviations: [], targetSpecific: [], notes: [] } } } };
      }
      if (msg.kind === "collect_activity") {
        return { ok: true, result: { records: [], announcements: [], changelog: [], recentActivity: [], acceptedReports: [], stats: {} } };
      }
      if (msg.kind === "collect_ki") {
        return { ok: true, result: { targetDomKey: msg.params?.target?.domKey ?? TARGET.domKey, displayedCount: 1, collectedCount: options.kiMismatch ? 0 : 1, columns: ["Priority"], rows: options.kiMismatch ? [] : [{ cells: ["P1"] }], skipped: false, countMatches: !options.kiMismatch, warnings: options.kiMismatch ? ["ki_count_mismatch:target:example-com"] : [], records: [] } };
      }
      if (msg.kind === "restore_page") return { ok: true, result: {} };
      throw new Error(`unexpected ${msg.kind}`);
    }),
  };
  return { deps, messages };
}

export function decodeMarkdown(url: string): string {
  const encoded = url.slice(url.indexOf(",") + 1);
  const binary = atob(encoded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
