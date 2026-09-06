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
const parseOriginPatternSrc = extract("parseOriginPattern");
const hostOriginAllowedSrc = extract("hostOriginAllowed");

interface MountHarness {
  mountInner: (
    html: string,
    sandboxValue: string,
    allowValue: string,
    colorScheme: unknown,
    mountMode?: "write" | "srcdoc",
    appliedCsp?: string,
    appliedCspMode?: "permissive" | "widget-declared",
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
    let mountSequence = 0;
    let currentMountId = null;
    let lastMount = null;
    // Pinning is off in this harness; the view-mode post falls back to "*".
    let hostOrigin = null;
    ${applyColorSchemeSrc}
    ${createInnerFrameSrc}
    ${mountInnerSrc}
    ${remountLastSrc}
    return {
      mountInner: (html, sandboxValue, allowValue, colorScheme, mountMode, appliedCsp = "default-src 'none'", appliedCspMode = "widget-declared") =>
        mountInner(html, sandboxValue, allowValue, colorScheme, mountMode, appliedCsp, appliedCspMode),
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
          mountId: 1,
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
      [
        {
          type: "mcpjam:view-mode",
          mountId: 1,
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
          mountId: 1,
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
      [
        {
          type: "mcpjam:view-mode",
          mountId: 1,
          mode: "srcdoc",
          url: "about:srcdoc",
        },
        "*",
      ],
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
    expect(
      h.posted.filter(
        ([data]) => (data as { type?: string }).type === "mcpjam:csp-applied",
      ),
    ).toEqual([
      [
        {
          type: "mcpjam:csp-applied",
          mountId: 1,
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
      [
        {
          type: "mcpjam:csp-applied",
          mountId: 2,
          csp: "default-src 'none'",
          mode: "widget-declared",
        },
        "*",
      ],
    ]);
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
