import { describe, expect, it } from "vitest";
import {
  RADAR_FEATURE_KEYS,
  RADAR_PROFILE_IDS,
  programFeatureVectorSchema,
  programScoreSchema,
  radarCatalogItemSchema,
  radarProgramSnapshotSchema,
  radarSignalSchema,
} from "../lib/radar/types";

const SIGNAL_KEYS = [
  "reward_potential",
  "reward_breadth",
  "meaningful_surface",
  "api_surface",
  "api_surface_size",
  "web_surface",
  "researcher_competition",
  "rewarded_activity",
  "submission_activity",
  "research_saturation",
  "freshness",
  "safe_harbor",
  "target_data_quality",
  "accessibility",
  "known_issue_density",
  "opportunity_change",
  "authz_opportunity",
] as const;

function signal(value: number | null) {
  return { value, source: "engagement_detail" as const, reason_code: "test" };
}

function vector(overrides: Record<string, number | null> = {}) {
  const out: Record<string, unknown> = { schema_version: 1 };
  for (const key of SIGNAL_KEYS) {
    out[key] = signal(overrides[key] ?? null);
  }
  return out;
}

const catalogItem = {
  uuid: "f2b0fb99-1b2c-45d2-9341-f4a25088ba3a",
  code: "acme",
  name: "Acme",
  lifecycle_status: "live",
  engagement_type: "bug_bounty",
  discovered_at: "2026-09-21T00:00:00.000Z",
};

const score = {
  schema_version: 1,
  engagement_uuid: catalogItem.uuid,
  profile: "best_ev",
  scoring_version: "1.0.0",
  score: 84.7,
  confidence: 0.88,
  provisional: false,
  components: {
    reward_potential: {
      signal: 0.8,
      weight: 3,
      direction: "benefit",
      contribution: 2.4,
    },
  },
  reasons: ["REWARD_HIGH"],
  source_hash: "sha256:" + "0".repeat(64),
};

describe("radar profile ids", () => {
  it("are exactly the six V1 profiles in stable order", () => {
    expect([...RADAR_PROFILE_IDS]).toEqual([
      "best_ev",
      "low_competition",
      "high_reward",
      "authz_api",
      "fresh_programs",
      "easy_entry",
    ]);
  });
});

describe("radar feature keys", () => {
  it("cover exactly the 17 signals, excluding schema_version", () => {
    expect([...RADAR_FEATURE_KEYS].sort()).toEqual([...SIGNAL_KEYS].sort());
    expect(RADAR_FEATURE_KEYS).not.toContain("schema_version");
  });
});

describe("radarSignalSchema", () => {
  it("accepts null and in-range 0..1 values", () => {
    for (const value of [null, 0, 0.5, 1]) {
      expect(radarSignalSchema.safeParse(signal(value)).success).toBe(true);
    }
  });

  it("rejects out-of-range, NaN, Infinity, and non-number values", () => {
    for (const value of [-0.1, 1.01, NaN, Infinity, -Infinity, "x", undefined]) {
      expect(
        radarSignalSchema.safeParse(signal(value as number)).success,
        `value ${String(value)} should be rejected`,
      ).toBe(false);
    }
  });

  it("rejects unknown sources and missing reason_code", () => {
    expect(
      radarSignalSchema.safeParse({ ...signal(0.5), source: "llm" }).success,
    ).toBe(false);
    expect(
      radarSignalSchema.safeParse({ value: 0.5, source: "derived" }).success,
    ).toBe(false);
  });
});

describe("programFeatureVectorSchema", () => {
  it("accepts a full vector of null signals", () => {
    expect(programFeatureVectorSchema.safeParse(vector()).success).toBe(true);
  });

  it("rejects a missing signal key and an out-of-range signal", () => {
    const missing = vector();
    delete missing.api_surface;
    expect(programFeatureVectorSchema.safeParse(missing).success).toBe(false);
    expect(
      programFeatureVectorSchema.safeParse(vector({ freshness: 1.5 })).success,
    ).toBe(false);
  });

  it("rejects unknown keys and wrong schema_version", () => {
    expect(
      programFeatureVectorSchema.safeParse({ ...vector(), extra: 1 }).success,
    ).toBe(false);
    expect(
      programFeatureVectorSchema.safeParse({ ...vector(), schema_version: 2 })
        .success,
    ).toBe(false);
  });
});

describe("radarCatalogItemSchema", () => {
  it("accepts a minimal item with null optional fields", () => {
    expect(
      radarCatalogItemSchema.safeParse({
        ...catalogItem,
        code: null,
        name: null,
        lifecycle_status: null,
        engagement_type: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a missing uuid or discovered_at", () => {
    for (const key of ["uuid", "discovered_at"] as const) {
      const bad = { ...catalogItem } as Record<string, unknown>;
      delete bad[key];
      expect(radarCatalogItemSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("radarProgramSnapshotSchema", () => {
  it("accepts a detail-less unavailable snapshot", () => {
    expect(
      radarProgramSnapshotSchema.safeParse({
        schema_version: 1,
        uuid: catalogItem.uuid,
        code: "acme",
        catalog: catalogItem,
        detail: null,
        enrichment: { status: "unavailable", error_kind: "forbidden" },
        source_hash: "sha256:" + "0".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("rejects enrichment.status outside the known set", () => {
    expect(
      radarProgramSnapshotSchema.safeParse({
        schema_version: 1,
        uuid: catalogItem.uuid,
        code: "acme",
        catalog: catalogItem,
        detail: null,
        enrichment: { status: "partial" },
        source_hash: "sha256:" + "0".repeat(64),
      }).success,
    ).toBe(false);
  });
});

describe("programScoreSchema", () => {
  it("accepts a deterministic score document", () => {
    expect(programScoreSchema.safeParse(score).success).toBe(true);
  });

  it("accepts a null score (all weighted signals unknown)", () => {
    expect(
      programScoreSchema.safeParse({ ...score, score: null }).success,
    ).toBe(true);
  });

  it("rejects NaN/Infinity score and confidence outside 0..1", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        programScoreSchema.safeParse({ ...score, score: bad }).success,
      ).toBe(false);
    }
    for (const bad of [-0.01, 1.01, NaN]) {
      expect(
        programScoreSchema.safeParse({ ...score, confidence: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown profile ids, extra keys, and malformed components", () => {
    expect(
      programScoreSchema.safeParse({ ...score, profile: "ai_best" }).success,
    ).toBe(false);
    expect(
      programScoreSchema.safeParse({ ...score, extra: 1 }).success,
    ).toBe(false);
    expect(
      programScoreSchema.safeParse({
        ...score,
        components: {
          reward_potential: { signal: 0.8, weight: 3 },
        },
      }).success,
    ).toBe(false);
  });
});
