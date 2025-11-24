
// In-memory storage for widget data (TTL: 1 hour)
export interface WidgetData {
  serverId: string;
  uri: string;
  toolInput: Record<string, any>;
  toolOutput: any;
  toolResponseMetadata?: Record<string, any> | null;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  timestamp: number;
}

// Export the widget data store so it can be accessed by the adapter-http proxy
export const widgetDataStore = new Map<string, WidgetData>();

// Cleanup expired widget data every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [toolId, data] of widgetDataStore.entries()) {
      if (now - data.timestamp > ONE_HOUR) {
        widgetDataStore.delete(toolId);
      }
    }
  },
  5 * 60 * 1000,
).unref();

export const serializeForInlineScript = (value: unknown) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export function getOpenAiBridgeScript(
  toolInput: any,
  toolOutput: any,
  toolResponseMetadata: any,
  theme: string | undefined,
  toolId: string,
  toolName: string,
  viewMode?: string,
  viewParams?: any
) {
  const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;

  return `
    <script>
      (function() {
        'use strict';

        const openaiAPI = {
          toolInput: ${serializeForInlineScript(toolInput)},
          toolOutput: ${serializeForInlineScript(toolOutput)},
          toolResponseMetadata: ${serializeForInlineScript(toolResponseMetadata)},
          displayMode: 'inline',
          maxHeight: 600,
          theme: ${JSON.stringify(theme ?? "dark")},
          locale: 'en-US',
          safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
          userAgent: {
            device: { type: 'desktop' },
            capabilities: { hover: true, touch: false }
          },
          view: {
            mode: ${JSON.stringify(viewMode ?? "inline")},
            params: ${serializeForInlineScript(viewParams ?? {})}
          },
          widgetState: null,

          async setWidgetState(state) {
            this.widgetState = state;
            try {
              localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(state));
            } catch (err) {
            }
            window.parent.postMessage({
              type: 'openai:setWidgetState',
              toolId: ${JSON.stringify(toolId)},
              state
            }, '*');
          },

          async callTool(toolName, params = {}) {
            return new Promise((resolve, reject) => {
              const requestId = \`tool_\${Date.now()}_\${Math.random()}\`;
              const handler = (event) => {
                if (event.data.type === 'openai:callTool:response' &&
                    event.data.requestId === requestId) {
                  window.removeEventListener('message', handler);
                  if (event.data.error) {
                    reject(new Error(event.data.error));
                  } else {
                    resolve(event.data.result);
                  }
                }
              };
              window.addEventListener('message', handler);
              window.parent.postMessage({
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
            window.parent.postMessage({
              type: 'openai:sendFollowup',
              message: payload.prompt || payload
            }, '*');
          },

          async requestDisplayMode(options = {}) {
            const mode = options.mode || 'inline';
            this.displayMode = mode;
            window.parent.postMessage({
              type: 'openai:requestDisplayMode',
              mode
            }, '*');
            return { mode };
          },

          async sendFollowUpMessage(args) {
            const prompt = typeof args === 'string' ? args : (args?.prompt || '');
            return this.sendFollowupTurn(prompt);
          },

          async openExternal(options) {
            const href = typeof options === 'string' ? options : options?.href;
            if (!href) {
              throw new Error('href is required for openExternal');
            }
            window.parent.postMessage({
              type: 'openai:openExternal',
              href
            }, '*');
            window.open(href, '_blank', 'noopener,noreferrer');
          },

          async requestModal(options) {
            window.parent.postMessage({
              type: 'openai:requestModal',
              title: options.title,
              params: options.params,
              anchor: options.anchor
            }, '*');
          }
        };

        // Define window.openai
        Object.defineProperty(window, 'openai', {
          value: openaiAPI,
          writable: false,
          configurable: false,
          enumerable: true
        });

        // Define window.webplus (alias)
        Object.defineProperty(window, 'webplus', {
          value: openaiAPI,
          writable: false,
          configurable: false,
          enumerable: true
        });

        // Dispatch initial globals event
        setTimeout(() => {
          try {
            const globalsEvent = new CustomEvent('openai:set_globals', {
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
            console.error('[OpenAI Widget] Failed to dispatch globals event:', err);
          }
        }, 0);

        // Restore widget state from localStorage
        setTimeout(() => {
          try {
            const stored = localStorage.getItem(${JSON.stringify(widgetStateKey)});
            if (stored && window.openai) {
              window.openai.widgetState = JSON.parse(stored);
            }
          } catch (err) {
            console.error('[OpenAI Widget] Failed to restore widget state:', err);
          }
        }, 0);

        // Listen for theme changes from parent
        window.addEventListener('message', (event) => {
          if (event.data.type === 'openai:set_globals') {
            const { globals } = event.data;

            if (globals?.theme && window.openai) {
              window.openai.theme = globals.theme;

              // Dispatch event for widgets that use useTheme() hook
              try {
                const globalsEvent = new CustomEvent('openai:set_globals', {
                  detail: { globals: { theme: globals.theme } }
                });
                window.dispatchEvent(globalsEvent);
              } catch (err) {
                console.error('[OpenAI Widget] Failed to dispatch theme change:', err);
              }
            }
          }

          if (event.data.type === 'openai:pushWidgetState' && event.data.toolId === ${JSON.stringify(toolId)}) {
            try {
              const nextState = event.data.state ?? null;
              window.openai.widgetState = nextState;
              try {
                localStorage.setItem(${JSON.stringify(widgetStateKey)}, JSON.stringify(nextState));
              } catch (err) {
              }
              try {
                const stateEvent = new CustomEvent('openai:widget_state', {
                  detail: { state: nextState }
                });
                window.dispatchEvent(stateEvent);
              } catch (err) {
                console.error('[OpenAI Widget] Failed to dispatch widget state event:', err);
              }
            } catch (err) {
              console.error('[OpenAI Widget] Failed to apply pushed widget state:', err);
            }
          }
        });
      })();
    </script>
  `;
}

