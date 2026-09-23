import { browser } from "wxt/browser";
import { downloadFile } from "../../lib/download";
import type { RadarMessage } from "../../lib/messages";
import type {
  RadarProgramDetail,
  RadarResultMode,
  RadarResultRow,
  RadarRunState,
} from "../../lib/radar/coordinator";
import { evidenceBadge } from "../../lib/radar/stage";
import type { RadarProfileId } from "../../lib/radar/types";
import {
  buildExportRequest,
  exportBlockedReason,
  parseExportResponse,
  type ExportFormValues,
} from "./exportDialog";
import {
  buildRows,
  componentRows,
  deepFallback,
  detailMetaText,
  detailRows,
  detailSlugSource,
  detailTitleText,
  engagementUrl,
  errorText,
  filterRows,
  isActive,
  profileOptions,
  resolveResultsMode,
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
  export?: unknown;
}

const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const exportButton = document.querySelector<HTMLButtonElement>("#export")!;
const exportDialog = document.querySelector<HTMLDialogElement>("#export-dialog")!;
const exportForm = document.querySelector<HTMLFormElement>("#export-form")!;
const exportCancel =
  document.querySelector<HTMLButtonElement>("#export-cancel")!;
const exportGo = document.querySelector<HTMLButtonElement>("#export-go")!;
const exportError = document.querySelector<HTMLElement>("#export-error")!;
const xCurrentProfile =
  document.querySelector<HTMLElement>("#x-current-profile")!;
const xDetail = document.querySelector<HTMLInputElement>("#x-detail")!;
const xDiagnostics =
  document.querySelector<HTMLInputElement>("#x-diagnostics")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const profileSelect = document.querySelector<HTMLSelectElement>("#profile")!;
const modeControl = document.querySelector<HTMLElement>("#mode-control")!;
const modeSelect = document.querySelector<HTMLSelectElement>("#mode")!;
const modeNote = document.querySelector<HTMLElement>("#mode-note")!;
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
const fKi = document.querySelector<HTMLInputElement>("#f-ki")!;
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
/** Latest run state — feeds the mode default and the stabilization line. */
let lastState: RadarRunState | null = null;
/** The user's explicit mode pick; null = follow the honest default. */
let modeChoice: RadarResultMode | null = null;
/** Note from the last deep→metadata fallback (null when none applied). */
let fallbackNote: string | null = null;

async function send(msg: RadarMessage): Promise<RouterResponse> {
  return (await browser.runtime.sendMessage(msg)) as RouterResponse;
}

/**
 * Syncs the mode control with the current resolution: hidden for
 * metadata-only profiles (their deep view is empty by design), else showing
 * the requested mode with any honesty note alongside.
 */
function renderModeControl(): void {
  const res = resolveResultsMode(currentProfile, lastState, modeChoice);
  modeControl.hidden = !res.offered;
  if (res.offered) modeSelect.value = res.requested;
  modeNote.textContent = res.note ?? fallbackNote ?? "";
}

