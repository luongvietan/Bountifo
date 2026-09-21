import { canonicalUrl as canonicalizeUrl } from "../canonical";
import {
  API_MAJOR_TARGET,
  API_SCHEMA_TESTED,
  DOCUMENT_SCHEMA_VERSION,
  PARSER_VERSION,
} from "../constants";
import { sortEvidenceForCorpus } from "../evidence";
import type { DetailsData } from "../dom/details";
import type { ParticipationStats, ActivityItem } from "../dom/activity";
import type { DomRule, DomTarget, DomTargetGroup } from "../dom/targets";
import type { KiResult } from "../dom/knownIssues";
import type { PolicyData } from "../dom/policies";
import type { TargetIdentity } from "./targetIds";
import type { IntegrityReport } from "./integrity";
import type {
  ApiEngagementData,
  ApiTarget,
  ApiTargetGroup,
  Evidence,
  IdentityQuality,
  PermissionFact,
  PermissionStatus,
  SafeHarborStatus,
  SourceRecord,
} from "../types";

// ---------------------------------------------------------------------------
// DocumentModel — the versioned, renderer-facing projection of a completed
// collection (spec §16). `generated_at`, `job_id`, and
// `provenance.collected_at` are volatile: they are stamped on the document
// but excluded from `normalized_hash` via stripVolatile.
// ---------------------------------------------------------------------------

export interface DocumentModel {
  schema_version: number;
  generated_at: string;
  job_id: string;
  engagement: {
    name: string | null;
    code: string;
    uuid: string | null;
    canonicalUrl: string;
    type: string | null;
    managedBounty: boolean | null;
    lifecycleStatus: string | null;
    testingStart: string | null;
    testingEnd: string | null;
    testingPeriodLabel: string | null;
    lastStatusTransition: string | null;
    lastBriefUpdate: string | null;
    safeHarbor: {
      status: SafeHarborStatus;
      level: string | null;
      evidence_refs: string[];
    };
    disclosurePolicy: string | null;
  };
  statistics: Record<string, { value: string; window: string | null }>;
  targets: {
    id: string;
    id_source: "api" | "derived";
    identity_quality: IdentityQuality;
    location: string | null;
    name: string | null;
    category: string | null;
    tags: string[];
    docLinks: string[];
    changeFlags: string[];
    inScope: boolean;
    groupId: string | null;
    /** Evidence ids for the scope-table record behind this target row. */
    evidence_refs: string[];
  }[];
  targetGroups: {
    id: string;
    name: string;
    inScope: boolean;
    description: string | null;
    /** Evidence ids for the scope-card record behind this group. */
    evidence_refs: string[];
    /**
     * API amounts are integers; a brief that publishes only a visible range
     * ("$2000 – $3000") keeps that string rather than losing the reward.
     */
    rewards: {
      p1: number | string | null;
      p2: number | string | null;
      p3: number | string | null;
      p4: number | string | null;
      p5: number | string | null;
    };
  }[];
  outOfScope: {
    location: string | null;
    name: string | null;
    notes: string | null;
  }[];
  techniques: Record<string, PermissionFact>;
  accountRules: { text: string; evidence_refs: string[] }[];
  dataRules: { text: string; evidence_refs: string[] }[];
  focusAreas: string[];
  nonFocusAreas: string[];
  /**
   * Excluded submission types on two axes (§11): `submission_status` is what
   * the brief will accept, `testing_status` is what it permits. A report the
   * program will not take is not, by itself, an activity it forbids.
   */
  submissionExclusions: {
    text: string;
    submission_status: "excluded";
    testing_status: PermissionStatus;
    /** Reward axis: "ineligible" only on explicit reward-denial language. */
    reward_status: "ineligible" | "unspecified";
    evidence_refs: string[];
  }[];
  /** Exclusive scope authorization: listed targets vs everything else. */
  scopeAuthorization: {
    listed_targets: { status: PermissionStatus; conditions: string[] };
    unlisted_targets: { status: PermissionStatus };
    quote: string;
    evidence_refs: string[];
  } | null;
  reportingRequirements: string[];
  vrt: {
    version: string | null;
    baseline: string | null;
    /** Vulnerability classes the program rules in or out (§4.4). */
    scope_rules: {
      category: string;
      vrt_version: string | null;
      applies_to: string | null;
      status: "out_of_scope" | "in_scope" | "conditional";
      note: string | null;
      /** Evidence ids for the exact row record behind this rule. */
      evidence_refs: string[];
    }[];
    exclusions: string[];
    deviations: string[];
    targetSpecific: string[];
    notes: string[];
    evidence_refs: string[];
  };
  knownIssues: {
    targetId: string;
    displayedCount: number | null;
    collectedCount: number;
    countMatches: boolean;
    columns: string[];
    rows: { cells: string[]; recognized?: Record<string, string> }[];
    evidence_refs: string[];
  }[];
  announcements: ActivityItem[];
  changelog: ActivityItem[];
  recentActivity: ActivityItem[];
  acceptedReports: ActivityItem[];
  evidence: Evidence[];
  collection: IntegrityReport["collection"];
  integrity: IntegrityReport["integrity"];
  quality: IntegrityReport["quality"];
  policy: IntegrityReport["policy"];
  api: {
    api_major_target: string;
    api_schema_tested: string;
    observed_version: string | null;
    status: string;
  };
  provenance: {
    parser_version: string;
    collected_at: string;
    missing_sections: string[];
    /**
     * Units that were collected but failed a validation (§13 count checks).
     * Distinct from `missing_sections`: the section exists, its numbers do not
     * reconcile, and `integrity.required_sections_complete` says so.
     */
    collection_issues: {
      code: string;
      target_id: string;
      displayed_count: number | null;
      collected_count: number;
    }[];
    conflicts: { factKey: string; evidence_refs: string[] }[];
  };
}

