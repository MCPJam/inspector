/**
 * Sandbox Proxy mount tests.
 *
 * `mountInner` / `createInnerFrame` live inline in `sandbox-proxy.html` (they
 * run in the proxy iframe, not Node). We lift them out of the HTML with the
 * same brace-walking extractor `sandbox-proxy-buildCSP.test.ts` uses and
 * evaluate them against a jsdom document.
 *
 * What is pinned here: the frame is created with its final `sandbox=` /
 * `allow=` BEFORE insertion (both are fixed at document creation), the
 * previous frame is removed and the `inner` binding repointed, the explicit
 * `"srcdoc"` mount mode and the opaque-origin fallback both assign `srcdoc`,
 * and a nested `sandbox-proxy-ready` (a widget reloading itself) remounts
 * from the cached arguments instead of being relayed.
 *
 * What is NOT pinned here: that the written document takes the proxy's URL.
 * jsdom's `document.open()` only clears child nodes — it models neither the
 * URL adoption nor the listener reset the HTML spec's document-open steps
 * require — so that property is asserted in the browser e2e, not here.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "routes",
    "apps",
    "mcp-apps",
    "sandbox-proxy.html",
  ),
  "utf8",
);

function extract(name: string): string {
  const sig = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = sig.exec(html);
  if (!m) throw new Error(`Could not extract function ${name}`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const ch = html[i++];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) throw new Error(`Unbalanced braces in ${name}`);
  return html.slice(m.index, i);
}

const applyColorSchemeSrc = extract("applyColorScheme");
const createInnerFrameSrc = extract("createInnerFrame");
const mountInnerSrc = extract("mountInner");
const remountLastSrc = extract("remountLast");

interface MountHarness {
  mountInner: (
    html: string,
    sandboxValue: string,
    allowValue: string,
    colorScheme: unknown,
    mountMode?: "write" | "srcdoc",
  ) => "url" | "srcdoc" | "srcdoc-fallback";
  createInnerFrame: (
    sandboxValue: string,
    allowValue: string,
  ) => HTMLIFrameElement;
  getInner: () => HTMLIFrameElement | null;
  getLastMount: () => Record<string, unknown> | null;
  setInner: (frame: HTMLIFrameElement | null) => void;
  /** Every `window.parent.postMessage` the proxy made. */
  posted: Array<[unknown, string]>;
}

/**
 * Rehydrate the proxy's mount helpers against a jsdom document, with the
 * top-level `inner` / `lastMount` bindings they close over.
 */
function harness(): { dom: JSDOM; h: MountHarness } {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      url: "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1",
    },
  );
  const posted: Array<[unknown, string]> = [];
  const win = {
    parent: {
      postMessage: (data: unknown, targetOrigin: string) =>
        posted.push([data, targetOrigin]),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    "document",
    "window",
    "posted",
    `
    const INNER_STYLE = "width:100%; height:100%; border:none;";
    let inner = null;
    let lastMount = null;
    ${applyColorSchemeSrc}
    ${createInnerFrameSrc}
    ${mountInnerSrc}
    ${remountLastSrc}
    return {
      mountInner,
      createInnerFrame,
      getInner: () => inner,
      getLastMount: () => lastMount,
      setInner: (frame) => { inner = frame; },
      posted,
    };
    `,
  ) as (
    document: Document,
    window: unknown,
    posted: Array<[unknown, string]>,
  ) => MountHarness;
  return { dom, h: factory(dom.window.document, win, posted) };
}

const WIDGET = "<!doctype html><html><body><p id='w'>hi</p></body></html>";

