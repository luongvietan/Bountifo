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
