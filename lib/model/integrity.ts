import { PARSER_VERSION } from "../constants";
import type { KiResult } from "../dom/knownIssues";
import { detectConflicts } from "./conflicts";
import type { CollectionStatus, Evidence, PermissionFact } from "../types";

/**
 * One collection unit's terminal outcome, recorded by the coordinator.
 * `required`/`critical` are coordinator-assigned per the unit criticality
 * table (u01_validate_url critical, u02_init_job critical, u03_collect_details
 * critical+required, u04_api_enrichment optional, u05–u08 required,
 * u09–u12 critical, u13 best-effort).
 */
export interface UnitOutcome {
  unitId: string;
  status: "ok" | "warning" | "failed" | "skipped";
  required: boolean;
  critical: boolean;
  warnings: string[];
}

export interface IntegrityReport {
  collection: {
    status: CollectionStatus;
    api_status: CollectionStatus | "unavailable";
    dom_status: CollectionStatus;
    parser_version: string;
    evidence_corpus_hash: string;
    normalized_hash: string;
  };
  integrity: {
    evidence_hash_valid: boolean;
    known_issues_counts_valid: boolean;
    required_sections_complete: boolean;
  };
  quality: { warnings: string[] };
  policy: { conflicts_present: boolean; unresolved_conflicts: number };
}

/**
 * Required collection units (spec §18): each maps to an advertised dossier
 * section, so a missing/failed/skipped outcome means an advertised section
 * was not collected → `partial`. u04_api_enrichment is deliberately absent —
 * API unavailability never makes DOM collection partial. u01/u02/u09–u12 are
 * not here because their failure is `critical` → `failed`, never `partial`;
 * they may also legitimately have no outcome yet when this runs inside u11.
 */
export const REQUIRED_UNIT_IDS = [
  "u03_collect_details",
  "u05_collect_targets",
  "u06_collect_policy",
  "u07_collect_activity",
  "u08_known_issues",
] as const;

/** The optional API enrichment unit; drives `api_status` independently. */
export const API_ENRICHMENT_UNIT_ID = "u04_api_enrichment";

/**
 * Coordinator-reported fatal DOM conditions (spec §18): unsupported_url,
 * session_expired, details_failed, tab_closed. Any non-null value → failed.
 */
export type DomCriticalFailure =
  | "unsupported_url"
  | "session_expired"
  | "details_failed"
  | "tab_closed";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/** Required outcome unusable: failed, skipped, or absent from the outcomes. */
function outcomeFailedRequired(o: UnitOutcome | undefined): boolean {
  return o === undefined || o.status === "failed" || o.status === "skipped";
}

/**
 * Spec §18 collection integrity:
 *
 * - A required outcome that is "failed"/"skipped"/missing → `partial`.
 * - A "critical" outcome that is "failed", OR a non-null domCriticalFailure
 *   (unsupported_url | session_expired | details_failed | tab_closed) →
 *   `failed`, which trumps `partial`.
 * - A Known Issues countMatches=false → `partial` + warning +
 *   known_issues_counts_valid=false (and the KI required section is
 *   incomplete per §13).
 * - apiFailed alone → api_status "unavailable"; it does NOT force partial.
 * - Conflicts only populate `policy.*`; they never change collection.status.
 * - required_sections_complete = every required unit's outcome is
 *   ok/warning AND every required count validation passed.
 * - Warnings never create additional collection-status values.
 */
/** Sections a real engagement brief always has; empty means collection missed them. */
const NEVER_EMPTY_SECTIONS = new Set(["details", "scope"]);

/** Warnings that mean a Known Issues target was never actually verified. */
const UNVERIFIED_KI_RE =
  /^ki_(?:dialog_not_opened|dialog_not_ready|displayed_count_unavailable|pagination_stuck|page_cap_50|count_mismatch)\b/;

