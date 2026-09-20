import { describe, expect, it } from "vitest";
import { browser } from "wxt/browser";
import {
  parseApiRequest,
  parseJobMessage,
  parsePopupMessage,
  validateJobSender,
  type ActiveJobDescriptor,
} from "../lib/messages";

const VALID_UUID = "01234567-89ab-cdef-0123-456789abcdef";

describe("parseApiRequest", () => {
  it("accepts each allowlisted op with valid params", () => {
    expect(
      parseApiRequest({ op: "TEST_TOKEN", params: { token: "abc" } }),
    ).toEqual({ op: "TEST_TOKEN", params: { token: "abc" } });
    expect(
      parseApiRequest({ op: "LIST_ENGAGEMENTS", params: { page: 2 } }),
    ).toEqual({ op: "LIST_ENGAGEMENTS", params: { page: 2 } });
    expect(
      parseApiRequest({ op: "GET_ENGAGEMENT", params: { uuid: VALID_UUID } }),
    ).toEqual({ op: "GET_ENGAGEMENT", params: { uuid: VALID_UUID } });
    expect(
      parseApiRequest({
        op: "GET_ENGAGEMENT",
        params: { code: "my-program_1" },
      }),
    ).toEqual({ op: "GET_ENGAGEMENT", params: { code: "my-program_1" } });
    expect(parseApiRequest({ op: "LIST_ENGAGEMENTS", params: {} })).toEqual({
      op: "LIST_ENGAGEMENTS",
      params: {},
    });
  });

  it("rejects unknown ops and non-object messages", () => {
    expect(parseApiRequest({ op: "FETCH", params: {} })).toBeNull();
    expect(parseApiRequest({ op: "DELETE_ENGAGEMENT", params: {} })).toBeNull();
    expect(parseApiRequest({})).toBeNull();
    expect(parseApiRequest(null)).toBeNull();
    expect(parseApiRequest("TEST_TOKEN")).toBeNull();
    expect(parseApiRequest(42)).toBeNull();
  });

  it("rejects a missing params object", () => {
    expect(parseApiRequest({ op: "TEST_TOKEN" })).toBeNull();
  });

  it.each([
    "url",
    "hostname",
    "headers",
    "Authorization",
    "authorization",
    "method",
    "options",
    "body",
    "credentials",
  ])("rejects params containing request-injection key %s", (key) => {
    expect(
      parseApiRequest({
        op: "GET_ENGAGEMENT",
        params: { uuid: VALID_UUID, [key]: "x" },
      }),
    ).toBeNull();
  });

  it("rejects extra top-level keys", () => {
    expect(
      parseApiRequest({
        op: "GET_ENGAGEMENT",
        params: {},
        url: "https://evil.example/",
      }),
    ).toBeNull();
    expect(
      parseApiRequest({ op: "GET_ENGAGEMENT", params: {}, headers: {} }),
    ).toBeNull();
    expect(
      parseApiRequest({ op: "GET_ENGAGEMENT", params: {}, options: {} }),
    ).toBeNull();
  });

  it("rejects out-of-range or non-integer page", () => {
    for (const page of [0, -1, 101, 1.5, "1", Number.NaN]) {
      expect(
        parseApiRequest({ op: "LIST_ENGAGEMENTS", params: { page } }),
      ).toBeNull();
    }
  });

  it("rejects malformed uuid", () => {
    for (const uuid of [
      "not-a-uuid",
      "01234567-89ab-cdef-0123-456789abcde", // 35 chars
      "01234567-89ab-cdef-0123-456789abcdef0", // 37 chars
      "zzzzzzzz-89ab-cdef-0123-456789abcdef",
      123,
    ]) {
      expect(
        parseApiRequest({ op: "GET_ENGAGEMENT", params: { uuid } }),
      ).toBeNull();
    }
  });

  it("rejects malformed code", () => {
    for (const code of ["has space", "a/b", "..", "code!", "code?x=1", 7]) {
      expect(
        parseApiRequest({ op: "LIST_ENGAGEMENTS", params: { code } }),
      ).toBeNull();
    }
  });
});

