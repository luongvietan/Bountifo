// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { keepMounted, mountLauncher, EXPORTER_UI_ATTR } from "../lib/ui/launcher";
import { collectTargets } from "../lib/dom/targets";
import { collectPolicies } from "../lib/dom/policies";
import { loadDoc, PAGE_URL } from "./helpers/dom";

function deps(over: Partial<Parameters<typeof mountLauncher>[1]> = {}) {
  return {
    startExport: vi.fn(async () => ({ ok: true as const })),
    cancelExport: vi.fn(async () => undefined),
    getState: vi.fn(async () => null),
    openOptions: vi.fn(),
    openRadar: vi.fn(),
    pageUrl: () => "https://bugcrowd.com/engagements/webdotcom",
    ...over,
  };
}

const shadowOf = (doc: Document) =>
  doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!.shadowRoot!;
const control = (doc: Document, name: string) =>
  shadowOf(doc).querySelector<HTMLButtonElement>(`[data-control="${name}"]`)!;

describe("mountLauncher placement", () => {
  it("sits inside the program title, to the right of the title text", () => {
    const doc = loadDoc("webdotcom-current.html");
    mountLauncher(doc, deps());
    const title = doc.querySelector("main header h2")!;
    const host = title.querySelector(`[${EXPORTER_UI_ATTR}]`);
    expect(host).not.toBeNull();
    expect(title.lastElementChild).toBe(host);
  });

  it("mounts right of the Featured tab on the engagements index", () => {
    const doc = new DOMParser().parseFromString(
      `<main><nav aria-label="Secondary navigation"><ul>
        <li><a href="/engagements">Vulnerability Disclosure</a></li>
        <li><a href="/engagements?c=pt">Pen Tests</a></li>
        <li><a href="/engagements?c=f">Featured</a></li>
      </ul></nav></main>`,
      "text/html",
    );
    // The real index URL is regionalized and parameterized.
    mountLauncher(
      doc,
      deps({
        pageUrl: () =>
          "https://bugcrowd.com/engagements?category=bug_bounty&page=1",
      }),
    );
    const featuredItem = [...doc.querySelectorAll("li")].find(
      (li) => li.textContent?.trim() === "Featured",
    )!;
    expect(
      featuredItem.nextElementSibling?.hasAttribute(EXPORTER_UI_ATTR),
    ).toBe(true);
  });

  it("mounts at the tail of the secondary nav when the index has no Featured tab", () => {
    // /engagements-us carries only Bug Bounty | Vulnerability Disclosure |
    // Pen Tests — no Featured. The strip's tail is the same visual spot.
    const doc = new DOMParser().parseFromString(
      `<header><img alt="logo"></header>
       <main><nav aria-label="Secondary navigation"><ul>
        <li><a href="/engagements-us">Bug Bounty</a></li>
        <li><a href="/engagements-us?c=vdp">Vulnerability Disclosure</a></li>
        <li><a href="/engagements-us?c=pt">Pen Tests</a></li>
      </ul></nav></main>`,
      "text/html",
    );
    mountLauncher(
      doc,
      deps({
        pageUrl: () =>
          "https://bugcrowd.com/engagements-us?category=bug_bounty&page=1&sort_by=promoted",
      }),
    );
    const penTests = [...doc.querySelectorAll("li")].find(
      (li) => li.textContent?.trim() === "Pen Tests",
    )!;
    expect(
      penTests.nextElementSibling?.hasAttribute(EXPORTER_UI_ATTR),
    ).toBe(true);
  });

  it("ignores a breadcrumb nav that is not the index tab strip", () => {
    const doc = new DOMParser().parseFromString(
      `<main><nav aria-label="Breadcrumb"><ul><li><a>Engagements</a></li></ul></nav></main>`,
      "text/html",
    );
    mountLauncher(
      doc,
      deps({ pageUrl: () => "https://bugcrowd.com/engagements-us" }),
    );
    const host = doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!;
    expect(host.closest("nav")).toBeNull();
    expect(host.parentElement?.tagName).toBe("BODY");
  });

  it("finds the Featured tab through a role=tab strip", () => {
    const doc = new DOMParser().parseFromString(
      `<div role="tablist">
        <button role="tab">Vulnerability Disclosure</button>
        <button role="tab">Pen Tests</button>
        <button role="tab">Featured</button>
      </div>`,
      "text/html",
    );
    mountLauncher(
      doc,
      deps({ pageUrl: () => "https://bugcrowd.com/engagements/" }),
    );
    const featured = [...doc.querySelectorAll("[role='tab']")].find(
      (t) => t.textContent?.trim() === "Featured",
    )!;
    expect(
      featured.nextElementSibling?.hasAttribute(EXPORTER_UI_ATTR),
    ).toBe(true);
  });

  it("uses the Featured tab even on a detail-shaped URL with no title", () => {
    // /engagements/featured parses like an engagement code but is a listing
    // view — the tab strip is the tell, not the URL shape.
    const doc = new DOMParser().parseFromString(
      `<nav><ul><li><a>Featured</a></li></ul></nav>`,
      "text/html",
    );
    mountLauncher(
      doc,
      deps({ pageUrl: () => "https://bugcrowd.com/engagements/featured" }),
    );
    const item = doc.querySelector("li")!;
    expect(item.nextElementSibling?.hasAttribute(EXPORTER_UI_ATTR)).toBe(true);
  });

  it("falls back to the header, then to a floating host", () => {
    const doc = loadDoc("webdotcom-current.html");
    doc.querySelector("main header h2")!.remove();
    doc.querySelector("main header img")!.remove();
    mountLauncher(doc, deps());
    const host = doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!;
    expect(host.closest("main header")).not.toBeNull();

    const bare = new DOMParser().parseFromString("<p>nothing</p>", "text/html");
    mountLauncher(bare, deps());
    const floating = bare.querySelector(`[${EXPORTER_UI_ATTR}]`)!;
    expect(floating.parentElement?.tagName).toBe("BODY");
  });

  it("mounts once even when main() runs again", () => {
    const doc = loadDoc("webdotcom-current.html");
    mountLauncher(doc, deps());
    mountLauncher(doc, deps());
    expect(doc.querySelectorAll(`[${EXPORTER_UI_ATTR}]`)).toHaveLength(1);
  });
});

