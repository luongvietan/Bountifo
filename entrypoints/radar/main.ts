import { browser } from "wxt/browser";
import type { RadarMessage } from "../../lib/messages";
import type {
  RadarProgramDetail,
  RadarResultRow,
  RadarRunState,
} from "../../lib/radar/coordinator";
import type { RadarProfileId } from "../../lib/radar/types";
import {
  buildRows,
  componentRows,
  errorText,
  formatCoverage,
  formatScore,
  isActive,
  profileOptions,
  statusText,
} from "./view";

// ---------------------------------------------------------------------------
// Engagement Radar page (Task 21) — thin DOM layer over the RADAR_* message
// ops. All scan work happens in the background coordinator; this page only
// sends named ops, polls state while a run is active, and renders rows.
// ---------------------------------------------------------------------------

/** Response envelope of the background router (entrypoints/background.ts). */
interface RouterResponse {
  ok?: boolean;
  error?: unknown;
  run?: RadarRunState | null;
  rows?: RadarResultRow[];
  program?: RadarProgramDetail | null;
}

const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const profileSelect = document.querySelector<HTMLSelectElement>("#profile")!;
const statusLine = document.querySelector<HTMLElement>("#status")!;
const feedback = document.querySelector<HTMLElement>("#feedback")!;
const resultsBody =
  document.querySelector<HTMLTableSectionElement>("#results-body")!;
const detailSection = document.querySelector<HTMLElement>("#detail")!;
const detailTitle = document.querySelector<HTMLElement>("#detail-title")!;
const detailMeta = document.querySelector<HTMLElement>("#detail-meta")!;
const componentsBody =
  document.querySelector<HTMLTableSectionElement>("#components-body")!;
const explanationList =
  document.querySelector<HTMLUListElement>("#explanation")!;

const RESULT_LIMIT = 50;
const POLL_MS = 1000;

let currentProfile: RadarProfileId = "best_ev";
let pollTimer: number | null = null;

async function send(msg: RadarMessage): Promise<RouterResponse> {
  return (await browser.runtime.sendMessage(msg)) as RouterResponse;
}

function renderState(state: RadarRunState | null): void {
  statusLine.textContent = statusText(state);
  cancelButton.hidden = !isActive(state);
}

function cell(tr: HTMLTableRowElement, text: string): void {
  const td = document.createElement("td");
  td.textContent = text;
  tr.append(td);
}

function renderRows(rows: RadarResultRow[]): void {
  resultsBody.replaceChildren();
  const views = buildRows(rows);
  if (views.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "empty";
    td.textContent = "No scored programs yet — run a scan.";
    tr.append(td);
    resultsBody.append(tr);
    return;
  }
  for (const view of views) {
    const tr = document.createElement("tr");
    if (!view.eligible) tr.classList.add("ineligible");
    if (view.provisional) tr.classList.add("provisional");
    for (const text of [
      view.rank,
      view.program,
      view.score,
      view.coverage,
      view.reward,
      view.surface,
      view.competition,
      view.freshness,
    ]) {
      cell(tr, text);
    }
    tr.addEventListener("click", () => void selectProgram(view.uuid));
    resultsBody.append(tr);
  }
}

function renderDetail(detail: RadarProgramDetail, uuid: string): void {
  detailSection.hidden = false;
  detailTitle.textContent =
    detail.catalog?.name ??
    detail.catalog?.code ??
    detail.snapshot?.code ??
    uuid;
  detailMeta.textContent =
    detail.score === null
      ? "No score stored for this profile."
      : `Score ${formatScore(detail.score.score)} · coverage ${formatCoverage(detail.score.confidence)}${detail.score.provisional ? " · PROVISIONAL" : ""}`;
  componentsBody.replaceChildren();
  if (detail.score !== null) {
    for (const component of componentRows(detail.score)) {
      const tr = document.createElement("tr");
      for (const text of [
        component.label,
        component.signal,
        component.weight,
        component.contribution,
      ]) {
        cell(tr, text);
      }
      componentsBody.append(tr);
    }
  }
  explanationList.replaceChildren();
  if (detail.explanation.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No explanation available.";
    explanationList.append(li);
  } else {
    for (const line of detail.explanation) {
      const li = document.createElement("li");
      li.textContent = line;
      explanationList.append(li);
    }
  }
}

async function selectProgram(uuid: string): Promise<void> {
  const resp = await send({
    op: "RADAR_GET_PROGRAM",
    uuid,
    profile: currentProfile,
  });
  if (resp.ok === true) {
    if (resp.program != null) {
      renderDetail(resp.program, uuid);
    } else {
      feedback.textContent = "No stored data for that program.";
    }
  } else {
    feedback.textContent = `Could not load program: ${errorText(resp.error)}`;
  }
}

async function refreshResults(): Promise<void> {
  const resp = await send({
    op: "RADAR_GET_RESULTS",
    profile: currentProfile,
    limit: RESULT_LIMIT,
  });
  if (resp.ok === true) {
    renderRows(resp.rows ?? []);
  } else {
    feedback.textContent = `Could not load results: ${errorText(resp.error)}`;
  }
}

async function refreshState(): Promise<RadarRunState | null> {
  const resp = await send({ op: "RADAR_GET_STATE" });
  if (resp.ok === true) {
    const state = resp.run ?? null;
    renderState(state);
    return state;
  }
  feedback.textContent = `Could not load scan state: ${errorText(resp.error)}`;
  return null;
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => void poll(), POLL_MS);
}

/** Poll tick: refresh the status line; on terminal state stop and load rows. */
async function poll(): Promise<void> {
  const state = await refreshState();
  if (!isActive(state)) {
    stopPolling();
    await refreshResults();
  }
}

async function refresh(): Promise<void> {
  const state = await refreshState();
  await refreshResults();
  if (isActive(state)) startPolling();
  else stopPolling();
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  feedback.textContent = "Starting scan…";
  const resp = await send({ op: "RADAR_START_SCAN" });
  scanButton.disabled = false;
  if (resp.ok === true) {
    feedback.textContent = "";
    renderState(resp.run ?? null);
    startPolling();
  } else {
    feedback.textContent = `Scan not started: ${errorText(resp.error)}`;
  }
});

cancelButton.addEventListener("click", async () => {
  cancelButton.disabled = true;
  const resp = await send({ op: "RADAR_CANCEL_SCAN" });
  cancelButton.disabled = false;
  if (resp.ok === true) {
    feedback.textContent = "Cancellation requested.";
    await poll();
  } else {
    feedback.textContent = `Cancel failed: ${errorText(resp.error)}`;
  }
});

refreshButton.addEventListener("click", () => void refresh());

profileSelect.addEventListener("change", () => {
  currentProfile = profileSelect.value as RadarProfileId;
  detailSection.hidden = true;
  void refreshResults();
});

for (const { id, label } of profileOptions()) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = label;
  profileSelect.append(option);
}
profileSelect.value = currentProfile;

void refresh();
