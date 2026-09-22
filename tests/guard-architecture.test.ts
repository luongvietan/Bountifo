import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Architectural regression — the tripwire that keeps the guard mandatory
 * (§31, §52, §64, item K of the audit).
 *
 * These tests do not prove a file is safe; they prove the inventory is
 * CLOSED. Any production source that gains a side-effect primitive, calls
 * evaluateAction outside the gate, or grows a planner-controlled bypass
 * flag fails here until a human either routes it through runWithGuard or
 * extends the registry with a documented non-target exception.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["lib", "entrypoints"];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

// Strip block and line comments (URLs in strings are safe to truncate —
// a sink or bypass flag never appears inside a URL). Comments must not
// register as sinks: `// never call fetch(url)` is documentation.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");

function files(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const path of sources(join(ROOT, dir))) {
      out.set(
        path.split("\\").join("/").replace(/^.*?(lib|entrypoints)\//, "$1/"),
        stripComments(readFileSync(path, "utf8")),
      );
    }
  }
  return out;
}

/**
 * Side-effect primitives. A match means the file can touch a network, a
 * browser API, persistent state, the DOM of a live page, a process, the
 * filesystem, or an external tool bridge. `delegated:*` marks calls into an
 * injected side-effecting dependency (fetchPage, apiRequest, sendToTab) —
 * the effect lives elsewhere but the call site still crosses the boundary.
 */
