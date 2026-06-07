/**
 * host-page.ts — page-side MCP Apps host runtime for the eval browser harness.
 *
 * This module is esbuild-bundled into a browser IIFE (see
 * `scripts/bundle-browser-harness.mjs`) and injected into the Playwright page
 * by `mcp-app-browser-harness.ts`. It runs the REAL production host bridge
 * (PR 1's `host-app-bridge.ts`) inside the page so a widget mounts and
 * handshakes exactly as it would in the live renderer — the eval harness gets
 * a faithful "did it render?" signal rather than an inert HTML snapshot.
 *
 * Division of labor:
 *   - PAGE (this module): mount the widget iframe, run the host AppBridge,
 *     complete the `ui/initialize` handshake, deliver tool input/result, and
 *     funnel app->host `tools/call` to Node via the `__mcpjamHostRpc` binding.
 *   - NODE (`mcp-app-browser-harness.ts`): Playwright lifecycle, screenshots,
 *     mouse/keyboard actions, byte budgets, classification, and the actual
 *     MCPClientManager dispatch behind `__mcpjamHostRpc`.
 *
 * Mount ordering: the host bridge MUST be listening before the guest's scripts
 * run, or the guest's `ui/initialize` request races ahead of the host and the
 * handshake never completes. We mount a blank iframe, connect the host bridge
 * to its (stable) contentWindow, THEN write the widget HTML into the same
 * document via `document.write` — which keeps the same contentWindow (unlike
 * re-assigning `srcdoc`, which navigates to a fresh window the captured
 * transport would no longer reach). This requires the sandbox to allow
 * same-origin (the default); the harness records `mount_failed` otherwise.
 */

import {
  createHostAppBridge,
  registerHostBridgeHandlers,
  resolveIframeSandboxPolicy,
} from "@/components/chat-v2/thread/mcp-apps/host-app-bridge";
import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const WIDGET_ROOT_ID = "mcpjam-widget-root";

export interface HostPageRenderOptions {
  widgetId: string;
  /** Widget resource HTML (already OpenAI-compat-injected by Node if needed). */
  html: string;
  /** Resolved host capabilities advertised in ui/initialize. */
  hostCapabilities: Record<string, unknown>;
  hostInfo: { name: string; version: string };
  /** SEP-1865 sandbox inputs; resolved to sandbox=/allow= here. */
  permissions?: Record<string, unknown>;
  sandboxAttrs?: string[];
  allowFeatures?: Record<string, string>;
  /** Tool input/output delivered to the widget after the handshake. */
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  /** Max wait for ui/initialize before reporting bridge_timeout. */
  renderTimeoutMs: number;
}

export interface HostPageRenderResult {
  mounted: boolean;
  bridgeInitialized: boolean;
  /** Structural blankness: the mounted document painted no visible content. */
  blank: boolean;
  mountError?: string;
}

interface ActiveWidget {
  iframe: HTMLIFrameElement;
  dispose: () => void;
}

const activeWidgets = new Map<string, ActiveWidget>();

declare global {
  interface Window {
    /** exposeBinding installed by Node: dispatches app->host tools/call. */
    __mcpjamHostRpc?: (payload: {
      widgetId: string;
      name: string;
      args: Record<string, unknown>;
    }) => Promise<{ result?: unknown; error?: string }>;
    __mcpjamHarness: {
      renderWidget: (
        opts: HostPageRenderOptions,
      ) => Promise<HostPageRenderResult>;
      dismissWidget: (widgetId: string) => boolean;
      isBlank: (widgetId: string) => boolean;
    };
  }
}

function ensureRoot(): HTMLElement {
  let root = document.getElementById(WIDGET_ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = WIDGET_ROOT_ID;
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.margin = "0";
    document.body.appendChild(root);
  }
  return root;
}

/** Structural blank check: no rendered text and no painted element box.
 *  Uses `innerText` (rendered text only) — NOT `textContent`, which would
 *  include the widget's own inline <script> source and never look blank. */
function isDocumentBlank(doc: Document | null | undefined): boolean {
  if (!doc || !doc.body) return true;
  const text = (doc.body.innerText ?? "").trim();
  if (text.length > 0) return false;
  // Any non-script element with a non-trivial layout box counts as painted.
  const els = doc.body.querySelectorAll(
    "*:not(script):not(style):not(meta):not(link):not(title)",
  );
  for (const el of Array.from(els)) {
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) return false;
  }
  return true;
}

