import type { JobDescriptor } from "./descriptor";

export const UNIT_ORDER = [
  "u01_validate_url",
  "u02_init_job",
  "u03_collect_details",
  "u04_api_enrichment",
  "u05_collect_targets",
  "u06_collect_policy",
  "u07_collect_activity",
  "u08_known_issues",
  "u09_build_evidence",
  "u10_normalize_facts",
  "u11_integrity_check",
  "u12_render_download",
  "u13_cleanup",
] as const;

export type UnitId = (typeof UNIT_ORDER)[number];

export const UNIT_PHASE: Record<UnitId, JobDescriptor["phase"]> = {
  u01_validate_url: "collecting",
  u02_init_job: "collecting",
  u03_collect_details: "collecting",
  u04_api_enrichment: "collecting",
  u05_collect_targets: "collecting",
  u06_collect_policy: "collecting",
  u07_collect_activity: "collecting",
  u08_known_issues: "collecting",
  u09_build_evidence: "processing",
  u10_normalize_facts: "processing",
  u11_integrity_check: "processing",
  u12_render_download: "rendering",
  u13_cleanup: "done",
};
