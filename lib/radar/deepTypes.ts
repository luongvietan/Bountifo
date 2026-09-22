import { z } from "zod";

/**
 * Radar V1.3 deep-enrichment contract — the shared boundary between the
 * Known Issues collector (lib/radar/knownIssues.ts), the changelog semantic
 * differ (lib/radar/diff.ts + history.ts), the feature extractor, and the UI.
 *
 * Deep data arrives via the run's deep_enriching stage over a Top-N shortlist
 * only. Programs without a deep pass keep `snapshot.deep` absent/null and
 * their derived signals stay null ("not_deep_analyzed") — missing deep data
 * is never coerced into 0 or "no issues".
 *
 * No timestamps live here by design: `stored_at` on the snapshot row is the
 * bookkeeping of record, so every field below can enter `source_hash`
 * without leaking volatile data.
 */

const nonNegativeInt = z.number().int().min(0);

/** Aggregate Known Issues summary for one engagement. */
export const radarKnownIssueSummarySchema = z
  .object({
    /**
     * complete    — the endpoint answered and parsed (a real 0 counts).
     * unavailable — the feature is absent for this program (e.g.
     *               knownIssuesEnabled false, 401/403/404, login redirect).
     * failed      — fetch or parse failed; counts are unknown, not zero.
     */
    status: z.enum(["complete", "unavailable", "failed"]),
    unique_count: nonNegativeInt.nullable(),
    total_count: nonNegativeInt.nullable(),
    /**
     * Optional VRT category breakdown — populated only when a per-group
     * stats source is wired. V1.3 uses the engagement aggregate, so this is
     * normally absent.
     */
    categories: z
      .array(
        z
          .object({
            category: z.string().min(1),
            unique: nonNegativeInt.nullable(),
            total: nonNegativeInt.nullable(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  // complete ⇒ real counts; anything else ⇒ counts stay null. A summary
  // claiming "complete" without counts is fabricated — reject it outright.
  .superRefine((s, ctx) => {
    const complete = s.status === "complete";
    if (complete !== (s.unique_count !== null && s.total_count !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "status/counts mismatch: complete requires counts",
      });
    }
  });
export type RadarKnownIssueSummary = z.infer<
  typeof radarKnownIssueSummarySchema
>;

/**
 * Structured facts from diffing the current brief document against a
 * previous changelog version. Every fact field is null unless
 * status === "complete": "unavailable" (fetch/parse failure) and
 * "no_baseline" (single-version history — nothing to diff against) both
 * mean the facts are UNKNOWN, never zero. A null field must never read as
 * "no change".
 */
export const radarSemanticDiffSchema = z
  .object({
    status: z.enum(["complete", "unavailable", "no_baseline"]),
    /** Previous changelog version id diffed against — null when none. */
    from_version: z.string().min(1).nullable(),
    /** Current ("Latest") changelog version id. */
    to_version: z.string().min(1).nullable(),
    added_targets: nonNegativeInt.nullable(),
    removed_targets: nonNegativeInt.nullable(),
    added_in_scope_targets: nonNegativeInt.nullable(),
    removed_in_scope_targets: nonNegativeInt.nullable(),
    moved_in_scope: nonNegativeInt.nullable(),
    moved_out_of_scope: nonNegativeInt.nullable(),
    added_api_targets: nonNegativeInt.nullable(),
    added_web_targets: nonNegativeInt.nullable(),
    added_groups: nonNegativeInt.nullable(),
    reward_increase: z.boolean().nullable(),
    reward_decrease: z.boolean().nullable(),
    safe_harbor_changed: z.boolean().nullable(),
    status_changed: z.boolean().nullable(),
    /**
     * complete diff whose only deltas are non-structural (text, timestamps,
     * administrative metadata) — the "wording edit" case freshness cannot
     * distinguish from real scope change.
     */
    only_administrative_changes: z.boolean().nullable(),
  })
  .strict()
  // complete ⇒ every fact is a real value; unavailable/no_baseline ⇒ every
  // fact stays null. A "complete" diff with null facts is fabricated.
  .superRefine((d, ctx) => {
    const facts = [
      d.added_targets,
      d.removed_targets,
      d.added_in_scope_targets,
      d.removed_in_scope_targets,
      d.moved_in_scope,
      d.moved_out_of_scope,
      d.added_api_targets,
      d.added_web_targets,
      d.added_groups,
      d.reward_increase,
      d.reward_decrease,
      d.safe_harbor_changed,
      d.status_changed,
      d.only_administrative_changes,
    ];
    const allKnown = facts.every((f) => f !== null);
    const allNull = facts.every((f) => f === null);
    const ok = d.status === "complete" ? allKnown : allNull;
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        message: "status/facts mismatch: complete requires all facts",
      });
    }
  });
export type RadarSemanticDiff = z.infer<typeof radarSemanticDiffSchema>;

/**
 * One program's deep-enrichment outcome. "partial" = exactly one source
 * completed; "complete" = both did. The sub-objects carry their own status,
 * so consumers read them, never the envelope, for data truth.
 */
export const radarDeepEnrichmentSchema = z
  .object({
    status: z.enum(["complete", "partial", "unavailable", "failed"]),
    known_issues: radarKnownIssueSummarySchema.nullable(),
    semantic_diff: radarSemanticDiffSchema.nullable(),
  })
  .strict();
export type RadarDeepEnrichment = z.infer<typeof radarDeepEnrichmentSchema>;
