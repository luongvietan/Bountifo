import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/errors";
import { mapBriefDocument } from "../lib/radar/detailMap";
import {
  radarScopeArcSchema,
  radarSemanticDiffSchema,
  type RadarSemanticDiff,
} from "../lib/radar/deepTypes";
import { diffBriefDocuments } from "../lib/radar/diff";
import {
  parseChangelogList,
  selectDiffBaseline,
  type RadarChangelogEntry,
} from "../lib/radar/history";
import { SCOPE_ARC_DEPTH } from "../lib/radar/types";
import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../lib/types";
import changelogList from "./fixtures/radar/site/webdotcom-changelog.json";
import briefDoc from "./fixtures/radar/site/webdotcom-brief-doc.json";
import briefDocPrev from "./fixtures/radar/site/webdotcom-brief-doc-prev.json";

// ---------------------------------------------------------------------------
// Radar V1.5 scope arc — lib/radar/arc.ts.
//
// The arc is a semantic diff between the current detail and the brief doc
// SCOPE_ARC_DEPTH (5) versions back — the multi-publish counterpart of the
// V1.3 single-step diff. siteRequest is mocked at the module boundary (same
// pattern as tests/radar-known-issues.test.ts) so every failure kind is
// reachable without the transport layer.
//
// Fixtures are the live webdotcom captures the semantic-diff suite already
// uses: a 24-entry changelog (head id cdf0a5a7… = "Latest") and the
// prev→curr brief doc pair whose known delta is exactly one added in-scope
// web target.
// ---------------------------------------------------------------------------

const siteRequestMock = vi.fn();

vi.mock("../lib/api/siteClient", () => ({
  siteRequest: (...args: unknown[]) => siteRequestMock(...args),
}));

import {
  fetchScopeArc,
  scopeMomentumScore,
  selectArcBaseline,
} from "../lib/radar/arc";

const IDS = { from_version: "v-prev", to_version: "v-curr" } as const;

function entry(partial: Partial<RadarChangelogEntry> = {}): RadarChangelogEntry {
  return {
    id: "e0",
    publishedAt: null,
    tags: [],
    state: null,
    publishedBy: null,
    ...partial,
  };
}

function makeTarget(partial: Partial<ApiTarget> = {}): ApiTarget {
  return {
    id: "",
    groupId: null,
    location: null,
    name: null,
    category: null,
    tags: [],
    inScope: true,
    ...partial,
  };
}

function makeGroup(partial: Partial<ApiTargetGroup> = {}): ApiTargetGroup {
  return {
    id: "",
    name: "Scope",
    inScope: true,
    description: null,
    rewards: { p1: null, p2: null, p3: null, p4: null, p5: null },
    ...partial,
  };
}

function makeDetail(partial: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "prog",
    name: "Program",
    code: "prog",
    engagementType: null,
    managedBounty: null,
    lifecycleStatus: "In progress",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: null,
    lastBriefUpdate: null,
    safeHarborLevel: null,
    statistics: {},
    targetGroups: [],
    targets: [],
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: null,
    ...partial,
  };
}

