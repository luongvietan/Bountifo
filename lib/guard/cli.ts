#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { evaluateScopeGuard, ScopeGuardInputError } from "./index.ts";
import { FactsParseError } from "./parse.ts";
import type { ContextFact, GuardDecision } from "./types.ts";

/**
 * scope-guard check --dossier <file.md|facts.yaml> --action <action.json>
 *                   [--context <context.json>] [--compact]
 *
 * Exit codes: 0 = ALLOW, 10 = REVIEW, 20 = DENY, 2 = invalid input/runtime.
 * Output is the GuardDecision JSON on stdout — directly consumable by an
 * agent harness. Diagnostics go to stderr only.
 */

const EXIT = { allow: 0, review: 10, deny: 20, error: 2 } as const;

function usage(): string {
  return [
    "usage: scope-guard check --dossier <file> --action <file> [options]",
    "",
    "  check                        evaluate one proposed action",
    "  --dossier <path>             Markdown dossier or bare Agent Facts YAML",
    "  --action <path>              ProposedAction (JSON or YAML)",
    "  --context <path>             optional trusted ContextFact[] (JSON/YAML)",
    "  --compact                    single-line JSON output",
    "",
    "exit codes: 0=ALLOW  10=REVIEW  20=DENY  2=invalid input/runtime failure",
  ].join("\n");
}

function args(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.set(a, next);
        i++;
      } else {
        out.set(a, true);
      }
    }
  }
  return out;
}

function decisionExit(d: GuardDecision): number {
  if (d.decision === "ALLOW") return EXIT.allow;
  if (d.decision === "DENY") return EXIT.deny;
  return EXIT.review;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "check") {
    process.stderr.write(`${usage()}\n`);
    return command === undefined || command === "help" || command === "--help"
      ? EXIT.allow
      : EXIT.error;
  }
  const flags = args(rest);
  const dossierPath = flags.get("--dossier") ?? flags.get("--facts");
  const actionPath = flags.get("--action");
  if (typeof dossierPath !== "string" || typeof actionPath !== "string") {
    process.stderr.write(`missing --dossier/--action\n\n${usage()}\n`);
    return EXIT.error;
  }

  let dossier: string;
  let actionText: string;
  let context: ContextFact[] | undefined;
  try {
    dossier = await readFile(dossierPath, "utf8");
    actionText = await readFile(actionPath, "utf8");
    const contextPath = flags.get("--context");
    if (typeof contextPath === "string") {
      const raw = parseYaml(await readFile(contextPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("--context must be an array of ContextFact objects");
      }
      context = raw as ContextFact[];
    }
  } catch (err) {
    process.stderr.write(
      `input error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT.error;
  }

  const action = parseYaml(actionText) as unknown;
  try {
    const input: Parameters<typeof evaluateScopeGuard>[0] = {
      agentFacts: dossier,
      action,
    };
    if (context !== undefined) input.trustedContext = context;
    const decision = await evaluateScopeGuard(input);
    const json = flags.has("--compact")
      ? JSON.stringify(decision)
      : JSON.stringify(decision, null, 2);
    process.stdout.write(`${json}\n`);
    return decisionExit(decision);
  } catch (err) {
    if (err instanceof ScopeGuardInputError || err instanceof FactsParseError) {
      process.stderr.write(`invalid input: ${err.message}\n`);
      return EXIT.error;
    }
    process.stderr.write(
      `evaluation failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT.error;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
