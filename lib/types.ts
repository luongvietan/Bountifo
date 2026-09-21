export type SourceType = "api" | "dom";
export type SourceLevel =
  | "page_header"
  | "target_specific_rule"
  | "explicit_program_rule"
  | "announcement"
  | "vrt_deviation"
  | "default_vrt"
  | "known_issue_note"
  | "api_field";
export type ExtractionStatus = "exact" | "partial" | "failed";
export type PermissionStatus =
  | "allowed"
  | "prohibited"
  | "conditional"
  | "unspecified";
export type SafeHarborStatus = "present" | "absent" | "unclear";
export type CollectionStatus = "complete" | "partial" | "failed";
export type ApplicabilityType =
  | "all_targets"
  | "target_ids"
  | "target_group_ids"
  | "engagement"
  | "conditional_context";
export type IdentityQuality =
  | "api"
  | "exact_location"
  | "name_fallback"
  | "duplicate_disambiguated";

export interface SourceLocator {
  section?: string;
  subsection?: string;
  targetId?: string;
  table?: string;
  pageIndex?: number;
  rowIndex?: number;
}

export interface SourceRecord {
  // produced by collectors (API client + DOM)
  sourceKey: string; // e.g. "dom:details:program-rules:automation"
  sourceType: SourceType;
  sourceLevel: SourceLevel;
  sourceUrl: string;
  authenticated: boolean;
  locator: SourceLocator;
  quote: string; // raw text; evidence builder normalizes
  extractionStatus: ExtractionStatus;
  data?: unknown; // structured payload for normalizers; NOT hashed
}

export interface Evidence {
  id: string; // "ev_" + 12 hex
  source_key: string;
  source: { url: string; type: SourceType; authenticated: boolean };
  locator: SourceLocator;
  source_level: SourceLevel;
  collected_at: string; // ISO-8601 with offset; excluded from hash
  quote: string; // normalized
  content_hash: string; // "sha256:" + 64 hex
  extraction: { status: ExtractionStatus; parser_version: string };
}

/**
 * A deterministic condition bounding a rule's applicability. `phase` covers
 * antecedents the exporter can type with certainty (post-compromise); any
 * other antecedent is preserved verbatim as `antecedent_text` so the rule
 * stays narrow instead of silently widening to the whole engagement.
 */
export type PolicyContextCondition =
  | { kind: "phase"; value: "post_compromise" }
  | { kind: "antecedent_text"; text: string };

export interface Applicability {
  type: ApplicabilityType;
  ids?: string[];
  conditions?: PolicyContextCondition[];
}

/**
 * A machine-readable carve-out to the scope-authorization baseline. The
 * exception is never a permission itself — `permit_evaluation` only tells a
 * downstream evaluator which authorization gate it may verify. A Barracuda
 * "must have prior written consent from the Security team" compiles to the
 * typed `prior_written_consent` condition; any other recognized exception
 * phrasing keeps the verbatim sentence as `source_text` so it stays narrow
 * and reviewable instead of widening into an automatic grant.
 */
export type AuthorizationExceptionCondition =
  | {
      kind: "prior_written_consent";
      issuer: "program_security_team";
      verification_required: true;
    }
  | { kind: "source_text"; text: string };

export interface ScopeAuthorizationException {
  applies_to:
    | "unlisted_targets"
    | "out_of_scope_targets"
    | "target_ids"
    | "target_group_ids";
  ids?: string[];
  condition: AuthorizationExceptionCondition;
  effect: "permit_evaluation";
  /** The verbatim sentence the exception was compiled from. */
  quote: string;
}

export interface Condition {
  id: string;
  text: string;
}

export interface PermissionFact {
  status: PermissionStatus;
  conditions: Condition[];
  applies_to: Applicability;
  evidence_refs: string[];
  conflict: {
    detected: boolean;
    evidence_refs: string[];
    asserted_statuses: PermissionStatus[];
  };
  resolution?: { status: "unresolved" };
  extraction: { status: ExtractionStatus };
}

export interface ApiEngagementData {
  // output of Task 3's parser
  uuid: string | null;
  name: string | null;
  code: string | null;
  engagementType: string | null;
  managedBounty: boolean | null;
  lifecycleStatus: string | null;
  testingStart: string | null;
  testingEnd: string | null;
  testingPeriodLabel: string | null;
  lastStatusTransition: string | null;
  lastBriefUpdate: string | null;
  safeHarborLevel: string | null;
  statistics: Record<string, { value: string; window: string | null }>;
  targetGroups: ApiTargetGroup[];
  targets: ApiTarget[];
  observedApiVersion: string | null;
}

export interface ApiTargetGroup {
  id: string;
  name: string;
  inScope: boolean;
  description: string | null;
  rewards: {
    p1: number | null;
    p2: number | null;
    p3: number | null;
    p4: number | null;
    p5: number | null;
  };
}

export interface ApiTarget {
  id: string;
  groupId: string | null;
  location: string | null;
  name: string | null;
  category: string | null;
  tags: string[];
  inScope: boolean;
}