export function extractHtmlContent(content: any): string | null {
  let htmlContent = "";
  const contentsArray = Array.isArray(content?.contents)
    ? content.contents
    : [];

  const firstContent = contentsArray[0];
  if (firstContent) {
    if (typeof (firstContent as { text?: unknown }).text === "string") {
      htmlContent = (firstContent as { text: string }).text;
    } else if (
      typeof (firstContent as { blob?: unknown }).blob === "string"
    ) {
      htmlContent = (firstContent as { blob: string }).blob;
    }
  }

  if (!htmlContent && content && typeof content === "object") {
    const recordContent = content as Record<string, unknown>;
    if (typeof recordContent.text === "string") {
      htmlContent = recordContent.text;
    } else if (typeof recordContent.blob === "string") {
      htmlContent = recordContent.blob;
    }
  }

  return htmlContent || null;
}

export function processLocalhostUrls(
  htmlContent: string,
  requestUrl: URL,
  forwardedProto: string | undefined,
  pathname: string,
  proxyPathPrefix: string
): { htmlContent: string; hasLocalhostUrls: boolean; primaryLocalhostUrl: string | null; baseUrl: string } {
  const localhostUrlRegex = /(https?:\/\/localhost:\d+)/g;
  const localhostMatches = htmlContent.match(localhostUrlRegex);

  const protocol = forwardedProto || requestUrl.protocol.replace(':', '');
  const baseUrl = `${protocol}://${requestUrl.host}`;

  let hasLocalhostUrls = false;
  let primaryLocalhostUrl: string | null = null;

  if (localhostMatches && localhostMatches.length > 0) {
    hasLocalhostUrls = true;
    const uniqueLocalhosts = [...new Set(localhostMatches)];
    primaryLocalhostUrl = uniqueLocalhosts[0];

    for (const localhostUrl of uniqueLocalhosts) {
      const proxyPath = pathname.replace(new RegExp(`${proxyPathPrefix}/[^/]+$`), `/widget-proxy/${encodeURIComponent(localhostUrl)}`);
      const proxyUrl = `${baseUrl}${proxyPath}`;
      htmlContent = htmlContent.replace(new RegExp(localhostUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), proxyUrl);
    }
  }

  return { htmlContent, hasLocalhostUrls, primaryLocalhostUrl, baseUrl };
}

export function injectBridgeScript(
  htmlContent: string,
  apiScript: string,
  baseTag: string = ''
): string {
  if (htmlContent.includes("<html>") && htmlContent.includes("<head>")) {
    return htmlContent.replace(
      "<head>",
      `<head>${baseTag}${apiScript}`,
    );
  } else {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${baseTag}
  ${apiScript}
</head>
<body>
  ${htmlContent}
</body>
</html>`;
  }
}
