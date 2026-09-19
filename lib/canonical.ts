import { TRACKING_PARAMS } from "./constants";
import type { SourceLocator } from "./types";

/**
 * NFC, CRLF/CR→LF, trim, collapse interior whitespace runs to a single space.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Recursive key-sorted JSON.stringify. Object keys sort lexicographically,
 * undefined object properties are dropped, array order is preserved.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value)) ?? "null";
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop === undefined) continue;
      sorted[key] = sortForCanonicalJson(prop);
    }
    return sorted;
  }
  return value;
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.some((pattern) =>
    pattern.endsWith("*")
      ? lower.startsWith(pattern.slice(0, -1))
      : lower === pattern,
  );
}

/**
 * Lowercases scheme/host, strips default port, fragment, and TRACKING_PARAMS,
 * sorts the remaining query params by key then value. Path is preserved.
 */
export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  url.hash = "";
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB
        ? valueA < valueB
          ? -1
          : valueA > valueB
            ? 1
            : 0
        : keyA < keyB
          ? -1
          : 1,
    );
  url.search = "";
  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

/**
 * canonicalJson of defined locator fields only (undefined fields dropped).
 */
export function canonicalLocator(loc: SourceLocator): string {
  return canonicalJson(loc);
}
