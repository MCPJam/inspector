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
 * a nested `sandbox-proxy-ready` (a widget reloading itself) remounts
 * from the cached arguments instead of being relayed, and the claude.ai-style
 * `"opaque"` mount (srcdoc without `allow-same-origin`) buffers host messages
 * until the view is ready.
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
const markInnerReadySrc = extract("markInnerReady");
const sendToInnerSrc = extract("sendToInner");
const buildAllowAttributeSrc = extract("buildAllowAttribute");
const buildInnerAllowValueSrc = extract("buildInnerAllowValue");
const buildInnerSandboxValueSrc = extract("buildInnerSandboxValue");
const parseOriginPatternSrc = extract("parseOriginPattern");
const hostOriginAllowedSrc = extract("hostOriginAllowed");

interface MountHarness {
  mountInner: (
    html: string,
    sandboxValue: string,
    allowValue: string,
    colorScheme: unknown,
    mountMode?: "write" | "srcdoc" | "opaque",
    appliedCsp?: string,
    appliedCspMode?: "permissive" | "widget-declared",
    cspIntent?: Record<string, unknown>,
  ) => "url" | "srcdoc" | "srcdoc-fallback" | "opaque";
  createInnerFrame: (
    sandboxValue: string,
    allowValue: string,
  ) => HTMLIFrameElement;
  getInner: () => HTMLIFrameElement | null;
  getLastMount: () => Record<string, unknown> | null;
  setInner: (frame: HTMLIFrameElement | null) => void;
  /** Host→view delivery (what the relay calls for every host message). */
  sendToInner: (data: unknown) => void;
  /** What the relay calls when the view sends its first message. */
  markInnerReady: () => void;
  getDelivery: () => { innerReady: boolean; channelDead: boolean };
  /** Every `window.parent.postMessage` the proxy made. */
  posted: Array<[unknown, string]>;
}

/**
 * Rehydrate the proxy's mount helpers against a jsdom document, with the
 * top-level `inner` / `lastMount` bindings they close over.
 */
function harness(proxyInstanceId = "proxy-a"): { dom: JSDOM; h: MountHarness } {
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
    "proxyInstanceId",
    `
    const INNER_STYLE = "width:100%; height:100%; border:none;";
    const READY_FLUSH_TIMEOUT_MS = 5000;
    let inner = null;
    let innerReady = true;
    let channelDead = false;
    let pendingForInner = [];
    let mountSequence = 0;
    let currentMountId = null;
    let lastMount = null;
    // Pinning is off in this harness; the view-mode post falls back to "*".
    let hostOrigin = null;
    ${applyColorSchemeSrc}
    ${createInnerFrameSrc}
    ${mountInnerSrc}
    ${remountLastSrc}
    ${markInnerReadySrc}
    ${sendToInnerSrc}
    return {
      mountInner: (html, sandboxValue, allowValue, colorScheme, mountMode, appliedCsp = "default-src 'none'", appliedCspMode = "widget-declared", cspIntent) =>
        mountInner(html, sandboxValue, allowValue, colorScheme, mountMode, appliedCsp, appliedCspMode, cspIntent),
      createInnerFrame,
      getInner: () => inner,
      getLastMount: () => lastMount,
      setInner: (frame) => { inner = frame; },
      sendToInner,
      markInnerReady,
      getDelivery: () => ({ innerReady, channelDead }),
      posted,
    };
    `,
  ) as (
    document: Document,
    window: unknown,
    posted: Array<[unknown, string]>,
    proxyInstanceId: string,
  ) => MountHarness;
  return {
    dom,
    h: factory(dom.window.document, win, posted, proxyInstanceId),
  };
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
      appliedCsp: "default-src 'none'",
      appliedCspMode: "widget-declared",
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
          type: "mcpjam:csp-applied",
          mountId: "proxy-a:1",
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
      [
        {
          type: "mcpjam:view-mode",
          mountId: "proxy-a:1",
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
      [
        {
          type: "mcpjam:csp-applied",
          mountId: "proxy-a:1",
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
      [
        {
          type: "mcpjam:view-mode",
          mountId: "proxy-a:1",
          mode: "srcdoc",
          url: "about:srcdoc",
        },
        "*",
      ],
    ]);
  });

  it("reports the pre-injection CSP intent with the same mount id", () => {
    const { h } = harness();
    const intent = {
      csp: { frameDomains: ["https://js.stripe.com"] },
      permissive: false,
    };
    h.mountInner(
      WIDGET,
      "allow-same-origin allow-scripts",
      "",
      "light",
      undefined,
      "frame-src https://js.stripe.com",
      "widget-declared",
      intent,
    );

    expect(h.posted[0][0]).toEqual({
      type: "mcpjam:csp-applied",
      mountId: "proxy-a:1",
      csp: "frame-src https://js.stripe.com",
      mode: "widget-declared",
      intent,
    });
  });

  it("echoes client restrictions from the real resource-ready handler", () => {
    const dom = new JSDOM(
      html.replace(
        '"__MCPJAM_HOST_ORIGINS__"',
        JSON.stringify(["http://localhost:6274"]),
      ),
      {
        url: "http://localhost:6274/api/apps/mcp-apps/sandbox-proxy",
        runScripts: "dangerously",
      },
    );
    try {
      const posted: [unknown, unknown][] = [];
      dom.window.postMessage = (data: unknown, targetOrigin: unknown) => {
        posted.push([data, targetOrigin]);
      };
      const csp = { resourceDomains: ["https://assets.example"] };
      const cspSubtypePolicy = { cspResourceDomains: { image: false } };
      const clientContext = {
        clientName: "Goose",
        declaredCsp: csp,
        capabilities: {
          cspResourceDomains: { image: false },
          cspFrameDomains: false,
          cspBaseUriDomains: false,
        },
      };
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "http://localhost:6274",
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/sandbox-resource-ready",
            params: {
              html: WIDGET,
              csp,
              cspSubtypePolicy,
              clientContext,
              permissive: false,
            },
          },
        }),
      );
      const applied = posted.find(
        ([data]) => (data as { type?: string }).type === "mcpjam:csp-applied",
      );
      expect(applied?.[1]).toBe("http://localhost:6274");
      expect(applied?.[0]).toEqual(
        expect.objectContaining({
          intent: { csp, cspSubtypePolicy, clientContext, permissive: false },
          csp: expect.stringContaining("img-src data: blob:"),
        }),
      );
    } finally {
      dom.window.close();
    }
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

