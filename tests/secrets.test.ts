import { describe, expect, it } from "vitest";
import { normalizeTokenInput, redactSecrets } from "../lib/secrets";

describe("normalizeTokenInput", () => {
  it("accepts a bare credential", () => {
    expect(normalizeTokenInput("abc")).toBe("abc");
  });

  it("strips the Token prefix case-insensitively", () => {
    expect(normalizeTokenInput("Token abc")).toBe("abc");
    expect(normalizeTokenInput("token abc")).toBe("abc");
    expect(normalizeTokenInput("TOKEN  abc")).toBe("abc");
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(normalizeTokenInput("")).toBeNull();
    expect(normalizeTokenInput("   ")).toBeNull();
  });

  it("returns null for a prefix with no credential", () => {
    expect(normalizeTokenInput("Token")).toBeNull();
    expect(normalizeTokenInput("Token   ")).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of each secret", () => {
    expect(redactSecrets("key=s1 key=s1 again s2", ["s1", "s2"])).toBe(
      "key=[REDACTED] key=[REDACTED] again [REDACTED]",
    );
  });

  it("is a no-op for empty secrets", () => {
    expect(redactSecrets("hello world", [""])).toBe("hello world");
    expect(redactSecrets("", [""])).toBe("");
  });
});
