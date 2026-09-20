import { describe, expect, it } from "vitest";
import { detectConflicts } from "../lib/model/conflicts";
import type { PermissionFact } from "../lib/types";

function fact(overrides: Partial<PermissionFact> = {}): PermissionFact {
  return {
    status: "allowed",
    conditions: [],
    applies_to: { type: "engagement" },
    evidence_refs: [],
    conflict: { detected: false, evidence_refs: [], asserted_statuses: [] },
    extraction: { status: "exact" },
    ...overrides,
  };
}

function conflicted(): PermissionFact {
  return fact({
    status: "unspecified",
    conflict: {
      detected: true,
      evidence_refs: ["ev_a", "ev_b"],
      asserted_statuses: ["allowed", "prohibited"],
    },
    resolution: { status: "unresolved" },
    evidence_refs: ["ev_a", "ev_b"],
  });
}

describe("detectConflicts", () => {
  it("reports none for an empty fact set", () => {
    expect(detectConflicts({})).toEqual({
      conflicts_present: false,
      unresolved_conflicts: 0,
    });
  });

  it("reports none when no fact has a conflict", () => {
    expect(
      detectConflicts({ automation: fact(), scanning: fact() }),
    ).toEqual({ conflicts_present: false, unresolved_conflicts: 0 });
  });

  it("counts a single unresolved conflict", () => {
    expect(
      detectConflicts({ automation: conflicted(), scanning: fact() }),
    ).toEqual({ conflicts_present: true, unresolved_conflicts: 1 });
  });

  it("counts multiple unresolved conflicts", () => {
    expect(
      detectConflicts({
        automation: conflicted(),
        scanning: conflicted(),
        dos: fact(),
      }),
    ).toEqual({ conflicts_present: true, unresolved_conflicts: 2 });
  });

  it("does not count detected conflicts lacking an unresolved resolution", () => {
    const weird = fact({
      conflict: {
        detected: true,
        evidence_refs: ["ev_a"],
        asserted_statuses: ["allowed", "prohibited"],
      },
      // resolution absent → not counted as unresolved
    });
    const res = detectConflicts({ automation: weird });
    expect(res).toEqual({ conflicts_present: false, unresolved_conflicts: 0 });
  });

  it("does not mutate the facts", () => {
    const facts = { automation: conflicted(), scanning: fact() };
    const snapshot = JSON.stringify(facts);
    const frozen = Object.freeze(facts);
    detectConflicts(frozen);
    expect(JSON.stringify(facts)).toBe(snapshot);
  });
});
