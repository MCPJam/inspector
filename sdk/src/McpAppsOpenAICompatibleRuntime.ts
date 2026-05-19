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
  /**
   * Tool response `_meta` (per the Apps SDK contract — exposed to widgets
   * as `window.openai.toolResponseMetadata`, distinct from
   * `toolOutput` which is the structured result the widget renders).
   * `null` when no `_meta` was attached to the tool result.
   */
  toolResponseMetadata: Record<string, unknown> | null;
  /**
   * Persisted widget state from a saved view or fork. Seeds
   * `window.openai.widgetState` on bootstrap so widgets that read
   * `widgetState` at first render see the saved value, not `null`.
   * `null` when the widget should boot with fresh state.
   */
  initialWidgetState: unknown;
  theme: string;
  viewMode: string;
  viewParams: Record<string, unknown>;
};

type PendingCall = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

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

  const {
    toolId,
    toolInput,
    toolOutput,
    toolResponseMetadata,
    initialWidgetState,
    theme,
    viewMode,
    viewParams,
  } = config;

  // JSON-RPC 2.0 call ID counter
  let callId = 0;

  // Pending calls awaiting responses (for callTool)
  const pendingCalls = new Map<number, PendingCall>();

  // Pending checkout calls awaiting responses (notification + callId pattern)
  const pendingCheckoutCalls = new Map<number, PendingCall>();

  /**
   * Dispatch the `openai:set_globals` CustomEvent. Apps SDK widgets (and the
   * ChatGPT UI guide examples) subscribe to this event to learn about
   * host-side state changes. The MCP-Apps path translates `ui/*`
   * notifications into this event so a widget written against the Apps SDK
   * contract sees the same surface here as it would in production ChatGPT.
   */
  const dispatchSetGlobals = (globals: Record<string, unknown>): void => {
    try {
      window.dispatchEvent(
        new CustomEvent("openai:set_globals", { detail: { globals } }),
      );
    } catch {
      // silent — CustomEvent should always succeed in a real DOM
    }
  };

  // Timeout for pending calls (30 seconds)
  const CALL_TIMEOUT_MS = 30_000;

  // Timeout for checkout calls (60 seconds — checkout flows take longer)
  const CHECKOUT_TIMEOUT_MS = 60_000;

  /**
   * Send a JSON-RPC 2.0 request (expects a response matched by id)
   */
  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
  ): { id: number } => {
    const id = ++callId;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
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
    toolResponseMetadata: toolResponseMetadata ?? null,
    theme: theme ?? "dark",
    displayMode: "inline",
    viewMode: viewMode ?? "inline",
    viewParams: viewParams ?? {},
    // Seeded with the persisted widgetState from a saved view / fork
    // (when present) so widgets that read window.openai.widgetState on
    // first render see the previously-saved state instead of null.
    widgetState: (initialWidgetState ?? null) as unknown,

    /**
     * Call an MCP tool by name. Returns a Promise resolved when the
     * host sends back the JSON-RPC response with the matching id.
     */
    callTool(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<unknown> {
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
      const prompt =
        typeof opts === "string" ? opts : ((opts as any)?.prompt ?? "");
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
     * Store arbitrary widget state for persistence. Mirrors the Apps SDK
     * contract:
     *   - update local `window.openai.widgetState`,
     *   - notify the host so it can persist for replay / saved views,
     *   - fire the `openai:set_globals` event for widgets that observe it.
     *
     * IMPORTANT: this does NOT call `ui/update-model-context`. That
     * request is a SEP-1865 spec API for explicitly updating the host's
     * model context (which is consumed by the LLM on the next turn) and
     * should be opt-in — auto-posting on every state change would leak
     * widget internals into the LLM prompt. Widgets that want to update
     * model context must call it themselves.
     */
    setWidgetState(state: unknown): void {
      this.widgetState = state;
      window.parent.postMessage(
        { type: "openai:setWidgetState", toolId, state },
        "*",
      );
      dispatchSetGlobals({ widgetState: state });
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

    // ── File Upload / Download ────────────────────────────────────────
    // These use custom (non-JSON-RPC) postMessage types, matching the
    // ChatGPT widget-runtime.ts protocol. The sandbox proxy and
    // SandboxedIframe whitelist these message types alongside CSP
    // violation messages.

    _fileCallId: 0,
    _pendingFileCalls: new Map<number, PendingCall>(),

    /**
     * Upload a file (image) to the host. Returns a fileId for later retrieval.
     */
    uploadFile(file: File): Promise<{ fileId: string }> {
      const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
      const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

      if (!(file instanceof File)) {
        return Promise.reject(new Error("uploadFile requires a File object"));
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        return Promise.reject(
          new Error(
            `Unsupported file type: ${file.type}. Allowed: ${ALLOWED_TYPES.join(", ")}`,
          ),
        );
      }
      if (file.size > MAX_SIZE) {
        return Promise.reject(
          new Error(
            `File too large. Maximum size: ${MAX_SIZE / 1024 / 1024}MB`,
          ),
        );
      }

      const id = ++this._fileCallId;

      return new Promise((resolve, reject) => {
        this._pendingFileCalls.set(id, { resolve, reject });

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          window.parent.postMessage(
            {
              type: "openai:uploadFile",
              callId: id,
              toolId,
              data: base64,
              mimeType: file.type,
              fileName: file.name,
            },
            "*",
          );
        };
        reader.onerror = () => {
          this._pendingFileCalls.delete(id);
          reject(new Error("Failed to read file"));
        };
        reader.readAsDataURL(file);

        setTimeout(() => {
          if (this._pendingFileCalls.has(id)) {
            this._pendingFileCalls.delete(id);
            reject(new Error("Upload timeout"));
          }
        }, 60_000);
      });
    },

    /**
     * Get a download URL for a previously uploaded file.
     */
    getFileDownloadUrl(options: {
      fileId: string;
    }): Promise<{ downloadUrl: string }> {
      if (!options || !options.fileId) {
        return Promise.reject(new Error("fileId is required"));
      }

      const id = ++this._fileCallId;

      return new Promise((resolve, reject) => {
        this._pendingFileCalls.set(id, { resolve, reject });

        window.parent.postMessage(
          {
            type: "openai:getFileDownloadUrl",
            callId: id,
            toolId,
            fileId: options.fileId,
          },
          "*",
        );

        setTimeout(() => {
          if (this._pendingFileCalls.has(id)) {
            this._pendingFileCalls.delete(id);
            reject(new Error("getFileDownloadUrl timeout"));
          }
        }, 30_000);
      });
    },

    /**
     * Request a checkout flow (ACP — Agentic Checkout Protocol).
     * Uses notification + callId pattern (same as requestModal) to avoid
     * conflicts with AppBridge's JSON-RPC request handling.
     */
    requestCheckout(session: Record<string, unknown>): Promise<unknown> {
      const id = ++callId;
      sendNotification("openai/requestCheckout", { ...session, callId: id });

      return new Promise((resolve, reject) => {
        pendingCheckoutCalls.set(id, { resolve, reject });
        setTimeout(() => {
          if (pendingCheckoutCalls.has(id)) {
            pendingCheckoutCalls.delete(id);
            reject(new Error("Checkout request timeout"));
          }
        }, CHECKOUT_TIMEOUT_MS);
      });
    },
  };

  // ── Listen for incoming JSON-RPC responses & notifications ─────────

  window.addEventListener("message", (event: MessageEvent) => {
    // Only accept messages from our parent (sandbox proxy)
    if (event.source !== window.parent) return;

    const data = event.data;
    if (!data || data.jsonrpc !== "2.0") return;

    // JSON-RPC response (has id, has result or error)
    if (
      data.id != null &&
      (data.result !== undefined || data.error !== undefined)
    ) {
      const pending = pendingCalls.get(data.id);
      if (pending) {
        pendingCalls.delete(data.id);
        if (data.error) {
          pending.reject(
            new Error(
              typeof data.error === "string"
                ? data.error
                : (data.error?.message ?? "Unknown error"),
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
        // MCP Apps bridge notification names (SEP-1865)
        case "ui/notifications/tool-input": {
          const args = params.arguments ?? params;
          openaiAPI.toolInput = args;
          dispatchSetGlobals({ toolInput: args });
          break;
        }
        case "ui/notifications/tool-input-partial": {
          const args = params.arguments ?? params;
          openaiAPI.toolInput = args;
          dispatchSetGlobals({ toolInput: args });
          break;
        }
        case "ui/notifications/tool-result": {
          openaiAPI.toolOutput = params;
          // Apps SDK exposes the tool result's `_meta` as a separate
          // `window.openai.toolResponseMetadata` surface (distinct from
          // toolOutput, which is the structured result the widget renders).
          // Surface it here when present so widgets can read timestamps,
          // source IDs, etc. without rummaging in toolOutput.
          const meta =
            (params as { _meta?: Record<string, unknown> } | undefined)?._meta;
          const detail: Record<string, unknown> = { toolOutput: params };
          if (meta && typeof meta === "object") {
            openaiAPI.toolResponseMetadata = meta;
            detail.toolResponseMetadata = meta;
          }
          dispatchSetGlobals(detail);
          break;
        }
        case "ui/notifications/tool-cancelled":
          // Tool was cancelled/errored
          break;
        case "ui/notifications/host-context-changed": {
          const changed: Record<string, unknown> = {};
          if (params.theme) {
            openaiAPI.theme = params.theme;
            changed.theme = params.theme;
          }
          if (params.displayMode) {
            openaiAPI.displayMode = params.displayMode;
            changed.displayMode = params.displayMode;
          }
          if (Object.keys(changed).length > 0) dispatchSetGlobals(changed);
          break;
        }
        case "openai/requestCheckout:response": {
          const pending = pendingCheckoutCalls.get(params.callId as number);
          if (pending) {
            pendingCheckoutCalls.delete(params.callId as number);
            if (params.error) {
              pending.reject(
                new Error(
                  typeof params.error === "string"
                    ? params.error
                    : "Checkout failed",
                ),
              );
            } else {
              pending.resolve(params.result);
            }
          }
          break;
        }
      }
    }
  });

  // ── Listen for file operation responses (non-JSON-RPC) ─────────────

  window.addEventListener("message", (event: MessageEvent) => {
    // Only accept messages from our parent (sandbox proxy)
    if (event.source !== window.parent) return;

    const data = event.data;
    if (!data) return;

    if (
      data.type === "openai:uploadFile:response" ||
      data.type === "openai:getFileDownloadUrl:response"
    ) {
      const pending = openaiAPI._pendingFileCalls.get(data.callId);
      if (pending) {
        openaiAPI._pendingFileCalls.delete(data.callId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data.result);
        }
      }
    }
  });

  // ── MCP Apps initialization handshake ─────────────────────────────
  // The host AppBridge expects ui/initialize → response → ui/notifications/initialized.
  // Without this, the bridge never fires oninitialized and the widget stays hidden.

  const PROTOCOL_VERSION = "2026-01-26";

  const initId = ++callId;
  window.parent.postMessage(
    {
      jsonrpc: "2.0",
      id: initId,
      method: "ui/initialize",
      params: {
        appInfo: { name: "openai-compat", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      },
    },
    "*",
  );

  // Wait for the initialize response, then send initialized notification
  pendingCalls.set(initId, {
    resolve: (result: unknown) => {
      const res = result as Record<string, unknown> | null;
      // Apply host context from init response
      if (res?.hostContext) {
        const ctx = res.hostContext as Record<string, unknown>;
        if (ctx.theme && typeof ctx.theme === "string")
          openaiAPI.theme = ctx.theme;
        if (ctx.displayMode && typeof ctx.displayMode === "string")
          openaiAPI.displayMode = ctx.displayMode;
      }
      // Complete the handshake — this triggers bridge.oninitialized on the host
      sendNotification("ui/notifications/initialized", {});
      // Initial set_globals dispatch with everything the runtime currently
      // knows. Apps SDK widgets that subscribe at script load (or via the
      // standard early-script pattern) will see this on the next tick.
      dispatchSetGlobals({
        toolInput: openaiAPI.toolInput,
        toolOutput: openaiAPI.toolOutput,
        toolResponseMetadata: openaiAPI.toolResponseMetadata,
        theme: openaiAPI.theme,
        displayMode: openaiAPI.displayMode,
        widgetState: openaiAPI.widgetState,
      });
    },
    reject: () => {
      // Initialization failed; still try to signal initialized so widget shows
      sendNotification("ui/notifications/initialized", {});
      // Dispatch initial globals in the failure path too so event-driven
      // widgets that subscribe to openai:set_globals get their initial
      // state (toolInput/toolOutput from config + defaults). Mirrors the
      // success branch above.
      dispatchSetGlobals({
        toolInput: openaiAPI.toolInput,
        toolOutput: openaiAPI.toolOutput,
        toolResponseMetadata: openaiAPI.toolResponseMetadata,
        theme: openaiAPI.theme,
        displayMode: openaiAPI.displayMode,
        widgetState: openaiAPI.widgetState,
      });
    },
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
