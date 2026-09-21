// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBrowser } from "wxt/testing/fake-browser";

// Task 22 — the popup gains an "Open Radar" affordance that launches the
// dedicated extension page via tabs.create; no radar UI lives in the popup.

const html = readFileSync(
  join(process.cwd(), "entrypoints/popup/index.html"),
  "utf8",
);

describe("popup radar entry point", () => {
  it("exposes an Open Radar button next to Settings in the markup", () => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const button = doc.querySelector<HTMLButtonElement>("#radar");
    expect(button).not.toBeNull();
    expect(button!.textContent?.trim()).toBe("Open Radar");
    expect(button!.classList.contains("quiet")).toBe(true);
    expect(button!.previousElementSibling?.id).toBe("settings");
  });

  it("opens /radar.html in a new tab when clicked", async () => {
    fakeBrowser.reset();
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.innerHTML = parsed.body.innerHTML;
    // Keep init()'s 1s refresh loop from outliving the test.
    vi.spyOn(window, "setInterval").mockReturnValue(0);
    const create = vi.spyOn(fakeBrowser.tabs, "create");

    await import("../entrypoints/popup/main");
    document.querySelector<HTMLButtonElement>("#radar")!.click();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      url: fakeBrowser.runtime.getURL("/radar.html"),
    });
    expect(create.mock.calls[0]![0].url).toMatch(/\/radar\.html$/);
  });
});