describe("parsePopupMessage", () => {
  it("accepts each popup op", () => {
    expect(parsePopupMessage({ op: "START_EXPORT", tabId: 3 })).toEqual({
      op: "START_EXPORT",
      tabId: 3,
    });
    expect(parsePopupMessage({ op: "CANCEL_EXPORT", jobId: "j1" })).toEqual({
      op: "CANCEL_EXPORT",
      jobId: "j1",
    });
    expect(parsePopupMessage({ op: "GET_JOB_STATE" })).toEqual({
      op: "GET_JOB_STATE",
    });
    expect(parsePopupMessage({ op: "SAVE_TOKEN", token: "t" })).toEqual({
      op: "SAVE_TOKEN",
      token: "t",
    });
    expect(parsePopupMessage({ op: "CLEAR_TOKEN" })).toEqual({
      op: "CLEAR_TOKEN",
    });
    expect(parsePopupMessage({ op: "GET_TOKEN_STATUS" })).toEqual({
      op: "GET_TOKEN_STATUS",
    });
  });

  it("rejects unknown ops and malformed payloads", () => {
    expect(parsePopupMessage({ op: "EXPORT" })).toBeNull();
    // The in-page launcher names no tab: the background uses sender.tab.id,
    // so a content script cannot aim an export at another tab.
    expect(parsePopupMessage({ op: "START_EXPORT_HERE" })).toEqual({
      op: "START_EXPORT_HERE",
    });
    expect(
      parsePopupMessage({ op: "START_EXPORT_HERE", tabId: 3 }),
    ).toBeNull();
    expect(parsePopupMessage({ op: "START_EXPORT", tabId: 1.5 })).toBeNull();
    expect(parsePopupMessage({ op: "START_EXPORT", tabId: "3" })).toBeNull();
    expect(parsePopupMessage({ op: "START_EXPORT" })).toBeNull();
    expect(parsePopupMessage({ op: "SAVE_TOKEN" })).toBeNull();
    expect(parsePopupMessage(null)).toBeNull();
  });

  it("rejects extra keys on any popup op (strict objects)", () => {
    expect(
      parsePopupMessage({ op: "GET_JOB_STATE", token: "x" }),
    ).toBeNull();
    expect(
      parsePopupMessage({ op: "CLEAR_TOKEN", jobId: "j" }),
    ).toBeNull();
    expect(
      parsePopupMessage({ op: "START_EXPORT", tabId: 3, url: "https://x/" }),
    ).toBeNull();
    expect(
      parsePopupMessage({ op: "SAVE_TOKEN", token: "t", headers: {} }),
    ).toBeNull();
  });
});

