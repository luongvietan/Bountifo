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
  detailMetaText,
  detailRows,
  detailSlugSource,
  detailTitleText,
  engagementUrl,
  errorText,
  filterRows,
  isActive,
  profileOptions,
  saturationRows,
  statusText,
  type FilterCriteria,
  type RowView,
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
const saturationBody =
  document.querySelector<HTMLTableSectionElement>("#saturation-body")!;
const deepGroups = document.querySelector<HTMLElement>("#deep-groups")!;
const explanationList =
  document.querySelector<HTMLUListElement>("#explanation")!;
const fSaturation =
  document.querySelector<HTMLInputElement>("#f-saturation")!;
const fDup = document.querySelector<HTMLInputElement>("#f-dup")!;
const fOpportunity =
  document.querySelector<HTMLInputElement>("#f-opportunity")!;
const fReward = document.querySelector<HTMLInputElement>("#f-reward")!;
const fApiHeavy = document.querySelector<HTMLInputElement>("#f-apiheavy")!;

const RESULT_LIMIT = 50;
const POLL_MS = 1000;

let currentProfile: RadarProfileId = "best_ev";
let pollTimer: number | null = null;
/** Last fetched (unfiltered) rows — filters re-render without re-fetching. */
let lastRows: RadarResultRow[] = [];

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

/** Program name cell — a deep link when the slug is site-safe, else text. */
function programCell(tr: HTMLTableRowElement, view: RowView): void {
  const td = document.createElement("td");
  if (view.programUrl === null) {
    td.textContent = view.program;
  } else {
    const a = document.createElement("a");
    a.href = view.programUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = view.program;
    // Row click opens the detail pane — a link click must not also select.
    a.addEventListener("click", (ev) => ev.stopPropagation());
    td.append(a);
  }
  tr.append(td);
}

/** Deep-signal cell: null renders "—" plus a subtle `unanalyzed` marker. */
function signalCell(
  tr: HTMLTableRowElement,
  text: string,
  analyzed: boolean,
): void {
  const td = document.createElement("td");
  td.textContent = text;
  if (!analyzed) td.classList.add("unanalyzed");
  tr.append(td);
}

/** Numeric filter input → criterion value; empty/unparseable = no filter. */
function numOrNull(el: HTMLInputElement): number | null {
  const v = el.valueAsNumber;
  return Number.isFinite(v) ? v : null;
}

function readCriteria(): FilterCriteria {
  return {
    maxSaturation: numOrNull(fSaturation),
    maxDup: numOrNull(fDup),
    minOpportunity: numOrNull(fOpportunity),
    minReward: numOrNull(fReward),
    apiHeavy: fApiHeavy.checked,
  };
}

function renderRows(rows: RadarResultRow[]): void {
  resultsBody.replaceChildren();
  const views = buildRows(filterRows(rows, readCriteria()));
  if (views.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "empty";
    td.textContent =
      rows.length === 0
        ? "No scored programs yet — run a scan."
        : "No programs match the current filters.";
    tr.append(td);
    resultsBody.append(tr);
    return;
  }
  for (const view of views) {
    const tr = document.createElement("tr");
    if (!view.eligible) tr.classList.add("ineligible");
    if (view.provisional) tr.classList.add("provisional");
    cell(tr, view.rank);
    programCell(tr, view);
    cell(tr, view.score);
    cell(tr, view.reward);
    cell(tr, view.surface);
    cell(tr, view.saturation);
    signalCell(tr, view.dup, view.dupAnalyzed);
    signalCell(tr, view.opportunity, view.opportunityAnalyzed);
    tr.addEventListener("click", () => void selectProgram(view.uuid));
    resultsBody.append(tr);
  }
}

function renderDetail(detail: RadarProgramDetail, uuid: string): void {
  detailSection.hidden = false;
  // Title doubles as the canonical engagement deep link when the slug is
  // site-safe; otherwise it stays plain text (never an arbitrary URL).
  const title = detailTitleText(detail, uuid);
  const url = engagementUrl(detailSlugSource(detail, uuid));
  detailTitle.replaceChildren();
  if (url === null) {
    detailTitle.textContent = title;
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = title;
    detailTitle.append(a);
  }
  detailMeta.textContent = detailMetaText(detail);
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
  saturationBody.replaceChildren();
  for (const row of saturationRows(detail.vector)) {
    const tr = document.createElement("tr");
    for (const text of [row.label, row.value]) {
      cell(tr, text);
    }
    saturationBody.append(tr);
  }
  deepGroups.replaceChildren();
  for (const group of detailRows(detail)) {
    const heading = document.createElement("h3");
    heading.textContent = group.title;
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (const row of group.rows) {
      const tr = document.createElement("tr");
      cell(tr, row.label);
      cell(tr, row.value);
      tbody.append(tr);
    }
    table.append(tbody);
    deepGroups.append(heading, table);
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
    lastRows = resp.rows ?? [];
    renderRows(lastRows);
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

// Filter controls re-render the last fetched rows — no new messages.
for (const el of [fSaturation, fDup, fOpportunity, fReward]) {
  el.addEventListener("input", () => renderRows(lastRows));
}
fApiHeavy.addEventListener("change", () => renderRows(lastRows));

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