describe("sandbox-proxy opaque mount (claude.ai)", () => {
  // jsdom cannot give a frame an opaque origin or render srcdoc, so the
  // view's window is stubbed and its `load` fired by hand; what is under test
  // is the proxy's mount and delivery rules.
  function stubViewWindow(frame: HTMLIFrameElement) {
    const sent: Array<[unknown, string]> = [];
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get: () => ({
        postMessage: (data: unknown, target: string) => sent.push([data, target]),
      }),
    });
    return sent;
  }
  function fireLoad(frame: HTMLIFrameElement) {
    frame.dispatchEvent(new frame.ownerDocument.defaultView!.Event("load"));
  }
  const CLAUDE_SANDBOX = "allow-forms allow-scripts";

  it("sets srcdoc before insertion and reports a view with no URL", () => {
    const { dom, h } = harness();
    const body = dom.window.document.body;
    const seen: Array<{ sandbox: string | null; srcdoc: string | null }> = [];
    const realAppend = body.appendChild.bind(body);
    vi.spyOn(body, "appendChild").mockImplementation((node: Node) => {
      const el = node as HTMLIFrameElement;
      seen.push({
        sandbox: el.getAttribute("sandbox"),
        srcdoc: el.getAttribute("srcdoc"),
      });
      return realAppend(node);
    });

    const mode = h.mountInner(
      WIDGET,
      CLAUDE_SANDBOX,
      "fullscreen *",
      "light",
      "opaque",
    );

    expect(mode).toBe("opaque");
    expect(seen).toEqual([{ sandbox: CLAUDE_SANDBOX, srcdoc: WIDGET }]);
    expect(h.getInner()!.getAttribute("allow")).toBe("fullscreen *");
    expect(h.getLastMount()!.mountMode).toBe("opaque");
    expect(h.posted[1]).toEqual([
      {
        type: "mcpjam:view-mode",
        mountId: "proxy-a:1",
        mode: "opaque",
        url: "about:srcdoc",
      },
      "*",
    ]);
  });

  it("holds host messages until the view's first load, then delivers them in order", () => {
    const { h } = harness();
    h.mountInner(WIDGET, CLAUDE_SANDBOX, "", "light", "opaque");
    const sent = stubViewWindow(h.getInner()!);

    h.sendToInner({ n: 1 });
    h.sendToInner({ n: 2 });
    expect(sent).toEqual([]);

    fireLoad(h.getInner()!);
    expect(sent).toEqual([
      [{ n: 1 }, "*"],
      [{ n: 2 }, "*"],
    ]);

    h.sendToInner({ n: 3 });
    expect(sent).toHaveLength(3);
  });

  it("delivers as soon as the view sends its first message", () => {
    const { h } = harness();
    h.mountInner(WIDGET, CLAUDE_SANDBOX, "", "light", "opaque");
    const sent = stubViewWindow(h.getInner()!);
    h.sendToInner({ n: 1 });
    // The relay calls this for any message from the current view.
    h.markInnerReady();
    expect(sent).toEqual([[{ n: 1 }, "*"]]);
  });

  it("stops waiting after 5 seconds when the view never loads", () => {
    vi.useFakeTimers();
    try {
      const { h } = harness();
      h.mountInner(WIDGET, CLAUDE_SANDBOX, "", "light", "opaque");
      const sent = stubViewWindow(h.getInner()!);
      h.sendToInner({ n: 1 });
      vi.advanceTimersByTime(4999);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent).toEqual([[{ n: 1 }, "*"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops delivering once the view navigates itself", () => {
    const { h } = harness();
    h.mountInner(WIDGET, CLAUDE_SANDBOX, "", "light", "opaque");
    const sent = stubViewWindow(h.getInner()!);
    fireLoad(h.getInner()!);
    fireLoad(h.getInner()!);
    expect(h.getDelivery()).toEqual({ innerReady: false, channelDead: true });
    h.sendToInner({ n: 1 });
    h.markInnerReady();
    expect(sent).toEqual([]);
  });

  it("starts a fresh channel on the next mount", () => {
    const { h } = harness();
    h.mountInner(WIDGET, CLAUDE_SANDBOX, "", "light", "opaque");
    fireLoad(h.getInner()!);
    fireLoad(h.getInner()!);
    h.mountInner(WIDGET, CLAUDE_SANDBOX, "", "light", "opaque");
    expect(h.getDelivery()).toEqual({ innerReady: false, channelDead: false });
  });

  it("keeps delivering at once on a written mount", () => {
    const { h } = harness();
    h.mountInner(WIDGET, "allow-same-origin allow-scripts", "", "light");
    const sent = stubViewWindow(h.getInner()!);
    h.sendToInner({ n: 1 });
    expect(sent).toEqual([[{ n: 1 }, "*"]]);
  });

  it("mounts claude.ai's exact frame from a real resource-ready", () => {
    const dom = new JSDOM(
      html.replace(
        '"__MCPJAM_HOST_ORIGINS__"',
        JSON.stringify(["http://localhost:6274"]),
      ),
      {
        url: "http://localhost:6274/api/apps/mcp-apps/sandbox-proxy",
        runScripts: "dangerously",
      },
    );
    try {
      const posted: [unknown, unknown][] = [];
      dom.window.postMessage = (data: unknown, targetOrigin: unknown) => {
        posted.push([data, targetOrigin]);
      };
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window,
          origin: "http://localhost:6274",
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/sandbox-resource-ready",
            params: {
              html: WIDGET,
              // The renderer's legacy baseline still carries allow-same-origin;
              // the profile's tokens win, and the opaque mount drops it.
              sandbox: "allow-scripts allow-same-origin allow-forms",
              sandboxAttrs: ["allow-forms"],
              permissions: { clipboardWrite: {} },
              permissive: true,
              mountMode: "opaque",
            },
          },
        }),
      );
      const frames = dom.window.document.querySelectorAll("iframe");
      expect(frames).toHaveLength(1);
      expect(frames[0].getAttribute("sandbox")).toBe(CLAUDE_SANDBOX);
      expect(frames[0].getAttribute("allow")).toBe(
        "fullscreen *; clipboard-write *",
      );
      expect(frames[0].getAttribute("srcdoc")).toContain("<p id='w'>hi</p>");
      expect(
        posted.find(
          ([data]) => (data as { type?: string }).type === "mcpjam:view-mode",
        )?.[0],
      ).toEqual(expect.objectContaining({ mode: "opaque", url: "about:srcdoc" }));
    } finally {
      dom.window.close();
    }
  });
});

