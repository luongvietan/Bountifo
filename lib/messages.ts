import { z } from "zod";
import { browser } from "wxt/browser";
import { BUGCROWD_SITE } from "./constants";

// ---------------------------------------------------------------------------
// Message protocol (spec §7.3, §19): the service worker exposes named
// operations only — never a generic authenticated fetch(url). All object
// schemas are .strict() so a sender cannot smuggle in a URL, hostname,
// headers, Authorization, method, or arbitrary request options.
// ---------------------------------------------------------------------------

export const ApiOperation = z.enum([
  "TEST_TOKEN",
  "LIST_ENGAGEMENTS",
  "GET_ENGAGEMENT",
]);

export const ApiRequestMsg = z
  .object({
    op: ApiOperation,
    params: z
      .object({
        code: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
        uuid: z
          .string()
          .regex(/^[0-9a-fA-F-]{36}$/)
          .optional(),
        page: z.number().int().min(1).max(100).optional(),
        token: z.string().optional(), // TEST_TOKEN only: probe an unsaved candidate
      })
      .strict(),
  })
  .strict(); // rejects url/hostname/headers/options injection

export const PopupMsg = z.discriminatedUnion("op", [
  z.object({ op: z.literal("START_EXPORT"), tabId: z.number().int() }).strict(),
  // The in-page launcher names no tab: the background reads sender.tab.id, so
  // a content script can only ever start an export for the page it runs in.
  z.object({ op: z.literal("START_EXPORT_HERE") }).strict(),
  z.object({ op: z.literal("CANCEL_EXPORT"), jobId: z.string() }).strict(),
  z.object({ op: z.literal("GET_JOB_STATE") }).strict(),
  z.object({ op: z.literal("SAVE_TOKEN"), token: z.string() }).strict(),
  z.object({ op: z.literal("CLEAR_TOKEN") }).strict(),
  z.object({ op: z.literal("GET_TOKEN_STATUS") }).strict(),
]);

export const JobMsg = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("PAGE_READY"),
      jobId: z.string(),
      url: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("UNIT_PROGRESS"),
      jobId: z.string(),
      unitId: z.string(),
      counters: z.record(z.string(), z.number()),
    })
    .strict(),
  z
    .object({
      op: z.literal("UNIT_RESULT"),
      jobId: z.string(),
      unitId: z.string(),
      result: z.unknown(),
    })
    .strict(),
]);

export type ApiRequest = z.infer<typeof ApiRequestMsg>;
export type PopupMessage = z.infer<typeof PopupMsg>;
export type JobMessage = z.infer<typeof JobMsg>;

/** Returns the parsed ApiRequest, or null when the message fails validation. */
export function parseApiRequest(msg: unknown): ApiRequest | null {
  const result = ApiRequestMsg.safeParse(msg);
  return result.success ? result.data : null;
}

/** Returns the parsed PopupMessage, or null when the message fails validation. */
export function parsePopupMessage(msg: unknown): PopupMessage | null {
  const result = PopupMsg.safeParse(msg);
  return result.success ? result.data : null;
}

/** Returns the parsed JobMessage, or null when the message fails validation. */
export function parseJobMessage(msg: unknown): JobMessage | null {
  const result = JobMsg.safeParse(msg);
  return result.success ? result.data : null;
}

/**
 * The small active-job descriptor persisted in chrome.storage.session
 * (spec §7.5/§17): job ID, tab ID, engagement code, phase, plus checkpoint /
 * counters carried as extra fields.
 */
export interface ActiveJobDescriptor {
  jobId: string;
  tabId: number;
  engagementCode: string;
  phase: string;
  [k: string]: unknown;
}

export type SenderValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validates a job-scoped message's sender before it is accepted (spec §7.3):
 * the sender must be this extension, come from the job's tab, sit on a URL
 * under "https://bugcrowd.com/" (exact prefix — subdomains and look-alike
 * suffixes are rejected), reference the active job ID, and arrive while the
 * job is in the expected phase.
 */
export function validateJobSender(
  sender: { id?: string; tab?: { id?: number; url?: string } },
  msg: { jobId: string },
  // Only the three fields the check reads: any descriptor shape satisfies it,
  // stored or in-memory.
  job: { jobId: string; tabId: number; phase: string },
  expectedPhase: string,
): SenderValidation {
  if (sender.id !== browser.runtime.id) {
    return { ok: false, reason: "sender_id_mismatch" };
  }
  if (sender.tab?.id !== job.tabId) {
    return { ok: false, reason: "sender_tab_mismatch" };
  }
  const url = sender.tab?.url;
  if (typeof url !== "string" || !url.startsWith(`${BUGCROWD_SITE}/`)) {
    return { ok: false, reason: "sender_tab_url_not_bugcrowd" };
  }
  if (msg.jobId !== job.jobId) {
    return { ok: false, reason: "job_id_mismatch" };
  }
  if (job.phase !== expectedPhase) {
    return { ok: false, reason: "job_phase_mismatch" };
  }
  return { ok: true };
}
