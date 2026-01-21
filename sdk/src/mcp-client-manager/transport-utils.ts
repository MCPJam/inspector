/**
 * Transport utilities for MCPClientManager
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RpcLogger } from "./types.js";

/**
 * Normalizes headers from various formats (Headers, string[][], or plain object)
 * into a plain Record<string, string>.
 *
 * @param headers - Headers in any supported format
 * @returns Plain object with header key-value pairs
 */
function normalizeHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) {
    return {};
  }

  // If it's already a plain object (not Headers or array), return as-is
  if (
    typeof headers === "object" &&
    !Array.isArray(headers) &&
    !(headers instanceof Headers)
  ) {
    return headers as Record<string, string>;
  }

  // Convert Headers or string[][] to a plain object
  const normalized: Record<string, string> = {};
  const headersObj = new Headers(headers);
  headersObj.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

/**
 * Checks if headers contain an Authorization header (case-insensitive check).
 *
 * @param headers - Normalized headers object
 * @returns The Authorization value if present, undefined otherwise
 */
function getExistingAuthorization(
  headers: Record<string, string>
): string | undefined {
  return headers["Authorization"] ?? headers["authorization"];
}

/**
 * Builds the requestInit object, merging accessToken into Authorization header if provided.
 *
 * @param accessToken - Optional access token for Bearer auth
 * @param requestInit - Optional existing requestInit config
 * @returns Merged requestInit with Authorization header if accessToken provided
 */
export function buildRequestInit(
  accessToken: string | undefined,
  requestInit: StreamableHTTPClientTransportOptions["requestInit"]
): StreamableHTTPClientTransportOptions["requestInit"] {
  if (!accessToken) {
    return requestInit;
  }

  const existingHeaders = normalizeHeaders(requestInit?.headers);
  const existingAuth = getExistingAuthorization(existingHeaders);

  // Remove any lowercase 'authorization' key to avoid duplicate headers
  const { authorization: _, ...headersWithoutLowercaseAuth } = existingHeaders;

  return {
    ...requestInit,
    headers: {
      Authorization: existingAuth ?? `Bearer ${accessToken}`,
      ...headersWithoutLowercaseAuth,
    },
  };
}

/**
 * Creates a logging wrapper transport that logs JSON-RPC traffic.
 *
 * @param serverId - The server ID for logging context
 * @param logger - The RPC logger function
 * @param transport - The underlying transport to wrap
 * @returns A new transport that logs all messages
 */
export function wrapTransportForLogging(
  serverId: string,
  logger: RpcLogger,
  transport: Transport
): Transport {
  class LoggingTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(private readonly inner: Transport) {
      this.inner.onmessage = (
        message: JSONRPCMessage,
        extra?: MessageExtraInfo
      ) => {
        try {
          logger({ direction: "receive", message, serverId });
        } catch {
          // Ignore logger errors
        }
        this.onmessage?.(message, extra);
      };
      this.inner.onclose = () => {
        this.onclose?.();
      };
      this.inner.onerror = (error: Error) => {
        this.onerror?.(error);
      };
    }

    async start(): Promise<void> {
      if (typeof (this.inner as any).start === "function") {
        await (this.inner as any).start();
      }
    }

    async send(
      message: JSONRPCMessage,
      options?: TransportSendOptions
    ): Promise<void> {
      try {
        logger({ direction: "send", message, serverId });
      } catch {
        // Ignore logger errors
      }
      await this.inner.send(message as any, options as any);
    }

    async close(): Promise<void> {
      await this.inner.close();
    }

    get sessionId(): string | undefined {
      return (this.inner as any).sessionId;
    }

    setProtocolVersion?(version: string): void {
      if (typeof this.inner.setProtocolVersion === "function") {
        this.inner.setProtocolVersion(version);
      }
    }
  }

  return new LoggingTransport(transport);
}

/**
 * Creates a default console logger for JSON-RPC traffic.
 *
 * @returns A logger function that outputs to console.debug
 */
export function createDefaultRpcLogger(): RpcLogger {
  return ({ direction, message, serverId }) => {
    let printable: string;
    try {
      printable =
        typeof message === "string" ? message : JSON.stringify(message);
    } catch {
      printable = String(message);
    }

    console.debug(`[MCP:${serverId}] ${direction.toUpperCase()} ${printable}`);
  };
}
