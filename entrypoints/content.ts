import { z } from "zod";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { BUGCROWD_SITE } from "../lib/constants";
import { collectDetails } from "../lib/dom/details";
import { collectPolicies } from "../lib/dom/policies";
import { collectTargets, type DomTarget } from "../lib/dom/targets";
import { collectActivity } from "../lib/dom/activity";
import {
  closeElement,
  collectKnownIssues,
  domKiDriver,
  type KiDriver,
} from "../lib/dom/knownIssues";
import { isSessionExpired } from "../lib/dom/session";
import {
  ensureRendered as ensureBriefRendered,
  windowTarget,
} from "../lib/dom/render";
import { keepMounted } from "../lib/ui/launcher";
import type { ActiveJobDescriptor } from "../lib/messages";
import type { JobDescriptor } from "../lib/job/descriptor";

// ---------------------------------------------------------------------------
// Content-script orchestrator (spec §7.4). main() captures the initial URL,
// reports PAGE_READY when an activeJob descriptor exists in storage.session,
// and serves RUN_UNIT requests from the coordinator. createOrchestrator is
// exported (with injected collectors) so unit tests exercise the real
// dispatch/session/restore logic with mocked collectors.
// ---------------------------------------------------------------------------

export interface UnitError {
  kind: string;
  message: string;
}

export interface UnitEnvelope {
  ok: boolean;
  result?: unknown;
  error?: UnitError;
}

