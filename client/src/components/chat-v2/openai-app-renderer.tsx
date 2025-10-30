import {
  useMemo,
  useRef,
  useState,
  useEffect,
  useCallback,
} from "react";
import { DynamicToolUIPart } from "ai";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { readResource } from "@/lib/mcp-resources-api";

type DisplayMode = "inline" | "pip" | "fullscreen";

interface OpenAIAppRendererProps {
  part: DynamicToolUIPart;
  serverId: string;
  toolMetadata?: Record<string, any>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (toolName: string, params: Record<string, any>) => Promise<any>;
}

export function OpenAIAppRenderer({
  part,
  serverId,
  toolMetadata,
  onSendFollowUp,
  onCallTool,
}: OpenAIAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number>(600);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [isFetchingWidget, setIsFetchingWidget] = useState(false);
  const [widgetFetchError, setWidgetFetchError] = useState<string | null>(null);

  const toolCallId = part.toolCallId ?? `${part.toolName || "openai-app"}`;
  const widgetStateKey = useMemo(
    () => `openai-widget-state:${toolCallId}`,
    [toolCallId],
  );

  // Extract stuff from the Tool _meta field
  const tool_meta_outputTemplate = useMemo(
    () => toolMetadata?.["openai/outputTemplate"],
    [toolMetadata],
  );

  const { structuredContent, toolResponseMetadata } = useMemo(() => {
    return { structuredContent: (part as any).output?.structuredContent, toolResponseMetadata: null };
  }, [part.output]);

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
        console.log(data);
        const html = data.content.contents[0].text ?? null;
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
          err instanceof Error
            ? err.message
            : "Failed to load widget resource",
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

  const toolInput = useMemo(() => (part.input as Record<string, any>) ?? {}, [
    part.input,
  ]);

  const toolOutput = useMemo(() => structuredContent ?? part.output ?? null, [
    structuredContent,
    part.output,
  ]);

  const srcDoc = useMemo(() => {
    if (!htmlContent) return null;

    const serializedInput = safeJsonStringify(toolInput);
    const serializedOutput = safeJsonStringify(toolOutput);
    const serializedMetadata = safeJsonStringify(toolResponseMetadata);
    const serializedTheme = safeJsonStringify(themeMode);

    const script = String.raw`
      (function() {
        'use strict';

        const widgetStateKey = ${JSON.stringify(widgetStateKey)};
        const openaiAPI = {
          toolInput: ${serializedInput || "null"},
          toolOutput: ${serializedOutput || "null"},
          toolResponseMetadata: ${serializedMetadata || "null"},
          displayMode: 'inline',
          maxHeight: ${maxHeight},
          theme: ${serializedTheme || '"dark"'},
          locale: 'en-US',
          safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
          userAgent: { device: { type: 'desktop' }, capabilities: { hover: true, touch: false } },
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
              toolId: ${JSON.stringify(toolCallId)},
              state
            }, '*');
          },

          async callTool(toolName, params = {}) {
            return new Promise((resolve, reject) => {
              const requestId = 'tool_' + Date.now() + '_' + Math.random();
              const handler = (event) => {
                if (event.data && event.data.type === 'openai:callTool:response' && event.data.requestId === requestId) {
                  window.removeEventListener('message', handler);
                  if (event.data.error) {
                    reject(new Error(event.data.error));
                  } else {
                    resolve(event.data.result);
                  }
                }
              };
              window.addEventListener('message', handler);
              window.parent?.postMessage({
                type: 'openai:callTool',
                requestId,
                toolName,
                params
              }, '*');
              setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error('Tool call timeout'));
              }, 30000);
            });
          },

          async sendFollowupTurn(message) {
            const payload = typeof message === 'string'
              ? { prompt: message }
              : message;
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
            window.parent?.postMessage({
              type: 'openai:requestDisplayMode',
              mode
            }, '*');
            return { mode };
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

        const dispatchGlobals = () => {
          try {
            const globalsEvent = new CustomEvent('webplus:set_globals', {
              detail: {
                globals: {
                  displayMode: openaiAPI.displayMode,
                  maxHeight: openaiAPI.maxHeight,
                  theme: openaiAPI.theme,
                  locale: openaiAPI.locale,
                  safeArea: openaiAPI.safeArea,
                  userAgent: openaiAPI.userAgent
                }
              }
            });
            window.dispatchEvent(globalsEvent);
          } catch (err) {
            console.warn('[OpenAI Widget] Failed to dispatch globals event', err);
          }
        };

        dispatchGlobals();

        try {
          const stored = localStorage.getItem(widgetStateKey);
          if (stored) {
            openaiAPI.widgetState = JSON.parse(stored);
          }
        } catch (err) {
          console.warn('[OpenAI Widget] Failed to restore widget state', err);
        }

        window.addEventListener('message', (event) => {
          if (!event?.data || typeof event.data !== 'object') return;
          if (event.data.type === 'webplus:set_globals' && event.data.globals?.theme) {
            openaiAPI.theme = event.data.globals.theme;
            try {
              const globalsEvent = new CustomEvent('webplus:set_globals', {
                detail: { globals: { theme: event.data.globals.theme } }
              });
              window.dispatchEvent(globalsEvent);
            } catch (err) {
              console.warn('[OpenAI Widget] Failed to relay theme change', err);
            }
          }
        });
      })();
    `;

    const template = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base href="/" />
  </head>
  <body>
    ${htmlContent}
    <script>${script.replace(/<\/script>/gi, "<\\/script>")}</script>
  </body>
</html>`;

    return template;
  }, [
    htmlContent,
    toolInput,
    toolOutput,
    toolResponseMetadata,
    themeMode,
    widgetStateKey,
    toolCallId,
  ]);

  const iframeHeight = useMemo(() => {
    if (displayMode === "fullscreen") return "80vh";
    if (displayMode === "pip") return "400px";
    return `${Math.min(Math.max(maxHeight, 320), 900)}px`;
  }, [displayMode, maxHeight]);

  useEffect(() => {
    if (!isReady) return;
    const iframeWindow = iframeRef.current?.contentWindow;
    if (!iframeWindow) return;
    try {
      iframeWindow.postMessage(
        {
          type: "webplus:set_globals",
          globals: { theme: themeMode },
        },
        "*",
      );
      const doc = iframeWindow.document;
      doc?.documentElement?.classList.toggle("dark", themeMode === "dark");
    } catch (err) {
      console.debug("Unable to update iframe theme", err);
    }
  }, [themeMode, isReady]);

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow)
        return;

      const iframeWindow = iframeRef.current.contentWindow;
      const postResponse = (payload: Record<string, any>) => {
        iframeWindow?.postMessage(payload, "*");
      };

      switch (event.data?.type) {
        case "openai:setWidgetState": {
          try {
            localStorage.setItem(
              widgetStateKey,
              JSON.stringify(event.data.state),
            );
          } catch (err) {
            console.warn("Failed to persist widget state", err);
          }
          break;
        }
        case "openai:callTool": {
          if (!onCallTool) {
            postResponse({
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              error: "callTool is not supported in this context",
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
          } catch (err) {
            postResponse({
              type: "openai:callTool:response",
              requestId: event.data.requestId,
              error: err instanceof Error ? err.message : "Unknown error",
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
    [iframeRef, onCallTool, onSendFollowUp, widgetStateKey],
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
              {" "}(Template <code>{tool_meta_outputTemplate}</code>)
            </>
          )}
        </div>
      );
    }

    if (part.state !== "output-available") {
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
            {" "}(Missing HTML content for template <code>{tool_meta_outputTemplate}</code>)
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
        key={`${toolCallId}-${themeMode}`}
        ref={iframeRef}
        srcDoc={srcDoc ?? undefined}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        title={`OpenAI App Widget: ${part.toolName || "tool"}`}
        allow="web-share"
        className="w-full border border-border/40 rounded-md bg-background"
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
