import { Hono } from "hono";
import "../../types/hono"; // Type extensions

const resources = new Hono();

// List resources endpoint
resources.post("/list", async (c) => {
  try {
    const { serverId } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpJamClientManager;
    const serverResources = mcpClientManager.getResourcesForServer(serverId);
    return c.json({ resources: { [serverId]: serverResources } });
  } catch (error) {
    console.error("Error fetching resources:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Read resource endpoint
resources.post("/read", async (c) => {
  try {
    const { serverId, uri } = await c.req.json();

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }

    if (!uri) {
      return c.json(
        {
          success: false,
          error: "Resource URI is required",
        },
        400,
      );
    }

    const mcpClientManager = c.mcpJamClientManager;

    const content = await mcpClientManager.getResource(uri, serverId);

    return c.json({ content });
  } catch (error) {
    console.error("Error reading resource:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Serve OpenAI widget HTML with injected API
resources.get("/openai-widget/:serverId/:uri", async (c) => {
  try {
    const serverId = c.req.param("serverId");
    const encodedUri = c.req.param("uri");
    const uri = decodeURIComponent(encodedUri);

    // Get query params for tool data
    const toolInput = c.req.query("toolInput") || "{}";
    const toolOutput = c.req.query("toolOutput") || "null";
    const toolId = c.req.query("toolId") || "unknown";

    const mcpClientManager = c.mcpJamClientManager;
    const connectedServers = mcpClientManager.getConnectedServers();

    // Try to find the actual server ID
    let actualServerId = serverId;
    if (!connectedServers[serverId]) {
      // Try to find a server that matches (case-insensitive)
      const serverNames = Object.keys(connectedServers);
      const match = serverNames.find(
        (name) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        actualServerId = match;
      } else {
        return c.html(
          `<html><body>
            <h3>Error: Server not connected</h3>
            <p>Requested server: ${serverId}</p>
            <p>Available servers: ${serverNames.join(", ")}</p>
          </body></html>`,
          404,
        );
      }
    }

    const content = await mcpClientManager.getResource(uri, actualServerId);

    // Extract HTML from content
    let htmlContent = "";
    if (Array.isArray(content)) {
      htmlContent = content[0]?.text || content[0]?.blob || "";
    } else if (content && typeof content === "object") {
      htmlContent = (content as any).text || (content as any).blob || "";
      if (!htmlContent && Array.isArray((content as any).contents)) {
        htmlContent =
          (content as any).contents[0]?.text ||
          (content as any).contents[0]?.blob ||
          "";
      }
    }

    if (!htmlContent) {
      return c.html(
        "<html><body>Error: No HTML content found</body></html>",
        404,
      );
    }

    // Restore widget state from localStorage if available
    const widgetStateKey = `openai-widget-state:${toolId}`;

    // Inject window.openai API with full Apps SDK compatibility
    // Define it IMMEDIATELY before any other code can execute
    const apiScript = `
      <script>
        // ===== CRITICAL: Define window.openai IMMEDIATELY =====
        // This must happen BEFORE any other code runs, including React hydration
        
        // Ensure window.openai doesn't exist yet
        if (window.openai) {
          console.warn('[OpenAI Widget] window.openai already exists, overwriting');
        }
        
        // Define window.openai SYNCHRONOUSLY with direct properties
        // The OpenAI Apps SDK components access these directly, not through methods
        var openaiAPI = {
          // Tool data (immutable)
          toolInput: ${toolInput},
          toolOutput: ${toolOutput},
          
          // Layout globals (mutable, components access these directly)
          displayMode: 'inline',
          maxHeight: 600,
          theme: 'dark',
          locale: 'en-US',
          safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
          userAgent: {},
          widgetState: null,

          // Persist widget state
          setWidgetState: async function(state) {
            this.widgetState = state;
            try {
              localStorage.setItem('${widgetStateKey}', JSON.stringify(state));
              console.log('[OpenAI Widget] Saved widget state:', state);
            } catch (err) {
              console.error('[OpenAI Widget] Failed to save widget state:', err);
            }
            window.parent.postMessage({
              type: 'openai:setWidgetState',
              toolId: '${toolId}',
              state: state
            }, '*');
          },

          // Call MCP tool
          callTool: async function(toolName, params) {
            return new Promise(function(resolve, reject) {
              var requestId = 'tool_' + Date.now() + '_' + Math.random();
              
              var handler = function(event) {
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
              
              // Send request
              window.parent.postMessage({
                type: 'openai:callTool',
                requestId: requestId,
                toolName: toolName,
                params: params || {}
              }, '*');
              
              // Timeout after 30 seconds
              setTimeout(function() {
                window.removeEventListener('message', handler);
                reject(new Error('Tool call timeout'));
              }, 30000);
            });
          },

          // Send follow-up message (OpenAI name)
          sendFollowupTurn: async function(message) {
            var payload = typeof message === 'string' 
              ? { prompt: message }
              : message;
            
            window.parent.postMessage({
              type: 'openai:sendFollowup',
              message: payload.prompt || payload
            }, '*');
          },

          // Send follow-up message (Webplus name - alias for compatibility)
          sendFollowUpMessage: async function(args) {
            var prompt = typeof args === 'string' ? args : (args && args.prompt) || '';
            window.parent.postMessage({
              type: 'openai:sendFollowup',
              message: prompt
            }, '*');
          },

          // Request display mode change
          requestDisplayMode: async function(options) {
            var mode = (options && options.mode) || 'inline';
            this.displayMode = mode;
            
            window.parent.postMessage({
              type: 'openai:requestDisplayMode',
              mode: mode
            }, '*');
            
            return { mode: mode };
          },

          // Completion APIs (stub implementations for compatibility)
          callCompletion: async function(request) {
            console.warn('[OpenAI Widget] callCompletion not implemented');
            return {
              content: { type: 'text', text: '' },
              model: 'mock',
              role: 'assistant'
            };
          },

          streamCompletion: async function* (request) {
            console.warn('[OpenAI Widget] streamCompletion not implemented');
            return;
          }
        };

        // Assign to BOTH window.webplus (original) and window.openai (alias)
        // OpenAI components check for window.webplus first!
        Object.defineProperty(window, 'webplus', {
          value: openaiAPI,
          writable: false,
          configurable: false,
          enumerable: true
        });

        Object.defineProperty(window, 'openai', {
          value: openaiAPI,
          writable: false,
          configurable: false,
          enumerable: true
        });

        // Fire initial globals event for components that use useSyncExternalStore
        // OpenAI components listen for 'webplus:set_globals' event (not openai:set_globals!)
        try {
          var globalsEvent = new CustomEvent('webplus:set_globals', {
            detail: {
              globals: {
                displayMode: 'inline',
                maxHeight: 600,
                theme: 'dark',
                locale: 'en-US',
                safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
                userAgent: {}
              }
            }
          });
          window.dispatchEvent(globalsEvent);
        } catch (err) {
          // Silently fail
        }

        // Try to restore widget state asynchronously (won't block component initialization)
        setTimeout(function() {
          try {
            var stored = localStorage.getItem('${widgetStateKey}');
            if (stored && window.openai) {
              window.openai.widgetState = JSON.parse(stored);
            }
          } catch (err) {
            // Silently fail
          }
        }, 0);
      </script>
    `;

    // Create proper HTML structure with our script executing FIRST
    // The pizzaz HTML is just fragments (no html/head/body tags), so we wrap it properly
    let modifiedHtml;

    if (htmlContent.includes("<html>") && htmlContent.includes("<head>")) {
      // Already has proper structure, inject at start of head
      modifiedHtml = htmlContent.replace("<head>", "<head>" + apiScript);
    } else {
      // Create full HTML structure with our script BEFORE any content
      modifiedHtml = `<!DOCTYPE html>
<html>
<head>
  ${apiScript}
</head>
<body>
  ${htmlContent}
</body>
</html>`;
    }

    return c.html(modifiedHtml);
  } catch (error) {
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

export default resources;
