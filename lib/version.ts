import { browser } from "wxt/browser";

// ---------------------------------------------------------------------------
// Build/runtime provenance for exports — where the report came from. Both
// return null rather than throwing: provenance is metadata, never a blocker.
// ---------------------------------------------------------------------------

/** The extension's manifest version ("0.1.0" etc.); null off-runtime. */
export function appVersion(): string | null {
  try {
    return browser.runtime.getManifest().version ?? null;
  } catch {
    return null;
  }
}

/** Source commit baked in at build time via VITE_COMMIT_SHA; null when the
 *  build did not define one. */
export function sourceCommit(): string | null {
  const sha = import.meta.env.VITE_COMMIT_SHA;
  return typeof sha === "string" && sha !== "" ? sha : null;
}
