import { browser } from "wxt/browser";
import type { JobDescriptor } from "../../lib/job/descriptor";
import { isSupportedEngagementUrl } from "../../lib/ids";
import { viewFor } from "../../lib/ui/popupState";

const exportButton = document.querySelector<HTMLButtonElement>("#export")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const settingsButton = document.querySelector<HTMLButtonElement>("#settings")!;
const pageStatus = document.querySelector<HTMLElement>("#page-status")!;
const jobStatus = document.querySelector<HTMLDListElement>("#job-status")!;
const feedback = document.querySelector<HTMLElement>("#feedback")!;

let activeTabId: number | null = null;
let activeUrl: string | null = null;
let currentJob: JobDescriptor | null = null;

async function getState(): Promise<JobDescriptor | null> {
  const response = (await browser.runtime.sendMessage({ op: "GET_JOB_STATE" })) as {
    ok?: boolean;
    state?: JobDescriptor | null;
  };
  return response.ok ? response.state ?? null : null;
}

function render(): void {
  const view = viewFor(activeUrl, currentJob);
  exportButton.disabled = !view.canExport;
  const active = currentJob !== null && !["done", "failed", "cancelled"].includes(currentJob.phase);
  cancelButton.hidden = !active;
  pageStatus.textContent = activeUrl === null
    ? "No active tab found."
    : isSupportedEngagementUrl(activeUrl)
      ? "Ready on a supported engagement."
      : "Open a Bugcrowd engagement page to export.";
  jobStatus.replaceChildren();
  for (const line of view.statusLines) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = line.label;
    dd.textContent = line.value;
    jobStatus.append(dt, dd);
  }
}

async function refresh(): Promise<void> {
  try {
    currentJob = await getState();
    render();
  } catch {
    feedback.textContent = "Unable to read exporter state.";
  }
}

exportButton.addEventListener("click", async () => {
  if (activeTabId === null) return;
  exportButton.disabled = true;
  feedback.textContent = "Starting export…";
  const response = (await browser.runtime.sendMessage({
    op: "START_EXPORT",
    tabId: activeTabId,
  })) as { ok?: boolean; error?: string };
  feedback.textContent = response.ok ? "Export started." : `Could not start: ${response.error ?? "unknown error"}`;
  await refresh();
});

cancelButton.addEventListener("click", async () => {
  if (currentJob === null) return;
  cancelButton.disabled = true;
  await browser.runtime.sendMessage({ op: "CANCEL_EXPORT", jobId: currentJob.jobId });
  feedback.textContent = "Cancellation requested.";
  cancelButton.disabled = false;
  await refresh();
});

settingsButton.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  activeUrl = tab?.url ?? null;
  await refresh();
  window.setInterval(() => void refresh(), 1000);
}

void init();
