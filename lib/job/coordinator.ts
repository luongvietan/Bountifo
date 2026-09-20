import { browser } from "wxt/browser";
import { normalizeText } from "../canonical";
import { downloadMarkdown } from "../download";
import {
  buildEvidence,
  evidenceCorpusHash,
  normalizedHash,
  validateEvidenceSet,
} from "../evidence";
import { exportFileName, isSupportedEngagementUrl, parseEngagementUrl } from "../ids";
import type { JobMessage } from "../messages";
import { validateJobSender } from "../messages";
import { assembleDocument, stripVolatile } from "../model/document";
import {
  buildPermissionFact,
  buildSafeHarborFact,
  mapTechnique,
  type AssertionInput,
} from "../model/facts";
import { computeIntegrity, type UnitOutcome } from "../model/integrity";
import { assignTargetIdentities } from "../model/targetIds";
import { renderMarkdown } from "../render/markdown";
import type { ApiEngagementData, Evidence, PermissionFact, SourceRecord } from "../types";
import {
  clearDescriptor,
  newDescriptor,
  readDescriptor,
  writeDescriptor,
  type JobDescriptor,
} from "./descriptor";
import {
  commitUnit,
  getAllEvidence,
  getAllFacts,
  getAllRecords,
  getBlob,
  getUnitResults,
  openStore,
  purgeJob,
  verifyJobData,
  type JobDb,
  type UnitResult,
} from "./store";
import { UNIT_ORDER, UNIT_PHASE, type UnitId } from "./units";
import type { fetchEngagementEnrichment } from "../api/engagements";

export interface CoordinatorDeps {
  sendToTab(tabId: number, msg: unknown): Promise<unknown>;
  apiEnrich(code: string, uuid: string | null): ReturnType<typeof fetchEngagementEnrichment>;
  now(): string;
  getTabUrl?: (tabId: number) => Promise<string | null>;
  download?: typeof downloadMarkdown;
}

type Envelope = { ok: boolean; result?: unknown; error?: { kind?: string; message?: string } };
type CollectorResult = Record<string, unknown> & { records?: SourceRecord[] };

const REQUIRED = new Set<UnitId>([
  "u03_collect_details",
  "u05_collect_targets",
  "u06_collect_policy",
  "u07_collect_activity",
  "u08_known_issues",
]);
const CRITICAL = new Set<UnitId>([
  "u01_validate_url",
  "u02_init_job",
  "u03_collect_details",
  "u09_build_evidence",
  "u10_normalize_facts",
  "u11_integrity_check",
  "u12_render_download",
]);
const CONTENT_KIND: Partial<Record<UnitId, string>> = {
  u03_collect_details: "collect_details",
  u05_collect_targets: "collect_targets",
  u06_collect_policy: "collect_policy",
  u07_collect_activity: "collect_activity",
};
const UNIT_BLOB: Partial<Record<UnitId, string>> = {
  u03_collect_details: "detailsData",
  u04_api_enrichment: "apiData",
  u05_collect_targets: "targetsData",
  u06_collect_policy: "policyData",
  u07_collect_activity: "activityData",
  u08_known_issues: "kiResults",
  u09_build_evidence: "evidenceBuilt",
  u10_normalize_facts: "normalizedData",
  u11_integrity_check: "document",
  u12_render_download: "markdown",
};

function asEnvelope(value: unknown): Envelope {
  if (typeof value !== "object" || value === null || typeof (value as { ok?: unknown }).ok !== "boolean") {
    return { ok: false, error: { kind: "invalid_response", message: "invalid content response" } };
  }
  return value as Envelope;
}

function withoutRecords(value: CollectorResult): Record<string, unknown> {
  const { records: _records, ...rest } = value;
  return rest;
}

function targetMatch(dom: { location: string | null; name: string | null }, api: ApiEngagementData | null) {
  if (api === null) return null;
  const location = normalizeText(dom.location ?? "");
  const name = normalizeText(dom.name ?? "");
  return api.targets.find((target) =>
    (location !== "" && normalizeText(target.location ?? "") === location) ||
    (location === "" && name !== "" && normalizeText(target.name ?? "") === name),
  ) ?? null;
}

function groupMatch(dom: { name: string }, api: ApiEngagementData | null) {
  if (api === null) return null;
  const name = normalizeText(dom.name);
  return api.targetGroups.find((group) => normalizeText(group.name) === name) ?? null;
}

