import type { RadarMessage } from "../../lib/messages";
import type { RadarRunState } from "../../lib/radar/coordinator";
import type { RadarProfileId } from "../../lib/radar/types";

// ---------------------------------------------------------------------------
// Export dialog logic — pure helpers so the DOM wiring in main.ts stays a
// thin shell (same convention as view.ts). No I/O here: building the request,
// deciding whether export is available, and unpacking the router envelope.
// ---------------------------------------------------------------------------

export interface ExportFormValues {
  format: "markdown" | "json" | "csv";
  /** "all" = every profile; "current" = the page's selected profile. */
  scope: "all" | "current";
  /** The page's current profile — required only when scope is "current". */
  profile: RadarProfileId | null;
  limit: 20 | 50 | "all";
  detail: boolean;
  diagnostics: boolean;
}

/** Spec defaults: Markdown · all six profiles · Top 50 · detail+diagnostics. */
export const EXPORT_DEFAULTS = {
  format: "markdown",
  scope: "all",
  limit: 50,
  detail: true,
  diagnostics: true,
} as const;

/**
 * Form values → message. Returns null when the combination is invalid
 * (current scope with no profile selected) instead of sending a request the
 * router would bounce as invalid_params.
 */
export function buildExportRequest(
  values: ExportFormValues,
): RadarMessage | null {
  const profile =
    values.scope === "current" ? values.profile : undefined;
  if (values.scope === "current" && profile === null) return null;
  return {
    op: "RADAR_EXPORT_REPORT",
    format: values.format,
    scope: values.scope,
    profile: profile ?? undefined,
    limit: values.limit,
    detail: values.detail,
    diagnostics: values.diagnostics,
  };
}

/**
 * Why the Export button is disabled, or null when export is allowed. Only a
 * missing run blocks — an in-progress scan still exports its latest persisted
 * snapshot honestly (deep rows gated by deep_completed_uuids).
 */
export function exportBlockedReason(state: RadarRunState | null): string | null {
  return state === null ? "No scan to export yet — run a scan first." : null;
}

/** Serialized export returned by the RADAR_EXPORT_REPORT route. */
export interface ExportPayload {
  filename: string;
  mime: string;
  body: string;
  content_hash: string;
  generated_at: string;
}

type ParsedExport =
  | { ok: true; payload: ExportPayload }
  | { ok: false; message: string };

/**
 * Router envelope → download payload or a human-readable failure line.
 * Never throws on a malformed payload — reports it instead.
 */
export function parseExportResponse(resp: {
  ok?: boolean;
  error?: unknown;
  export?: unknown;
}): ParsedExport {
  if (resp.ok !== true) {
    const err = resp.error;
    if (err === "no_scan") {
      return {
        ok: false,
        message: "No scan results to export yet — run a scan first.",
      };
    }
    if (err === "invalid_params") {
      return {
        ok: false,
        message: "Pick a profile to export the current profile only.",
      };
    }
    return {
      ok: false,
      message: `Export failed: ${typeof err === "string" ? err : "unexpected error"}`,
    };
  }
  const e = resp.export as Partial<ExportPayload> | null | undefined;
  if (
    e === null ||
    e === undefined ||
    typeof e.filename !== "string" ||
    typeof e.mime !== "string" ||
    typeof e.body !== "string" ||
    typeof e.content_hash !== "string" ||
    typeof e.generated_at !== "string"
  ) {
    return { ok: false, message: "Export failed: malformed response." };
  }
  return { ok: true, payload: e as ExportPayload };
}
