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
  viewMode: string;
  viewParams: Record<string, unknown>;
  // One-release feature flag for the setWidgetState fix. When true, state
  // persists to localStorage (the correct behavior) and emits
  // openai/setWidgetState. When false, legacy behavior — routes through
  // ui/update-model-context, which leaks widget state into the next LLM turn.
  // Default false during Stage 1 soak; flipped to true once renderer-side
  // handlers (Stage 1.5) and smoke land.
  useLocalStorageWidgetState?: boolean;
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
    toolName,
    toolInput,
    toolOutput,
    theme,
    viewMode,
    viewParams,
    useLocalStorageWidgetState = false,
  } = config;

  const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;

  // JSON-RPC 2.0 call ID counter
  let callId = 0;

  // Pending calls awaiting responses (for callTool)
  const pendingCalls = new Map<number, PendingCall>();

  // Pending checkout calls awaiting responses (notification + callId pattern)
  const pendingCheckoutCalls = new Map<number, PendingCall>();

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

  const heightPoster = (() => {
    let lastHeight = 0;
    return {
      post(height: number): void {
        const rounded = Math.round(height);
        if (rounded <= 0 || rounded === lastHeight) return;
        lastHeight = rounded;
        sendNotification("ui/notifications/size-changed", { height: rounded });
      },
      reset(): void {
        // Clear the cache so the next measurement re-emits even at the same
        // pixel value — used when returning from PiP/fullscreen to inline,
        // where the iframe's resolved width changes but content height may
        // round to the prior value.
        lastHeight = 0;
      },
    };
  })();

  const postHeight = (height: number) => heightPoster.post(height);

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

  // Initial defaults — overwritten by ui/notifications/host-context-changed
  // and by hostContext returned in the ui/initialize response.
  const DEFAULT_SAFE_AREA = { top: 0, right: 0, bottom: 0, left: 0 };
  const DEFAULT_DEVICE_CAPABILITIES = {
    hover: false,
    touch: false,
    keyboard: false,
    pointer: "coarse" as string,
    standalone: false,
    screen: { width: 0, height: 0 },
  };

  const openaiAPI = {
    toolInput: toolInput ?? {},
    toolOutput: toolOutput ?? null,
    theme: theme ?? "dark",
    displayMode: "inline",
    viewMode: viewMode ?? "inline",
    viewParams: viewParams ?? {},
    // view is the modal-widget contract surface — set when the runtime is
    // mounted inside a modal. Stage 1.4 wires it from viewMode/viewParams.
    view: { mode: viewMode ?? "inline", params: viewParams ?? {} },
    widgetState: null as unknown,
    // Host-context globals — populated by host-context-changed dispatches.
    // Shape mirrors ChatGptAppsRuntime so widgets authored against ChatGPT
    // can read window.openai.* uniformly.
    locale: "en-US" as string,
    maxHeight: null as number | null,
    safeArea: { insets: DEFAULT_SAFE_AREA },
    userAgent: {
      device: { type: "desktop" as string },
      capabilities: DEFAULT_DEVICE_CAPABILITIES as Record<string, unknown>,
    },

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
     * Store arbitrary widget state for persistence.
     *
     * With useLocalStorageWidgetState=true (correct): persist to localStorage
     * under openai-widget-state:${toolName}:${toolId} and emit an
     * openai/setWidgetState notification. localStorage powers modal↔inline
     * state sync via the `storage` event.
     *
     * With useLocalStorageWidgetState=false (legacy): route to
     * ui/update-model-context. This leaks widget state into the model's next
     * turn, which is wrong — view state ≠ model context. Preserved under
     * flag for one release to allow rollback during Stage 1 soak.
     */
    setWidgetState(state: unknown): void {
      this.widgetState = state;
      if (useLocalStorageWidgetState) {
        try {
          localStorage.setItem(widgetStateKey, JSON.stringify(state));
        } catch {
          // quota exceeded, storage disabled, etc. — non-fatal
        }
        sendNotification("openai/setWidgetState", { state, toolId });
      } else {
        sendRequest("ui/update-model-context", {
          structuredContent:
            typeof state === "object" && state !== null
              ? (state as Record<string, unknown>)
              : { value: state },
        });
      }
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

    /**
     * Drive the widget's own history. Called by widget code when the user
     * interacts with widget-internal UI; also called from the renderer's
     * fullscreen header back/forward chevrons via inbound openai/navigate.
     */
    notifyNavigation(direction: "back" | "forward"): void {
      driveNavigation(direction);
    },
  };

  // ── Navigation history instrumentation ────────────────────────────
  // Wrap pushState/replaceState and watch popstate so the host learns when
  // the widget's internal history changes — drives the fullscreen header's
  // back/forward chevron state. Mirrors ChatGptAppsRuntime semantics over
  // JSON-RPC instead of the legacy `openai:navigationStateChanged` message.

  const navigationState = { currentIndex: 0, historyLength: 1 };

  const withNavigationIndex = (
    state: unknown,
    index: number,
  ): Record<string, unknown> => {
    if (state && typeof state === "object" && !Array.isArray(state)) {
      return { ...(state as Record<string, unknown>), __navIndex: index };
    }
    return { __navIndex: index };
  };

  const notifyNavigationState = (): void => {
    const canGoBack = navigationState.currentIndex > 0;
    const canGoForward =
      navigationState.currentIndex < navigationState.historyLength - 1;
    sendNotification("openai/navigationStateChanged", {
      toolId,
      canGoBack,
      canGoForward,
      historyLength: navigationState.historyLength,
      currentIndex: navigationState.currentIndex,
    });
  };

  const installHistoryHooks = (): void => {
    const originalPushState = history.pushState.bind(history);
    history.pushState = function pushState(
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const nextIndex = navigationState.currentIndex + 1;
      originalPushState(withNavigationIndex(state, nextIndex), unused, url);
      navigationState.currentIndex = nextIndex;
      navigationState.historyLength = history.length;
      notifyNavigationState();
    };

    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = function replaceState(
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      originalReplaceState(
        withNavigationIndex(state, navigationState.currentIndex),
        unused,
        url,
      );
      navigationState.historyLength = history.length;
      notifyNavigationState();
    };

    window.addEventListener("popstate", (event) => {
      const stateIndex =
        (event.state as { __navIndex?: number } | null)?.__navIndex ??
        navigationState.currentIndex;
      navigationState.currentIndex = stateIndex;
      navigationState.historyLength = history.length;
      notifyNavigationState();
    });
  };

  const driveNavigation = (direction: string): void => {
    if (direction === "back") {
      if (navigationState.currentIndex > 0) {
        navigationState.currentIndex--;
        history.back();
      }
    } else if (direction === "forward") {
      if (navigationState.currentIndex < navigationState.historyLength - 1) {
        navigationState.currentIndex++;
        history.forward();
      }
    }
  };

  // ── Host-context plumbing ─────────────────────────────────────────
  // The MCP Apps bridge pushes ui/notifications/host-context-changed with a
  // McpUiHostContext payload (theme, displayMode, locale, timeZone, userAgent
  // as string, deviceCapabilities, safeAreaInsets, styles, toolInfo, ...).
  // Translate that into the window.openai.* shape ChatGPT widgets expect and
  // dispatch openai:set_globals so widget code listening for it stays in sync.

  const deriveDeviceType = (ua: string): string => {
    if (!ua) return "desktop";
    if (/iPad|Tablet/i.test(ua)) return "tablet";
    if (/Mobile|iPhone|Android.*Mobile/i.test(ua)) return "mobile";
    return "desktop";
  };

  const dispatchGlobals = (globals: Record<string, unknown>): void => {
    try {
      window.dispatchEvent(
        new CustomEvent("openai:set_globals", { detail: { globals } }),
      );
    } catch {
      // CustomEvent unsupported (very old browsers); non-fatal
    }
  };

  const applyHostContext = (ctx: Record<string, unknown>): void => {
    const changed: Record<string, unknown> = {};
    if (typeof ctx.theme === "string") {
      openaiAPI.theme = ctx.theme;
      changed.theme = ctx.theme;
    }
    if (typeof ctx.displayMode === "string") {
      const prev = openaiAPI.displayMode;
      openaiAPI.displayMode = ctx.displayMode;
      changed.displayMode = ctx.displayMode;
      // Re-measure on return-to-inline transitions (PiP/fullscreen → inline).
      // The iframe's resolved width changes, but content height may round to
      // the same pixel value the cache holds — force a re-emit.
      if (ctx.displayMode === "inline" && prev !== "inline") {
        heightPoster.reset();
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => measureAndNotifyHeight());
        } else {
          setTimeout(() => measureAndNotifyHeight(), 0);
        }
      }
    }
    if (typeof ctx.locale === "string") {
      openaiAPI.locale = ctx.locale;
      changed.locale = ctx.locale;
    }
    if (typeof ctx.maxHeight === "number") {
      openaiAPI.maxHeight = ctx.maxHeight;
      changed.maxHeight = ctx.maxHeight;
    } else if (ctx.maxHeight === null) {
      openaiAPI.maxHeight = null;
      changed.maxHeight = null;
    }
    if (ctx.safeAreaInsets && typeof ctx.safeAreaInsets === "object") {
      openaiAPI.safeArea = {
        insets: ctx.safeAreaInsets as typeof DEFAULT_SAFE_AREA,
      };
      changed.safeArea = openaiAPI.safeArea;
    }
    const uaString = typeof ctx.userAgent === "string" ? ctx.userAgent : "";
    const caps =
      ctx.deviceCapabilities && typeof ctx.deviceCapabilities === "object"
        ? (ctx.deviceCapabilities as Record<string, unknown>)
        : null;
    if (uaString || caps) {
      openaiAPI.userAgent = {
        device: { type: deriveDeviceType(uaString) },
        capabilities: caps ?? openaiAPI.userAgent.capabilities,
      };
      changed.userAgent = openaiAPI.userAgent;
    }
    if (ctx.toolInfo && typeof ctx.toolInfo === "object") {
      // toolInput / toolOutput live on dedicated notifications; toolInfo on
      // host-context just carries identity. Nothing to apply here today.
    }
    if (Object.keys(changed).length > 0) {
      dispatchGlobals(changed);
    }
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
        case "ui/notifications/tool-input":
          openaiAPI.toolInput = params.arguments ?? params;
          dispatchGlobals({ toolInput: openaiAPI.toolInput });
          break;
        case "ui/notifications/tool-input-partial":
          openaiAPI.toolInput = params.arguments ?? params;
          dispatchGlobals({ toolInput: openaiAPI.toolInput });
          break;
        case "ui/notifications/tool-result":
          openaiAPI.toolOutput = params;
          dispatchGlobals({ toolOutput: openaiAPI.toolOutput });
          break;
        case "ui/notifications/tool-cancelled":
          // Tool was cancelled/errored
          break;
        case "ui/notifications/host-context-changed":
          applyHostContext(params as Record<string, unknown>);
          break;
        case "openai/navigate": {
          // Host → widget: user clicked back/forward chevron in the
          // fullscreen header. Drive the widget's own history.
          if (params.toolId === toolId || params.toolId == null) {
            if (typeof params.direction === "string") {
              driveNavigation(params.direction);
            }
          }
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
      if (res?.hostContext && typeof res.hostContext === "object") {
        applyHostContext(res.hostContext as Record<string, unknown>);
      }
      // Complete the handshake — this triggers bridge.oninitialized on the host
      sendNotification("ui/notifications/initialized", {});
    },
    reject: () => {
      // Initialization failed; still try to signal initialized so widget shows
      sendNotification("ui/notifications/initialized", {});
    },
  });

  // ── Mount on window ────────────────────────────────────────────────

  installHistoryHooks();

  Object.defineProperty(window, "openai", {
    value: openaiAPI,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  // Seed listeners with current globals so widgets that subscribe at mount
  // get the initial snapshot without waiting for a host-context-changed.
  setTimeout(() => {
    dispatchGlobals({
      displayMode: openaiAPI.displayMode,
      maxHeight: openaiAPI.maxHeight,
      theme: openaiAPI.theme,
      locale: openaiAPI.locale,
      safeArea: openaiAPI.safeArea,
      userAgent: openaiAPI.userAgent,
    });
  }, 0);

  // ── Widget state restore + cross-iframe sync (flag-gated) ─────────
  // When useLocalStorageWidgetState is on, restore prior state on mount
  // and listen for storage events so modal and inline instances of the same
  // widget stay in sync (they share localStorage via same origin).
  if (useLocalStorageWidgetState) {
    try {
      const stored = localStorage.getItem(widgetStateKey);
      if (stored !== null) {
        openaiAPI.widgetState = JSON.parse(stored);
      }
    } catch {
      // Corrupt entry or storage disabled — start from null.
    }

    window.addEventListener("storage", (event: StorageEvent) => {
      if (event.key !== widgetStateKey || event.newValue == null) return;
      try {
        const next = JSON.parse(event.newValue);
        openaiAPI.widgetState = next;
        dispatchGlobals({ widgetState: next });
      } catch {
        // ignore malformed payload from a peer iframe
      }
    });
  }

  setupAutoResize();
})();