function ruleStatus(text: string): "allowed" | "prohibited" | "conditional" | "unspecified" {
  if (/\b(?:must\s+not|do\s+not|not\s+allowed|prohibited|forbidden|never)\b/i.test(text)) return "prohibited";
  if (/\b(?:only|unless|provided\s+that|with\s+(?:prior\s+)?permission)\b/i.test(text)) return "conditional";
  if (/\b(?:allowed|permitted|may)\b/i.test(text)) return "allowed";
  return "unspecified";
}

function ruleTechniqueKey(text: string, fallbackIndex: number): string {
  const known: [RegExp, string][] = [
    [/automat/i, "automation"],
    [/\bscann?(?:ing|er|ers|ed|s)?\b/i, "scanning"],
    [/brute[\s-]?force|credential\s*stuff/i, "brute force"],
    [/denial[\s-]?of[\s-]?service|\bd?dos\b/i, "denial of service"],
    [/social[\s-]?engineer|phishing|vishing|smishing/i, "social engineering"],
    [/physical(?:ly)?[\s-]?(?:test|access|attack)/i, "physical testing"],
  ];
  return known.find(([pattern]) => pattern.test(text))?.[1] ??
    `target_rule_${String(fallbackIndex + 1).padStart(3, "0")}`;
}

export class JobCoordinator {
  private descriptor: JobDescriptor | null = null;
  private db: JobDb | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  get state(): JobDescriptor | null {
    return this.descriptor;
  }

  async waitForIdle(): Promise<void> {
    await this.running;
  }

  private async database(): Promise<JobDb> {
    this.db ??= await openStore();
    return this.db;
  }

  private async persist(patch: Partial<JobDescriptor>): Promise<void> {
    if (this.descriptor === null) return;
    this.descriptor = { ...this.descriptor, ...patch, updatedAt: this.deps.now() };
    await writeDescriptor(this.descriptor);
  }

