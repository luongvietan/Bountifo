import { describe, expect, it } from "vitest";
import {
  selectDeepCandidates,
  type ShortlistInput,
} from "../lib/radar/shortlist";
import {
  DEEP_PROFILE_IDS,
  MAX_DEEP_PROGRAMS,
  PROFILE_CANDIDATE_DEPTH,
  type RadarProfileId,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Agent A — Radar V1.3.1 profile-aware deep-candidate shortlist.
//
// V1.3 deep-enriched only the best_ev metadata Top-30, so the deep-weighted
// profiles (fresh_programs, low_competition, authz_api) never got
// known_issue_density / opportunity_change on their own top rows. The union
// built here is the fix; these tests pin the union semantics, the
// deterministic dispatch order, the budget cap, and a realistic overlap
// measurement that informs PROFILE_CANDIDATE_DEPTH.
// ---------------------------------------------------------------------------

/** Convenience: ordered uuid lists keyed by profile. */
function input(
  perProfile: Partial<Record<RadarProfileId, readonly string[]>>,
  extra: Partial<ShortlistInput> = {},
): ShortlistInput {
  return {
    perProfile: new Map(Object.entries(perProfile)) as ReadonlyMap<
      RadarProfileId,
      readonly string[]
    >,
    ...extra,
  };
}

function uuidList(prefix: string, count: number, start = 0): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}-${String(start + i).padStart(3, "0")}`,
  );
}

describe("selectDeepCandidates — union semantics", () => {
  it("dedupes a uuid present in 3 profiles, keeping all reasons in profile-priority order", () => {
    const shared = "u-shared";
    const result = selectDeepCandidates(
      input({
        // Deliberately pass rankings where the shared uuid sits at
        // different ranks — each contributes its own reason.
        best_ev: ["u-a", shared, "u-b"],
        fresh_programs: ["u-c", "u-d", shared],
        low_competition: ["u-e", shared, "u-f"],
        authz_api: ["u-g", "u-h"],
      }),
    );

    const candidate = result.candidates.find((c) => c.uuid === shared);
    expect(candidate).toBeDefined();
    expect(candidate!.reasons).toEqual([
      { profile: "best_ev", metadata_rank: 2 },
      { profile: "fresh_programs", metadata_rank: 3 },
      { profile: "low_competition", metadata_rank: 2 },
    ]);
    // DEEP_PROFILE_IDS priority order — NOT the order the profiles happen
    // to appear in the input map.
    expect(
      candidate!.reasons.map((r) => r.profile),
    ).toEqual(["best_ev", "fresh_programs", "low_competition"]);
    // One union entry, not three.
    expect(
      result.candidates.filter((c) => c.uuid === shared),
    ).toHaveLength(1);
    expect(result.unionSize).toBe(3 + 3 + 3 + 2 - 2); // 9 rows − 2 dup merges
    expect(result.truncated).toBe(0);
  });

  it("admits uuids that only appear in a non-best_ev deep profile (V1.3 headline fix)", () => {
    const result = selectDeepCandidates(
      input({
        best_ev: ["be-1", "be-2", "be-3"],
        fresh_programs: ["fp-only-1", "be-1", "fp-only-2"],
        low_competition: ["lc-only", "be-2"],
        authz_api: ["az-only"],
      }),
    );

    const uuids = result.candidates.map((c) => c.uuid);
    // V1.3 these four would never have been deep-enriched at all.
    for (const only of ["fp-only-1", "fp-only-2", "lc-only", "az-only"]) {
      expect(uuids).toContain(only);
    }
    // Their provenance is honestly single-profile.
    expect(
      result.candidates.find((c) => c.uuid === "lc-only")!.reasons,
    ).toEqual([{ profile: "low_competition", metadata_rank: 1 }]);
    expect(
      result.candidates.find((c) => c.uuid === "az-only")!.reasons,
    ).toEqual([{ profile: "authz_api", metadata_rank: 1 }]);
  });

  it("keeps the best rank when a profile ranking duplicates a uuid", () => {
    const result = selectDeepCandidates(
      input({ best_ev: ["dup", "u-x", "dup"] }),
    );
    const candidate = result.candidates.find((c) => c.uuid === "dup")!;
    expect(candidate.reasons).toEqual([
      { profile: "best_ev", metadata_rank: 1 },
    ]);
    expect(result.unionSize).toBe(2);
  });
});

describe("selectDeepCandidates — dispatch ordering", () => {
  it("orders best_ev #1 before fresh_programs #1 before low_competition #1", () => {
    const result = selectDeepCandidates(
      input({
        // Disjoint top rows: ordering must come from profile priority,
        // not insertion or uuid order.
        authz_api: ["zz-authz-1"],
        low_competition: ["mm-low-1"],
        fresh_programs: ["gg-fresh-1"],
        best_ev: ["tt-best-1"],
      }),
    );
    expect(result.candidates.map((c) => c.uuid)).toEqual([
      "tt-best-1", // best_ev #1 — highest-priority profile wins
      "gg-fresh-1", // fresh_programs #1
      "mm-low-1", // low_competition #1
      "zz-authz-1", // authz_api #1
    ]);
  });

  it("ranks within one profile bucket by metadata rank", () => {
    const result = selectDeepCandidates(
      input({
        best_ev: ["be-1", "be-2"],
        fresh_programs: ["fp-1", "fp-2", "fp-3"],
      }),
    );
    expect(result.candidates.map((c) => c.uuid)).toEqual([
      "be-1",
      "be-2",
      "fp-1",
      "fp-2",
      "fp-3",
    ]);
  });

  it("breaks rank-swap ties by uuid ASC", () => {
    // a-uuid and b-uuid hold the SAME sort key (0,1): each is rank 1 in one
    // of the two top-priority profiles and rank 2 in the other. uuid ASC is
    // the only total-order tiebreak left.
    const result = selectDeepCandidates(
      input({
        best_ev: ["b-uuid", "a-uuid"],
        fresh_programs: ["a-uuid", "b-uuid"],
      }),
    );
    expect(result.candidates.map((c) => c.uuid)).toEqual([
      "a-uuid",
      "b-uuid",
    ]);
    expect(result.candidates[0]!.reasons).toEqual([
      { profile: "best_ev", metadata_rank: 2 },
      { profile: "fresh_programs", metadata_rank: 1 },
    ]);
  });

  it("promotes a multi-profile uuid into its best profile bucket", () => {
    const result = selectDeepCandidates(
      input({
        best_ev: ["be-1", "everywhere"],
        fresh_programs: ["fp-1", "everywhere", "fp-2"],
        low_competition: ["everywhere"],
      }),
    );
    // "everywhere" sorts as a best_ev candidate (rank 2), ahead of every
    // fresh/low row despite appearing in their lists too.
    expect(result.candidates.map((c) => c.uuid)).toEqual([
      "be-1",
      "everywhere",
      "fp-1",
      "fp-2",
    ]);
    expect(
      result.candidates[1]!.reasons.map((r) => r.profile),
    ).toEqual(["best_ev", "fresh_programs", "low_competition"]);
  });
});

describe("selectDeepCandidates — depth and budget", () => {
  it("respects the depth parameter per profile", () => {
    const rankings = {
      best_ev: uuidList("be", 10),
      fresh_programs: uuidList("fp", 10),
    };
    const deep3 = selectDeepCandidates(input(rankings, { depth: 3 }));
    expect(deep3.unionSize).toBe(6);
    // Rank 4+ of each profile is outside the admitted window.
    expect(deep3.candidates.map((c) => c.uuid)).not.toContain("be-003");
    expect(
      deep3.candidates.find((c) => c.uuid === "fp-002")!.reasons,
    ).toEqual([{ profile: "fresh_programs", metadata_rank: 3 }]);

    // depth larger than the list is honest — nothing fabricated.
    const deep50 = selectDeepCandidates(input(rankings, { depth: 50 }));
    expect(deep50.unionSize).toBe(20);
  });

  it("treats absent profiles and empty lists as empty", () => {
    const empty = selectDeepCandidates(input({}));
    expect(empty).toEqual({ candidates: [], truncated: 0, unionSize: 0 });

    const partial = selectDeepCandidates(
      input({ low_competition: ["lc-1"], authz_api: [] }),
    );
    expect(partial.unionSize).toBe(1);
    expect(partial.candidates[0]!.reasons).toEqual([
      { profile: "low_competition", metadata_rank: 1 },
    ]);
  });

  it("defaults to PROFILE_CANDIDATE_DEPTH and MAX_DEEP_PROGRAMS", () => {
    // 4 disjoint 25-deep rankings → union 80, capped at 60.
    const rankings = Object.fromEntries(
      DEEP_PROFILE_IDS.map((p, i) => [p, uuidList(`p${i}`, 25)]),
    );
    const result = selectDeepCandidates(input(rankings));
    expect(result.candidates).toHaveLength(MAX_DEEP_PROGRAMS);
    expect(result.unionSize).toBe(4 * PROFILE_CANDIDATE_DEPTH);
    expect(result.truncated).toBe(4 * PROFILE_CANDIDATE_DEPTH - MAX_DEEP_PROGRAMS);
    // And depth defaulted to 20, not 25.
    expect(
      result.candidates.map((c) => c.uuid),
    ).not.toContain("p0-020");
  });

  it("truncates at maxCandidates and reports overflow honestly", () => {
    const rankings = {
      best_ev: uuidList("be", 10),
      fresh_programs: uuidList("fp", 10),
    };
    const result = selectDeepCandidates(
      input(rankings, { depth: 10, maxCandidates: 7 }),
    );
    expect(result.unionSize).toBe(20);
    expect(result.candidates).toHaveLength(7);
    expect(result.truncated).toBe(13);
    // The cut is deterministic: the best_ev bucket sorts first and
    // survives, the fresh_programs tail is what overflows.
    expect(result.candidates.map((c) => c.uuid)).toEqual(uuidList("be", 7));
    expect(result.candidates[6]!.uuid).toBe("be-006");
  });
});

describe("selectDeepCandidates — determinism", () => {
  it("produces identical output for identical input (run twice)", () => {
    const rankings = {
      best_ev: uuidList("be", 20),
      fresh_programs: ["be-003", ...uuidList("fp", 19)],
      low_competition: ["be-010", "fp-003", ...uuidList("lc", 18)],
      authz_api: ["lc-005", "be-001", ...uuidList("az", 18)],
    };
    const a = selectDeepCandidates(input(rankings));
    const b = selectDeepCandidates(input(rankings));
    expect(b).toEqual(a);
    // And key-order in the input map must not matter.
    const shuffled = new Map<RadarProfileId, readonly string[]>([
      ["authz_api", rankings.authz_api],
      ["best_ev", rankings.best_ev],
      ["low_competition", rankings.low_competition],
      ["fresh_programs", rankings.fresh_programs],
    ]);
    expect(selectDeepCandidates({ perProfile: shuffled })).toEqual(a);
  });
});

describe("selectDeepCandidates — overlap statistics (sizing evidence)", () => {
  it("measures union size under realistic ~50% cross-profile overlap", () => {
    // Synthetic catalog: 120 programs. best_ev's top-20 is the reference;
    // each other deep profile shares ~half its top-20 with best_ev plus a
    // little incidental overlap, the rest being profile-unique picks — the
    // realistic shape for profiles weighting different signals.
    const depth = PROFILE_CANDIDATE_DEPTH; // 20
    const catalog = uuidList("u", 120);

    const bestEvTop = catalog.slice(0, depth); // u-000..u-019
    const rankings: Record<string, string[]> = {
      // best_ev: top-20 then the remainder of the catalog in order.
      best_ev: [...catalog],
      // fresh_programs: best_ev ranks 1-10 + 10 unique deeper picks.
      fresh_programs: [
        ...bestEvTop.slice(0, 10),
        ...catalog.slice(60, 70),
      ],
      // low_competition: best_ev ranks 6-15 + 10 uniques.
      low_competition: [
        ...bestEvTop.slice(5, 15),
        ...catalog.slice(70, 80),
      ],
      // authz_api: best_ev ranks 11-20 + 5 shared with fresh's uniques
      // + 5 uniques of its own.
      authz_api: [
        ...bestEvTop.slice(10, 20),
        ...catalog.slice(60, 65),
        ...catalog.slice(80, 85),
      ],
    };
    // Every ranking covers the whole catalog deterministically (only the
    // top-`depth` window is admitted anyway).
    for (const p of Object.keys(rankings)) {
      const list = rankings[p]!;
      const seen = new Set(list);
      for (const u of catalog) if (!seen.has(u)) list.push(u);
    }

    const result = selectDeepCandidates(input(rankings));

    // Pairwise overlap matrix over the admitted top-N windows.
    const profiles = DEEP_PROFILE_IDS;
    const tops = profiles.map(
      (p) => new Set((rankings[p] ?? []).slice(0, depth)),
    );
    const matrix: Record<string, Record<string, number>> = {};
    for (let i = 0; i < profiles.length; i++) {
      const pi = profiles[i]!;
      matrix[pi] = {};
      for (let j = 0; j < profiles.length; j++) {
        const pj = profiles[j]!;
        const a = tops[i]!;
        const b = tops[j]!;
        matrix[pi]![pj] = [...a].filter((u) => b.has(u)).length;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[overlap] depth=${depth} unionSize=${result.unionSize} ` +
        `candidates=${result.candidates.length} truncated=${result.truncated}`,
    );
    const header = ["", ...profiles.map((p) => p.slice(0, 7))];
    // eslint-disable-next-line no-console
    console.log(`[overlap] ${header.join("\t")}`);
    for (const p of profiles) {
      // eslint-disable-next-line no-console
      console.log(
        `[overlap] ${p.slice(0, 7)}\t${profiles
          .map((q) => String(matrix[p]?.[q] ?? 0).padStart(2))
          .join("\t")}`,
      );
    }

    // Sanity bounds: the union can never exceed 4×depth (zero overlap) nor
    // fall below the largest admitted window.
    expect(result.unionSize).toBeLessThanOrEqual(4 * depth);
    expect(result.unionSize).toBeGreaterThanOrEqual(depth);
    // Under the synthesized overlap the union leaves headroom against the
    // 60-program deep budget.
    expect(result.unionSize).toBeLessThanOrEqual(80);
    expect(result.candidates.length).toBe(
      Math.min(result.unionSize, MAX_DEEP_PROGRAMS),
    );
  });
});
