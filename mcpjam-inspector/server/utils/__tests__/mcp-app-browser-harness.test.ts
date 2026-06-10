import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { build } from "esbuild";
import {
  McpAppBrowserHarness,
  ChromiumNotInstalledError,
  cspSourceMatchesUrl,
  injectCspMeta,
  type McpAppBrowserHarnessOptions,
} from "../mcp-app-browser-harness";

/**
 * Bundle a guest widget fixture (TS using the real ext-apps App SDK) into a
 * self-contained browser IIFE, then wrap it as widget HTML. Using the real
 * guest SDK exercises the actual ui/initialize handshake against the harness's
 * production host bridge.
 */
async function bundleGuest(source: string): Promise<string> {
  const r = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

function guestHtml(js: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${js}</script></body></html>`;
}

// A guest that completes the handshake and renders a clickable button whose
// center sits at the viewport center (640,400). Clicking it calls a server tool.
const BUTTON_GUEST_SRC = `
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-button", version: "1.0.0" });
(async () => {
  await app.connect();
  const b = document.createElement("button");
  b.id = "ok";
  b.textContent = "Reserve seat";
  b.style.cssText = "position:absolute;left:540px;top:370px;width:200px;height:60px;font-size:18px";
  b.addEventListener("click", () => {
    app.callServerTool({ name: "reserve", arguments: { seat: 12 } }).catch(() => {});
  });
  document.body.appendChild(b);
})();
`;

// A guest that completes the handshake but paints nothing -> blank_screenshot.
const BLANK_GUEST_SRC = `
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-blank", version: "1.0.0" });
app.connect().catch(() => {});
`;

// Plain HTML with no guest SDK: paints text but never handshakes -> bridge_timeout.
const STATIC_NO_BRIDGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><p style="font-size:24px;padding:20px">Static content, no bridge handshake</p></body></html>`;

let buttonHtml = "";
let blankHtml = "";

beforeAll(async () => {
  buttonHtml = guestHtml(await bundleGuest(BUTTON_GUEST_SRC));
  blankHtml = guestHtml(await bundleGuest(BLANK_GUEST_SRC));
}, 60_000);

const harnesses: McpAppBrowserHarness[] = [];
function makeHarness(
  overrides: Partial<McpAppBrowserHarnessOptions> = {}
): McpAppBrowserHarness & { calls: Array<{ name: string }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(
    async (_serverId: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    }
  );
  const h = new McpAppBrowserHarness({
    callTool,
    budgets: { renderTimeoutMs: 1200, settleTimeoutMs: 1200 },
    ...overrides,
  }) as McpAppBrowserHarness & { calls: typeof calls };
  h.calls = calls;
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  while (harnesses.length) {
    await harnesses.pop()!.dispose();
  }
});

describe("McpAppBrowserHarness — Chromium gating", () => {
  it("records browser_unavailable when Chromium is not installed", async () => {
    // Force the binary-missing path by overriding the launcher loader.
    class NoChromiumHarness extends McpAppBrowserHarness {
      protected async loadChromium() {
        return {
          executablePath: () => "/nonexistent/path/to/chromium",
          launch: async () => {
            throw new Error("should not launch");
          },
        } as never;
      }
    }
    const h = new NoChromiumHarness({
      callTool: async () => ({ content: [] }),
    });
    harnesses.push(h);
    const obs = await h.renderWidget({
      toolCallId: "tc-x",
      toolName: "show",
      serverId: "s1",
      html: "<html><body>hi</body></html>",
    });
    expect(obs.status).toBe("browser_unavailable");
    expect(ChromiumNotInstalledError).toBeTypeOf("function");
  });
});

describe("McpAppBrowserHarness — render classification", () => {
  it("classifies a handshaking, painting widget as rendered", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "tc-1",
      toolName: "show_seats",
      serverId: "s1",
      html: buttonHtml,
      resourceUri: "ui://widget/seats",
    });
    expect(obs.status).toBe("rendered");
    expect(obs.bridgeInitialized).toBe(true);
    expect(obs.screenshotBase64 && obs.screenshotBase64.length).toBeGreaterThan(
      0
    );
    // screenshot within the byte budget (256 KiB default).
    const bytes = Buffer.from(obs.screenshotBase64!, "base64").byteLength;
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
  }, 30_000);

  it("classifies static HTML that never handshakes as bridge_timeout", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "tc-2",
      toolName: "static",
      serverId: "s1",
      html: STATIC_NO_BRIDGE_HTML,
    });
    expect(obs.status).toBe("bridge_timeout");
    expect(obs.bridgeInitialized).toBe(false);
  }, 30_000);

  it("classifies a handshaking-but-empty widget as blank_screenshot", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "tc-3",
      toolName: "blank",
      serverId: "s1",
      html: blankHtml,
    });
    expect(obs.status).toBe("blank_screenshot");
    expect(obs.bridgeInitialized).toBe(true);
  }, 30_000);

  it("tears down a non-kept widget before mounting the next one", async () => {
    const h = makeHarness();
    // First widget rendered without keepMounted -> must be torn down in-page.
    const first = await h.renderWidget({
      toolCallId: "seq-1",
      toolName: "first",
      serverId: "s1",
      html: buttonHtml,
    });
    expect(first.status).toBe("rendered");
    expect(h.hasRenderedWidget()).toBe(false);

    // A second render in the same page mounts cleanly (prior bridge disposed).
    const second = await h.renderWidget({
      toolCallId: "seq-2",
      toolName: "second",
      serverId: "s1",
      html: buttonHtml,
      keepMounted: true,
    });
    expect(second.status).toBe("rendered");
    expect(h.hasRenderedWidget()).toBe(true);
  }, 30_000);

  it("reports screenshot_failed when the frame can't fit the byte budget", async () => {
    // A 1-byte cap is unsatisfiable even at the lowest JPEG quality, so
    // captureScreenshot throws and the render fails closed rather than emit an
    // oversized image.
    const h = makeHarness({
      budgets: {
        renderTimeoutMs: 1200,
        settleTimeoutMs: 600,
        screenshotMaxBytes: 1,
      },
    });
    const obs = await h.renderWidget({
      toolCallId: "tiny-1",
      toolName: "show_seats",
      serverId: "flights",
      html: buttonHtml,
      keepMounted: true,
    });
    expect(obs.status).toBe("screenshot_failed");
    expect(obs.screenshotBase64).toBeUndefined();
    // A failed render is not kept mounted.
    expect(h.getMountedWidgetId()).toBeNull();
    expect(h.hasRenderedWidget()).toBe(false);
  }, 30_000);
});

