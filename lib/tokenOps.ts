import { browser } from "wxt/browser";
import { normalizeTokenInput } from "./secrets";
import { credentialStorageUsable } from "./storageAccess";

export const CREDENTIAL_STORAGE_KEY = "apiCredential";

export type SaveCredentialResult =
  | { ok: true }
  | { ok: false; reason: "storage_locked" | "invalid" };

/**
 * Normalizes the raw input (accepts "Token x" or bare "x"), verifies the
 * storage lockdown, then stores the bare credential under `apiCredential`.
 * Fails closed: if the TRUSTED_CONTEXTS lockdown is not in effect nothing is
 * written and the reason is "storage_locked" (spec §7.2).
 *
 * SERVICE-WORKER-ONLY by contract — must never be imported by content,
 * popup, or options code.
 */
export async function saveCredential(
  raw: string,
): Promise<SaveCredentialResult> {
  const credential = normalizeTokenInput(raw);
  if (credential === null) return { ok: false, reason: "invalid" };
  if (!(await credentialStorageUsable())) {
    return { ok: false, reason: "storage_locked" };
  }
  await browser.storage.local.set({ [CREDENTIAL_STORAGE_KEY]: credential });
  return { ok: true };
}

/**
 * Returns the stored credential, or null when storage is locked or no
 * credential is stored. SERVICE-WORKER-ONLY by contract — never imported by
 * content/popup/options code; the token never leaves the service worker.
 */
export async function getCredential(): Promise<string | null> {
  if (!(await credentialStorageUsable())) return null;
  const record = await browser.storage.local.get(CREDENTIAL_STORAGE_KEY);
  const value = record[CREDENTIAL_STORAGE_KEY];
  return typeof value === "string" ? value : null;
}

/**
 * Removes the stored credential unconditionally. A failed lockdown check must
 * prevent reading/writing a token, but it must never make an existing secret
 * undeletable from the trusted service-worker context.
 */
export async function clearCredential(): Promise<void> {
  await browser.storage.local.remove(CREDENTIAL_STORAGE_KEY);
}

/** Whether a credential is stored and readable (false while locked). */
export async function hasCredential(): Promise<boolean> {
  return (await getCredential()) !== null;
}
