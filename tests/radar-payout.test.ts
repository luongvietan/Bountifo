import { describe, expect, it } from "vitest";
import { normReward } from "../lib/radar/curves";
import { extractProgramFeatures } from "../lib/radar/features";
import { payoutRealizedSignal } from "../lib/radar/payout";
import { programFeatureVectorSchema } from "../lib/radar/types";
import type { RadarProgramSnapshot } from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";

// ---------------------------------------------------------------------------
// V1.5 `payout_realized` — statistics.average_payout through the FROZEN
// normReward curve. Pins: honest null on absent/unparseable input, a real 0
// on "$0", source "statistics" + reason_code "average_payout_curve" on every
// sourced reading, `window` deliberately ignored, extractor-level
// detail_unavailable short-circuit, and purity (repeat calls identical).
// Fixture builders mirror tests/radar-features.test.ts.
// ---------------------------------------------------------------------------

const NOW = "2026-09-21T00:00:00.000Z";

function detail(overrides: Partial<ApiEngagementData> = {}): ApiEngagementData {
  return {
    uuid: "uuid-1",
    name: "Acme",
    code: "acme",
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
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
    ...overrides,
  };
}

/**
 * Detail whose statistics carry `average_payout` — `value`/`window` take
 * `unknown` so malformed runtime shapes (null, numbers) can be probed past
 * the declared `{value: string}` type.
 */
function withPayout(
  value: unknown,
  window: string | null = null,
): ApiEngagementData {
  return detail({
    statistics: {
      average_payout: {
        value: value as string,
        window,
      },
    },
  });
}

function snapshot(detailValue: ApiEngagementData | null): RadarProgramSnapshot {
  return {
    schema_version: 1,
    uuid: "uuid-1",
    code: "acme",
    catalog: {
      uuid: "uuid-1",
      code: "acme",
      name: "Acme",
      lifecycle_status: "live",
      engagement_type: "bug_bounty",
      discovered_at: "2026-09-01T00:00:00.000Z",
    },
    detail: detailValue,
    enrichment:
      detailValue === null
        ? { status: "failed", error_kind: "http" }
        : { status: "complete" },
    source_hash: `sha256:${"0".repeat(64)}`,
  };
}

const NULL_SIGNAL = {
  value: null,
  source: "statistics",
  reason_code: "average_payout_curve",
} as const;

describe("payoutRealizedSignal — absent input", () => {
  it("is null when statistics itself is absent", () => {
    const d = detail();
    // statistics is declared non-optional, but the signal stays defensive —
    // a hydration path that drops the block must not crash it.
    delete (d as { statistics?: unknown }).statistics;
    expect(payoutRealizedSignal(d)).toEqual(NULL_SIGNAL);
  });

  it("is null when average_payout is absent", () => {
    for (const d of [
      detail({ statistics: {} }),
      detail({
        statistics: {
          researchers_participating: { value: "10", window: null },
        },
      }),
      // Present key, absent value slot at runtime.
      detail({
        statistics: {
          average_payout: undefined as unknown as {
            value: string;
            window: string | null;
          },
        },
      }),
    ]) {
      expect(payoutRealizedSignal(d)).toEqual(NULL_SIGNAL);
    }
  });

  it("is null when the value is null or non-string at runtime", () => {
    for (const d of [withPayout(null), withPayout(2000), withPayout({})]) {
      expect(payoutRealizedSignal(d)).toEqual(NULL_SIGNAL);
    }
  });
});

