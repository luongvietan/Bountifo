import { JSDOM } from "jsdom";
import { expect } from "vitest";
import type { SourceLevel, SourceRecord } from "../../lib/types";

import activityHtml from "../fixtures/dom/activity.html?raw";
import activityPage2Html from "../fixtures/dom/activity-page2.html?raw";
import detailsHtml from "../fixtures/dom/details.html?raw";
import kiMismatchHtml from "../fixtures/dom/ki-mismatch.html?raw";
import kiMultiHtml from "../fixtures/dom/ki-multi.html?raw";
import kiOneHtml from "../fixtures/dom/ki-one.html?raw";
import kiZeroHtml from "../fixtures/dom/ki-zero.html?raw";
import policiesHtml from "../fixtures/dom/policies.html?raw";
import sessionExpiredHtml from "../fixtures/dom/session-expired.html?raw";
import targetsHtml from "../fixtures/dom/targets.html?raw";
import targetsNestedCandidateHtml from "../fixtures/dom/targets-nested-candidate.html?raw";
import targetsWrapperHtml from "../fixtures/dom/targets-wrapper.html?raw";

export const PAGE_URL = "https://bugcrowd.com/engagements/acme-bb";

const FIXTURES: Record<string, string> = {
  "activity.html": activityHtml,
  "activity-page2.html": activityPage2Html,
  "details.html": detailsHtml,
  "ki-mismatch.html": kiMismatchHtml,
  "ki-multi.html": kiMultiHtml,
  "ki-one.html": kiOneHtml,
  "ki-zero.html": kiZeroHtml,
  "policies.html": policiesHtml,
  "session-expired.html": sessionExpiredHtml,
  "targets.html": targetsHtml,
  "targets-nested-candidate.html": targetsNestedCandidateHtml,
  "targets-wrapper.html": targetsWrapperHtml,
};

/** Loads a sanitized DOM fixture into a full jsdom Document. */
export function loadDoc(name: string, url: string = PAGE_URL): Document {
  const html = FIXTURES[name];
  if (html === undefined) throw new Error(`unknown fixture: ${name}`);
  return new JSDOM(html, { url }).window.document;
}

const LEVELS = new Set<SourceLevel>([
  "page_header",
  "target_specific_rule",
  "explicit_program_rule",
  "announcement",
  "vrt_deviation",
  "default_vrt",
  "known_issue_note",
  "api_field",
]);

const STATUSES = new Set(["exact", "partial", "failed"]);

/** Every SourceRecord must carry a non-empty sourceKey + quote and a valid level/status. */
export function assertRecordsWellFormed(records: SourceRecord[]): void {
  expect(records.length).toBeGreaterThan(0);
  for (const r of records) {
    expect(typeof r.sourceKey).toBe("string");
    expect(r.sourceKey.length).toBeGreaterThan(0);
    expect(typeof r.quote).toBe("string");
    expect(r.quote.trim().length).toBeGreaterThan(0);
    expect(LEVELS.has(r.sourceLevel)).toBe(true);
    expect(STATUSES.has(r.extractionStatus)).toBe(true);
    expect(r.sourceType).toBe("dom");
    expect(r.authenticated).toBe(true);
    expect(typeof r.sourceUrl).toBe("string");
    expect(r.sourceUrl.length).toBeGreaterThan(0);
  }
}
