import { ApiError } from "../api/errors";

// ---------------------------------------------------------------------------
// Radar V1.3 changelog history — parses the version list served at
//   GET /engagements/<slug>/changelog.json?page=N
// and selects the diff baseline consumed by the semantic differ
// (lib/radar/diff.ts).
//
// Verified live 2026-09-22: the list is newest-first, `changelogState` is
// "Latest" on the current version and null elsewhere, and `tags` is a
// comma-separated vocabulary ("brief", "targets", "migration" — any order,
// possibly empty/null) marking which document aspects a version touched.
// Every listed id is fetchable at changelog/<id>.json with the identical
// brief-doc shape, so the baseline below names a real diffable document.
//
// Strict parsing: a malformed ENVELOPE throws ApiError("invalid_response")
// (the hydration catch maps it to enrichment "failed"). Individual entries
// that can't be identified are skipped — a corrupt row must not fail the
// whole history. Nothing is fabricated: unknown fields stay null/[] and
// baseline selection returns null rather than guessing a pairing.
//
// Pure module: no network, no storage, no Date.now(), no randomness.
// ---------------------------------------------------------------------------

/** One changelog list entry — the fields the differ's baseline policy reads. */
export interface RadarChangelogEntry {
  id: string;
  publishedAt: string | null;
  /** Parsed `tags` (comma-separated upstream; may legitimately be empty). */
  tags: string[];
  /** Raw `changelogState` — "Latest" marks the current version. */
  state: string | null;
  publishedBy: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** "targets,brief" → ["targets","brief"]; non-string/empty → []. */
function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

/**
 * Parses the changelog list envelope. Throws ApiError("invalid_response")
 * when `raw` isn't an object carrying a `changelogs` array — that is a
 * broken endpoint contract, not "no history". An empty array parses to an
 * empty list (the caller decides what zero history means). Entries without
 * a usable string id are skipped, never repaired.
 */
export function parseChangelogList(raw: unknown): RadarChangelogEntry[] {
  const root = asRecord(raw);
  const list = root === null ? undefined : root.changelogs;
  if (!Array.isArray(list)) {
    throw new ApiError(
      "invalid_response",
      "changelog response missing changelogs array",
    );
  }
  const out: RadarChangelogEntry[] = [];
  for (const item of list) {
    const e = asRecord(item);
    if (e === null) continue;
    const id = asString(e.id);
    if (id === null) continue; // unidentifiable entry — skipped, not fatal
    out.push({
      id,
      publishedAt: asString(e.publishedAt),
      tags: parseTags(e.tags),
      state: asString(e.changelogState),
      publishedBy: asString(e.publishedBy),
    });
  }
  return out;
}

/**
 * Baseline = the version immediately BEFORE the current one in newest-first
 * list order — the diff answers "what did the latest publish change".
 *
 *   latestId found at index i  → entries[i+1].id; null when Latest is the
 *                                oldest entry (no earlier version exists).
 *   latestId null/empty        → fallback: predecessor of entries[0]. The
 *                                head is treated as current because the list
 *                                is newest-first even when no entry carries
 *                                the "Latest" tag.
 *   latestId set but absent    → null. An asserted current version that the
 *                                list doesn't contain (pagination drift,
 *                                stale id) must never be silently paired
 *                                with an arbitrary older entry — that would
 *                                fabricate a baseline.
 *   fewer than 2 entries       → null (no baseline exists).
 */
export function selectDiffBaseline(
  entries: RadarChangelogEntry[],
  latestId: string | null,
): string | null {
  if (!Array.isArray(entries) || entries.length < 2) return null;
  if (typeof latestId === "string" && latestId !== "") {
    const idx = entries.findIndex((e) => e.id === latestId);
    if (idx === -1) return null;
    return entries[idx + 1]?.id ?? null;
  }
  return entries[1]?.id ?? null;
}

/**
 * True when the entry's tags mark a scope-document change ("targets"). A
 * "brief"-only version is a wording/administrative edit candidate — the
 * semantic diff decides what actually changed; this is only a cheap
 * pre-fetch signal for callers that want one.
 */
export function entryTouchesTargets(entry: RadarChangelogEntry): boolean {
  return entry.tags.some((t) => t.toLowerCase() === "targets");
}