describe("McpAppBrowserHarness — interaction", () => {
  it("dispatches a widget-initiated tools/call from a click", async () => {
    const h = makeHarness();
    const render = await h.renderWidget({
      toolCallId: "tc-int",
      toolName: "show_seats",
      serverId: "flights",
      html: buttonHtml,
      keepMounted: true,
    });
    expect(render.status).toBe("rendered");
    expect(h.hasRenderedWidget()).toBe(true);

    const result = await h.executeAction({
      toolCallId: "tc-int",
      action: { action: "left_click", coordinate: [640, 400] },
    });

    expect(result.widgetToolCalls.length).toBe(1);
    expect(result.widgetToolCalls[0]).toMatchObject({
      name: "reserve",
      ok: true,
    });
    expect(
      result.screenshotBase64 && result.screenshotBase64.length
    ).toBeGreaterThan(0);
    // dispatched through the injected callTool with the widget's serverId.
    expect(h.calls).toEqual([{ name: "reserve", args: { seat: 12 } }]);
  }, 30_000);

  it("returns 'no_rendered_widget' when acting on an unmounted tool call", async () => {
    const h = makeHarness();
    // Launch via a cheap render so the page exists, but don't keep it mounted.
    await h.renderWidget({
      toolCallId: "tc-gone",
      toolName: "show",
      serverId: "s1",
      html: blankHtml,
    });
    const result = await h.executeAction({
      toolCallId: "tc-gone",
      action: { action: "screenshot" },
    });
    expect(result.note).toBe("no_rendered_widget");
    expect(result.widgetToolCalls).toEqual([]);
  }, 30_000);

  it("drops the prior kept widget's mount on a second kept render", async () => {
    const h = makeHarness();
    await h.renderWidget({
      toolCallId: "kept-1",
      toolName: "first",
      serverId: "s1",
      html: buttonHtml,
      keepMounted: true,
    });
    await h.renderWidget({
      toolCallId: "kept-2",
      toolName: "second",
      serverId: "s1",
      html: buttonHtml,
      keepMounted: true,
    });
    // The page shows only kept-2 now; acting on kept-1 must NOT drive it.
    const stale = await h.executeAction({
      toolCallId: "kept-1",
      action: { action: "left_click", coordinate: [640, 400] },
    });
    expect(stale.note).toBe("no_rendered_widget");
    // kept-2 is the live widget.
    const live = await h.executeAction({
      toolCallId: "kept-2",
      action: { action: "left_click", coordinate: [640, 400] },
    });
    expect(live.widgetToolCalls.map((c) => c.name)).toEqual(["reserve"]);
  }, 30_000);

  it("force-dismisses the widget once the per-widget step cap is reached", async () => {
    const h = makeHarness({
      budgets: {
        renderTimeoutMs: 1200,
        settleTimeoutMs: 600,
        maxBrowserStepsPerWidget: 1,
      },
    });
    const render = await h.renderWidget({
      toolCallId: "cap-1",
      toolName: "show_seats",
      serverId: "flights",
      html: buttonHtml,
      keepMounted: true,
    });
    expect(render.status).toBe("rendered");
    // getMountedWidgetId is the single source of truth for the live widget.
    expect(h.getMountedWidgetId()).toBe("cap-1");

    // First action consumes the only allowed step.
    const first = await h.executeAction({
      toolCallId: "cap-1",
      action: { action: "left_click", coordinate: [640, 400] },
    });
    expect(first.note).toBeUndefined();

    // Second action is over the step cap -> force-dismiss + distinct note.
    const second = await h.executeAction({
      toolCallId: "cap-1",
      action: { action: "screenshot" },
    });
    expect(second.note).toBe("step_budget_exceeded");
    // The widget is torn down: no longer live, and further actions no-op.
    expect(h.getMountedWidgetId()).toBeNull();
    expect(h.hasRenderedWidget()).toBe(false);
    const third = await h.executeAction({
      toolCallId: "cap-1",
      action: { action: "screenshot" },
    });
    expect(third.note).toBe("no_rendered_widget");
  }, 30_000);
});

