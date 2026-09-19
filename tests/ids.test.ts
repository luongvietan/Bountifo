import { describe, expect, it } from "vitest";
import {
  exportFileName,
  isSupportedEngagementUrl,
  parseEngagementUrl,
  targetIdPreimage,
} from "../lib/ids";

describe("parseEngagementUrl", () => {
  it("parses an engagement root URL", () => {
    expect(
      parseEngagementUrl("https://bugcrowd.com/engagements/aiven-mbb-og"),
    ).toEqual({
      code: "aiven-mbb-og",
      canonicalUrl: "https://bugcrowd.com/engagements/aiven-mbb-og",
    });
  });

  it("parses a subpath and drops it from the canonical URL", () => {
    expect(
      parseEngagementUrl(
        "https://bugcrowd.com/engagements/aiven-mbb-og/known_issues",
      ),
    ).toEqual({
      code: "aiven-mbb-og",
      canonicalUrl: "https://bugcrowd.com/engagements/aiven-mbb-og",
    });
  });

  it("parses a query string and drops it from the canonical URL", () => {
    expect(
      parseEngagementUrl("https://bugcrowd.com/engagements/aiven-mbb-og?tab=scope"),
    ).toEqual({
      code: "aiven-mbb-og",
      canonicalUrl: "https://bugcrowd.com/engagements/aiven-mbb-og",
    });
  });

  it("rejects http scheme", () => {
    expect(
      parseEngagementUrl("http://bugcrowd.com/engagements/aiven-mbb-og"),
    ).toBeNull();
  });

  it("rejects other hosts including www", () => {
    expect(
      parseEngagementUrl("https://www.bugcrowd.com/engagements/aiven-mbb-og"),
    ).toBeNull();
    expect(
      parseEngagementUrl("https://example.com/engagements/aiven-mbb-og"),
    ).toBeNull();
  });

  it("rejects non-engagement paths", () => {
    expect(
      parseEngagementUrl("https://bugcrowd.com/programs/aiven-mbb-og"),
    ).toBeNull();
  });

  it("rejects a missing code", () => {
    expect(parseEngagementUrl("https://bugcrowd.com/engagements/")).toBeNull();
    expect(parseEngagementUrl("https://bugcrowd.com/engagements")).toBeNull();
  });
});

describe("isSupportedEngagementUrl", () => {
  it("is true for engagement URLs and false otherwise", () => {
    expect(
      isSupportedEngagementUrl("https://bugcrowd.com/engagements/aiven-mbb-og"),
    ).toBe(true);
    expect(
      isSupportedEngagementUrl("https://bugcrowd.com/programs/aiven-mbb-og"),
    ).toBe(false);
  });
});

describe("exportFileName", () => {
  it("zero-pads month and day", () => {
    expect(exportFileName("aiven-mbb-og", new Date(2026, 0, 5))).toBe(
      "bugcrowd-aiven-mbb-og-2026-01-05.md",
    );
  });

  it("matches the exact filename format", () => {
    expect(exportFileName("aiven-mbb-og", new Date(2026, 8, 20))).toBe(
      "bugcrowd-aiven-mbb-og-2026-09-20.md",
    );
  });
});

describe("targetIdPreimage", () => {
  const base = {
    engagementId: "eng-1",
    location: "https://api.example.com",
    name: null,
    type: "website",
  };

  it("omits occurrence when undefined", () => {
    expect(targetIdPreimage(base)).toBe(
      '{"engagementId":"eng-1","location":"https://api.example.com","name":null,"type":"website"}',
    );
  });

  it("includes occurrence when set", () => {
    expect(targetIdPreimage({ ...base, occurrence: 2 })).toBe(
      '{"engagementId":"eng-1","location":"https://api.example.com","name":null,"occurrence":2,"type":"website"}',
    );
  });
});
