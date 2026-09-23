import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  radarExportContentHash,
  serializeRadarExport,
  type RadarExportFormat,
} from "../lib/radar/export";
import { sampleRadarExportData } from "./fixtures/radar-export-sample";

// ---------------------------------------------------------------------------
// docs/samples guard — the checked-in sample reports must stay byte-identical
// to the deterministic fixture (tests/fixtures/radar-export-sample.ts).
// Regenerate after an intentional format/fixture change:
//   WRITE_SAMPLES=1 npx vitest run tests/radar-samples.test.ts
// Line endings are normalized so CRLF checkouts don't produce false diffs.
// ---------------------------------------------------------------------------

const SAMPLES_DIR = fileURLToPath(new URL("../docs/samples", import.meta.url));
const WRITE = process.env.WRITE_SAMPLES === "1";

const FORMATS: [RadarExportFormat, string][] = [
  ["markdown", "radar-report.md"],
  ["json", "radar-report.json"],
  ["csv", "radar-report.csv"],
];

const norm = (s: string) => s.replace(/\r\n/g, "\n");

describe("docs/samples golden reports", () => {
  for (const [format, file] of FORMATS) {
    it(`${file} matches the serialized fixture`, async () => {
      const { body } = await serializeRadarExport(
        sampleRadarExportData(),
        format,
      );
      const path = join(SAMPLES_DIR, file);
      if (WRITE) {
        mkdirSync(SAMPLES_DIR, { recursive: true });
        writeFileSync(path, body);
        return;
      }
      expect(norm(body)).toBe(norm(readFileSync(path, "utf8")));
    });
  }

  it("serializing the same fixture twice is byte-identical", async () => {
    for (const [format] of FORMATS) {
      const a = await serializeRadarExport(sampleRadarExportData(), format);
      const b = await serializeRadarExport(sampleRadarExportData(), format);
      expect(a.body).toBe(b.body);
      expect(a.content_hash).toBe(b.content_hash);
      expect(a.filename).toBe(b.filename);
    }
  });

  it("content hash is format-independent", async () => {
    const expected = await radarExportContentHash(sampleRadarExportData());
    for (const [format] of FORMATS) {
      const { content_hash } = await serializeRadarExport(
        sampleRadarExportData(),
        format,
      );
      expect(content_hash).toBe(expected);
    }
  });
});