describe("cspSourceMatchesUrl — CSP host-source matching", () => {
  const u = (s: string) => new URL(s);

  it("matches exact origins and rejects scheme/host mismatches", () => {
    expect(
      cspSourceMatchesUrl("https://esm.sh", u("https://esm.sh/react"))
    ).toBe(true);
    expect(
      cspSourceMatchesUrl("https://esm.sh", u("http://esm.sh/react"))
    ).toBe(false);
    expect(
      cspSourceMatchesUrl("https://esm.sh", u("https://evil.sh/react"))
    ).toBe(false);
  });

  it("matches wildcard subdomains but not the bare apex", () => {
    const src = "https://*.excalidraw.com";
    expect(
      cspSourceMatchesUrl(src, u("https://cdn.excalidraw.com/a.woff2"))
    ).toBe(true);
    expect(cspSourceMatchesUrl(src, u("https://a.b.excalidraw.com/x"))).toBe(
      true
    );
    expect(cspSourceMatchesUrl(src, u("https://excalidraw.com/x"))).toBe(false);
    expect(cspSourceMatchesUrl(src, u("https://notexcalidraw.com/x"))).toBe(
      false
    );
  });

  it("scheme-less host-sources match http(s)/ws(s) on that host only", () => {
    expect(cspSourceMatchesUrl("esm.sh", u("https://esm.sh/x"))).toBe(true);
    expect(cspSourceMatchesUrl("esm.sh", u("http://esm.sh/x"))).toBe(true);
    expect(cspSourceMatchesUrl("esm.sh", u("wss://esm.sh/socket"))).toBe(true);
    expect(cspSourceMatchesUrl("esm.sh", u("ftp://esm.sh/x"))).toBe(false);
    expect(cspSourceMatchesUrl("esm.sh", u("https://other.sh/x"))).toBe(false);
  });

  it("scheme-only sources allow any host on that scheme", () => {
    expect(cspSourceMatchesUrl("https:", u("https://anything.example/x"))).toBe(
      true
    );
    expect(cspSourceMatchesUrl("https:", u("http://anything.example/x"))).toBe(
      false
    );
  });

  it("honors ports (explicit, wildcard, and scheme defaults)", () => {
    expect(
      cspSourceMatchesUrl("https://cdn.x.io:8443", u("https://cdn.x.io:8443/a"))
    ).toBe(true);
    expect(
      cspSourceMatchesUrl("https://cdn.x.io:8443", u("https://cdn.x.io/a"))
    ).toBe(false);
    expect(
      cspSourceMatchesUrl("https://cdn.x.io:443", u("https://cdn.x.io/a"))
    ).toBe(true);
    expect(
      cspSourceMatchesUrl("https://cdn.x.io:*", u("https://cdn.x.io:9999/a"))
    ).toBe(true);
  });

  it("treats an omitted source port as the scheme default only (not any port)", () => {
    // CSP: a source without a port matches only the URL scheme's default port.
    expect(
      cspSourceMatchesUrl(
        "https://api.example.com",
        u("https://api.example.com/x")
      )
    ).toBe(true);
    expect(
      cspSourceMatchesUrl(
        "https://api.example.com",
        u("https://api.example.com:443/x")
      )
    ).toBe(true);
    expect(
      cspSourceMatchesUrl(
        "https://api.example.com",
        u("https://api.example.com:8443/x")
      )
    ).toBe(false);
    // http default is 80.
    expect(cspSourceMatchesUrl("http://h.io", u("http://h.io/x"))).toBe(true);
    expect(cspSourceMatchesUrl("http://h.io", u("http://h.io:8080/x"))).toBe(
      false
    );
  });

  it("ignores paths in host-sources (origin-granular gate)", () => {
    expect(
      cspSourceMatchesUrl(
        "https://cdn.x.io/assets/",
        u("https://cdn.x.io/other/file.js")
      )
    ).toBe(true);
  });

  it("never matches quoted keywords or empty sources", () => {
    expect(cspSourceMatchesUrl("'self'", u("https://esm.sh/x"))).toBe(false);
    expect(cspSourceMatchesUrl("'unsafe-inline'", u("https://esm.sh/x"))).toBe(
      false
    );
    expect(cspSourceMatchesUrl("", u("https://esm.sh/x"))).toBe(false);
  });
});