/**
 * Collector outputs paired for the §6.3 merge. The coordinator (u10) pairs
 * each DOM group/target with its API counterpart (canonical name / location
 * match) — `api: null` means no API match, so every field falls back to DOM.
 * API-only groups/targets are not inputs: the researcher-visible DOM defines
 * the exact visible scope.
 */
export interface AssembleArgs {
  jobId: string;
  generatedAt: string;
  collectedAt: string;
  canonicalUrl: string;
  api: ApiEngagementData | null;
  details: DetailsData | null;
  groups: { dom: DomTargetGroup; api: ApiTargetGroup | null }[];
  targets: {
    dom: DomTarget;
    api: ApiTarget | null;
    identity: TargetIdentity;
  }[];
  rules: DomRule[];
  policy: PolicyData | null;
  activity: {
    announcements: ActivityItem[];
    changelog: ActivityItem[];
    recentActivity: ActivityItem[];
    acceptedReports: ActivityItem[];
    stats: ParticipationStats;
  } | null;
  /** KI result + the assigned target id for `result.targetDomKey`. */
  kiResults: { result: KiResult; targetId: string }[];
  techniques: Record<string, PermissionFact>;
  safeHarbor: { status: SafeHarborStatus; evidence_refs: string[] };
  /** Raw source records — used to attach evidence_refs to text fields. */
  records: SourceRecord[];
  evidence: Evidence[];
  integrity: IntegrityReport;
}

/**
 * Known Issues warnings that describe a target the collection never verified.
 * Each one becomes a named collection issue so `required_sections_complete:
 * false` always has a visible, target-scoped reason.
 */
const KI_ISSUE_RE =
  /^ki_(dialog_not_opened|dialog_not_ready|displayed_count_unavailable|pagination_stuck|page_cap_50)\b/;

