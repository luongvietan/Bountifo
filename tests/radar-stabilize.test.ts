import { describe, expect, it } from "vitest";
import {
  evaluateFrontier,
  type FrontierInput,
} from "../lib/radar/stabilize";
import {
  DEEP_BATCH_SIZE,
  MAX_DEEP_PROGRAMS,
  STABILITY_BUFFER,
  STABLE_TOP_K,
  type RadarProfileId,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Agent C — Radar V1.3.1 stabilization frontier (pure evaluateFrontier).
//
// V1.3 ran one deep pass over a fixed shortlist and stopped: after the deep
// re-score pushed programs out of the Top-K, unanalyzed metadata candidates
// rose above them and were never analyzed. The frontier watches each
// deep-dependent profile's metadata Top-(K + buffer) and batches whatever is
// inside the window but not yet deep-committed — until the frontier closes
// ("stable") or the budget is gone ("budget_limited").
// ---------------------------------------------------------------------------

const WINDOW = STABLE_TOP_K + STABILITY_BUFFER; // 30

/** Ordered uuids "<prefix>-r<rank>" for metadata ranks 1..n. */
function ranking(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-r${i + 1}`);
}

function uuids(candidates: readonly { uuid: string }[]): string[] {
  return candidates.map((c) => c.uuid);
}

function makeInput(overrides: Partial<FrontierInput> = {}): FrontierInput {
  return {
    perProfileMetadata: new Map(),
    committed: new Set(),
    committedCount: 0,
    ...overrides,
  };
}

describe("frontier window", () => {
  it("empty input → stable, empty batch, full budget remaining", () => {
    const verdict = evaluateFrontier(makeInput());
    expect(verdict).toEqual({
      missing: [],
      batch: [],
      statusIfStopped: "stable",
      remainingAfter: MAX_DEEP_PROGRAMS,
    });
  });

  it("frontier fully committed → stable with an empty batch", () => {
    const ranks = ranking("ev", WINDOW + 5); // window sees first 30 only
    const committed = new Set(ranks.slice(0, WINDOW));
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranks]]),
        committed,
        committedCount: committed.size,
      }),
    );
    expect(verdict.statusIfStopped).toBe("stable");
    expect(verdict.missing).toEqual([]);
    expect(verdict.batch).toEqual([]);
    expect(verdict.remainingAfter).toBe(MAX_DEEP_PROGRAMS - WINDOW);
  });

  it("buffer boundary: rank K+buffer is in-window, K+buffer+1 is out", () => {
    const ranks = ranking("ev", WINDOW + 2); // 32 eligible rows
    const verdict = evaluateFrontier(
      makeInput({ perProfileMetadata: new Map([["best_ev", ranks]]) }),
    );
    expect(verdict.missing).toHaveLength(WINDOW);
    expect(uuids(verdict.missing)).toContain(`ev-r${WINDOW}`);
    expect(uuids(verdict.missing)).not.toContain(`ev-r${WINDOW + 1}`);
    expect(uuids(verdict.missing)).not.toContain(`ev-r${WINDOW + 2}`);
    // The in-window edge carries its true metadata rank.
    const edge = verdict.missing.find((c) => c.uuid === `ev-r${WINDOW}`);
    expect(edge?.reasons).toEqual([
      { profile: "best_ev", metadata_rank: WINDOW },
    ]);
  });

  it("profiles outside DEEP_PROFILE_IDS are ignored — they weight no deep signal", () => {
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([
          ["high_reward", ["hr-1", "hr-2", "hr-3"]],
          ["easy_entry", ["ee-1"]],
          ["best_ev", ["be-1"]],
        ]),
      }),
    );
    expect(uuids(verdict.missing)).toEqual(["be-1"]);
  });

  it("a uuid duplicated inside one ranking keeps its first (best) rank", () => {
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([
          ["best_ev", ["dup", "x", "dup", "y"]],
        ]),
      }),
    );
    expect(uuids(verdict.missing)).toEqual(["dup", "x", "y"]);
    expect(verdict.missing[0]?.reasons).toEqual([
      { profile: "best_ev", metadata_rank: 1 },
    ]);
    expect(verdict.missing[1]?.reasons).toEqual([
      { profile: "best_ev", metadata_rank: 2 },
    ]);
  });
});

describe("missing — dispatch order and provenance", () => {
  it("orders by profile priority → lowest rank among reasons → uuid ASC", () => {
    // Fixture keys (min DEEP_PROFILE_IDS index, min rank over ALL reasons):
    //   be1 (0,1) · multi {be5,fr1} (0,1) · be2 (0,2)
    //   tie-a {be10,az3} (0,3) · tie-b {be3,lc4} (0,3) — uuid breaks the tie
    //   be4 (0,4) · be6..be9 (0,6..9) · fr2 (1,2)
    //   lc1..lc3 (2,1..3) · az1..az2 (3,1..2)
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([
          [
            "best_ev",
            [
              "be1", "be2", "tie-b", "be4", "multi",
              "be6", "be7", "be8", "be9", "tie-a",
            ],
          ],
          ["fresh_programs", ["multi", "fr2"]],
          ["low_competition", ["lc1", "lc2", "lc3", "tie-b"]],
          ["authz_api", ["az1", "az2", "tie-a"]],
        ]),
      }),
    );

    expect(uuids(verdict.missing)).toEqual([
      "be1", "multi", "be2", "tie-a", "tie-b",
      "be4", "be6", "be7", "be8", "be9",
      "fr2", "lc1", "lc2", "lc3", "az1", "az2",
    ]);

    // "multi" ranks 5th in best_ev but 1st in fresh_programs — the lowest
    // rank across ALL reasons (1) puts it ahead of be2 (0,2). This pins
    // the shortlist's independent-minima rule, not rank-within-best-profile.
    expect(uuids(verdict.missing).indexOf("multi")).toBeLessThan(
      uuids(verdict.missing).indexOf("be2"),
    );
    // Identical (profile, rank) keys → uuid ASC decides.
    expect(uuids(verdict.missing).indexOf("tie-a")).toBeLessThan(
      uuids(verdict.missing).indexOf("tie-b"),
    );
    // batch is a strict prefix of missing, capped at DEEP_BATCH_SIZE.
    expect(uuids(verdict.batch)).toEqual(
      uuids(verdict.missing).slice(0, DEEP_BATCH_SIZE),
    );
  });

  it("merges multi-profile provenance into one candidate, reasons in DEEP_PROFILE_IDS order", () => {
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([
          ["authz_api", ["shared", "az-only"]],
          ["best_ev", ["be-only", "shared"]],
          ["low_competition", ["shared"]],
        ]),
      }),
    );
    const shared = verdict.missing.find((c) => c.uuid === "shared");
    // Accumulated in DEEP_PROFILE_IDS order (best_ev → fresh → low_comp →
    // authz), NOT in Map insertion order and NOT in rank order.
    expect(shared?.reasons).toEqual([
      { profile: "best_ev", metadata_rank: 2 },
      { profile: "low_competition", metadata_rank: 1 },
      { profile: "authz_api", metadata_rank: 1 },
    ]);
    // No duplicate candidates for the merged uuid.
    expect(
      verdict.missing.filter((c) => c.uuid === "shared"),
    ).toHaveLength(1);
  });

  it("deep drops admit lower metadata rows: committed ranks 1..K, ranks K+1..K+buffer appear in missing", () => {
    // The V1.3 shape: Top-20 committed. After deep re-scoring, members can
    // fall out of the Top-K — the frontier must still cover the window so
    // ranks 21–30 (which can rise into it) are owed a deep pass.
    const ranks = ranking("ev", WINDOW);
    const committed = new Set(ranks.slice(0, STABLE_TOP_K));
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranks]]),
        committed,
        committedCount: committed.size,
      }),
    );
    expect(uuids(verdict.missing)).toEqual(
      ranking("ev", WINDOW).slice(STABLE_TOP_K),
    );
    for (const [i, c] of verdict.missing.entries()) {
      expect(c.reasons).toEqual([
        { profile: "best_ev", metadata_rank: STABLE_TOP_K + i + 1 },
      ]);
    }
    expect(verdict.statusIfStopped).toBe("incomplete");
    expect(uuids(verdict.batch)).toEqual(uuids(verdict.missing)); // 10 ≤ batchSize
    expect(verdict.remainingAfter).toBe(
      MAX_DEEP_PROGRAMS - STABLE_TOP_K - DEEP_BATCH_SIZE,
    );
  });
});

describe("batch and budget", () => {
  it("batch is capped at batchSize when missing is larger", () => {
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([
          ["best_ev", ranking("ev", WINDOW + 4)], // 30 missing
        ]),
      }),
    );
    expect(verdict.missing).toHaveLength(WINDOW);
    expect(verdict.batch).toHaveLength(DEEP_BATCH_SIZE);
    expect(uuids(verdict.batch)).toEqual(uuids(verdict.missing).slice(0, DEEP_BATCH_SIZE));
    expect(verdict.statusIfStopped).toBe("incomplete");
    expect(verdict.remainingAfter).toBe(MAX_DEEP_PROGRAMS - DEEP_BATCH_SIZE);
  });

  it("batch is capped at remaining budget when that is smaller than batchSize", () => {
    const committed = new Set(ranking("x", MAX_DEEP_PROGRAMS - 3));
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranking("ev", WINDOW)]]),
        committed, // disjoint from the window — 57 already spent elsewhere
        committedCount: committed.size,
      }),
    );
    expect(verdict.missing).toHaveLength(WINDOW);
    expect(uuids(verdict.batch)).toEqual(["ev-r1", "ev-r2", "ev-r3"]);
    expect(verdict.remainingAfter).toBe(0);
    expect(verdict.statusIfStopped).toBe("incomplete");
  });

  it("budget exhausted with missing left → budget_limited, empty batch", () => {
    const committed = new Set(ranking("x", MAX_DEEP_PROGRAMS));
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranking("ev", WINDOW)]]),
        committed,
        committedCount: committed.size,
      }),
    );
    expect(verdict.missing).toHaveLength(WINDOW); // gaps reported honestly
    expect(verdict.batch).toEqual([]);
    expect(verdict.statusIfStopped).toBe("budget_limited");
    expect(verdict.remainingAfter).toBe(0);
  });

  it("overspent budget (committedCount > maxBudget) still reports budget_limited, never negative remaining", () => {
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ["be-1"]]]),
        committed: new Set(),
        committedCount: MAX_DEEP_PROGRAMS + 7,
      }),
    );
    expect(verdict.batch).toEqual([]);
    expect(verdict.statusIfStopped).toBe("budget_limited");
    expect(verdict.remainingAfter).toBe(0);
  });

  it("committed uuids are never re-batched, wherever they rank", () => {
    const ranks = ranking("ev", WINDOW);
    const committed = new Set(["ev-r1", "ev-r15", "ev-r30"]);
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranks]]),
        committed,
        committedCount: committed.size,
      }),
    );
    expect(verdict.missing).toHaveLength(WINDOW - committed.size);
    for (const uuid of committed) {
      expect(uuids(verdict.missing)).not.toContain(uuid);
      expect(uuids(verdict.batch)).not.toContain(uuid);
    }
    expect(verdict.missing[0]?.uuid).toBe("ev-r2");
  });

  it("committedCount — not committed.size — is the budget ledger", () => {
    // Two in-window uuids are committed, but 55 programs of budget were
    // spent in earlier rounds on rows that have since left the window.
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranking("ev", WINDOW)]]),
        committed: new Set(["ev-r1", "ev-r2"]),
        committedCount: MAX_DEEP_PROGRAMS - 5,
      }),
    );
    expect(verdict.missing).toHaveLength(WINDOW - 2);
    expect(verdict.batch).toHaveLength(5); // min(batchSize 10, budget 5)
    expect(verdict.remainingAfter).toBe(0);
    expect(verdict.statusIfStopped).toBe("incomplete");
  });
});

describe("stabilization status", () => {
  it("a single in-window straggler enters the next batch — the V1.3 regression", () => {
    // V1.3 deep-enriched a fixed shortlist once, then stopped: a program a
    // deep-score drop admitted into the window was never analyzed. V1.3.1
    // picks it up — here the rank-30 edge of the K+buffer window is the
    // only uncommitted row and becomes the entire next batch.
    const ranks = ranking("ev", WINDOW + 5);
    const committed = new Set(ranks.slice(0, WINDOW - 1)); // ranks 1..29
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranks]]),
        committed,
        committedCount: committed.size,
      }),
    );
    expect(verdict.statusIfStopped).toBe("incomplete"); // keep going
    expect(uuids(verdict.missing)).toEqual([`ev-r${WINDOW}`]);
    expect(uuids(verdict.batch)).toEqual([`ev-r${WINDOW}`]);
    expect(verdict.batch[0]?.reasons).toEqual([
      { profile: "best_ev", metadata_rank: WINDOW },
    ]);
    expect(verdict.remainingAfter).toBe(MAX_DEEP_PROGRAMS - WINDOW);
  });

  it("closed frontier stays stable even when the budget is fully spent", () => {
    const ranks = ranking("ev", WINDOW);
    const verdict = evaluateFrontier(
      makeInput({
        perProfileMetadata: new Map([["best_ev", ranks]]),
        committed: new Set(ranks),
        committedCount: MAX_DEEP_PROGRAMS, // spent to the cap
      }),
    );
    expect(verdict.statusIfStopped).toBe("stable");
    expect(verdict.batch).toEqual([]);
    expect(verdict.remainingAfter).toBe(0);
  });
});

describe("parameters and determinism", () => {
  it("honors custom stableTopK / buffer / batchSize / maxBudget", () => {
    const base = makeInput({
      perProfileMetadata: new Map([["best_ev", ranking("ev", 8)]]),
      stableTopK: 3,
      buffer: 2, // window = 5
      batchSize: 2,
      maxBudget: 4,
    });
    const first = evaluateFrontier(base);
    expect(first.missing).toHaveLength(5);
    expect(uuids(first.batch)).toEqual(["ev-r1", "ev-r2"]);
    expect(first.remainingAfter).toBe(2);
    expect(first.statusIfStopped).toBe("incomplete");

    const second = evaluateFrontier({ ...base, committedCount: 3 });
    expect(second.batch).toHaveLength(1); // min(2, 4−3)
    expect(second.remainingAfter).toBe(0);
  });

  it("identical input → identical verdict; Map insertion order is irrelevant", () => {
    const entries: [RadarProfileId, readonly string[]][] = [
      ["best_ev", ["shared", "be-2", "be-3"]],
      ["fresh_programs", ["fr-1", "shared"]],
      ["low_competition", ["lc-1", "shared", "lc-3"]],
    ];
    const input = makeInput({
      perProfileMetadata: new Map(entries),
      committed: new Set(["be-2"]),
      committedCount: 10,
    });
    const a = evaluateFrontier(input);
    const b = evaluateFrontier(input);
    expect(a).toEqual(b);

    const reversed = evaluateFrontier({
      ...input,
      perProfileMetadata: new Map([...entries].reverse()),
    });
    expect(reversed).toEqual(a);
  });
});
