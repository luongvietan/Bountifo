import { describe, expect, it } from "vitest";
import { radarSourceHash } from "../lib/radar/hash";
import type { ApiEngagementData } from "../lib/types";
import type { RadarCatalogItem } from "../lib/radar/types";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function catalog(overrides: Partial<RadarCatalogItem> = {}): RadarCatalogItem {
  return {
    uuid: "uuid-1",
    code: "acme",
    name: "Acme",
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "uuid-1",
    name: "Acme",
    code: "acme",
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: "2026-01-01T00:00:00.000Z",
    testingEnd: null,
    testingPeriodLabel: "ongoing",
    lastStatusTransition: "2026-06-01T00:00:00.000Z",
    lastBriefUpdate: "2026-09-01T00:00:00.000Z",
    safeHarborLevel: "full",
    statistics: {
      submissions: { value: "42", window: null },
      avg_payout: { value: "500", window: "90d" },
    },
    targetGroups: [
      {
        id: "g1",
        name: "Web",
        inScope: true,
        description: "web assets",
        rewards: { p1: 50, p2: 200, p3: 500, p4: null, p5: null },
      },
      {
        id: "g2",
        name: "API",
        inScope: true,
        description: null,
        rewards: { p1: 100, p2: null, p3: null, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: "t1",
        groupId: "g1",
        location: "https://a.example.com",
        name: "A",
        category: "api",
        tags: ["b", "a"],
        inScope: false,
      },
      {
        id: "t2",
        groupId: "g1",
        location: "https://b.example.com",
        name: "B",
        category: "website",
        tags: ["prod", "xss"],
        inScope: true,
      },
    ],
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: "2026-09-01",
    ...overrides,
  };
}

describe("radarSourceHash", () => {
  it("returns sha256:+64hex and is deterministic for identical input", async () => {
    const input = { catalog: catalog(), detail: detail() };
    const a = await radarSourceHash(input);
    const b = await radarSourceHash(input);
    expect(a).toMatch(HASH_RE);
    expect(a).toBe(b);
  });

  it("is independent of targetGroups/targets/tags arrival order", async () => {
    const base = detail();
    const shuffled = detail({
      targetGroups: [...base.targetGroups].reverse(),
      targets: [...base.targets].reverse(),
    });
    shuffled.targets = shuffled.targets.map((t) => ({
      ...t,
      tags: [...t.tags].reverse(),
    }));
    const a = await radarSourceHash({ catalog: catalog(), detail: base });
    const b = await radarSourceHash({ catalog: catalog(), detail: shuffled });
    expect(a).toBe(b);
  });

  it("is independent of statistics key insertion order", async () => {
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    const b = await radarSourceHash({
      catalog: catalog(),
      detail: detail({
        statistics: {
          avg_payout: { value: "500", window: "90d" },
          submissions: { value: "42", window: null },
        },
      }),
    });
    expect(a).toBe(b);
  });

  it("ignores discovered_at and observedApiVersion (volatile fields)", async () => {
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    const b = await radarSourceHash({
      catalog: catalog({ discovered_at: "2026-12-31T23:59:59.999Z" }),
      detail: detail({ observedApiVersion: "2999-01-01" }),
    });
    const c = await radarSourceHash({
      catalog: catalog({ discovered_at: "2020-01-01T00:00:00.000Z" }),
      detail: detail({ observedApiVersion: null }),
    });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("changes when a reward amount changes", async () => {
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    const modified = detail();
    modified.targetGroups = modified.targetGroups.map((g) =>
      g.id === "g1" ? { ...g, rewards: { ...g.rewards, p3: 501 } } : g,
    );
    const b = await radarSourceHash({ catalog: catalog(), detail: modified });
    expect(a).not.toBe(b);
  });

  it("changes when a target changes (location, scope flag, tags)", async () => {
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    for (const targets of [
      detail().targets.map((t) =>
        t.id === "t1" ? { ...t, location: "https://c.example.com" } : t,
      ),
      detail().targets.map((t) =>
        t.id === "t1" ? { ...t, inScope: true } : t,
      ),
      detail().targets.map((t) =>
        t.id === "t2" ? { ...t, tags: [...t.tags, "extra"] } : t,
      ),
    ]) {
      const b = await radarSourceHash({
        catalog: catalog(),
        detail: detail({ targets }),
      });
      expect(a).not.toBe(b);
    }
  });

  it("changes when statistics change", async () => {
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    const b = await radarSourceHash({
      catalog: catalog(),
      detail: detail({
        statistics: {
          ...detail().statistics,
          avg_payout: { value: "501", window: "90d" },
        },
      }),
    });
    expect(a).not.toBe(b);
  });

  it("changes when each research-saturation input changes", async () => {
    // Every raw input feeding submission_activity / rewarded_activity /
    // recent crowding must move the hash — a silent stats change would let a
    // stale saturation score survive a re-scan.
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    for (const key of [
      "valid_submission_count",
      "researchers_participating",
      "vulnerabilities_rewarded",
    ] as const) {
      const b = await radarSourceHash({
        catalog: catalog(),
        detail: detail({
          statistics: {
            ...detail().statistics,
            [key]: { value: "777", window: null },
          },
        }),
      });
      expect(b, `statistics.${key}`).not.toBe(a);
    }
  });

  it("changes when catalog identity fields change", async () => {
    const a = await radarSourceHash({ catalog: catalog(), detail: detail() });
    for (const overrides of [
      { code: "acme-2" },
      { name: "Acme Renamed" },
      { lifecycle_status: "paused" },
      { engagement_type: "vdp" },
    ]) {
      const b = await radarSourceHash({
        catalog: catalog(overrides),
        detail: detail(),
      });
      expect(a).not.toBe(b);
    }
  });

  it("distinguishes a missing detail from a present one", async () => {
    const withDetail = await radarSourceHash({
      catalog: catalog(),
      detail: detail(),
    });
    const without = await radarSourceHash({
      catalog: catalog(),
      detail: null,
    });
    const withoutAgain = await radarSourceHash({
      catalog: catalog(),
      detail: null,
    });
    expect(without).toMatch(HASH_RE);
    expect(without).toBe(withoutAgain);
    expect(withDetail).not.toBe(without);
  });
});
