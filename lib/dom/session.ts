import { findSection } from "./domUtils";

const LOGIN_PATH_RE =
  /^\/(users?\/(sign_in|log_?in)|sign_?in|log_?in|login|auth|sessions?(\/new)?|sso|oauth|identity)/i;

const ENGAGEMENT_SECTION_RE =
  /details|scope|targets?|program|announcements?|changelog|brief|polic/i;

/**
 * True when the session looks expired: the URL landed on a login/auth path,
 * or the document carries a password login form while lacking engagement
 * content. An engagement page can legitimately display supplied credentials
 * (spec §4.3), so a password field only means "expired" when no engagement
 * sections exist. An unparseable URL simply defers to the DOM check.
 */
export function isSessionExpired(doc: Document, url: string): boolean {
  try {
    if (LOGIN_PATH_RE.test(new URL(url).pathname)) return true;
  } catch {
    // unparseable URL → DOM evidence only
  }
  if (doc.querySelector("input[type='password']") === null) return false;
  const hasEngagementContent =
    doc.querySelector("h1") !== null &&
    findSection(doc, ENGAGEMENT_SECTION_RE) !== null;
  return !hasEngagementContent;
}
