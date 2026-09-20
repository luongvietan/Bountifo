import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { apiRequest } from "../lib/api/client";
import {
  fetchEngagementEnrichment,
  resolveEngagementUuid,
  testToken,
} from "../lib/api/engagements";
import { ApiError } from "../lib/api/errors";
import { ensureTrustedContexts } from "../lib/storageAccess";
import {
  parseApiRequest,
  parseJobMessage,
  parsePopupMessage,
  type ApiRequest,
} from "../lib/messages";
import { JobCoordinator } from "../lib/job/coordinator";

// Every router response has this shape and contains only static, fixed
// fields — request payloads (which may carry token/Authorization material)
// are never echoed back. API op failures use {kind,message} (sanitized
// ApiError fields); protocol failures use a short static string.
type RouterError = string | { kind: string; message: string };
type RouterResponse = {
  ok: boolean;
  data?: unknown;
  error?: RouterError;
  [k: string]: unknown;
};

export const coordinator = new JobCoordinator({
  sendToTab: (tabId, msg) => browser.tabs.sendMessage(tabId, msg),
  apiEnrich: fetchEngagementEnrichment,
  now: () => new Date().toISOString(),
  getTabUrl: async (tabId) => (await browser.tabs.get(tabId)).url ?? null,
});

// testToken() reports verdicts as static detail strings; map them back onto
// ApiError-style kinds for the {ok:false,error:{kind,message}} envelope.
const TEST_TOKEN_DETAIL_KIND: Record<string, string> = {
  unauthorized: "unauthorized",
  "rate limited, try later": "rate_limited",
  unreachable: "network",
};

function apiErrorResponse(err: unknown): RouterResponse {
  if (err instanceof ApiError) {
    return { ok: false, error: { kind: err.kind, message: err.message } };
  }
  // Unknown failure: static message only — a thrown value's message is not
  // guaranteed free of request/credential detail (spec §18/§19).
  return { ok: false, error: { kind: "unknown", message: "unexpected error" } };
}

async function routeApiRequest(req: ApiRequest): Promise<RouterResponse> {
  const { op, params } = req;
  try {
    switch (op) {
      case "TEST_TOKEN": {
        const res = await testToken(params.token);
        if (res.ok) return { ok: true, data: { detail: res.detail } };
        return {
          ok: false,
          error: {
            kind: TEST_TOKEN_DETAIL_KIND[res.detail] ?? "network",
            message: res.detail,
          },
        };
      }
      case "LIST_ENGAGEMENTS": {
        const res = await apiRequest({
          operation: "LIST_ENGAGEMENTS",
          page: params.page ?? 1,
        });
        return { ok: true, data: res };
      }
      case "GET_ENGAGEMENT": {
        // Exactly one selector required (the schema allows either/both).
        const hasUuid = typeof params.uuid === "string";
        const hasCode = typeof params.code === "string";
        if (hasUuid === hasCode) return { ok: false, error: "invalid_params" };
        let uuid = params.uuid ?? null;
        if (uuid === null) {
          uuid = await resolveEngagementUuid(params.code as string);
          if (uuid === null) {
            return { ok: false, error: "engagement_not_found" };
          }
        }
        const res = await fetchEngagementEnrichment(params.code ?? "", uuid);
        if (!res.ok) {
          return {
            ok: false,
            error: { kind: res.error.kind, message: res.error.message },
          };
        }
        return {
          ok: true,
          data: { engagement: res.data, records: res.records },
        };
      }
    }
  } catch (err) {
    return apiErrorResponse(err);
  }
}

// Exported (not just wired into onMessage) so tests can exercise the router
// without faking a full message dispatch.
export function routeMessage(
  rawMsg: unknown,
  sender: { id?: string; tab?: { id?: number; url?: string } },
): RouterResponse | Promise<RouterResponse> {
  // (a) Named API operations. These exist for extension pages only (options
  // TEST_TOKEN probe, coordinator-driven fetches); a content-script sender is
  // identifiable by sender.tab and is always rejected (spec §7.5/§19).
  const apiReq = parseApiRequest(rawMsg);
  if (apiReq !== null) {
    if (sender.tab !== undefined) return { ok: false, error: "forbidden" };
    return routeApiRequest(apiReq);
  }
  // (b) Popup operations — Task 9 wires job ops, Task 10 wires token ops.
  const popup = parsePopupMessage(rawMsg);
  if (popup !== null) {
    switch (popup.op) {
      case "START_EXPORT":
        return coordinator.start(popup.tabId);
      case "CANCEL_EXPORT":
        if (coordinator.state !== null && coordinator.state.jobId !== popup.jobId) {
          return { ok: false, error: "unknown_job" };
        }
        return coordinator.cancel().then(() => ({ ok: true }));
      case "GET_JOB_STATE":
        return { ok: true, state: coordinator.state };
      default:
        return { ok: false, error: "not_implemented" };
    }
  }
  // (c) Job-scoped content-script messages — sender validated against the
  // stored job descriptor (Task 9 wires the descriptor store).
  const jobMsg = parseJobMessage(rawMsg);
  if (jobMsg !== null) {
    return coordinator.handleJobMessage(jobMsg, sender) as Promise<RouterResponse>;
  }
  return { ok: false, error: "unknown_message" };
}

export default defineBackground(() => {
  // Lock down chrome.storage.local at every service-worker startup, before
  // any credential access (spec §7.2/§19).
  void ensureTrustedContexts();
  void coordinator.resume();

  browser.runtime.onInstalled.addListener(() => {
    void ensureTrustedContexts();
  });

  browser.runtime.onMessage.addListener((msg: unknown, sender) =>
    Promise.resolve(routeMessage(msg, sender)),
  );
});