const SINK_PATTERNS: Record<string, RegExp> = {
  "network:fetch": /\bfetch\s*\(/,
  "network:xhr": /XMLHttpRequest/,
  "network:ws-beacon": /\bnew\s+WebSocket|navigator\.sendBeacon/,
  "network:http-client": /\baxios\b|\bgot\s*\(|\bhttps?\.request\s*\(|\bundici\b|\bsuperagent\b/,
  process: /\bchild_process\b|\bexecFile(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bBun\.spawn\b|\bDeno\.Command\b/,
  "browser:download": /(?:browser|chrome)\.downloads\.download/,
  "browser:tabs-message": /(?:browser|chrome)\.tabs\.sendMessage/,
  "browser:runtime-message": /(?:browser|chrome)\.runtime\.sendMessage/,
  "browser:storage": /(?:browser|chrome)\.storage\??\s*\.(?:local|session|sync|managed)/,
  idb: /\bopenDB\s*\(|\bindexedDB\.open\s*\(/,
  "dom:effect": /\.(?:click|requestSubmit|submit)\s*\(|\.dispatchEvent\s*\(/,
  "delegated:network": /\bfetchPage\s*\(|(?<!function )\bapiRequest\s*(?:<[^>]*>)?\s*\(|(?<!function )\bsiteRequest\s*(?:<[^>]*>)?\s*\(/,
  "delegated:tab-message": /\bsendToTab\s*\(/,
  "fs:write":
    /\bwriteFile(?:Sync)?\s*\(|\bappendFile(?:Sync)?\s*\(|\bunlink(?:Sync)?\s*\(|\brename(?:Sync)?\s*\(|\brm(?:Sync)?\s*\(/,
  "automation:playwright":
    /\bpage\.(?:goto|click|fill|press|evaluate|locator)\s*\(|\bpuppeteer\b/,
  "tool-bridge": /\b(?:callTool|toolCall|invokeTool)\s*\(|\bmcp\b/i,
};

/**
 * The complete, closed registry of production side-effect surfaces.
 * Every entry is collection-plane (Bugcrowd dossier collection) or local
 * exporter bookkeeping — none is target-execution plane. The rationale for
 * each classification lives in docs/EXECUTION-GUARD-AUDIT.md.
 */
const SINK_REGISTRY: Record<string, string[]> = {
  // Authenticated Bugcrowd API GETs (allowlisted ops; collection plane).
  "lib/api/client.ts": ["network:fetch"],
  // Session-cookie site reads for the researcher surface
  // (engagements.json catalog + brief HTML; collection plane).
  "lib/api/siteClient.ts": ["network:fetch"],
  "lib/api/engagements.ts": ["delegated:network"],
  // Radar catalog enumerator paging engagements.json (collection plane).
  "lib/radar/catalog.ts": ["delegated:network"],
  // Radar detail hydration: site JSON reads (changelog → doc → stats);
  // the mapper itself is pure (collection plane).
  "lib/radar/enrichment.ts": ["delegated:network"],
  // V1.3 deep stage: per-shortlist site JSON reads (known-issues aggregate,
  // previous changelog doc) via the same allowlisted siteRequest.
  "lib/radar/knownIssues.ts": ["delegated:network"],
  "lib/radar/deep.ts": ["delegated:network"],
  // Radar IndexedDB persistence (bce-radar database).
  "lib/radar/store.ts": ["idb"],
  // Same-origin dossier page fetch + extension messaging + job bookkeeping.
  "entrypoints/content.ts": [
    "network:fetch",
    "browser:runtime-message",
    "browser:storage",
  ],
  // Message router + API ops.
  "entrypoints/background.ts": ["browser:tabs-message", "delegated:network"],
  // Options page → background token ops.
  "entrypoints/options/main.ts": ["browser:runtime-message"],
  // Popup → background job ops.
  "entrypoints/popup/main.ts": ["browser:runtime-message"],
  // Radar page → background messaging.
  "entrypoints/radar/main.ts": ["browser:runtime-message"],
  // Final local file save.
  "lib/download.ts": ["browser:download"],
  // Injected tab-messaging dependency.
  "lib/job/coordinator.ts": ["delegated:tab-message"],
  // Session-scoped job descriptor.
  "lib/job/descriptor.ts": ["browser:storage"],
  // IndexedDB job persistence.
  "lib/job/store.ts": ["idb"],
  // Storage availability probe.
  "lib/storageAccess.ts": ["browser:storage"],
  // Credential storage (local only).
  "lib/tokenOps.ts": ["browser:storage"],
  // Injected same-origin page fetcher (collection plane).
  "lib/dom/activity.ts": ["delegated:network"],
  // Pagination clicks during DOM collection.
  "lib/dom/knownIssues.ts": ["dom:effect"],
};

describe("architecture: closed side-effect registry", () => {
  it("every production sink file is registered with exactly its declared sinks", () => {
    const violations: string[] = [];
    for (const [file, src] of files()) {
      const found = new Set<string>();
      for (const [id, re] of Object.entries(SINK_PATTERNS)) {
        if (re.test(src)) found.add(id);
      }
      const declared = new Set(SINK_REGISTRY[file] ?? []);
      for (const id of found) {
        if (!declared.has(id)) {
          violations.push(`${file}: undeclared sink '${id}'`);
        }
      }
      for (const id of declared) {
        if (!found.has(id)) {
          violations.push(`${file}: registered sink '${id}' no longer present`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no unregistered production file contains a side-effect primitive", () => {
    const offenders: string[] = [];
    for (const [file, src] of files()) {
      if (file in SINK_REGISTRY) continue;
      for (const [id, re] of Object.entries(SINK_PATTERNS)) {
        if (re.test(src)) offenders.push(`${file}: '${id}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("architecture: radar collection-plane closure", () => {
  /**
   * Task 20 — Engagement Radar introduces no new raw network primitive.
   * All HTTP goes through apiRequest(); raw primitives (fetch, XHR, axios,
   * undici, got, http(s).request, WebSocket, sendBeacon) must never appear
   * under lib/radar. Only catalog.ts and enrichment.ts may call apiRequest
   * (their delegated:network registry entries), and only store.ts touches
   * IndexedDB. Every other radar file must be provably sink-free — the
   * coordinator included (its IDB handle and network functions are injected).
   */
  const RADAR_FILE = /^lib\/radar\//;
  const RAW_NETWORK =
    /\bfetch\s*\(|XMLHttpRequest|\baxios\b|\bundici\b|\bgot\s*\(|\bhttps?\.request\s*\(|\bnew\s+WebSocket|navigator\.sendBeacon/;
  const API_REQUEST_CALL = /\bapiRequest\s*(?:<[^>]*>)?\s*\(/;

  /** Radar files permitted to invoke the delegated apiRequest sink. */
  const RADAR_DELEGATED_NETWORK = new Set([
    "lib/radar/catalog.ts",
    "lib/radar/enrichment.ts",
  ]);

  /** Exact radar registry expectation — mirrors SINK_REGISTRY entries. */
  const RADAR_REGISTRY: Record<string, string[]> = {
    "lib/radar/catalog.ts": ["delegated:network"],
    "lib/radar/enrichment.ts": ["delegated:network"],
    "lib/radar/knownIssues.ts": ["delegated:network"],
    "lib/radar/deep.ts": ["delegated:network"],
    "lib/radar/store.ts": ["idb"],
  };

  function radarSources(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [file, src] of files()) {
      if (RADAR_FILE.test(file)) out.set(file, src);
    }
    return out;
  }

  it("no lib/radar file touches a raw network primitive", () => {
    const offenders: string[] = [];
    for (const [file, src] of radarSources()) {
      if (RAW_NETWORK.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("apiRequest is only called from catalog.ts and enrichment.ts", () => {
    const offenders: string[] = [];
    for (const [file, src] of radarSources()) {
      if (RADAR_DELEGATED_NETWORK.has(file)) continue;
      if (API_REQUEST_CALL.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("every lib/radar file either declares its sinks or provably has none", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const [file, src] of radarSources()) {
      seen.add(file);
      const found = Object.entries(SINK_PATTERNS)
        .filter(([, re]) => re.test(src))
        .map(([id]) => id)
        .sort();
      const declared = [...(SINK_REGISTRY[file] ?? [])].sort();
      if (found.join(",") !== declared.join(",")) {
        offenders.push(
          `${file}: sinks [${found.join(", ")}] vs registry [${declared.join(", ")}]`,
        );
      }
    }
    // The registry entries must also point at real files — no stale rows.
    for (const file of Object.keys(RADAR_REGISTRY)) {
      if (!seen.has(file)) {
        offenders.push(`${file}: registered but file is gone`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the radar registry stays exactly: catalog/enrichment/deep network, store idb", () => {
    for (const [file, sinks] of Object.entries(RADAR_REGISTRY)) {
      expect(
        SINK_REGISTRY[file],
        `${file} missing or changed in SINK_REGISTRY`,
      ).toEqual(sinks);
    }
    // coordinator.ts must need NO entry — its effects are injected deps.
    expect(SINK_REGISTRY["lib/radar/coordinator.ts"]).toBeUndefined();
  });
});

describe("architecture: single canonical gate", () => {
  const GATE_INTERNALS = /^lib\/guard\//;

  it("evaluateAction is only reachable inside lib/guard", () => {
    const offenders: string[] = [];
    for (const [file, src] of files()) {
      if (GATE_INTERNALS.test(file)) continue;
      if (/\bevaluateAction\b/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no production code gates execution on decision !== DENY/REVIEW", () => {
    const offenders: string[] = [];
    const forbidden = /decision\s*!==\s*["'](?:DENY|REVIEW)["']/;
    for (const [file, src] of files()) {
      if (forbidden.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("harness.ts retains the fail-closed ordering: gate check precedes execute()", () => {
    const src = files().get("lib/guard/harness.ts");
    expect(src).toBeDefined();
    const gate = src!.indexOf("if (decision.execution_allowed !== true)");
    const execIdx = src!.indexOf("await params.execute()");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThan(gate);
  });
});

describe("architecture: no planner-controlled bypass surface", () => {
  const BYPASS_PATTERNS: Record<string, RegExp> = {
    "guard-skip-flag": /\b(?:skip|bypass|disable|ignore)[_-]?scope[_-]?guard\b|\b(?:skip|bypass|disable)[_-]?guard\b/i,
    "planner-authority-flag": /\b(?:trusted|authorized|reviewAccepted|force|unsafe|override|consentGranted|preAuthorized)\s*[:=]\s*true\b/,
    "env-disable": /DISABLE_SCOPE_GUARD|SCOPE_GUARD_(?:OFF|DISABLE|SKIP)/,
    "env-gate": /\b(?:process\.env|import\.meta\.env)\.[A-Z_]*(?:GUARD|SCOPE|AUTH)/,
  };

  it("no production file carries a bypass flag or env gate", () => {
    const offenders: string[] = [];
    for (const [file, src] of files()) {
      for (const [id, re] of Object.entries(BYPASS_PATTERNS)) {
        if (re.test(src)) offenders.push(`${file}: '${id}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ProposedAction schema carries no bypass fields", async () => {
    const { proposedActionSchema } = await import("@/lib/guard/types.ts");
    const base = {
      schema_version: 1,
      engagement: { code: "x" },
      target: { url: "https://a.example.com/" },
      technique: { id: "xss" },
      operation: { kind: "read", destructive: false, external_side_effect: false },
    };
    for (const flag of [
      "skipGuard",
      "skip_scope_guard",
      "trusted",
      "authorized",
      "reviewAccepted",
      "force",
      "unsafe",
      "override",
    ]) {
      // Strict schema rejects unknown keys — a bypass field is a parse
      // error, which the gate treats as fail-closed.
      expect(
        proposedActionSchema.safeParse({ ...base, [flag]: true }).success,
        `ProposedAction accepted bypass field '${flag}'`,
      ).toBe(false);
    }
  });
});
