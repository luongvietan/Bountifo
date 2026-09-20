// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectActivity } from "../lib/dom/activity";
import { collectTargets } from "../lib/dom/targets";
import { loadDoc, PAGE_URL } from "./helpers/dom";

// Nubank's brief puts each feed heading in a title row beside a "View all …"
// link, and its announcement cards carry their own <h3> subheads. Both used to
// defeat scoping: the heading's sibling run was the nav link alone, so the feed
// collapsed to one item whose body was that link.

const doc = loadDoc("nubank-current.html");
const targets = collectTargets(loadDoc("nubank-current.html"), PAGE_URL);
const activity = await collectActivity(doc, PAGE_URL, async () => null);

describe("Nubank feed scoping", () => {
  it("collects the announcement cards, not the section's 'View all' link", () => {
    const bodies = activity.changelog.map((i) => i.body);
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b === "View all announcements")).toBe(false);
    expect(bodies[0]).toContain("The Arraia Bonus Promo is Ending Soon!");
    expect(bodies[1]).toContain("Temporary Promotion");
  });

  it("keeps each card whole instead of splitting its metadata list", () => {
    expect(activity.recentActivity).toHaveLength(2);
    const first = activity.recentActivity[0]!;
    expect(first.body).toContain("prod-*.nubank.com.br");
    expect(first.body).toContain("By bckz");
    expect(first.body).toContain("Priority P1");
  });

  it("titles a card by its own lead line, never by a body subhead", () => {
    // "The Heated Payouts" is an <h3> inside the announcement's body.
    expect(activity.changelog.map((i) => i.title)).toEqual([
      "WaynesWorld announced The Arraia Bonus Promo is Ending Soon!",
      "sanciont announced Temporary Promotion: Arraia dos Bounties!",
    ]);
    // ...and a researcher's profile link is not a title either.
    expect(activity.recentActivity.map((i) => i.title)).toEqual([
      "Submission accepted on target: prod-*.nubank.com.br",
      "Submission accepted on target: *.nubank.com.br",
    ]);
  });

  it("dates each announcement from its own <time>", () => {
    expect(activity.changelog.map((i) => i.timestamp)).toEqual([
      "2026-06-26T16:30:27Z",
      "2026-06-01T14:11:38Z",
    ]);
  });
});

describe("Nubank scope inventory", () => {
  it("names the group card and joins its reward chart", () => {
    expect(targets.groups.map((g) => g.name)).toEqual(["Core Assets"]);
    expect(targets.groups[0]!.rewards.p1).toBe("$2000 – $4000");
    expect(targets.groups[0]!.rewards.p2).toBe("$1000 – $2000");
  });

  it("reads a <code> location and an app target's link", () => {
    expect(targets.targets.map((t) => t.location)).toEqual([
      "https://play.google.com/store/apps/details?id=com.nu.production",
      "prod-*.nubank.com.br",
    ]);
    expect(targets.targets[0]!.name).toBe("Nubank Android: Play Store");
    expect(targets.targets.every((t) => t.inScope)).toBe(true);
  });
});
