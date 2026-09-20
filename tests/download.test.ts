import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMarkdown } from "../lib/download";

describe("downloadMarkdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads UTF-8 Markdown through a deterministic data URL", async () => {
    const download = vi
      .spyOn(browser.downloads, "download")
      .mockResolvedValue(7);

    await downloadMarkdown("bugcrowd-acme-2026-09-20.md", "hello ✓");

    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith({
      url: "data:text/markdown;charset=utf-8;base64,aGVsbG8g4pyT",
      filename: "bugcrowd-acme-2026-09-20.md",
      saveAs: false,
      conflictAction: "uniquify",
    });
  });
});
