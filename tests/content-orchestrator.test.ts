// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://bugcrowd.com/engagements/acme-bb"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browser } from "wxt/browser";
import contentScript, {
  createOrchestrator,
  sameOriginFetchPage,
  type OrchestratorDeps,
} from "../entrypoints/content";
import type { DomTarget } from "../lib/dom/targets";
import type { KiDriver } from "../lib/dom/knownIssues";

// ---------------------------------------------------------------------------
// Content-script orchestrator (spec §7.4): PAGE_READY gated on the stored
// activeJob descriptor, RUN_UNIT dispatch with per-unit session checks,
// {ok,result}/{ok:false,error} envelopes, and restore of exporter-opened UI.
// ---------------------------------------------------------------------------

const TARGET: DomTarget = {
  domKey: "target:api-acme-example",
  groupDomKey: "group:web",
  inScope: true,
  location: "api.acme.example",
  name: "Acme API",
  category: "API",
  tags: [],
  docLinks: [],
  changeFlags: [],
  displayedKnownIssuesCount: 1,
  kiControlLabel: "View known issues",
};

function fakeKiDriver(): KiDriver {
  return {
    open: vi.fn(async () => document.createElement("div")),
    waitReady: vi.fn(async () => true),
    currentPage: vi.fn(() => ({ columns: ["A"], rows: [["1"]] })),
    advance: vi.fn(async () => "end" as const),
    close: vi.fn(async () => {}),
  };
}

function makeDeps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    doc: document,
    initialUrl: location.href,
    expectedJobId: null,
    kiDriver: fakeKiDriver(),
    collectDetails: vi.fn(() => ({ records: [], data: "details" })),
    collectTargets: vi.fn(() => ({ records: [], data: "targets" })),
    collectPolicies: vi.fn(() => ({ records: [], data: "policies" })),
    collectActivity: vi.fn(async () => ({ records: [], data: "activity" })),
    collectKnownIssues: vi.fn(async () => ({
      targetDomKey: TARGET.domKey,
      collectedCount: 1,
      records: [],
    })),
    isSessionExpired: vi.fn(() => false),
    fetchPage: vi.fn(async () => null),
    emitProgress: vi.fn(),
    ...over,
  };
}

function runUnit(
  msg: Partial<Record<string, unknown>> & { kind: string },
): unknown {
  return { op: "RUN_UNIT", jobId: "job-1", unitId: "unit-1", ...msg };
}

