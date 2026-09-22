import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractProgramFeatures } from "../lib/radar/features";
import { radarSourceHash } from "../lib/radar/hash";
import { getRadarProfile } from "../lib/radar/profiles";
import { rankPrograms, REASON_TEXT, scoreProgram } from "../lib/radar/scoring";
import {
  programScoreSchema,
  RADAR_PROFILE_IDS,
  radarProgramSnapshotSchema,
} from "../lib/radar/types";
import type {
  ProgramFeatureVector,
  ProgramScore,
  RadarProfileId,
  RadarProgramSnapshot,
} from "../lib/radar/types";

// ---------------------------------------------------------------------------
// Task 19 — scoring regression fixtures.
//
// tests/fixtures/radar/*.json are serialized RadarProgramSnapshots. The test
// loads them through the strict schema, recomputes the baked source_hash, and
// pins the plan's cross-fixture PROFILE RELATIONSHIPS — never arbitrary
// catalog positions:
//
//   high_reward       → high-reward-api > low-reward-low-competition
//   low_competition   → low-reward-low-competition > high-reward-api
//   fresh_programs    → fresh-program > stale-program
//   authz_api         → api-heavy (high-reward-api) > web-only comparators
//   best_ev           → partial-program confidence < complete fixtures
//
// NOW is fixed; fixture dates are built so freshness bands land as intended.
// ---------------------------------------------------------------------------

const NOW = "2026-09-21T00:00:00.000Z";
const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "radar");

const FIXTURE_NAMES = [
  "high-reward-api",
  "low-reward-low-competition",
  "fresh-program",
  "stale-program",
  "partial-program",
  "mixed-target-program",
] as const;
type FixtureName = (typeof FIXTURE_NAMES)[number];

const snapshots = new Map<FixtureName, RadarProgramSnapshot>();
const vectors = new Map<FixtureName, ProgramFeatureVector>();
const scores = new Map<FixtureName, Map<RadarProfileId, ProgramScore>>();

beforeAll(() => {
  for (const name of FIXTURE_NAMES) {
    const raw: unknown = JSON.parse(
      readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"),
    );
    const snapshot = radarProgramSnapshotSchema.parse(raw);
    snapshots.set(name, snapshot);
    const vector = extractProgramFeatures(snapshot, NOW);
    vectors.set(name, vector);
    const perProfile = new Map<RadarProfileId, ProgramScore>();
    for (const id of RADAR_PROFILE_IDS) {
      perProfile.set(
        id,
        scoreProgram(snapshot, vector, getRadarProfile(id)),
      );
    }
    scores.set(name, perProfile);
  }
});

function snap(name: FixtureName): RadarProgramSnapshot {
  const s = snapshots.get(name);
  if (s === undefined) throw new Error(`fixture not loaded: ${name}`);
  return s;
}

function vec(name: FixtureName): ProgramFeatureVector {
  return vectors.get(name)!;
}

function score(name: FixtureName, profile: RadarProfileId): ProgramScore {
  return scores.get(name)!.get(profile)!;
}

