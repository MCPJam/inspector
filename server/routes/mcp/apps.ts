/**
 * MCP Apps (SEP-1865) Server Routes
 *
 * Provides endpoints for storing widget data and serving widget HTML
 * with injected MCP Apps client script.
 *
 * This follows the same pattern as openai.ts but uses the SEP-1865
 * JSON-RPC 2.0 protocol for widget communication.
 */

import { Hono } from "hono";
import "../../types/hono";

const apps = new Hono();

// Widget data store - SAME PATTERN as openai.ts
interface WidgetData {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolId: string;
  toolName: string;
  theme?: "light" | "dark";
  protocol: "mcp-apps";
  timestamp: number;
}

const widgetDataStore = new Map<string, WidgetData>();

// Safe JSON serialization for inline scripts
const serializeForInlineScript = (value: unknown) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// Cleanup expired data every 5 minutes - SAME as openai.ts
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

// Store widget data - SAME pattern as openai.ts
apps.post("/widget/store", async (c) => {
  try {
    const body = await c.req.json();
    const {
      serverId,
      resourceUri,
      toolInput,
      toolOutput,
      toolId,
      toolName,
      theme,
      protocol,
    } = body;

    if (!serverId || !resourceUri || !toolId || !toolName) {
      return c.json({ success: false, error: "Missing required fields" }, 400);
    }

    widgetDataStore.set(toolId, {
      serverId,
      resourceUri,
      toolInput,
      toolOutput,
      toolId,
      toolName,
      theme: theme ?? "dark",
      protocol: protocol ?? "mcp-apps",
      timestamp: Date.now(),
    });

    return c.json({ success: true });
  } catch (error) {
    console.error("[MCP Apps] Error storing widget data:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Serve widget content with injected MCP Apps script
apps.get("/widget-content/:toolId", async (c) => {
  try {
    const toolId = c.req.param("toolId");
    const widgetData = widgetDataStore.get(toolId);

    if (!widgetData) {
      return c.html(
        "<html><body>Error: Widget data not found or expired</body></html>",
        404,
      );
    }

    const { serverId, resourceUri, toolInput, toolOutput, theme, toolName } =
      widgetData;
    const mcpClientManager = c.mcpClientManager;

    // REUSE existing mcpClientManager.readResource (same as resources.ts)
    const resourceResult = await mcpClientManager.readResource(serverId, {
      uri: resourceUri,
    });

    // Extract HTML from resource contents
    const contents = resourceResult?.contents || [];
    const content = contents[0];

    if (!content) {
      return c.html(
        "<html><body>Error: No content in resource</body></html>",
        404,
      );
    }

    let html: string;
    if ("text" in content && typeof content.text === "string") {
      html = content.text;
    } else if ("blob" in content && typeof content.blob === "string") {
      html = Buffer.from(content.blob, "base64").toString("utf-8");
    } else {
      return c.html(
        "<html><body>Error: No HTML content in resource</body></html>",
        404,
      );
    }

    // Inject MCP Apps client script - SAME pattern as openai.ts buildBridgeScript
    const mcpAppsScript = buildMCPAppsScript({
      toolId,
      toolName,
      toolInput,
      toolOutput,
      theme,
    });

    // Inject script into <head> - SAME as openai.ts
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>${mcpAppsScript}`);
    } else if (html.includes("<html>")) {
      html = html.replace("<html>", `<html><head>${mcpAppsScript}</head>`);
    } else {
      html = mcpAppsScript + html;
    }

    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return c.body(html);
  } catch (error) {
    console.error("[MCP Apps] Error fetching resource:", error);
    return c.html(
      `<html><body>Error: ${error instanceof Error ? error.message : "Unknown error"}</body></html>`,
      500,
    );
  }
});

/**
 * Build the MCP Apps client script to inject into widget HTML.
 *
 * This script provides the window.mcpApp API per SEP-1865:
 * - callTool(name, args) - Call another MCP tool
 * - readResource(uri) - Read an MCP resource
 * - openLink(url) - Open external link
 * - sendMessage(text) - Send message to chat
 * - resize(width, height) - Notify host of size change
 *
 * Events:
 * - mcp:tool-input - Tool input received
 * - mcp:tool-result - Tool result received
 * - mcp:tool-cancelled - Tool was cancelled
 * - mcp:context-change - Host context changed
 * - mcp:teardown - About to be torn down
 */
function buildMCPAppsScript(opts: {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  theme?: string;
}): string {
  const { toolInput, toolOutput } = opts;

  return `
<script>
(function() {
  'use strict';

  const pending = new Map();
  let nextId = 1;
  let hostContext = {};

  function sendRequest(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Request timeout: ' + method));
        }
      }, 30000);
    });
  }

  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  window.addEventListener('message', (event) => {
    const { jsonrpc, id, method, params, result, error } = event.data || {};
    if (jsonrpc !== '2.0') return;

    // Handle responses to our requests
    if (id !== undefined && pending.has(id)) {
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      if (error) {
        reject(new Error(error.message || 'Unknown error'));
      } else {
        resolve(result);
      }
      return;
    }

    // Handle notifications from host
    if (method === 'ui/notifications/tool-input') {
      window.mcpApp.toolInput = params.arguments;
      window.dispatchEvent(new CustomEvent('mcp:tool-input', { detail: params }));
    }
    if (method === 'ui/notifications/tool-result') {
      window.mcpApp.toolResult = params;
      window.dispatchEvent(new CustomEvent('mcp:tool-result', { detail: params }));
    }
    if (method === 'ui/host-context-change') {
      Object.assign(hostContext, params);
      window.mcpApp.hostContext = hostContext;
      window.dispatchEvent(new CustomEvent('mcp:context-change', { detail: params }));
    }
    // SEP-1865: Tool was cancelled
    if (method === 'ui/tool-cancelled') {
      window.dispatchEvent(new CustomEvent('mcp:tool-cancelled', { detail: params }));
    }
    if (method === 'ui/resource-teardown') {
      window.dispatchEvent(new CustomEvent('mcp:teardown', { detail: params }));
    }
  });

  // Initialize with host
  sendRequest('ui/initialize', {
    capabilities: {},
    clientInfo: { name: 'MCP App Widget', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  }).then((result) => {
    hostContext = result.hostContext || {};
    window.mcpApp.hostContext = hostContext;

    // Notify host that we're initialized
    sendNotification('ui/notifications/initialized', {});
  }).catch((err) => {
    console.error('[MCP App] Initialization failed:', err);
  });

  // Public API - SEP-1865 compliant
  window.mcpApp = {
    toolInput: ${serializeForInlineScript(toolInput)},
    toolResult: ${serializeForInlineScript(toolOutput)},
    hostContext: {},

    // Call another MCP tool
    async callTool(name, args = {}) {
      return sendRequest('tools/call', { name, arguments: args });
    },

    // Read an MCP resource
    async readResource(uri) {
      return sendRequest('resources/read', { uri });
    },

    // Open external link
    async openLink(url) {
      return sendRequest('ui/open-link', { url });
    },

    // Send message to chat
    async sendMessage(text) {
      return sendRequest('ui/message', {
        role: 'user',
        content: { type: 'text', text }
      });
    },

    // Notify host of size change
    resize(width, height) {
      sendNotification('ui/size-change', { width, height });
    },
  };

  // NOTE: No window.openai alias - MCP Apps uses window.mcpApp only
  // OpenAI SDK widgets use a different iframe with window.openai

  // Auto-report size changes
  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === document.body) {
          const { width, height } = entry.contentRect;
          window.mcpApp.resize(Math.round(width), Math.round(height));
        }
      }
    });

    if (document.body) {
      resizeObserver.observe(document.body);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        resizeObserver.observe(document.body);
      });
    }
  }
})();
</script>
`;
}

export default apps;
