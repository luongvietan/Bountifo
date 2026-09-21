import { stringify as stringifyYaml } from "yaml";
import type { ActivityItem } from "../dom/activity";
import type { DocumentModel } from "../model/document";
import type { Evidence, PermissionFact } from "../types";
import { renderFrontMatter } from "./frontMatter";

const MD_META_RE = /[\\*_\[\]()#+\-.!|>]/g;

export function escapeMd(text: string): string {
  return text.replace(MD_META_RE, "\\$&");
}

function tableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function mdTable(headers: string[], rows: string[][]): string {
  const width = headers.length;
  const renderRow = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => tableCell(cells[i] ?? "")).join(" | ")} |`;
  return [
    renderRow(headers),
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(renderRow),
  ].join("\n");
}

function factForYaml(fact: PermissionFact): object {
  return {
    status: fact.status,
    conditions: fact.conditions,
    applies_to: fact.applies_to,
    evidence_refs: fact.evidence_refs,
    conflict: fact.conflict,
    ...(fact.resolution === undefined ? {} : { resolution: fact.resolution }),
    extraction: fact.extraction,
  };
}

export function renderAgentFacts(model: DocumentModel): string {
  const techniques = Object.fromEntries(
    Object.keys(model.techniques)
      .sort()
      .map((key) => [key, factForYaml(model.techniques[key]!)]),
  );
  // model.targets is id-sorted while outOfScope follows collection order, so
  // the rule notes join on the (location, name) identity rather than index.
  const noteKey = (location: string | null, name: string | null): string =>
    `${location ?? ""}${name ?? ""}`;
  const outOfScopeNotes = new Map(
    model.outOfScope.map((o) => [noteKey(o.location, o.name), o.notes]),
  );
  const scopeTarget = (target: DocumentModel["targets"][number]) => ({
    target_id: target.id,
    location: target.location,
    name: target.name,
    category: target.category,
    scope_group_ids: target.groupId === null ? [] : [target.groupId],
    evidence_refs: target.evidence_refs,
  });
  const facts = {
    // The guard-facing schema versions independently of the dossier schema:
    // every key below the version is additive, so old consumers keep parsing.
    agent_facts_schema_version: 1,
    engagement: { code: model.engagement.code },
    techniques,
    // Kept beside the techniques so a consumer cannot mistake a refused report
    // for a forbidden activity: the two axes are named separately (§11).
    submission_exclusions: model.submissionExclusions,
    // Named `authorized_scope` so the key can never read as an HTTP
    // Authorization header in a scan of the output (§19). Its `exceptions`
    // carry consent carve-outs — metadata, never permission.
    authorized_scope: model.scopeAuthorization,
    // Program operational state is its own axis: a submission pause changes
    // what the program accepts, never what testing is authorized.
    program_state: model.programState,
    // A deterministic target inventory so a Scope Guard resolves a proposed
    // URL against the program's listed targets without scraping Markdown.
    scope_inventory: {
      in_scope: model.targets
        .filter((target) => target.inScope)
        .map(scopeTarget),
      out_of_scope: model.targets
        .filter((target) => !target.inScope)
        .map((target) => ({
          ...scopeTarget(target),
          notes:
            outOfScopeNotes.get(noteKey(target.location, target.name)) ?? null,
        })),
    },
    scope_groups: model.targetGroups.map((group) => ({
      id: group.id,
      name: group.name,
      in_scope: group.inScope,
      evidence_refs: group.evidence_refs,
    })),
    // A Scope Guard needs the VRT verdicts beside the target list: they rule
    // whole vulnerability classes in or out regardless of asset.
    vrt_scope_rules: model.vrt.scope_rules,
    safe_harbor: model.engagement.safeHarbor,
    // Account/data constraints live outside `techniques`; the guard evaluates
    // them as typed rules with their own evidence trail.
    account_rules: model.accountRules,
    data_rules: model.dataRules,
    collection: model.collection,
    integrity: model.integrity,
    collection_issues: model.provenance.collection_issues,
    policy: model.policy,
  };
  return `\`\`\`yaml\n${stringifyYaml(facts, { lineWidth: 0 }).trimEnd()}\n\`\`\``;
}

function value(value: string | number | boolean | null): string {
  return value === null ? "—" : escapeMd(String(value));
}

