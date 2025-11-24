import { Hono } from "hono";
import "../../types/hono";
import { handleJsonRpc, BridgeMode } from "../../services/mcp-http-bridge";
import {
  widgetDataStore,
  getOpenAiBridgeScript,
  extractHtmlContent,
  processLocalhostUrls,
  injectBridgeScript,
} from "./widget-utils";

// In-memory SSE session store per serverId:sessionId
type Session = {
  send: (event: string, data: string) => void;
  close: () => void;
};
const sessions: Map<string, Session> = new Map();
const latestSessionByServer: Map<string, string> = new Map();

// Unified HTTP adapter that handles both adapter-http and manager-http routes
// with the same robust implementation but different JSON-RPC response modes

function createHttpHandler(mode: BridgeMode, routePrefix: string) {
  const router = new Hono();

  router.options("/:serverId", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
      "Access-Control-Allow-Headers":
        "*, Authorization, Content-Type, Accept, Accept-Language",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400",
    }),
  );

  // Wildcard variants to tolerate trailing paths (e.g., /mcp)
  router.options("/:serverId/*", (c) =>
    c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
      "Access-Control-Allow-Headers":
        "*, Authorization, Content-Type, Accept, Accept-Language",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400",
    }),
  );

  async function handleHttp(c: any) {
    const serverId = c.req.param("serverId");
    const method = c.req.method;
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Check if this is a widget-related request and handle it specially
    if (pathname.includes('/widget/store') && method === 'POST') {
      try {
        const body = await c.req.json();
        const {
          uri,
          toolInput,
          toolOutput,
          toolResponseMetadata,
          toolId,
          toolName,
          theme,
        } = body;

        if (!serverId || !uri || !toolId || !toolName) {
          return c.json({ success: false, error: "Missing required fields" }, 400);
        }

        // Store widget data directly in the shared widget data store
        widgetDataStore.set(toolId, {
          serverId,
          uri,
          toolInput,
          toolOutput,
          toolResponseMetadata: toolResponseMetadata ?? null,
          toolId,
          toolName,
          theme: theme ?? "dark",
          timestamp: Date.now(),
        });

        return c.json({ success: true }, 200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "*",
        });
      } catch (error: any) {
        console.error("Error storing widget data:", error);
        return c.json({ success: false, error: error.message }, 500);
      }
    }

    // Check for widget container request
    // For ChatGPT compatibility, we need to return the widget HTML directly, not a JS loader
    if (pathname.includes('/widget/') && !pathname.includes('/widget-content/') && !pathname.includes('/widget/store') && method === 'GET') {
      try {
        const match = pathname.match(/\/widget\/([^/]+)$/);
        if (match) {
          const toolId = match[1];

          // Retrieve widget data from storage
          const widgetData = widgetDataStore.get(toolId);
          if (!widgetData) {
            return c.html(
              "<html><body>Error: Widget data not found or expired</body></html>",
              404,
              {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "*",
              }
            );
          }

          const {
            serverId: widgetServerId,
            uri,
            toolInput,
            toolOutput,
            toolResponseMetadata,
            toolName,
            theme,
          } = widgetData;

          const mcpClientManager = c.mcpClientManager;
          const availableServers = mcpClientManager
            .listServers()
            .filter((id: string) => Boolean(mcpClientManager.getClient(id)));

          // Normalize serverId
          let actualServerId = widgetServerId;
          if (!availableServers.includes(widgetServerId)) {
            const match = availableServers.find(
              (name: string) => name.toLowerCase() === widgetServerId.toLowerCase(),
            );
            if (match) {
              actualServerId = match;
            } else {
              return c.html(
                `<html><body>
                  <h3>Error: Server not connected</h3>
                  <p>Requested server: ${widgetServerId}</p>
                  <p>Available servers: ${availableServers.join(", ")}</p>
                </body></html>`,
                404,
                {
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Expose-Headers": "*",
                }
              );
            }
          }

          // Read the widget HTML from MCP server
          const content = await mcpClientManager.readResource(actualServerId, {
            uri,
          });

          let htmlContent = extractHtmlContent(content);

          if (!htmlContent) {
            return c.html(
              "<html><body>Error: No HTML content found</body></html>",
              404,
              {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "*",
              }
            );
          }

          // Rewrite localhost URLs to route through our proxy
          const requestUrl = new URL(c.req.url);
          const forwardedProto = c.req.header('x-forwarded-proto') || c.req.header('x-forwarded-protocol');

          const {
            htmlContent: processedHtml,
            hasLocalhostUrls,
            primaryLocalhostUrl,
            baseUrl
          } = processLocalhostUrls(
            htmlContent,
            requestUrl,
            forwardedProto,
            pathname,
            '/widget'
          );

          htmlContent = processedHtml;

          // OpenAI Apps SDK bridge script - complete implementation
          const apiScript = getOpenAiBridgeScript(
            toolInput,
            toolOutput,
            toolResponseMetadata,
            theme,
            toolId,
            toolName
          );

          // Inject the bridge script and base tag into the HTML
          // Add base tag if we're proxying localhost URLs for dynamic resource loading
          const baseTag = hasLocalhostUrls && primaryLocalhostUrl
            ? `<base href="${baseUrl}${pathname.replace(/\/widget\/[^/]+$/, `/widget-proxy/${encodeURIComponent(primaryLocalhostUrl)}`)}/">`
            : '';

          const modifiedHtml = injectBridgeScript(htmlContent, apiScript, baseTag);

          return c.html(modifiedHtml, 200, {
            "Content-Type": "text/html",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "*",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          });
        }
      } catch (error: any) {
        console.error("Error serving widget container:", error);
        return c.html(`<html><body>Error: ${error.message}</body></html>`, 500, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "*",
        });
      }
    }

    // Check for widget proxy request (proxies widget static assets from localhost)
    if (pathname.includes('/widget-proxy/') && method === 'GET') {
      try {
        const match = pathname.match(/\/widget-proxy\/([^/]+)(\/.*)?$/);
        if (match) {
          const encodedBaseUrl = match[1];
          const resourcePath = match[2] || '';
          const baseUrl = decodeURIComponent(encodedBaseUrl);

          // Construct the full URL to the widget server
          const targetUrl = `${baseUrl}${resourcePath}`;

          // Fetch the resource from the widget server
          const response = await fetch(targetUrl);

          if (!response.ok) {
            return c.body(`Proxy error: ${response.statusText}`, response.status, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Expose-Headers": "*",
            });
          }

          // Get the content type
          const contentType = response.headers.get('content-type') || 'application/octet-stream';

          // Stream the response back
          const body = await response.arrayBuffer();

          return c.body(body, response.status, {
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "*",
            "Cache-Control": "public, max-age=31536000, immutable",
          });
        }
      } catch (error: any) {
        console.error("Error proxying widget resource:", error);
        return c.text(`Proxy error: ${error.message}`, 500, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "*",
        });
      }
    }

    // Check for widget-content request
    if (pathname.includes('/widget-content/') && method === 'GET') {
      try {
        const match = pathname.match(/\/widget-content\/([^/]+)$/);
        if (match) {
          const toolId = match[1];

          // Retrieve widget data from storage
          const widgetData = widgetDataStore.get(toolId);
          if (!widgetData) {
            return c.html(
              "<html><body>Error: Widget data not found or expired</body></html>",
              404,
              {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "*",
              }
            );
          }

          const {
            serverId: widgetServerId,
            uri,
            toolInput,
            toolOutput,
            toolResponseMetadata,
            toolName,
            theme,
          } = widgetData;

          const mcpClientManager = c.mcpClientManager;
          const availableServers = mcpClientManager
            .listServers()
            .filter((id: string) => Boolean(mcpClientManager.getClient(id)));

          let actualServerId = widgetServerId;
          if (!availableServers.includes(widgetServerId)) {
            const match = availableServers.find(
              (name: string) => name.toLowerCase() === widgetServerId.toLowerCase(),
            );
            if (match) {
              actualServerId = match;
            } else {
              return c.html(
                `<html><body>
                  <h3>Error: Server not connected</h3>
                  <p>Requested server: ${widgetServerId}</p>
                  <p>Available servers: ${availableServers.join(", ")}</p>
                </body></html>`,
                404,
                {
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Expose-Headers": "*",
                }
              );
            }
          }

          // Read the widget HTML from MCP server
          const content = await mcpClientManager.readResource(actualServerId, {
            uri,
          });

          let htmlContent = extractHtmlContent(content);

          if (!htmlContent) {
            return c.html(
              "<html><body>Error: No HTML content found</body></html>",
              404,
              {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "*",
              }
            );
          }

          // Rewrite localhost URLs to route through our proxy
          // This fixes CORS issues when widget resources are on localhost
          const requestUrl = new URL(c.req.url);
          const forwardedProto = c.req.header('x-forwarded-proto') || c.req.header('x-forwarded-protocol');

          const {
            htmlContent: processedHtml
          } = processLocalhostUrls(
            htmlContent,
            requestUrl,
            forwardedProto,
            pathname,
            '/widget-content'
          );

          htmlContent = processedHtml;

          // OpenAI Apps SDK bridge script
          const apiScript = getOpenAiBridgeScript(
            toolInput,
            toolOutput,
            toolResponseMetadata,
            theme,
            toolId,
            toolName
          );

          // Inject the bridge script into the HTML
          const modifiedHtml = injectBridgeScript(htmlContent, apiScript, '<base href="/">');

          // Security headers
          const trustedCdns = [
            "https://persistent.oaistatic.com",
            "https://*.oaistatic.com",
            "https://unpkg.com",
            "https://cdn.jsdelivr.net",
            "https://cdnjs.cloudflare.com",
            "https://cdn.skypack.dev",
            "https://apps-sdk-widgets.vercel.app",
            "https://dynamic.heygen.ai",
            "https://static.heygen.ai",
            "https://files2.heygen.ai",
          ].join(" ");

          const headers: Record<string, string> = {
            "Content-Security-Policy": [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${trustedCdns}`,
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              `style-src 'self' 'unsafe-inline' ${trustedCdns}`,
              "img-src 'self' data: https: blob:",
              "media-src 'self' data: https: blob:",
              `font-src 'self' data: ${trustedCdns}`,
              "connect-src 'self' https: wss: ws:",
              "frame-ancestors 'self'",
            ].join("; "),
            "X-Frame-Options": "SAMEORIGIN",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "*",
          };

          return c.html(modifiedHtml, 200, headers);
        }
      } catch (error: any) {
        console.error("Error serving widget content:", error);
        return c.html(
          `<html><body>Error: ${error.message}</body></html>`,
          500,
          {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "*",
          }
        );
      }
    }

    // SSE endpoint for clients that probe/subscribe via GET; HEAD advertises event-stream
    if (method === "HEAD") {
      return c.body(null, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
    }
    if (method === "GET") {
      const encoder = new TextEncoder();
      const incomingUrl = new URL(c.req.url);
      // Allow proxy to override the endpoint base so the client posts back through the proxy
      const overrideBase = c.req.header("x-mcpjam-endpoint-base");
      let endpointBase: string;
      if (overrideBase && overrideBase.trim() !== "") {
        endpointBase = overrideBase.trim();
      } else {
        // Compute an absolute endpoint based on forwarded headers when present
        // so direct access (without the proxy) advertises a reachable URL.
        const xfProto = c.req.header("x-forwarded-proto");
        const xfHost = c.req.header("x-forwarded-host");
        const host = xfHost || c.req.header("host");
        let proto = xfProto;
        if (!proto) {
          const originHeader = c.req.header("origin");
          if (originHeader && /^https:/i.test(originHeader)) proto = "https";
        }
        if (!proto) proto = "http";
        const origin = host ? `${proto}://${host}` : incomingUrl.origin;
        endpointBase = `${origin}/api/mcp/${routePrefix}/${serverId}/messages`;
      }
      const sessionId = crypto.randomUUID();
      let timer: any;
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: string) => {
            controller.enqueue(encoder.encode(`event: ${event}\n`));
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          };
          const close = () => {
            try {
              controller.close();
            } catch { }
          };

          // Register session
          sessions.set(`${serverId}:${sessionId}`, { send, close });
          latestSessionByServer.set(serverId, sessionId);

          // Ping and endpoint per SSE transport handshake
          send("ping", "");
          const sep = endpointBase.includes("?") ? "&" : "?";
          const url = `${endpointBase}${sep}sessionId=${sessionId}`;
          // Emit endpoint as JSON (spec-friendly) then as a plain string (compat).
          try {
            send("endpoint", JSON.stringify({ url, headers: {} }));
          } catch { }
          try {
            send("endpoint", url);
          } catch { }

          // Periodic keepalive comments so proxies don't buffer/close
          timer = setInterval(() => {
            try {
              controller.enqueue(
                encoder.encode(`: keepalive ${Date.now()}\n\n`),
              );
            } catch { }
          }, 15000);
        },
        cancel() {
          try {
            clearInterval(timer);
          } catch { }
          sessions.delete(`${serverId}:${sessionId}`);
          // If this session was the latest for this server, clear pointer
          if (latestSessionByServer.get(serverId) === sessionId) {
            latestSessionByServer.delete(serverId);
          }
        },
      });
      return c.body(stream as any, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
    }

    if (method !== "POST") {
      return c.json({ error: "Unsupported request" }, 400);
    }

    // Parse JSON body (best effort)
    let body: any = undefined;
    try {
      body = await c.req.json();
    } catch { }

    const clientManager = c.mcpClientManager;

    // Normalize serverId - try to find a case-insensitive match if exact match fails
    let normalizedServerId = serverId;
    const availableServers = clientManager
      .listServers()
      .filter((id: string) => Boolean(clientManager.getClient(id)));

    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name: string) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        normalizedServerId = match;
      }
    }

    const response = await handleJsonRpc(
      normalizedServerId,
      body as any,
      clientManager,
      mode,
    );
    if (!response) {
      // Notification → 202 Accepted
      return c.body("Accepted", 202, { "Access-Control-Allow-Origin": "*" });
    }
    return c.body(JSON.stringify(response), 200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    });
  }

  // Endpoint to receive client messages for SSE transport: /:serverId/messages?sessionId=...
  router.post("/:serverId/messages", async (c) => {
    const serverId = c.req.param("serverId");
    const url = new URL(c.req.url);
    const sessionId = url.searchParams.get("sessionId") || "";
    const key = `${serverId}:${sessionId}`;
    let sess = sessions.get(key);
    if (!sess) {
      const fallbackId = latestSessionByServer.get(serverId);
      if (fallbackId) {
        sess = sessions.get(`${serverId}:${fallbackId}`);
      }
    }
    if (!sess) {
      return c.json({ error: "Invalid session" }, 400);
    }
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      try {
        const txt = await c.req.text();
        body = txt ? JSON.parse(txt) : undefined;
      } catch {
        body = undefined;
      }
    }
    const id = body?.id ?? null;
    const method = body?.method as string | undefined;
    const params = body?.params ?? {};

    // Normalize serverId - try to find a case-insensitive match if exact match fails
    let normalizedServerId = serverId;
    const availableServers = c.mcpClientManager
      .listServers()
      .filter((id: string) => Boolean(c.mcpClientManager.getClient(id)));

    if (!availableServers.includes(serverId)) {
      const match = availableServers.find(
        (name: string) => name.toLowerCase() === serverId.toLowerCase(),
      );
      if (match) {
        normalizedServerId = match;
      }
    }

    // Reuse the JSON-RPC handling via bridge
    try {
      const responseMessage = await handleJsonRpc(
        normalizedServerId,
        { id, method, params },
        c.mcpClientManager,
        mode,
      );
      // If there is a JSON-RPC response, emit it over SSE to the client
      if (responseMessage) {
        try {
          sess.send("message", JSON.stringify(responseMessage));
        } catch { }
      }
      // 202 Accepted per SSE transport semantics
      return c.body("Accepted", 202, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
      });
    } catch (e: any) {
      return c.body("Error", 400, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
      });
    }
  });

  // Register catch-all handlers AFTER the messages route so it isn't shadowed
  // Widget requests are handled inside handleHttp function
  router.all("/:serverId", handleHttp);
  router.all("/:serverId/*", handleHttp);

  return router;
}

// Create both adapters with their respective modes
export const adapterHttp = createHttpHandler("adapter", "adapter-http");
export const managerHttp = createHttpHandler("manager", "manager-http");

// Export default for backward compatibility (adapter)
export default adapterHttp;
