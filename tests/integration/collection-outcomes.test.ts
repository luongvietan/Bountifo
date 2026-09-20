import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import { JobCoordinator } from "../../lib/job/coordinator";
import { decodeMarkdown, harness } from "./helpers";

beforeEach(() => fakeBrowser.reset());

async function run(options = {}) {
  const download = vi.spyOn(browser.downloads, "download").mockResolvedValue(1);
  const h = harness(options);
  const coordinator = new JobCoordinator(h.deps);
  await coordinator.start(7);
  await coordinator.waitForIdle();
  const markdown = download.mock.calls.length === 0 ? null : decodeMarkdown(download.mock.calls[0]![0].url);
  return { coordinator, download, markdown, messages: h.messages };
}

describe("collection outcomes", () => {
  it("keeps DOM-complete export complete when API is unavailable", async () => {
    const { markdown } = await run();
    expect(markdown).toContain("status: complete");
    expect(markdown).toContain("api_status: unavailable");
  });

  it("preserves conflicting program and target evidence as unresolved", async () => {
    const { markdown } = await run({ conflict: true });
    expect(markdown).toContain("unresolved_conflicts: 1");
    expect(markdown).toContain("Automated scanning is allowed.");
    expect(markdown).toContain("Automated scanning is prohibited.");
  });

  it("marks a Known Issues mismatch partial with a warning", async () => {
    const { markdown } = await run({ kiMismatch: true });
    expect(markdown).toContain("status: partial");
    expect(markdown).toContain("known_issues_counts_valid: false");
    expect(markdown).toContain("ki_count_mismatch");
  });

  it("fails on session expiry and never downloads", async () => {
    const { coordinator, download, messages } = await run({ fatalKind: "collect_targets" });
    expect(coordinator.state?.phase).toBe("failed");
    expect(download).not.toHaveBeenCalled();
    expect(messages.some((msg) => (msg as { kind?: string }).kind === "restore_page")).toBe(true);
  });
});