describe("payoutRealizedSignal — frozen reward curve", () => {
  it.each([
    ["$2,000", 0.5],
    ["$25,000", 1],
    ["$100,000", 1], // clamps above the top anchor
    ["500", 0.25],
    ["$500.00", 0.25],
    ["10,000", 0.8],
  ])("average_payout %j → %s", (raw, expected) => {
    expect(payoutRealizedSignal(withPayout(raw))).toEqual({
      value: expected,
      source: "statistics",
      reason_code: "average_payout_curve",
    });
  });

  it("reads a real 0 on $0 / 0 — never coerced to null", () => {
    for (const raw of ["$0", "0", "$0.00", "0.0"]) {
      const s = payoutRealizedSignal(withPayout(raw));
      expect(s.value).toBe(0); // a real reading, not null
      expect(s.value).not.toBeNull();
      expect(s.source).toBe("statistics");
      expect(s.reason_code).toBe("average_payout_curve");
    }
  });

  it("interpolates in ln-space between anchors and rounds to 4 decimals", () => {
    // normReward(1000): ln(1001) sits ~halfway between ln(501) and ln(2001)
    // → 0.37495… → rounds to 0.375 at 4 decimals (the raw curve is pinned
    // ~0.3749 in radar-features.test.ts).
    const mid = payoutRealizedSignal(withPayout("1,000"));
    expect(mid.value).toBe(0.375);
    expect(mid.value).toBe(Number(normReward(1000).toFixed(4)));
    expect(mid.value!).toBeGreaterThan(0.25);
    expect(mid.value!).toBeLessThan(0.5);

    // Between the 2000 and 10000 anchors: strictly inside (0.5, 0.8).
    const upper = payoutRealizedSignal(withPayout("$5,000"));
    expect(upper.value).toBe(Number(normReward(5000).toFixed(4)));
    expect(upper.value!).toBeGreaterThan(0.5);
    expect(upper.value!).toBeLessThan(0.8);
  });

  it("is monotone non-decreasing in the parsed amount", () => {
    const raws = ["0", "250", "500", "1,000", "$2,000", "5,000", "10,000", "25,000"];
    let prev = -1;
    for (const raw of raws) {
      const s = payoutRealizedSignal(withPayout(raw));
      expect(s.value).not.toBeNull();
      expect(s.value!).toBeGreaterThanOrEqual(prev);
      prev = s.value!;
    }
  });

  it("ignores the stat's window — any window's average is payment evidence", () => {
    for (const window of [null, "30d", "90d", "all_time"]) {
      expect(payoutRealizedSignal(withPayout("$2,000", window)).value).toBe(
        0.5,
      );
    }
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(payoutRealizedSignal(withPayout("  $2,000  ")).value).toBe(0.5);
  });
});

describe("payoutRealizedSignal — malformed strings stay honestly null", () => {
  it.each([
    "abc",
    "N/A",
    "1,23,4", // bad thousands grouping
    "1,2345",
    "12k", // suffix notation — never a bare parseFloat
    "-500", // negative-as-text rejected
    "$-5",
    "-1,000",
    "1e3",
    "1.2.3",
    ".5",
    "5.",
    "$",
    "",
    "   ",
    "1 234",
  ])("rejects %j", (raw) => {
    expect(payoutRealizedSignal(withPayout(raw))).toEqual(NULL_SIGNAL);
  });
});

describe("payoutRealizedSignal — purity", () => {
  it("is pure: repeat calls on the same input are identical", () => {
    const d = withPayout("$3,333.33", "90d");
    const a = payoutRealizedSignal(d);
    const b = payoutRealizedSignal(d);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // fresh object each call — no shared mutable state
    expect(a.value).toBe(Number(normReward(3333.33).toFixed(4)));
  });
});

describe("payout_realized via extractProgramFeatures", () => {
  it("populates the vector slot from statistics.average_payout", () => {
    const v = extractProgramFeatures(snapshot(withPayout("$2,000", "30d")), NOW);
    expect(v.payout_realized).toEqual({
      value: 0.5,
      source: "statistics",
      reason_code: "average_payout_curve",
    });
    expect(programFeatureVectorSchema.safeParse(v).success).toBe(true);
  });

  it("reads the honest null when the stat is absent or malformed", () => {
    for (const d of [
      detail({ statistics: {} }),
      withPayout("abc"),
    ]) {
      const v = extractProgramFeatures(snapshot(d), NOW);
      expect(v.payout_realized).toEqual(NULL_SIGNAL);
    }
  });

  it("detail === null → detail_unavailable, not the curve code", () => {
    const v = extractProgramFeatures(snapshot(null), NOW);
    expect(v.payout_realized).toEqual({
      value: null,
      source: "statistics",
      reason_code: "detail_unavailable",
    });
  });
});