describe("mountLauncher isolation from collection", () => {
  it("leaves collector output byte-identical", () => {
    const before = collectTargets(loadDoc("webdotcom-current.html"), PAGE_URL);
    const beforePolicy = collectPolicies(loadDoc("webdotcom-current.html"), PAGE_URL);
    const doc = loadDoc("webdotcom-current.html");
    mountLauncher(doc, deps());
    control(doc, "toggle").click(); // panel open: its markup is live
    expect(JSON.stringify(collectTargets(doc, PAGE_URL))).toBe(
      JSON.stringify(before),
    );
    expect(JSON.stringify(collectPolicies(doc, PAGE_URL))).toBe(
      JSON.stringify(beforePolicy),
    );
  });

  it("hides its controls and dialog from document-level queries", () => {
    const doc = loadDoc("webdotcom-current.html");
    mountLauncher(doc, deps());
    control(doc, "toggle").click();
    // The Known Issues driver scans the document for dialogs and buttons.
    expect(doc.querySelectorAll("[role='dialog'],dialog").length).toBe(0);
    const buttons = [...doc.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons.some((t) => (t ?? "").includes("Export"))).toBe(false);
  });
});

describe("mountLauncher behavior", () => {
  it("starts an export for the current tab and reports back", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const d = deps();
    const ui = mountLauncher(doc, d);
    control(doc, "toggle").click();
    control(doc, "export").click();
    await vi.waitFor(() => expect(d.startExport).toHaveBeenCalledTimes(1));
    expect(shadowOf(doc).textContent).toContain("Export started");
    ui.destroy();
  });

  it("surfaces a refusal instead of claiming success", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const d = deps({
      startExport: vi.fn(async () => ({ ok: false as const, error: "job_active" })),
    });
    mountLauncher(doc, d);
    control(doc, "toggle").click();
    control(doc, "export").click();
    await vi.waitFor(() =>
      expect(shadowOf(doc).textContent).toContain("job_active"),
    );
  });

  it("renders live phase and counters, and cancels the running job", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const job = {
      jobId: "job_ab12cd34",
      phase: "collecting",
      counters: { unitDone: 3, unitTotal: 12, kiDone: 1, kiTotal: 4 },
      warnings: 0,
      unresolvedConflicts: 0,
    };
    const d = deps({ getState: vi.fn(async () => job as never) });
    const ui = mountLauncher(doc, d);
    control(doc, "toggle").click();
    await ui.refresh();
    const text = shadowOf(doc).textContent ?? "";
    expect(text).toContain("Collecting");
    expect(text).toContain("3/12 units");
    expect(control(doc, "export").disabled).toBe(true);
    control(doc, "cancel").click();
    await vi.waitFor(() =>
      expect(d.cancelExport).toHaveBeenCalledWith("job_ab12cd34"),
    );
  });

  it("opens the Radar page from the panel", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const d = deps();
    mountLauncher(doc, d);
    control(doc, "toggle").click();
    control(doc, "radar").click();
    expect(d.openRadar).toHaveBeenCalledTimes(1);
  });

  it("refuses to export away from a supported engagement page", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const ui = mountLauncher(
      doc,
      deps({ pageUrl: () => "https://bugcrowd.com/dashboard" }),
    );
    await ui.refresh();
    expect(control(doc, "export").disabled).toBe(true);
  });

  it("follows a client-side navigation instead of trusting the mount-time URL", async () => {
    const doc = loadDoc("webdotcom-current.html");
    let url = "https://bugcrowd.com/dashboard";
    const ui = mountLauncher(doc, deps({ pageUrl: () => url }));
    await ui.refresh();
    expect(control(doc, "export").disabled).toBe(true);
    url = "https://bugcrowd.com/engagements/webdotcom";
    await ui.refresh();
    expect(control(doc, "export").disabled).toBe(false);
  });
});

