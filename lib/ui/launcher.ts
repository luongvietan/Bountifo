import type { JobDescriptor } from "../job/descriptor";
import { isSupportedEngagementUrl } from "../ids";
import { viewFor } from "./popupState";

// ---------------------------------------------------------------------------
// In-page launcher (spec §7.4 UI surface). The exporter is driven from the
// engagement brief itself instead of the toolbar popup, so the button lives
// beside the engagement logo.
//
// Everything is rendered inside a shadow root. That is not cosmetic: the DOM
// collectors and the Known Issues driver scan `document` for tables, list
// items, buttons and `[role=dialog]`, and shadow content is invisible to those
// queries. A light-DOM panel would be collected as engagement evidence and
// could be mistaken for the Known Issues dialog.
// ---------------------------------------------------------------------------

/** Marks the exporter's own nodes so collectors can skip them (§7.4). */
export const EXPORTER_UI_ATTR = "data-bugcrowd-exporter";

export interface LauncherDeps {
  /** START_EXPORT for the tab this script runs in; the tab is never named. */
  startExport: () => Promise<{ ok: boolean; error?: string }>;
  cancelExport: (jobId: string) => Promise<void>;
  getState: () => Promise<JobDescriptor | null>;
  openOptions: () => void;
  /** Opens the Radar extension page (the background names the tab). */
  openRadar: () => void;
  /** Read per paint: the brief is a single-page app and navigates in place. */
  pageUrl: () => string;
  /** Defaults to true; a covered window still reports a running job. */
  isVisible?: () => boolean;
}

export interface LauncherHandle {
  /** Re-reads job state and repaints. */
  refresh: () => Promise<void>;
  destroy: () => void;
  host: Element;
  /** Panel visibility, so a remount can restore it. */
  isOpen: () => boolean;
  /** True while the last known job is still running. */
  hasActiveJob: () => boolean;
}

export interface MountOptions {
  /** Start with the panel open (used when restoring after a remount). */
  open?: boolean;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** Polls per look-in while the tab is hidden and no job is known to run. */
const HIDDEN_BEAT = 5;

/**
 * Layout on the host element itself, inline so the brief's own flex/grid rules
 * cannot squeeze or stretch the button (`:host` styles lose to the page's
 * rules for the host's own box).
 */
const HOST_STYLE =
  "display:inline-flex;flex:0 0 auto;align-self:flex-start;margin-left:8px;";
const FLOATING_STYLE = "position:fixed;right:16px;bottom:16px;z-index:2147483000;";

const STYLE = `
:host { all: initial; }
.wrap { position: relative; display: inline-flex; font: 500 13px/1.4 system-ui, sans-serif; vertical-align: top; }
button { font: inherit; white-space: nowrap; cursor: pointer; border-radius: 6px; border: 1px solid #c7c7d1; background: #fff; color: #16161d; padding: 7px 12px; }
button:disabled { cursor: not-allowed; opacity: .55; }
button[data-control="toggle"] { background: #16161d; border-color: #16161d; color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
button[data-control="toggle"]:hover { background: #2e2e3c; }
button.primary { background: #16161d; border-color: #16161d; color: #fff; }
.panel { position: absolute; top: calc(100% + 8px); right: 0; width: 260px; padding: 12px; z-index: 2147483000;
  background: #fff; color: #16161d; border: 1px solid #d7d7e0; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.panel[hidden] { display: none; }
h2 { margin: 0 0 8px; font-size: 13px; }
dl { display: grid; grid-template-columns: auto auto; gap: 2px 10px; margin: 0 0 10px; font-size: 12px; }
dt { color: #5b5b6b; } dd { margin: 0; text-align: right; }
.row { display: flex; gap: 6px; }
p { margin: 8px 0 0; font-size: 12px; color: #5b5b6b; }
`;

/**
 * True for the engagements index (https://bugcrowd.com/engagements[/]) — the
 * page whose tab strip ends in "Featured". Sub-paths belong to engagements.
 */
function isEngagementListUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.hostname === "bugcrowd.com" &&
      (url.pathname === "/engagements" || url.pathname === "/engagements/")
    );
  } catch {
    return false;
  }
}

/**
 * The "Featured" item in the index tab strip. The link/button itself may sit
 * inside a pure wrapper (e.g. an li whose only content is the link), so we
 * climb while the parent is just this item — the button then mounts as a
 * sibling item right of Featured, not inside the tab itself.
 */
function findFeaturedTab(doc: Document): Element | null {
  for (const el of doc.querySelectorAll("a, button, [role='tab'], [role='link']")) {
    if (el.textContent?.trim().toLowerCase() !== "featured") continue;
    let item = el;
    while (
      item.parentElement !== null &&
      item.parentElement.textContent?.trim().toLowerCase() === "featured"
    ) {
      item = item.parentElement;
    }
    return item;
  }
  return null;
}

