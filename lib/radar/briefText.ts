import { normalizeText } from "../canonical";

// ---------------------------------------------------------------------------
// V1.4 brief-text extraction — pure deterministic HTML→text of the brief
// document's two free-text fields (`data.brief.description` and
// `data.brief.targetsOverview`), joined with "\n".
//
// No DOMParser: the changelog document serves sanitized HTML fragments, and
// the signals that consume this (accessibility, authz_opportunity) only need
// plaintext. Pipeline per field: strip `<[^>]*>` → single space, decode the
// named entities `&amp; &lt; &gt; &quot; &#39; &nbsp;` plus numeric `&#\d+;`
// references, then collapse whitespace (normalizeText). Returns null when
// both sources are absent or normalize to empty — unknown, never fabricated.
// ---------------------------------------------------------------------------

/** One regex, single left-to-right pass — `&amp;lt;` decodes to "&lt;". */
const ENTITY_RE = /&(?:amp|lt|gt|quot|nbsp);|&#\d+;/g;

function decodeEntity(entity: string): string {
  switch (entity) {
    case "&amp;":
      return "&";
    case "&lt;":
      return "<";
    case "&gt;":
      return ">";
    case "&quot;":
      return '"';
    case "&nbsp;":
      return " ";
    default: {
      // "&#\d+;" — decimal numeric character reference.
      const code = Number(entity.slice(2, -1));
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Tags become single spaces (word boundary preserved); entities decode
 *  after the strip so escaped markup like `&lt;div&gt;` survives as text. */
function htmlToText(html: string): string {
  return normalizeText(
    html.replace(/<[^>]*>/g, " ").replace(ENTITY_RE, decodeEntity),
  );
}

/**
 * `doc` is the raw changelog/brief document (the object carrying `data`).
 * Non-string or absent fields contribute nothing; null when neither source
 * yields text.
 */
export function briefTextFromDoc(doc: unknown): string | null {
  const brief = asRecord(asRecord(doc)?.data)?.brief;
  const fields = asRecord(brief);
  const parts: string[] = [];
  for (const raw of [fields?.description, fields?.targetsOverview]) {
    if (typeof raw !== "string") continue;
    const text = htmlToText(raw);
    if (text !== "") parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}