describe("launcher polling", () => {
  const runningJob = {
    jobId: "job_ab12cd34",
    phase: "collecting",
    counters: { unitDone: 3, unitTotal: 12, kiDone: 0, kiTotal: 0 },
    warnings: 0,
    unresolvedConflicts: 0,
  };

  it("keeps reporting progress while the window is behind another one", async () => {
    // The export runs in the background worker; a covered tab reports
    // visibilityState "hidden", and skipping the poll froze the panel on its
    // last painted state while the job ran to completion.
    const doc = loadDoc("webdotcom-current.html");
    const d = deps({
      getState: vi.fn(async () => runningJob as never),
      isVisible: () => false,
    });
    const keeper = keepMounted(doc, d);
    // A covered tab polls on a slower beat, but it never stops.
    for (let i = 0; i < 5; i++) await keeper.tick();
    expect(d.getState).toHaveBeenCalled();
    expect(shadowOf(doc).textContent).toContain("3/12 units");
    keeper.stop();
  });

  it("stays quiet on an idle page nobody is looking at", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const d = deps({ getState: vi.fn(async () => null), isVisible: () => false });
    const keeper = keepMounted(doc, d);
    await keeper.tick();
    await keeper.tick();
    expect(d.getState).not.toHaveBeenCalled();
    keeper.stop();
  });

  it("does not stack overlapping refreshes", async () => {
    const doc = loadDoc("webdotcom-current.html");
    let resolve: (v: unknown) => void = () => undefined;
    const d = deps({
      getState: vi.fn(
        () => new Promise((r) => { resolve = r; }) as never,
      ),
    });
    const ui = mountLauncher(doc, d);
    const first = ui.refresh();
    const second = ui.refresh();
    resolve(null);
    await Promise.all([first, second]);
    expect(d.getState).toHaveBeenCalledTimes(1);
    ui.destroy();
  });
});

describe("keepMounted against a re-rendering page", () => {
  it("comes back after the app rebuilds the header subtree", () => {
    const doc = loadDoc("webdotcom-current.html");
    const keeper = keepMounted(doc, deps());
    const header = doc.querySelector("main header")!;
    // What React does on re-render: the subtree is rebuilt from scratch,
    // taking foreign nodes with it — including the button nested inside the
    // title heading.
    const clones = [...header.children].map((c) => {
      const clone = c.cloneNode(true) as Element;
      clone
        .querySelectorAll(`[${EXPORTER_UI_ATTR}]`)
        .forEach((n) => n.remove());
      return clone;
    });
    header.replaceChildren(...clones);
    expect(doc.querySelector(`[${EXPORTER_UI_ATTR}]`)).toBeNull();
    keeper.check();
    expect(doc.querySelector(`[${EXPORTER_UI_ATTR}]`)).not.toBeNull();
    keeper.stop();
  });

  it("moves into the title once the app has rendered the header", () => {
    const doc = new DOMParser().parseFromString(
      "<main id='researcher-engagement-brief-root'></main>",
      "text/html",
    );
    const keeper = keepMounted(doc, deps());
    expect(
      doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!.parentElement!.tagName,
    ).toBe("BODY");

    const header = doc.createElement("header");
    header.innerHTML = "<h2>Late brief</h2><img alt='logo'>";
    doc.querySelector("main")!.append(header);
    keeper.check();
    const host = doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!;
    expect(host.parentElement?.tagName).toBe("H2");
    expect(host.parentElement?.textContent).toContain("Late brief");
    expect(doc.querySelectorAll(`[${EXPORTER_UI_ATTR}]`)).toHaveLength(1);
    keeper.stop();
  });

  it("does not remount while the button is where it belongs", () => {
    const doc = loadDoc("webdotcom-current.html");
    const keeper = keepMounted(doc, deps());
    const first = doc.querySelector(`[${EXPORTER_UI_ATTR}]`);
    keeper.check();
    keeper.check();
    expect(doc.querySelector(`[${EXPORTER_UI_ATTR}]`)).toBe(first);
    keeper.stop();
  });

  it("keeps the panel open across a remount", () => {
    const doc = loadDoc("webdotcom-current.html");
    const keeper = keepMounted(doc, deps());
    control(doc, "toggle").click();
    expect(shadowOf(doc).querySelector(".panel")!.hasAttribute("hidden")).toBe(false);
    doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!.remove();
    keeper.check();
    expect(shadowOf(doc).querySelector(".panel")!.hasAttribute("hidden")).toBe(false);
    keeper.stop();
  });

  it("reacts to a mutation without being polled", async () => {
    const doc = loadDoc("webdotcom-current.html");
    const keeper = keepMounted(doc, deps());
    doc.querySelector(`[${EXPORTER_UI_ATTR}]`)!.remove();
    await vi.waitFor(() =>
      expect(doc.querySelector(`[${EXPORTER_UI_ATTR}]`)).not.toBeNull(),
    );
    keeper.stop();
  });
});
