import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { JobCoordinator, type CoordinatorDeps } from "../lib/job/coordinator";
import { UNIT_ORDER } from "../lib/job/units";
import { newDescriptor, writeDescriptor } from "../lib/job/descriptor";
import { commitUnit, openStore } from "../lib/job/store";
import { browser } from "wxt/browser";

const URL = "https://bugcrowd.com/engagements/acme";
const SECRET = "secret-token-should-never-leak";

function details() {
  return {
    records: [],
    data: {
      name: "Acme",
      code: "acme",
      engagementType: "Bug Bounty",
      managedBounty: true,
      lifecycleStatus: "live",
      testingStart: null,
      testingEnd: null,
      testingPeriodLabel: "Ongoing",
      lastStatusTransition: null,
      lastBriefUpdate: null,
      safeHarborLevel: null,
      disclosurePolicy: null,
      statistics: {},
    },
  };
}

const TARGET = {
  domKey: "target:example-com",
  groupDomKey: "group:web",
  inScope: true,
  location: "https://example.com",
  name: "Example",
  category: "website",
  tags: [],
  docLinks: [],
  changeFlags: [],
  displayedKnownIssuesCount: 0,
  kiControlLabel: null,
};

function scriptedDeps(messages: unknown[]): CoordinatorDeps {
  return {
    getTabUrl: vi.fn(async () => URL),
    now: vi.fn(() => "2026-09-20T02:00:00Z"),
    apiEnrich: vi.fn(async () => ({ ok: false, error: { kind: "not_found", message: "not found" } } as never)),
    download: vi.fn(async () => undefined),
    sendToTab: vi.fn(async (_tabId, raw) => {
      messages.push(raw);
      const msg = raw as { kind: string; params?: Record<string, unknown> };
      if (msg.kind === "collect_details") return { ok: true, result: details() };
      if (msg.kind === "collect_targets") {
        return {
          ok: true,
          result: {
            records: [{ sourceKey: "dom:scope:rule:no-automation", sourceType: "dom", sourceLevel: "target_specific_rule", sourceUrl: URL, authenticated: true, locator: { section: "Scope", targetId: TARGET.domKey }, quote: "Do not automate this target", extractionStatus: "exact", data: { text: "Do not automate this target", appliesToDomKeys: [TARGET.domKey], level: "target_specific_rule" } }],
            groups: [{ domKey: "group:web", name: "Web", inScope: true, description: null, rewards: { p1: null, p2: null, p3: null, p4: null, p5: null } }],
            targets: [TARGET],
            rules: [{ text: "Do not automate this target", appliesToDomKeys: [TARGET.domKey], level: "target_specific_rule" }],
          },
        };
      }
      if (msg.kind === "collect_policy") {
        return { ok: true, result: { records: [], data: { safeHarborStatements: [], authorizationStatements: [], techniques: [], accountRules: [], dataRules: [], focusAreas: [], nonFocusAreas: [], reportingRequirements: [], vrt: { version: null, baseline: null, exclusions: [], deviations: [], targetSpecific: [], notes: [] } } } };
      }
      if (msg.kind === "collect_activity") {
        return { ok: true, result: { records: [], announcements: [], changelog: [], recentActivity: [], acceptedReports: [], stats: {} } };
      }
      if (msg.kind === "collect_ki") {
        return { ok: true, result: { targetDomKey: TARGET.domKey, displayedCount: 0, collectedCount: 0, columns: [], rows: [], skipped: true, countMatches: true, warnings: [], records: [] } };
      }
      if (msg.kind === "restore_page") return { ok: true, result: {} };
      throw new Error(`unexpected unit ${msg.kind}`);
    }),
  };
}

beforeEach(async () => {
  fakeBrowser.reset();
  await fakeBrowser.storage.local.set({ apiCredential: SECRET });
});

