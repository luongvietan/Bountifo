import { canonicalJson, normalizeText } from "../canonical";
import type {
  Applicability,
  Condition,
  Evidence,
  ExtractionStatus,
  PermissionFact,
  PermissionStatus,
  SafeHarborStatus,
} from "../types";

/**
 * One source's assertion about a permission-like technique: the extracted
 * status, any condition clauses, applicability, and the already-built
 * evidence objects backing it. Only assertions with ≥1 evidence object at
 * extraction.status "exact" can establish an asserted status (spec §9/§11);
 * partial/failed evidence is retained for human review only.
 */
export interface AssertionInput {
  status: PermissionStatus;
  conditions: string[];
  applies_to: Applicability;
  evidence: Evidence[];
}

const EXTRACTION_RANK: Record<ExtractionStatus, number> = {
  exact: 0,
  partial: 1,
  failed: 2,
};

/** Worst (most pessimistic) extraction status; "failed" when empty. */
function worstExtraction(evs: Evidence[]): ExtractionStatus {
  if (evs.length === 0) return "failed";
  let worst: ExtractionStatus = "exact";
  for (const e of evs) {
    if (EXTRACTION_RANK[e.extraction.status] > EXTRACTION_RANK[worst]) {
      worst = e.extraction.status;
    }
  }
  return worst;
}

/** Unique, deterministically ordered (codepoint sort) id list. */
function uniqSortedIds(evs: Evidence[]): string[] {
  return [...new Set(evs.map((e) => e.id))].sort();
}

/**
 * Merge applicability across assertions. Identical scopes pass through (ids
 * normalized to sorted-unique). Multiple `target_ids` scopes union. Anything
 * more divergent widens conservatively to `engagement` — the fact cannot be
 * narrowed when its backing sources disagree about where it applies.
 */
function mergeApplicability(apps: Applicability[]): Applicability {
  if (apps.length === 0) return { type: "engagement" };
  const first = apps[0]!;
  if (apps.every((a) => canonicalJson(a) === canonicalJson(first))) {
    return first.ids === undefined
      ? { type: first.type }
      : { type: first.type, ids: [...new Set(first.ids)].sort() };
  }
  if (apps.every((a) => a.type === "target_ids")) {
    return {
      type: "target_ids",
      ids: [...new Set(apps.flatMap((a) => a.ids ?? []))].sort(),
    };
  }
  return { type: "engagement" };
}

/** Fresh empty conflict block (fresh arrays — facts must not share refs). */
function noConflict(): PermissionFact["conflict"] {
  return { detected: false, evidence_refs: [], asserted_statuses: [] };
}

/**
 * Reduce assertions to a four-state PermissionFact (spec §11/§12):
 *
 * - An assertion is "asserted" only when backed by ≥1 evidence object with
 *   extraction.status "exact". Partial evidence never establishes a status —
 *   not even several partial records that agree.
 * - Zero asserted → status "unspecified"; evidence_refs keep every attached
 *   evidence id (incl. partial) for review; extraction.status is worst-of.
 *   `unspecified` is never rewritten as `prohibited`.
 * - Exactly one distinct asserted status → that status, conditions merged
 *   (deduped by normalized text, sorted, id'd condition_001..), all evidence.
 * - ≥2 distinct asserted statuses → conflict: status "unspecified" (the enum
 *   has no conflict value), conflict.detected, every asserted status and all
 *   asserted-side evidence preserved in the conflict block, resolution
 *   unresolved. Nothing is resolved or dropped.
 */
export function buildPermissionFact(
  assertions: AssertionInput[],
): PermissionFact {
  const allEvidence = assertions.flatMap((a) => a.evidence);
  const asserted = assertions.filter((a) =>
    a.evidence.some((e) => e.extraction.status === "exact"),
  );
  const assertedStatuses = [...new Set(asserted.map((a) => a.status))].sort();
  const evidenceRefs = uniqSortedIds(allEvidence);

  if (assertedStatuses.length === 0) {
    return {
      status: "unspecified",
      conditions: [],
      applies_to: mergeApplicability(assertions.map((a) => a.applies_to)),
      evidence_refs: evidenceRefs,
      conflict: noConflict(),
      extraction: { status: worstExtraction(allEvidence) },
    };
  }

  const assertedEvidence = asserted.flatMap((a) => a.evidence);

  if (assertedStatuses.length === 1) {
    // Merge conditions from asserted assertions only — conditions attached
    // to partial/failed evidence are not established. Dedupe on normalized
    // text, sort for input-order independence, id sequentially.
    const texts = new Set<string>();
    for (const a of asserted) {
      for (const raw of a.conditions) {
        const text = normalizeText(raw);
        if (text !== "") texts.add(text);
      }
    }
    const conditions: Condition[] = [...texts].sort().map((text, i) => ({
      id: `condition_${String(i + 1).padStart(3, "0")}`,
      text,
    }));
    // Invariant: conditional ⇒ conditions.length > 0. A conditional fact
    // with no extracted condition is unsafe — `all([])` vacuously passes in
    // most downstream guards — so it downgrades to unspecified; its evidence
    // is retained and the partial extraction status marks it for review.
    if (assertedStatuses[0] === "conditional" && conditions.length === 0) {
      return {
        status: "unspecified",
        conditions: [],
        applies_to: mergeApplicability(asserted.map((a) => a.applies_to)),
        evidence_refs: evidenceRefs,
        conflict: noConflict(),
        extraction: { status: "partial" },
      };
    }
    return {
      status: assertedStatuses[0]!,
      conditions,
      applies_to: mergeApplicability(asserted.map((a) => a.applies_to)),
      evidence_refs: evidenceRefs,
      conflict: noConflict(),
      extraction: { status: "exact" },
    };
  }

  // Conflict: preserve every asserted status and its evidence. Per-status
  // condition lists would be ambiguous under one merged fact, so they stay
  // empty; the full evidence trail is in evidence_refs / conflict block.
  return {
    status: "unspecified",
    conditions: [],
    applies_to: mergeApplicability(asserted.map((a) => a.applies_to)),
    evidence_refs: evidenceRefs,
    conflict: {
      detected: true,
      evidence_refs: uniqSortedIds(assertedEvidence),
      asserted_statuses: assertedStatuses,
    },
    resolution: { status: "unresolved" },
    extraction: { status: "exact" },
  };
}

/**
 * Safe Harbor uses domain states (spec §11): present / absent / unclear.
 * Unambiguous evidence decides; competing or purely ambiguous signals are
 * unclear. All signal evidence is retained for review.
 */
export function buildSafeHarborFact(signals: {
  present?: Evidence[];
  absent?: Evidence[];
  ambiguous?: Evidence[];
}): { status: SafeHarborStatus; evidence_refs: string[] } {
  const present = signals.present ?? [];
  const absent = signals.absent ?? [];
  const ambiguous = signals.ambiguous ?? [];
  let status: SafeHarborStatus;
  if (present.length > 0 && absent.length === 0) status = "present";
  else if (absent.length > 0 && present.length === 0) status = "absent";
  else status = "unclear";
  return {
    status,
    evidence_refs: uniqSortedIds([...present, ...absent, ...ambiguous]),
  };
}

/** Adapt a parsed policy technique row into an assertion for buildPermissionFact. */
export function mapTechnique(
  policyTechnique: {
    name: string;
    status: PermissionStatus;
    conditions: string[];
  },
  ev: Evidence[],
  applies_to: Applicability,
): AssertionInput {
  return {
    status: policyTechnique.status,
    conditions: [...policyTechnique.conditions],
    applies_to,
    evidence: ev,
  };
}
