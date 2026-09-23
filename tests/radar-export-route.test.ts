import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { getRadarProfile } from "../lib/radar/profiles";
import { RADAR_PROFILE_IDS } from "../lib/radar/types";
import type {
  RadarCatalogItem,
  RadarProfileId,
  RadarProgramSnapshot,
} from "../lib/radar/types";
import type { ApiEngagementData } from "../lib/types";

// ---------------------------------------------------------------------------
// RADAR_EXPORT_REPORT — message schema + background router coverage. The
// radar store is seeded directly (fake-indexeddb backs the real `bce-radar`
// DB for the file's lifetime → unique uuid/run prefixes per test); the op
// must stay read-only and must never reach for the network.
// ---------------------------------------------------------------------------

type StoreModule = typeof import("../lib/radar/store");

const T0 = "2026-09-21T00:00:00.000Z";
const T1 = "2026-09-21T00:05:00.000Z";
// Alphanumeric deliberately: Markdown escaping would rewrite hyphens before
// the redaction pass, so a metachar-free secret is what a redaction assertion
// can observe (escaped secrets can't appear verbatim anyway).
const CREDENTIAL = "t0kexportredaction9f8e7d6c";

let store: StoreModule;
type RouteResult = {
  ok: boolean;
  error?: unknown;
  export?: {
    filename: string;
    mime: string;
    body: string;
    content_hash: string;
    generated_at: string;
  };
};
type Sender = { id?: string; url?: string; tab?: { id?: number; url?: string } };
let routeMessage: (
  msg: unknown,
  sender: Sender,
) => Promise<RouteResult>;
let seq = 0;

const uid = () => `rt-${(++seq).toString(36)}`;
const rid = () => `run-rt-${(++seq).toString(36)}`;

const extensionPageSender = { id: fakeBrowser.runtime.id };
const contentScriptSender = {
  id: fakeBrowser.runtime.id,
  url: "https://bugcrowd.com/engagements/acme-corp-bb",
  tab: { id: 7, url: "https://bugcrowd.com/engagements/acme-corp-bb" },
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  Object.defineProperty(fakeBrowser.storage.local, "setAccessLevel", {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
    writable: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("export must not fetch");
    }),
  );
  store = await import("../lib/radar/store");
  const bg = await import("../entrypoints/background");
  // RouterResponse is open-shaped; the export envelope fields are pinned here.
  routeMessage = (msg, sender) =>
    Promise.resolve(bg.routeMessage(msg, sender)) as Promise<RouteResult>;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function detail(uuid: string, name: string): ApiEngagementData {
  return {
    uuid,
    name,
    code: `c-${uuid}`,
    engagementType: "bug_bounty",
    managedBounty: true,
    lifecycleStatus: "live",
    testingStart: null,
    testingEnd: null,
    testingPeriodLabel: null,
    lastStatusTransition: T0,
    lastBriefUpdate: T0,
    safeHarborLevel: "full",
    statistics: {},
    targetGroups: [
      {
        id: `g-${uuid}`,
        name: "Web",
        inScope: true,
        description: null,
        rewards: { p1: 5000, p2: 500, p3: 100, p4: null, p5: null },
      },
    ],
    targets: [
      {
        id: `t-${uuid}`,
        groupId: `g-${uuid}`,
        location: "https://a.example.com",
        name: "site",
        category: "website",
        tags: [],
        inScope: true,
      },
    ],
    participation: null,
    credentialsProvided: null,
    briefText: null,
    observedApiVersion: "2026-09-20",
  };
}

function seedItem(uuid: string, name = `Program ${uuid}`): RadarCatalogItem {
  return {
    uuid,
    code: `c-${uuid}`,
    name,
    lifecycle_status: "live",
    engagement_type: "bug_bounty",
    discovered_at: T0,
  };
}

