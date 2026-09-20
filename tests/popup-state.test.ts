import { describe, expect, it } from "vitest";
import { newDescriptor } from "../lib/job/descriptor";
import { viewFor } from "../lib/ui/popupState";

const URL = "https://bugcrowd.com/engagements/acme";

describe("viewFor", () => {
  it("disables export outside a supported engagement", () => {
    expect(viewFor("https://example.com", null).canExport).toBe(false);
    expect(viewFor(null, null).canExport).toBe(false);
  });

  it("enables export on a supported engagement with no active job", () => {
    expect(viewFor(URL, null).canExport).toBe(true);
  });

  it("shows active progress and independent health lines", () => {
    const job = newDescriptor(7, "acme", URL);
    job.phase = "processing";
    job.counters = { unitDone: 8, unitTotal: 13, kiDone: 2, kiTotal: 4 };
    job.warnings = 3;
    job.unresolvedConflicts = 1;
    const view = viewFor(URL, job);
    expect(view.canExport).toBe(false);
    expect(view.statusLines).toEqual([
      { label: "Phase", value: "Processing" },
      { label: "Progress", value: "8/13 units" },
      { label: "Known Issues", value: "2/4" },
      { label: "Warnings", value: "3" },
      { label: "Conflicts", value: "1" },
    ]);
  });

  it.each(["done", "failed", "cancelled"] as const)(
    "re-enables export after a %s job",
    (phase) => {
      const job = newDescriptor(7, "acme", URL);
      job.phase = phase;
      expect(viewFor(URL, job).canExport).toBe(true);
    },
  );
});
