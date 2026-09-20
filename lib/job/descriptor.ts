import { browser } from "wxt/browser";
import { UNIT_ORDER } from "./units";

export interface JobDescriptor {
  jobId: string;
  tabId: number;
  engagementCode: string;
  initialUrl: string;
  phase: "collecting" | "processing" | "rendering" | "done" | "failed" | "cancelled";
  currentUnit: string | null;
  completedUnits: string[];
  pendingUnits: string[];
  counters: { unitDone: number; unitTotal: number; kiDone: number; kiTotal: number };
  warnings: number;
  unresolvedConflicts: number;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

const KEY = "activeJob";

async function exposeSessionToContentScripts(): Promise<void> {
  const area = browser.storage.session as typeof browser.storage.session & {
    setAccessLevel?: (details: { accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }) => Promise<void>;
  };
  try {
    await area.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  } catch {
    // Chromium variants without this API still keep the descriptor safe: it
    // contains checkpoints only, never credentials.
  }
}

export async function readDescriptor(): Promise<JobDescriptor | null> {
  const stored = await browser.storage.session.get(KEY);
  const value = (stored as Record<string, unknown>)[KEY];
  return typeof value === "object" && value !== null
    ? (value as JobDescriptor)
    : null;
}

export async function writeDescriptor(d: JobDescriptor): Promise<void> {
  await exposeSessionToContentScripts();
  await browser.storage.session.set({ [KEY]: d });
}

export async function patchDescriptor(
  patch: Partial<JobDescriptor>,
): Promise<JobDescriptor | null> {
  const current = await readDescriptor();
  if (current === null) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeDescriptor(next);
  return next;
}

export async function clearDescriptor(): Promise<void> {
  await browser.storage.session.remove(KEY);
}

export function newDescriptor(
  tabId: number,
  code: string,
  initialUrl: string,
): JobDescriptor {
  const now = new Date().toISOString();
  return {
    jobId: `job_${crypto.randomUUID().slice(0, 8)}`,
    tabId,
    engagementCode: code,
    initialUrl,
    phase: "collecting",
    currentUnit: null,
    completedUnits: [],
    pendingUnits: [...UNIT_ORDER],
    counters: { unitDone: 0, unitTotal: UNIT_ORDER.length, kiDone: 0, kiTotal: 0 },
    warnings: 0,
    unresolvedConflicts: 0,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
  };
}
