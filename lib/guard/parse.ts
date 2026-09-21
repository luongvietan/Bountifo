import { parse as parseYaml } from "yaml";
import type { AgentFacts } from "./types.ts";

/** Thrown when the Agent Facts input cannot be read as an object at all. */
export class FactsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactsParseError";
  }
}

/**
 * The Agent Facts block is a fenced YAML document under the dossier's
 * "## Agent Facts" heading. Also accepts a bare YAML/JSON facts document.
 */
const AGENT_FACTS_BLOCK_RE =
  /^##\s+Agent Facts[^\n]*\n+```ya?ml[^\n]*\r?\n([\s\S]*?)```/im;

export function extractAgentFactsYaml(dossier: string): string | null {
  const m = AGENT_FACTS_BLOCK_RE.exec(dossier);
  return m === null ? null : (m[1] ?? null);
}

/**
 * Parse Agent Facts from a dossier markdown string, a bare YAML/JSON facts
 * document, or an already-parsed object. Malformed input throws
 * FactsParseError; structurally old dossiers (no `scope_inventory`) parse
 * fine — the compiler degrades them to REVIEW.
 */
export function parseAgentFacts(input: string | object): AgentFacts {
  let raw: unknown;
  if (typeof input === "string") {
    const embedded = extractAgentFactsYaml(input);
    const text = (embedded ?? input).trim();
    if (text === "") throw new FactsParseError("empty Agent Facts input");
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new FactsParseError(
        `Agent Facts YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    raw = input;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FactsParseError("Agent Facts is not a mapping");
  }
  return raw as AgentFacts;
}