/** A contract-shaped complete diff with every fact zeroed/quiet. */
function completeDiff(
  partial: Partial<RadarSemanticDiff> = {},
): RadarSemanticDiff {
  return {
    status: "complete",
    from_version: "v-old",
    to_version: "v-new",
    added_targets: 0,
    removed_targets: 0,
    added_in_scope_targets: 0,
    removed_in_scope_targets: 0,
    moved_in_scope: 0,
    moved_out_of_scope: 0,
    added_api_targets: 0,
    added_web_targets: 0,
    added_groups: 0,
    reward_increase: false,
    reward_decrease: false,
    safe_harbor_changed: false,
    status_changed: false,
    only_administrative_changes: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// selectArcBaseline
// ---------------------------------------------------------------------------

describe("selectArcBaseline", () => {
  // Live capture: 24 entries, newest-first; entries[0] carries "Latest".
  const entries = parseChangelogList(changelogList);
  const latestId = entries[0]!.id;

  it("selects the entry SCOPE_ARC_DEPTH publishes back from Latest", () => {
    expect(SCOPE_ARC_DEPTH).toBe(5);
    expect(entries).toHaveLength(24);
    expect(selectArcBaseline(entries, latestId)).toEqual({
      id: entries[5]!.id, // 74f0d731-40bf-453a-85ad-6d45deb73560
      window: 5,
    });
  });

  it("spans depth positions from a mid-list latest", () => {
    expect(selectArcBaseline(entries, entries[3]!.id)).toEqual({
      id: entries[8]!.id,
      window: 5,
    });
  });

  it("clamps to the oldest entry when depth overruns the list", () => {
    // i=20, j = min(25, 23) = 23 → window 3, not 5.
    expect(selectArcBaseline(entries, entries[20]!.id)).toEqual({
      id: entries[23]!.id,
      window: 3,
    });
    // i=22 → j = 23 → window 1.
    expect(selectArcBaseline(entries, entries[22]!.id)).toEqual({
      id: entries[23]!.id,
      window: 1,
    });
  });

  it("returns null when Latest is the oldest entry (j === i)", () => {
    expect(selectArcBaseline(entries, entries[23]!.id)).toBeNull();
  });

  it("returns null when an asserted latestId is absent — never pairs arbitrary", () => {
    // Same doctrine as selectDiffBaseline: a stale/paginated-out current id
    // must not silently diff against an unrelated older version.
    expect(selectArcBaseline(entries, "not-in-this-list")).toBeNull();
  });

  it("treats the head as current when latestId is null or empty", () => {
    const expected = { id: entries[5]!.id, window: 5 };
    expect(selectArcBaseline(entries, null)).toEqual(expected);
    expect(selectArcBaseline(entries, "")).toEqual(expected);
  });

  it("returns null for single-entry and empty histories", () => {
    const only = [entry({ id: "only" })];
    expect(selectArcBaseline(only, "only")).toBeNull();
    expect(selectArcBaseline(only, null)).toBeNull();
    expect(selectArcBaseline([], null)).toBeNull();
    expect(selectArcBaseline([], "x")).toBeNull();
  });

  it("honors an explicit depth argument", () => {
    expect(selectArcBaseline(entries, latestId, 2)).toEqual({
      id: entries[2]!.id,
      window: 2,
    });
    // depth 0 → j === i → no window.
    expect(selectArcBaseline(entries, latestId, 0)).toBeNull();
  });

  it("at depth 1 it reproduces selectDiffBaseline — same id, window 1", () => {
    for (const i of [0, 5, 22]) {
      const arc = selectArcBaseline(entries, entries[i]!.id, 1);
      expect(arc).toEqual({ id: entries[i + 1]!.id, window: 1 });
      expect(arc!.id).toBe(selectDiffBaseline(entries, entries[i]!.id));
    }
    // Tail: both report no baseline.
    expect(selectArcBaseline(entries, entries[23]!.id, 1)).toBeNull();
    expect(selectDiffBaseline(entries, entries[23]!.id)).toBeNull();
  });

  it("a 2-version history selects the same doc as the step baseline (dedupe contract)", () => {
    // When the arc window clamps onto the step baseline, both selectors name
    // the SAME version id — a caller comparing ids can fetch the document
    // once and feed it to both diffs. This pins that id equality; the fetch
    // dedupe itself is coordinator-side.
    const two = entries.slice(0, 2);
    const arc = selectArcBaseline(two, two[0]!.id);
    expect(arc).toEqual({ id: two[1]!.id, window: 1 });
    expect(arc!.id).toBe(selectDiffBaseline(two, two[0]!.id));
    // And with the head-as-current fallback the equality still holds.
    expect(selectArcBaseline(two, null)!.id).toBe(
      selectDiffBaseline(two, null),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchScopeArc
// ---------------------------------------------------------------------------

describe("fetchScopeArc", () => {
  const entries = parseChangelogList(changelogList);
  const latestId = entries[0]!.id;
  const arcBaselineId = entries[5]!.id;
  const currentDetail = mapBriefDocument("webdotcom", briefDoc, null);

  beforeEach(() => {
    siteRequestMock.mockReset();
  });

  it("no_baseline when no arc baseline exists — and never fetches", async () => {
    const arc = await fetchScopeArc(
      "webdotcom",
      [entry({ id: "only" })],
      "only",
      currentDetail,
    );
    expect(arc).toEqual({
      status: "no_baseline",
      window_versions: null,
      diff: null,
    });
    expect(radarScopeArcSchema.safeParse(arc).success).toBe(true);
    expect(siteRequestMock).not.toHaveBeenCalled();
  });

  it("no_baseline when the asserted latestId is absent from the list", async () => {
    const arc = await fetchScopeArc(
      "webdotcom",
      entries,
      "stale-id",
      currentDetail,
    );
    expect(arc.status).toBe("no_baseline");
    expect(siteRequestMock).not.toHaveBeenCalled();
  });

  it("fetches GET_BRIEF_DOC for the arc baseline and completes the diff", async () => {
    siteRequestMock.mockResolvedValue({ data: briefDocPrev, status: 200 });
    const arc = await fetchScopeArc(
      "webdotcom",
      entries,
      latestId,
      currentDetail,
    );
    expect(siteRequestMock).toHaveBeenCalledTimes(1);
    expect(siteRequestMock).toHaveBeenCalledWith({
      operation: "GET_BRIEF_DOC",
      slug: "webdotcom",
      versionId: arcBaselineId,
    });
    expect(radarScopeArcSchema.safeParse(arc).success).toBe(true);
    expect(arc.status).toBe("complete");
    expect(arc.window_versions).toBe(5);
    // from_version is the SELECTED changelog id — the arc baseline — and
    // to_version the asserted Latest id.
    expect(arc.diff!.from_version).toBe(arcBaselineId);
    expect(arc.diff!.to_version).toBe(latestId);
    expect(radarSemanticDiffSchema.safeParse(arc.diff).success).toBe(true);
    // The fixture pair's known delta: one added in-scope web target.
    expect(arc.diff!.status).toBe("complete");
    expect(arc.diff!.added_in_scope_targets).toBe(1);
    expect(arc.diff!.added_web_targets).toBe(1);
    expect(scopeMomentumScore(arc.diff!)).toBeGreaterThan(0);
  });

  it("clamped window: a short history reports the real window, not depth", async () => {
    const two = entries.slice(0, 2);
    siteRequestMock.mockResolvedValue({ data: briefDocPrev, status: 200 });
    const arc = await fetchScopeArc(
      "webdotcom",
      two,
      two[0]!.id,
      currentDetail,
    );
    expect(siteRequestMock).toHaveBeenCalledWith({
      operation: "GET_BRIEF_DOC",
      slug: "webdotcom",
      versionId: two[1]!.id,
    });
    // Arc window 1 = the step baseline id — the coordinator's cue to dedupe
    // this document against the step diff's fetch. Exactly one request here.
    expect(two[1]!.id).toBe(selectDiffBaseline(two, two[0]!.id));
    expect(siteRequestMock).toHaveBeenCalledTimes(1);
    expect(arc.status).toBe("complete");
    expect(arc.window_versions).toBe(1);
  });

  it("unavailable when the baseline doc fetch throws — window still reported", async () => {
    siteRequestMock.mockRejectedValue(
      new ApiError("not_found", "not found", 404),
    );
    const arc = await fetchScopeArc(
      "webdotcom",
      entries,
      latestId,
      currentDetail,
    );
    expect(arc).toEqual({
      status: "unavailable",
      window_versions: 5,
      diff: null,
    });
    expect(radarScopeArcSchema.safeParse(arc).success).toBe(true);
  });

  it("unavailable when the baseline doc is malformed (mapBriefDocument throws)", async () => {
    siteRequestMock.mockResolvedValue({ data: { nope: true }, status: 200 });
    const arc = await fetchScopeArc(
      "webdotcom",
      entries,
      latestId,
      currentDetail,
    );
    expect(arc).toEqual({
      status: "unavailable",
      window_versions: 5,
      diff: null,
    });
  });

  it("unavailable when the differ can't analyze the pair — schema keeps diff null", async () => {
    siteRequestMock.mockResolvedValue({ data: briefDocPrev, status: 200 });
    const broken = {
      ...currentDetail,
      targets: "oops",
    } as unknown as ApiEngagementData;
    const arc = await fetchScopeArc("webdotcom", entries, latestId, broken);
    expect(arc).toEqual({
      status: "unavailable",
      window_versions: 5,
      diff: null,
    });
    expect(radarScopeArcSchema.safeParse(arc).success).toBe(true);
  });

  it("never throws — even on non-Error rejections", async () => {
    siteRequestMock.mockRejectedValue("a bare string rejection");
    await expect(
      fetchScopeArc("webdotcom", entries, latestId, currentDetail),
    ).resolves.toMatchObject({ status: "unavailable", diff: null });
  });
});

// ---------------------------------------------------------------------------
// scopeMomentumScore
// ---------------------------------------------------------------------------

describe("scopeMomentumScore", () => {
  it("is null unless the diff completed — unknown is never zero", () => {
    for (const status of ["unavailable", "no_baseline"] as const) {
      expect(scopeMomentumScore(completeDiff({ status }))).toBeNull();
    }
    const noBaseline = diffBriefDocuments(null, makeDetail(), {
      from_version: null,
      to_version: "v-curr",
    });
    expect(noBaseline.status).toBe("no_baseline");
    expect(scopeMomentumScore(noBaseline)).toBeNull();
  });

  it("only_administrative_changes → a real 0 (analyzed, no net growth)", () => {
    expect(
      scopeMomentumScore(completeDiff({ only_administrative_changes: true })),
    ).toBe(0);
    // And through the real differ — the wording-edit case freshness can't see.
    const same = diffBriefDocuments(makeDetail(), makeDetail(), IDS);
    expect(same.only_administrative_changes).toBe(true);
    expect(scopeMomentumScore(same)).toBe(0);
  });

  it("pins the worked example: ai=10 → ≈0.194 contribution", () => {
    // 0.35·10/(10+8) = 0.19444… → round4 0.1944.
    expect(
      scopeMomentumScore(completeDiff({ added_in_scope_targets: 10 })),
    ).toBe(0.1944);
  });

  it("pins the worked example continued: +api 2 → +0.083, +reward → +0.15", () => {
    // 0.35·10/18 + 0.25·2/6 = 0.19444 + 0.08333 → 0.2778.
    expect(
      scopeMomentumScore(
        completeDiff({ added_in_scope_targets: 10, added_api_targets: 2 }),
      ),
    ).toBe(0.2778);
    // + 0.15 flat → 0.4278.
    expect(
      scopeMomentumScore(
        completeDiff({
          added_in_scope_targets: 10,
          added_api_targets: 2,
          reward_increase: true,
        }),
      ),
    ).toBe(0.4278);
  });

  it("pins the remaining terms: ag=2 → 0.05, mi=4 → 0.075", () => {
    // 0.10·2/(2+2) = 0.05; 0.15·4/(4+4) = 0.075.
    expect(scopeMomentumScore(completeDiff({ added_groups: 2 }))).toBe(0.05);
    expect(scopeMomentumScore(completeDiff({ moved_in_scope: 4 }))).toBe(
      0.075,
    );
  });

  it("reductions contribute nothing — shrinkage is never negative momentum", () => {
    expect(
      scopeMomentumScore(
        completeDiff({
          removed_targets: 40,
          removed_in_scope_targets: 30,
          moved_out_of_scope: 10,
          reward_decrease: true,
        }),
      ),
    ).toBe(0);
  });

  it("administrative flags alone add no momentum", () => {
    expect(
      scopeMomentumScore(
        completeDiff({ safe_harbor_changed: true, status_changed: true }),
      ),
    ).toBe(0);
  });

  it("is monotone nondecreasing in net adds through the real differ", () => {
    const inGroup = makeGroup({ id: "g", inScope: true });
    const scores = [0, 1, 3, 8, 20, 100].map((n) =>
      scopeMomentumScore(
        diffBriefDocuments(
          makeDetail({ targetGroups: [inGroup] }),
          makeDetail({
            targetGroups: [inGroup],
            targets: Array.from({ length: n }, (_, i) =>
              makeTarget({
                id: `t${i}`,
                groupId: "g",
                inScope: true,
                location: `https://host${i}.example.com`,
              }),
            ),
          }),
          IDS,
        ),
      ),
    );
    expect(scores[0]).toBe(0);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
    for (const s of scores) {
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(1);
    }
  });

  it("saturates at 1 when every term is maxed", () => {
    expect(
      scopeMomentumScore(
        completeDiff({
          added_in_scope_targets: 1_000_000,
          added_api_targets: 1_000_000,
          added_groups: 1_000_000,
          moved_in_scope: 1_000_000,
          reward_increase: true,
        }),
      ),
    ).toBe(1);
  });

  it("treats a null fact on a complete diff as 0 — defensive, never fabricated", () => {
    // Schema-unreachable (complete ⇒ all facts known), but the score must
    // still read honestly rather than produce NaN.
    const s = scopeMomentumScore(
      completeDiff({ added_in_scope_targets: null }),
    );
    expect(s).toBe(0);
    expect(Number.isFinite(s!)).toBe(true);
  });
});