/** RUN_UNIT {jobId, unitId, kind, params} — background → content script. */
const RunUnitMsg = z
  .object({
    op: z.literal("RUN_UNIT"),
    jobId: z.string().min(1),
    unitId: z.string().min(1),
    kind: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type FetchPage = (url: string) => Promise<Document | null>;

export interface OrchestratorDeps {
  doc: Document;
  /** URL captured on script load; collection is attributed to it. */
  initialUrl: string;
  /** activeJob.jobId when present; mismatched unit jobIds are rejected. */
  expectedJobId: string | null;
  kiDriver: KiDriver;
  collectDetails: (doc: Document, pageUrl: string) => unknown;
  collectTargets: (doc: Document, pageUrl: string) => unknown;
  collectPolicies: (doc: Document, pageUrl: string) => unknown;
  collectActivity: (
    doc: Document,
    pageUrl: string,
    fetchPage: FetchPage,
  ) => Promise<unknown>;
  collectKnownIssues: (
    driver: KiDriver,
    doc: Document,
    target: DomTarget,
    pageUrl: string,
  ) => Promise<unknown>;
  isSessionExpired: (doc: Document, url: string) => boolean;
  fetchPage: FetchPage;
  emitProgress: (
    jobId: string,
    unitId: string,
    counters: Record<string, number>,
  ) => void;
  /**
   * Brings the lazily-rendered brief into existence before anything is read.
   * Runs once per page; a failure here never blocks collection.
   */
  ensureRendered?: () => Promise<void>;
}

export interface Orchestrator {
  /** RUN_UNIT → envelope; other message shapes → undefined (not ours). */
  handleMessage(msg: unknown): Promise<UnitEnvelope | undefined>;
  /** Closes exporter-opened UI and restores the initial URL (§17). */
  restorePage(): Promise<{ closedElements: number; urlRestored: boolean }>;
  /** Every element the exporter opened, for restorePage()/cancellation. */
  openedElements: Set<Element>;
}

function envelopeErr(kind: string, message: string): UnitEnvelope {
  return { ok: false, error: { kind, message } };
}

/** Minimal structural check before params.target reaches the KI collector. */
function asDomTarget(raw: unknown): DomTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Partial<DomTarget>;
  return typeof t.domKey === "string" ? (t as DomTarget) : null;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const openedElements = new Set<Element>();
  let kiDone = 0;
  let rendered: Promise<void> | null = null;

  /** Once per page, and never a reason to abandon a collection. */
  const ensureRendered = async (): Promise<void> => {
    if (deps.ensureRendered === undefined) return;
    rendered ??= deps.ensureRendered().catch(() => undefined);
    await rendered;
  };

  // Everything the KI driver opens is tracked so restore_page can close it.
  const trackingDriver: KiDriver = {
    ...deps.kiDriver,
    open: async (doc, target) => {
      const el = await deps.kiDriver.open(doc, target);
      if (el !== null) openedElements.add(el);
      return el;
    },
  };

  const currentUrl = () =>
    deps.doc.defaultView?.location.href ?? deps.initialUrl;

  async function restorePage(): Promise<{
    closedElements: number;
    urlRestored: boolean;
  }> {
    let closedElements = 0;
    for (const el of [...openedElements]) {
      try {
        await closeElement(el);
        closedElements++;
      } catch {
        // best effort — restoration continues with the next element
      }
    }
    openedElements.clear();
    let urlRestored = false;
    const win = deps.doc.defaultView;
    if (win !== null && win.location.href !== deps.initialUrl) {
      urlRestored = true;
      try {
        win.history.back();
      } catch {
        try {
          win.location.assign(deps.initialUrl);
        } catch {
          urlRestored = false;
        }
      }
    }
    return { closedElements, urlRestored };
  }

  async function handleMessage(msg: unknown): Promise<UnitEnvelope | undefined> {
    const parsed = RunUnitMsg.safeParse(msg);
    if (!parsed.success) {
      // Malformed RUN_UNIT gets an envelope; foreign messages are ignored.
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { op?: unknown }).op === "RUN_UNIT"
      ) {
        return envelopeErr("invalid_message", "malformed RUN_UNIT message");
      }
      return undefined;
    }
    const unit = parsed.data;

    if (deps.expectedJobId !== null && unit.jobId !== deps.expectedJobId) {
      return envelopeErr("job_mismatch", "unit jobId does not match active job");
    }

    // Session check before every unit (§18: expiry during DOM collection is
    // fatal). restore_page is exempt — §17 cleanup must run even after
    // expiry/cancellation so exporter-opened UI never leaks.
    if (
      unit.kind !== "restore_page" &&
      deps.isSessionExpired(deps.doc, currentUrl())
    ) {
      return envelopeErr("session_expired", "session expired during collection");
    }

    // The brief renders on scroll; read nothing until it exists. restore_page
    // is exempt — cleanup must not re-render the page it is restoring.
    if (unit.kind !== "restore_page") await ensureRendered();

    try {
      switch (unit.kind) {
        case "collect_details":
          return { ok: true, result: deps.collectDetails(deps.doc, deps.initialUrl) };
        case "collect_targets":
          return { ok: true, result: deps.collectTargets(deps.doc, deps.initialUrl) };
        case "collect_policy":
          return { ok: true, result: deps.collectPolicies(deps.doc, deps.initialUrl) };
        case "collect_activity":
          return {
            ok: true,
            result: await deps.collectActivity(
              deps.doc,
              deps.initialUrl,
              deps.fetchPage,
            ),
          };
        case "collect_ki": {
          const target = asDomTarget(unit.params?.target);
          if (target === null) {
            return envelopeErr(
              "invalid_params",
              "collect_ki requires params.target with a domKey",
            );
          }
          const result = await deps.collectKnownIssues(
            trackingDriver,
            deps.doc,
            target,
            deps.initialUrl,
          );
          kiDone++;
          const total = unit.params?.kiTotal;
          deps.emitProgress(unit.jobId, unit.unitId, {
            kiDone,
            kiTotal: typeof total === "number" ? total : kiDone,
          });
          return { ok: true, result };
        }
        case "restore_page":
          return { ok: true, result: await restorePage() };
        default:
          return envelopeErr("unknown_unit_kind", `unknown unit kind: ${unit.kind}`);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message.slice(0, 300) : "unit failed";
      return envelopeErr("unit_failed", message);
    }
  }

  return { handleMessage, restorePage, openedElements };
}

/**
 * Same-origin authenticated fetch for pagination fallbacks (spec §6.2):
 * restricted to the bugcrowd.com origin; returns null on any failure. The
 * response is parsed through DOMParser — page text is untrusted data and is
 * never executed.
 */
