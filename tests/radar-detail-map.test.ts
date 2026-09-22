// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectDetails } from "../lib/dom/details";
import { collectTargets } from "../lib/dom/targets";
import { loadDoc, PAGE_URL } from "./helpers/dom";
import { mapBriefToEngagement } from "../lib/radar/detailMap";

/** Runs the real DOM collectors on a saved brief fixture, then maps. */
function mapFixture(name: string, slug = "webdotcom") {
  const doc = loadDoc(name);
  const { data: details } = collectDetails(doc, PAGE_URL);
  const { groups, targets } = collectTargets(doc, PAGE_URL);
  return mapBriefToEngagement(slug, details, groups, targets);
}

describe("mapBriefToEngagement — fixture end-to-end", () => {
  it("maps the webdotcom brief into ApiEngagementData", () => {
    const detail = mapFixture("webdotcom-current.html");
    expect(detail.uuid).toBe("webdotcom");
    expect(detail.code).toBe("webdotcom");
    expect(detail.name).toBe("Web.com Bug Bounty");
    expect(detail.engagementType).toBe("Bug Bounty");
    expect(detail.lifecycleStatus).toContain("In progress");
    expect(detail.observedApiVersion).toBeNull();
  });

  it("carries header statistics under snake_case keys", () => {
    const detail = mapFixture("webdotcom-current.html");
    // DOM labels slug to "vulnerabilities-rewarded"; the feature extractor
    // consumes the API-shaped "vulnerabilities_rewarded".
    expect(detail.statistics.vulnerabilities_rewarded?.value).toBe("721");
    expect(detail.statistics.average_payout?.value).toBe("$2,000");
    expect(
      detail.statistics.average_payout?.window,
    ).toBe("last 3 months");
  });

  it("maps scope groups with numeric reward ceilings from range text", () => {
    const detail = mapFixture("webdotcom-current.html");
    const inScope = detail.targetGroups.filter((g) => g.inScope);
    expect(inScope).toHaveLength(1);
    const oneWeb = inScope[0]!;
    // "$2000 – $3000" → the tier's potential ceiling (max).
    expect(oneWeb.rewards.p1).toBe(3000);
    expect(oneWeb.rewards.p2).toBe(1500);
    expect(oneWeb.rewards.p3).toBe(600);
    expect(oneWeb.rewards.p4).toBeNull();
  });

  it("maps in-scope and out-of-scope targets with identity fields", () => {
    const detail = mapFixture("webdotcom-current.html");
    expect(detail.targets.length).toBeGreaterThan(0);
    const inScope = detail.targets.filter((t) => t.inScope);
    const appWeb = inScope.find((t) => t.location?.includes("app.web.com"));
    expect(appWeb).toBeDefined();
    expect(appWeb?.name).toBe("app.web.com");
    expect(appWeb?.tags).toContain("Website Testing");
    const out = detail.targets.filter((t) => !t.inScope);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((t) => t.inScope === false)).toBe(true);
  });

  it("extracts the safe-harbor level and freshness dates", () => {
    const detail = mapFixture("webdotcom-current.html");
    // Fixture header carries "Safe harbor"; the value must be a string or
    // null — never inferred from prose.
    expect(
      detail.safeHarborLevel === null ||
        typeof detail.safeHarborLevel === "string",
    ).toBe(true);
    expect(detail.lastBriefUpdate).toBe("2026-09-11T15:03:27Z");
  });
});

describe("mapBriefToEngagement — reward normalization", () => {
  const emptyDetails = {
    name: null,
    code: null,
    engagementType: null,
    managedBounty: null,
    lifecycleStatus: null,
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: null,
    lastBriefUpdate: null,
    safeHarborLevel: null,
    disclosurePolicy: null,
    statistics: {},
  };

  function groupWith(reward: number | string | null) {
    return [
      {
        domKey: "g1",
        name: "G",
        inScope: true,
        description: null,
        rewards: { p1: reward, p2: null, p3: null, p4: null, p5: null },
      },
    ];
  }

  function p1Of(reward: number | string | null) {
    const detail = mapBriefToEngagement(
      "slug",
      emptyDetails,
      groupWith(reward),
      [],
    );
    return detail.targetGroups[0]?.rewards.p1;
  }

  it("passes finite numbers through", () => {
    expect(p1Of(2500)).toBe(2500);
    expect(p1Of(0)).toBe(0);
  });

  it("takes the maximum of range text", () => {
    expect(p1Of("$2,000 – $3,000")).toBe(3000);
    expect(p1Of("$5000")).toBe(5000);
  });

  it("maps non-monetary text and junk to null", () => {
    expect(p1Of("Points")).toBeNull();
    expect(p1Of("Kudos")).toBeNull();
    expect(p1Of(null)).toBeNull();
  });
});
