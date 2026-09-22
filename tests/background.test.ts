import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { API_BASE } from "../lib/constants";
import fixture from "./fixtures/api/engagement.json";

// Router-level tests for entrypoints/background.ts: API op dispatch and the
// sender.tab rejection (content scripts must never drive API ops). Fresh
// modules per test — the API client holds a module-level rate bucket.

const CREDENTIAL = "test-credential-4f8c2b91";
const ENGAGEMENT_UUID = fixture.data.id;

type SetAccessLevelFn = (details: { accessLevel: string }) => Promise<void>;

function stubSetAccessLevel(fn: SetAccessLevelFn | undefined) {
  Object.defineProperty(fakeBrowser.storage.local, "setAccessLevel", {
    value: fn,
    configurable: true,
    writable: true,
  });
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200 });
}

type RouterResponse = {
  ok: boolean;
  data?: unknown;
  error?: string | { kind: string; message: string };
};

let routeMessage: (
  msg: unknown,
  sender: { id?: string; url?: string; tab?: { id?: number; url?: string } },
) => RouterResponse | Promise<RouterResponse>;
let fetchMock: ReturnType<typeof vi.fn>;
let coordinator: { start: (tabId: number) => Promise<unknown> };
let radar: {
  start: () => Promise<unknown>;
  cancel: () => Promise<unknown>;
  getState: () => Promise<unknown>;
  getResults: (
    profile: import("../lib/radar/types").RadarProfileId,
    limit?: number,
    minConfidence?: number,
  ) => Promise<unknown>;
  getProgram: (
    uuid: string,
    profile?: import("../lib/radar/types").RadarProfileId,
  ) => Promise<unknown>;
};

