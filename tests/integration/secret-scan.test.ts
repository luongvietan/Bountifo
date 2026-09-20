import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import { JobCoordinator } from "../../lib/job/coordinator";
import { decodeMarkdown, harness } from "./helpers";

const SECRET = "hunter2-secret-token";

beforeEach(async () => {
  fakeBrowser.reset();
  await fakeBrowser.storage.local.set({ apiCredential: SECRET });
});

describe("secret scan", () => {
  it("keeps credential material out of output, messages, state, errors, and logs", async () => {
    const errors: unknown[][] = [];
    const warnings: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args); });
    const download = vi.spyOn(browser.downloads, "download").mockResolvedValue(1);
    const h = harness();
    const coordinator = new JobCoordinator(h.deps);
    await coordinator.start(7);
    await coordinator.waitForIdle();
    const markdown = decodeMarkdown(download.mock.calls[0]![0].url);
    const scanned = JSON.stringify({ markdown, messages: h.messages, state: coordinator.state, errors, warnings });
    expect(scanned).not.toContain(SECRET);
    expect(scanned).not.toContain("Token hunter2");
    expect(scanned).not.toMatch(/Authorization\s*:/i);
  });
});