describe("parseJobMessage", () => {
  it("accepts each job op", () => {
    expect(
      parseJobMessage({
        op: "PAGE_READY",
        jobId: "j",
        url: "https://bugcrowd.com/engagements/x",
      }),
    ).toEqual({
      op: "PAGE_READY",
      jobId: "j",
      url: "https://bugcrowd.com/engagements/x",
    });
    expect(
      parseJobMessage({
        op: "UNIT_PROGRESS",
        jobId: "j",
        unitId: "u",
        counters: { knownIssues: 3 },
      }),
    ).toEqual({
      op: "UNIT_PROGRESS",
      jobId: "j",
      unitId: "u",
      counters: { knownIssues: 3 },
    });
    expect(
      parseJobMessage({
        op: "UNIT_RESULT",
        jobId: "j",
        unitId: "u",
        result: { any: "thing" },
      }),
    ).toEqual({
      op: "UNIT_RESULT",
      jobId: "j",
      unitId: "u",
      result: { any: "thing" },
    });
    // result is z.unknown(): null payload is schema-valid
    expect(
      parseJobMessage({
        op: "UNIT_RESULT",
        jobId: "j",
        unitId: "u",
        result: null,
      }),
    ).toEqual({ op: "UNIT_RESULT", jobId: "j", unitId: "u", result: null });
  });

  it("rejects a JobMsg carrying a token field (strict objects)", () => {
    expect(
      parseJobMessage({
        op: "PAGE_READY",
        jobId: "j",
        url: "https://bugcrowd.com/x",
        token: "x",
      }),
    ).toBeNull();
    expect(
      parseJobMessage({
        op: "UNIT_RESULT",
        jobId: "j",
        unitId: "u",
        result: {},
        token: "x",
      }),
    ).toBeNull();
    expect(
      parseJobMessage({
        op: "UNIT_PROGRESS",
        jobId: "j",
        unitId: "u",
        counters: {},
        Authorization: "Token x",
      }),
    ).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(parseJobMessage({ op: "PAGE_READY", jobId: "j" })).toBeNull();
    expect(
      parseJobMessage({
        op: "UNIT_PROGRESS",
        jobId: "j",
        unitId: "u",
        counters: { a: "1" },
      }),
    ).toBeNull();
    expect(
      parseJobMessage({ op: "UNIT_RESULT", jobId: "j" }),
    ).toBeNull();
    expect(parseJobMessage({ op: "PAGE_READY", jobId: 1, url: "u" })).toBeNull();
    expect(parseJobMessage({ op: "NOPE", jobId: "j" })).toBeNull();
    expect(parseJobMessage(null)).toBeNull();
  });
});

describe("validateJobSender", () => {
  const job: ActiveJobDescriptor = {
    jobId: "job-1",
    tabId: 42,
    engagementCode: "prog",
    phase: "collecting",
  };
  const validSender = {
    id: browser.runtime.id,
    tab: { id: 42, url: "https://bugcrowd.com/engagements/prog" },
  };

  it("accepts a fully valid sender", () => {
    expect(
      validateJobSender(validSender, { jobId: "job-1" }, job, "collecting"),
    ).toEqual({ ok: true });
  });

  it("rejects a wrong or missing sender id", () => {
    for (const sender of [
      { ...validSender, id: "other-extension-id" },
      { tab: validSender.tab },
    ]) {
      const res = validateJobSender(
        sender,
        { jobId: "job-1" },
        job,
        "collecting",
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(typeof res.reason).toBe("string");
    }
  });

  it("rejects a wrong tab id or missing tab", () => {
    for (const sender of [
      { id: validSender.id, tab: { id: 43, url: validSender.tab.url } },
      { id: validSender.id },
      { id: validSender.id, tab: {} },
    ]) {
      expect(
        validateJobSender(sender, { jobId: "job-1" }, job, "collecting").ok,
      ).toBe(false);
    }
  });

  it("rejects non-bugcrowd, insecure, subdomain, or missing tab urls", () => {
    for (const url of [
      "http://bugcrowd.com/engagements/prog", // http is not allowed
      "https://sub.bugcrowd.com/engagements/prog", // subdomains are NOT allowed
      "https://bugcrowd.com.evil.example/x", // suffix spoof
      "https://bugcrowd.com", // no path — does not match the "https://bugcrowd.com/" prefix
      "chrome-extension://abc/page.html",
    ]) {
      const sender = { id: browser.runtime.id, tab: { id: 42, url } };
      expect(
        validateJobSender(sender, { jobId: "job-1" }, job, "collecting").ok,
      ).toBe(false);
    }
    // missing url entirely
    const sender = { id: browser.runtime.id, tab: { id: 42 } };
    expect(
      validateJobSender(sender, { jobId: "job-1" }, job, "collecting").ok,
    ).toBe(false);
  });

  it("rejects a wrong jobId", () => {
    expect(
      validateJobSender(validSender, { jobId: "job-2" }, job, "collecting").ok,
    ).toBe(false);
  });

  it("rejects a wrong phase", () => {
    expect(
      validateJobSender(validSender, { jobId: "job-1" }, job, "rendering").ok,
    ).toBe(false);
  });
});
