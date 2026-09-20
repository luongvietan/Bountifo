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
  const facts = {
    techniques,
    safe_harbor: model.engagement.safeHarbor,
    collection: model.collection,
    integrity: model.integrity,
    policy: model.policy,
  };
  return `\`\`\`yaml\n${stringifyYaml(facts, { lineWidth: 0 }).trimEnd()}\n\`\`\``;
}

function value(value: string | number | boolean | null): string {
  return value === null ? "—" : escapeMd(String(value));
}

function formatAmount(amount: number | null): string {
  if (amount === null) return "—";
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
      const metadata = [
        `- Source key: ${escapeMd(item.source_key)}`,
        `- Source level: ${escapeMd(item.source_level)}`,
        `- URL: ${item.source.url}`,
        `- Section: ${locator === "" ? "—" : escapeMd(locator)}`,
        `- Extraction: ${item.extraction.status}`,
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
      `- Status: ${model.engagement.safeHarbor.status}\n- Level: ${value(model.engagement.safeHarbor.level)}\n- Disclosure policy: ${value(model.engagement.disclosurePolicy)}\n\n${bulletLines(authStatements)}`,
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
      `### Focus areas\n\n${bulletLines(model.focusAreas)}\n\n### Explicit exclusions\n\n${bulletLines(model.nonFocusAreas)}`,
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
