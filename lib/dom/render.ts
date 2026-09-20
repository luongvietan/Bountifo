// ---------------------------------------------------------------------------
// Render guard. The engagement brief is a single-page app that renders its
// sections lazily: the targets table does not exist in the DOM until the
// reader has scrolled near it. Collecting before that happens produces an
// honest but empty dossier — the scope inventory reads "None recorded" for a
// program that has sixteen targets.
//
// So collection scrolls the brief once, waits for it to stop growing, and puts
// the reader back where they were. Everything here is expressed against a tiny
// interface so the walk is testable without a browser.
// ---------------------------------------------------------------------------

export interface RenderTarget {
  scrollY(): number;
  scrollTo(y: number): void;
  /** Full document height, which grows as lazy sections materialise. */
  height(): number;
  viewport(): number;
  /** Any monotonic measure of "how much page exists" (element count). */
  size(): number;
  wait(ms: number): Promise<void>;
}

export interface RenderResult {
  steps: number;
  /** True when the page stopped growing before the step cap. */
  settled: boolean;
}

export interface RenderOptions {
  maxSteps?: number;
  stepMs?: number;
  /** Consecutive unchanged measurements that count as settled. */
  stillFor?: number;
}

/**
 * Scrolls until the page stops producing new content, then restores the
 * original position. Never throws: a page that refuses to scroll is reported
 * as unsettled and collection continues on whatever is present, because a
 * partial brief is still worth exporting (and is marked partial downstream).
 */
export async function ensureRendered(
  target: RenderTarget,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const maxSteps = options.maxSteps ?? 40;
  const stepMs = options.stepMs ?? 250;
  const stillFor = options.stillFor ?? 2;

  let start = 0;
  try {
    start = target.scrollY();
  } catch {
    return { steps: 0, settled: false };
  }

  let steps = 0;
  let still = 0;
  let previous = -1;
  let settled = false;

  try {
    for (; steps < maxSteps; steps++) {
      const viewport = target.viewport();
      const bottom = Math.max(target.height() - viewport, 0);
      const next = Math.min((steps + 1) * viewport, bottom);
      target.scrollTo(next);
      await target.wait(stepMs);

      const size = target.size();
      still = size === previous ? still + 1 : 0;
      previous = size;
      // Settled means: nothing new appeared, and there is nothing below us.
      if (still >= stillFor && next >= bottom) {
        settled = true;
        steps++;
        break;
      }
    }
  } catch {
    settled = false;
  }

  try {
    target.scrollTo(start);
  } catch {
    // The reader's position is a courtesy, not a requirement.
  }
  return { steps, settled };
}

/** RenderTarget backed by a real window/document pair. */
export function windowTarget(win: Window): RenderTarget {
  const doc = win.document;
  return {
    scrollY: () => win.scrollY,
    scrollTo: (y) => win.scrollTo(0, y),
    height: () =>
      Math.max(
        doc.documentElement?.scrollHeight ?? 0,
        doc.body?.scrollHeight ?? 0,
      ),
    viewport: () => win.innerHeight || 800,
    size: () => doc.querySelectorAll("*").length,
    wait: (ms) => new Promise((resolve) => win.setTimeout(resolve, ms)),
  };
}
