import { describe, expect, it } from "vitest";
import { parseRadarMessage } from "../lib/messages";

// Strict-schema tests for the RADAR_* extension-page protocol (Task 16).
// Same conventions as messages.test.ts: every op is a .strict() object so
// request-injection keys (url/headers/method/body/token) are rejected.

const VALID_UUID = "01234567-89ab-cdef-0123-456789abcdef";

describe("parseRadarMessage accepts", () => {
  it.each([
    { op: "RADAR_START_SCAN" },
    { op: "RADAR_CANCEL_SCAN" },
    { op: "RADAR_GET_STATE" },
  ])("fieldless op %s", (msg) => {
    expect(parseRadarMessage(msg)).toEqual(msg);
  });

  it("RADAR_GET_RESULTS with all fields", () => {
    expect(
      parseRadarMessage({
        op: "RADAR_GET_RESULTS",
        profile: "best_ev",
        limit: 50,
        minConfidence: 0.7,
      }),
    ).toEqual({
      op: "RADAR_GET_RESULTS",
      profile: "best_ev",
      limit: 50,
      minConfidence: 0.7,
    });
  });

  it("RADAR_GET_RESULTS defaults limit to 50", () => {
    expect(
      parseRadarMessage({ op: "RADAR_GET_RESULTS", profile: "low_competition" }),
    ).toEqual({ op: "RADAR_GET_RESULTS", profile: "low_competition", limit: 50 });
  });

  it("accepts every known profile id", () => {
    for (const profile of [
      "best_ev",
      "low_competition",
      "high_reward",
      "authz_api",
      "fresh_programs",
      "easy_entry",
    ]) {
      expect(
        parseRadarMessage({ op: "RADAR_GET_RESULTS", profile }),
      ).not.toBeNull();
    }
  });

  it("RADAR_GET_PROGRAM with uuid only (profile optional)", () => {
    expect(
      parseRadarMessage({ op: "RADAR_GET_PROGRAM", uuid: VALID_UUID }),
    ).toEqual({ op: "RADAR_GET_PROGRAM", uuid: VALID_UUID });
    expect(
      parseRadarMessage({
        op: "RADAR_GET_PROGRAM",
        uuid: VALID_UUID,
        profile: "high_reward",
      }),
    ).toEqual({
      op: "RADAR_GET_PROGRAM",
      uuid: VALID_UUID,
      profile: "high_reward",
    });
  });
});

describe("parseRadarMessage rejects", () => {
  it("unknown ops and non-object messages", () => {
    expect(parseRadarMessage({ op: "RADAR_SCAN" })).toBeNull();
    expect(parseRadarMessage({ op: "RADAR_DELETE" })).toBeNull();
    expect(parseRadarMessage({ op: "LIST_ENGAGEMENTS", params: {} })).toBeNull();
    expect(parseRadarMessage(null)).toBeNull();
    expect(parseRadarMessage("RADAR_START_SCAN")).toBeNull();
    expect(parseRadarMessage(42)).toBeNull();
    expect(parseRadarMessage({})).toBeNull();
  });

  it.each([
    { op: "RADAR_START_SCAN" },
    { op: "RADAR_CANCEL_SCAN" },
    { op: "RADAR_GET_STATE" },
  ])("extra keys on fieldless op %s", (msg) => {
    expect(parseRadarMessage({ ...msg, url: "https://evil.example/" })).toBeNull();
    expect(parseRadarMessage({ ...msg, token: "x" })).toBeNull();
    expect(parseRadarMessage({ ...msg, run_id: "r1" })).toBeNull();
  });

  it.each(["url", "hostname", "headers", "Authorization", "method", "body", "credentials", "operation"])(
    "request-injection key %s on RADAR_GET_RESULTS",
    (key) => {
      expect(
        parseRadarMessage({
          op: "RADAR_GET_RESULTS",
          profile: "best_ev",
          [key]: "x",
        }),
      ).toBeNull();
    },
  );

  it("out-of-range or non-integer limit", () => {
    for (const limit of [0, -1, 201, 1.5, "50", Number.NaN]) {
      expect(
        parseRadarMessage({ op: "RADAR_GET_RESULTS", profile: "best_ev", limit }),
      ).toBeNull();
    }
    // 200 is the bound — accepted.
    expect(
      parseRadarMessage({
        op: "RADAR_GET_RESULTS",
        profile: "best_ev",
        limit: 200,
      }),
    ).not.toBeNull();
  });

  it("out-of-range minConfidence", () => {
    for (const minConfidence of [-0.1, 1.1, "0.5", Number.NaN]) {
      expect(
        parseRadarMessage({
          op: "RADAR_GET_RESULTS",
          profile: "best_ev",
          minConfidence,
        }),
      ).toBeNull();
    }
  });

  it("unknown profile on RADAR_GET_RESULTS / RADAR_GET_PROGRAM", () => {
    expect(
      parseRadarMessage({ op: "RADAR_GET_RESULTS", profile: "everything" }),
    ).toBeNull();
    expect(
      parseRadarMessage({
        op: "RADAR_GET_PROGRAM",
        uuid: VALID_UUID,
        profile: "everything",
      }),
    ).toBeNull();
  });

  it("missing or malformed uuid on RADAR_GET_PROGRAM", () => {
    expect(parseRadarMessage({ op: "RADAR_GET_PROGRAM" })).toBeNull();
    for (const uuid of [
      "not-a-uuid",
      "01234567-89ab-cdef-0123-456789abcde", // 35 chars
      "01234567-89ab-cdef-0123-456789abcdef0", // 37 chars
      "zzzzzzzz-89ab-cdef-0123-456789abcdef",
      123,
    ]) {
      expect(
        parseRadarMessage({ op: "RADAR_GET_PROGRAM", uuid }),
      ).toBeNull();
    }
  });
});
