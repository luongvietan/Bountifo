import { describe, expect, it } from "vitest";
import { mapBriefDocument } from "../lib/radar/detailMap";
import changelogList from "./fixtures/radar/site/webdotcom-changelog.json";
import briefDoc from "./fixtures/radar/site/webdotcom-brief-doc.json";
import stats from "./fixtures/radar/site/webdotcom-statistics.json";

// Fixtures are live captures from bugcrowd.com/engagements/webdotcom —
// changelog version list, the "Latest" changelog document, and the
// statistics endpoint. They exercise the mapper against the real payload
// shape, not a hand-rolled approximation.

describe("mapBriefDocument — live-shaped changelog doc", () => {
  const detail = mapBriefDocument("webdotcom", briefDoc, stats);

  it("maps identity from the slug and engagement metadata", () => {
    expect(detail.uuid).toBe("webdotcom");
    expect(detail.code).toBe("webdotcom");
    expect(detail.name).toBe("Web.com Bug Bounty");
    expect(detail.engagementType).toBe("Bug Bounty");
    expect(detail.observedApiVersion).toBe(
      "cdf0a5a7-3e14-4bd2-8997-a9567e0bb63e",
    );
  });

  it("maps lifecycle fields", () => {
    expect(detail.lifecycleStatus).toBe("In progress");
    expect(detail.testingStart).toBe("2017-04-13T19:00:00Z");
    expect(detail.testingEnd).toBeNull();
    expect(detail.lastStatusTransition).toBe("2017-04-13T19:00:00.000Z");
    expect(detail.lastBriefUpdate).toBe("2026-09-11T15:03:27.462Z");
  });

  it("maps safe harbor status", () => {
    expect(detail.safeHarborLevel).toBe("full");
  });

  it("maps statistics into snake_case keys consumed by features", () => {
    expect(detail.statistics.vulnerabilities_rewarded?.value).toBe("721");
    expect(detail.statistics.average_payout?.value).toBe("$2,000");
    expect(detail.statistics.validation_within?.value).toBe("12 days");
    // The site surface has no participant-count field — absent, not zero.
    expect(detail.statistics.researchers_participating).toBeUndefined();
  });

  it("maps scope groups with cent-denominated reward ceilings in dollars", () => {
    const inScope = detail.targetGroups.find((g) => g.inScope);
    expect(inScope).toBeDefined();
    expect(inScope!.rewards.p1).toBe(3000);
    expect(inScope!.rewards.p2).toBe(1500);
    expect(inScope!.rewards.p3).toBe(600);
    // Tiers absent in the range object stay null, not zero.
    expect(inScope!.rewards.p4).toBeNull();
    expect(inScope!.rewards.p5).toBeNull();
  });

  it("maps targets with uri/category/tags and group linkage", () => {
    expect(detail.targets.length).toBeGreaterThan(0);
    const t = detail.targets[0]!;
    expect(t.id).toBeTruthy();
    expect(t.inScope).toBe(true);
    expect(t.groupId).toBe(detail.targetGroups.find((g) => g.inScope)!.id);
    const web = detail.targets.find((x) => x.category === "website");
    expect(web?.location).toBe("https://app.web.com");
    expect(web?.tags).toContain("Website Testing");
  });

  it("keeps out-of-scope groups and their targets flagged false", () => {
    const outGroup = detail.targetGroups.find((g) => !g.inScope);
    expect(outGroup).toBeDefined();
    for (const t of detail.targets.filter((x) => x.groupId === outGroup!.id)) {
      expect(t.inScope).toBe(false);
    }
  });
});

describe("mapBriefDocument — degenerate inputs", () => {
  it("throws on a doc without the data payload", () => {
    expect(() => mapBriefDocument("x", { id: "v1" }, null)).toThrow();
  });

  it("throws when data.scope is not an array", () => {
    expect(() =>
      mapBriefDocument("x", { data: { brief: {}, scope: {} } }, null),
    ).toThrow();
  });

  it("produces empty statistics when the stats payload is absent", () => {
    const detail = mapBriefDocument("webdotcom", briefDoc, null);
    expect(detail.statistics).toEqual({});
    expect(detail.targetGroups.length).toBeGreaterThan(0);
  });

  it("tolerates groups with missing reward ranges and empty targets", () => {
    const doc = {
      id: "v2",
      publishedAt: "2026-01-01T00:00:00Z",
      data: {
        brief: { name: "Minimal" },
        engagement: { code: "x" },
        scope: [{ id: "g1", name: "Scope", inScope: true, targets: [] }],
      },
    };
    const detail = mapBriefDocument("x", doc, null);
    expect(detail.targetGroups[0]!.rewards).toEqual({
      p1: null,
      p2: null,
      p3: null,
      p4: null,
      p5: null,
    });
    expect(detail.targets).toEqual([]);
    expect(detail.name).toBe("Minimal");
  });

  it("ignores non-numeric stats fields without inventing values", () => {
    const detail = mapBriefDocument("webdotcom", briefDoc, {
      rewardedVulnerabilities: "oops",
      averagePayout: null,
    });
    expect(detail.statistics.vulnerabilities_rewarded).toBeUndefined();
    expect(detail.statistics.average_payout).toBeUndefined();
  });
});

describe("changelog version selection", () => {
  it("fixture exposes a Latest-tagged entry for the doc fetch", () => {
    const latest = changelogList.changelogs.find(
      (c) => c.changelogState === "Latest",
    );
    expect(latest?.id).toBe("cdf0a5a7-3e14-4bd2-8997-a9567e0bb63e");
  });
});
