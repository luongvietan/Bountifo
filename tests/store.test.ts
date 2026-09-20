import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  commitUnit,
  getAllRecords,
  getBlob,
  getUnitResults,
  openStore,
  purgeJob,
  verifyJobData,
} from "../lib/job/store";
import type { SourceRecord } from "../lib/types";

const record: SourceRecord = {
  sourceKey: "dom:details:name",
  sourceType: "dom",
  sourceLevel: "page_header",
  sourceUrl: "https://bugcrowd.com/engagements/acme",
  authenticated: true,
  locator: { section: "Details" },
  quote: "Acme",
  extractionStatus: "exact",
};

describe("job store", () => {
  it("commits cross-store writes atomically and overwrites a repeated unit", async () => {
    const db = await openStore();
    const jobId = `job_store_${crypto.randomUUID()}`;
    await commitUnit(
      db,
      jobId,
      "u03_collect_details",
      { records: [record], blob: { kind: "detailsData", value: { name: "Acme" } } },
      { unitId: "u03_collect_details", status: "ok", committedAt: "t1" },
    );
    await commitUnit(
      db,
      jobId,
      "u03_collect_details",
      { records: [record], blob: { kind: "detailsData", value: { name: "Acme 2" } } },
      { unitId: "u03_collect_details", status: "warning", committedAt: "t2" },
    );
    expect(await getUnitResults(db, jobId)).toEqual([
      { unitId: "u03_collect_details", status: "warning", committedAt: "t2" },
    ]);
    expect(await getAllRecords(db, jobId)).toEqual([record]);
    expect(await getBlob(db, jobId, "detailsData")).toEqual({ name: "Acme 2" });
    expect(await verifyJobData(db, jobId, ["u03_collect_details", "detailsData"])).toEqual({ ok: true, missing: [] });
    await purgeJob(db, jobId);
    expect(await verifyJobData(db, jobId, ["u03_collect_details", "detailsData"])).toEqual({
      ok: false,
      missing: ["u03_collect_details", "detailsData"],
    });
    db.close();
  });

  it("reports every missing unit/blob checkpoint", async () => {
    const db = await openStore();
    const jobId = `job_missing_${crypto.randomUUID()}`;
    expect(await verifyJobData(db, jobId, ["u05_collect_targets", "targetsData"])).toEqual({
      ok: false,
      missing: ["u05_collect_targets", "targetsData"],
    });
    db.close();
  });
});