describe("radar fixture files", () => {
  it("the fixture directory holds exactly the six required fixtures", () => {
    const onDisk = readdirSync(FIXTURE_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name)
      .sort();
    expect(onDisk).toEqual(
      [...FIXTURE_NAMES].map((n) => `${n}.json`).sort(),
    );
  });

  it.each(FIXTURE_NAMES)(
    "%s validates against radarProgramSnapshotSchema",
    (name) => {
      const raw: unknown = JSON.parse(
        readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"),
      );
      const res = radarProgramSnapshotSchema.safeParse(raw);
      expect(res.success).toBe(true);
    },
  );

  it.each(FIXTURE_NAMES)(
    "%s carries a source_hash equal to radarSourceHash(catalog, detail)",
    async (name) => {
      const s = snap(name);
      const recomputed = await radarSourceHash({
        catalog: s.catalog,
        detail: s.detail,
      });
      // Baked at authoring time — recomputation must reproduce it exactly.
      expect(s.source_hash).toBe(recomputed);
      expect(s.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
  );

  it.each(FIXTURE_NAMES)(
    "%s produces schema-valid scores for every profile",
    (name) => {
      for (const id of RADAR_PROFILE_IDS) {
        const s = score(name, id);
        expect(
          programScoreSchema.safeParse(s).success,
          `profile '${id}' score failed schema validation`,
        ).toBe(true);
        expect(s.source_hash).toBe(snap(name).source_hash);
        expect(s.engagement_uuid).toBe(snap(name).uuid);
      }
    },
  );
});

describe("fixture signal semantics", () => {
  it("high-reward-api is api-heavy with strong P1/P2 rewards", () => {
    const v = vec("high-reward-api");
    expect(v.api_surface.value).toBeCloseTo(4 / 6, 4);
    expect(v.reward_potential.value).not.toBeNull();
    expect(v.reward_potential.value!).toBeGreaterThanOrEqual(0.8);
    expect(v.reward_breadth.value).toBe(1);
    // One deliberately out-of-scope API target must not count: the
    // api_surface denominator is the 6 in-scope targets only.
    const targets = snap("high-reward-api").detail!.targets;
    const outOfScope = targets.filter((t) => !t.inScope);
    expect(outOfScope).toHaveLength(1);
    expect(outOfScope[0]!.category).toBe("api");
    expect(targets.filter((t) => t.inScope)).toHaveLength(6);
  });

  it("low-reward-low-competition is quiet, low-paying, web-only", () => {
    const v = vec("low-reward-low-competition");
    expect(v.researcher_competition.value!).toBeLessThanOrEqual(0.3);
    expect(v.reward_potential.value!).toBeLessThan(0.5);
    expect(v.api_surface.value).toBe(0);
    expect(v.web_surface.value).toBe(1);
  });

  it("fresh vs stale differ only in the freshness band", () => {
    const fresh = vec("fresh-program");
    const stale = vec("stale-program");
    expect(fresh.freshness.value).toBe(1);
    expect(stale.freshness.value).toBe(0.15);
    // Everything else identical — the fixtures isolate the date effect.
    for (const key of Object.keys(fresh) as (keyof typeof fresh)[]) {
      if (key === "freshness" || key === "schema_version") continue;
      expect(stale[key]).toEqual(fresh[key]);
    }
    expect(score("fresh-program", "fresh_programs").reasons).toContain(
      "RECENTLY_UPDATED",
    );
    expect(score("stale-program", "fresh_programs").reasons).toContain(
      "STALE_PROGRAM",
    );
  });

  it("mixed-target spans api + web + mobile + other surfaces", () => {
    const v = vec("mixed-target-program");
    expect(v.api_surface.value).toBe(0.25);
    expect(v.web_surface.value).toBe(0.25);
    // 4 in-scope targets all carrying identity → 4/(4+25).
    expect(v.meaningful_surface.value).toBeCloseTo(4 / 29, 4);
  });

  it("partial-program carries no detail — every detail signal is unknown", () => {
    const s = snap("partial-program");
    expect(s.detail).toBeNull();
    expect(s.enrichment.status).not.toBe("complete");
    const v = vec("partial-program");
    for (const key of [
      "reward_potential",
      "reward_breadth",
      "meaningful_surface",
      "api_surface",
      "api_surface_size",
      "web_surface",
      "researcher_competition",
      "submission_activity",
      "research_saturation",
      "rewarded_activity",
      "freshness",
      "safe_harbor",
      "target_data_quality",
    ] as const) {
      expect(v[key].value).toBeNull();
      expect(v[key].reason_code).toBe("detail_unavailable");
    }
  });
});

describe("profile relationships over fixtures", () => {
  it("high_reward: high-reward-api outranks low-reward-low-competition", () => {
    const hi = score("high-reward-api", "high_reward");
    const lo = score("low-reward-low-competition", "high_reward");
    expect(hi.score).not.toBeNull();
    expect(lo.score).not.toBeNull();
    expect(hi.score!).toBeGreaterThan(lo.score!);
    expect(hi.reasons).toContain("REWARD_HIGH");
    expect(lo.reasons).toContain("REWARD_LOW");
  });

  it("low_competition: low-reward-low-competition outranks high-reward-api", () => {
    const hi = score("high-reward-api", "low_competition");
    const lo = score("low-reward-low-competition", "low_competition");
    expect(lo.score!).toBeGreaterThan(hi.score!);
    expect(lo.reasons).toContain("SATURATION_LOW");
  });

  it("fresh_programs: fresh-program outranks stale-program", () => {
    const fresh = score("fresh-program", "fresh_programs");
    const stale = score("stale-program", "fresh_programs");
    expect(fresh.score!).toBeGreaterThan(stale.score!);
  });

  it("authz_api: the api-heavy program outranks both comparators", () => {
    const api = score("high-reward-api", "authz_api");
    // mixed-target-program stands in as the broad-surface comparator;
    // low-reward-low-competition is the marketing-web-only one (api_surface 0).
    const mixed = score("mixed-target-program", "authz_api");
    const webOnly = score("low-reward-low-competition", "authz_api");
    expect(api.score!).toBeGreaterThan(mixed.score!);
    expect(api.score!).toBeGreaterThan(webOnly.score!);
    expect(api.reasons).toContain("API_SURFACE_HIGH");
    expect(webOnly.reasons).not.toContain("API_SURFACE_HIGH");
  });

  it("partial-program scores lower confidence than complete fixtures", () => {
    const partial = score("partial-program", "best_ev");
    // Every weighted signal unknown → score null, confidence 0.
    expect(partial.score).toBeNull();
    expect(partial.confidence).toBe(0);
    for (const name of FIXTURE_NAMES) {
      if (name === "partial-program") continue;
      const s = score(name, "best_ev");
      expect(
        s.confidence,
        `${name} should beat partial-program confidence`,
      ).toBeGreaterThan(partial.confidence);
    }
    // …and the same gap under every other profile.
    for (const id of RADAR_PROFILE_IDS) {
      expect(score("partial-program", id).confidence).toBe(0);
    }
  });

  it("partial-program ranks last under every profile", () => {
    for (const id of RADAR_PROFILE_IDS) {
      const ranked = rankPrograms(
        FIXTURE_NAMES.map((n) => score(n, id)),
        getRadarProfile(id),
      );
      const last = ranked[ranked.length - 1]!;
      expect(last.score.engagement_uuid).toBe(snap("partial-program").uuid);
      expect(last.eligible).toBe(false);
    }
  });
});

describe("reason-code hygiene over fixtures", () => {
  it("every emitted code has a REASON_TEXT template", () => {
    for (const name of FIXTURE_NAMES) {
      for (const id of RADAR_PROFILE_IDS) {
        for (const code of score(name, id).reasons) {
          expect(REASON_TEXT[code], `missing template for '${code}'`).toBeTruthy();
        }
      }
    }
  });

  it("partial-program reasons are exactly the weighted UNKNOWN_* codes", () => {
    const s = score("partial-program", "best_ev");
    expect(s.reasons).toEqual([
      "UNKNOWN_REWARD_POTENTIAL",
      "UNKNOWN_MEANINGFUL_SURFACE",
      "UNKNOWN_FRESHNESS",
      "UNKNOWN_RESEARCH_SATURATION",
      "UNKNOWN_API_SURFACE",
      "UNKNOWN_WEB_SURFACE",
      "UNKNOWN_REWARD_BREADTH",
      "UNKNOWN_REWARDED_ACTIVITY",
      "UNKNOWN_SAFE_HARBOR",
      "UNKNOWN_TARGET_DATA_QUALITY",
    ]);
  });
});