function formatAmount(amount: number | string | null): string {
  if (amount === null) return "—";
  // A visible range is already formatted as the brief showed it.
  if (typeof amount === "string") return amount === "" ? "—" : escapeMd(amount);
  const [whole, fraction] = String(amount).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function evidenceRefs(refs: string[]): string {
  return refs.length === 0 ? "" : ` (evidence: ${refs.map(escapeMd).join(", ")})`;
}

function bulletLines(items: string[], empty = "None recorded."): string {
  return items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");
}

function renderFactList(facts: Record<string, PermissionFact>): string {
  const lines: string[] = [];
  for (const key of Object.keys(facts).sort()) {
    const fact = facts[key]!;
    lines.push(
      `- **${escapeMd(key)}:** ${fact.status}${evidenceRefs(fact.evidence_refs)}`,
    );
    for (const condition of fact.conditions) {
      lines.push(`  - ${condition.text}`);
    }
  }
  return lines.length === 0 ? "None recorded." : lines.join("\n");
}

function renderActivity(items: ActivityItem[]): string {
  if (items.length === 0) return "None recorded.";
  return items
    .map((item) => {
      const title = item.title ?? item.kind.replace(/_/g, " ");
      const date = item.timestamp === null ? "" : ` — ${item.timestamp}`;
      const source = item.sourceUrl === null ? "" : ` ([source](${item.sourceUrl}))`;
      return `### ${escapeMd(title)}${date}\n\n${item.body}${source}`;
    })
    .join("\n\n");
}

function quoted(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function renderEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) return "None recorded.";
  return evidence
    .map((item) => {
      const locator = [item.locator.section, item.locator.subsection]
        .filter((part): part is string => part !== undefined)
        .join(" / ");
      // Everything the content hash covers is printed beside it, so a
      // reader can recompute the corpus from this file alone instead of
      // taking `evidence_hash_valid` on trust (spec 14, 21).
      const metadata = [
        `- Source key: ${escapeMd(item.source_key)}`,
        `- Source level: ${escapeMd(item.source_level)}`,
        `- Source type: ${item.source.type}`,
        `- URL: ${item.source.url}`,
        `- Authenticated: ${item.source.authenticated}`,
        `- Section: ${locator === "" ? "—" : escapeMd(locator)}`,
        `- Collected at: ${escapeMd(item.collected_at)}`,
        `- Content hash: ${escapeMd(item.content_hash)}`,
        `- Extraction: ${item.extraction.status} (parser ${escapeMd(item.extraction.parser_version)})`,
      ].join("\n");
      return `### ${item.id}\n\n${metadata}\n\n${quoted(item.quote)}`;
    })
    .join("\n\n");
}

function authorizationEvidence(model: DocumentModel): Evidence[] {
  const wanted = new Set(model.engagement.safeHarbor.evidence_refs);
  return model.evidence.filter(
    (item) =>
      wanted.has(item.id) || /(?:authorization|safe[-_:]?harbor)/i.test(item.source_key),
  );
}

function renderKnownIssues(model: DocumentModel): string {
  if (model.knownIssues.length === 0) return "None recorded.";
  return model.knownIssues
    .map((result) => {
      const counts = `Displayed: ${result.displayedCount ?? "unknown"}; collected: ${result.collectedCount}.`;
      const mismatch = result.countMatches
        ? ""
        : `\n\n⚠ Count mismatch: displayed ${result.displayedCount ?? "unknown"}, collected ${result.collectedCount}`;
      const rows =
        result.columns.length === 0
          ? "No tabular rows recorded."
          : mdTable(result.columns, result.rows.map((row) => row.cells));
      return `### ${escapeMd(result.targetId)}\n\n${counts}${mismatch}\n\n${rows}${evidenceRefs(result.evidence_refs)}`;
    })
    .join("\n\n");
}

