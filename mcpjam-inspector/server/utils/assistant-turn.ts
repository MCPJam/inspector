/**
 * Assistant turn engine (Stage 1 of horizontally-safe synthetic chatbox
 * sessions — see plan v3 §A "engine extraction").
 *
 * `runAssistantTurn` is the shared assistant-turn driver for both the live
 * chat path (`/api/web/chat-v2`, `/api/mcp/chat-v2`) and the upcoming
 * synthetic-chat runner. It owns the Convex `/stream` + local-tool
 * execution loop now implemented as the streamSink-aware
 * {@link runChatEngineLoop} primitive.
 *
 * After Stage 1.1, the engine no longer lives inside
 * `handleMCPJamFreeChatModel`: that function is a thin Response-returning
 * wrapper around the same `runChatEngineLoop` that `runAssistantTurn`
 * calls. The synthetic-runner path (`streamSink: "none"`) runs the
 * agent loop inline against a no-op writer — it does NOT build a
 * `Response` and drain it. The transcript flows back via the captured
 * `messageHistory` and the engine's `onConversationComplete` tap.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
  AssistantModelMessage,
  ToolModelMessage,
  ToolSet,
  UIMessageChunk,
} from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";
import type {
  ProgressiveToolPlan,
  ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import {
  runChatEngineLoop,
  type MCPJamHandlerOptions,
} from "./mcpjam-stream-handler.js";
import type { PersistedTurnTrace } from "./chat-ingestion.js";

/**
 * Authentication context for `runAssistantTurn`.
 *
 * The caller forwards the inbound `authorization` header from the browser
 * request directly to Convex. `clientIp` is the originating IP for the
 * per-IP guest spend cap (see `mcpjam-stream-handler.ts` doc on `clientIp`).
 */
export type RunAssistantTurnAuthContext = {
  kind: "user_bearer";
  /** Full `authorization` header value, e.g. `"Bearer …"`. */
  token: string;
  /** Originating client IP for the per-IP guest spend cap. */
  clientIp?: string | null;
};

/** Where streamed chunks go. */
export type RunAssistantTurnStreamSink = "ui" | "none";

/** Whether `runAssistantTurn` runs the chat-ingestion path itself. */
export type RunAssistantTurnPersistMode = "handler" | "caller";

export interface RunAssistantTurnOptions {
  messages: ModelMessage[];
  projectId?: string;
  chatboxId?: string;
  accessVersion?: number;

  modelDefinition: ModelDefinition;
  systemPrompt: string;
  temperature?: number;

  selectedServerIds?: string[];
  /**
   * Optional display names for the selected servers. Reserved for the
   * upcoming synthetic runner adapter so a generated `chatSessions.row`
   * can resolve `serverIds → serverNames` without re-querying the
   * manager. Stage 1 does not consume this; persist when present.
   */
  selectedServerNames?: string[];

  mcpClientManager: MCPClientManager;

  authContext: RunAssistantTurnAuthContext;

  /**
   * Source-of-traffic marker forwarded into chat-ingestion. Mirrors
   * the existing `MCPJamHandlerOptions.sourceType` union but kept
   * narrowed to the public values to avoid silent string churn.
   */
  sourceType: "direct" | "chatbox";
  /**
   * Surface marker forwarded into chat-ingestion. Stage 1 only wires
   * the type-narrow union; existing callers still send the string
   * verbatim into `persistChatSessionToConvex`.
   */
  surface?: "preview" | "share_link";

  /** See `PrepareChatV2Options.approvalMode`. Default `"prompt"`. */
  approvalMode?: "prompt" | "auto-deny";
  /**
   * Required-tool-approval policy on the underlying engine. Forwarded
   * verbatim to `handleMCPJamFreeChatModel` so the dispatch-time
   * approval gate at mcpjam-stream-handler.ts:834–843 fires when set.
   */
  requireToolApproval?: boolean;

  streamSink: RunAssistantTurnStreamSink;
  persistMode: RunAssistantTurnPersistMode;

  /**
   * When provided, threaded into the `/stream` request body so Convex's
   * spend-record path can attribute usage to the synthetic run/job. The
   * backend ignores unknown fields until the matching wiring lands per
   * `feedback_bridge_preserves_unknown_fields`.
   */
  synthesisRunId?: string;
  synthesisJobId?: string;

  // --- The fields below are pass-throughs to `handleMCPJamFreeChatModel`
  //     that the live-chat callers already supply today. Exposed here so
  //     a thin wrapper can forward them without losing behavior. ---

  /** Pre-built advertised tool set (output of `prepareChatV2`). */
  tools: ToolSet;
  chatSessionId?: string;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  abortSignal?: AbortSignal;
  heartbeatIntervalMs?: number;
  maxSteps?: number;

