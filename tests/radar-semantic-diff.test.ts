import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api/errors";
import { mapBriefDocument } from "../lib/radar/detailMap";
import { radarSemanticDiffSchema } from "../lib/radar/deepTypes";
import {
  diffBriefDocuments,
  opportunityChangeScore,
} from "../lib/radar/diff";
import {
  entryTouchesTargets,
  parseChangelogList,
  selectDiffBaseline,
  type RadarChangelogEntry,
} from "../lib/radar/history";
import type { ApiEngagementData, ApiTarget, ApiTargetGroup } from "../lib/types";
import changelogList from "./fixtures/radar/site/webdotcom-changelog.json";
import changelogPage2 from "./fixtures/radar/site/webdotcom-changelog-p2.json";
import briefDoc from "./fixtures/radar/site/webdotcom-brief-doc.json";
import briefDocPrev from "./fixtures/radar/site/webdotcom-brief-doc-prev.json";

// Radar V1.3 semantic differ + changelog history parsing.
//
// Fixtures are live captures from bugcrowd.com/engagements/webdotcom.
// webdotcom-brief-doc-prev.json is the real-shaped predecessor version
// (id/publishedAt of the actual predecessor changelog entry, one in-scope
// target — bluehost — removed) so the prev→curr diff is a known quantity:
// exactly one added in-scope web target.

const IDS = { from_version: "v-prev", to_version: "v-curr" } as const;

const COUNTER_KEYS = [
  "added_targets",
  "removed_targets",
  "added_in_scope_targets",
  "removed_in_scope_targets",
  "moved_in_scope",
  "moved_out_of_scope",
  "added_api_targets",
  "added_web_targets",
  "added_groups",
] as const;

const FLAG_KEYS = [
  "reward_increase",
  "reward_decrease",
  "safe_harbor_changed",
  "status_changed",
] as const;

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
    observedApiVersion: null,
    ...partial,
  };
}

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

// ---------------------------------------------------------------------------
// diffBriefDocuments — real fixture pair
// ---------------------------------------------------------------------------

describe("diffBriefDocuments — mapped fixture pair", () => {
  const curr = mapBriefDocument("webdotcom", briefDoc, null);
  const prev = mapBriefDocument("webdotcom", briefDocPrev, null);
  const diff = diffBriefDocuments(prev, curr, {
    from_version: briefDocPrev.id as string,
    to_version: briefDoc.id as string,
  });

  it("produces a contract-valid complete diff with version ids", () => {
    expect(radarSemanticDiffSchema.safeParse(diff).success).toBe(true);
    expect(diff.status).toBe("complete");
    expect(diff.from_version).toBe("3f5d9ee5-4636-442f-a608-4b1457a92f23");
    expect(diff.to_version).toBe("cdf0a5a7-3e14-4bd2-8997-a9567e0bb63e");
  });

  it("counts exactly the known added in-scope web target", () => {
    expect(diff.added_targets).toBe(1);
    expect(diff.added_in_scope_targets).toBe(1);
    expect(diff.added_web_targets).toBe(1);
    expect(diff.added_api_targets).toBe(0);
    expect(diff.removed_targets).toBe(0);
    expect(diff.removed_in_scope_targets).toBe(0);
    expect(diff.moved_in_scope).toBe(0);
    expect(diff.moved_out_of_scope).toBe(0);
    expect(diff.added_groups).toBe(0);
    expect(diff.reward_increase).toBe(false);
    expect(diff.reward_decrease).toBe(false);
    expect(diff.safe_harbor_changed).toBe(false);
    expect(diff.status_changed).toBe(false);
    expect(diff.only_administrative_changes).toBe(false);
    // One new in-scope web target: 0.35·(1/4) = 0.0875.
    expect(opportunityChangeScore(diff)).toBe(0.0875);
  });
});

// ---------------------------------------------------------------------------
// diffBriefDocuments — identical / text-only documents
// ---------------------------------------------------------------------------

