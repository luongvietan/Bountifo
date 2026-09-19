/**
 * SHA-256 of the UTF-8 encoding of `data`, returned as lowercase hex.
 * Uses globalThis.crypto.subtle (available in extension contexts and Node).
 */
export async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `${prefix}_${hexDigest.slice(0, len)}` — e.g. prefixedId("ev", digest, 12).
 */
export function prefixedId(
  prefix: string,
  hexDigest: string,
  len: number,
): string {
  return `${prefix}_${hexDigest.slice(0, len)}`;
}
