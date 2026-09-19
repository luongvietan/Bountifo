import { BUGCROWD_SITE } from "./constants";
import { canonicalJson } from "./canonical";

export interface ParsedEngagementUrl {
  code: string;
  canonicalUrl: string;
}

const ENGAGEMENT_PATH_RE = /^\/engagements\/([A-Za-z0-9_-]+)(?:\/|$)/;

/**
 * Matches https://bugcrowd.com/engagements/<code>(optional subpath/query);
 * returns null otherwise. The canonical URL is the engagement root —
 * subpaths and query params are dropped.
 */
export function parseEngagementUrl(raw: string): ParsedEngagementUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "bugcrowd.com") return null;
  const code = ENGAGEMENT_PATH_RE.exec(url.pathname)?.[1];
  if (code === undefined) return null;
  return { code, canonicalUrl: `${BUGCROWD_SITE}/engagements/${code}` };
}

export function isSupportedEngagementUrl(raw: string): boolean {
  return parseEngagementUrl(raw) !== null;
}

/**
 * `bugcrowd-${code}-${yyyy}-${mm}-${dd}.md` in local time, zero-padded.
 */
export function exportFileName(engagementCode: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `bugcrowd-${engagementCode}-${yyyy}-${mm}-${dd}.md`;
}

export interface DerivedTargetIdInput {
  engagementId: string; // API UUID else canonical engagement URL
  location: string | null;
  name: string | null;
  type: string | null;
  occurrence?: number;
}

/**
 * canonicalJson preimage for derived target IDs; `occurrence` is omitted
 * when undefined and included when set (duplicate disambiguation).
 */
export function targetIdPreimage(input: DerivedTargetIdInput): string {
  return canonicalJson({
    engagementId: input.engagementId,
    location: input.location,
    name: input.name,
    type: input.type,
    occurrence: input.occurrence,
  });
}