describe("JobCoordinator", () => {
  it("refuses to overwrite a persisted active job during service-worker startup races", async () => {
    const active = newDescriptor(7, "acme", URL);
    await writeDescriptor(active);
    const messages: unknown[] = [];
    const coordinator = new JobCoordinator(scriptedDeps(messages));
    expect(await coordinator.start(7)).toEqual({ ok: false, error: "job_active" });
    expect(messages).toEqual([]);
  });

  it("drives all units, checkpoints after results, downloads, cleans up, and leaks no token", async () => {
    const messages: unknown[] = [];
    const deps = scriptedDeps(messages);
    const coordinator = new JobCoordinator(deps);
    const started = await coordinator.start(7);
    expect(started.ok).toBe(true);
    await coordinator.waitForIdle();
    expect(coordinator.state?.phase).toBe("done");
    expect(coordinator.state?.completedUnits).toEqual(UNIT_ORDER);
    expect(deps.download).toHaveBeenCalledOnce();
    const markdown = vi.mocked(deps.download!).mock.calls[0]![1];
    expect(markdown).toContain("status: prohibited");
    expect(markdown).toContain("type: target_ids");
    const kinds = messages.map((m) => (m as { kind?: string }).kind).filter(Boolean);
    expect(kinds).toEqual([
      "collect_details",
      "collect_targets",
      "collect_policy",
      "collect_activity",
      "collect_ki",
      "restore_page",
    ]);
    expect(JSON.stringify(messages)).not.toContain(SECRET);
    expect(JSON.stringify(coordinator.state)).not.toContain(SECRET);
    expect(await fakeBrowser.storage.session.get("activeJob")).toEqual({});
  });

  it("cancels between units, restores the page, and never downloads", async () => {
    const messages: unknown[] = [];
    let release!: (value: unknown) => void;
    const first = new Promise((resolve) => { release = resolve; });
    const deps = scriptedDeps(messages);
    vi.mocked(deps.sendToTab).mockImplementationOnce(async (_tabId, raw) => {
      messages.push(raw);
      return first;
    });
    const coordinator = new JobCoordinator(deps);
    await coordinator.start(7);
    await vi.waitFor(() => expect(messages.length).toBe(1));
    const cancelling = coordinator.cancel();
    release({ ok: true, result: details() });
    await cancelling;
    await coordinator.waitForIdle();
    expect(coordinator.state?.phase).toBe("cancelled");
    expect(deps.download).not.toHaveBeenCalled();
    expect(messages.map((m) => (m as { kind?: string }).kind)).toEqual([
      "collect_details",
      "restore_page",
    ]);
  });

  it("resumes from the first pending unit instead of repeating completed collectors", async () => {
    const descriptor = newDescriptor(7, "acme", URL);
    descriptor.jobId = `job_resume_${crypto.randomUUID()}`;
    descriptor.completedUnits = [...UNIT_ORDER.slice(0, 5)];
    descriptor.pendingUnits = [...UNIT_ORDER.slice(5)];
    descriptor.currentUnit = "u06_collect_policy";
    await writeDescriptor(descriptor);
    const db = await openStore();
    for (const unitId of UNIT_ORDER.slice(0, 5)) {
      const blob =
        unitId === "u03_collect_details"
          ? { kind: "detailsData", value: details().data }
          : unitId === "u04_api_enrichment"
            ? { kind: "apiData", value: null }
            : unitId === "u05_collect_targets"
              ? { kind: "targetsData", value: { groups: [], targets: [TARGET], rules: [] } }
              : undefined;
      await commitUnit(
        db,
        descriptor.jobId,
        unitId,
        blob === undefined ? {} : { blob },
        { unitId, status: unitId === "u04_api_enrichment" ? "warning" : "ok", committedAt: "t" },
      );
    }
    db.close();

    const messages: unknown[] = [];
    const deps = scriptedDeps(messages);
    const resumed = new JobCoordinator(deps);
    await resumed.resume();
    expect(resumed.state?.phase).toBe("done");
    expect(messages.map((m) => (m as { kind?: string }).kind)).toEqual([
      "collect_policy",
      "collect_activity",
      "collect_ki",
      "restore_page",
    ]);
  });

  it("fails closed when a completed checkpoint references missing data", async () => {
    const descriptor = newDescriptor(7, "acme", URL);
    descriptor.jobId = `job_broken_${crypto.randomUUID()}`;
    descriptor.completedUnits = ["u01_validate_url", "u02_init_job", "u03_collect_details"];
    descriptor.pendingUnits = [...UNIT_ORDER.slice(3)];
    await writeDescriptor(descriptor);
    const db = await openStore();
    for (const unitId of descriptor.completedUnits.slice(0, 2)) {
      await commitUnit(db, descriptor.jobId, unitId, {}, { unitId, status: "ok", committedAt: "t" });
    }
    db.close();
    const messages: unknown[] = [];
    const resumed = new JobCoordinator(scriptedDeps(messages));
    await resumed.resume();
    expect(resumed.state?.phase).toBe("failed");
    expect(messages.map((m) => (m as { kind?: string }).kind)).toEqual(["restore_page"]);
  });

  it("resumes inside Known Issues and skips targets already sub-checkpointed", async () => {
    const secondTarget = { ...TARGET, domKey: "target:second", location: "https://second.example" };
    const descriptor = newDescriptor(7, "acme", URL);
    descriptor.jobId = `job_ki_${crypto.randomUUID()}`;
    descriptor.completedUnits = [...UNIT_ORDER.slice(0, 7)];
    descriptor.pendingUnits = [...UNIT_ORDER.slice(7)];
    descriptor.currentUnit = "u08_known_issues";
    await writeDescriptor(descriptor);
    const db = await openStore();
    for (const unitId of UNIT_ORDER.slice(0, 7)) {
      const blob =
        unitId === "u03_collect_details" ? { kind: "detailsData", value: details().data } :
        unitId === "u04_api_enrichment" ? { kind: "apiData", value: null } :
        unitId === "u05_collect_targets" ? { kind: "targetsData", value: { groups: [], targets: [TARGET, secondTarget], rules: [] } } :
        unitId === "u06_collect_policy" ? { kind: "policyData", value: { safeHarborStatements: [], authorizationStatements: [], techniques: [], accountRules: [], dataRules: [], focusAreas: [], nonFocusAreas: [], reportingRequirements: [], vrt: { version: null, baseline: null, exclusions: [], deviations: [], targetSpecific: [], notes: [] } } } :
        unitId === "u07_collect_activity" ? { kind: "activityData", value: { announcements: [], changelog: [], recentActivity: [], acceptedReports: [], stats: {} } } : undefined;
      await commitUnit(db, descriptor.jobId, unitId, blob === undefined ? {} : { blob }, { unitId, status: unitId === "u04_api_enrichment" ? "warning" : "ok", committedAt: "t" });
    }
    await commitUnit(
      db,
      descriptor.jobId,
      "u08_known_issues",
      { blob: { kind: "kiResults", value: [{ targetDomKey: TARGET.domKey, displayedCount: 0, collectedCount: 0, columns: [], rows: [], skipped: true, countMatches: true, warnings: [], records: [] }] } },
      { unitId: "u08_known_issues", status: "ok", committedAt: "t", output: { kiDone: [TARGET.domKey] } },
    );
    db.close();
    const messages: unknown[] = [];
    const resumed = new JobCoordinator(scriptedDeps(messages));
    await resumed.resume();
    const kiMessages = messages.filter((m) => (m as { kind?: string }).kind === "collect_ki") as { params: { target: { domKey: string } } }[];
    expect(kiMessages).toHaveLength(1);
    expect(kiMessages[0]!.params.target.domKey).toBe(secondTarget.domKey);
  });

  it.each(["session_expired", "tab_closed"])(
    "treats %s during DOM collection as fatal and cleans up",
    async (kind) => {
      const messages: unknown[] = [];
      const deps = scriptedDeps(messages);
      vi.mocked(deps.sendToTab).mockImplementationOnce(async (_tabId, raw) => {
        messages.push(raw);
        if (kind === "tab_closed") throw new Error("gone");
        return { ok: false, error: { kind: "session_expired", message: "expired" } };
      });
      const coordinator = new JobCoordinator(deps);
      await coordinator.start(7);
      await coordinator.waitForIdle();
      expect(coordinator.state?.phase).toBe("failed");
      expect(messages.map((m) => (m as { kind?: string }).kind)).toEqual([
        "collect_details",
        "restore_page",
      ]);
      expect(deps.download).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed noncritical required collector as a partial export", async () => {
    const messages: unknown[] = [];
    const deps = scriptedDeps(messages);
    const original = vi.mocked(deps.sendToTab).getMockImplementation()!;
    vi.mocked(deps.sendToTab).mockImplementation(async (tabId, raw) => {
      if ((raw as { kind?: string }).kind === "collect_policy") {
        messages.push(raw);
        return { ok: false, error: { kind: "unit_failed", message: "selector changed" } };
      }
      return original(tabId, raw);
    });
    const coordinator = new JobCoordinator(deps);
    await coordinator.start(7);
    await coordinator.waitForIdle();
    expect(coordinator.state?.phase).toBe("done");
    const markdown = vi.mocked(deps.download!).mock.calls[0]![1];
    expect(markdown).toContain("status: partial");
    expect(markdown).toContain("required_sections_complete: false");
  });

  it("rejects progress from the wrong unit and the wrong sender", async () => {
    const messages: unknown[] = [];
    let release!: (value: unknown) => void;
    const deps = scriptedDeps(messages);
    vi.mocked(deps.sendToTab).mockImplementationOnce(async (_tabId, raw) => {
      messages.push(raw);
      return new Promise((resolve) => { release = resolve; });
    });
    const coordinator = new JobCoordinator(deps);
    const started = await coordinator.start(7);
    if (!started.ok) throw new Error(started.error);
    await vi.waitFor(() => expect(coordinator.state?.currentUnit).toBe("u03_collect_details"));
    const wrongUnit = await coordinator.handleJobMessage(
      { op: "UNIT_PROGRESS", jobId: started.jobId, unitId: "u04_api_enrichment", counters: { kiDone: 1 } },
      { id: browser.runtime.id, tab: { id: 7, url: URL } },
    );
    expect(wrongUnit).toEqual({ ok: false, error: "unexpected_unit" });
    const wrongSender = await coordinator.handleJobMessage(
      { op: "UNIT_PROGRESS", jobId: started.jobId, unitId: "u03_collect_details", counters: { kiDone: 1 } },
      { id: "another-extension", tab: { id: 7, url: URL } },
    );
    expect(wrongSender).toEqual({ ok: false, error: "forbidden" });
    const cancelling = coordinator.cancel();
    release({ ok: true, result: details() });
    await cancelling;
    await coordinator.waitForIdle();
  });
});
