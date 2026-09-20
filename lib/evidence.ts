import {
  canonicalJson,
  canonicalLocator,
  canonicalUrl,
  normalizeText,
} from "./canonical";
import {
  EVIDENCE_SCHEMA_VERSION,
  PARSER_VERSION,
  SOURCE_TYPE_ORDER,
} from "./constants";
import { prefixedId, sha256Hex } from "./hash";
import type {
  Evidence,
  SourceLevel,
  SourceLocator,
  SourceRecord,
  SourceType,
} from "./types";

/**
 * Spec §9 hash preimage. Contains EXACTLY these fields — collection time,
 * parser runtime/version, job id, Promise completion order, and volatile DOM
 * ids are excluded, so the same statement at the same logical authenticated
 * source always produces the same id/content_hash.
 */
export interface EvidenceHashInputV1 {
  schema_version: number;
  source_type: SourceType;
  source_authenticated: boolean;
  canonical_source_url: string;
  source_key: string;
  source_level: SourceLevel;
  canonical_locator: SourceLocator;
  normalized_quote: string;
}

/**
 * Locator restricted to the stable semantic fields of SourceLocator with
 * undefined fields dropped. Any extra (volatile) keys a collector may have
 * smuggled in are excluded — they never reach the hash preimage or the
 * emitted evidence object.
 */
function definedLocator(loc: SourceLocator): SourceLocator {
  const out: SourceLocator = {};
  if (loc.section !== undefined) out.section = loc.section;
  if (loc.subsection !== undefined) out.subsection = loc.subsection;
  if (loc.targetId !== undefined) out.targetId = loc.targetId;
  if (loc.table !== undefined) out.table = loc.table;
  if (loc.pageIndex !== undefined) out.pageIndex = loc.pageIndex;
  if (loc.rowIndex !== undefined) out.rowIndex = loc.rowIndex;
  return out;
}

/**
 * Spec §9 `EvidenceHashInputV1` preimage object for a record whose source URL
 * has already been canonicalized (see buildEvidence).
 */
export function evidenceHashInputV1(
  rec: SourceRecord,
  canonicalSourceUrl: string,
): EvidenceHashInputV1 {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_type: rec.sourceType,
    source_authenticated: rec.authenticated,
    canonical_source_url: canonicalSourceUrl,
    source_key: rec.sourceKey,
    source_level: rec.sourceLevel,
    canonical_locator: definedLocator(rec.locator),
    normalized_quote: normalizeText(rec.quote),
  };
}

/**
 * Build content-addressed evidence: canonicalize url+locator+quote, hash the
 * canonical preimage, id = `ev_`+first12hex, content_hash = `sha256:`+digest.
 * Per-record work is independent, so Promise completion order cannot affect
 * the result; collected_at is stamped but never hashed.
 */
export async function buildEvidence(
  records: SourceRecord[],
  opts: { collectedAt: string },
): Promise<Evidence[]> {
  return Promise.all(
    records.map(async (rec) => {
      let url: string;
      try {
        url = canonicalUrl(rec.sourceUrl);
      } catch {
        // Unparseable source URL (untrusted DOM data): keep the raw string so
        // hashing stays deterministic instead of throwing mid-collection.
        url = normalizeText(rec.sourceUrl);
      }
      const input = evidenceHashInputV1(rec, url);
      const digest = await sha256Hex(canonicalJson(input));
      return {
        id: prefixedId("ev", digest, 12),
        source_key: rec.sourceKey,
        source: { url, type: rec.sourceType, authenticated: rec.authenticated },
        locator: input.canonical_locator,
        source_level: rec.sourceLevel,
        collected_at: opts.collectedAt,
        quote: input.normalized_quote,
        content_hash: `sha256:${digest}`,
        extraction: {
          status: rec.extractionStatus,
          parser_version: PARSER_VERSION,
        },
      };
    }),
  );
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sourceTypeRank(t: SourceType): number {
  const i = SOURCE_TYPE_ORDER.indexOf(t);
  return i === -1 ? SOURCE_TYPE_ORDER.length : i;
}

/**
 * Spec §14 corpus order: fixed source-type order (api, then dom), then
 * source_key, then canonical-locator JSON, then evidence id. Returns a new
 * array; the input is not mutated. Codepoint-order comparisons keep the sort
 * locale-independent and fully deterministic.
 */
export function sortEvidenceForCorpus(evs: Evidence[]): Evidence[] {
  return [...evs].sort(
    (a, b) =>
      sourceTypeRank(a.source.type) - sourceTypeRank(b.source.type) ||
      cmpStr(a.source_key, b.source_key) ||
      cmpStr(canonicalLocator(a.locator), canonicalLocator(b.locator)) ||
      cmpStr(a.id, b.id),
  );
}

/** Project an Evidence back to its hash-input shape (volatile fields removed). */
function hashInputProjection(ev: Evidence): EvidenceHashInputV1 {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_type: ev.source.type,
    source_authenticated: ev.source.authenticated,
    canonical_source_url: ev.source.url,
    source_key: ev.source_key,
    source_level: ev.source_level,
    canonical_locator: definedLocator(ev.locator),
    normalized_quote: ev.quote,
  };
}

/**
 * `sha256:`+hex over canonicalJson of the corpus-sorted evidence projected
 * back to EvidenceHashInputV1 form (collected_at excluded). Independent of
 * asynchronous collection completion order.
 */
export async function evidenceCorpusHash(evs: Evidence[]): Promise<string> {
  const projection = sortEvidenceForCorpus(evs).map(hashInputProjection);
  return `sha256:${await sha256Hex(canonicalJson(projection))}`;
}

/**
 * `sha256:`+hex over canonicalJson of a model. The caller strips volatile
 * fields (export timestamp, job id, progress state) beforehand.
 */
export async function normalizedHash(model: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(model))}`;
}