/**
 * Where the button belongs, by page kind (url is the current page URL — the
 * brief navigates client-side, so it is read per resolution):
 *
 * - engagement detail: inside the program title (the brief header's heading),
 *   so the button sits on the title line right of the title text;
 * - engagements index: as a sibling item right of the "Featured" tab;
 * - fallback: beside the engagement logo, else inside the brief header, else
 *   floating over the page.
 *
 * The logo's outermost wrapper inside the header is used so the button is
 * not injected into a link or figure.
 */
export function resolveAnchor(
  doc: Document,
  url?: string,
): {
  parent: Element;
  after: Element | null;
  floating: boolean;
} {
  const pageUrl = url ?? doc.defaultView?.location?.href ?? "";
  if (isSupportedEngagementUrl(pageUrl)) {
    const title =
      doc.querySelector("main header h2") ??
      doc.querySelector("main header h1") ??
      doc.querySelector("[role='main'] header h2, [role='main'] header h1") ??
      doc.querySelector("header h2, header h1");
    // Mounting inside the heading keeps the button on the title line; the
    // keeper re-anchors it when the SPA replaces the heading.
    if (title !== null) {
      return { parent: title, after: null, floating: false };
    }
  } else if (isEngagementListUrl(pageUrl)) {
    const featured = findFeaturedTab(doc);
    if (featured !== null) {
      return {
        parent: featured.parentElement ?? doc.body,
        after: featured,
        floating: false,
      };
    }
  }
  const header =
    doc.querySelector("main header,[role='main'] header") ??
    doc.querySelector("header");
  if (header !== null) {
    const logo = header.querySelector("img");
    if (logo !== null) {
      let outer: Element = logo;
      while (outer.parentElement !== null && outer.parentElement !== header) {
        outer = outer.parentElement;
      }
      return { parent: outer.parentElement ?? header, after: outer, floating: false };
    }
    return { parent: header, after: null, floating: false };
  }
  const body = doc.body ?? doc.documentElement;
  return { parent: body, after: null, floating: true };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Partial<Record<string, string>> = {},
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) node.setAttribute(key, value);
  }
  return node;
}

/**
 * Mounts the launcher once per document and returns a handle. Calling it again
 * on a document that already has one is a no-op that returns the existing
 * handle, so a re-injected content script never stacks buttons.
 */