async function renderWidget(
  opts: HostPageRenderOptions,
): Promise<HostPageRenderResult> {
  // Resolve the outer iframe sandbox attributes with the SAME builder the
  // production SandboxedIframe uses (PR 1), so the grant surface matches.
  const policy = resolveIframeSandboxPolicy({
    sandboxAttrs: opts.sandboxAttrs,
    permissions: opts.permissions as never,
    allowFeatures: opts.allowFeatures,
  });

  // Only one widget is visible per page (we replaceChildren below). Dispose any
  // previously-mounted widgets first so their host bridges are closed and their
  // map entries cleared, rather than orphaning bridges on a repeat render.
  for (const id of Array.from(activeWidgets.keys())) {
    if (id !== opts.widgetId) dismissWidget(id);
  }
  dismissWidget(opts.widgetId);

  const root = ensureRoot();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", policy.sandbox);
  if (policy.allow) iframe.setAttribute("allow", policy.allow);
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.background = "#ffffff";
  // Blank doc first so the host can attach its transport before the guest runs.
  iframe.srcdoc = "<!doctype html><html><head></head><body></body></html>";
  root.replaceChildren(iframe);

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    iframe.addEventListener("load", finish, { once: true });
    // about:srcdoc loads ~immediately; guard against a missed load event.
    setTimeout(finish, 500);
  });

  const guestWindow = iframe.contentWindow;
  const guestDoc = iframe.contentDocument;
  if (!guestWindow || !guestDoc) {
    return {
      mounted: false,
      bridgeInitialized: false,
      blank: true,
      mountError:
        "iframe contentWindow/contentDocument unavailable (sandbox missing allow-same-origin?)",
    };
  }

  let initialized = false;
  const bridge = createHostAppBridge({
    hostInfo: opts.hostInfo,
    hostCapabilities: opts.hostCapabilities as never,
    sandbox: {},
    hostContext: {},
  });

  registerHostBridgeHandlers(bridge, {
    effectiveHostCapabilities: opts.hostCapabilities as never,
    getToolCallId: () => opts.widgetId,
    callbacks: {
      onAppInitialized: (b) => {
        initialized = true;
        // Deliver tool data so data-driven widgets actually paint.
        if (opts.toolInput) {
          void b.sendToolInput({ arguments: opts.toolInput }).catch(() => {});
        }
        if (opts.toolOutput !== undefined) {
          void b.sendToolResult(opts.toolOutput as never).catch(() => {});
        }
      },
      onCallTool: async (name, args) => {
        const rpc = window.__mcpjamHostRpc;
        if (!rpc) throw new Error("host RPC binding not installed");
        const out = await rpc({ widgetId: opts.widgetId, name, args });
        if (out.error) throw new Error(out.error);
        return out.result as never;
      },
    },
  });

  const transport = new PostMessageTransport(guestWindow, guestWindow);
  try {
    await bridge.connect(transport);
  } catch (err) {
    // Not yet registered in activeWidgets; remove the iframe so it doesn't
    // linger in the DOM.
    iframe.remove();
    return {
      mounted: false,
      bridgeInitialized: false,
      blank: true,
      mountError: err instanceof Error ? err.message : String(err),
    };
  }

  // Host is now listening. Write the widget HTML into the SAME document so the
  // guest's scripts execute against a host that's already connected.
  try {
    guestDoc.open();
    guestDoc.write(opts.html);
    guestDoc.close();
  } catch (err) {
    // Close the connected bridge + drop the iframe so this failed render
    // doesn't leave an orphaned host bridge running.
    void bridge.close?.().catch?.(() => {});
    iframe.remove();
    return {
      mounted: false,
      bridgeInitialized: false,
      blank: true,
      mountError: err instanceof Error ? err.message : String(err),
    };
  }

  activeWidgets.set(opts.widgetId, {
    iframe,
    dispose: () => {
      void bridge.close?.().catch?.(() => {});
      iframe.remove();
    },
  });

  // Wait for the handshake or the render timeout.
  const start = Date.now();
  while (!initialized && Date.now() - start < opts.renderTimeoutMs) {
    await new Promise((r) => setTimeout(r, 30));
  }

  return {
    mounted: true,
    bridgeInitialized: initialized,
    blank: isDocumentBlank(iframe.contentDocument),
  };
}

function dismissWidget(widgetId: string): boolean {
  const w = activeWidgets.get(widgetId);
  if (!w) return false;
  w.dispose();
  activeWidgets.delete(widgetId);
  return true;
}

function isBlank(widgetId: string): boolean {
  const w = activeWidgets.get(widgetId);
  if (!w) return true;
  return isDocumentBlank(w.iframe.contentDocument);
}

window.__mcpjamHarness = { renderWidget, dismissWidget, isBlank };
