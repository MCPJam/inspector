/**
 * The slice of the `codex app-server` protocol this bridge speaks, as
 * hand-written types.
 *
 * WHY HAND-WRITTEN. `codex app-server generate-json-schema` emits 291 files
 * describing 95 client methods, 10 server requests and 75 notifications. The
 * bridge uses maybe fifteen of them. Generating types for all of it would bury
 * the ones that matter and would churn on every upstream release, most of which
 * touch surfaces we never call. Instead the names we depend on are listed in
 * {@link USED_CLIENT_METHODS} / {@link USED_SERVER_REQUESTS} /
 * {@link USED_NOTIFICATIONS} and asserted against the committed schema snapshot
 * by `__tests__/schema-snapshot.test.ts` — so an upstream REMOVAL fails a unit
 * test here rather than a turn inside a sandbox.
 *
 * Shapes below are taken from the 0.149.1 snapshot in
 * `.spike-codex-appserver/schema/0.149.1/`, with two corrections observed on a
 * live server and noted at their fields (`availableDecisions`, and the fact
 * that `decline` is accepted even when unlisted).
 */

/** JSON-RPC id. Codex uses integers; strings are accepted by the spec. */
export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};
export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};
export type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export type JsonRpcFrame =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/* ── Client → server ─────────────────────────────────────────────────────── */

/**
 * `thread/start` accepts an OPEN `config` object (`additionalProperties: true`)
 * that layers over `CODEX_HOME/config.toml`. Verified live: an `mcp_servers`
 * table passed this way starts and reaches `ready`, so it is a real per-thread
 * channel and not just scalar overrides.
 */
export type ThreadStartParams = {
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandbox?: CodexSandboxMode;
  ephemeral?: boolean;
  /** Layered over config.toml for this thread. */
  config?: Record<string, unknown>;
  /**
   * Extra instructions ALONGSIDE Codex's own system prompt. Deliberately used
   * instead of `baseInstructions`, which REPLACES it — passing MCPJam's host
   * instructions there would silently delete Codex's tool guidance and the
   * agent would stop using its own tools correctly.
   */
  developerInstructions?: string;
  serviceName?: string;
};

export type ThreadResumeParams = ThreadStartParams & { threadId: string };

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexApprovalsReviewer =
  | "user"
  | "auto_review"
  | "guardian_subagent";
export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type TurnStartParams = {
  threadId: string;
  input: Array<{ type: "text"; text: string }>;
  model?: string;
  effort?: string;
  summary?: "auto" | "concise" | "detailed" | "none";
  cwd?: string;
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  outputSchema?: unknown;
};

export type ThreadStartResult = {
  thread: {
    id: string;
    sessionId?: string;
    modelProvider?: string;
    ephemeral?: boolean;
    path?: string;
    cliVersion?: string;
  };
  model?: string;
};

export type TurnStartResult = {
  turn: { id: string; status: TurnStatus };
};

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

/* ── Server → client requests ────────────────────────────────────────────── */

/**
 * Sent BEFORE the corresponding `item/started`. Measured, and load-bearing:
 * the bridge cannot wait for the item to learn what the command is, so every
 * field the synthesized `tool-call` needs is read from here.
 */
export type CommandExecutionApprovalParams = {
  threadId: string;
  turnId: string;
  /** The MODEL's call id. Stable across the approval, `item/started` and
   *  `item/completed`, which is what makes de-duplication possible. */
  itemId: string;
  startedAtMs: number;
  /** The full command line as one string (not an argv array). */
  command?: string | null;
  cwd?: string | null;
  environmentId?: string | null;
  reason?: string | null;
  commandActions?: CommandAction[] | null;
  proposedExecpolicyAmendment?: string[] | null;
  networkApprovalContext?: {
    host: string;
    protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
  } | null;
  /**
   * PRESENT ON THE WIRE, ABSENT FROM THE SCHEMA (0.149.1 and 0.152.0). Treat as
   * advisory only: a live run offered `["accept", {acceptWithExecpolicyAmendment}, "cancel"]`
   * and still honoured `{"decision":"decline"}`. Never gate a decision on this.
   */
  availableDecisions?: unknown[];
};

export type FileChangeApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
};

export type PermissionsApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason?: string | null;
  permissions?: unknown;
};

export type ToolRequestUserInputParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  autoResolutionMs?: number | null;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options?: unknown[] | null;
  }>;
};

export type McpElicitationParams = {
  threadId: string;
  turnId?: string | null;
  serverName: string;
};

/**
 * The decisions an approval response may carry.
 *
 * `decline` is what MCPJam sends for a denial. It is NOT always advertised in
 * `availableDecisions` and is honoured anyway — verified live, producing a
 * `declined` item and no execution.
 */
export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

/* ── Notifications ───────────────────────────────────────────────────────── */

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path?: string | null }
  | {
      type: "search";
      command: string;
      path?: string | null;
      query?: string | null;
    }
  | { type: "unknown"; command: string };

export type ItemStatus = "inProgress" | "completed" | "failed" | "declined";

export type FileChangeEntry = {
  path: string;
  diff?: string;
  kind?: { type: string; move_path?: string };
};

export type ThreadItem =
  | { type: "userMessage"; id: string; content?: unknown[] }
  | { type: "agentMessage"; id: string; text?: string }
  | { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
  | { type: "plan"; id: string; text?: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: unknown;
      status: ItemStatus;
      commandActions?: CommandAction[];
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
      processId?: string | null;
      source?: unknown;
    }
  | {
      type: "fileChange";
      id: string;
      status: ItemStatus;
      changes?: FileChangeEntry[];
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments?: unknown;
      result?: unknown;
      error?: { message: string } | null;
      status: "inProgress" | "completed" | "failed";
      durationMs?: number | null;
    }
  | {
      type: "webSearch";
      id: string;
      query: string;
      action?: unknown;
      results?: unknown[] | null;
    }
  | { type: "contextCompaction"; id: string }
  | { type: string; id: string; [key: string]: unknown };

export type TokenUsageBreakdown = {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

export type ThreadTokenUsage = {
  last?: TokenUsageBreakdown;
  total?: TokenUsageBreakdown;
  modelContextWindow?: number | null;
};

export type TurnCompletedParams = {
  threadId: string;
  turn: {
    id: string;
    status: TurnStatus;
    error?: { message: string; additionalDetails?: string | null } | null;
  };
};

/* ── The dependency surface, asserted against the committed schema ───────── */

export const USED_CLIENT_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
  "thread/compact/start",
] as const;

export const USED_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const;

export const USED_NOTIFICATIONS = [
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/patchUpdated",
  // Switched on by the translator to label a compaction as manual vs automatic.
  // Absent from this list the snapshot guard would not notice an upstream
  // rename, which is the one thing the list exists to catch.
  "thread/compacted",
  "mcpServer/startupStatus/updated",
  "error",
  "warning",
  "configWarning",
] as const;

/** The codex version the snapshot and these types were taken from. */
export const PINNED_CODEX_VERSION = "0.149.1";
