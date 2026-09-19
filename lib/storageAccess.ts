import { browser } from "wxt/browser";

// Cached for the whole service-worker lifetime: the lockdown is applied once
// per startup (spec §7.2) and never retried — a failed attempt stays failed.
let lockdownPromise: Promise<boolean> | null = null;

async function applyLockdown(): Promise<boolean> {
  try {
    const area = browser.storage?.local;
    // Method missing (e.g. older engine / Firefox) → fail closed.
    if (!area || typeof area.setAccessLevel !== "function") return false;
    await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Restricts chrome.storage.local to trusted contexts so content scripts cannot
 * read the stored credential (spec §7.2/§19). Called at SW startup and on
 * install. The first call performs the operation; the in-flight/resolved
 * promise is cached so later callers share it. Returns false when
 * setAccessLevel throws or is missing; never retries within one SW lifetime.
 */
export function ensureTrustedContexts(): Promise<boolean> {
  if (lockdownPromise === null) {
    lockdownPromise = applyLockdown();
  }
  return lockdownPromise;
}

/**
 * Whether the credential area of chrome.storage.local is locked down and safe
 * to use. Identity alias for ensureTrustedContexts().
 */
export function credentialStorageUsable(): Promise<boolean> {
  return ensureTrustedContexts();
}
