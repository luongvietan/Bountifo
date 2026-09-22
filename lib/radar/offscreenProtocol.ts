import type { ApiEngagementData } from "../types";

/**
 * Message protocol between the service worker (offscreen.ts) and the
 * offscreen document (entrypoints/offscreen). `kind` discriminates the
 * channel so the background router can early-return and let the offscreen
 * document own the response — a global "unknown_message" reply would race
 * the real answer.
 */
export const OFFSCREEN_MESSAGE_KIND = "radar_offscreen";

export interface OffscreenParseRequest {
  kind: typeof OFFSCREEN_MESSAGE_KIND;
  op: "PARSE_BRIEF";
  slug: string;
  html: string;
  pageUrl: string;
}

export type OffscreenParseResponse =
  | { ok: true; detail: ApiEngagementData }
  | { ok: false };

export function isOffscreenParseRequest(
  msg: unknown,
): msg is OffscreenParseRequest {
  if (msg === null || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.kind === OFFSCREEN_MESSAGE_KIND &&
    m.op === "PARSE_BRIEF" &&
    typeof m.slug === "string" &&
    typeof m.html === "string" &&
    typeof m.pageUrl === "string"
  );
}

/** Any message on the offscreen channel — the background listener returns
 *  undefined for these so the offscreen document's sendResponse wins. */
export function isOffscreenMessage(msg: unknown): boolean {
  return (
    msg !== null &&
    typeof msg === "object" &&
    (msg as { kind?: unknown }).kind === OFFSCREEN_MESSAGE_KIND
  );
}