describe("injectCspMeta", () => {
  it("inserts the policy as the first child of <head>", () => {
    const out = injectCspMeta(
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
      "default-src 'self'"
    );
    expect(out).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'">`
    );
    // Must precede any resource-bearing tag it governs.
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(
      out.indexOf("<title>")
    );
  });

  it("synthesizes a <head> when the document omits one", () => {
    expect(
      injectCspMeta("<html><body>x</body></html>", "default-src 'none'")
    ).toContain(
      `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head>`
    );
    // No <html> at all: prepend so document.write still parses it first.
    expect(injectCspMeta("<p>x</p>", "default-src 'none'")).toBe(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p>x</p>`
    );
  });

  it("escapes attribute-breaking chars so widget metadata can't corrupt the policy", () => {
    // A `"` in widget-derived CSP content must not break out of content="…"
    // and truncate/disable the injected policy (or inject sibling markup).
    const out = injectCspMeta(
      "<!doctype html><html><head></head><body></body></html>",
      `connect-src 'self' https://x"></head><script>alert(1)</script>`
    );
    expect(out).not.toContain(`x"></head>`); // no real breakout
    expect(out).not.toContain("<script>alert(1)</script>"); // not injected as markup
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Single quotes are valid inside a double-quoted attribute -> left as-is.
    expect(out).toContain("connect-src 'self'");
  });
});