export function renderMarkdown(model: DocumentModel): string {
  const overviewRows = [
    ["Name", value(model.engagement.name)],
    ["Code", value(model.engagement.code)],
    ["UUID", value(model.engagement.uuid)],
    ["Type", value(model.engagement.type)],
    ["Managed bounty", value(model.engagement.managedBounty)],
    ["Lifecycle", value(model.engagement.lifecycleStatus)],
    ["Testing start", value(model.engagement.testingStart)],
    ["Testing end", value(model.engagement.testingEnd)],
    ["Testing period", value(model.engagement.testingPeriodLabel)],
    ["Last status transition", value(model.engagement.lastStatusTransition)],
    ["Last brief update", value(model.engagement.lastBriefUpdate)],
  ];
  const statistics = Object.keys(model.statistics)
    .sort()
    .map((key) => [key, model.statistics[key]!.value, model.statistics[key]!.window ?? "—"]);

  const scopeRows = model.targets
    .filter((target) => target.inScope)
    .map((target) => [
      target.id,
      target.location ?? target.name ?? "—",
      target.category ?? "—",
      target.tags.join(", ") || "—",
    ]);
  const outOfScope = model.outOfScope.map((target) => {
    const identity = target.location ?? target.name ?? "Unnamed target";
    return `${identity}${target.notes === null ? "" : ` — ${target.notes}`}`;
  });

  const rewardRows = model.targetGroups.map((group) => [
    group.name,
    formatAmount(group.rewards.p1),
    formatAmount(group.rewards.p2),
    formatAmount(group.rewards.p3),
    formatAmount(group.rewards.p4),
    formatAmount(group.rewards.p5),
  ]);

  // The two exclusion axes stay in separate columns; collapsing them into one
  // bullet is what let "not accepted" read as "not testable".
  const exclusions =
    model.submissionExclusions.length === 0
      ? bulletLines(model.nonFocusAreas)
      : mdTable(
          ["Excluded submission", "Submission", "Testing", "Reward"],
          model.submissionExclusions.map((item) => [
            item.text,
            item.submission_status,
            item.testing_status,
            item.reward_status,
          ]),
        );
  const scope = model.scopeAuthorization;
  const exceptionLines = (scope?.exceptions ?? []).map((e) =>
    e.condition.kind === "prior_written_consent"
      ? `- Exception (${escapeMd(e.applies_to)}): verified prior written consent from the program security team — re-opens evaluation only, never an automatic permission${evidenceRefs(e.evidence_refs)}`
      : `- Exception (${escapeMd(e.applies_to)}): ${escapeMd(e.condition.text)}${evidenceRefs(e.evidence_refs)}`,
  );
  const scopeAuthorization =
    scope === null
      ? ""
      : `${[
          `- Listed targets: ${scope.listed_targets.status}`,
          ...scope.listed_targets.conditions.map(
            (condition) => `  - ${escapeMd(condition)}`,
          ),
          `- Unlisted targets: ${scope.unlisted_targets.status}`,
          ...exceptionLines,
          `- Source: ${quoted(scope.quote)}${evidenceRefs(scope.evidence_refs)}`,
        ].join("\n")}\n\n`;
  const programState =
    model.programState === null
      ? ""
      : `### Program state\n\n${[
          `- Submissions: ${model.programState.submission_state}`,
          `- Testing authorization: ${model.programState.testing_state}`,
          `- Rewards: ${model.programState.reward_state}`,
          `- Effective: ${value(model.programState.effective_at_text)}`,
          `- Resume date: ${value(model.programState.resume_at)}`,
        ].join("\n")}${evidenceRefs(model.programState.evidence_refs)}\n\n`;

  const authStatements = authorizationEvidence(model).map(
    (item) => `${item.quote}${evidenceRefs([item.id])}`,
  );
  const accountRules = model.accountRules.map(
    (rule) => `${rule.text}${evidenceRefs(rule.evidence_refs)}`,
  );
  const dataRules = model.dataRules.map(
    (rule) => `${rule.text}${evidenceRefs(rule.evidence_refs)}`,
  );

  const vrtParts = [
    `- Version: ${value(model.vrt.version)}`,
    `- Baseline: ${value(model.vrt.baseline)}`,
    `- Evidence: ${model.vrt.evidence_refs.length === 0 ? "—" : model.vrt.evidence_refs.map(escapeMd).join(", ")}`,
    "",
    "### Scope rules",
    "",
    model.vrt.scope_rules.length === 0
      ? "None recorded."
      : mdTable(
          ["Vulnerability class", "VRT", "Applies to", "Status", "Note"],
          model.vrt.scope_rules.map((rule) => [
            rule.category,
            rule.vrt_version ?? "—",
            rule.applies_to ?? "—",
            rule.status,
            rule.note ?? "—",
          ]),
        ),
    "",
    "### Exclusions",
    "",
    bulletLines(model.vrt.exclusions),
    "",
    "### Deviations",
    "",
    bulletLines(model.vrt.deviations),
    "",
    "### Target-specific rules",
    "",
    bulletLines(model.vrt.targetSpecific),
    "",
    "### Notes",
    "",
    bulletLines(model.vrt.notes),
  ].join("\n");

  const constraints = [
    "### Technique constraints",
    "",
    renderFactList(model.techniques),
    "",
    "### Account rules",
    "",
    bulletLines(accountRules),
    "",
    "### Data and resource rules",
    "",
    bulletLines(dataRules),
  ].join("\n");

  const activity = [
    "### Announcements",
    "",
    renderActivity(model.announcements),
    "",
    "### Changelog",
    "",
    renderActivity(model.changelog),
  ].join("\n");

  const recent = [
    "### Recent activity",
    "",
    renderActivity(model.recentActivity),
    "",
    "### Accepted reports",
    "",
    renderActivity(model.acceptedReports),
    "",
    "### Participation and response statistics",
    "",
    statistics.length === 0
      ? "None recorded."
      : mdTable(["Metric", "Value", "Window"], statistics),
  ].join("\n");

  const conflicts = model.provenance.conflicts.map(
    (conflict) => `${conflict.factKey}${evidenceRefs(conflict.evidence_refs)}`,
  );
  const provenance = [
    `- Parser version: ${escapeMd(model.provenance.parser_version)}`,
    `- Collected at: ${escapeMd(model.provenance.collected_at)}`,
    "",
    "### Conflicts",
    "",
    bulletLines(conflicts),
    "",
    "### Missing sections",
    "",
    bulletLines(model.provenance.missing_sections.map(escapeMd)),
    "",
    "### Collection issues",
    "",
    bulletLines(
      model.provenance.collection_issues.map(
        (issue) =>
          `${escapeMd(issue.code)} — ${escapeMd(issue.target_id)} (displayed ${
            issue.displayed_count ?? "unknown"
          }, collected ${issue.collected_count})`,
      ),
    ),
    "",
    "### Warnings",
    "",
    bulletLines(model.quality.warnings.map(escapeMd)),
  ].join("\n");

  const sections: [string, string][] = [
    ["Agent Facts", renderAgentFacts(model)],
    [
      "Engagement Overview",
      `${mdTable(["Field", "Value"], overviewRows)}\n\n### Key statistics\n\n${
        statistics.length === 0
          ? "None recorded."
          : mdTable(["Metric", "Value", "Window"], statistics)
      }`,
    ],
    [
      "Authorization and Safe Harbor",
      `- Status: ${model.engagement.safeHarbor.status}\n- Level: ${value(model.engagement.safeHarbor.level)}\n- Disclosure policy: ${value(model.engagement.disclosurePolicy)}\n\n${programState}${scopeAuthorization}${bulletLines(authStatements)}`,
    ],
    [
      "Scope Inventory",
      `### In-scope targets\n\n${
        scopeRows.length === 0
          ? "None recorded."
          : mdTable(["ID", "Location / name", "Category", "Tags"], scopeRows)
      }\n\n### Out-of-scope targets\n\n${bulletLines(outOfScope)}`,
    ],
    [
      "Reward Matrix",
      rewardRows.length === 0
        ? "None recorded."
        : mdTable(["Group", "P1", "P2", "P3", "P4", "P5"], rewardRows),
    ],
    ["Known Issues", renderKnownIssues(model)],
    ["VRT Policy", vrtParts],
    ["Testing, Account, Resource, and Data Constraints", constraints],
    [
      "Focus Areas / Explicit Exclusions",
      `### Focus areas\n\n${bulletLines(model.focusAreas)}\n\n### Explicit exclusions\n\n${exclusions}`,
    ],
    [
      "Credentials and Access",
      "Credential material is not included in this export. Follow the engagement's visible access instructions.",
    ],
    ["Reporting Requirements", bulletLines(model.reportingRequirements)],
    ["Announcements and Changelog", activity],
    ["Recent Activity, Participation, Response Statistics", recent],
    ["Evidence Objects", renderEvidence(model.evidence)],
    ["Collection Provenance, Conflicts, Missing Sections, Warnings", provenance],
  ];

  return `${renderFrontMatter(model)}\n${sections
    .map(([heading, body]) => `## ${heading}\n\n${body}`)
    .join("\n\n")}\n`;
}