beforeEach(() => {
  fakeBrowser.reset();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RUN_UNIT dispatch", () => {
  it.each([
    ["collect_details", "collectDetails"],
    ["collect_targets", "collectTargets"],
    ["collect_policy", "collectPolicies"],
    ["collect_activity", "collectActivity"],
  ] as const)("dispatches %s to its collector and wraps the result", async (kind, depKey) => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    const res = (await orch.handleMessage(runUnit({ kind }))) as {
      ok: boolean;
      result: unknown;
    };
    expect(res.ok).toBe(true);
    expect(deps[depKey]).toHaveBeenCalledTimes(1);
    expect(deps[depKey]).toHaveBeenCalledWith(
      document,
      location.href,
      ...(kind === "collect_activity" ? [deps.fetchPage] : []),
    );
    expect(res.result).toMatchObject({ data: expect.any(String) });
  });

  it("collect_ki passes the tracking driver, document, target, and initial URL", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    const res = (await orch.handleMessage(
      runUnit({ kind: "collect_ki", params: { target: TARGET, kiTotal: 4 } }),
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    const call = vi.mocked(deps.collectKnownIssues).mock.calls[0]!;
    expect(call[1]).toBe(document);
    expect(call[2]).toEqual(TARGET);
    expect(call[3]).toBe(location.href);
    // Progress emitted during KI with {kiDone, kiTotal} counters.
    expect(deps.emitProgress).toHaveBeenCalledWith("job-1", "unit-1", {
      kiDone: 1,
      kiTotal: 4,
    });
  });

  it("tracks dialogs the KI driver opens so restore_page can close them", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    await orch.handleMessage(
      runUnit({ kind: "collect_ki", params: { target: TARGET } }),
    );
    const wrappedDriver = vi.mocked(deps.collectKnownIssues).mock.calls[0]![0];
    const opened = await wrappedDriver.open(document, TARGET);
    expect(opened).not.toBeNull();
    expect(orch.openedElements.has(opened!)).toBe(true);
  });

  it("short-circuits with session_expired before running a unit", async () => {
    const deps = makeDeps({
      isSessionExpired: vi.fn(() => true),
    });
    const orch = createOrchestrator(deps);
    const res = (await orch.handleMessage(
      runUnit({ kind: "collect_details" }),
    )) as { ok: boolean; error: { kind: string } };
    expect(res).toEqual({
      ok: false,
      error: { kind: "session_expired", message: expect.any(String) },
    });
    expect(deps.collectDetails).not.toHaveBeenCalled();
  });

  it("restore_page closes exporter-opened elements and restores the URL", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const deps = makeDeps({ initialUrl: "https://bugcrowd.com/engagements/acme-bb/start" });
    const orch = createOrchestrator(deps);
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Close");
    btn.addEventListener("click", () => dlg.remove());
    dlg.appendChild(btn);
    document.body.appendChild(dlg);
    orch.openedElements.add(dlg);

    const res = (await orch.handleMessage(
      runUnit({ kind: "restore_page" }),
    )) as { ok: boolean; result: { closedElements: number; urlRestored: boolean } };
    expect(res.ok).toBe(true);
    expect(res.result.closedElements).toBe(1);
    expect(dlg.isConnected).toBe(false);
    // location.href differs from initialUrl → history navigation triggered.
    expect(res.result.urlRestored).toBe(true);
    expect(back).toHaveBeenCalled();
    expect(orch.openedElements.size).toBe(0);
  });

  it("restore_page still runs when the session has expired (§17 cleanup)", async () => {
    const deps = makeDeps({ isSessionExpired: vi.fn(() => true) });
    const orch = createOrchestrator(deps);
    const dlg = document.createElement("div");
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Close");
    btn.addEventListener("click", () => dlg.remove());
    dlg.appendChild(btn);
    document.body.appendChild(dlg);
    orch.openedElements.add(dlg);
    const res = (await orch.handleMessage(
      runUnit({ kind: "restore_page" }),
    )) as { ok: boolean; result: { closedElements: number } };
    expect(res.ok).toBe(true);
    expect(res.result.closedElements).toBe(1);
    expect(dlg.isConnected).toBe(false);
  });

  it("returns {ok:false} for an unknown unit kind", async () => {
    const orch = createOrchestrator(makeDeps());
    const res = (await orch.handleMessage(
      runUnit({ kind: "collect_everything" }),
    )) as { ok: boolean; error: { kind: string } };
    expect(res.ok).toBe(false);
    expect(res.error.kind).toBe("unknown_unit_kind");
  });

  it("returns {ok:false} for a malformed RUN_UNIT and ignores foreign messages", async () => {
    const orch = createOrchestrator(makeDeps());
    const bad = (await orch.handleMessage({
      op: "RUN_UNIT",
      kind: "collect_details",
    })) as { ok: boolean; error: { kind: string } };
    expect(bad.ok).toBe(false);
    expect(bad.error.kind).toBe("invalid_message");
    expect(await orch.handleMessage({ op: "PAGE_READY" })).toBeUndefined();
    expect(await orch.handleMessage("noise")).toBeUndefined();
  });

  it("rejects collect_ki without a valid params.target", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    const res = (await orch.handleMessage(
      runUnit({ kind: "collect_ki", params: {} }),
    )) as { ok: boolean; error: { kind: string } };
    expect(res.ok).toBe(false);
    expect(res.error.kind).toBe("invalid_params");
    expect(deps.collectKnownIssues).not.toHaveBeenCalled();
  });

  it("rejects a unit for a different job when an activeJob is expected", async () => {
    const deps = makeDeps({ expectedJobId: "job-1" });
    const orch = createOrchestrator(deps);
    const res = (await orch.handleMessage(
      runUnit({ kind: "collect_details", jobId: "other-job" }),
    )) as { ok: boolean; error: { kind: string } };
    expect(res.ok).toBe(false);
    expect(res.error.kind).toBe("job_mismatch");
    expect(deps.collectDetails).not.toHaveBeenCalled();
  });

  it("wraps collector exceptions in {ok:false,error:{kind,message}}", async () => {
    const deps = makeDeps({
      collectDetails: vi.fn(() => {
        throw new Error("selector exploded");
      }),
    });
    const orch = createOrchestrator(deps);
    const res = (await orch.handleMessage(
      runUnit({ kind: "collect_details" }),
    )) as { ok: boolean; error: { kind: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.kind).toBe("unit_failed");
    expect(res.error.message).toContain("selector exploded");
  });
});

