/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * OpenAI Compatibility Runtime for MCP Apps (SEP-1865)
 *
 * This IIFE creates a `window.openai` object inside MCP App sandboxed iframes,
 * providing ChatGPT-compatible API methods that route through the existing
 * AppBridge JSON-RPC 2.0 handlers.
 *
 * Unlike the ChatGPT widget-runtime.ts (which uses custom message types like
 * "openai:callTool"), this runtime uses JSON-RPC 2.0 messages because
 * SandboxedIframe only passes through messages with `jsonrpc: "2.0"`.
 *
 * Config is read from a <script id="openai-compat-config"> DOM element.
 * No external imports — runs inside a sandboxed iframe.
 */

export {};

type OpenAICompatConfig = {
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  theme: string;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

declare global {
  interface Window {
    openai: any;
  }
}

(function bootstrap() {
  // Defensive: skip if already defined (e.g., ChatGPT widget-runtime ran first)
  if (window.openai) return;

  const CONFIG_ID = "openai-compat-config";

  const readConfig = (): OpenAICompatConfig | null => {
    try {
      const el = document.getElementById(CONFIG_ID);
      if (!el) {
        console.warn("[OpenAI Compat] Missing config element #" + CONFIG_ID);
        return null;
      }
      return JSON.parse(el.textContent || "{}") as OpenAICompatConfig;
    } catch (err) {
      console.error("[OpenAI Compat] Failed to parse config", err);
      return null;
    }
  };

  const config = readConfig();
  if (!config) return;

  const { toolId, toolName, toolInput, toolOutput, theme } = config;

  // JSON-RPC 2.0 call ID counter
  let callId = 0;

  // Pending calls awaiting responses (for callTool)
  const pendingCalls = new Map<number, PendingCall>();

  // Timeout for pending calls (30 seconds)
  const CALL_TIMEOUT_MS = 30_000;

  /**
   * Send a JSON-RPC 2.0 request (expects a response matched by id)
   */
  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
  ): { id: number } => {
    const id = ++callId;
    window.parent.postMessage(
      { jsonrpc: "2.0", id, method, params },
      "*",
    );
    return { id };
  };

  /**
   * Send a JSON-RPC 2.0 notification (fire-and-forget, no id)
   */
  const sendNotification = (
    method: string,
    params?: Record<string, unknown>,
  ): void => {
    window.parent.postMessage(
      { jsonrpc: "2.0", method, params: params ?? {} },
      "*",
    );
  };

  // ── Auto-height via ResizeObserver ──────────────────────────────────

  const postHeight = (() => {
    let lastHeight = 0;
    return (height: number) => {
      const rounded = Math.round(height);
      if (rounded <= 0 || rounded === lastHeight) return;
      lastHeight = rounded;
      sendNotification("ui/notifications/size-changed", {
        height: rounded,
      });
    };
  })();

  const measureAndNotifyHeight = () => {
    try {
      let contentHeight = 0;
      if (document.body) {
        const children = document.body.children;
        for (let i = 0; i < children.length; i++) {
          const child = children[i] as HTMLElement;
          if (child.tagName === "SCRIPT" || child.tagName === "STYLE") continue;
          const rect = child.getBoundingClientRect();
          const bottom = rect.top + rect.height + window.scrollY;
          contentHeight = Math.max(contentHeight, bottom);
        }
        const bodyStyle = window.getComputedStyle(document.body);
        contentHeight += parseFloat(bodyStyle.marginBottom) || 0;
        contentHeight += parseFloat(bodyStyle.paddingBottom) || 0;
      }
      if (contentHeight <= 0) {
        const docEl = document.documentElement;
        contentHeight = Math.max(
          docEl ? docEl.scrollHeight : 0,
          document.body ? document.body.scrollHeight : 0,
        );
      }
      postHeight(Math.ceil(contentHeight));
    } catch {
      // silent
    }
  };

  const setupAutoResize = () => {
    let scheduled = false;
    const scheduleMeasure = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        measureAndNotifyHeight();
      });
    };
    scheduleMeasure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(scheduleMeasure);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } else {
      window.addEventListener("resize", scheduleMeasure);
    }
    window.addEventListener("load", () => {
      requestAnimationFrame(measureAndNotifyHeight);
    });
  };

  // ── Build window.openai ────────────────────────────────────────────

  const openaiAPI = {
    toolInput: toolInput ?? {},
    toolOutput: toolOutput ?? null,
    theme: theme ?? "dark",
    displayMode: "inline",
    widgetState: null as unknown,

    /**
     * Call an MCP tool by name. Returns a Promise resolved when the
     * host sends back the JSON-RPC response with the matching id.
     */
    callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const { id } = sendRequest("tools/call", {
        name,
        arguments: args,
        _meta: {},
      });

      return new Promise((resolve, reject) => {
        pendingCalls.set(id, { resolve, reject });
        setTimeout(() => {
          if (pendingCalls.has(id)) {
            pendingCalls.delete(id);
            reject(new Error("Tool call timeout"));
          }
        }, CALL_TIMEOUT_MS);
      });
    },

    /**
     * Send a follow-up message to the host chat.
     * Uses sendRequest (not notification) because ui/message is a JSON-RPC
     * request in the MCP Apps spec — the AppBridge only dispatches requests
     * (messages with an id) to its onmessage handler.
     */
    sendFollowUpMessage(opts: unknown): void {
      const prompt = typeof opts === "string" ? opts : (opts as any)?.prompt ?? "";
      sendRequest("ui/message", {
        role: "user",
        content: [{ type: "text", text: prompt }],
      });
    },

    /**
     * Alias for sendFollowUpMessage (ChatGPT compat).
     */
    sendFollowupTurn(message: unknown): void {
      this.sendFollowUpMessage(message);
    },

    /**
     * Notify the host of the widget's intrinsic height.
     */
    notifyIntrinsicHeight(height: unknown): void {
      const n = Number(height);
      if (Number.isFinite(n) && n > 0) postHeight(n);
    },

    /**
     * Open an external URL in a new tab.
     * ui/open-link is a request in the spec; param is `url` (not `href`).
     */
    openExternal(options: { href: string } | string): void {
      const href = typeof options === "string" ? options : options?.href;
      if (!href) throw new Error("href is required for openExternal");
      sendRequest("ui/open-link", { url: href });
      window.open(href, "_blank", "noopener,noreferrer");
    },

    /**
     * Request a display mode change (inline, fullscreen, pip).
     * ui/request-display-mode is a request in the spec.
     */
    requestDisplayMode(
      options: { mode?: string; maxHeight?: number | null } = {},
    ): { mode: string } {
      const mode = options.mode || "inline";
      this.displayMode = mode;
      sendRequest("ui/request-display-mode", { mode });
      return { mode };
    },

    /**
     * Store arbitrary widget state for persistence.
     * Maps to ui/update-model-context which is a request expecting
     * { content?: ContentBlock[], structuredContent?: Record }.
     */
    setWidgetState(state: unknown): void {
      this.widgetState = state;
      sendRequest("ui/update-model-context", {
        structuredContent: typeof state === "object" && state !== null
          ? state as Record<string, unknown>
          : { value: state },
      });
    },

    /**
     * Request a modal to be opened (ChatGPT-specific, notification).
     */
    requestModal(options?: {
      title?: string;
      params?: Record<string, unknown>;
      anchor?: string;
      template?: string;
    }): void {
      const opts = options ?? {};
      sendNotification("openai/requestModal", {
        title: opts.title,
        params: opts.params,
        anchor: opts.anchor,
        template: opts.template,
      });
    },

    /**
     * Request the widget to be closed (ChatGPT-specific, notification).
     */
    requestClose(): void {
      sendNotification("openai/requestClose", { toolId });
    },
  };

  // ── Listen for incoming JSON-RPC responses & notifications ─────────

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (!data || data.jsonrpc !== "2.0") return;

    // JSON-RPC response (has id, has result or error)
    if (data.id != null && (data.result !== undefined || data.error !== undefined)) {
      const pending = pendingCalls.get(data.id);
      if (pending) {
        pendingCalls.delete(data.id);
        if (data.error) {
          pending.reject(
            new Error(
              typeof data.error === "string"
                ? data.error
                : data.error?.message ?? "Unknown error",
            ),
          );
        } else {
          pending.resolve(data.result);
        }
      }
      return;
    }

    // JSON-RPC notification (has method, no id)
    if (data.method) {
      const params = data.params ?? {};
      switch (data.method) {
        case "ui/set-tool-input":
          openaiAPI.toolInput = params.toolInput ?? params;
          break;
        case "ui/set-tool-output":
          openaiAPI.toolOutput = params.toolOutput ?? params;
          break;
        case "ui/set-theme":
          if (params.theme) openaiAPI.theme = params.theme;
          break;
      }
    }
  });

  // ── Mount on window ────────────────────────────────────────────────

  Object.defineProperty(window, "openai", {
    value: openaiAPI,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  setupAutoResize();
})();
