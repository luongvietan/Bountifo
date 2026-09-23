/**
 * Minimal Node.js ambient declarations for the Scope Guard CLI and the
 * architecture source-scan test. This project is a browser extension and
 * intentionally does not depend on @types/node; only the surface actually
 * touched is declared here. If @types/node is ever added, delete this file
 * (the real declarations win).
 */

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): void;
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Dirent[];
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
  export function fileURLToPath(url: URL): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code: number): never;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};
