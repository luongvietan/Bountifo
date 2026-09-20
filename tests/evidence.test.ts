import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalLocator, canonicalUrl } from "../lib/canonical";
import { EVIDENCE_SCHEMA_VERSION, PARSER_VERSION } from "../lib/constants";
import {
  buildEvidence,
  evidenceCorpusHash,
  evidenceHashInputV1,
  normalizedHash,
  sortEvidenceForCorpus,
  validateEvidenceSet,
} from "../lib/evidence";
import type { SourceRecord } from "../lib/types";

function makeRec(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceKey: "dom:details:program-rules:automation",
    sourceType: "dom",
    sourceLevel: "explicit_program_rule",
    sourceUrl: "https://bugcrowd.com/engagements/acme",
    authenticated: true,
    locator: { section: "Program Rules", subsection: "Automated testing" },
    quote:
      "Automated scanning is permitted only against explicitly listed targets.",
    extractionStatus: "exact",
    ...overrides,
  };
}

const COLLECTED = "2026-09-20T01:10:22+07:00";

/** Deterministic Fisher-Yates with an LCG — fixed seeds keep runs reproducible. */
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

describe("evidenceHashInputV1", () => {
  it("contains exactly the spec-pinned preimage fields", () => {
    const input = evidenceHashInputV1(
      makeRec(),
      "https://bugcrowd.com/engagements/acme",
    ) as unknown as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      [
        "canonical_locator",
        "canonical_source_url",
        "normalized_quote",
        "schema_version",
        "source_authenticated",
        "source_key",
        "source_level",
        "source_type",
      ].sort(),
    );
    expect(input).toEqual({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      source_type: "dom",
      source_authenticated: true,
      canonical_source_url: "https://bugcrowd.com/engagements/acme",
      source_key: "dom:details:program-rules:automation",
      source_level: "explicit_program_rule",
      canonical_locator: {
        section: "Program Rules",
        subsection: "Automated testing",
      },
      normalized_quote:
        "Automated scanning is permitted only against explicitly listed targets.",
    });
  });

  it("drops undefined locator fields and unknown volatile keys", () => {
    const input = evidenceHashInputV1(
      makeRec({
        locator: {
          section: "Scope",
          subsection: undefined,
          targetId: undefined,
          pageIndex: undefined,
          rowIndex: 3,
          // simulate a collector sneaking in a volatile DOM id
          ...({ domNodeId: "ember123" } as object),
        },
      }),
      "https://bugcrowd.com/engagements/acme",
    ) as unknown as { canonical_locator: Record<string, unknown> };
    expect(input.canonical_locator).toEqual({ section: "Scope", rowIndex: 3 });
  });

  it("normalizes the quote (CRLF, whitespace runs, NFC)", () => {
    const input = evidenceHashInputV1(
      makeRec({ quote: "  line one\r\nline   two  " }),
      "https://bugcrowd.com/engagements/acme",
    ) as { normalized_quote: string };
    expect(input.normalized_quote).toBe("line one line two");
  });
});

