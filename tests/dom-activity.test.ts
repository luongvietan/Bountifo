// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { collectActivity } from "../lib/dom/activity";
import { assertRecordsWellFormed, loadDoc, PAGE_URL } from "./helpers/dom";

const PAGE2_URL = "https://bugcrowd.com/engagements/acme-bb/announcements?page=2";

function mockFetch() {
  const page2 = loadDoc("activity-page2.html", PAGE2_URL);
  const fn = vi.fn(async (url: string): Promise<Document | null> =>
    url === PAGE2_URL ? page2 : null,
  );
  return fn;
}

describe("collectActivity", () => {
  it("does not silently truncate announcement history after ten pages", async () => {
    const pageUrl = (page: number) => `${PAGE_URL}/announcements?page=${page}`;
    const docFor = (page: number) =>
      new DOMParser().parseFromString(
        `<section><h2>Announcements</h2><article><h3>Item ${page}</h3><p>Body ${page}</p></article>${
          page < 12 ? `<a rel="next" href="${pageUrl(page + 1)}">Next</a>` : ""
        }</section>`,
        "text/html",
      );
    const fetchPage = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return Number.isInteger(page) && page >= 2 && page <= 12
        ? docFor(page)
        : null;
    });
    const result = await collectActivity(docFor(1), pageUrl(1), fetchPage);
    expect(result.announcements.map((item) => item.title)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`),
    );
    expect(fetchPage).toHaveBeenCalledTimes(11);
  });

  it("exhausts announcement pagination via fetchPage until no next link", async () => {
    const fetchPage = mockFetch();
    const res = await collectActivity(loadDoc("activity.html"), PAGE_URL, fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(PAGE2_URL);
    expect(res.announcements).toHaveLength(3);
    expect(res.announcements.map((a) => a.title)).toEqual([
      "Reward increase for Q3",
      "New target added",
      "Program relaunched",
    ]);
    // An item from page 2 carries that page as its source.
    expect(res.announcements[2]!.sourceUrl).toBe(PAGE2_URL);
  });

  it("stops cleanly when fetchPage returns null", async () => {
    const fetchPage = vi.fn(async (): Promise<Document | null> => null);
    const res = await collectActivity(loadDoc("activity.html"), PAGE_URL, fetchPage);
    expect(res.announcements).toHaveLength(2);
  });

  it("collects changelog, recent activity, and accepted reports", async () => {
    const res = await collectActivity(loadDoc("activity.html"), PAGE_URL, mockFetch());
    expect(res.changelog).toHaveLength(2);
    expect(res.changelog[0]!.kind).toBe("changelog");
    expect(res.changelog[0]!.timestamp).toBe("2026-09-05");
    expect(res.recentActivity).toHaveLength(2);
    expect(res.recentActivity[0]!.kind).toBe("activity");
    expect(res.recentActivity[0]!.timestamp).toBe("2026-09-18T10:00:00Z");
    expect(res.acceptedReports).toHaveLength(2);
    expect(res.acceptedReports[0]!.kind).toBe("accepted_report");
    expect(res.acceptedReports[0]!.title).toBe("IDOR in customer portal");
    expect(res.acceptedReports[0]!.sourceUrl).toBe(
      "https://bugcrowd.com/submissions/r-1001",
    );
  });

  it("captures item timestamps and per-item source URLs", async () => {
    const res = await collectActivity(loadDoc("activity.html"), PAGE_URL, mockFetch());
    const first = res.announcements[0]!;
    expect(first.timestamp).toBe("2026-09-01T00:00:00Z");
    expect(first.sourceUrl).toBe(
      "https://bugcrowd.com/engagements/acme-bb/announcements/42",
    );
    expect(first.body).toContain("P1 rewards increased");
  });

  it("extracts participation statistics with windows", async () => {
    const res = await collectActivity(loadDoc("activity.html"), PAGE_URL, mockFetch());
    expect(res.stats["researchers-participated"]).toEqual({
      value: "128",
      window: "in the last 90 days",
    });
    expect(res.stats["average-response-time"]).toEqual({
      value: "6 hours",
      window: "all time",
    });
  });

  it("emits well-formed records under dom:activity", async () => {
    const res = await collectActivity(loadDoc("activity.html"), PAGE_URL, mockFetch());
    assertRecordsWellFormed(res.records);
    for (const r of res.records) {
      expect(r.sourceKey.startsWith("dom:activity:")).toBe(true);
    }
    const page2Record = res.records.find((r) =>
      r.quote.includes("maintenance pause"),
    );
    expect(page2Record?.sourceUrl).toBe(PAGE2_URL);
    const ann = res.records.find((r) =>
      r.sourceKey.startsWith("dom:activity:announcements:"),
    );
    expect(ann?.sourceLevel).toBe("announcement");
  });
});

describe("collectActivity current Bugcrowd feed cards", () => {
  it("keeps each top-level card as one complete activity item", async () => {
    const current = await collectActivity(
      loadDoc("webdotcom-current.html"),
      PAGE_URL,
      async () => null,
    );
    expect(current.changelog).toHaveLength(2);
    expect(current.changelog[0]?.body).toContain("New Target added!");
    expect(current.changelog[0]?.body).toContain("app.web.com and its AI features");
    expect(current.recentActivity).toHaveLength(2);
    expect(current.recentActivity[0]?.body).toContain(
      "Submission accepted on target: www.networksolutions.com",
    );
    expect(current.recentActivity[0]?.body).toContain("Priority P1");
  });
});