const extensionPageSender = { id: fakeBrowser.runtime.id };
const contentScriptSender = {
  id: fakeBrowser.runtime.id,
  url: "https://bugcrowd.com/engagements/acme-corp-bb",
  tab: { id: 7, url: "https://bugcrowd.com/engagements/acme-corp-bb" },
};
// Chrome sets sender.tab for ANY tab-hosted page — including this
// extension's own pages opened via tabs.create. A tab-hosted extension
// page is identified by its extension-origin sender URL, not by the
// absence of sender.tab.
const tabHostedExtensionSender = {
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL("/radar.html"),
  tab: { id: 9, url: fakeBrowser.runtime.getURL("/radar.html") },
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  vi.useFakeTimers();
  stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
  await fakeBrowser.storage.local.set({ apiCredential: CREDENTIAL });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  ({ routeMessage, coordinator, radar } = await import(
    "../entrypoints/background"
  ));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("routeMessage API op sender restriction", () => {
  it.each(["TEST_TOKEN", "LIST_ENGAGEMENTS", "GET_ENGAGEMENT"] as const)(
    "rejects %s when sender.tab is present (content script)",
    async (op) => {
      const params =
        op === "TEST_TOKEN"
          ? { token: "x" }
          : op === "GET_ENGAGEMENT"
            ? { uuid: ENGAGEMENT_UUID }
            : {};
      const res = await routeMessage({ op, params }, contentScriptSender);
      expect(res).toEqual({ ok: false, error: "forbidden" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("starts an in-page export for the sender's own tab only", async () => {
    const start = vi
      .spyOn(coordinator, "start")
      .mockResolvedValue({ ok: true, jobId: "job_ab12cd34" } as never);
    const res = await routeMessage({ op: "START_EXPORT_HERE" }, contentScriptSender);
    expect(start).toHaveBeenCalledWith(contentScriptSender.tab!.id);
    expect(res).toEqual({ ok: true, jobId: "job_ab12cd34" });
    start.mockRestore();
  });

  it("rejects an in-page export from a sender with no tab", async () => {
    const start = vi.spyOn(coordinator, "start");
    const res = await routeMessage({ op: "START_EXPORT_HERE" }, {});
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it("accepts API ops from an extension page hosted in a tab", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const res = await routeMessage(
      { op: "LIST_ENGAGEMENTS", params: { page: 1 } },
      tabHostedExtensionSender,
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the same ops from an extension page (no sender.tab)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const res = await routeMessage(
      { op: "LIST_ENGAGEMENTS", params: { page: 1 } },
      extensionPageSender,
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${API_BASE}/engagements?page[number]=1&page[size]=25`,
    );
  });

  it("opens the Radar page in a new tab for the in-page launcher", async () => {
    const create = vi
      .spyOn(fakeBrowser.tabs, "create")
      .mockResolvedValue({} as never);
    const res = await routeMessage({ op: "OPEN_RADAR" }, contentScriptSender);
    expect(res).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(String(create.mock.calls[0]![0].url)).toContain("radar.html");
    create.mockRestore();
  });

  it("OPEN_RADAR also works from an extension page", async () => {
    const create = vi
      .spyOn(fakeBrowser.tabs, "create")
      .mockResolvedValue({} as never);
    const res = await routeMessage({ op: "OPEN_RADAR" }, extensionPageSender);
    expect(res).toEqual({ ok: true });
    create.mockRestore();
  });
});

describe("routeMessage TEST_TOKEN", () => {
  it("returns token-valid detail on 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const res = await routeMessage(
      { op: "TEST_TOKEN", params: { token: "candidate-1" } },
      extensionPageSender,
    );
    expect(res).toEqual({ ok: true, data: { detail: "token valid" } });
    const init = fetchMock.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.Authorization).toBe("Token candidate-1");
  });

  it("returns a sanitized kind/message error on 401 and never echoes the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const res = await routeMessage(
      { op: "TEST_TOKEN", params: { token: "probe-secret-3" } },
      extensionPageSender,
    );
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("probe-secret-3");
  });
});

describe("routeMessage GET_ENGAGEMENT", () => {
  it("requires uuid XOR code", async () => {
    const both = await routeMessage(
      {
        op: "GET_ENGAGEMENT",
        params: { uuid: ENGAGEMENT_UUID, code: "acme-corp-bb" },
      },
      extensionPageSender,
    );
    expect(both.ok).toBe(false);
    const neither = await routeMessage(
      { op: "GET_ENGAGEMENT", params: {} },
      extensionPageSender,
    );
    expect(neither.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uuid path fetches the engagement and returns data + records", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fixture));
    const res = await routeMessage(
      { op: "GET_ENGAGEMENT", params: { uuid: ENGAGEMENT_UUID } },
      extensionPageSender,
    );
    expect(res.ok).toBe(true);
    const data = res.data as {
      engagement: { uuid: string };
      records: { sourceKey: string }[];
    };
    expect(data.engagement.uuid).toBe(ENGAGEMENT_UUID);
    expect(data.records.length).toBeGreaterThan(0);
    expect(data.records[0]?.sourceKey).toMatch(/^api:engagement:/);
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL);
  });

  it("code path resolves through the index then fetches by uuid", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("page[number]")) {
        return jsonResponse({
          data: [
            {
              type: "engagement",
              id: ENGAGEMENT_UUID,
              attributes: { code: "acme-corp-bb" },
            },
          ],
        });
      }
      return jsonResponse(fixture);
    });
    const res = await routeMessage(
      { op: "GET_ENGAGEMENT", params: { code: "acme-corp-bb" } },
      extensionPageSender,
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      `${API_BASE}/engagements/${ENGAGEMENT_UUID}?include=target_groups,targets`,
    );
  });

  it("returns engagement_not_found when the code matches nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const res = await routeMessage(
      { op: "GET_ENGAGEMENT", params: { code: "acme-corp-bb" } },
      extensionPageSender,
    );
    expect(res).toEqual({ ok: false, error: "engagement_not_found" });
  });

  it("maps ApiError to sanitized {kind,message}", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }));
    const res = await routeMessage(
      { op: "GET_ENGAGEMENT", params: { uuid: ENGAGEMENT_UUID } },
      extensionPageSender,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ kind: "forbidden" });
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL);
  });
});

describe("routeMessage radar ops", () => {
  const radarMsgs = [
    { op: "RADAR_START_SCAN" },
    { op: "RADAR_CANCEL_SCAN" },
    { op: "RADAR_GET_STATE" },
    { op: "RADAR_GET_RESULTS", profile: "best_ev", limit: 10 },
    { op: "RADAR_GET_PROGRAM", uuid: ENGAGEMENT_UUID },
  ];

  it.each(radarMsgs)(
    "rejects $op when sender.tab is present (content script)",
    async (msg) => {
      const res = await routeMessage(msg, contentScriptSender);
      expect(res).toEqual({ ok: false, error: "forbidden" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("RADAR_START_SCAN from an extension page starts the scan and returns the run", async () => {
    const fakeRun = {
      run_id: "radar_ab12cd34",
      phase: "catalog",
      discovered: 0,
      enriched: 0,
      scored: 0,
      pending_uuids: [],
      completed_uuids: [],
      warnings: 0,
      started_at: "2026-09-21T00:00:00.000Z",
      updated_at: "2026-09-21T00:00:00.000Z",
    };
    const start = vi
      .spyOn(radar, "start")
      .mockResolvedValue(fakeRun as never);
    const res = await routeMessage(
      { op: "RADAR_START_SCAN" },
      extensionPageSender,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, run: fakeRun });
    start.mockRestore();
  });

  it("RADAR ops from a tab-hosted extension page are accepted", async () => {
    const fakeRun = { run_id: "radar_tabhost", phase: "catalog" };
    const start = vi.spyOn(radar, "start").mockResolvedValue(fakeRun as never);
    const res = await routeMessage(
      { op: "RADAR_START_SCAN" },
      tabHostedExtensionSender,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, run: fakeRun });
    start.mockRestore();
  });

  it("RADAR_CANCEL_SCAN cancels the active run", async () => {
    const fakeRun = { run_id: "radar_ab12cd34", phase: "cancelled" };
    const cancel = vi
      .spyOn(radar, "cancel")
      .mockResolvedValue(fakeRun as never);
    const res = await routeMessage(
      { op: "RADAR_CANCEL_SCAN" },
      extensionPageSender,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, run: fakeRun });
    cancel.mockRestore();
  });

  it("RADAR_GET_STATE returns the current run", async () => {
    const getState = vi.spyOn(radar, "getState").mockResolvedValue(null);
    const res = await routeMessage(
      { op: "RADAR_GET_STATE" },
      extensionPageSender,
    );
    expect(getState).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, run: null });
    getState.mockRestore();
  });

  it("RADAR_GET_RESULTS forwards profile/limit/minConfidence", async () => {
    const getResults = vi
      .spyOn(radar, "getResults")
      .mockResolvedValue([] as never);
    const res = await routeMessage(
      {
        op: "RADAR_GET_RESULTS",
        profile: "low_competition",
        limit: 25,
        minConfidence: 0.7,
      },
      extensionPageSender,
    );
    expect(getResults).toHaveBeenCalledWith(
      "low_competition",
      25,
      0.7,
      undefined,
    );
    expect(res).toEqual({ ok: true, rows: [] });
    getResults.mockRestore();
  });

  it("RADAR_GET_RESULTS applies the schema default limit", async () => {
    const getResults = vi
      .spyOn(radar, "getResults")
      .mockResolvedValue([] as never);
    await routeMessage(
      { op: "RADAR_GET_RESULTS", profile: "best_ev" },
      extensionPageSender,
    );
    expect(getResults).toHaveBeenCalledWith("best_ev", 50, undefined, undefined);
    getResults.mockRestore();
  });

  it("RADAR_GET_PROGRAM defaults the profile to best_ev", async () => {
    const getProgram = vi
      .spyOn(radar, "getProgram")
      .mockResolvedValue(null as never);
    const res = await routeMessage(
      { op: "RADAR_GET_PROGRAM", uuid: ENGAGEMENT_UUID },
      extensionPageSender,
    );
    expect(getProgram).toHaveBeenCalledWith(ENGAGEMENT_UUID, "best_ev");
    expect(res).toEqual({ ok: true, program: null });
    getProgram.mockRestore();
  });

  it("maps a coordinator ApiError to sanitized {kind,message}", async () => {
    // Dynamic import so the class identity matches the fresh modules the
    // router imported after vi.resetModules().
    const { ApiError } = await import("../lib/api/errors");
    const getResults = vi
      .spyOn(radar, "getResults")
      .mockRejectedValue(new ApiError("no_token", "no credential") as never);
    const res = await routeMessage(
      { op: "RADAR_GET_RESULTS", profile: "best_ev", limit: 10 },
      extensionPageSender,
    );
    expect(res).toEqual({
      ok: false,
      error: { kind: "no_token", message: "no credential" },
    });
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL);
    getResults.mockRestore();
  });
});