describe("sandbox-proxy inner sandbox and allow values", () => {
  const sandboxValue = new Function(
    "sandbox",
    "sandboxAttrs",
    "opaque",
    `${buildInnerSandboxValueSrc}\nreturn buildInnerSandboxValue(sandbox, sandboxAttrs, opaque);`,
  ) as (sandbox: unknown, sandboxAttrs: unknown, opaque: boolean) => string;
  const allowValue = new Function(
    "permissions",
    "opaque",
    `${buildAllowAttributeSrc}\n${buildInnerAllowValueSrc}\nreturn buildInnerAllowValue(permissions, opaque);`,
  ) as (permissions: unknown, opaque: boolean) => string;

  it("gives a same-origin view the mandatory tokens plus the profile's", () => {
    expect(sandboxValue(undefined, ["allow-forms"], false)).toBe(
      "allow-forms allow-same-origin allow-scripts",
    );
  });

  it("gives an opaque view claude.ai's exact tokens", () => {
    expect(sandboxValue(undefined, ["allow-forms"], true)).toBe(
      "allow-forms allow-scripts",
    );
  });

  it("drops allow-same-origin on the opaque mount wherever it came from", () => {
    expect(
      sandboxValue(undefined, ["allow-forms", "allow-same-origin"], true),
    ).toBe("allow-forms allow-scripts");
    expect(
      sandboxValue(
        "allow-scripts allow-same-origin allow-forms allow-popups",
        undefined,
        true,
      ),
    ).toBe("allow-forms allow-popups allow-scripts");
  });

  it("still rejects a token with internal whitespace", () => {
    expect(
      sandboxValue(undefined, ["allow-forms allow-popups"], false),
    ).toBe("allow-same-origin allow-scripts");
  });

  it("adds fullscreen * only on the opaque mount", () => {
    expect(allowValue({ clipboardWrite: {} }, false)).toBe("clipboard-write *");
    expect(allowValue({ clipboardWrite: {} }, true)).toBe(
      "fullscreen *; clipboard-write *",
    );
    expect(allowValue(undefined, true)).toBe("fullscreen *");
    expect(allowValue(undefined, false)).toBe("");
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
    expect(
      h.posted.filter(
        ([data]) => (data as { type?: string }).type === "mcpjam:csp-applied",
      ),
    ).toEqual([
      [
        {
          type: "mcpjam:csp-applied",
          mountId: "proxy-a:1",
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
      [
        {
          type: "mcpjam:csp-applied",
          mountId: "proxy-a:2",
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
    ]);
  });

  it("does not reuse mount ids when the whole proxy is recreated", () => {
    const firstProxy = harness("proxy-a").h;
    const secondProxy = harness("proxy-b").h;

    firstProxy.mountInner(
      WIDGET,
      "allow-same-origin allow-scripts",
      "",
      "light",
    );
    secondProxy.mountInner(
      WIDGET,
      "allow-same-origin allow-scripts",
      "",
      "light",
    );

    const firstApplied = firstProxy.posted[0][0] as { mountId: string };
    const secondApplied = secondProxy.posted[0][0] as { mountId: string };
    expect(firstApplied.mountId).toBe("proxy-a:1");
    expect(secondApplied.mountId).toBe("proxy-b:1");
    expect(firstApplied.mountId).not.toBe(secondApplied.mountId);
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

  it("stamps forwarded violations with the current mount id", () => {
    expect(html).toContain("? { ...data, mountId: currentMountId }");
  });

  it("routes host traffic through the delivery buffer", () => {
    const hostBranch = html.slice(
      html.indexOf('"ui/notifications/sandbox-color-scheme-changed"'),
      html.indexOf("} else if (event.source === inner.contentWindow)"),
    );
    expect(hostBranch).toContain("sendToInner(event.data);");
    expect(hostBranch).not.toContain("inner.contentWindow.postMessage");
  });

  it("marks the view ready on its first message, unless it navigated away", () => {
    const viewBranch = html.slice(
      html.indexOf("} else if (event.source === inner.contentWindow)"),
      html.indexOf('data.type === "mcp-apps:csp-violation"'),
    );
    const deadIdx = viewBranch.indexOf("if (channelDead) return;");
    const readyIdx = viewBranch.indexOf("markInnerReady();");
    expect(deadIdx).toBeGreaterThan(0);
    expect(readyIdx).toBeGreaterThan(deadIdx);
  });
});

describe("sandbox-proxy host-origin allowlist", () => {
  // The proxy loads untrusted HTML on request and relays that widget's
  // messages back out, so "who may post to this document" is a real gate,
  // not bookkeeping. Everything ambiguous has to fail closed.
  const allowed = new Function(
    "origin",
    "patterns",
    `${parseOriginPatternSrc}\n${hostOriginAllowedSrc}\nreturn hostOriginAllowed(origin, patterns);`,
  ) as (origin: string, patterns: string[] | null) => boolean;

  const parse = new Function(
    "pattern",
    `${parseOriginPatternSrc}\nreturn parseOriginPattern(pattern);`,
  ) as (pattern: string) => unknown;

  const HOSTED = ["https://app.mcpjam.com", "http://localhost:*"];

  it("accepts an exact origin", () => {
    expect(allowed("https://app.mcpjam.com", HOSTED)).toBe(true);
  });

  it("accepts any port when the pattern wildcards it", () => {
    expect(allowed("http://localhost:5173", HOSTED)).toBe(true);
    expect(allowed("http://localhost:6274", HOSTED)).toBe(true);
  });

  it("rejects a different scheme, host, or port", () => {
    expect(allowed("http://app.mcpjam.com", HOSTED)).toBe(false);
    expect(allowed("https://evil.com", HOSTED)).toBe(false);
    expect(allowed("https://app.mcpjam.com:8443", HOSTED)).toBe(false);
  });

  it("does not let a wildcard span a dot in the host", () => {
    // The danger a host wildcard would introduce: a pattern for mcpjam.com
    // matching an attacker-registered lookalike.
    expect(parse("https://*.mcpjam.com")).toBeNull();
    expect(allowed("https://evil-mcpjam.com", ["https://*mcpjam.com"])).toBe(
      false,
    );
  });

  it("treats a suffix or prefix of an allowed host as a different host", () => {
    expect(allowed("https://app.mcpjam.com.evil.test", HOSTED)).toBe(false);
    expect(allowed("https://notapp.mcpjam.com", HOSTED)).toBe(false);
  });

  it("matches a default port against a pattern that names none", () => {
    expect(allowed("https://app.mcpjam.com:443", HOSTED)).toBe(true);
  });

  it("fails closed on an opaque origin and on an empty list", () => {
    // A sandboxed document without allow-same-origin posts "null".
    expect(allowed("null", HOSTED)).toBe(false);
    expect(allowed("https://app.mcpjam.com", [])).toBe(false);
    expect(allowed("https://app.mcpjam.com", null)).toBe(false);
  });

  it("ignores unparsable patterns rather than widening on them", () => {
    expect(allowed("https://app.mcpjam.com", ["not-an-origin", "*"])).toBe(
      false,
    );
  });
});

describe("sandbox-proxy host-origin pinning (source contract)", () => {
  // The lock lives inline in the message listener rather than in a named
  // function, so pin its shape where it is: the gate must precede any
  // handling, and the inner→host relay must answer the locked origin.
  it("gates the parent branch before handling and locks the origin", () => {
    const branch = html.slice(
      html.indexOf("if (event.source === window.parent)"),
      html.indexOf(
        'event.data.method === "ui/notifications/sandbox-resource-ready"',
      ),
    );
    expect(branch).toContain(
      "hostOriginAllowed(event.origin, hostOriginPatterns)",
    );
    expect(branch).toContain("hostOrigin = event.origin");
    expect(branch).toContain("event.origin !== hostOrigin");
  });

  it("relays to the locked origin rather than any window", () => {
    expect(html).toContain(
      'window.parent.postMessage(outgoing, hostOrigin || "*")',
    );
    // And the boot handshake, which happens before any host message, is the
    // only postMessage that can still be unaddressed.
    expect(html).not.toContain('window.parent.postMessage(data, "*")');
  });
});