describe("McpAppBrowserHarness — widget-declared CSP enforcement", () => {
  // Guest that probes three origins via fetch (a connect-src concern) the
  // instant it parses — before the bridge — so the injected <meta> CSP (first
  // in <head>) governs them. `.invalid` is a reserved TLD (RFC 2606): a
  // CSP-allowed probe leaves the machine and merely fails DNS, while a
  // CSP-blocked probe never makes a network attempt and logs a violation.
  const PROBE_GUEST_SRC = `
fetch("https://conn-ok.invalid/a").catch(() => {});
fetch("https://res-only.invalid/b").catch(() => {});
fetch("https://nope.invalid/c").catch(() => {});
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-csp", version: "1.0.0" });
(async () => {
  await app.connect();
  const d = document.createElement("div");
  d.textContent = "csp fixture";
  d.style.cssText = "font-size:32px;padding:40px";
  document.body.appendChild(d);
})();
`;

  // Single-origin probe used for the undeclared-default and reset cases.
  const ONE_PROBE_GUEST_SRC = `
fetch("https://anywhere.invalid/x").catch(() => {});
import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "fixture-csp1", version: "1.0.0" });
(async () => {
  await app.connect();
  const d = document.createElement("div");
  d.textContent = "csp1 fixture";
  d.style.cssText = "font-size:32px;padding:40px";
  document.body.appendChild(d);
})();
`;

  let probeHtml = "";
  let oneProbeHtml = "";
  beforeAll(async () => {
    probeHtml = guestHtml(await bundleGuest(PROBE_GUEST_SRC));
    oneProbeHtml = guestHtml(await bundleGuest(ONE_PROBE_GUEST_SRC));
  }, 60_000);

  it("enforces directive separation: fetch obeys connect_domains, not resource_domains", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "csp-1",
      toolName: "show_widget",
      serverId: "srv",
      html: probeHtml,
      cspMeta: {
        connect_domains: ["https://conn-ok.invalid"],
        resource_domains: ["https://res-only.invalid"],
      },
    });
    expect(obs.status).toBe("rendered");
    const errs = (obs.consoleErrors ?? []).join("\n");
    // The "Refused to connect to '<url>'" prefix names the BLOCKED url itself
    // (so it can't be confused with conn-ok appearing in the echoed directive).
    expect(errs).toMatch(/Connecting to 'https:\/\/res-only\.invalid/);
    expect(errs).toMatch(/Connecting to 'https:\/\/nope\.invalid/);
    // connect_domains origin is permitted by connect-src -> no CSP violation.
    expect(errs).not.toMatch(/Connecting to 'https:\/\/conn-ok\.invalid/);
  }, 30_000);

  it("policies undeclared widgets with the SEP restrictive default", async () => {
    const h = makeHarness();
    const obs = await h.renderWidget({
      toolCallId: "csp-default",
      toolName: "show_widget",
      serverId: "srv",
      html: oneProbeHtml,
      // no cspMeta -> widget-declared default: connect-src 'self' + loopback.
    });
    expect(obs.status).toBe("rendered");
    const errs = (obs.consoleErrors ?? []).join("\n");
    expect(errs).toMatch(/Connecting to 'https:\/\/anywhere\.invalid/);
  }, 30_000);

  it("re-derives the policy per widget: a later undeclared widget loses the grant", async () => {
    const h = makeHarness();
    const first = await h.renderWidget({
      toolCallId: "csp-2a",
      toolName: "show_widget",
      serverId: "srv",
      html: oneProbeHtml,
      cspMeta: { connect_domains: ["https://anywhere.invalid"] },
    });
    expect(first.status).toBe("rendered");
    expect((first.consoleErrors ?? []).join("\n")).not.toMatch(
      /Connecting to 'https:\/\/anywhere\.invalid/
    );

    // Same harness, same probe — but THIS widget declares nothing, so the
    // injected CSP reverts to the restrictive default and blocks the fetch.
    const second = await h.renderWidget({
      toolCallId: "csp-2b",
      toolName: "show_widget",
      serverId: "srv",
      html: oneProbeHtml,
    });
    expect(second.status).toBe("rendered");
    expect((second.consoleErrors ?? []).join("\n")).toMatch(
      /Connecting to 'https:\/\/anywhere\.invalid/
    );
  }, 45_000);
});
