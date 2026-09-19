// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isSessionExpired } from "../lib/dom/session";
import { loadDoc, PAGE_URL } from "./helpers/dom";

describe("isSessionExpired", () => {
  it("returns true for a redirect to a login/auth path", () => {
    const doc = loadDoc("details.html");
    expect(
      isSessionExpired(doc, "https://bugcrowd.com/users/sign_in?return_to=/x"),
    ).toBe(true);
    expect(isSessionExpired(doc, "https://bugcrowd.com/login")).toBe(true);
  });

  it("returns true for a login form page without engagement content", () => {
    const doc = loadDoc("session-expired.html", "https://bugcrowd.com/users/sign_in");
    expect(isSessionExpired(doc, "https://bugcrowd.com/users/sign_in")).toBe(true);
    // DOM evidence alone is enough even on an unexpected URL.
    expect(isSessionExpired(doc, PAGE_URL)).toBe(true);
  });

  it("returns false for an authenticated engagement page", () => {
    expect(isSessionExpired(loadDoc("details.html"), PAGE_URL)).toBe(false);
    expect(isSessionExpired(loadDoc("policies.html"), PAGE_URL)).toBe(false);
    expect(isSessionExpired(loadDoc("targets.html"), PAGE_URL)).toBe(false);
  });
});