describe("sandbox-proxy createInnerFrame", () => {
  it("sets sandbox and allow on the element without appending it", () => {
    const { dom, h } = harness();
    const frame = h.createInnerFrame(
      "allow-scripts allow-same-origin",
      "camera *",
    );
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin",
    );
    expect(frame.getAttribute("allow")).toBe("camera *");
    expect(frame.isConnected).toBe(false);
    expect(dom.window.document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("omits allow when there are no permissions", () => {
    const { h } = harness();
    const frame = h.createInnerFrame("allow-scripts allow-same-origin", "");
    expect(frame.hasAttribute("allow")).toBe(false);
  });
});

describe("sandbox-proxy mountInner", () => {
  it("writes the HTML into a fresh frame that carries its attributes at insertion", () => {
    const { dom, h } = harness();
    const body = dom.window.document.body;
    const seen: Array<{ sandbox: string | null; allow: string | null }> = [];
    const realAppend = body.appendChild.bind(body);
    vi.spyOn(body, "appendChild").mockImplementation((node: Node) => {
      const el = node as HTMLIFrameElement;
      seen.push({
        sandbox: el.getAttribute("sandbox"),
        allow: el.getAttribute("allow"),
      });
      return realAppend(node);
    });

    const mode = h.mountInner(
      WIDGET,
      "allow-forms allow-same-origin allow-scripts",
      "geolocation *",
      "dark",
    );

    expect(mode).toBe("url");
    expect(seen).toEqual([
      {
        sandbox: "allow-forms allow-same-origin allow-scripts",
        allow: "geolocation *",
      },
    ]);
    const inner = h.getInner()!;
    expect(inner.isConnected).toBe(true);
    expect(inner.hasAttribute("srcdoc")).toBe(false);
    expect(inner.contentDocument!.querySelector("#w")!.textContent).toBe("hi");
    expect(inner.style.colorScheme).toBe("dark");
    expect(dom.window.document.documentElement.style.colorScheme).toBe("dark");
    expect(h.getLastMount()).toEqual({
      html: WIDGET,
      sandboxValue: "allow-forms allow-same-origin allow-scripts",
      allowValue: "geolocation *",
      colorScheme: "dark",
      mountMode: undefined,
    });
  });

  it("reports where the view landed so the host can show the origin", () => {
    // The Inspector's "View origin" chip is fed by this message, and it is
    // the answer to "what do I allowlist with my third-party API key" — a
    // mount that reports nothing is a mount the developer cannot act on.
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    expect(h.posted).toEqual([
      [
        {
          type: "mcpjam:view-mode",
          mode: "url",
          // jsdom's document.open() does not adopt the entry document's URL
          // (the browser e2e pins that); what matters here is that the proxy
          // reports its own document URL rather than a hardcoded string.
          url: "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1",
        },
        "*",
      ],
    ]);
  });

  it("reports about:srcdoc when the view has no URL of its own", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-scripts", "", "light", "srcdoc");
    expect(h.posted).toEqual([
      [{ type: "mcpjam:view-mode", mode: "srcdoc", url: "about:srcdoc" }, "*"],
    ]);
  });

  it("removes the previous frame and repoints `inner` on every mount", () => {
    const { dom, h } = harness();
    const placeholder = h.createInnerFrame(
      "allow-scripts allow-same-origin",
      "",
    );
    dom.window.document.body.appendChild(placeholder);
    h.setInner(placeholder);

    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const first = h.getInner()!;
    expect(placeholder.isConnected).toBe(false);
    expect(first).not.toBe(placeholder);

    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const second = h.getInner()!;
    expect(first.isConnected).toBe(false);
    expect(second).not.toBe(first);
    expect(dom.window.document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it('assigns srcdoc when the host asks for mountMode "srcdoc"', () => {
    const { h } = harness();
    const mode = h.mountInner(
      WIDGET,
      "allow-same-origin allow-scripts",
      "",
      "light",
      "srcdoc",
    );
    expect(mode).toBe("srcdoc");
    expect(h.getInner()!.getAttribute("srcdoc")).toBe(WIDGET);
    expect(h.getLastMount()!.mountMode).toBe("srcdoc");
  });

  it("falls back to srcdoc when the frame's document is unreachable", () => {
    const { dom, h } = harness();
    const doc = dom.window.document;
    const create = doc.createElement.bind(doc);
    vi.spyOn(doc, "createElement").mockImplementation((tag: string) => {
      const el = create(tag);
      if (tag === "iframe") {
        // An opaque-origin frame exposes no contentDocument.
        Object.defineProperty(el, "contentDocument", { get: () => null });
      }
      return el;
    });

    const mode = h.mountInner(WIDGET, "allow-scripts", "", "light");
    expect(mode).toBe("srcdoc-fallback");
    expect(h.getInner()!.getAttribute("srcdoc")).toBe(WIDGET);
  });

  it("normalizes an unknown color scheme to light dark", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "sepia");
    expect(h.getInner()!.style.colorScheme).toBe("light dark");
  });
});

describe("sandbox-proxy blank-reload remount", () => {
  // Chromium answers location.reload() in a written document by reloading
  // the initial about:blank entry. jsdom cannot reload a frame, so the
  // frame's post-navigation state is stubbed and the `load` event fired
  // by hand; the listener's decision rule is what is under test.
  function loadWith(frame: HTMLIFrameElement, href: string | Error) {
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get: () => ({
        get location() {
          if (href instanceof Error) throw href;
          return { href };
        },
      }),
    });
    frame.dispatchEvent(new frame.ownerDocument.defaultView!.Event("load"));
  }

  it("remounts the last view when the frame comes back as about:blank", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "camera *", "dark");
    const before = h.getInner()!;
    loadWith(before, "about:blank");
    const after = h.getInner()!;
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(after.getAttribute("allow")).toBe("camera *");
    expect(after.contentDocument!.querySelector("#w")!.textContent).toBe("hi");
  });

  it("leaves the frame alone after its own write (href is the proxy URL)", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const frame = h.getInner()!;
    loadWith(
      frame,
      "http://127.0.0.1:6274/api/apps/mcp-apps/sandbox-proxy?v=1",
    );
    expect(h.getInner()).toBe(frame);
  });

  it("leaves a widget's own cross-origin navigation alone", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const frame = h.getInner()!;
    loadWith(frame, new Error("SecurityError"));
    expect(h.getInner()).toBe(frame);
  });

  it("ignores a load from a frame that is no longer current", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const stale = h.getInner()!;
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const current = h.getInner()!;
    loadWith(stale, "about:blank");
    expect(h.getInner()).toBe(current);
  });
});

describe("sandbox-proxy nested sandbox-proxy-ready guard", () => {
  // The relay branch is inline in the listener (not a named function), so
  // pin the contract at the source level: the guard precedes the relay
  // allow-list and remounts from `lastMount` rather than forwarding.
  it("remounts instead of relaying a nested proxy-ready", () => {
    const guardIdx = html.indexOf(
      'data.method === "ui/notifications/sandbox-proxy-ready"',
    );
    const relayIdx = html.indexOf('data.type === "mcp-apps:csp-violation"');
    expect(guardIdx).toBeGreaterThan(0);
    expect(relayIdx).toBeGreaterThan(guardIdx);
    const guard = html.slice(guardIdx, relayIdx);
    expect(guard).toContain("remountLast();");
    expect(guard).toContain("return;");
    expect(guard).not.toContain("window.parent.postMessage");
  });
});
