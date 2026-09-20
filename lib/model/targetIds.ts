import { canonicalJson, normalizeText } from "../canonical";
import { sha256Hex } from "../hash";
import type { IdentityQuality } from "../types";

export interface TargetIdentity {
  id: string;
  id_source: "api" | "derived";
  identity_quality: IdentityQuality;
  duplicate_disambiguated: boolean;
}

/**
 * Identity inputs gathered from API targets and DOM targets. `groupKey` is
 * group membership — spec §10: membership is a property/reference, never part
 * of target identity (moving groups must not mint a new id).
 */
export interface TargetIdentityInput {
  apiId?: string | null;
  location: string | null;
  name: string | null;
  type: string | null;
  groupKey?: string | null;
}

/** normalizeText, treating null/undefined/empty-after-normalize as absent. */
function norm(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const n = normalizeText(s);
  return n === "" ? null : n;
}

const hasApiId = (t: TargetIdentityInput): t is TargetIdentityInput & { apiId: string } =>
  t.apiId !== null && t.apiId !== undefined && t.apiId !== "";

/**
 * Assign stable target identities (spec §10).
 *
 * - apiId present → passthrough `{id: apiId, id_source: "api", identity_quality: "api"}`.
 * - Otherwise a derived id `target_`+8hex of the canonical preimage
 *   `{schema_version:1, engagement, location, type, occurrence?}` where
 *   `location` is the canonical exact location, or the explicit name as the
 *   documented lower-quality fallback (identity_quality exact_location vs
 *   name_fallback). `groupKey` is never in the preimage.
 * - When the same canonical location/name + type occurs more than once the
 *   duplicates are sorted canonically (by canonical location/name/type JSON)
 *   and occurrence=1..n is added to the preimage; those identities are marked
 *   identity_quality "duplicate_disambiguated".
 *
 * Output is index-aligned with the input and deterministic across input
 * order.
 */
export async function assignTargetIdentities(
  targets: TargetIdentityInput[],
  engagementId: string,
): Promise<TargetIdentity[]> {
  // Identity basis: canonical location, else canonical name (documented
  // lower-quality fallback). `type` is the stable category discriminator.
  const basis = targets.map((t) =>
    hasApiId(t) ? null : (norm(t.location) ?? norm(t.name)),
  );
  const typeNorm = targets.map((t) => norm(t.type));

  // Group derived targets by identity key to find duplicates.
  const groups = new Map<string, number[]>();
  targets.forEach((t, i) => {
    if (hasApiId(t)) return;
    const key = canonicalJson({ location: basis[i], type: typeNorm[i] });
    const members = groups.get(key);
    if (members === undefined) groups.set(key, [i]);
    else members.push(i);
  });

  // Duplicates get a deterministic occurrence discriminator after canonical
  // sorting. Sort key covers every identity-relevant field (normalized
  // location, name, type) so occurrence assignment is input-order
  // independent; groupKey is deliberately excluded. Targets tied on all
  // fields are identity-indistinguishable, so their relative order is
  // irrelevant to the emitted id multiset.
  const occurrence = new Map<number, number>();
  const sortKeyOf = (i: number): string =>
    canonicalJson({
      location: norm(targets[i]!.location),
      name: norm(targets[i]!.name),
      type: typeNorm[i],
    });
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => {
      const ka = sortKeyOf(a);
      const kb = sortKeyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    sorted.forEach((idx, pos) => occurrence.set(idx, pos + 1));
  }

  return Promise.all(
    targets.map(async (t, i): Promise<TargetIdentity> => {
      if (hasApiId(t)) {
        return {
          id: t.apiId,
          id_source: "api",
          identity_quality: "api",
          duplicate_disambiguated: false,
        };
      }
      const occ = occurrence.get(i); // undefined for non-duplicates → dropped
      const preimage = canonicalJson({
        schema_version: 1,
        engagement: engagementId,
        location: basis[i],
        type: typeNorm[i],
        occurrence: occ,
      });
      const digest = await sha256Hex(preimage);
      const dup = occ !== undefined;
      const quality: IdentityQuality = dup
        ? "duplicate_disambiguated"
        : norm(t.location) !== null
          ? "exact_location"
          : "name_fallback";
      return {
        id: `target_${digest.slice(0, 8)}`,
        id_source: "derived",
        identity_quality: quality,
        duplicate_disambiguated: dup,
      };
    }),
  );
}