describe("diffBriefDocuments — identical and text-only docs", () => {
  const curr = mapBriefDocument("webdotcom", briefDoc, null);

  it("complete + all zeros + only_administrative for a doc vs itself", () => {
    const diff = diffBriefDocuments(curr, curr, IDS);
    expect(diff.status).toBe("complete");
    for (const k of COUNTER_KEYS) expect(diff[k]).toBe(0);
    for (const k of FLAG_KEYS) expect(diff[k]).toBe(false);
    expect(diff.only_administrative_changes).toBe(true);
    expect(opportunityChangeScore(diff)).toBe(0);
  });

  it("the 13-minute wording edit: different publishedAt/description → 0", () => {
    // Mirrors the live evidence: two versions 13min apart, identical
    // scope/rewards, reworded prose. freshness can't tell — the diff can.
    const edited = JSON.parse(JSON.stringify(briefDoc)) as Record<
      string,
      unknown
    >;
    edited.id = "aaaaaaaa-0000-4000-8000-000000000000";
    edited.publishedAt = "2026-09-11T15:16:00.000Z";
    (edited.data as { brief: { description: string } }).brief.description =
      "<p>Completely reworded administrative copy.</p>";
    const scope = (edited.data as { scope: { description: string }[] }).scope;
    scope[0]!.description = "Edited group description text.";
    const diff = diffBriefDocuments(
      curr,
      mapBriefDocument("webdotcom", edited, null),
      IDS,
    );
    expect(diff.status).toBe("complete");
    for (const k of COUNTER_KEYS) expect(diff[k]).toBe(0);
    expect(diff.only_administrative_changes).toBe(true);
    expect(opportunityChangeScore(diff)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffBriefDocuments — target add/remove/move semantics
// ---------------------------------------------------------------------------

describe("diffBriefDocuments — target deltas", () => {
  const inGroup = makeGroup({ id: "g-in", name: "In Scope", inScope: true });
  const outGroup = makeGroup({
    id: "g-out",
    name: "Out of Scope",
    inScope: false,
  });

  it("counts an added in-scope web target", () => {
    const diff = diffBriefDocuments(
      makeDetail({ targetGroups: [inGroup] }),
      makeDetail({
        targetGroups: [inGroup],
        targets: [
          makeTarget({
            id: "t1",
            groupId: "g-in",
            inScope: true,
            location: "https://app.example.com",
            category: "website",
          }),
        ],
      }),
      IDS,
    );
    expect(diff.added_targets).toBe(1);
    expect(diff.added_in_scope_targets).toBe(1);
    expect(diff.added_web_targets).toBe(1);
    expect(diff.added_api_targets).toBe(0);
    expect(opportunityChangeScore(diff)).toBeGreaterThan(0);
  });

  it("does NOT count an out-of-scope addition as in-scope — but it is structural", () => {
    const diff = diffBriefDocuments(
      makeDetail({ targetGroups: [inGroup, outGroup] }),
      makeDetail({
        targetGroups: [inGroup, outGroup],
        targets: [
          makeTarget({
            id: "t1",
            groupId: "g-out",
            inScope: false,
            location: "https://staging.example.com",
            category: "website",
          }),
        ],
      }),
      IDS,
    );
    expect(diff.added_targets).toBe(1);
    expect(diff.added_in_scope_targets).toBe(0);
    expect(diff.added_web_targets).toBe(0);
    // A real scope-list change — not administrative — yet no new huntable
    // surface, so the score stays 0.
    expect(diff.only_administrative_changes).toBe(false);
    expect(opportunityChangeScore(diff)).toBe(0);
  });

  it("counts removed targets, in-scope only when the removed one was", () => {
    const prev = makeDetail({
      targetGroups: [inGroup, outGroup],
      targets: [
        makeTarget({
          id: "t-in",
          groupId: "g-in",
          inScope: true,
          location: "https://a.example.com",
        }),
        makeTarget({
          id: "t-out",
          groupId: "g-out",
          inScope: false,
          location: "https://b.example.com",
        }),
      ],
    });
    const diff = diffBriefDocuments(
      prev,
      makeDetail({ targetGroups: [inGroup, outGroup] }),
      IDS,
    );
    expect(diff.removed_targets).toBe(2);
    expect(diff.removed_in_scope_targets).toBe(1);
    expect(diff.added_targets).toBe(0);
    // Scope reductions are never positive opportunity.
    expect(opportunityChangeScore(diff)).toBe(0);
  });

  it("counts a group-level inScope flip as moved_in_scope", () => {
    const prev = makeDetail({
      targetGroups: [makeGroup({ id: "g1", inScope: false })],
      targets: [
        makeTarget({ id: "t1", groupId: "g1", inScope: false }),
      ],
    });
    const curr = makeDetail({
      targetGroups: [makeGroup({ id: "g1", inScope: true })],
      targets: [makeTarget({ id: "t1", groupId: "g1", inScope: true })],
    });
    const diff = diffBriefDocuments(prev, curr, IDS);
    expect(diff.moved_in_scope).toBe(1);
    expect(diff.moved_out_of_scope).toBe(0);
    // Same keyed target — a move, never an add/remove.
    expect(diff.added_targets).toBe(0);
    expect(diff.removed_targets).toBe(0);
    // 0.10·(1/3)
    expect(opportunityChangeScore(diff)).toBe(0.0333);
  });

  it("counts a target relisted into an in-scope group as moved_in_scope", () => {
    const groups = [inGroup, outGroup];
    const prev = makeDetail({
      targetGroups: groups,
      targets: [
        makeTarget({ id: "t1", groupId: "g-out", inScope: false }),
      ],
    });
    const curr = makeDetail({
      targetGroups: groups,
      targets: [makeTarget({ id: "t1", groupId: "g-in", inScope: true })],
    });
    const diff = diffBriefDocuments(prev, curr, IDS);
    expect(diff.moved_in_scope).toBe(1);
    expect(diff.added_targets).toBe(0);
    expect(diff.added_groups).toBe(0);
  });

  it("counts moved_out_of_scope symmetrically and never scores it", () => {
    const prev = makeDetail({
      targetGroups: [inGroup, outGroup],
      targets: [makeTarget({ id: "t1", groupId: "g-in", inScope: true })],
    });
    const curr = makeDetail({
      targetGroups: [inGroup, outGroup],
      targets: [
        makeTarget({ id: "t1", groupId: "g-out", inScope: false }),
      ],
    });
    const diff = diffBriefDocuments(prev, curr, IDS);
    expect(diff.moved_out_of_scope).toBe(1);
    expect(diff.moved_in_scope).toBe(0);
    expect(opportunityChangeScore(diff)).toBe(0);
  });

  it("falls back to the location|name|category composite when id is empty", () => {
    const prev = makeDetail({
      targetGroups: [inGroup],
      targets: [
        makeTarget({
          id: "",
          groupId: "g-in",
          inScope: true,
          location: "https://a.example.com",
          name: "A",
          category: "website",
        }),
      ],
    });
    // Same composite identity → no delta.
    const same = diffBriefDocuments(prev, { ...prev }, IDS);
    expect(same.added_targets).toBe(0);
    expect(same.removed_targets).toBe(0);
    // Different location → old key removed, new key added.
    const changed = diffBriefDocuments(
      prev,
      makeDetail({
        targetGroups: [inGroup],
        targets: [
          makeTarget({
            id: "",
            groupId: "g-in",
            inScope: true,
            location: "https://renamed.example.com",
            name: "A",
            category: "website",
          }),
        ],
      }),
      IDS,
    );
    expect(changed.added_targets).toBe(1);
    expect(changed.removed_targets).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// diffBriefDocuments — surface classification, groups, rewards, flags
// ---------------------------------------------------------------------------

describe("diffBriefDocuments — classification and group facts", () => {
  const inGroup = makeGroup({ id: "g-in", name: "In Scope", inScope: true });
  const base = makeDetail({ targetGroups: [inGroup] });

  it("scores an added API target higher than an added web target", () => {
    const apiDiff = diffBriefDocuments(
      base,
      makeDetail({
        targetGroups: [inGroup],
        targets: [
          makeTarget({
            id: "t-api",
            groupId: "g-in",
            inScope: true,
            location: "https://api.example.com/v1",
            name: "Public API",
            category: "api",
          }),
        ],
      }),
      IDS,
    );
    const webDiff = diffBriefDocuments(
      base,
      makeDetail({
        targetGroups: [inGroup],
        targets: [
          makeTarget({
            id: "t-web",
            groupId: "g-in",
            inScope: true,
            location: "https://www.example.com",
            category: "website",
          }),
        ],
      }),
      IDS,
    );
    expect(apiDiff.added_api_targets).toBe(1);
    expect(apiDiff.added_web_targets).toBe(0);
    expect(webDiff.added_api_targets).toBe(0);
    expect(webDiff.added_web_targets).toBe(1);
    // api: 0.35·(1/4) + 0.30·(1/3) = 0.1875; web: 0.0875.
    expect(opportunityChangeScore(apiDiff)).toBe(0.1875);
    expect(opportunityChangeScore(webDiff)).toBe(0.0875);
    expect(opportunityChangeScore(apiDiff)!).toBeGreaterThan(
      opportunityChangeScore(webDiff)!,
    );
  });

  it("counts only NEW in-scope groups in added_groups", () => {
    const diff = diffBriefDocuments(
      base,
      makeDetail({
        targetGroups: [
          inGroup,
          makeGroup({ id: "g-new", name: "New", inScope: true }),
          makeGroup({ id: "g-new-out", name: "New Out", inScope: false }),
        ],
      }),
      IDS,
    );
    expect(diff.added_groups).toBe(1);
  });

  it("matches groups by name fallback when id is empty", () => {
    const named = makeGroup({ id: "", name: "Web Assets", inScope: true });
    const prev = makeDetail({ targetGroups: [named] });
    const curr = makeDetail({
      targetGroups: [named, makeGroup({ id: "", name: "APIs", inScope: true })],
    });
    const diff = diffBriefDocuments(prev, curr, IDS);
    expect(diff.added_groups).toBe(1);
  });
});

describe("diffBriefDocuments — rewards, safe harbor, status", () => {
  const g = (p1: number | null) =>
    makeGroup({
      id: "g1",
      inScope: true,
      rewards: { p1, p2: null, p3: null, p4: null, p5: null },
    });

  it("flags reward_increase on a strictly-greater shared in-scope tier", () => {
    const diff = diffBriefDocuments(
      makeDetail({ targetGroups: [g(1000)] }),
      makeDetail({ targetGroups: [g(2000)] }),
      IDS,
    );
    expect(diff.reward_increase).toBe(true);
    expect(diff.reward_decrease).toBe(false);
    expect(diff.only_administrative_changes).toBe(false);
    // Flat 0.15 contribution.
    expect(opportunityChangeScore(diff)).toBe(0.15);
  });

  it("flags reward_decrease without any positive score effect", () => {
    const diff = diffBriefDocuments(
      makeDetail({ targetGroups: [g(2000)] }),
      makeDetail({ targetGroups: [g(500)] }),
      IDS,
    );
    expect(diff.reward_decrease).toBe(true);
    expect(diff.reward_increase).toBe(false);
    expect(diff.only_administrative_changes).toBe(false);
    expect(opportunityChangeScore(diff)).toBe(0);
  });

  it("treats null→x and x→null tiers as data gaps, not changes", () => {
    const appeared = diffBriefDocuments(
      makeDetail({ targetGroups: [g(null)] }),
      makeDetail({ targetGroups: [g(500)] }),
      IDS,
    );
    expect(appeared.reward_increase).toBe(false);
    expect(appeared.reward_decrease).toBe(false);
    const vanished = diffBriefDocuments(
      makeDetail({ targetGroups: [g(500)] }),
      makeDetail({ targetGroups: [g(null)] }),
      IDS,
    );
    expect(vanished.reward_increase).toBe(false);
    expect(vanished.reward_decrease).toBe(false);
  });

  it("ignores reward deltas on groups that are out-of-scope now", () => {
    const out = (p1: number) =>
      makeGroup({
        id: "g1",
        inScope: false,
        rewards: { p1, p2: null, p3: null, p4: null, p5: null },
      });
    const diff = diffBriefDocuments(
      makeDetail({ targetGroups: [out(100)] }),
      makeDetail({ targetGroups: [out(9999)] }),
      IDS,
    );
    expect(diff.reward_increase).toBe(false);
    expect(diff.reward_decrease).toBe(false);
  });

  it("flags safe_harbor_changed and status_changed on field differences", () => {
    const diff = diffBriefDocuments(
      makeDetail({
        targetGroups: [g(100)],
        safeHarborLevel: "full",
        lifecycleStatus: "In progress",
      }),
      makeDetail({
        targetGroups: [g(100)],
        safeHarborLevel: "partial",
        lifecycleStatus: "Paused",
      }),
      IDS,
    );
    expect(diff.safe_harbor_changed).toBe(true);
    expect(diff.status_changed).toBe(true);
    // Flags inform the UI; they add no opportunity score on their own.
    expect(opportunityChangeScore(diff)).toBe(0);
  });

  it("treats a null→value safe-harbor appearance as a change, null↔null as none", () => {
    const appeared = diffBriefDocuments(
      makeDetail({ safeHarborLevel: null }),
      makeDetail({ safeHarborLevel: "full" }),
      IDS,
    );
    expect(appeared.safe_harbor_changed).toBe(true);
    const bothNull = diffBriefDocuments(
      makeDetail({ safeHarborLevel: null }),
      makeDetail({ safeHarborLevel: null }),
      IDS,
    );
    expect(bothNull.safe_harbor_changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diffBriefDocuments — non-complete statuses
// ---------------------------------------------------------------------------

describe("diffBriefDocuments — no baseline / unavailable", () => {
  it("prev null → no_baseline: every fact null, to_version set", () => {
    const diff = diffBriefDocuments(null, makeDetail(), {
      from_version: "v-prev",
      to_version: "v-curr",
    });
    expect(radarSemanticDiffSchema.safeParse(diff).success).toBe(true);
    expect(diff.status).toBe("no_baseline");
    // Nothing was diffed — from_version is honestly null.
    expect(diff.from_version).toBeNull();
    expect(diff.to_version).toBe("v-curr");
    for (const k of COUNTER_KEYS) expect(diff[k]).toBeNull();
    for (const k of FLAG_KEYS) expect(diff[k]).toBeNull();
    expect(diff.only_administrative_changes).toBeNull();
    expect(opportunityChangeScore(diff)).toBeNull();
  });

  it("structurally broken inputs → unavailable with null facts", () => {
    const broken = {
      ...makeDetail(),
      targets: "oops",
    } as unknown as ApiEngagementData;
    const diff = diffBriefDocuments(makeDetail(), broken, IDS);
    expect(radarSemanticDiffSchema.safeParse(diff).success).toBe(true);
    expect(diff.status).toBe("unavailable");
    expect(diff.from_version).toBe("v-prev");
    expect(diff.to_version).toBe("v-curr");
    for (const k of COUNTER_KEYS) expect(diff[k]).toBeNull();
    expect(opportunityChangeScore(diff)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// opportunityChangeScore — shape of the curve
// ---------------------------------------------------------------------------

describe("opportunityChangeScore", () => {
  it("is monotone nondecreasing in added in-scope targets", () => {
    const inGroup = makeGroup({ id: "g", inScope: true });
    const scores = [0, 1, 2, 5, 20].map((n) =>
      opportunityChangeScore(
        diffBriefDocuments(
          makeDetail({ targetGroups: [inGroup] }),
          makeDetail({
            targetGroups: [inGroup],
            targets: Array.from({ length: n }, (_, i) =>
              makeTarget({ id: `t${i}`, groupId: "g", inScope: true }),
            ),
          }),
          IDS,
        ),
      ),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
    expect(scores[0]).toBe(0);
    for (const s of scores) {
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// parseChangelogList
// ---------------------------------------------------------------------------

describe("parseChangelogList", () => {
  it("parses the live-captured webdotcom list", () => {
    const entries = parseChangelogList(changelogList);
    expect(entries).toHaveLength(24);
    expect(entries[0]).toEqual({
      id: "cdf0a5a7-3e14-4bd2-8997-a9567e0bb63e",
      publishedAt: "2026-09-11T15:03:27.462Z",
      tags: ["brief"],
      state: "Latest",
      publishedBy: "bugcrowd",
    });
    // Comma-separated tags split in given order; null state stays null.
    expect(entries[1]!.tags).toEqual(["targets", "brief"]);
    expect(entries[8]!.tags).toEqual(["brief", "targets"]);
    expect(entries[1]!.state).toBeNull();
  });

  it("parses a page-2 shaped envelope incl. null and empty tags", () => {
    // Synthetic continuation page — shape sample, not a live capture.
    const entries = parseChangelogList(changelogPage2);
    expect(entries).toHaveLength(10);
    expect(entries.every((e) => e.state === null)).toBe(true);
    expect(entries[7]!.tags).toEqual([]); // tags: null
    expect(entries[8]!.tags).toEqual([]); // tags: ""
  });

  it("throws invalid_response on non-object or missing/array-less changelogs", () => {
    for (const raw of [
      null,
      undefined,
      "x",
      42,
      [],
      {},
      { changelogs: "nope" },
      { changelogs: {} },
      { changelogs: null },
    ]) {
      expect(() => parseChangelogList(raw)).toThrow(ApiError);
      try {
        parseChangelogList(raw);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).kind).toBe("invalid_response");
      }
    }
  });

  it("returns an empty list for an empty changelogs array", () => {
    expect(parseChangelogList({ changelogs: [] })).toEqual([]);
  });

  it("skips entries without a string id, keeps the rest", () => {
    const entries = parseChangelogList({
      changelogs: [
        { id: 7, publishedAt: "x" },
        "junk",
        null,
        { publishedAt: "x" },
        { id: "", publishedAt: "x" },
        {
          id: "ok",
          publishedAt: "2026-01-01T00:00:00Z",
          tags: " targets , brief ",
          changelogState: "Latest",
          publishedBy: "customer",
        },
        { id: "ok2" },
      ],
    });
    expect(entries.map((e) => e.id)).toEqual(["ok", "ok2"]);
    expect(entries[0]!.tags).toEqual(["targets", "brief"]);
    expect(entries[0]!.state).toBe("Latest");
    expect(entries[0]!.publishedBy).toBe("customer");
    // Missing optional fields stay null/[] — never fabricated.
    expect(entries[1]!).toEqual({
      id: "ok2",
      publishedAt: null,
      tags: [],
      state: null,
      publishedBy: null,
    });
  });
});

// ---------------------------------------------------------------------------
// selectDiffBaseline
// ---------------------------------------------------------------------------

describe("selectDiffBaseline", () => {
  const entries = parseChangelogList(changelogList);

  it("returns the immediate predecessor of the Latest entry in list order", () => {
    expect(
      selectDiffBaseline(entries, "cdf0a5a7-3e14-4bd2-8997-a9567e0bb63e"),
    ).toBe("3f5d9ee5-4636-442f-a608-4b1457a92f23");
  });

  it("returns the next entry for any mid-list latest", () => {
    expect(selectDiffBaseline(entries, entries[5]!.id)).toBe(entries[6]!.id);
  });

  it("returns null when Latest is the oldest entry (no earlier version)", () => {
    const last = entries[entries.length - 1]!;
    expect(selectDiffBaseline(entries, last.id)).toBeNull();
  });

  it("falls back to the head's predecessor when latestId is null", () => {
    expect(selectDiffBaseline(entries, null)).toBe(entries[1]!.id);
    expect(selectDiffBaseline(entries, "")).toBe(entries[1]!.id);
  });

  it("returns null when an asserted latestId is absent from the list", () => {
    expect(selectDiffBaseline(entries, "not-in-this-list")).toBeNull();
  });

  it("returns null for single-entry and empty histories", () => {
    expect(selectDiffBaseline([entry({ id: "only" })], "only")).toBeNull();
    expect(selectDiffBaseline([entry({ id: "only" })], null)).toBeNull();
    expect(selectDiffBaseline([], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// entryTouchesTargets
// ---------------------------------------------------------------------------

describe("entryTouchesTargets", () => {
  it("is true only when the parsed tag list contains 'targets'", () => {
    expect(entryTouchesTargets(entry({ tags: ["targets", "brief"] }))).toBe(
      true,
    );
    expect(entryTouchesTargets(entry({ tags: ["brief", "targets"] }))).toBe(
      true,
    );
    expect(entryTouchesTargets(entry({ tags: ["targets"] }))).toBe(true);
    expect(entryTouchesTargets(entry({ tags: ["brief"] }))).toBe(false);
    expect(entryTouchesTargets(entry({ tags: ["migration"] }))).toBe(false);
    expect(entryTouchesTargets(entry({ tags: [] }))).toBe(false);
  });
});
