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
  | "engagement";
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

export interface Applicability {
  type: ApplicabilityType;
  ids?: string[];
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
