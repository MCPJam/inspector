import { unknownMethodError } from "./mock-errors.js";
import type { MockForwardBlockReason } from "./mock-observer.js";
import type {
  CallToolResult,
  InputRequiredResult,
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
  /**
   * The caller's answers to questions the real server asked in an earlier
   * round (2026-07-28 `input_required`), and the state it handed back. Send
   * both with the call, as the real server expects them.
   */
  inputResponses?: Record<string, unknown>;
  requestState?: string;
}

/** What the mock is about to send to the real server. */
export type MockForwardRequest =
  | {
      kind: "tool";
      /** The name the client called. */
      tool: string;
      /** The real tool, after any rename. */
      realTool: string;
      /** The final arguments, after fixed values were applied. */
      arguments: Record<string, unknown>;
    }
  | { kind: "request"; method: string };

/**
 * The host's answer to "may this forward happen now". A refusal says why in
 * `message`, which is shown to the caller as written, so it names what to do.
 */
export type MockForwardDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: MockForwardBlockReason;
      message: string;
    };

/** The list families a version's pinned discovery contract holds. Skills are resources with `skill://` URIs. */
export type MockListingFamily = "tools" | "prompts" | "resources" | "resourceTemplates";

/** One saved entry of a family, as an MCP list returns it. */
export type MockPinnedEntry<F extends MockListingFamily> = F extends "tools"
  ? Tool
  : Record<string, unknown>;

/**
 * The real server, reached as a client. The Inspector's route implements this
 * on a connection from `createAuthorizedManager`; tests implement it on a
 * client wired to an in-process server. Each method maps to one call on
 * `MCPClientManager` (`getInitializationInfo`, `listTools`, `executeTool`) or
 * on its managed client (`request`).
 *
 * `describe` and `listTools` are discovery: the mock calls them without asking
 * `authorizeForward`, so a host that must not contact the base answers them
 * from what it saved. `callTool` and `request` are forwards: the mock calls
 * `authorizeForward` immediately before each and does not dispatch unless it
 * allows.
 */
export interface MockRealServer {
  describe(options?: { signal?: AbortSignal }): Promise<MockRealServerInfo>;
  /** Every tool, all pages walked. */
  listTools(options?: { signal?: AbortSignal }): Promise<Tool[]>;
  /**
   * The entries of one family saved in the version's pinned discovery
   * contract, with no network read. The mock lists from this while forwarding
   * is blocked, for every family (tools included), so a blocked mock never
   * contacts the base. The host returns only what the caller may read (the
   * shareable or caller-private rule) and `[]` when nothing was captured.
   * Optional: a mock with no base has nothing pinned.
   */
  pinnedListing?<F extends MockListingFamily>(family: F): Promise<MockPinnedEntry<F>[]>;
  /**
   * Whether the forward may happen now. The host checks the current policy,
   * the caller's access and the caller's credentials here, on every call. If
   * this throws, the mock refuses the forward as `policy_unavailable`.
   */
  authorizeForward(
    request: MockForwardRequest,
    options?: { signal?: AbortSignal }
  ): Promise<MockForwardDecision>;
  /**
   * A real server that needs input answers a 2026-07-28 call with an
   * `input_required` result; return it as it is and the mock hands it to the
   * caller, who answers by retrying (the retry carries the answers back in
   * `inputResponses` and `requestState`). A connection that answers questions
   * itself needs no part of this.
   */
  callTool(call: MockRealCall): Promise<CallToolResult | InputRequiredResult>;
  /** Any other spec method, passed through whole; the result is the result object. */
  request(
    request: { method: string; params?: Record<string, unknown> },
    options?: { signal?: AbortSignal }
  ): Promise<Record<string, unknown>>;
  /** Subscribes to list-changed notifications; returns the unsubscribe. */
  onListChanged(handler: (kind: MockListChangedKind) => void): () => void;
}

/** The real server of a mock made from nothing: no tools, no capabilities, nothing to forward to. */
export const NO_REAL_SERVER: MockRealServer = {
  describe: async () => ({ capabilities: {} }),
  listTools: async () => [],
  authorizeForward: async () => ({
    allowed: false,
    reason: "no_base",
    message:
      "This mock has no backing server to forward the call to. Save an answer for it, or make the mock from a saved server.",
  }),
  callTool: async (call) => {
    throw new Error(`There is no real server to call "${call.name}" on.`);
  },
  request: async ({ method }) => {
    throw unknownMethodError(method);
  },
  onListChanged: () => () => {},
};
