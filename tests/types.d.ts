// Ambient test-only module declarations.
// `?raw` fixture imports resolve to file contents through Vite.
declare module "*.html?raw" {
  const content: string;
  export default content;
}

// jsdom ships no bundled types; declare the surface the DOM tests use.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: { document: Document };
  }
}

// Sample-report regeneration (tests/radar-samples.test.ts WRITE_SAMPLES=1)
// writes docs/samples/* — declared here rather than lib/guard/node.d.ts so
// the architecture tripwire never mistakes ambient declarations for
// production fs sinks.
declare module "node:fs" {
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): void;
}

declare module "node:url" {
  export function fileURLToPath(url: URL): string;
}
