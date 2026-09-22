import { describe, expect, it } from "vitest";
import { extractProgramFeatures } from "../lib/radar/features";
import { RADAR_PROFILES } from "../lib/radar/profiles";
import { rankPrograms, scoreProgram } from "../lib/radar/scoring";
import type { RadarProgramSnapshot } from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";

// ---------------------------------------------------------------------------
// Agent E — fixture-invariant guard for the V1.3.1 adversarial catalogs.
//
// tests/radar-v131-stabilization.test.ts depends on crafted details producing
// DISJOINT per-profile leaders (the profile-selection-bias scenario). If the
// ranking internals ever drift, this contract-ready test fails cleanly here —
// instead of leaving the integration-gated tests red for the wrong reason.
//
// The table mirrors UNION_DETAILS in radar-v131-stabilization.test.ts — keep
// the two in sync when tuning fixtures.
// ---------------------------------------------------------------------------

const T0 = "2026-09-21T00:00:00.000Z";
const RECENT = "2026-09-20T00:00:00.000Z"; // 1d → freshness 1.0
const MID = "2026-06-23T00:00:00.000Z"; // 90d → freshness 0.6
const STALE = "2025-01-01T00:00:00.000Z"; // >180d → freshness 0.15

interface DetailOpts {
  p1?: number | null;
  lastBriefUpdate?: string;
  researchers?: string;
  submissions?: string;
  rewarded?: string;
  apiTargets?: number;
  webTargets?: number;
}

function detail(uuid: string, o: DetailOpts = {}): ApiEngagementData {
  const stats: Record<string, { value: string; window: string | null }> = {};
  if (o.researchers !== undefined)
    stats.researchers_participating = { value: o.researchers, window: "all_time" };
  if (o.submissions !== undefined)
    stats.valid_submission_count = { value: o.submissions, window: "all_time" };
  if (o.rewarded !== undefined)
    stats.vulnerabilities_rewarded = { value: o.rewarded, window: "90d" };
  const targets = [];
  for (let i = 0; i < (o.apiTargets ?? 0); i++) {
    targets.push({
      id: `t-${uuid}-a${i}`,
      groupId: `g-${uuid}`,
      location: null,
      name: `api-${i}`,
      category: "api",
      tags: [],
      inScope: true,
    });
  }
  for (let i = 0; i < (o.webTargets ?? 0); i++) {
    targets.push({
      id: `t-${uuid}-w${i}`,
      groupId: `g-${uuid}`,
      location: `https://w${i}.example.com`,
      name: `web-${i}`,
      category: "website",
      tags: [],
      inScope: true,
    });
  }
  return {
    uuid,
    name: `Program ${uuid}`,
    code: uuid,
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: "2020-01-01T00:00:00.000Z",
    lastBriefUpdate: o.lastBriefUpdate ?? T0,
    safeHarborLevel: "full",
    statistics: stats,
    targetGroups: [
      {
        id: `g-${uuid}`,
        name: "Scope",
        inScope: true,
        description: null,
        rewards: {
          p1: o.p1 === undefined ? 5000 : o.p1,
          p2: null,
          p3: null,
          p4: null,
          p5: null,
        },
      },
    ],
    targets,
    observedApiVersion: "v1",
  };
}

function snap(uuid: string, o: DetailOpts = {}): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid,
    code: uuid,
    catalog: {
      uuid,
      code: uuid,
      name: `Program ${uuid}`,
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: T0,
    },
    detail: detail(uuid, o),
    enrichment: { status: "complete" },
    source_hash: `sha256:${"ab".repeat(32)}`,
  };
}