/** Seed one terminal run with metadata-stage scores for every profile. */
async function seedRunWith(
  uuids: string[],
  opts: { nameFor?: (u: string) => string } = {},
): Promise<string> {
  const db = await store.openRadarStore();
  const items = uuids.map((u) => seedItem(u, opts.nameFor?.(u)));
  await store.putCatalogItems(db, items);
  for (const u of uuids) {
    const snap: RadarProgramSnapshot = {
      schema_version: 1,
      uuid: u,
      code: `c-${u}`,
      catalog: seedItem(u, opts.nameFor?.(u)),
      detail: detail(u, opts.nameFor?.(u) ?? `Program ${u}`),
      enrichment: { status: "complete" },
      source_hash: `sha256:${(++seq).toString(16).padStart(64, "0")}`,
    };
    await store.putSnapshot(db, snap, T1);
    for (const p of RADAR_PROFILE_IDS) {
      await store.putScore(
        db,
        {
          schema_version: 1,
          engagement_uuid: u,
          profile: p,
          scoring_version: getRadarProfile(p).version,
          score: 60,
          confidence: 0.9,
          provisional: false,
          components: {},
          reasons: [],
          source_hash: snap.source_hash,
        },
        T1,
        undefined,
        "metadata",
      );
    }
  }
  const runId = rid();
  await store.putRun(db, {
    run_id: runId,
    phase: "done",
    discovered: uuids.length,
    enriched: uuids.length,
    scored: uuids.length,
    pending_uuids: [],
    completed_uuids: [...uuids],
    warnings: 0,
    started_at: T0,
    updated_at: T1,
    catalog_complete: true,
    enrichment_failed: 0,
    warning_details: [],
    cancel_requested: false,
    deep_pending_uuids: [],
    deep_completed_uuids: [],
    deep_enriched: 0,
    deep_candidates: [],
    deep_round: 0,
    deep_budget: 0,
    deep_stabilization: null,
    deep_sources: {
      known_issues: {},
      semantic_diff: {},
      scope_arc: {},
      group_stats: {},
    },
    summary: {
      status: "complete",
      catalog_complete: true,
      discovered: uuids.length,
      enriched: uuids.length,
      enrichment_failed: 0,
      scored: uuids.length,
      warnings: [],
    },
  });
  await store.setLatestRunId(db, runId);
  db.close();
  return runId;
}

function exportMsg(over: Record<string, unknown> = {}) {
  return {
    op: "RADAR_EXPORT_REPORT",
    format: "markdown",
    scope: "all",
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("RADAR_EXPORT_REPORT", () => {
  it("empty store → {ok:false, error:'no_scan'} — honest, never fabricated", async () => {
    const res = await routeMessage(exportMsg(), extensionPageSender);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_scan");
  });

  it("scope:'current' without a profile → invalid_params", async () => {
    await seedRunWith([uid()]);
    const res = await routeMessage(
      exportMsg({ scope: "current" }),
      extensionPageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_params");
  });

  it("strict schema: injection keys fail parsing → unknown_message", async () => {
    const res = await routeMessage(
      exportMsg({ url: "https://evil.example.com", headers: {} }),
      extensionPageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown_message");
  });

  it("content-script senders are rejected", async () => {
    await seedRunWith([uid()]);
    const res = await routeMessage(exportMsg(), contentScriptSender);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden");
  });

  it("returns a serialized export envelope over the persisted scan", async () => {
    const u = uid();
    await seedRunWith([u]);
    const res = await routeMessage(exportMsg(), extensionPageSender);
    expect(res.ok).toBe(true);
    const out = res.export!;
    expect(out.filename).toMatch(/^radar-report-run-rt-.*-all-top50\.md$/);
    expect(out.mime).toBe("text/markdown");
    expect(out.body).toContain("# Radar Report");
    expect(out.body).toContain(u);
    expect(out.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The wall-clock stamp lives in the envelope only — never in the body.
    expect(out.body).not.toContain(out.generated_at);
  });

  it("json format → parseable envelope; csv → pinned header", async () => {
    const u = uid();
    await seedRunWith([u]);
    const json = await routeMessage(
      exportMsg({ format: "json" }),
      extensionPageSender,
    );
    expect(json.ok).toBe(true);
    const parsed = JSON.parse(json.export!.body);
    expect(parsed.schema).toBe("bce-radar-export");
    expect(parsed.content_sha256).toBe(json.export!.content_hash);

    const csv = await routeMessage(
      exportMsg({ format: "csv", limit: "all" }),
      extensionPageSender,
    );
    expect(csv.ok).toBe(true);
    expect(csv.export!.mime).toBe("text/csv");
    expect(csv.export!.body.split("\n")[0]).toContain("profile_id");
  });

  it("current-profile scope exports exactly that profile", async () => {
    const u = uid();
    await seedRunWith([u]);
    const res = await routeMessage(
      exportMsg({ format: "json", scope: "current", profile: "authz_api" }),
      extensionPageSender,
    );
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.export!.body);
    expect(parsed.report.sections).toHaveLength(1);
    expect(parsed.report.sections[0].profile_id).toBe("authz_api");
  });

  it("redacts the stored credential wherever it appears in report data", async () => {
    await fakeBrowser.storage.local.set({ apiCredential: CREDENTIAL });
    const u = uid();
    await seedRunWith([u], { nameFor: () => `Evil ${CREDENTIAL} Corp` });
    const res = await routeMessage(exportMsg(), extensionPageSender);
    expect(res.ok).toBe(true);
    expect(res.export!.body).not.toContain(CREDENTIAL);
    expect(res.export!.body).toContain("[REDACTED]");
  });

  it("defaults: limit 50, detail+diagnostics on (schema-level)", async () => {
    const u = uid();
    await seedRunWith([u]);
    const res = await routeMessage(
      exportMsg({ format: "json" }),
      extensionPageSender,
    );
    const parsed = JSON.parse(res.export!.body);
    expect(parsed.report.options).toEqual({
      profiles: [...RADAR_PROFILE_IDS],
      limit: 50,
      detail: true,
      diagnostics: true,
    });
  });
});
