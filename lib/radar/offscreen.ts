import { browser } from "wxt/browser";
import type { ApiEngagementData } from "../types";
import { ApiError } from "../api/errors";
import {
  OFFSCREEN_MESSAGE_KIND,
  type OffscreenParseResponse,
} from "./offscreenProtocol";

/**
 * Service-worker side of the brief-HTML parser. MV3 service workers have no
 * DOM/DOMParser, so the page markup is parsed inside a lazily-created
 * offscreen document (`offscreen.html`) that runs the same DOM collectors
 * the exporter uses on live pages.
 */

interface ChromeOffscreen {
  hasDocument(): Promise<boolean>;
  createDocument(options: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void>;
}

function offscreenApi(): ChromeOffscreen {
  // `chrome.offscreen` is Chrome-only — absent from the polyfill types.
  const api = (globalThis as { chrome?: { offscreen?: ChromeOffscreen } })
    .chrome?.offscreen;
  if (api === undefined) {
    throw new ApiError("invalid_response", "offscreen api unavailable");
  }
  return api;
}

let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (await api.hasDocument()) return;
  creating ??= api
    .createDocument({
      url: browser.runtime.getURL("/offscreen.html"),
      reasons: ["DOM_PARSER"],
      justification:
        "Parse engagement brief HTML into radar feature data (no DOM in the service worker).",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/**
 * Parses one brief's HTML into ApiEngagementData via the offscreen document.
 * Throws ApiError("invalid_response") when the parser is unreachable or
 * reports failure — enrichment classifies it per-item like any other
 * transient failure.
 */
export async function parseBriefHtml(
  slug: string,
  html: string,
  pageUrl: string,
): Promise<ApiEngagementData> {
  await ensureOffscreenDocument();
  const res = (await browser.runtime.sendMessage({
    kind: OFFSCREEN_MESSAGE_KIND,
    op: "PARSE_BRIEF",
    slug,
    html,
    pageUrl,
  })) as OffscreenParseResponse | undefined;
  if (
    res !== undefined &&
    res !== null &&
    typeof res === "object" &&
    res.ok === true &&
    res.detail !== null &&
    typeof res.detail === "object"
  ) {
    return res.detail;
  }
  throw new ApiError("invalid_response", "offscreen parse failed");
}
