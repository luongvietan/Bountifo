/**
 * Minimal Node.js ambient declarations for the Scope Guard CLI. This project
 * is a browser extension and intentionally does not depend on @types/node;
 * only the surface cli.ts touches is declared here. If @types/node is ever
 * added, delete this file (the real declarations win).
 */

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
}

declare const process: {
  argv: string[];
  exit(code: number): never;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};