describe("buildEvidence", () => {
  it("produces ev_+12hex ids and sha256:+64hex content hashes", async () => {
    const [ev] = await buildEvidence([makeRec()], { collectedAt: COLLECTED });
    expect(ev).toBeDefined();
    expect(ev!.id).toMatch(/^ev_[0-9a-f]{12}$/);
    expect(ev!.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // id is the first 12 hex chars of the same digest
    expect(ev!.content_hash.slice("sha256:".length).startsWith(ev!.id.slice(3)))
      .toBe(true);
  });

  it("gives the same id for the same logical source+text regardless of collected_at", async () => {
    const [a] = await buildEvidence([makeRec()], {
      collectedAt: "2026-09-20T01:10:22+07:00",
    });
    const [b] = await buildEvidence([makeRec()], {
      collectedAt: "2026-12-31T23:59:59+00:00",
    });
    expect(a!.id).toBe(b!.id);
    expect(a!.content_hash).toBe(b!.content_hash);
    expect(a!.collected_at).not.toBe(b!.collected_at);
  });

  it("produces a different id for a different source_key", async () => {
    const [a] = await buildEvidence([makeRec()], { collectedAt: COLLECTED });
    const [b] = await buildEvidence(
      [makeRec({ sourceKey: "dom:details:program-rules:brute-force" })],
      { collectedAt: COLLECTED },
    );
    expect(a!.id).not.toBe(b!.id);
  });

  it("produces a different id for a changed quote", async () => {
    const [a] = await buildEvidence([makeRec()], { collectedAt: COLLECTED });
    const [b] = await buildEvidence(
      [makeRec({ quote: "Automated scanning is strictly prohibited." })],
      { collectedAt: COLLECTED },
    );
    expect(a!.id).not.toBe(b!.id);
  });

  it("produces different ids for different url / locator / auth / level / type", async () => {
    const [base] = await buildEvidence([makeRec()], {
      collectedAt: COLLECTED,
    });
    const variants = await buildEvidence(
      [
        makeRec({ sourceUrl: "https://bugcrowd.com/engagements/other" }),
        makeRec({ locator: { section: "Other Section" } }),
        makeRec({ authenticated: false }),
        makeRec({ sourceLevel: "announcement" }),
        makeRec({ sourceType: "api" }),
      ],
      { collectedAt: COLLECTED },
    );
    for (const ev of variants) {
      expect(ev.id).not.toBe(base!.id);
    }
  });

  it("canonicalizes url (tracking params, fragment) and quote in the output", async () => {
    const [ev] = await buildEvidence(
      [
        makeRec({
          sourceUrl:
            "https://BUGCROWD.COM:443/engagements/acme?utm_source=x&keep=1#frag",
          quote: "  padded   text  ",
        }),
      ],
      { collectedAt: COLLECTED },
    );
    expect(ev!.source.url).toBe(
      "https://bugcrowd.com/engagements/acme?keep=1",
    );
    expect(ev!.quote).toBe("padded text");
    // canonical url means the pre-canonical and post-canonical urls hash alike
    const [clean] = await buildEvidence(
      [
        makeRec({
          sourceUrl: "https://bugcrowd.com/engagements/acme?keep=1",
          quote: "padded text",
        }),
      ],
      { collectedAt: COLLECTED },
    );
    expect(ev!.id).toBe(clean!.id);
  });

  it("copies extraction status (partial and failed preserved)", async () => {
    const evs = await buildEvidence(
      [
        makeRec({ extractionStatus: "partial" }),
        makeRec({ extractionStatus: "failed", sourceKey: "dom:x" }),
      ],
      { collectedAt: COLLECTED },
    );
    expect(evs[0]!.extraction).toEqual({
      status: "partial",
      parser_version: PARSER_VERSION,
    });
    expect(evs[1]!.extraction.status).toBe("failed");
  });

  it("keeps locator free of volatile fields on the emitted object", async () => {
    const [ev] = await buildEvidence(
      [
        makeRec({
          locator: {
            section: "S",
            targetId: "t1",
            rowIndex: undefined,
            ...({ emberId: "e9" } as object),
          },
        }),
      ],
      { collectedAt: COLLECTED },
    );
    expect(ev!.locator).toEqual({ section: "S", targetId: "t1" });
    expect(Object.keys(ev!.locator).sort()).toEqual(["section", "targetId"]);
  });

  it("preserves input order and count", async () => {
    const recs = [
      makeRec({ sourceKey: "k1" }),
      makeRec({ sourceKey: "k2" }),
      makeRec({ sourceKey: "k1" }), // identical duplicate → identical id
    ];
    const evs = await buildEvidence(recs, { collectedAt: COLLECTED });
    expect(evs).toHaveLength(3);
    expect(evs[0]!.source_key).toBe("k1");
    expect(evs[0]!.id).toBe(evs[2]!.id);
  });
});

describe("sortEvidenceForCorpus", () => {
  it("orders by source-type order (api→dom), then source_key, locator JSON, id", async () => {
    const recs = [
      // dom, key dom:a, locator section — sorts after rowIndex locator
      makeRec({
        sourceKey: "dom:a",
        locator: { section: "s" },
        quote: "q1",
      }),
      // dom, key dom:a, locator rowIndex — '{"rowIndex":1}' < '{"section":"s"}'
      makeRec({ sourceKey: "dom:a", locator: { rowIndex: 1 }, quote: "q2" }),
      // dom, key dom:a, same locator as previous but different quote → id tiebreak
      makeRec({ sourceKey: "dom:a", locator: { rowIndex: 1 }, quote: "q3" }),
      makeRec({ sourceKey: "dom:b", locator: {}, quote: "q4" }),
      makeRec({
        sourceType: "api",
        sourceKey: "api:z",
        locator: {},
        quote: "q5",
      }),
      makeRec({
        sourceType: "api",
        sourceKey: "api:a",
        locator: {},
        quote: "q6",
      }),
    ];
    const evs = await buildEvidence(recs, { collectedAt: COLLECTED });
    const sorted = sortEvidenceForCorpus(evs);
    const keys = sorted.map((e) => `${e.source_key}#${e.id}`);
    // api first (a then z), then dom:a (rowIndex pair ordered by id, then
    // section locator), then dom:b.
    const idOf = (quote: string) =>
      evs.find((e) => e.quote === quote)!.id;
    const domPair = [idOf("q2"), idOf("q3")].sort();
    expect(keys).toEqual([
      `api:a#${idOf("q6")}`,
      `api:z#${idOf("q5")}`,
      `dom:a#${domPair[0]}`,
      `dom:a#${domPair[1]}`,
      `dom:a#${idOf("q1")}`,
      `dom:b#${idOf("q4")}`,
    ]);
  });

  it("does not mutate the input array", async () => {
    const evs = await buildEvidence(
      [makeRec({ sourceKey: "b" }), makeRec({ sourceKey: "a" })],
      { collectedAt: COLLECTED },
    );
    const before = evs.map((e) => e.id);
    sortEvidenceForCorpus(evs);
    expect(evs.map((e) => e.id)).toEqual(before);
  });
});

describe("evidenceCorpusHash", () => {
  const corpusRecords: SourceRecord[] = [
    makeRec({
      sourceType: "api",
      sourceKey: "api:engagement:uuid",
      sourceUrl: "https://api.bugcrowd.com/engagements/uuid",
      sourceLevel: "api_field",
      locator: {},
      quote: "engagement payload",
    }),
    makeRec({
      sourceType: "api",
      sourceKey: "api:engagement:targets",
      sourceUrl: "https://api.bugcrowd.com/engagements/uuid",
      sourceLevel: "api_field",
      locator: {},
      quote: "targets payload",
    }),
    makeRec({ sourceKey: "dom:details:name", locator: { section: "Details" }, quote: "Acme" }),
    makeRec({ sourceKey: "dom:scope:target:x", locator: { section: "Scope", rowIndex: 0 }, quote: "x.example.com" }),
    makeRec({ sourceKey: "dom:scope:target:y", locator: { section: "Scope", rowIndex: 1 }, quote: "y.example.com" }),
    makeRec({ sourceKey: "dom:policies:rule:automation", locator: { section: "Program Rules" }, quote: "Automated scanning permitted." }),
    makeRec({ sourceKey: "dom:activity:item:0", locator: { section: "Activity", rowIndex: 0 }, quote: "Accepted report" }),
  ];

  it("returns sha256:+64hex and is invariant under input order (10 shuffles)", async () => {
    const evs = await buildEvidence(corpusRecords, { collectedAt: COLLECTED });
    const reference = await evidenceCorpusHash(evs);
    expect(reference).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (let seed = 1; seed <= 10; seed++) {
      const h = await evidenceCorpusHash(shuffled(evs, seed * 7919));
      expect(h).toBe(reference);
    }
  });

  it("produces the same sorted order regardless of input order", async () => {
    const evs = await buildEvidence(corpusRecords, { collectedAt: COLLECTED });
    const referenceOrder = sortEvidenceForCorpus(evs).map((e) => e.id);
    for (let seed = 1; seed <= 10; seed++) {
      const order = sortEvidenceForCorpus(shuffled(evs, seed * 104729)).map(
        (e) => e.id,
      );
      expect(order).toEqual(referenceOrder);
    }
  });

  it("excludes collected_at: same records collected twice hash identically", async () => {
    const a = await buildEvidence(corpusRecords, {
      collectedAt: "2026-01-01T00:00:00Z",
    });
    const b = await buildEvidence(corpusRecords, {
      collectedAt: "2026-12-31T23:59:59Z",
    });
    expect(await evidenceCorpusHash(a)).toBe(await evidenceCorpusHash(b));
  });

  it("changes when evidence content changes", async () => {
    const a = await buildEvidence(corpusRecords, { collectedAt: COLLECTED });
    const b = await buildEvidence(
      [...corpusRecords, makeRec({ sourceKey: "dom:extra", quote: "extra" })],
      { collectedAt: COLLECTED },
    );
    expect(await evidenceCorpusHash(a)).not.toBe(await evidenceCorpusHash(b));
  });

  it("handles the empty corpus deterministically", async () => {
    const h = await evidenceCorpusHash([]);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(await evidenceCorpusHash([]));
  });
});

describe("normalizedHash", () => {
  it("is key-order invariant and content sensitive", async () => {
    const a = await normalizedHash({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = await normalizedHash({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(b);
    const c = await normalizedHash({ a: { c: "x", d: [1, 2] }, b: 2 });
    expect(c).not.toBe(a);
  });
});

describe("validateEvidenceSet", () => {
  it("recomputes evidence hashes instead of accepting valid-looking corruption", async () => {
    const records = [makeRec()];
    const evidence = await buildEvidence(records, { collectedAt: COLLECTED });
    await expect(validateEvidenceSet(records, evidence)).resolves.toBe(true);
    await expect(
      validateEvidenceSet(records, [
        { ...evidence[0]!, content_hash: `sha256:${"f".repeat(64)}` },
      ]),
    ).resolves.toBe(false);
  });
});

describe("corpus sort key sanity", () => {
  it("canonicalLocator ordering matches comparator expectations", () => {
    expect(canonicalLocator({ rowIndex: 1 }) < canonicalLocator({ section: "s" }))
      .toBe(true);
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
    expect(canonicalUrl("https://bugcrowd.com/engagements/x")).toBe(
      "https://bugcrowd.com/engagements/x",
    );
  });
});
