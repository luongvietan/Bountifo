// ---------------------------------------------------------------------------
// Render guard. The engagement brief is a single-page app that renders its
// sections lazily: the targets table does not exist in the DOM until the
// reader has scrolled near it. Collecting before that happens produces an
// honest but empty dossier — the scope inventory reads "None recorded" for a
// program that has sixteen targets.
//
// Scrolling alone is not enough to know the page is ready. A brief that is
// still loading holds its shape with placeholder rows, so it has a stable
// element count and a bottom to reach while showing nothing; and a brief in a
// hidden tab never renders at all, however far it is scrolled. So the guard
// asks three questions — did it stop growing, is there anything below, is it
// still a skeleton — and says why when the answer is no.
//
// Everything here is expressed against a tiny interface so the walk is
// testable without a browser.
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
  /**
   * False while the document is hidden. A hidden tab does not run the brief's
   * lazy rendering, so scrolling it accomplishes nothing; the only thing worth
   * doing is waiting for the reader to come back.
   */
  visible?(): boolean;
  /** True while the page is still showing loading placeholders. */
  pending?(): boolean;
}

/** Why the page never settled. Absent when it did. */
export type RenderStall = "page_hidden" | "still_loading" | "step_cap";

export interface RenderResult {
  steps: number;
  /** True when the page stopped growing before the step cap. */
  settled: boolean;
  reason: RenderStall | null;
}

export interface RenderOptions {
  maxSteps?: number;
  stepMs?: number;
  /** Consecutive unchanged measurements that count as settled. */
  stillFor?: number;
}

/**
 * Scrolls until the page stops producing new content, then restores the
 * original position. Never throws: a page that refuses to render is reported
 * as unsettled with a reason and collection continues on whatever is present,
 * because a partial brief is still worth exporting (and is marked partial
 * downstream, where the reason is recorded as a quality warning).
 */
export async function ensureRendered(
  target: RenderTarget,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const maxSteps = options.maxSteps ?? 40;
  const stepMs = options.stepMs ?? 250;
  const stillFor = options.stillFor ?? 2;
  const visible = () => target.visible?.() ?? true;
  const pending = () => target.pending?.() ?? false;

  let start = 0;
  try {
    start = target.scrollY();
  } catch {
    return { steps: 0, settled: false, reason: "step_cap" };
  }

  let steps = 0;
  let still = 0;
  let previous = -1;
  let settled = false;
  let reason: RenderStall = "step_cap";
  // Steps spent scrolling, so a hidden page does not skip straight past the
  // top of the document once it comes back.
  let scrolls = 0;

  try {
    for (; steps < maxSteps; steps++) {
      const showing = visible();
      let atBottom = false;
      if (showing) {
        const viewport = target.viewport();
        const bottom = Math.max(target.height() - viewport, 0);
        const next = Math.min((scrolls + 1) * viewport, bottom);
        target.scrollTo(next);
        atBottom = next >= bottom;
        scrolls++;
      }
      await target.wait(stepMs);

      if (!showing) {
        // Nothing observed while hidden means anything: start the stability
        // count over when the page comes back.
        still = 0;
        previous = -1;
        reason = "page_hidden";
        continue;
      }

      const size = target.size();
      still = size === previous ? still + 1 : 0;
      previous = size;
      if (still < stillFor || !atBottom) {
        reason = "step_cap";
        continue;
      }
      // Stable and nothing below — but a skeleton is stable too.
      if (pending()) {
        reason = "still_loading";
        continue;
      }
      settled = true;
      steps++;
      break;
    }
  } catch {
    settled = false;
  }

  try {
    target.scrollTo(start);
  } catch {
    // The reader's position is a courtesy, not a requirement.
  }
  return { steps, settled, reason: settled ? null : reason };
}

/**
 * Loading placeholders this many times over means the brief is still a
 * skeleton. Bugcrowd draws each placeholder line as a zero-width non-joiner;
 * a rendered brief contains none, and one mid-load measured 184.
 */
const PLACEHOLDER_LIMIT = 20;
const PLACEHOLDER = "‌";

function placeholderHeavy(text: string): boolean {
  let seen = 0;
  let at = text.indexOf(PLACEHOLDER);
  while (at !== -1) {
    if (++seen >= PLACEHOLDER_LIMIT) return true;
    at = text.indexOf(PLACEHOLDER, at + 1);
  }
  return false;
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
    visible: () => doc.visibilityState !== "hidden",
    // textContent rather than innerText: the question is what the page holds,
    // not how it lays out, and this runs once per step.
    pending: () => placeholderHeavy(doc.body?.textContent ?? ""),
  };
}