export function computeIntegrity(args: {
  outcomes: UnitOutcome[];
  kiResults: KiResult[];
  apiFailed: boolean;
  domCriticalFailure: string | null;
  facts: Record<string, PermissionFact>;
  evidence: Evidence[];
  corpusHash: string;
  normalizedHash: string;
  /** Caller-supplied recomputation result; format checks remain the fallback. */
  evidenceHashValid?: boolean;
  /**
   * Required sections that came back empty (§18). A unit can succeed and still
   * return nothing - a brief that renders its scope lazily is collected before
   * the targets exist - and an empty scope inventory reported as `complete`
   * is the worst possible answer for a consumer deciding what it may test.
   */
  missingSections?: string[];
}): IntegrityReport {
  const { outcomes, kiResults, apiFailed, domCriticalFailure } = args;
  const byId = new Map(outcomes.map((o) => [o.unitId, o]));
  const warnings: string[] = [];

  for (const o of outcomes) warnings.push(...o.warnings);
  for (const ki of kiResults) {
    warnings.push(...ki.warnings);
    if (
      !ki.countMatches &&
      !ki.warnings.some((w) => w.startsWith("ki_count_mismatch"))
    ) {
      warnings.push(`ki_count_mismatch:${ki.targetDomKey}`);
    }
  }

  // Required units = the fixed §18 set plus anything the coordinator flagged.
  const requiredIds = new Set<string>(REQUIRED_UNIT_IDS);
  for (const o of outcomes) {
    if (o.required) requiredIds.add(o.unitId);
  }

  let requiredSectionsComplete = true;
  let partial = false;
  for (const id of requiredIds) {
    const o = byId.get(id);
    if (o === undefined) {
      partial = true;
      requiredSectionsComplete = false;
      warnings.push(`missing_required_unit:${id}`);
    } else if (o.status === "failed" || o.status === "skipped") {
      partial = true;
      requiredSectionsComplete = false;
    }
    // "warning" keeps the section complete — warnings coexist with complete.
  }

  // Activity and Known Issues are legitimately empty on some briefs - a new
  // program has no announcements, and not every brief exposes known issues.
  // A brief with no targets or no identity is a different thing entirely:
  // the collection missed them, and calling that complete would tell a
  // consumer it may test nothing, or anything.
  const missingCritical = (args.missingSections ?? []).filter((section) =>
    NEVER_EMPTY_SECTIONS.has(section),
  );
  for (const section of missingCritical) {
    warnings.push(`missing_section:${section}`);
  }

  // §13: a target counts as verified only when it was opened, paginated and
  // checked. A mismatch fails that, and so does never getting the dialog open
  // or never seeing a displayed count — calling those "valid" would assert a
  // check the collection never performed. An advertised Known Issues feature
  // with an unknown displayed count is a gap (unknown ≠ 0 ≠ valid); only a
  // target whose brief genuinely exposes nothing skips cleanly.
  const knownIssuesCountsValid = kiResults.every(
    (ki) =>
      ki.countMatches &&
      !(ki.displayedCount === null && ki.advertised) &&
      !ki.warnings.some((w) => UNVERIFIED_KI_RE.test(w)),
  );
  if (!knownIssuesCountsValid) {
    partial = true;
    requiredSectionsComplete = false;
  }
  if (missingCritical.length > 0) {
    partial = true;
    requiredSectionsComplete = false;
  }

  // Critical failure (failed critical outcome or a fatal DOM condition)
  // trumps partial — the dataset is unusable.
  const criticalFailed = outcomes.some(
    (o) => o.critical && o.status === "failed",
  );
  const failed = domCriticalFailure !== null || criticalFailed;
  if (domCriticalFailure !== null) {
    warnings.push(`dom_critical_failure:${domCriticalFailure}`);
  }

  const status: CollectionStatus = failed
    ? "failed"
    : partial
      ? "partial"
      : "complete";

  // api_status is an independent dimension: "complete" only when the
  // optional enrichment actually produced data; a warning outcome still
  // means the API answered (warnings live in quality.warnings).
  const apiOutcome = byId.get(API_ENRICHMENT_UNIT_ID);
  const api_status: CollectionStatus | "unavailable" =
    apiFailed ||
    apiOutcome === undefined ||
    apiOutcome.status === "failed" ||
    apiOutcome.status === "skipped"
      ? "unavailable"
      : "complete";

  // dom_status reflects DOM-side collection: a fatal DOM condition → failed;
  // a missing/failed/skipped DOM required unit or a KI count mismatch →
  // partial; otherwise complete.
  const domPartial =
    REQUIRED_UNIT_IDS.some((id) => outcomeFailedRequired(byId.get(id))) ||
    !knownIssuesCountsValid ||
    missingCritical.length > 0;
  const dom_status: CollectionStatus =
    domCriticalFailure !== null ? "failed" : domPartial ? "partial" : "complete";

  // The corpus hash is computed by the caller (async); here we verify it is
  // present and well-formed, and that every evidence object carries a
  // well-formed content hash.
  const evidence_hash_valid =
    args.evidenceHashValid ??
    (SHA256_RE.test(args.corpusHash) &&
      args.evidence.every((e) => SHA256_RE.test(e.content_hash)));

  return {
    collection: {
      status,
      api_status,
      dom_status,
      parser_version: PARSER_VERSION,
      evidence_corpus_hash: args.corpusHash,
      normalized_hash: args.normalizedHash,
    },
    integrity: {
      evidence_hash_valid,
      known_issues_counts_valid: knownIssuesCountsValid,
      required_sections_complete: requiredSectionsComplete,
    },
    quality: { warnings: [...new Set(warnings)] },
    policy: detectConflicts(args.facts),
  };
}
