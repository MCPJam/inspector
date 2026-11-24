import { unknownMethodError } from "./mock-errors.js";
import type {
  CallToolResult,
  LoggingLevel,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/server";

/** What the real server said in its handshake. */
export interface MockRealServerInfo {
  serverInfo?: { name: string; version: string; title?: string };
  instructions?: string;
  capabilities: ServerCapabilities;
}

export interface MockRealProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface MockRealLog {
  level: LoggingLevel;
  data: unknown;
  logger?: string;
}

export type MockListChangedKind = "tools" | "prompts" | "resources";

export interface MockRealCall {
  name: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * The caller's log level for this call (2026-07-28 sends one per request, in
   * `_meta`). Without it a real server may send no log messages at all.
   */
  logLevel?: LoggingLevel;
  /** Called for each progress notification the real server sends during the call. */
  onProgress?: (progress: MockRealProgress) => void;
  /** Called for each log message the real server sends during the call. */
  onLog?: (log: MockRealLog) => void;
}

/**
 * The real server, reached as a client. The Inspector's route implements this
 * on a connection from `createAuthorizedManager`; tests implement it on a
 * client wired to an in-process server. Each method maps to one call on
 * `MCPClientManager` (`getInitializationInfo`, `listTools`, `executeTool`) or
 * on its managed client (`request`).
 */
export interface MockRealServer {
  describe(options?: { signal?: AbortSignal }): Promise<MockRealServerInfo>;
  /** Every tool, all pages walked. */
  listTools(options?: { signal?: AbortSignal }): Promise<Tool[]>;
  callTool(call: MockRealCall): Promise<CallToolResult>;
  /** Any other spec method, passed through whole; the result is the result object. */
  request(
    request: { method: string; params?: Record<string, unknown> },
    options?: { signal?: AbortSignal }
  ): Promise<Record<string, unknown>>;
  /** Subscribes to list-changed notifications; returns the unsubscribe. */
  onListChanged(handler: (kind: MockListChangedKind) => void): () => void;
}

/** The real server of a mock made from nothing: no tools, no capabilities. */
export const NO_REAL_SERVER: MockRealServer = {
  describe: async () => ({ capabilities: {} }),
  listTools: async () => [],
  callTool: async (call) => {
    throw new Error(`There is no real server to call "${call.name}" on.`);
  },
  request: async ({ method }) => {
    throw unknownMethodError(method);
  },
  onListChanged: () => () => {},
};
