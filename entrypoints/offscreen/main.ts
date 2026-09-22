import { browser } from "wxt/browser";
import { collectDetails } from "../../lib/dom/details";
import { collectTargets } from "../../lib/dom/targets";
import { mapBriefToEngagement } from "../../lib/radar/detailMap";
import { isOffscreenParseRequest } from "../../lib/radar/offscreenProtocol";

/**
 * Offscreen document: the only extension context with DOM/DOMParser that the
 * service worker can reach headlessly. It parses fetched brief HTML with the
 * exporter's own collectors and returns the mapped ApiEngagementData. The
 * document renders nothing — the script is its whole job.
 */
browser.runtime.onMessage.addListener((msg: unknown) => {
  if (!isOffscreenParseRequest(msg)) return undefined;
  try {
    const doc = new DOMParser().parseFromString(msg.html, "text/html");
    const { data: details } = collectDetails(doc, msg.pageUrl);
    const { groups, targets } = collectTargets(doc, msg.pageUrl);
    return Promise.resolve({
      ok: true,
      detail: mapBriefToEngagement(msg.slug, details, groups, targets),
    });
  } catch {
    return Promise.resolve({ ok: false });
  }
});