export async function sameOriginFetchPage(url: string): Promise<Document | null> {
  if (typeof location === "undefined") return null;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.origin !== location.origin || target.origin !== BUGCROWD_SITE) {
    return null;
  }
  try {
    const res = await fetch(target.href, { credentials: "same-origin" });
    if (!res.ok) return null;
    const html = await res.text();
    return new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

/** The activeJob descriptor in storage.session, or null when absent. */
async function readActiveJob(): Promise<ActiveJobDescriptor | null> {
  try {
    const stored = await browser.storage.session.get("activeJob");
    const job = (stored as { activeJob?: unknown } | undefined)?.activeJob;
    if (
      typeof job === "object" &&
      job !== null &&
      typeof (job as { jobId?: unknown }).jobId === "string"
    ) {
      return job as ActiveJobDescriptor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * In-page launcher wiring (§7.4): the brief drives its own export, so the
 * toolbar popup is optional. The background resolves the tab from the sender,
 * so no tab id crosses this boundary.
 */
function startLauncher(): void {
  const send = async (msg: unknown): Promise<Record<string, unknown>> =>
    ((await browser.runtime.sendMessage(msg)) ?? {}) as Record<string, unknown>;
  const launcher = keepMounted(document, {
    startExport: async () => {
      const res = await send({ op: "START_EXPORT_HERE" });
      return {
        ok: res.ok === true,
        error: typeof res.error === "string" ? res.error : undefined,
      };
    },
    cancelExport: async (jobId) => {
      await send({ op: "CANCEL_EXPORT", jobId });
    },
    getState: async () => {
      const res = await send({ op: "GET_JOB_STATE" });
      return res.ok === true ? ((res.state ?? null) as JobDescriptor | null) : null;
    },
    openOptions: () => void browser.runtime.openOptionsPage(),
    // The brief navigates client-side; the URL is read per paint, not once.
    pageUrl: () => location.href,
    isVisible: () => document.visibilityState === "visible",
  });
  // The observer handles re-renders; this beat refreshes job state and
  // double-checks placement in case a render produced no observed mutation.
  // The keeper decides how hard to poll: a covered window still shows a
  // running export.
  window.setInterval(() => void launcher.tick(), 2000);
}

export default defineContentScript({
  matches: ["https://bugcrowd.com/engagements/*"],
  runAt: "document_idle",
  async main() {
    // 1. The initial URL is captured before any unit runs — collection is
    //    always attributed to it, and restore_page returns the tab to it.
    const initialUrl = location.href;
    const activeJob = await readActiveJob();

    const orchestrator = createOrchestrator({
      doc: document,
      initialUrl,
      expectedJobId: activeJob?.jobId ?? null,
      kiDriver: domKiDriver,
      collectDetails,
      collectTargets,
      collectPolicies,
      collectActivity,
      collectKnownIssues,
      isSessionExpired,
      fetchPage: sameOriginFetchPage,
      ensureRendered: async () => {
        await ensureBriefRendered(windowTarget(window));
      },
      emitProgress: (jobId, unitId, counters) => {
        void browser.runtime
          .sendMessage({ op: "UNIT_PROGRESS", jobId, unitId, counters })
          .catch(() => undefined);
      },
    });

    // 2. RUN_UNIT dispatch; the return value is the implicit UNIT_RESULT.
    //    The listener registers before PAGE_READY so a unit dispatched in
    //    response to readiness can never arrive early and be dropped.
    browser.runtime.onMessage.addListener((msg: unknown) =>
      orchestrator.handleMessage(msg),
    );

    // 3. Page readiness is reported only for an active job (§7.5): the
    //    coordinator reconnects after worker restarts / page navigations.
    if (activeJob !== null) {
      try {
        await browser.runtime.sendMessage({
          op: "PAGE_READY",
          jobId: activeJob.jobId,
          url: initialUrl,
        });
      } catch {
        // No listener yet — the coordinator polls readiness too.
      }
    }

    // 4. The in-page launcher. Mounted last so a failure here can never stop
    //    collection from being served.
    try {
      startLauncher();
    } catch {
      // The toolbar popup remains available.
    }
  },
});
