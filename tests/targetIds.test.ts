import { describe, expect, it } from "vitest";
import {
  assignTargetIdentities,
  type TargetIdentityInput,
} from "../lib/model/targetIds";

const ENG = "engagement-uuid-1234";

function t(overrides: Partial<TargetIdentityInput> = {}): TargetIdentityInput {
  return {
    apiId: null,
    location: null,
    name: null,
    type: null,
    groupKey: null,
    ...overrides,
  };
}

/** Deterministic shuffle (LCG) for input-order determinism checks. */
function shuffled<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

describe("assignTargetIdentities — api passthrough", () => {
  it("passes apiId through untouched with api quality", async () => {
    const [id] = await assignTargetIdentities(
      [
        t({
          apiId: "c1f2e3d4-uuid",
          location: "https://a.example.com",
          name: "A",
          type: "website",
          groupKey: "g1",
        }),
      ],
      ENG,
    );
    expect(id).toEqual({
      id: "c1f2e3d4-uuid",
      id_source: "api",
      identity_quality: "api",
      duplicate_disambiguated: false,
    });
  });
});

describe("assignTargetIdentities — derived ids", () => {
  it("derives target_+8hex ids with exact_location quality when location exists", async () => {
    const [id] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", name: "A", type: "website" })],
      ENG,
    );
    expect(id!.id).toMatch(/^target_[0-9a-f]{8}$/);
    expect(id!.id_source).toBe("derived");
    expect(id!.identity_quality).toBe("exact_location");
    expect(id!.duplicate_disambiguated).toBe(false);
  });

  it("falls back to name with name_fallback quality when no location", async () => {
    const [id] = await assignTargetIdentities(
      [t({ name: "Acme iOS App", type: "mobile_app" })],
      ENG,
    );
    expect(id!.id).toMatch(/^target_[0-9a-f]{8}$/);
    expect(id!.identity_quality).toBe("name_fallback");
  });

  it("prefers location over name for the identity basis", async () => {
    const [withName] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", name: "Different name" })],
      ENG,
    );
    const [withoutName] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", name: null })],
      ENG,
    );
    // name is not part of identity when a location exists
    expect(withName!.id).toBe(withoutName!.id);
  });

  it("normalizes identity basis (whitespace / NFC) before hashing", async () => {
    const [a] = await assignTargetIdentities(
      [t({ location: "  https://a.example.com   ", type: "website" })],
      ENG,
    );
    const [b] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", type: "website" })],
      ENG,
    );
    expect(a!.id).toBe(b!.id);
    // NFC: NFD "é" (e + combining acute) equals precomposed "é"
    const [nfd] = await assignTargetIdentities(
      [t({ location: "https://café.example.com", type: "website" })],
      ENG,
    );
    const [nfc] = await assignTargetIdentities(
      [t({ location: "https://café.example.com", type: "website" })],
      ENG,
    );
    expect(nfd!.id).toBe(nfc!.id);
  });

  it("scopes identity to the engagement", async () => {
    const target = t({ location: "https://a.example.com", type: "website" });
    const [a] = await assignTargetIdentities([target], "eng-1");
    const [b] = await assignTargetIdentities([target], "eng-2");
    expect(a!.id).not.toBe(b!.id);
  });

  it("never includes groupKey in the preimage — moving groups keeps the id", async () => {
    const [g1] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", type: "website", groupKey: "group:a" })],
      ENG,
    );
    const [g2] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", type: "website", groupKey: "group:b" })],
      ENG,
    );
    const [g3] = await assignTargetIdentities(
      [t({ location: "https://a.example.com", type: "website", groupKey: null })],
      ENG,
    );
    expect(g1!.id).toBe(g2!.id);
    expect(g1!.id).toBe(g3!.id);
  });

  it("discriminates on type", async () => {
    const [web] = await assignTargetIdentities(
      [t({ location: "a.example.com", type: "website" })],
      ENG,
    );
    const [api] = await assignTargetIdentities(
      [t({ location: "a.example.com", type: "api" })],
      ENG,
    );
    expect(web!.id).not.toBe(api!.id);
  });
});

