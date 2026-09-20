import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// NOTE: fakeBrowser's in-memory storage.local does NOT implement
// setAccessLevel — it exists only as a not-mocked stub that throws
// MockNotImplementedError. Tests therefore stub it via
// Object.defineProperty (the storage area is a plain object, so the
// property is replaceable).
//
// ensureTrustedContexts caches its promise for the whole service-worker
// lifetime, so each test re-imports the modules fresh after
// vi.resetModules() to get an uncached module instance.

type SetAccessLevelFn = (details: { accessLevel: string }) => Promise<void>;

const THROWING_STUB: SetAccessLevelFn = () => {
  throw new Error("storage.local.setAccessLevel not implemented");
};

function stubSetAccessLevel(fn: SetAccessLevelFn | undefined) {
  Object.defineProperty(fakeBrowser.storage.local, "setAccessLevel", {
    value: fn,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  fakeBrowser.reset();
  // Default per-test behavior matches the real fakeBrowser: a stub that throws.
  stubSetAccessLevel(THROWING_STUB);
});

describe("ensureTrustedContexts", () => {
  it("calls setAccessLevel with TRUSTED_CONTEXTS once and caches the result", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    stubSetAccessLevel(spy);
    const { ensureTrustedContexts, credentialStorageUsable } = await import(
      "../lib/storageAccess"
    );

    await expect(ensureTrustedContexts()).resolves.toBe(true);
    await expect(ensureTrustedContexts()).resolves.toBe(true);
    await expect(credentialStorageUsable()).resolves.toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("returns false when setAccessLevel throws and never retries", async () => {
    const spy = vi.fn(THROWING_STUB);
    stubSetAccessLevel(spy);
    const { ensureTrustedContexts, credentialStorageUsable } = await import(
      "../lib/storageAccess"
    );

    await expect(ensureTrustedContexts()).resolves.toBe(false);
    // cached failure: no second call, same false result
    await expect(ensureTrustedContexts()).resolves.toBe(false);
    await expect(credentialStorageUsable()).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns false when setAccessLevel is missing entirely", async () => {
    stubSetAccessLevel(undefined);
    const { ensureTrustedContexts, credentialStorageUsable } = await import(
      "../lib/storageAccess"
    );

    await expect(ensureTrustedContexts()).resolves.toBe(false);
    await expect(credentialStorageUsable()).resolves.toBe(false);
  });
});

describe("credential ops (storage usable)", () => {
  it("saves, reads, and clears a normalized credential", async () => {
    stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
    const {
      saveCredential,
      getCredential,
      hasCredential,
      clearCredential,
      CREDENTIAL_STORAGE_KEY,
    } = await import("../lib/tokenOps");

    await expect(hasCredential()).resolves.toBe(false);
    await expect(getCredential()).resolves.toBeNull();

    await expect(saveCredential("Token abc123")).resolves.toEqual({ ok: true });
    const stored = await fakeBrowser.storage.local.get(CREDENTIAL_STORAGE_KEY);
    // "Token x" input is stored as the bare credential "x"
    expect(stored[CREDENTIAL_STORAGE_KEY]).toBe("abc123");

    await expect(getCredential()).resolves.toBe("abc123");
    await expect(hasCredential()).resolves.toBe(true);

    await expect(clearCredential()).resolves.toBeUndefined();
    await expect(getCredential()).resolves.toBeNull();
    await expect(hasCredential()).resolves.toBe(false);
  });

  it("stores a bare credential unchanged", async () => {
    stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
    const { saveCredential, getCredential } = await import("../lib/tokenOps");

    await expect(saveCredential("abc123")).resolves.toEqual({ ok: true });
    await expect(getCredential()).resolves.toBe("abc123");
  });

  it("rejects unnormalizable input without storing", async () => {
    stubSetAccessLevel(vi.fn().mockResolvedValue(undefined));
    const { saveCredential, hasCredential, CREDENTIAL_STORAGE_KEY } =
      await import("../lib/tokenOps");

    for (const raw of ["", "   ", "Token", "Token   ", "has space"]) {
      await expect(saveCredential(raw)).resolves.toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    await expect(hasCredential()).resolves.toBe(false);
    const stored = await fakeBrowser.storage.local.get(CREDENTIAL_STORAGE_KEY);
    expect(stored[CREDENTIAL_STORAGE_KEY]).toBeUndefined();
  });
});

describe("credential ops fail closed when storage is locked", () => {
  it("save -> storage_locked, get -> null, has -> false, clear -> no-op", async () => {
    // beforeEach installed the throwing stub → lockdown fails.
    const { saveCredential, getCredential, hasCredential, clearCredential } =
      await import("../lib/tokenOps");

    await expect(saveCredential("abc123")).resolves.toEqual({
      ok: false,
      reason: "storage_locked",
    });
    await expect(getCredential()).resolves.toBeNull();
    await expect(hasCredential()).resolves.toBe(false);
    await expect(clearCredential()).resolves.toBeUndefined();
  });

  it("writes nothing to storage when locked", async () => {
    const { saveCredential, CREDENTIAL_STORAGE_KEY } = await import(
      "../lib/tokenOps"
    );
    await saveCredential("abc123");
    const stored = await fakeBrowser.storage.local.get(CREDENTIAL_STORAGE_KEY);
    expect(stored[CREDENTIAL_STORAGE_KEY]).toBeUndefined();
  });

  it("still removes a stored credential when lockdown verification fails", async () => {
    await fakeBrowser.storage.local.set({ apiCredential: "abc123" });
    const { clearCredential, CREDENTIAL_STORAGE_KEY } = await import(
      "../lib/tokenOps"
    );
    await expect(clearCredential()).resolves.toBeUndefined();
    const stored = await fakeBrowser.storage.local.get(CREDENTIAL_STORAGE_KEY);
    expect(stored[CREDENTIAL_STORAGE_KEY]).toBeUndefined();
  });

  it("reports invalid input even when storage is locked (normalize runs first)", async () => {
    const { saveCredential } = await import("../lib/tokenOps");
    await expect(saveCredential("  ")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