describe("main() PAGE_READY gating", () => {
  it("sends PAGE_READY only when an activeJob exists in storage.session", async () => {
    await fakeBrowser.storage.session.set({
      activeJob: {
        jobId: "job-9",
        tabId: 3,
        engagementCode: "acme-bb",
        phase: "collect",
      },
    });
    const seen: { op?: string; jobId?: string; url?: string }[] = [];
    browser.runtime.onMessage.addListener((msg: { op?: string }) => {
      seen.push(msg as (typeof seen)[number]);
    });
    await (contentScript.main as (ctx?: unknown) => Promise<unknown>)({});
    const ready = seen.find((m) => m.op === "PAGE_READY");
    expect(ready).toBeDefined();
    expect(ready!.jobId).toBe("job-9");
    expect(ready!.url).toBe(location.href);
  });

  it("does not send PAGE_READY without an activeJob", async () => {
    const seen: { op?: string }[] = [];
    browser.runtime.onMessage.addListener((msg: { op?: string }) => {
      seen.push(msg);
    });
    await (contentScript.main as (ctx?: unknown) => Promise<unknown>)({});
    expect(seen.find((m) => m.op === "PAGE_READY")).toBeUndefined();
  });

  it("answers RUN_UNIT messages through the runtime listener", async () => {
    await fakeBrowser.storage.session.set({
      activeJob: {
        jobId: "job-9",
        tabId: 3,
        engagementCode: "acme-bb",
        phase: "collect",
      },
    });
    await (contentScript.main as (ctx?: unknown) => Promise<unknown>)({});
    // fake-browser's sendMessage only resolves Chrome-style (return true +
    // sendResponse) listeners; the orchestrator returns a Promise per the
    // polyfill convention, so trigger the event and await the results.
    const trigger = (
      browser.runtime.onMessage as unknown as {
        trigger: (msg: unknown, sender: unknown) => Promise<unknown[]>;
      }
    ).trigger;
    const results = await trigger(
      { op: "RUN_UNIT", jobId: "job-9", unitId: "u-1", kind: "collect_details" },
      {},
    );
    const envelope = results.find(
      (r): r is { ok: boolean } =>
        typeof r === "object" && r !== null && "ok" in r,
    );
    expect(envelope?.ok).toBe(true);
  });
});

describe("sameOriginFetchPage", () => {
  it("fetches same-origin bugcrowd pages and parses them", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html><body><h1>Page two</h1></body></html>", {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const doc = await sameOriginFetchPage(
      "https://bugcrowd.com/engagements/acme-bb/announcements?page=2",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(doc?.querySelector("h1")?.textContent).toBe("Page two");
  });

  it.each([
    "https://evil.example/engagements/acme-bb",
    "https://api.bugcrowd.com/engagements",
    "http://bugcrowd.com/engagements/acme-bb",
    "not a url",
  ])("refuses %s without fetching", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sameOriginFetchPage(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on fetch failure or non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect(
      await sameOriginFetchPage("https://bugcrowd.com/engagements/acme-bb/x"),
    ).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(
      await sameOriginFetchPage("https://bugcrowd.com/engagements/acme-bb/x"),
    ).toBeNull();
  });
});
