const TOKEN_PREFIX_RE = /^token\s+(.+)$/is;

/**
 * Accepts "abc" or "Token abc" (case-insensitive prefix) and returns the bare
 * credential. Returns null for empty/whitespace input, a bare "Token" prefix
 * with no credential, or a credential with invalid shape (interior whitespace).
 */
export function normalizeTokenInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const credential = (TOKEN_PREFIX_RE.exec(trimmed)?.[1] ?? trimmed).trim();
  if (credential === "") return null;
  if (/^token$/i.test(credential)) return null;
  if (/\s/.test(credential)) return null;
  return credential;
}

/**
 * Replaces every occurrence of each non-empty secret with "[REDACTED]".
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