  async start(tabId: number): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
    if (this.running !== null) return { ok: false, error: "job_active" };
    const persisted = await readDescriptor();
    if (
      persisted !== null &&
      !["done", "failed", "cancelled"].includes(persisted.phase)
    ) {
      return { ok: false, error: "job_active" };
    }
    const url = this.deps.getTabUrl
      ? await this.deps.getTabUrl(tabId)
      : (await browser.tabs.get(tabId)).url ?? null;
    if (url === null || !isSupportedEngagementUrl(url)) return { ok: false, error: "unsupported_url" };
    const parsed = parseEngagementUrl(url)!;
    this.descriptor = newDescriptor(tabId, parsed.code, url);
    this.descriptor.createdAt = this.deps.now();
    this.descriptor.updatedAt = this.deps.now();
    await writeDescriptor(this.descriptor);
    this.running = this.run().finally(() => { this.running = null; });
    return { ok: true, jobId: this.descriptor.jobId };
  }

  async resume(): Promise<void> {
    if (this.running !== null) return this.running;
    const descriptor = await readDescriptor();
    if (descriptor === null) return;
    this.descriptor = descriptor;
    const db = await this.database();
    if (["done", "failed", "cancelled"].includes(descriptor.phase)) {
      await purgeJob(db, descriptor.jobId);
      await clearDescriptor();
      return;
    }
    const required = descriptor.completedUnits.flatMap((unit) => {
      const blob = UNIT_BLOB[unit as UnitId];
      return blob === undefined ? [unit] : [unit, blob];
    });
    const verified = await verifyJobData(db, descriptor.jobId, required);
    if (!verified.ok) {
      await this.finish("failed");
      return;
    }
    this.running = this.run().finally(() => { this.running = null; });
    await this.running;
  }

  async cancel(): Promise<void> {
    if (this.descriptor === null) this.descriptor = await readDescriptor();
    if (this.descriptor === null) return;
    await this.persist({ cancelRequested: true });
    if (this.running !== null) await this.running;
    else await this.finish("cancelled");
  }

  async handleJobMessage(
    msg: JobMessage,
    sender: { id?: string; tab?: { id?: number; url?: string } },
  ): Promise<unknown> {
    if (this.descriptor === null) this.descriptor = await readDescriptor();
    if (this.descriptor === null) return { ok: false, error: "unknown_job" };
    const validation = validateJobSender(sender, msg, this.descriptor, this.descriptor.phase);
    if (!validation.ok) return { ok: false, error: "forbidden" };
    if ("unitId" in msg && this.descriptor.currentUnit !== msg.unitId) {
      return { ok: false, error: "unexpected_unit" };
    }
    if (msg.op === "UNIT_PROGRESS") {
      await this.persist({ counters: { ...this.descriptor.counters, ...msg.counters } });
      return { ok: true };
    }
    if (msg.op === "PAGE_READY" && this.running === null && this.descriptor.currentUnit !== null) {
      this.running = this.run().finally(() => { this.running = null; });
    }
    return { ok: true };
  }

  private async run(): Promise<void> {
    try {
      while (this.descriptor !== null && this.descriptor.pendingUnits.length > 0) {
        if (this.descriptor.cancelRequested) {
          await this.finish("cancelled");
          return;
        }
        const unitId = this.descriptor.pendingUnits[0] as UnitId;
        if (unitId === "u13_cleanup") {
          await this.finish("done");
          return;
        }
        await this.persist({ currentUnit: unitId, phase: UNIT_PHASE[unitId] });
        const result = await this.execute(unitId);
        if (result.fatal) {
          await this.finish("failed");
          return;
        }
        const completedUnits = [...this.descriptor.completedUnits, unitId];
        const pendingUnits = this.descriptor.pendingUnits.filter((id) => id !== unitId);
        await this.persist({
          completedUnits,
          pendingUnits,
          currentUnit: null,
          warnings: this.descriptor.warnings + (result.warning ? 1 : 0),
          counters: { ...this.descriptor.counters, unitDone: completedUnits.length },
        });
      }
    } catch {
      await this.finish("failed");
    }
  }

  private async dispatchContent(unitId: UnitId, kind: string, params?: Record<string, unknown>): Promise<Envelope> {
    if (this.descriptor === null) return { ok: false };
    if (this.descriptor.cancelRequested) return { ok: false, error: { kind: "cancelled" } };
    try {
      return asEnvelope(await this.deps.sendToTab(this.descriptor.tabId, {
        op: "RUN_UNIT",
        jobId: this.descriptor.jobId,
        unitId,
        kind,
        ...(params === undefined ? {} : { params }),
      }));
    } catch {
      return { ok: false, error: { kind: "tab_closed", message: "engagement tab unavailable" } };
    }
  }

  private async execute(unitId: UnitId): Promise<{ warning: boolean; fatal: boolean }> {
    const descriptor = this.descriptor!;
    const db = await this.database();
    const committedAt = this.deps.now();
    if (unitId === "u01_validate_url" || unitId === "u02_init_job") {
      await commitUnit(db, descriptor.jobId, unitId, {}, { unitId, status: "ok", committedAt });
      return { warning: false, fatal: false };
    }

    const kind = CONTENT_KIND[unitId];
    if (kind !== undefined) {
      const envelope = await this.dispatchContent(unitId, kind);
      if (!envelope.ok) return this.recordFailure(unitId, envelope.error?.kind ?? "unit_failed");
      const output = (envelope.result ?? {}) as CollectorResult;
      const blobKind = UNIT_BLOB[unitId]!;
      await commitUnit(
        db,
        descriptor.jobId,
        unitId,
        { records: output.records ?? [], blob: { kind: blobKind, value: unitId === "u03_collect_details" || unitId === "u06_collect_policy" ? output.data : withoutRecords(output) } },
        { unitId, status: "ok", committedAt },
      );
      return { warning: false, fatal: false };
    }

    if (unitId === "u04_api_enrichment") {
      const result = await this.deps.apiEnrich(descriptor.engagementCode, null);
      if (!result.ok) {
        await commitUnit(db, descriptor.jobId, unitId, { blob: { kind: "apiData", value: null } }, { unitId, status: "warning", committedAt, output: { error: result.error.kind } });
        return { warning: true, fatal: false };
      }
      await commitUnit(db, descriptor.jobId, unitId, { records: result.records, blob: { kind: "apiData", value: result.data } }, { unitId, status: "ok", committedAt });
      return { warning: false, fatal: false };
    }

    if (unitId === "u08_known_issues") return this.collectKnownIssues(db, descriptor);
    if (unitId === "u09_build_evidence") {
      const records = await getAllRecords(db, descriptor.jobId);
      const evidence = await buildEvidence(records, { collectedAt: this.deps.now() });
      await commitUnit(db, descriptor.jobId, unitId, { evidence, blob: { kind: "evidenceBuilt", value: true } }, { unitId, status: "ok", committedAt });
      return { warning: false, fatal: false };
    }
    if (unitId === "u10_normalize_facts") return this.normalize(db, descriptor);
    if (unitId === "u11_integrity_check") return this.buildDocument(db, descriptor);
    if (unitId === "u12_render_download") {
      const document = await getBlob<import("../model/document").DocumentModel>(db, descriptor.jobId, "document");
      if (document === null) return this.recordFailure(unitId, "missing_document");
      const markdown = renderMarkdown(document);
      await (this.deps.download ?? downloadMarkdown)(exportFileName(descriptor.engagementCode, new Date(this.deps.now())), markdown);
      await commitUnit(db, descriptor.jobId, unitId, { blob: { kind: "markdown", value: markdown } }, { unitId, status: "ok", committedAt });
      return { warning: false, fatal: false };
    }
    return { warning: false, fatal: false };
  }

  private async recordFailure(unitId: UnitId, kind: string): Promise<{ warning: boolean; fatal: boolean }> {
    const db = await this.database();
    const optional = unitId === "u04_api_enrichment";
    const placeholder =
      unitId === "u05_collect_targets"
        ? { kind: "targetsData", value: { groups: [], targets: [], rules: [] } }
        : unitId === "u06_collect_policy"
          ? {
              kind: "policyData",
              value: {
                safeHarborStatements: [],
                authorizationStatements: [],
                techniques: [],
                accountRules: [],
                dataRules: [],
                focusAreas: [],
                nonFocusAreas: [],
                reportingRequirements: [],
                vrt: {
                  version: null,
                  baseline: null,
                  exclusions: [],
                  deviations: [],
                  targetSpecific: [],
                  notes: [],
                },
              },
            }
          : unitId === "u07_collect_activity"
            ? {
                kind: "activityData",
                value: {
                  announcements: [],
                  changelog: [],
                  recentActivity: [],
                  acceptedReports: [],
                  stats: {},
                },
              }
            : unitId === "u08_known_issues"
              ? { kind: "kiResults", value: [] }
              : undefined;
    await commitUnit(db, this.descriptor!.jobId, unitId, placeholder === undefined ? {} : { blob: placeholder }, {
      unitId,
      status: optional ? "warning" : "failed",
      committedAt: this.deps.now(),
      output: { error: kind },
    });
    return { warning: optional || !CRITICAL.has(unitId), fatal: kind === "session_expired" || kind === "tab_closed" || CRITICAL.has(unitId) };
  }

  private async collectKnownIssues(db: JobDb, descriptor: JobDescriptor) {
    const targetsData = await getBlob<{ targets: Record<string, unknown>[] }>(db, descriptor.jobId, "targetsData");
    if (targetsData === null) return this.recordFailure("u08_known_issues", "missing_targets");
    const collected = (await getBlob<unknown[]>(db, descriptor.jobId, "kiResults")) ?? [];
    const done = new Set(collected.map((item) => String((item as { targetDomKey?: unknown }).targetDomKey)));
    await this.persist({ counters: { ...descriptor.counters, kiDone: done.size, kiTotal: targetsData.targets.length } });
    for (const target of targetsData.targets) {
      const domKey = String(target.domKey);
      if (done.has(domKey)) continue;
      const envelope = await this.dispatchContent("u08_known_issues", "collect_ki", { target, kiTotal: targetsData.targets.length });
      if (!envelope.ok) return this.recordFailure("u08_known_issues", envelope.error?.kind ?? "unit_failed");
      collected.push(envelope.result);
      done.add(domKey);
      await commitUnit(db, descriptor.jobId, "u08_known_issues", { records: ((envelope.result as CollectorResult)?.records ?? []), blob: { kind: "kiResults", value: collected } }, { unitId: "u08_known_issues", status: "ok", committedAt: this.deps.now(), output: { kiDone: [...done] } });
      await this.persist({ counters: { ...this.descriptor!.counters, kiDone: done.size, kiTotal: targetsData.targets.length } });
    }
    if (targetsData.targets.length === 0) {
      await commitUnit(db, descriptor.jobId, "u08_known_issues", { blob: { kind: "kiResults", value: collected } }, { unitId: "u08_known_issues", status: "ok", committedAt: this.deps.now(), output: { kiDone: [] } });
    }
    return { warning: false, fatal: false };
  }

  private async normalize(db: JobDb, descriptor: JobDescriptor) {
    const targetsData = await getBlob<any>(db, descriptor.jobId, "targetsData");
    const policy = await getBlob<any>(db, descriptor.jobId, "policyData");
    const api = await getBlob<ApiEngagementData>(db, descriptor.jobId, "apiData");
    if (targetsData === null || policy === null) return this.recordFailure("u10_normalize_facts", "missing_inputs");
    const pairs = targetsData.targets.map((dom: any) => ({ dom, api: targetMatch(dom, api) }));
    const identities = await assignTargetIdentities(
      pairs.map(({ dom, api: target }: any) => ({ apiId: target?.id ?? null, location: dom.location, name: dom.name, type: dom.category, groupKey: dom.groupDomKey })),
      api?.uuid ?? descriptor.initialUrl,
    );
    const evidence = await getAllEvidence(db, descriptor.jobId);
    const assertionsByTechnique = new Map<string, AssertionInput[]>();
    const addAssertion = (key: string, assertion: AssertionInput) => {
      const existing = assertionsByTechnique.get(key);
      if (existing === undefined) assertionsByTechnique.set(key, [assertion]);
      else existing.push(assertion);
    };
    for (const technique of policy.techniques ?? []) {
      const matching = evidence.filter((item) => normalizeText(item.quote) === normalizeText(technique.quote));
      addAssertion(
        technique.name,
        mapTechnique(technique, matching, { type: "engagement" }),
      );
    }
    const targetIdByDomKey = new Map(
      pairs.map(({ dom }: any, index: number) => [dom.domKey, identities[index]!.id]),
    );
    const groupIdByDomKey = new Map(
      targetsData.groups.map((dom: any) => [dom.domKey, groupMatch(dom, api)?.id ?? dom.domKey]),
    );
    for (const [index, rule] of (targetsData.rules ?? []).entries()) {
      const targetIds = (rule.appliesToDomKeys as string[])
        .map((key) => targetIdByDomKey.get(key))
        .filter((id): id is string => id !== undefined);
      const groupIds = (rule.appliesToDomKeys as string[])
        .map((key) => groupIdByDomKey.get(key))
        .filter((id): id is string => id !== undefined);
      const applies_to =
        targetIds.length > 0 && groupIds.length === 0
          ? { type: "target_ids" as const, ids: [...new Set(targetIds)].sort() }
          : groupIds.length > 0 && targetIds.length === 0
            ? { type: "target_group_ids" as const, ids: [...new Set(groupIds)].sort() }
            : { type: "engagement" as const };
      const matching = evidence.filter((item) => normalizeText(item.quote) === normalizeText(rule.text));
      addAssertion(ruleTechniqueKey(rule.text, index), {
        status: ruleStatus(rule.text),
        conditions: [],
        applies_to,
        evidence: matching,
      });
    }
    const techniques: Record<string, PermissionFact> = Object.fromEntries(
      [...assertionsByTechnique.entries()].map(([key, assertions]) => [
        key,
        buildPermissionFact(assertions),
      ]),
    );
    const safeEvidence = evidence.filter((item) => (policy.safeHarborStatements ?? []).some((text: string) => normalizeText(text) === normalizeText(item.quote)));
    const safeHarbor = buildSafeHarborFact({ present: safeEvidence });
    const normalized = {
      groups: targetsData.groups.map((dom: any) => ({ dom, api: groupMatch(dom, api) })),
      targets: pairs.map((pair: any, index: number) => ({ ...pair, identity: identities[index] })),
      techniques,
      safeHarbor,
    };
    await commitUnit(db, descriptor.jobId, "u10_normalize_facts", { facts: techniques, blob: { kind: "normalizedData", value: normalized } }, { unitId: "u10_normalize_facts", status: "ok", committedAt: this.deps.now() });
    return { warning: false, fatal: false };
  }

  private async buildDocument(db: JobDb, descriptor: JobDescriptor) {
    const details = await getBlob<any>(db, descriptor.jobId, "detailsData");
    const api = await getBlob<ApiEngagementData>(db, descriptor.jobId, "apiData");
    const targetsData = await getBlob<any>(db, descriptor.jobId, "targetsData");
    const policy = await getBlob<any>(db, descriptor.jobId, "policyData");
    const activity = await getBlob<any>(db, descriptor.jobId, "activityData");
    const kiResults = (await getBlob<any[]>(db, descriptor.jobId, "kiResults")) ?? [];
    const normalized = await getBlob<any>(db, descriptor.jobId, "normalizedData");
    if (targetsData === null || normalized === null) return this.recordFailure("u11_integrity_check", "missing_inputs");
    const records = await getAllRecords(db, descriptor.jobId);
    const evidence = await getAllEvidence(db, descriptor.jobId);
    const facts = await getAllFacts(db, descriptor.jobId);
    const results = await getUnitResults(db, descriptor.jobId);
    const outcomes: UnitOutcome[] = results.map((result) => ({
      unitId: result.unitId,
      status: result.status === "ok" ? "ok" : result.status,
      required: REQUIRED.has(result.unitId as UnitId),
      critical: CRITICAL.has(result.unitId as UnitId),
      warnings:
        result.status === "ok"
          ? []
          : [`unit_${result.status}:${result.unitId}`],
    }));
    const corpusHash = await evidenceCorpusHash(evidence);
    const evidenceHashValid = await validateEvidenceSet(records, evidence);
    const placeholder = `sha256:${"0".repeat(64)}`;
    let integrity = computeIntegrity({ outcomes, kiResults, apiFailed: api === null, domCriticalFailure: null, facts, evidence, corpusHash, normalizedHash: placeholder, evidenceHashValid });
    const args = {
      jobId: descriptor.jobId,
      generatedAt: this.deps.now(),
      collectedAt: this.deps.now(),
      canonicalUrl: descriptor.initialUrl,
      api,
      details,
      groups: normalized.groups,
      targets: normalized.targets,
      rules: targetsData.rules ?? [],
      policy,
      activity,
      kiResults: kiResults.map((result) => ({ result, targetId: normalized.targets.find((item: any) => item.dom.domKey === result.targetDomKey)?.identity.id ?? result.targetDomKey })),
      techniques: normalized.techniques,
      safeHarbor: normalized.safeHarbor,
      records,
      evidence,
      integrity,
    };
    const draft = assembleDocument(args);
    const stripped = stripVolatile(draft) as any;
    stripped.collection.normalized_hash = "";
    const hash = await normalizedHash(stripped);
    integrity = computeIntegrity({ outcomes, kiResults, apiFailed: api === null, domCriticalFailure: null, facts, evidence, corpusHash, normalizedHash: hash, evidenceHashValid });
    const document = assembleDocument({ ...args, integrity });
    await commitUnit(db, descriptor.jobId, "u11_integrity_check", { blob: { kind: "document", value: document } }, { unitId: "u11_integrity_check", status: "ok", committedAt: this.deps.now() });
    await this.persist({ unresolvedConflicts: integrity.policy.unresolved_conflicts, warnings: integrity.quality.warnings.length });
    return { warning: false, fatal: false };
  }

  private async finish(phase: "done" | "failed" | "cancelled"): Promise<void> {
    if (this.descriptor === null) return;
    const descriptor = this.descriptor;
    try {
      await this.deps.sendToTab(descriptor.tabId, { op: "RUN_UNIT", jobId: descriptor.jobId, unitId: "u13_cleanup", kind: "restore_page" });
    } catch {
      // Cleanup is best effort when the tab is already gone.
    }
    const completedUnits = descriptor.completedUnits.includes("u13_cleanup")
      ? descriptor.completedUnits
      : [...descriptor.completedUnits, "u13_cleanup"];
    this.descriptor = {
      ...descriptor,
      phase,
      currentUnit: null,
      completedUnits,
      pendingUnits: [],
      counters: { ...descriptor.counters, unitDone: completedUnits.length },
      updatedAt: this.deps.now(),
    };
    const db = await this.database();
    await clearDescriptor();
    await purgeJob(db, descriptor.jobId);
  }
}