/** The UNION_DETAILS table from radar-v131-stabilization.test.ts. */
const UNION_DETAILS: Record<string, DetailOpts> = {
  ev1: { p1: 30000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  ev2: { p1: 28000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  fp1: { p1: 5000, lastBriefUpdate: RECENT, researchers: "300", submissions: "300", rewarded: "150", apiTargets: 1, webTargets: 2 },
  fp2: { p1: 4900, lastBriefUpdate: RECENT, researchers: "300", submissions: "300", rewarded: "150", apiTargets: 1, webTargets: 2 },
  lc1: { p1: 4000, lastBriefUpdate: MID, researchers: "0", submissions: "0", rewarded: "0", apiTargets: 1, webTargets: 2 },
  lc2: { p1: 3900, lastBriefUpdate: MID, researchers: "0", submissions: "0", rewarded: "0", apiTargets: 1, webTargets: 2 },
  aa1: { p1: 5500, lastBriefUpdate: MID, researchers: "500", submissions: "500", rewarded: "200", apiTargets: 8, webTargets: 1 },
  aa2: { p1: 5400, lastBriefUpdate: MID, researchers: "500", submissions: "500", rewarded: "200", apiTargets: 7, webTargets: 1 },
  bf1: { p1: 20000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf2: { p1: 19000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf3: { p1: 18000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf4: { p1: 17000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf5: { p1: 16000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bf6: { p1: 15000, lastBriefUpdate: MID, researchers: "100", submissions: "100", rewarded: "50", apiTargets: 1, webTargets: 2 },
  bt1: { p1: 100, lastBriefUpdate: STALE, researchers: "5000", submissions: "5000", rewarded: "900", apiTargets: 0, webTargets: 1 },
  bt2: { p1: 100, lastBriefUpdate: STALE, researchers: "5000", submissions: "5000", rewarded: "900", apiTargets: 0, webTargets: 1 },
};

const UNION_UUIDS = ["ev1", "ev2", "fp1", "fp2", "lc1", "lc2", "aa1", "aa2"];
const BLOCKER_UUIDS = ["bf1", "bf2", "bf3", "bf4", "bf5", "bf6"];

function orderFor(
  defs: Record<string, DetailOpts>,
  pid: keyof typeof RADAR_PROFILES,
): string[] {
  const profile = RADAR_PROFILES[pid];
  const snaps = Object.entries(defs).map(([u, o]) => snap(u, o));
  return rankPrograms(
    snaps.map((s) => scoreProgram(s, extractProgramFeatures(s, T0), profile)),
    profile,
  )
    .filter((r) => r.eligible)
    .map((r) => r.score.engagement_uuid);
}

describe("fixture invariants: disjoint-leaders catalog", () => {
  it("each deep profile's top-2 is its own specialist pair", () => {
    expect(orderFor(UNION_DETAILS, "best_ev").slice(0, 2)).toEqual([
      "ev1",
      "ev2",
    ]);
    expect(orderFor(UNION_DETAILS, "fresh_programs").slice(0, 2)).toEqual([
      "fp1",
      "fp2",
    ]);
    expect(
      orderFor(UNION_DETAILS, "low_competition").slice(0, 2),
    ).toEqual(["lc1", "lc2"]);
    expect(orderFor(UNION_DETAILS, "authz_api").slice(0, 2)).toEqual([
      "aa1",
      "aa2",
    ]);
  });

  it("the specialists sit below best_ev's top-8 (the bias the union must fix)", () => {
    const bestEv = orderFor(UNION_DETAILS, "best_ev");
    // Old shortlist = best_ev top-8 = {ev1, ev2, bf1..bf6} — no specialist.
    expect(bestEv.slice(0, 8).sort()).toEqual(
      ["ev1", "ev2", ...BLOCKER_UUIDS].sort(),
    );
    for (const specialist of ["fp1", "fp2", "lc1", "lc2", "aa1", "aa2"]) {
      expect(bestEv.indexOf(specialist)).toBeGreaterThanOrEqual(8);
    }
  });

  it("every profile's top-1 (the UNION_KNOBS frontier) is a union member", () => {
    for (const [pid, leader] of [
      ["best_ev", "ev1"],
      ["fresh_programs", "fp1"],
      ["low_competition", "lc1"],
      ["authz_api", "aa1"],
    ] as const) {
      expect(orderFor(UNION_DETAILS, pid)[0]).toBe(leader);
    }
    // Sanity: the union is exactly the 8 specialists+leaders, dedup'd.
    expect(UNION_UUIDS.length).toBe(8);
  });
});

describe("fixture invariants: rerank catalog", () => {
  // Mirrors the x-catalog in the iterative-deepening test: uniform dims,
  // descending reward → every deep profile agrees on x1>x2>x3>x4>x5.
  const X_DETAILS: Record<string, DetailOpts> = {
    x1: { p1: 20000, lastBriefUpdate: MID, researchers: "200", submissions: "200", rewarded: "100", apiTargets: 1, webTargets: 2 },
    x2: { p1: 16000, lastBriefUpdate: MID, researchers: "200", submissions: "200", rewarded: "100", apiTargets: 1, webTargets: 2 },
    x3: { p1: 12000, lastBriefUpdate: MID, researchers: "200", submissions: "200", rewarded: "100", apiTargets: 1, webTargets: 2 },
    x4: { p1: 8000, lastBriefUpdate: MID, researchers: "200", submissions: "200", rewarded: "100", apiTargets: 1, webTargets: 2 },
    x5: { p1: 4000, lastBriefUpdate: MID, researchers: "200", submissions: "200", rewarded: "100", apiTargets: 1, webTargets: 2 },
  };

  it("all deep profiles rank x1..x5 identically (union={x1,x2}, frontier top-3={x1,x2,x3})", () => {
    for (const pid of [
      "best_ev",
      "fresh_programs",
      "low_competition",
      "authz_api",
    ] as const) {
      expect(orderFor(X_DETAILS, pid)).toEqual(["x1", "x2", "x3", "x4", "x5"]);
    }
  });
});