const cmpStr = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Engagement code from `/engagements/<code>` when neither source has it. */
function codeFromUrl(url: string): string {
  try {
    const m = /\/engagements\/([^/?#]+)/.exec(new URL(url).pathname);
    return m?.[1] !== undefined ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

function canonicalOrRaw(url: string): string {
  try {
    return canonicalizeUrl(url);
  } catch {
    return url;
  }
}

function detailsEmpty(d: DetailsData | null): boolean {
  if (d === null) return true;
  return (
    d.name === null &&
    d.code === null &&
    d.engagementType === null &&
    d.managedBounty === null &&
    d.lifecycleStatus === null &&
    d.testingStart === null &&
    d.testingEnd === null &&
    d.testingPeriodLabel === null &&
    d.lastStatusTransition === null &&
    d.lastBriefUpdate === null &&
    d.safeHarborLevel === null &&
    d.disclosurePolicy === null &&
    Object.keys(d.statistics).length === 0
  );
}

function policyEmpty(p: PolicyData | null): boolean {
  if (p === null) return true;
  return (
    p.safeHarborStatements.length === 0 &&
    p.authorizationStatements.length === 0 &&
    p.techniques.length === 0 &&
    p.accountRules.length === 0 &&
    p.dataRules.length === 0 &&
    p.focusAreas.length === 0 &&
    p.nonFocusAreas.length === 0 &&
    p.reportingRequirements.length === 0 &&
    p.vrt.version === null &&
    p.vrt.baseline === null &&
    p.vrt.exclusions.length === 0 &&
    p.vrt.deviations.length === 0 &&
    p.vrt.targetSpecific.length === 0 &&
    p.vrt.notes.length === 0
  );
}

function activityEmpty(a: AssembleArgs["activity"]): boolean {
  if (a === null) return true;
  return (
    a.announcements.length === 0 &&
    a.changelog.length === 0 &&
    a.recentActivity.length === 0 &&
    a.acceptedReports.length === 0 &&
    Object.keys(a.stats).length === 0
  );
}

/**
 * Deep-clone of the model minus exactly the volatile fields — `generated_at`,
 * `job_id`, and `collected_at` wherever it names a per-run collection
 * timestamp (`provenance.collected_at` and each `evidence[].collected_at`) —
 * so `normalizedHash` output is stable across identical collections (spec
 * §14: normalized_hash excludes volatile collection metadata; §21 requires
 * reproducible hashes). Evidence `collected_at` is already excluded from
 * `evidence_corpus_hash` by the EvidenceHashInputV1 projection, so stripping
 * it here keeps the two hashes consistent. Nothing else is removed.
 */
export function stripVolatile(model: DocumentModel): object {
  const clone = JSON.parse(JSON.stringify(model)) as Record<
    string,
    unknown
  > & {
    generated_at?: string;
    job_id?: string;
    provenance?: { collected_at?: string };
    evidence?: { collected_at?: string }[];
  };
  delete clone.generated_at;
  delete clone.job_id;
  if (clone.provenance !== undefined) {
    delete clone.provenance.collected_at;
  }
  if (Array.isArray(clone.evidence)) {
    for (const e of clone.evidence) {
      delete e.collected_at;
    }
  }
  return clone;
}

/**
 * Merge every collector output into the versioned DocumentModel.
 *
 * §6.3 precedence is field-level, never silent wholesale choice:
 * - API wins official uuid, lifecycle timestamps (testingStart/End,
 *   lastStatusTransition, lastBriefUpdate), relationship ids (group/target
 *   ids, target.groupId), and integer reward amounts.
 * - DOM wins policy text, exact visible scope (which groups/targets exist,
 *   inScope), locations, names, categories, tags, docLinks, changeFlags,
 *   Known Issues, page-only statistics, and the remaining metadata labels.
 * - A null winner falls back to the other source; material disagreement on
 *   a permission is already encoded upstream — both assertions went through
 *   buildPermissionFact (u10) — so `techniques` passes through verbatim.
 */
/**
 * Required sections that came back empty. A unit can report success and still
 * return nothing, so this is computed from the collected data rather than from
 * unit outcomes, and the integrity check consumes it (§18).
 */
export function missingSections(
  args: Pick<
    AssembleArgs,
    "details" | "groups" | "targets" | "policy" | "activity" | "kiResults"
  >,
): string[] {
  const out: string[] = [];
  if (detailsEmpty(args.details)) out.push("details");
  if (args.groups.length === 0 && args.targets.length === 0) out.push("scope");
  if (policyEmpty(args.policy)) out.push("policy");
  if (activityEmpty(args.activity)) out.push("activity");
  if (args.kiResults.length === 0) out.push("known_issues");
  return out;
}

export function assembleDocument(args: AssembleArgs): DocumentModel {
  const { api, details, policy, activity } = args;

  // Evidence id lookup by source_key, for attaching evidence_refs to
  // collector-produced text fields (one source_key → many evidence ids).
  const evBySourceKey = new Map<string, string[]>();
  for (const e of args.evidence) {
    const list = evBySourceKey.get(e.source_key);
    if (list === undefined) evBySourceKey.set(e.source_key, [e.id]);
    else list.push(e.id);
  }
  const refsForKey = (sourceKey: string): string[] =>
    evBySourceKey.get(sourceKey) ?? [];

  /** Evidence ids for every record quoting this exact sentence. */
  const refsForQuote = (quote: string): string[] => {
    const ids = new Set<string>();
    for (const r of args.records) {
      if (r.quote !== quote) continue;
      for (const id of refsForKey(r.sourceKey)) ids.add(id);
    }
    return [...ids].sort();
  };

  /** Evidence ids for records whose structured payload is this exact text. */
  const refsForText = (text: string): string[] => {
    const ids = new Set<string>();
    for (const r of args.records) {
      if (r.data === text) {
        for (const id of refsForKey(r.sourceKey)) ids.add(id);
      }
    }
    return [...ids].sort();
  };

  /** Evidence ids for every record under a source_key prefix. */
  const refsForPrefix = (prefix: string): string[] => {
    const ids = new Set<string>();
    for (const r of args.records) {
      if (r.sourceKey.startsWith(prefix)) {
        for (const id of refsForKey(r.sourceKey)) ids.add(id);
      }
    }
    return [...ids].sort();
  };

  // --- groups: DOM defines the set; API wins id + integer rewards ---------
  const mergedGroups = args.groups.map(({ dom, api: g }) => ({
    domKey: dom.domKey,
    emitted: {
      id: g?.id ?? dom.domKey, // API relationship id, else `group:<slug>` domKey
      name: dom.name,
      inScope: dom.inScope,
      description: dom.description ?? g?.description ?? null,
      // `dom:scope:` + domKey is the collector's record convention
      // ("group:web" → "dom:scope:group:web", "target:x" → "dom:scope:target:x").
      evidence_refs: refsForKey(`dom:scope:${dom.domKey}`),
      rewards: {
        p1: g?.rewards.p1 ?? dom.rewards.p1,
        p2: g?.rewards.p2 ?? dom.rewards.p2,
        p3: g?.rewards.p3 ?? dom.rewards.p3,
        p4: g?.rewards.p4 ?? dom.rewards.p4,
        p5: g?.rewards.p5 ?? dom.rewards.p5,
      },
    },
  }));
  const emittedGroupId = new Map(
    mergedGroups.map((g) => [g.domKey, g.emitted.id]),
  );
  const targetGroups = mergedGroups
    .map((g) => g.emitted)
    .sort((a, b) => cmpStr(a.id, b.id));

  // --- targets: identity upstream; DOM wins the descriptive fields --------
  const targets = args.targets.map(({ dom, api: t, identity }) => ({
    id: identity.id,
    id_source: identity.id_source,
    identity_quality: identity.identity_quality,
    location: dom.location ?? t?.location ?? null,
    name: dom.name ?? t?.name ?? null,
    category: dom.category ?? t?.category ?? null,
    tags: dom.tags.length > 0 ? [...dom.tags] : [...(t?.tags ?? [])],
    docLinks: [...dom.docLinks],
    changeFlags: [...dom.changeFlags],
    inScope: dom.inScope,
    groupId:
      t?.groupId ??
      (dom.groupDomKey !== null
        ? (emittedGroupId.get(dom.groupDomKey) ?? dom.groupDomKey)
        : null),
    evidence_refs: refsForKey(`dom:scope:${dom.domKey}`),
  }));
  targets.sort((a, b) => cmpStr(a.id, b.id));

  // --- out-of-scope: inScope=false targets + their applying rule texts ----
  const rulesByDomKey = new Map<string, string[]>();
  for (const rule of args.rules) {
    for (const key of rule.appliesToDomKeys) {
      const list = rulesByDomKey.get(key);
      if (list === undefined) rulesByDomKey.set(key, [rule.text]);
      else if (!list.includes(rule.text)) list.push(rule.text);
    }
  }
  const outOfScope = args.targets
    .filter(({ dom }) => !dom.inScope)
    .map(({ dom }) => {
      // Notes = verbatim rule texts applying to the target or to its group
      // (a group's boundary rules bind every member). Engagement-wide rules
      // with empty appliesToDomKeys apply to nothing in particular and are
      // preserved in evidence only.
      const noteTexts = new Set<string>([
        ...(rulesByDomKey.get(dom.domKey) ?? []),
        ...(dom.groupDomKey !== null
          ? (rulesByDomKey.get(dom.groupDomKey) ?? [])
          : []),
      ]);
      return {
        location: dom.location,
        name: dom.name,
        notes: noteTexts.size > 0 ? [...noteTexts].join("\n") : null,
      };
    });

  // --- engagement metadata: API wins uuid/lifecycle timestamps ------------
  const canonicalUrl = canonicalOrRaw(args.canonicalUrl);
  const engagement: DocumentModel["engagement"] = {
    name: details?.name ?? api?.name ?? null,
    code: details?.code ?? api?.code ?? codeFromUrl(canonicalUrl),
    uuid: api?.uuid ?? null,
    canonicalUrl,
    type: details?.engagementType ?? api?.engagementType ?? null,
    managedBounty: details?.managedBounty ?? api?.managedBounty ?? null,
    lifecycleStatus: details?.lifecycleStatus ?? api?.lifecycleStatus ?? null,
    testingStart: api?.testingStart ?? details?.testingStart ?? null,
    testingEnd: api?.testingEnd ?? details?.testingEnd ?? null,
    testingPeriodLabel:
      details?.testingPeriodLabel ?? api?.testingPeriodLabel ?? null,
    lastStatusTransition:
      api?.lastStatusTransition ?? details?.lastStatusTransition ?? null,
    lastBriefUpdate: api?.lastBriefUpdate ?? details?.lastBriefUpdate ?? null,
    safeHarbor: {
      status: args.safeHarbor.status,
      level: details?.safeHarborLevel ?? api?.safeHarborLevel ?? null,
      evidence_refs: [...args.safeHarbor.evidence_refs].sort(),
    },
    disclosurePolicy: details?.disclosurePolicy ?? null,
  };

  // Statistics: DOM (page-exposed) wins over API for the same key.
  const statistics: DocumentModel["statistics"] = {
    ...(api?.statistics ?? {}),
    ...(activity?.stats ?? {}),
    ...(details?.statistics ?? {}),
  };

  // --- policy projection ---------------------------------------------------
  const accountRules = (policy?.accountRules ?? []).map((text) => ({
    text,
    evidence_refs: refsForText(text),
  }));
  const dataRules = (policy?.dataRules ?? []).map((text) => ({
    text,
    evidence_refs: refsForText(text),
  }));
  const submissionExclusions = (policy?.exclusions ?? []).map((item) => ({
    text: item.text,
    submission_status: item.submissionStatus,
    testing_status: item.testingStatus,
    reward_status: item.rewardStatus,
    // Quote-based: a line that also stated a technique rule was recorded as
    // that technique, so both facts share the one evidence object.
    evidence_refs: refsForQuote(item.text),
  }));
  const scopeAuthorization: DocumentModel["scopeAuthorization"] =
    policy?.scopeAuthorization == null
      ? null
      : {
          listed_targets: {
            status: policy.scopeAuthorization.listedTargets.status,
            conditions: [...policy.scopeAuthorization.listedTargets.conditions],
          },
          unlisted_targets: {
            status: policy.scopeAuthorization.unlistedTargets.status,
          },
          quote: policy.scopeAuthorization.quote,
          evidence_refs: refsForQuote(policy.scopeAuthorization.quote),
        };
  const vrt: DocumentModel["vrt"] = {
    version: policy?.vrt.version ?? null,
    baseline: policy?.vrt.baseline ?? null,
    scope_rules: (policy?.vrt.scopeRules ?? []).map((rule) => ({
      category: rule.category,
      vrt_version: rule.vrtVersion,
      applies_to: rule.appliesTo,
      status: rule.status,
      note: rule.note,
      evidence_refs: refsForQuote(rule.quote),
    })),
    exclusions: [...(policy?.vrt.exclusions ?? [])],
    deviations: [...(policy?.vrt.deviations ?? [])],
    targetSpecific: [...(policy?.vrt.targetSpecific ?? [])],
    notes: [...(policy?.vrt.notes ?? [])],
    evidence_refs: refsForPrefix("dom:details:vrt:"),
  };

  const knownIssues = args.kiResults.map(({ result, targetId }) => ({
    targetId,
    displayedCount: result.displayedCount,
    collectedCount: result.collectedCount,
    countMatches: result.countMatches,
    columns: [...result.columns],
    rows: result.rows.map((row) =>
      row.recognized === undefined
        ? { cells: [...row.cells] }
        : { cells: [...row.cells], recognized: { ...row.recognized } },
    ),
    evidence_refs: refsForKey(`dom:ki:${result.targetDomKey}`),
  }));
  knownIssues.sort((a, b) => cmpStr(a.targetId, b.targetId));

  // --- provenance ------------------------------------------------------------
  const missing_sections = missingSections(args);

  // A Known Issues table that was collected but did not reconcile is not a
  // missing section; it is a validation failure, named here so
  // `integrity.required_sections_complete: false` has a visible reason.
  const collection_issues = args.kiResults
    .flatMap(({ result, targetId }) => {
      const codes = new Set<string>();
      if (!result.countMatches) codes.add("known_issues:incomplete_counts");
      for (const warning of result.warnings) {
        const m = KI_ISSUE_RE.exec(warning);
        if (m !== null) codes.add(`known_issues:${m[1]}`);
      }
      return [...codes].sort().map((code) => ({
        code,
        target_id: targetId,
        displayed_count: result.displayedCount,
        collected_count: result.collectedCount,
      }));
    })
    .sort(
      (a, b) => cmpStr(a.target_id, b.target_id) || cmpStr(a.code, b.code),
    );

  const conflicts = Object.keys(args.techniques)
    .filter((key) => args.techniques[key]!.conflict.detected)
    .sort()
    .map((factKey) => ({
      factKey,
      evidence_refs: [...args.techniques[factKey]!.conflict.evidence_refs].sort(),
    }));

  return {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    generated_at: args.generatedAt,
    job_id: args.jobId,
    engagement,
    statistics,
    targets,
    targetGroups,
    outOfScope,
    techniques: args.techniques,
    accountRules,
    dataRules,
    focusAreas: [...(policy?.focusAreas ?? [])],
    nonFocusAreas: [...(policy?.nonFocusAreas ?? [])],
    submissionExclusions,
    scopeAuthorization,
    reportingRequirements: [...(policy?.reportingRequirements ?? [])],
    vrt,
    knownIssues,
    announcements: [...(activity?.announcements ?? [])],
    changelog: [...(activity?.changelog ?? [])],
    recentActivity: [...(activity?.recentActivity ?? [])],
    acceptedReports: [...(activity?.acceptedReports ?? [])],
    evidence: sortEvidenceForCorpus(args.evidence),
    collection: args.integrity.collection,
    integrity: args.integrity.integrity,
    quality: args.integrity.quality,
    policy: args.integrity.policy,
    api: {
      api_major_target: API_MAJOR_TARGET,
      api_schema_tested: API_SCHEMA_TESTED,
      observed_version: api?.observedApiVersion ?? null,
      status: args.integrity.collection.api_status,
    },
    provenance: {
      parser_version: PARSER_VERSION,
      collected_at: args.collectedAt,
      missing_sections,
      collection_issues,
      conflicts,
    },
  };
}
