import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { readResource } from "@/lib/mcp-resources-api";

type DisplayMode = "inline" | "pip" | "fullscreen";

type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | string;

interface OpenAIAppRendererProps {
  serverId: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolState;
  toolInput?: Record<string, any> | null;
  toolOutput?: unknown;
  toolMetadata?: Record<string, any>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
}

export function OpenAIAppRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput: toolInputProp,
  toolOutput: toolOutputProp,
  toolMetadata,
  onSendFollowUp,
  onCallTool,
}: OpenAIAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number>(600);
  const [contentHeight, setContentHeight] = useState<number>(600);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [isFetchingWidget, setIsFetchingWidget] = useState(false);
  const [widgetFetchError, setWidgetFetchError] = useState<string | null>(null);
  const widgetStateRef = useRef<any>(null);
  const resolvedToolCallId = useMemo(
    () => toolCallId ?? `${toolName || "openai-app"}`,
    [toolCallId, toolName],
  );
  const widgetStateKey = useMemo(
    () => `openai-widget-state:${resolvedToolCallId}`,
    [resolvedToolCallId],
  );

  useEffect(() => {
    try {
      const stored = localStorage.getItem(widgetStateKey);
      if (stored) {
        widgetStateRef.current = JSON.parse(stored);
      } else {
        widgetStateRef.current = null;
      }
    } catch (err) {
      widgetStateRef.current = null;
      console.warn("Failed to load cached widget state", err);
    }
  }, [widgetStateKey]);

  // Extract stuff from the Tool _meta field
  const tool_meta_outputTemplate = useMemo(
    () => toolMetadata?.["openai/outputTemplate"],
    [toolMetadata],
  );

  const structuredContent = useMemo(() => {
    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null &&
      "structuredContent" in (toolOutputProp as Record<string, unknown>)
    ) {
      return (toolOutputProp as Record<string, unknown>).structuredContent;
    }
    return null;
  }, [toolOutputProp]);

  const toolResponseMetadata = useMemo(() => {
    if (toolMetadata && typeof toolMetadata === "object") {
      return toolMetadata;
    }

    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null &&
      "_meta" in (toolOutputProp as Record<string, unknown>)
    ) {
      const meta = (toolOutputProp as Record<string, unknown>)._meta;
      if (meta && typeof meta === "object") {
        return meta as Record<string, unknown>;
      }
    }

    return null;
  }, [toolMetadata, toolOutputProp]);

  useEffect(() => {
    let isCancelled = false;

    if (!tool_meta_outputTemplate) {
      setWidgetHtml(null);
      setWidgetFetchError(null);
      setIsFetchingWidget(false);
      return () => {
        isCancelled = true;
      };
    }

    const loadResource = async () => {
      setIsFetchingWidget(true);
      setWidgetHtml(null);
      setWidgetFetchError(null);

      try {
        const data = await readResource(serverId, tool_meta_outputTemplate);

        const pickString = (value: unknown): string | null => {
          if (typeof value !== "string") return null;
          const trimmed = value.trim();
          return trimmed ? value : null;
        };

        let html: string | null = null;
        const content = data?.content as
          | {
              contents?: Array<
                { text?: unknown; blob?: unknown } | Record<string, unknown>
              >;
              text?: unknown;
              blob?: unknown;
            }
          | string
          | undefined;

        if (content && typeof content === "object" && "contents" in content) {
          const items = Array.isArray(content.contents) ? content.contents : [];
          for (const item of items) {
            const candidate =
              pickString((item as { text?: unknown }).text) ??
              pickString((item as { blob?: unknown }).blob);
            if (candidate) {
              html = candidate;
              break;
            }
          }
        }

        if (!html && content && typeof content === "object") {
          html =
            pickString((content as { text?: unknown }).text) ??
            pickString((content as { blob?: unknown }).blob);
        }

        if (!html && typeof content === "string") {
          html = pickString(content);
        }

        if (!html) {
          setWidgetHtml(null);
          setWidgetFetchError("Resource did not include HTML content");
          return;
        }
        setWidgetHtml(html);
      } catch (err) {
        if (isCancelled) return;
        setWidgetHtml(null);
        setWidgetFetchError(
          err instanceof Error ? err.message : "Failed to load widget resource",
        );
      } finally {
        if (!isCancelled) {
          setIsFetchingWidget(false);
        }
      }
    };

    loadResource();

    return () => {
      isCancelled = true;
    };
  }, [serverId, tool_meta_outputTemplate]);

  const htmlContent = widgetHtml;

  const resolvedToolInput = useMemo(
    () => (toolInputProp as Record<string, any>) ?? {},
    [toolInputProp],
  );

  const resolvedToolOutput = useMemo(
    () => structuredContent ?? toolOutputProp ?? null,
    [structuredContent, toolOutputProp],
  );

  const srcDoc = useMemo(() => {
    if (!htmlContent) return null;

    const serializedInput = safeJsonStringify(resolvedToolInput);
    const serializedOutput = safeJsonStringify(resolvedToolOutput);
    const serializedMetadata = safeJsonStringify(toolResponseMetadata);
    const serializedTheme = safeJsonStringify(themeMode);

    const script = String.raw`
      (function () {
        'use strict';

        const widgetStateKey = ${JSON.stringify(widgetStateKey)};
        const defaultLocale = 'en-US';
        const defaultSafeArea = { insets: { top: 0, right: 0, bottom: 0, left: 0 } };
        const defaultUserAgent = { device: { type: 'desktop' }, capabilities: { hover: true, touch: false } };

        const openaiAPI = {
          toolInput: ${serializedInput || "null"},
          toolOutput: ${serializedOutput || "null"},
          toolResponseMetadata: ${serializedMetadata || "null"},
          displayMode: 'inline',
          maxHeight: ${maxHeight},
          theme: ${serializedTheme || '"dark"'},
          locale: defaultLocale,
          safeArea: defaultSafeArea,
          userAgent: defaultUserAgent,
          widgetState: null,

          async setWidgetState(state) {
            this.widgetState = state;
            try {
              localStorage.setItem(widgetStateKey, JSON.stringify(state));
            } catch (err) {
              console.error('[OpenAI Widget] Failed to save widget state', err);
            }
            window.parent?.postMessage({
              type: 'openai:setWidgetState',
              toolId: ${JSON.stringify(resolvedToolCallId)},
              state
            }, '*');
            dispatchGlobalsEvent();
            scheduleHeightBroadcast();
          },

          async callTool(toolName, params = {}) {
            return new Promise((resolve, reject) => {
              const requestId = 'tool_' + Date.now() + '_' + Math.random();
              const handleMessage = (event) => {
                if (!event?.data || typeof event.data !== 'object') return;
                if (event.data.type !== 'openai:callTool:response' || event.data.requestId !== requestId) return;
                window.removeEventListener('message', handleMessage);
                if (event.data.error) {
                  reject(new Error(event.data.error));
                } else {
                  resolve(event.data.result);
                }
              };
              window.addEventListener('message', handleMessage);
              window.parent?.postMessage({
                type: 'openai:callTool',
                requestId,
                toolName,
                params
              }, '*');
              setTimeout(() => {
                window.removeEventListener('message', handleMessage);
                reject(new Error('Tool call timeout'));
              }, 30000);
            });
          },

          async sendFollowupTurn(message) {
            const payload = typeof message === 'string'
              ? { prompt: message }
              : (message || {});
            window.parent?.postMessage({
              type: 'openai:sendFollowup',
              message: payload.prompt || payload
            }, '*');
          },

          async sendFollowUpMessage(args) {
            const prompt = typeof args === 'string' ? args : (args?.prompt || '');
            return this.sendFollowupTurn(prompt);
          },

          async requestDisplayMode(options = {}) {
            const mode = options.mode || 'inline';
            this.displayMode = mode;
            if (typeof options.maxHeight === 'number') {
              this.maxHeight = options.maxHeight;
            }
            window.parent?.postMessage({
              type: 'openai:requestDisplayMode',
              mode,
              maxHeight: this.maxHeight
            }, '*');
            dispatchGlobalsEvent();
            scheduleHeightBroadcast();
            return { mode: this.displayMode };
          },

          async openExternal(options) {
            const href = typeof options === 'string' ? options : options?.href;
            if (!href) {
              throw new Error('href is required for openExternal');
            }
            window.parent?.postMessage({
              type: 'openai:openExternal',
              href
            }, '*');
            window.open(href, '_blank', 'noopener,noreferrer');
          }
        };

        Object.defineProperty(window, 'openai', {
          value: openaiAPI,
          writable: false,
          configurable: false,
          enumerable: true
        });

        Object.defineProperty(window, 'webplus', {
          value: openaiAPI,
          writable: false,
          configurable: false,
          enumerable: true
        });

        const dispatchGlobalsEvent = () => {
          try {
            const detail = {
              toolInput: openaiAPI.toolInput,
              toolOutput: openaiAPI.toolOutput,
              toolResponseMetadata: openaiAPI.toolResponseMetadata,
              widgetState: openaiAPI.widgetState,
              theme: openaiAPI.theme,
              displayMode: openaiAPI.displayMode,
              maxHeight: openaiAPI.maxHeight,
              locale: openaiAPI.locale,
              safeArea: openaiAPI.safeArea,
              userAgent: openaiAPI.userAgent
            };
            const webplusDetail = { globals: detail };
            window.dispatchEvent(new CustomEvent('openai:set_globals', { detail }));
            window.dispatchEvent(new CustomEvent('webplus:set_globals', { detail: webplusDetail }));
          } catch (err) {
            console.warn('[OpenAI Widget] Failed to dispatch globals event', err);
          }
        };

        let resizeRafId = null;
        let lastBroadcastedHeight = 0;
        const measureAndBroadcastHeight = () => {
          const doc = document.documentElement;
          const body = document.body;
          const heights = [
            doc ? doc.scrollHeight : 0,
            body ? body.scrollHeight : 0,
            doc ? doc.offsetHeight : 0,
            body ? body.offsetHeight : 0,
            doc ? doc.clientHeight : 0,
            body ? body.clientHeight : 0,
          ];
          const next = Math.max.apply(null, heights);
          if (!next || Math.abs(next - lastBroadcastedHeight) < 1) {
            return;
          }
          lastBroadcastedHeight = next;
          window.parent?.postMessage({ type: 'openai:resize', height: next }, '*');
        };

        const scheduleHeightBroadcast = () => {
          if (resizeRafId !== null) {
            cancelAnimationFrame(resizeRafId);
          }
          resizeRafId = requestAnimationFrame(() => {
            resizeRafId = null;
            measureAndBroadcastHeight();
          });
        };

        scheduleHeightBroadcast();

        if (typeof ResizeObserver !== 'undefined') {
          const resizeObserver = new ResizeObserver(scheduleHeightBroadcast);
          resizeObserver.observe(document.documentElement);
          resizeObserver.observe(document.body);
        } else {
          setInterval(measureAndBroadcastHeight, 500);
        }

        window.addEventListener('load', scheduleHeightBroadcast);
        window.addEventListener('resize', scheduleHeightBroadcast);

        const applyGlobalsUpdate = (globals) => {
          if (!globals || typeof globals !== 'object') {
            return;
          }
          if (globals.theme !== undefined) {
            openaiAPI.theme = globals.theme;
          }
          if (globals.displayMode !== undefined) {
            openaiAPI.displayMode = globals.displayMode;
          }
          if (globals.maxHeight !== undefined) {
            openaiAPI.maxHeight = globals.maxHeight;
          }
          if (globals.locale !== undefined) {
            openaiAPI.locale = globals.locale;
          }
          if (globals.toolInput !== undefined) {
            openaiAPI.toolInput = globals.toolInput;
          }
          if (globals.toolOutput !== undefined) {
            openaiAPI.toolOutput = globals.toolOutput;
          }
          if (globals.toolResponseMetadata !== undefined) {
            openaiAPI.toolResponseMetadata = globals.toolResponseMetadata;
          }
          if (globals.widgetState !== undefined) {
            openaiAPI.widgetState = globals.widgetState;
          }
          if (globals.safeArea !== undefined) {
            openaiAPI.safeArea = globals.safeArea;
          }
          if (globals.userAgent !== undefined) {
            openaiAPI.userAgent = globals.userAgent;
          }
          scheduleHeightBroadcast();
        };

        try {
          const stored = localStorage.getItem(widgetStateKey);
          if (stored) {
            openaiAPI.widgetState = JSON.parse(stored);
          }
        } catch (err) {
          console.warn('[OpenAI Widget] Failed to restore widget state', err);
        }

        dispatchGlobalsEvent();

        window.addEventListener('message', (event) => {
          if (!event?.data || typeof event.data !== 'object') {
            return;
          }

          const { type, detail, globals } = event.data;

          if (type === 'openai:set_globals' || type === 'webplus:set_globals') {
            const payload =
              (detail && typeof detail === 'object'
                ? detail.globals !== undefined
                  ? detail.globals
                  : detail
                : undefined) ?? globals ?? {};
            applyGlobalsUpdate(payload);
            dispatchGlobalsEvent();
          } else if (type === 'openai:tool_response') {
            const responseDetail = detail || {};
            window.dispatchEvent(new CustomEvent('openai:tool_response', { detail: responseDetail }));
          }
        });
      })();
    `;

    const serializedScript = `<script>${script.replace(/<\/script>/gi, "<\\/script>")}</script>`;
    const hasHtmlTag = /<html[\s>]/i.test(htmlContent);
    const hasHeadTag = /<head[\s>]/i.test(htmlContent);
    const hasBaseTag = /<base\s/i.test(htmlContent);
    const baseTag = hasBaseTag ? "" : '<base href="/" />';
    const headInjection = `${baseTag}${baseTag ? "\n" : ""}${serializedScript}\n`;

    let template: string;

    if (hasHtmlTag) {
      if (hasHeadTag) {
        template = htmlContent.replace(
          /<head([^>]*)>/i,
          (_match, headAttrs) => `<head${headAttrs}>${headInjection}`,
        );
      } else {
        template = htmlContent.replace(
          /<html([^>]*)>/i,
          (_match, htmlAttrs) =>
            `<html${htmlAttrs}><head>${headInjection}</head>`,
        );
      }
    } else {
      template = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="/" />
    ${serializedScript}
  </head>
  <body>
    ${htmlContent}
  </body>
</html>`;
    }
    return template;
  }, [
    htmlContent,
    resolvedToolInput,
    resolvedToolOutput,
    toolResponseMetadata,
    themeMode,
    widgetStateKey,
    resolvedToolCallId,
  ]);

  const appliedHeight = useMemo(
    () => Math.min(Math.max(contentHeight, 320), maxHeight),
    [contentHeight, maxHeight],
  );

  const iframeHeight = useMemo(() => {
    if (displayMode === "fullscreen") return "80vh";
    if (displayMode === "pip") return "400px";
    return `${appliedHeight}px`;
  }, [appliedHeight, displayMode]);

  const postGlobalsToIframe = useCallback(
    (overrides: Record<string, unknown> = {}) => {
      if (!isReady) return;
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow) return;

      const detail: Record<string, unknown> = {
        theme: themeMode,
        displayMode,
        maxHeight,
        locale: "en-US",
        toolInput: resolvedToolInput,
        toolOutput: resolvedToolOutput,
        toolResponseMetadata,
        widgetState: widgetStateRef.current,
      };

      const resolvedHeight =
        overrides.height !== undefined
          ? overrides.height
          : displayMode === "pip"
            ? 400
            : displayMode === "inline"
              ? appliedHeight
              : undefined;

      if (resolvedHeight !== undefined) {
        detail.height = resolvedHeight;
      }

      Object.assign(detail, overrides);

      iframeWindow.postMessage(
        {
          type: "openai:set_globals",
          detail,
        },
        "*",
      );

      iframeWindow.postMessage(
        {
          type: "webplus:set_globals",
          globals: detail,
          detail: { globals: detail },
        },
        "*",
      );
    },
    [
      appliedHeight,
      displayMode,
      isReady,
      maxHeight,
      themeMode,
      resolvedToolInput,
      resolvedToolOutput,
      toolResponseMetadata,
    ],
  );

  const emitToolResponse = useCallback((detail: Record<string, any>) => {
    const iframeWindow = iframeRef.current?.contentWindow;
    if (!iframeWindow) return;
    iframeWindow.postMessage(
      {
        type: "openai:tool_response",
        detail,
      },
      "*",
    );
  }, []);

  useEffect(() => {
    postGlobalsToIframe();
  }, [postGlobalsToIframe]);

  useEffect(() => {
    if (!isReady) return;
    const iframeWindow = iframeRef.current?.contentWindow;
    if (!iframeWindow) return;
    try {
      const doc = iframeWindow.document;
      doc?.documentElement?.classList.toggle("dark", themeMode === "dark");
    } catch (err) {
      console.debug("Unable to update iframe theme", err);
    }
  }, [themeMode, isReady]);

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      )
        return;

      const iframeWindow = iframeRef.current.contentWindow;
      const postResponse = (payload: Record<string, any>) => {
        iframeWindow?.postMessage(payload, "*");
      };

      switch (event.data?.type) {
        case "openai:resize": {
          const rawHeight = Number(event.data.height);
          if (Number.isFinite(rawHeight) && rawHeight > 0) {
            const nextHeight = Math.round(rawHeight);
            setContentHeight((prev) =>
              Math.abs(prev - nextHeight) > 1 ? nextHeight : prev,
            );
          }
          break;
        }
        case "openai:setWidgetState": {
          try {
            localStorage.setItem(
              widgetStateKey,
              JSON.stringify(event.data.state),
            );
          } catch (err) {
            console.warn("Failed to persist widget state", err);
          }
          widgetStateRef.current = event.data.state;
          break;
        }
        case "openai:callTool": {
          if (!onCallTool) {
            postResponse({
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              error: "callTool is not supported in this context",
            });
            emitToolResponse({
              requestId: event.data.requestId,
              toolName: event.data.toolName,
              params: event.data.params || {},
              error: "callTool is not supported in this context",
              status: "error",
            });
            break;
          }
          try {
            const result = await onCallTool(
              event.data.toolName,
              event.data.params || {},
            );
            postResponse({
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              result,
            });
            emitToolResponse({
              requestId: event.data.requestId,
              toolName: event.data.toolName,
              params: event.data.params || {},
              result,
              status: "completed",
            });
          } catch (err) {
            postResponse({
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              error: err instanceof Error ? err.message : "Unknown error",
            });
            emitToolResponse({
              requestId: event.data.requestId,
              toolName: event.data.toolName,
              params: event.data.params || {},
              error: err instanceof Error ? err.message : "Unknown error",
              status: "error",
            });
          }
          break;
        }
        case "openai:sendFollowup": {
          if (onSendFollowUp && typeof event.data.message === "string") {
            onSendFollowUp(event.data.message);
          }
          break;
        }
        case "openai:requestDisplayMode": {
          if (event.data.mode) {
            setDisplayMode(event.data.mode);
          }
          if (typeof event.data.maxHeight === "number") {
            setMaxHeight(event.data.maxHeight);
          }
          break;
        }
        case "openai:openExternal": {
          if (event.data.href && typeof event.data.href === "string") {
            window.open(event.data.href, "_blank", "noopener,noreferrer");
          }
          break;
        }
      }
    },
    [iframeRef, onCallTool, onSendFollowUp, widgetStateKey, emitToolResponse],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  if (isFetchingWidget) {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Loading OpenAI App widget template...
      </div>
    );
  }

  if (!htmlContent) {
    if (widgetFetchError) {
      return (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
          Failed to load widget template: {widgetFetchError}
          {tool_meta_outputTemplate && (
            <>
              {" "}
              (Template <code>{tool_meta_outputTemplate}</code>)
            </>
          )}
        </div>
      );
    }

    if (toolState !== "output-available") {
      return (
        <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
          Widget UI will appear once the tool finishes executing.
        </div>
      );
    }

    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Unable to render OpenAI App UI for this tool result.
        {tool_meta_outputTemplate && (
          <>
            {" "}
            (Missing HTML content for template{" "}
            <code>{tool_meta_outputTemplate}</code>)
          </>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      {loadError && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
          Failed to load widget: {loadError}
        </div>
      )}
      <iframe
        key={`${resolvedToolCallId}-${themeMode}`}
        ref={iframeRef}
        srcDoc={srcDoc || "<html><body>Loading...</body></html>"}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        title={`OpenAI App Widget: ${toolName || "tool"}`}
        allow="microphone *; midi *"
        className="border border-border/40 rounded-md bg-background h-full w-full max-w-full"
        style={{
          minHeight: "320px",
          height: iframeHeight,
          maxHeight: displayMode === "fullscreen" ? "90vh" : undefined,
        }}
        onLoad={() => {
          setIsReady(true);
          setLoadError(null);
        }}
        onError={() => {
          setLoadError("Iframe failed to load");
        }}
      />
      {tool_meta_outputTemplate && (
        <div className="text-[11px] text-muted-foreground/70">
          Template: <code>{tool_meta_outputTemplate}</code>
        </div>
      )}
    </div>
  );
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return (
      JSON.stringify(value, (_key, val) => {
        if (typeof val === "bigint") {
          return val.toString();
        }
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return undefined;
          }
          seen.add(val);
        }
        return val;
      }) ?? "null"
    );
  } catch (err) {
    console.warn("Failed to serialize value for Apps SDK", err);
    return "null";
  }
}
