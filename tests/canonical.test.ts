import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalLocator,
  canonicalUrl,
  normalizeText,
} from "../lib/canonical";

describe("normalizeText", () => {
  it("normalizes Unicode to NFC", () => {
    // "e" + combining acute (NFD) must become precomposed "é" (NFC)
    expect(normalizeText("café")).toBe("café");
  });

  it("converts CRLF and CR to LF, then collapses whitespace runs to a single space", () => {
    expect(normalizeText("a\r\nb\rc")).toBe("a b c");
  });

  it("trims and collapses interior whitespace runs to a single space", () => {
    expect(normalizeText("  hello \t  world   again  ")).toBe(
      "hello world again",
    );
  });
});

describe("canonicalJson", () => {
  it("sorts nested object keys lexicographically", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 1 })).toBe(
      '{"a":1,"b":{"c":2,"d":1}}',
    );
  });

  it("drops undefined object properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });
});

describe("canonicalUrl", () => {
  it("lowercases scheme and host", () => {
    expect(canonicalUrl("HTTPS://BUGCROWD.COM/engagements/x")).toBe(
      "https://bugcrowd.com/engagements/x",
    );
  });

  it("strips the default port and fragment", () => {
    expect(canonicalUrl("https://bugcrowd.com:443/engagements/x#frag")).toBe(
      "https://bugcrowd.com/engagements/x",
    );
  });

  it("strips tracking parameters", () => {
    expect(
      canonicalUrl("https://bugcrowd.com/e?utm_source=x&gclid=y&keep=1"),
    ).toBe("https://bugcrowd.com/e?keep=1");
  });

  it("sorts remaining query params", () => {
    expect(canonicalUrl("https://bugcrowd.com/e?b=2&a=1")).toBe(
      "https://bugcrowd.com/e?a=1&b=2",
    );
  });

  it("preserves the path", () => {
    expect(canonicalUrl("https://bugcrowd.com/a/b/c")).toBe(
      "https://bugcrowd.com/a/b/c",
    );
  });
});

describe("canonicalLocator", () => {
  it("emits canonical JSON of defined fields only", () => {
    expect(
      canonicalLocator({
        subsection: "Automated testing",
        section: "Program Rules",
        rowIndex: undefined,
      }),
    ).toBe('{"section":"Program Rules","subsection":"Automated testing"}');
  });
});
