import { describe, expect, it, vi } from "vitest";
import { ensureRendered, type RenderTarget } from "../lib/dom/render";

/** A page that only materialises content once it has been scrolled past. */
function lazyPage(options: { chunks?: number; viewport?: number } = {}) {
  const chunks = options.chunks ?? 4;
  const viewport = options.viewport ?? 800;
  let revealed = 1;
  let y = 0;
  const waits: number[] = [];
  const target: RenderTarget = {
    scrollY: () => y,
    scrollTo: (next) => {
      y = next;
      // Scrolling to the current bottom renders the next chunk.
      if (y + viewport >= revealed * viewport && revealed < chunks) revealed++;
    },
    height: () => revealed * viewport,
    viewport: () => viewport,
    size: () => revealed * 100,
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return { target, waits, revealed: () => revealed, scrollY: () => y };
}

describe("ensureRendered", () => {
  it("scrolls a lazy brief until nothing new appears", async () => {
    const page = lazyPage({ chunks: 5 });
    const result = await ensureRendered(page.target);
    expect(page.revealed()).toBe(5);
    expect(result.settled).toBe(true);
  });

  it("puts the reader back where they were", async () => {
    const page = lazyPage({ chunks: 3 });
    page.target.scrollTo(240);
    await ensureRendered(page.target);
    expect(page.scrollY()).toBe(240);
  });

  it("stops at the step cap instead of scrolling forever", async () => {
    let size = 0;
    let y = 0;
    const endless: RenderTarget = {
      scrollY: () => y,
      scrollTo: (next) => {
        y = next;
        size += 10; // every scroll reveals more, forever
      },
      height: () => size * 100,
      viewport: () => 800,
      size: () => size,
      wait: async () => undefined,
    };
    const result = await ensureRendered(endless, { maxSteps: 6 });
    expect(result.steps).toBe(6);
    expect(result.settled).toBe(false);
    expect(y).toBe(0);
  });

  it("returns immediately when the page is already whole", async () => {
    const page = lazyPage({ chunks: 1 });
    const result = await ensureRendered(page.target);
    expect(result.settled).toBe(true);
    expect(result.steps).toBeLessThanOrEqual(3);
  });

  it("never lets a scrolling failure stop collection", async () => {
    const broken: RenderTarget = {
      scrollY: () => 0,
      scrollTo: () => {
        throw new Error("scroll blocked");
      },
      height: () => 4000,
      viewport: () => 800,
      size: () => 10,
      wait: async () => undefined,
    };
    await expect(ensureRendered(broken)).resolves.toMatchObject({
      settled: false,
    });
  });
});

describe("ensureRendered on a page that will not render", () => {
  it("does not call a skeleton settled just because it stopped growing", async () => {
    // A loading brief holds its shape: stable element count, a bottom to
    // reach, and nothing in it.
    const page = lazyPage({ chunks: 2 });
    const result = await ensureRendered(
      { ...page.target, pending: () => true },
      { maxSteps: 5 },
    );
    expect(result.settled).toBe(false);
    expect(result.reason).toBe("still_loading");
    expect(result.steps).toBe(5);
  });

  it("settles once the placeholders give way to content", async () => {
    const page = lazyPage({ chunks: 2 });
    let loading = true;
    const result = await ensureRendered(
      {
        ...page.target,
        pending: () => {
          const was = loading;
          loading = false; // the second look finds the brief rendered
          return was;
        },
      },
      { maxSteps: 8 },
    );
    expect(result.settled).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("waits out a hidden tab instead of reading an empty page", async () => {
    // A hidden tab never runs the brief's lazy rendering, so no amount of
    // scrolling helps; the guard spends its budget waiting.
    const page = lazyPage({ chunks: 4 });
    const scrolledTo: number[] = [];
    const result = await ensureRendered(
      {
        ...page.target,
        scrollTo: (y) => {
          scrolledTo.push(y);
          page.target.scrollTo(y);
        },
        visible: () => false,
      },
      { maxSteps: 5 },
    );
    expect(result.settled).toBe(false);
    expect(result.reason).toBe("page_hidden");
    // The only scroll is the one that puts the reader back where they were.
    expect(scrolledTo).toEqual([0]);
  });

  it("renders the brief when the reader comes back", async () => {
    const page = lazyPage({ chunks: 3 });
    let hidden = 3;
    const result = await ensureRendered(
      { ...page.target, visible: () => hidden-- <= 0 },
      { maxSteps: 20 },
    );
    expect(result.settled).toBe(true);
    expect(page.revealed()).toBe(3);
  });

  it("names the step cap when the page just keeps growing", async () => {
    let size = 0;
    const endless: RenderTarget = {
      scrollY: () => 0,
      scrollTo: () => {
        size += 10;
      },
      height: () => size * 100,
      viewport: () => 800,
      size: () => size,
      wait: async () => undefined,
    };
    const result = await ensureRendered(endless, { maxSteps: 4 });
    expect(result).toMatchObject({ settled: false, reason: "step_cap" });
  });
});