describe("assignTargetIdentities — duplicates", () => {
  it("disambiguates identical location+type into distinct deterministic ids", async () => {
    const targets = [
      t({ location: "https://a.example.com", name: "A", type: "website" }),
      t({ location: "https://a.example.com", name: "B", type: "website" }),
    ];
    const ids = await assignTargetIdentities(targets, ENG);
    expect(ids[0]!.id).not.toBe(ids[1]!.id);
    expect(ids[0]!.identity_quality).toBe("duplicate_disambiguated");
    expect(ids[1]!.identity_quality).toBe("duplicate_disambiguated");
    expect(ids[0]!.duplicate_disambiguated).toBe(true);
    expect(ids[1]!.duplicate_disambiguated).toBe(true);

    // Same identity ⇒ same id as a singleton would NOT hold (occurrence in preimage)
    const [solo] = await assignTargetIdentities([targets[0]!], ENG);
    expect(ids.map((i) => i.id)).not.toContain(solo!.id);
  });

  it("assigns occurrences deterministically across input order (name tiebreak)", async () => {
    const targets = [
      t({ location: "https://a.example.com", name: "Alpha", type: "website" }),
      t({ location: "https://a.example.com", name: "Beta", type: "website" }),
      t({ location: "https://a.example.com", name: "Gamma", type: "website" }),
    ];
    const reference = await assignTargetIdentities(targets, ENG);
    const byName = (ids: typeof reference, list: typeof targets) =>
      new Map(list.map((tgt, i) => [tgt.name, ids[i]!.id]));
    const ref = byName(reference, targets);
    for (let seed = 1; seed <= 10; seed++) {
      const idx = shuffled(targets.map((_, i) => i), seed * 31);
      const permuted = idx.map((i) => targets[i]!);
      const ids = await assignTargetIdentities(permuted, ENG);
      const got = byName(ids, permuted);
      for (const name of ["Alpha", "Beta", "Gamma"]) {
        expect(got.get(name)).toBe(ref.get(name));
      }
    }
  });

  it("produces a stable id multiset for indistinguishable twins", async () => {
    const twins = [
      t({ location: "https://a.example.com", type: "website", groupKey: "g1" }),
      t({ location: "https://a.example.com", type: "website", groupKey: "g2" }),
    ];
    const ref = (await assignTargetIdentities(twins, ENG))
      .map((i) => i.id)
      .sort();
    expect(ref[0]).not.toBe(ref[1]);
    for (let seed = 1; seed <= 5; seed++) {
      const permuted = shuffled(twins, seed);
      const got = (await assignTargetIdentities(permuted, ENG))
        .map((i) => i.id)
        .sort();
      expect(got).toEqual(ref);
    }
  });

  it("does not mark non-duplicate derived ids as disambiguated", async () => {
    const ids = await assignTargetIdentities(
      [
        t({ location: "https://a.example.com", type: "website" }),
        t({ location: "https://b.example.com", type: "website" }),
        t({ location: "https://a.example.com", type: "api" }),
      ],
      ENG,
    );
    expect(ids.every((i) => !i.duplicate_disambiguated)).toBe(true);
    expect(new Set(ids.map((i) => i.id)).size).toBe(3);
    expect(ids[2]!.identity_quality).toBe("exact_location");
  });
});

describe("assignTargetIdentities — mixed + edge cases", () => {
  it("handles mixed api + derived targets, output index-aligned", async () => {
    const ids = await assignTargetIdentities(
      [
        t({ location: "https://a.example.com", type: "website" }),
        t({ apiId: "uuid-9", location: "https://b.example.com" }),
        t({ name: "Only name" }),
      ],
      ENG,
    );
    expect(ids).toHaveLength(3);
    expect(ids[0]!.id_source).toBe("derived");
    expect(ids[1]).toEqual({
      id: "uuid-9",
      id_source: "api",
      identity_quality: "api",
      duplicate_disambiguated: false,
    });
    expect(ids[2]!.identity_quality).toBe("name_fallback");
  });

  it("still produces a deterministic id when both location and name are absent", async () => {
    const [a] = await assignTargetIdentities([t({ type: "website" })], ENG);
    const [b] = await assignTargetIdentities([t({ type: "website" })], ENG);
    expect(a!.id).toMatch(/^target_[0-9a-f]{8}$/);
    expect(a!.id).toBe(b!.id);
    expect(a!.identity_quality).toBe("name_fallback");
  });
});
