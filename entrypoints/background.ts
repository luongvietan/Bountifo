import { browser } from "wxt/browser";
import { ensureTrustedContexts } from "../lib/storageAccess";
import {
  parseApiRequest,
  parseJobMessage,
  parsePopupMessage,
  validateJobSender,
  type ActiveJobDescriptor,
  type JobMessage,
} from "../lib/messages";

// Every router response has this shape and contains only static, fixed
// fields — request payloads (which may carry token/Authorization material)
// are never echoed back.
type RouterResponse = { ok: boolean; error?: string; [k: string]: unknown };

// Active job descriptors keyed by jobId. Task 9 will persist/rehydrate these
// via chrome.storage.session; the skeleton store is always empty so job
// messages currently fail closed with { ok: false }.
const activeJobs = new Map<string, ActiveJobDescriptor>();

function routeJobMessage(
  msg: JobMessage,
  sender: { id?: string; tab?: { id?: number; url?: string } },
): RouterResponse {
  const job = activeJobs.get(msg.jobId);
  if (!job) return { ok: false, error: "unknown_job" };
  // Task 9 supplies the real per-unit expected phase; until then the
  // descriptor's own persisted phase is the only expectation available.
  const validation = validateJobSender(sender, msg, job, job.phase);
  if (!validation.ok) return { ok: false, error: "forbidden" };
  // Task 9 wires unit handling (PAGE_READY / UNIT_PROGRESS / UNIT_RESULT).
  return { ok: false, error: "not_implemented" };
}

function routeMessage(
  rawMsg: unknown,
  sender: { id?: string; tab?: { id?: number; url?: string } },
): RouterResponse {
  // (a) Named API operations — Task 3 wires the API client.
  if (parseApiRequest(rawMsg) !== null) {
    return { ok: false, error: "not_implemented" };
  }
  // (b) Popup operations — Task 9 wires job ops, Task 10 wires token ops.
  if (parsePopupMessage(rawMsg) !== null) {
    return { ok: false, error: "not_implemented" };
  }
  // (c) Job-scoped content-script messages — sender validated against the
  // stored job descriptor (Task 9 wires the descriptor store).
  const jobMsg = parseJobMessage(rawMsg);
  if (jobMsg !== null) {
    return routeJobMessage(jobMsg, sender);
  }
  return { ok: false, error: "unknown_message" };
}

export default defineBackground(() => {
  // Lock down chrome.storage.local at every service-worker startup, before
  // any credential access (spec §7.2/§19).
  void ensureTrustedContexts();

  browser.runtime.onInstalled.addListener(() => {
    void ensureTrustedContexts();
  });

  browser.runtime.onMessage.addListener((msg: unknown, sender) =>
    Promise.resolve(routeMessage(msg, sender)),
  );
});