export function mountLauncher(
  doc: Document,
  deps: LauncherDeps,
  options: MountOptions = {},
): LauncherHandle {
  const existing = doc.querySelector(`[${EXPORTER_UI_ATTR}]`);
  if (existing !== null) {
    const handle = (existing as { __launcher?: LauncherHandle }).__launcher;
    if (handle !== undefined) return handle;
  }

  const anchor = resolveAnchor(doc, deps.pageUrl());
  const host = el(doc, "span", {
    [EXPORTER_UI_ATTR]: "ui",
    style: anchor.floating ? `${HOST_STYLE}${FLOATING_STYLE}` : HOST_STYLE,
  });
  if (anchor.after !== null) anchor.after.insertAdjacentElement("afterend", host);
  else anchor.parent.append(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = el(doc, "style");
  style.textContent = STYLE;
  const wrap = el(doc, "div", { class: "wrap" });

  const toggle = el(doc, "button", {
    "data-control": "toggle",
    "aria-expanded": "false",
    "aria-label": "Bugcrowd engagement exporter",
    type: "button",
  });
  toggle.textContent = "Export brief";

  // role=dialog is safe here: shadow content is not reachable from the
  // document queries the Known Issues driver uses.
  const panel = el(doc, "div", {
    class: "panel",
    role: "dialog",
    "aria-label": "Engagement exporter",
    hidden: "",
  });
  const title = el(doc, "h2");
  title.textContent = "Engagement exporter";
  const status = el(doc, "dl", { "data-control": "status" });
  const row = el(doc, "div", { class: "row" });
  const exportBtn = el(doc, "button", {
    "data-control": "export",
    class: "primary",
    type: "button",
  });
  exportBtn.textContent = "Export";
  const cancelBtn = el(doc, "button", { "data-control": "cancel", type: "button" });
  cancelBtn.textContent = "Cancel";
  const settingsBtn = el(doc, "button", {
    "data-control": "settings",
    type: "button",
  });
  settingsBtn.textContent = "Settings";
  const radarBtn = el(doc, "button", {
    "data-control": "radar",
    type: "button",
  });
  radarBtn.textContent = "Open Radar";
  const feedback = el(doc, "p", { "data-control": "feedback" });

  row.append(exportBtn, cancelBtn, settingsBtn, radarBtn);
  panel.append(title, status, row, feedback);
  wrap.append(toggle, panel);
  shadow.append(style, wrap);

  let job: JobDescriptor | null = null;

  function paint(): void {
    const view = viewFor(deps.pageUrl(), job);
    const active = job !== null && !TERMINAL.has(job.phase);
    exportBtn.disabled = !view.canExport;
    cancelBtn.hidden = !active;
    status.replaceChildren();
    if (view.statusLines.length === 0) {
      const dt = el(doc, "dt");
      dt.textContent = "Status";
      const dd = el(doc, "dd");
      dd.textContent = view.canExport ? "Ready" : "Not an engagement page";
      status.append(dt, dd);
      return;
    }
    for (const line of view.statusLines) {
      const dt = el(doc, "dt");
      dt.textContent = line.label;
      const dd = el(doc, "dd");
      dd.textContent = line.value;
      status.append(dt, dd);
    }
  }

  // One poll at a time. A slow round-trip during collection used to let
  // several refreshes stack and resolve out of order, repainting the panel
  // with a stale snapshot.
  let inFlight: Promise<void> | null = null;
  async function refresh(): Promise<void> {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        job = await deps.getState();
        paint();
      } catch {
        feedback.textContent = "Unable to read exporter state.";
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  toggle.addEventListener("click", () => {
    const open = panel.hasAttribute("hidden");
    if (open) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
    toggle.setAttribute("aria-expanded", String(open));
    if (open) void refresh();
  });

  exportBtn.addEventListener("click", () => {
    exportBtn.disabled = true;
    feedback.textContent = "Starting export…";
    void deps
      .startExport()
      .then(async (res) => {
        feedback.textContent = res.ok
          ? "Export started."
          : `Could not start: ${res.error ?? "unknown error"}`;
        await refresh();
      })
      .catch(() => {
        feedback.textContent = "Could not start: unknown error";
      });
  });

  cancelBtn.addEventListener("click", () => {
    if (job === null) return;
    const jobId = job.jobId;
    cancelBtn.disabled = true;
    void deps
      .cancelExport(jobId)
      .then(async () => {
        feedback.textContent = "Cancellation requested.";
        cancelBtn.disabled = false;
        await refresh();
      })
      .catch(() => {
        cancelBtn.disabled = false;
      });
  });

  settingsBtn.addEventListener("click", () => deps.openOptions());
  radarBtn.addEventListener("click", () => deps.openRadar());

  paint();

  if (options.open === true) {
    panel.removeAttribute("hidden");
    toggle.setAttribute("aria-expanded", "true");
    void refresh();
  }

  const handle: LauncherHandle = {
    refresh,
    destroy: () => host.remove(),
    host,
    isOpen: () => !panel.hasAttribute("hidden"),
    hasActiveJob: () => job !== null && !TERMINAL.has(job.phase),
  };
  (host as { __launcher?: LauncherHandle }).__launcher = handle;
  return handle;
}

// ---------------------------------------------------------------------------
// Staying mounted. The brief is a single-page app: it rebuilds the header on
// render, on tab switches inside the brief, and on client-side navigation
// between engagements, taking any foreign child with it. Mounting once makes
// the button appear and then vanish, so the mount is supervised instead.
// ---------------------------------------------------------------------------

export interface LauncherKeeper {
  /** Remounts when the button is gone or no longer beside the logo. */
  check: () => void;
  /** Repaints the live handle (a remount replaces the previous one). */
  refresh: () => Promise<void>;
  /**
   * One polling beat: keeps the mount honest and the panel current. A hidden
   * tab is still polled while a job runs — the export happens in the
   * background worker, and the reader is often watching from another window.
   */
  tick: () => Promise<void>;
  stop: () => void;
}

/** True when the button is missing, detached, or no longer at its anchor. */
function misplaced(doc: Document, host: Element | null, url: string): boolean {
  if (host === null || !host.isConnected) return true;
  const anchor = resolveAnchor(doc, url);
  // Nothing better to move to: a floating button stays where it is.
  if (anchor.floating) return false;
  if (anchor.after !== null) return host.previousElementSibling !== anchor.after;
  return host.parentElement !== anchor.parent;
}

export function keepMounted(
  doc: Document,
  deps: LauncherDeps,
  options: { debounceMs?: number } = {},
): LauncherKeeper {
  let handle = mountLauncher(doc, deps);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let beat = 0;

  const check = (): void => {
    if (stopped) return;
    const host = doc.querySelector(`[${EXPORTER_UI_ATTR}]`);
    if (!misplaced(doc, host, deps.pageUrl())) return;
    // The previous handle still answers for its own markup even after the
    // page detached it, so an open panel survives the rebuild.
    const open = handle.isOpen();
    host?.remove();
    handle = mountLauncher(doc, deps, { open });
  };

  // Observing the whole document is what the page's own re-renders demand;
  // the callback only runs a single attribute query, and repeated mutations
  // in one render collapse into one check.
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
  const observer = new Observer(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      check();
    }, options.debounceMs ?? 100);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  return {
    check,
    refresh: () => handle.refresh(),
    tick: async () => {
      beat++;
      const visible = deps.isVisible === undefined || deps.isVisible();
      // Hidden and idle: look in occasionally, because a job may have been
      // started from the popup or from another window since the last look.
      if (!visible && !handle.hasActiveJob() && beat % HIDDEN_BEAT !== 0) return;
      check();
      await handle.refresh();
    },
    stop: () => {
      stopped = true;
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      handle.destroy();
    },
  };
}
