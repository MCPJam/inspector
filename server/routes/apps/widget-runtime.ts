/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

export {};

type DeviceCapabilities = {
  hover: boolean;
  touch: boolean;
};

type SafeAreaInsets = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

type UserLocation = {
  country: string;
  region: string;
  city: string;
};

type RuntimeConfig = {
  toolId: string;
  toolName: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata?: Record<string, any> | null;
  theme: string;
  locale: string;
  deviceType: "mobile" | "tablet" | "desktop";
  userLocation?: UserLocation | null;
  maxHeight?: number | null;
  capabilities?: DeviceCapabilities | null;
  safeAreaInsets?: SafeAreaInsets;
  viewMode?: string;
  viewParams?: Record<string, any>;
  useMapPendingCalls?: boolean;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type NavigationDirection = "back" | "forward";

type OpenAIAPI = {
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata: Record<string, any> | null;
  displayMode: string;
  theme: string;
  locale: string;
  maxHeight: number | null;
  safeArea: { insets: SafeAreaInsets };
  userAgent: { device: { type: string }; capabilities: DeviceCapabilities };
  view: { mode: string; params: Record<string, any> };
  widgetState: any;
  _pendingCalls?: Map<number, PendingCall>;
  _callId: number;
  setWidgetState(state: any): void;
  callTool(toolName: string, args?: Record<string, any>): Promise<any>;
  sendFollowUpMessage(opts: any): void;
  sendFollowupTurn(message: any): void;
  requestDisplayMode(options?: { mode?: string; maxHeight?: number | null }): {
    mode: string;
  };
  requestClose(): void;
  openExternal(options: { href: string } | string): void;
  requestModal(options: any): void;
  notifyIntrinsicHeight(height: unknown): void;
  notifyNavigation(direction: NavigationDirection): void;
};

declare global {
  interface Window {
    openai: OpenAIAPI;
    webplus: OpenAIAPI;
  }
}

const CONFIG_ELEMENT_ID = "openai-runtime-config";

const readConfig = (): RuntimeConfig | null => {
  try {
    const el = document.getElementById(CONFIG_ELEMENT_ID);
    if (!el) {
      console.error("[OpenAI Widget] Missing runtime config element");
      return null;
    }
    const raw = el.textContent || "{}";
    return JSON.parse(raw) as RuntimeConfig;
  } catch (err) {
    console.error("[OpenAI Widget] Failed to parse runtime config", err);
    return null;
  }
};

const clampNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

(function bootstrap() {
  const config = readConfig();
  if (!config) return;

  const {
    toolId,
    toolName,
    toolInput,
    toolOutput,
    toolResponseMetadata,
    theme,
    locale,
    deviceType,
    userLocation,
    maxHeight,
    capabilities,
    safeAreaInsets,
    viewMode = "inline",
    viewParams = {},
    useMapPendingCalls = true,
  } = config;

  const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;

  const hostLocale = locale;
  const hostDeviceType = deviceType;
  const hostUserLocation = userLocation ?? null;
  const hostCapabilities = capabilities ?? null;
  const hostSafeAreaInsets = safeAreaInsets ?? {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  };

  try {
    document.documentElement.lang = hostLocale;
  } catch (e) {
    // no-op
  }

  const detectedTouch =
    "ontouchstart" in window || (navigator as any).maxTouchPoints > 0;
  const detectedHover = window.matchMedia("(hover: hover)").matches;
  const hasTouch = hostCapabilities ? hostCapabilities.touch : detectedTouch;
  const hasHover = hostCapabilities ? hostCapabilities.hover : detectedHover;

  const getSubjectId = (): string => {
    let subjectId = sessionStorage.getItem("openai_subject_id");
    if (!subjectId) {
      subjectId = "anon_" + Math.random().toString(36).substring(2, 15);
      sessionStorage.setItem("openai_subject_id", subjectId);
    }
    return subjectId;
  };

  const postHeight = (() => {
    let lastHeight = 0;
    return (height: unknown) => {
      const numericHeight = Number(height);
      if (!Number.isFinite(numericHeight) || numericHeight <= 0) return;
      const roundedHeight = Math.round(numericHeight);
      if (roundedHeight === lastHeight) return;
      lastHeight = roundedHeight;
      window.parent.postMessage(
        { type: "openai:resize", height: roundedHeight },
        "*",
      );
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
    } catch (err) {
      console.error("[OpenAI Widget] Failed to measure height:", err);
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
      const resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
    } else {
      window.addEventListener("resize", scheduleMeasure);
    }

    window.addEventListener("load", () => {
      requestAnimationFrame(measureAndNotifyHeight);
    });
  };

  const navigationState = { currentIndex: 0, historyLength: 1 };

  const withNavigationIndex = (
    state: any,
    index: number,
  ): Record<string, any> => {
    return state && typeof state === "object"
      ? { ...state, __navIndex: index }
      : { __navIndex: index };
  };

  const notifyNavigationState = () => {
    const canGoBack = navigationState.currentIndex > 0;
    const canGoForward =
      navigationState.currentIndex < navigationState.historyLength - 1;
    window.parent.postMessage(
      {
        type: "openai:navigationStateChanged",
        toolId,
        canGoBack,
        canGoForward,
        historyLength: navigationState.historyLength,
        currentIndex: navigationState.currentIndex,
      },
      "*",
    );
  };

  const originalPushState = history.pushState.bind(history);
  history.pushState = function pushState(
    state: any,
    title: string,
    url?: string | URL | null,
  ) {
    const nextIndex = navigationState.currentIndex + 1;
    const stateWithIndex = withNavigationIndex(state, nextIndex);
    originalPushState(stateWithIndex, title, url);
    navigationState.currentIndex = nextIndex;
    navigationState.historyLength = history.length;
    notifyNavigationState();
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function replaceState(
    state: any,
    title: string,
    url?: string | URL | null,
  ) {
    const stateWithIndex = withNavigationIndex(
      state,
      navigationState.currentIndex,
    );
    originalReplaceState(stateWithIndex, title, url);
    navigationState.historyLength = history.length;
    notifyNavigationState();
  };

  window.addEventListener("popstate", (event) => {
    const stateIndex =
      (event as any).state?.__navIndex ?? navigationState.currentIndex;
    navigationState.currentIndex = stateIndex;
    navigationState.historyLength = history.length;
    notifyNavigationState();
  });

  const openaiAPI: any = {
    toolInput,
    toolOutput,
    toolResponseMetadata: toolResponseMetadata ?? null,
    displayMode: "inline",
    theme,
    locale: hostLocale,
    maxHeight: maxHeight ?? null,
    safeArea: { insets: hostSafeAreaInsets },
    userAgent: {
      device: { type: hostDeviceType },
      capabilities: { hover: hasHover, touch: hasTouch },
    },
    view: { mode: viewMode, params: viewParams },
    widgetState: null,
    ...(useMapPendingCalls ? { _pendingCalls: new Map() } : {}),
    _callId: 0,

    setWidgetState(state: any) {
      this.widgetState = state;
      try {
        localStorage.setItem(widgetStateKey, JSON.stringify(state));
      } catch (err) {
        // no-op
      }
      window.parent.postMessage(
        { type: "openai:setWidgetState", toolId, state },
        "*",
      );
    },

    callTool(toolName: string, args: Record<string, any> = {}) {
      const callId = ++this._callId;
      if (useMapPendingCalls) {
        return new Promise((resolve, reject) => {
          this._pendingCalls.set(callId, { resolve, reject });
          window.parent.postMessage(
            {
              type: "openai:callTool",
              toolName,
              args,
              callId,
              toolId,
              _meta: Object.assign(
                {
                  "openai/locale": hostLocale,
                  "openai/userAgent": navigator.userAgent,
                  "openai/subject": getSubjectId(),
                },
                hostUserLocation
                  ? { "openai/userLocation": hostUserLocation }
                  : {},
              ),
            },
            "*",
          );
          setTimeout(() => {
            if (this._pendingCalls.has(callId)) {
              this._pendingCalls.delete(callId);
              reject(new Error("Tool call timeout"));
            }
          }, 30000);
        });
      }

      return new Promise((resolve, reject) => {
        const handler = (event: MessageEvent<any>) => {
          if (
            event.data?.type === "openai:callTool:response" &&
            event.data.callId === callId
          ) {
            window.removeEventListener("message", handler);
            event.data.error
              ? reject(new Error(event.data.error))
              : resolve(event.data.result);
          }
        };
        window.addEventListener("message", handler);
        window.parent.postMessage(
          {
            type: "openai:callTool",
            callId,
            toolName,
            args,
            toolId,
            _meta: Object.assign(
              {
                "openai/locale": hostLocale,
                "openai/userAgent": navigator.userAgent,
                "openai/subject": getSubjectId(),
              },
              hostUserLocation
                ? { "openai/userLocation": hostUserLocation }
                : {},
            ),
          },
          "*",
        );
        setTimeout(() => {
          window.removeEventListener("message", handler);
          reject(new Error("Tool call timeout"));
        }, 30000);
      });
    },

    sendFollowUpMessage(opts: any) {
      const prompt = typeof opts === "string" ? opts : opts?.prompt || "";
      window.parent.postMessage(
        { type: "openai:sendFollowup", message: prompt, toolId },
        "*",
      );
    },

    sendFollowupTurn(message: any) {
      return this.sendFollowUpMessage(
        typeof message === "string" ? message : message?.prompt || "",
      );
    },

    requestDisplayMode(options: any = {}) {
      const mode = options.mode || "inline";
      this.displayMode = mode;
      window.parent.postMessage(
        {
          type: "openai:requestDisplayMode",
          mode,
          maxHeight: options.maxHeight,
          toolId,
        },
        "*",
      );
      return { mode };
    },

    requestClose() {
      window.parent.postMessage({ type: "openai:requestClose", toolId }, "*");
    },

    openExternal(options: any) {
      let href: string | undefined;
      if (typeof options === "string") {
        console.warn(
          "[OpenAI SDK] openExternal(string) is deprecated. Use openExternal({ href: string }) instead.",
        );
        href = options;
      } else {
        href = options?.href;
      }
      if (!href)
        throw new Error(
          'href is required for openExternal. Usage: openExternal({ href: "https://..." })',
        );
      window.parent.postMessage({ type: "openai:openExternal", href }, "*");
      window.open(href, "_blank", "noopener,noreferrer");
    },

    requestModal(options: any) {
      window.parent.postMessage(
        {
          type: "openai:requestModal",
          title: options.title,
          params: options.params,
          anchor: options.anchor,
        },
        "*",
      );
    },

    notifyIntrinsicHeight(height: unknown) {
      postHeight(height);
    },

    notifyNavigation(direction: "back" | "forward") {
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
    },
  };

  Object.defineProperty(window, "openai", {
    value: openaiAPI,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  Object.defineProperty(window, "webplus", {
    value: openaiAPI,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  setTimeout(() => {
    try {
      window.dispatchEvent(
        new CustomEvent("openai:set_globals", {
          detail: {
            globals: {
              displayMode: openaiAPI.displayMode,
              maxHeight: openaiAPI.maxHeight,
              theme: openaiAPI.theme,
              locale: openaiAPI.locale,
              safeArea: openaiAPI.safeArea,
              userAgent: openaiAPI.userAgent,
            },
          },
        }),
      );
    } catch (err) {
      console.error("[OpenAI Widget] Failed to dispatch globals event:", err);
    }
  }, 0);

  setTimeout(() => {
    try {
      const stored = localStorage.getItem(widgetStateKey);
      if (stored && window.openai)
        window.openai.widgetState = JSON.parse(stored);
    } catch (err) {
      console.error("[OpenAI Widget] Failed to restore widget state:", err);
    }
  }, 0);

  window.addEventListener("message", (event: MessageEvent<any>) => {
    const { type, callId, result, error, globals } = event.data || {};
    switch (type) {
      case "openai:callTool:response": {
        if (!useMapPendingCalls) break;
        const pending = window.openai._pendingCalls?.get(callId);
        if (pending) {
          window.openai._pendingCalls?.delete(callId);
          error ? pending.reject(new Error(error)) : pending.resolve(result);
        }
        break;
      }
      case "openai:set_globals":
        if (globals) {
          if (globals.displayMode !== undefined)
            window.openai.displayMode = globals.displayMode;
          if (globals.maxHeight !== undefined)
            window.openai.maxHeight = globals.maxHeight;
          if (globals.theme !== undefined) window.openai.theme = globals.theme;
          if (globals.locale !== undefined)
            window.openai.locale = globals.locale;
          if (globals.safeArea !== undefined)
            window.openai.safeArea = globals.safeArea;
          if (globals.userAgent !== undefined)
            window.openai.userAgent = globals.userAgent;
          if (globals.view !== undefined) window.openai.view = globals.view;
        }
        try {
          window.dispatchEvent(
            new CustomEvent("openai:set_globals", { detail: { globals } }),
          );
        } catch (err) {
          // no-op
        }
        break;
      case "openai:pushWidgetState":
        if (event.data.toolId === toolId) {
          try {
            const nextState = event.data.state ?? null;
            window.openai.widgetState = nextState;
            try {
              localStorage.setItem(widgetStateKey, JSON.stringify(nextState));
            } catch (err) {
              // no-op
            }
            window.dispatchEvent(
              new CustomEvent("openai:widget_state", {
                detail: { state: nextState },
              }),
            );
          } catch (err) {
            console.error(
              "[OpenAI Widget] Failed to apply pushed widget state:",
              err,
            );
          }
        }
        break;
      case "openai:requestResize":
        measureAndNotifyHeight();
        break;
      case "openai:navigate":
        if (event.data.toolId === toolId) {
          if (event.data.direction === "back") {
            if (navigationState.currentIndex > 0) {
              navigationState.currentIndex--;
              history.back();
            }
          } else if (event.data.direction === "forward") {
            if (
              navigationState.currentIndex <
              navigationState.historyLength - 1
            ) {
              navigationState.currentIndex++;
              history.forward();
            }
          }
        }
        break;
    }
  });

  window.addEventListener("openai:resize", (event: Event) => {
    try {
      const detail =
        event && typeof event === "object" && "detail" in event
          ? (event as any).detail || {}
          : {};
      const height =
        typeof detail?.height === "number"
          ? detail.height
          : typeof detail?.size?.height === "number"
            ? detail.size.height
            : null;
      if (height != null) {
        postHeight(height);
      } else {
        measureAndNotifyHeight();
      }
    } catch (err) {
      console.error("[OpenAI Widget] Failed to process resize event:", err);
    }
  });

  setupAutoResize();

  document.addEventListener("securitypolicyviolation", (e: any) => {
    const violation = {
      type: "openai:csp-violation",
      toolId,
      directive: e.violatedDirective,
      blockedUri: e.blockedURI,
      sourceFile: e.sourceFile || null,
      lineNumber: clampNumber(e.lineNumber),
      columnNumber: clampNumber(e.columnNumber),
      originalPolicy: e.originalPolicy,
      effectiveDirective: e.effectiveDirective,
      disposition: e.disposition,
      timestamp: Date.now(),
    };

    console.warn(
      "[OpenAI Widget CSP Violation]",
      violation.directive,
      ":",
      violation.blockedUri,
    );
    window.parent.postMessage(violation, "*");
  });
})();
