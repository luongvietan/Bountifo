import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  clearDescriptor,
  newDescriptor,
  patchDescriptor,
  readDescriptor,
  writeDescriptor,
} from "../lib/job/descriptor";
import { UNIT_ORDER } from "../lib/job/units";

beforeEach(() => fakeBrowser.reset());

describe("job descriptor", () => {
  it("round-trips, patches, and clears the active checkpoint", async () => {
    const descriptor = newDescriptor(7, "acme", "https://bugcrowd.com/engagements/acme");
    expect(descriptor.jobId).toMatch(/^job_[0-9a-f-]{8}$/i);
    expect(descriptor.pendingUnits).toEqual(UNIT_ORDER);
    await writeDescriptor(descriptor);
    expect(await readDescriptor()).toEqual(descriptor);
    const patched = await patchDescriptor({ currentUnit: "u03_collect_details", warnings: 2 });
    expect(patched).toMatchObject({ currentUnit: "u03_collect_details", warnings: 2 });
    await clearDescriptor();
    expect(await readDescriptor()).toBeNull();
  });

  it("never persists credential-shaped fields", async () => {
    const descriptor = newDescriptor(7, "acme", "https://bugcrowd.com/engagements/acme");
    await writeDescriptor(descriptor);
    const serialized = JSON.stringify(await readDescriptor());
    expect(serialized).not.toMatch(/token|authorization|credential/i);
  });
});
