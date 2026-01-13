/**
 * MCP App communication layer using postMessage.
 * 
 * When running inside an MCP host (like MCP Jam), the app is rendered in an iframe
 * and must communicate with the host via postMessage. The host then proxies
 * tool calls to the MCP server.
 * 
 * This implements the SEP-1865 MCP Apps specification.
 */

declare global {
  interface Window {
    __MCP_RESOURCE_URI__?: string;
  }
}

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Pending requests waiting for responses
const pendingRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();

let requestId = 0;
let initialized = false;

/**
 * Initialize the postMessage listener for responses from the MCP host.
 */
const initMessageListener = () => {
  if (initialized) return;
  initialized = true;

  window.addEventListener("message", (event) => {
    // Handle JSON-RPC responses from the host
    const data = event.data;
    
    if (data && typeof data === "object" && data.jsonrpc === "2.0" && "id" in data) {
      const pending = pendingRequests.get(data.id);
      if (pending) {
        pendingRequests.delete(data.id);
        
        if (data.error) {
          pending.reject(new Error(data.error.message || "MCP error"));
        } else {
          pending.resolve(data.result);
        }
      }
    }
  });
};

/**
 * Send a JSON-RPC request to the MCP host via postMessage.
 */
const sendRequest = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
  initMessageListener();

  return new Promise((resolve, reject) => {
    const id = ++requestId;
    
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    // Send to parent window (the MCP host)
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(request, "*");
    } else {
      // Fallback: we're not in an iframe, reject
      pendingRequests.delete(id);
      reject(new Error("Not running inside an MCP host iframe"));
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
};

/**
 * Check if we're running inside an MCP host (iframe).
 */
export const isInMcpHost = (): boolean => {
  return window.parent !== window;
};

/**
 * Get the resource URI injected by the server.
 */
export const getResourceUri = (): string | undefined => {
  return window.__MCP_RESOURCE_URI__;
};

/**
 * Call an MCP tool.
 * 
 * When in an MCP host: uses postMessage to proxy through the host.
 * When standalone: falls back to HTTP /rpc endpoint.
 */
export const callTool = async <T = unknown>(
  toolName: string,
  args?: Record<string, unknown>
): Promise<T> => {
  if (isInMcpHost()) {
    // Use postMessage to call through the MCP host
    const result = await sendRequest<unknown>(
      "tools/call",
      { name: toolName, arguments: args ?? {} }
    );
    
    // Parse the MCP tool response format - try different response shapes
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      
      // Shape 1: { content: [{ type: "text", text: "..." }] }
      if ("content" in obj && Array.isArray(obj.content)) {
        const textContent = obj.content.find((c: { type?: string; text?: string }) => c.type === "text");
        if (textContent?.text) {
          try {
            const parsed = JSON.parse(textContent.text);
            return parsed as T;
          } catch (e) {
            // Failed to parse as JSON, continue to other shapes
          }
        }
      }
      
      // Shape 2: Direct data object
      if ("data" in obj) {
        return obj as T;
      }
    }
    
    return result as T;
  } else {
    // Fallback to HTTP for local development
    return callToolViaHttp<T>(toolName, args);
  }
};

/**
 * HTTP fallback for local development.
 */
let httpRpcId = 0;

const callToolViaHttp = async <T = unknown>(
  method: string,
  params?: Record<string, unknown>
): Promise<T> => {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++httpRpcId,
      method,
      params: params ?? {},
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }

  return json.result as T;
};

/**
 * Notify the host of a resize request.
 */
export const resize = (height?: number): void => {
  if (!isInMcpHost()) return;
  
  const actualHeight = height ?? document.documentElement.scrollHeight;
  window.parent.postMessage({
    type: "resize",
    height: actualHeight,
  }, "*");
};

/**
 * Request to open an external link.
 */
export const openLink = (url: string): void => {
  if (isInMcpHost()) {
    window.parent.postMessage({
      type: "openLink",
      url,
    }, "*");
  } else {
    window.open(url, "_blank");
  }
};

/**
 * Send a user message to the chat.
 */
export const sendMessage = (message: string): void => {
  if (!isInMcpHost()) return;
  
  window.parent.postMessage({
    type: "sendMessage",
    message,
  }, "*");
};