function renderState(state: RadarRunState | null): void {
  lastState = state;
  statusLine.textContent = statusText(state);
  cancelButton.hidden = !isActive(state);
  // Export reads the persisted snapshot — only a missing run blocks it
  // (mid-scan exports report the partial, honestly-gated state).
  const blocked = exportBlockedReason(state);
  exportButton.disabled = blocked !== null;
  exportButton.title = blocked ?? "Export the latest saved scan";
  renderModeControl();
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

/**
 * Score cell: evidence badge (DEEP/META) + score text. The badge marks the
 * row's evidence AVAILABILITY — deep-analyzed this scan vs metadata-only —
 * while the number itself is always the active view's stage (the deep
 * ranking only ever contains deep rows; the metadata view shows metadata
 * baselines, deep-analyzed or not). The tooltip must describe evidence,
 * never claim the displayed number's stage — a DEEP badge in metadata view
 * still shows the metadata score.
 */
function scoreCell(tr: HTMLTableRowElement, view: RowView): void {
  const td = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `ev ${view.evidence}`;
  // evidenceBadge() marks elevated evidence ("DEEP"); metadata is the
  // baseline every row holds, surfaced here as the explicit "META" label.
  badge.textContent = evidenceBadge(view.evidence) ?? "META";
  badge.title =
    view.evidence === "deep"
      ? "Deep-analyzed in this scan — a deep score exists for this row (Δ = deep − metadata)."
      : "Metadata-stage only — catalog/brief signals; not deep-analyzed.";
  td.append(badge, document.createTextNode(` ${view.score}`));
  if (view.scoreDelta !== null) {
    td.title = "Δ = deep score − metadata score";
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
    maxKiPressure: numOrNull(fKi),
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
    td.colSpan = 11;
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
    scoreCell(tr, view);
    cell(tr, view.pct);
    cell(tr, view.reward);
    cell(tr, view.surface);
    cell(tr, view.saturation);
    signalCell(tr, view.kiPressure, view.kiAnalyzed);
    signalCell(tr, view.opportunity, view.opportunityAnalyzed);
    cell(tr, view.access);
    cell(tr, view.authz);
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
  // Percentile is rank context carried by the clicked results row — looked
  // up from the last fetch; `??` keeps a real 0.0 bottom-of-cohort reading
  // from collapsing into "—" (only a missing row yields null).
  const percentile =
    lastRows.find((row) => row.uuid === uuid)?.percentile ?? null;
  for (const group of detailRows(detail, percentile)) {
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

/**
 * Fetches the ranked rows under the resolved evidence mode. A "deep"
 * request that comes back empty falls back to the metadata ranking when it
 * has rows — deepFallback carries the note that says the swap happened.
 */
async function refreshResults(): Promise<void> {
  const { requested } = resolveResultsMode(
    currentProfile,
    lastState,
    modeChoice,
  );
  fallbackNote = null;
  const resp = await send({
    op: "RADAR_GET_RESULTS",
    profile: currentProfile,
    limit: RESULT_LIMIT,
    mode: requested,
  });
  if (resp.ok !== true) {
    feedback.textContent = `Could not load results: ${errorText(resp.error)}`;
    renderModeControl();
    return;
  }
  let rows = resp.rows ?? [];
  if (requested === "deep" && rows.length === 0) {
    const metaResp = await send({
      op: "RADAR_GET_RESULTS",
      profile: currentProfile,
      limit: RESULT_LIMIT,
      mode: "metadata",
    });
    if (metaResp.ok === true) {
      const fb = deepFallback(rows, metaResp.rows ?? []);
      rows = fb.rows;
      fallbackNote = fb.note;
    } else {
      feedback.textContent =
        `Could not load results: ${errorText(metaResp.error)}`;
    }
  }
  lastRows = rows;
  renderRows(lastRows);
  renderModeControl();
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

// --- Export dialog -----------------------------------------------------------

/** Reads the dialog controls; radio/checkbox values are sanitized here. */
function readExportForm(): ExportFormValues {
  const fd = new FormData(exportForm);
  const formatRaw = fd.get("x-format");
  const scopeRaw = fd.get("x-scope");
  const limitRaw = fd.get("x-limit");
  return {
    format: formatRaw === "json" ? "json" : formatRaw === "csv" ? "csv" : "markdown",
    scope: scopeRaw === "current" ? "current" : "all",
    profile: currentProfile,
    limit: limitRaw === "20" ? 20 : limitRaw === "all" ? "all" : 50,
    detail: xDetail.checked,
    diagnostics: xDiagnostics.checked,
  };
}

exportButton.addEventListener("click", () => {
  if (exportBlockedReason(lastState) !== null) return; // belt: also disabled
  exportError.textContent = "";
  xCurrentProfile.textContent =
    profileOptions().find((p) => p.id === currentProfile)?.label ??
    currentProfile;
  exportDialog.showModal();
});

exportCancel.addEventListener("click", () => exportDialog.close());

exportForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void runExport();
});

let exportBusy = false;

/** Sends the export op, downloads the serialized report, reports failures. */
async function runExport(): Promise<void> {
  // Enter-key resubmits bypass the disabled button — block reentrancy here.
  if (exportBusy) return;
  const req = buildExportRequest(readExportForm());
  if (req === null) {
    exportError.textContent = "Pick a profile to export the current profile only.";
    return;
  }
  exportBusy = true;
  exportGo.disabled = true;
  exportError.textContent = "Assembling report…";
  try {
    const resp = await send(req);
    const parsed = parseExportResponse(resp);
    if (!parsed.ok) {
      exportError.textContent = parsed.message;
      return;
    }
    await downloadFile(
      parsed.payload.filename,
      parsed.payload.body,
      parsed.payload.mime,
    );
    exportDialog.close();
    feedback.textContent = `Exported ${parsed.payload.filename}`;
  } catch {
    exportError.textContent = "Export failed — the report could not be assembled or downloaded.";
  } finally {
    exportBusy = false;
    exportGo.disabled = false;
    if (exportError.textContent === "Assembling report…") {
      exportError.textContent = "";
    }
  }
}

// Filter controls re-render the last fetched rows — no new messages.
for (const el of [fSaturation, fKi, fOpportunity, fReward]) {
  el.addEventListener("input", () => renderRows(lastRows));
}
fApiHeavy.addEventListener("change", () => renderRows(lastRows));

// The mode toggle is an explicit choice — re-fetches under that evidence
// level (deep requests may still fall back to metadata honestly).
modeSelect.addEventListener("change", () => {
  modeChoice = modeSelect.value === "deep" ? "deep" : "metadata";
  void refreshResults();
});

profileSelect.addEventListener("change", () => {
  currentProfile = profileSelect.value as RadarProfileId;
  modeChoice = null; // new profile → fresh honest default
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