  /**
   * Callback invoked when the chat-ingestion handler path runs. Only
   * consumed when `persistMode === "handler"`; ignored when
   * `persistMode === "caller"` (the caller is responsible for writing
   * its own `chatSessions` row using the returned transcript).
   */
  onConversationComplete?: MCPJamHandlerOptions["onConversationComplete"];
  /** Optional stream-cleanup hook (e.g. MCPClientManager teardown). */
  onStreamComplete?: MCPJamHandlerOptions["onStreamComplete"];
  onStreamWriterReady?: MCPJamHandlerOptions["onStreamWriterReady"];
  onLiveTextDelta?: MCPJamHandlerOptions["onLiveTextDelta"];

  /**
   * Override the Convex endpoint path. Stage 1 keeps this wired so
   * `handleHostedOrgChatModel` (org BYOK delegation chain) keeps
   * working — `runAssistantTurn` is the same engine, and the org BYOK
   * path needs `/stream/org` + `extraBodyFields: { providerKey }`.
   */
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  extraBodyFields?: Record<string, unknown>;
}

/**
 * Outputs of a completed assistant turn.
 *
 * - `messages` is the full conversation history (input + assistant
 *   responses + tool results) — same shape passed to
 *   `onConversationComplete`.
 * - `assistantMessages`, `toolCalls`, `toolResults` are pre-extracted
 *   views over `messages` for synthetic-runner convenience; live-chat
 *   callers can ignore them.
 * - `response` is populated only when `streamSink === "ui"`; the
 *   wrapper returns it back to Hono as the SSE response.
 */
export interface RunAssistantTurnResult {
  messages: ModelMessage[];
  assistantMessages: AssistantModelMessage[];
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  toolResults: Array<{
    toolCallId: string;
    toolName?: string;
    output: unknown;
  }>;
  turnTrace?: PersistedTurnTrace;
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  /** Set only for `streamSink: "ui"`. */
  response?: Response;
}

function extractAssistantMessages(
  messages: ModelMessage[]
): AssistantModelMessage[] {
  const out: AssistantModelMessage[] = [];
  for (const msg of messages) {
    if (msg?.role === "assistant") {
      out.push(msg as AssistantModelMessage);
    }
  }
  return out;
}

function extractToolCalls(
  messages: ModelMessage[]
): RunAssistantTurnResult["toolCalls"] {
  const out: RunAssistantTurnResult["toolCalls"] = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const content = (msg as AssistantModelMessage).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool-call") {
        out.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }
    }
  }
  return out;
}

function extractToolResults(
  messages: ModelMessage[]
): RunAssistantTurnResult["toolResults"] {
  const out: RunAssistantTurnResult["toolResults"] = [];
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    for (const part of (msg as ToolModelMessage).content) {
      if (part.type === "tool-result") {
        out.push({
          toolCallId: part.toolCallId,
          toolName: (part as { toolName?: string }).toolName,
          output: part.output,
        });
      }
    }
  }
  return out;
}

/**
 * Build the merged `extraBodyFields` payload forwarded to the Convex
 * `/stream` request. Caller-supplied fields win; the synthesis
 * attribution keys are appended last so they never override a real
 * upstream key collision (none today — they're new).
 */
