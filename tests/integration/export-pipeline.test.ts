import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import { JobCoordinator } from "../../lib/job/coordinator";
import { decodeMarkdown, harness } from "./helpers";

beforeEach(() => fakeBrowser.reset());

async function run(reverseRecords = false): Promise<string> {
  const download = vi.spyOn(browser.downloads, "download").mockResolvedValue(1);
  const coordinator = new JobCoordinator(harness({ reverseRecords }).deps);
  await coordinator.start(7);
  await coordinator.waitForIdle();
  expect(download).toHaveBeenCalledOnce();
  const request = download.mock.calls[0]![0];
  expect(request.filename).toBe("bugcrowd-acme-2026-09-20.md");
  return decodeMarkdown(request.url);
}

describe("full export pipeline", () => {
  it("downloads front matter and all dossier sections in order", async () => {
    const markdown = await run();
    expect(markdown.startsWith("---\nschema_version: 2")).toBe(true);
    const headings = [
      "Agent Facts", "Engagement Overview", "Authorization and Safe Harbor",
      "Scope Inventory", "Reward Matrix", "Known Issues", "VRT Policy",
      "Testing, Account, Resource, and Data Constraints",
      "Focus Areas / Explicit Exclusions", "Credentials and Access",
      "Reporting Requirements", "Announcements and Changelog",
      "Recent Activity, Participation, Response Statistics", "Evidence Objects",
      "Collection Provenance, Conflicts, Missing Sections, Warnings",
    ];
    let previous = -1;
    for (const heading of headings) {
      const index = markdown.indexOf(`## ${heading}`);
      expect(index, heading).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("keeps corpus hash and evidence order stable across input order", async () => {
    const first = await run(false);
    vi.restoreAllMocks();
    fakeBrowser.reset();
    const second = await run(true);
    const hash = (text: string) => text.match(/evidence_corpus_hash: (sha256:[0-9a-f]{64})/)?.[1];
    expect(hash(first)).toBe(hash(second));
    expect(first.match(/### ev_[0-9a-f]{12}/g)).toEqual(second.match(/### ev_[0-9a-f]{12}/g));
  });
});