function buildExtraBodyFields(
  opts: RunAssistantTurnOptions
): Record<string, unknown> | undefined {
  const base = { ...(opts.extraBodyFields ?? {}) };
  if (opts.synthesisRunId) {
    base.synthesisRunId = opts.synthesisRunId;
  }
  if (opts.synthesisJobId) {
    base.synthesisJobId = opts.synthesisJobId;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * Translate `RunAssistantTurnOptions` into the underlying
 * `MCPJamHandlerOptions` shape. Wraps `onConversationComplete` so the
 * `runAssistantTurn` caller (or the result object) always sees the
 * final transcript even when `persistMode: "caller"` suppresses the
 * handler-side persistence.
 */
function buildHandlerOptions(
  opts: RunAssistantTurnOptions,
  captureTranscript: (
    messages: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => void
): MCPJamHandlerOptions {
  const wrappedOnConversationComplete: MCPJamHandlerOptions["onConversationComplete"] =
    async (fullHistory, turnTrace) => {
      captureTranscript(fullHistory, turnTrace);
      if (
        opts.persistMode === "handler" &&
        typeof opts.onConversationComplete === "function"
      ) {
        await opts.onConversationComplete(fullHistory, turnTrace);
      }
    };

  const handlerOptions: MCPJamHandlerOptions = {
    messages: opts.messages,
    modelId: String(opts.modelDefinition.id),
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    mcpClientManager: opts.mcpClientManager,
    authHeader: opts.authContext.token,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.chatboxId ? { chatboxId: opts.chatboxId } : {}),
    ...(opts.accessVersion !== undefined
      ? { accessVersion: opts.accessVersion }
      : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    ...(opts.sourceType ? { sourceType: opts.sourceType } : {}),
    ...(opts.selectedServerIds
      ? { selectedServers: opts.selectedServerIds }
      : {}),
    ...(opts.requireToolApproval !== undefined
      ? { requireToolApproval: opts.requireToolApproval }
      : {}),
    ...(opts.approvalMode !== undefined
      ? { approvalMode: opts.approvalMode }
      : {}),
    onConversationComplete: wrappedOnConversationComplete,
    ...(opts.onStreamComplete
      ? { onStreamComplete: opts.onStreamComplete }
      : {}),
    ...(opts.onStreamWriterReady
      ? { onStreamWriterReady: opts.onStreamWriterReady }
      : {}),
    ...(opts.onLiveTextDelta
      ? { onLiveTextDelta: opts.onLiveTextDelta }
      : {}),
    ...(opts.endpointPath ? { endpointPath: opts.endpointPath } : {}),
    ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    ...(opts.authContext.clientIp !== undefined &&
    opts.authContext.clientIp !== null
      ? { clientIp: opts.authContext.clientIp }
      : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: opts.heartbeatIntervalMs }
      : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.progressivePlan
      ? { progressivePlan: opts.progressivePlan }
      : {}),
    ...(opts.discoveryState ? { discoveryState: opts.discoveryState } : {}),
  };

  const extraBodyFields = buildExtraBodyFields(opts);
  if (extraBodyFields) {
    handlerOptions.extraBodyFields = extraBodyFields;
  }
  return handlerOptions;
}

/**
 * Run a single assistant turn against an MCPJam-provided model.
 *
 * Calls {@link runChatEngineLoop} directly — no intermediate
 * `Response`-draining facade. Behavior by stream sink:
 *
 * - `streamSink: "ui"`: the engine builds an SSE Response identical to
 *   the live `/stream` path. `RunAssistantTurnResult.response` is
 *   populated. The transcript is delivered to the caller's
 *   `onConversationComplete` (when `persistMode: "handler"`) via the
 *   engine's `onFinish` once the caller drains the Response body, NOT
 *   via the synchronous return value. `messages` on the result
 *   reflects the in-flight `messageHistory` reference the engine
 *   mutates, so callers that await the response stream see the final
 *   transcript through it; callers that need a pre-drain snapshot
 *   should consume via `onConversationComplete`.
 *
 * - `streamSink: "none"`: the engine runs inline against a no-op
 *   writer. The agent loop, trace persistence, and the
 *   `onConversationComplete` tap all complete BEFORE
 *   `runChatEngineLoop` returns. `messages` is the populated
 *   `messageHistory` from the engine (NOT a fallback to the input).
 */
export async function runAssistantTurn(
  opts: RunAssistantTurnOptions
): Promise<RunAssistantTurnResult> {
  let capturedMessages: ModelMessage[] | undefined;
  let capturedTrace: PersistedTurnTrace | undefined;

  const handlerOptions = buildHandlerOptions(opts, (fullHistory, turnTrace) => {
    capturedMessages = fullHistory;
    capturedTrace = turnTrace;
  });

  const engineResult = await runChatEngineLoop(
    handlerOptions,
    opts.streamSink
  );

  // For streamSink: "none" the engine has fully run — its
  // onConversationComplete tap (wrapped above) populated
  // capturedMessages/capturedTrace synchronously. For streamSink: "ui"
  // the engine returned a Response without running onFinish yet; the
  // captured fields will populate later, after Hono drains the body.
  //
  // engineResult.messageHistory is the live ref the engine mutates, so
  // it converges to the same content as capturedMessages once the
  // stream drains. We prefer the captured snapshot when available
  // (post-onFinish view) and fall back to the engine ref otherwise —
  // never to opts.messages.
  const messages =
    capturedMessages ??
    engineResult.messageHistory;
  const assistantMessages = extractAssistantMessages(messages);
  const toolCalls = extractToolCalls(messages);
  const toolResults = extractToolResults(messages);

  // For streamSink: "none" we prefer the trace surfaced eagerly on the
  // engine result (set inside onFinish before runChatEngineLoop
  // resolved). For streamSink: "ui" the trace populates the wrapped
  // onConversationComplete callback after the response body is drained.
  const turnTrace = capturedTrace ?? engineResult.turnTrace;

  const result: RunAssistantTurnResult = {
    messages,
    assistantMessages,
    toolCalls,
    toolResults,
    ...(turnTrace ? { turnTrace } : {}),
    ...(turnTrace?.usage ? { usage: turnTrace.usage } : {}),
    ...(turnTrace?.finishReason
      ? { finishReason: turnTrace.finishReason }
      : {}),
  };

  if (opts.streamSink === "ui" && engineResult.response) {
    result.response = engineResult.response;
  }

  return result;
}

// Re-export the chunk type so callers that wire a custom sink (future
// stages) don't have to import from `ai` separately.
export type { UIMessageChunk };
