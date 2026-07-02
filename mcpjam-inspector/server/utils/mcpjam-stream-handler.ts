/**
 * MCPJam Stream Handler
 *
 * Handles the agentic loop for MCPJam-provided models.
 * The LLM lives in Convex (to protect the OpenRouter key),
 * while MCP tools execute locally in this Express server.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  parseJsonEventStream,
  pruneMessages,
  type ToolSet,
} from "ai";
import type {
  UIMessageChunk,
  ReasoningUIPart,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  AssistantModelMessage,
  ToolResultPart,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { zodSchema } from "@ai-sdk/provider-utils";
import type { MCPClientManager, Harness } from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config/internal";
import { runHarnessTurn } from "./harness/run-harness-turn.js";
import type { HarnessSessionCommitPayload } from "./harness/harness-session-state.js";
import type { HarnessMcpProxyStrategy } from "./harness/harness-proxy-strategy.js";
import {
  buildFinishChunk,
  emitError,
  emitToolApprovalRequest,
  emitToolInput,
  emitToolOutput,
  emitToolOutputDenied,
  safelyInvoke,
} from "./chat-stream-chunks.js";
import { z } from "zod";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "@/shared/http-tool-calls";
import { isClientFulfilledToolName } from "@/shared/client-fulfilled-tools";
import {
  scrubUnavailableToolHistoryForBackend,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
} from "./chat-helpers";
import { normalizeModelMessagesForConvex } from "./normalize-model-messages-for-convex";
import {
  serializeToolsForConvex,
  type ToolDefinition,
} from "./mcpjam-tool-helpers";
import {
  commitNewlyLoaded,
  gateToolsToActiveSubset,
  lookupToolIdByModelName,
  META_TOOL_SEARCH,
  resolveActiveToolNames,
  META_TOOL_NAMES,
  shouldForceInitialToolSearch,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import { mergeMcpToolOriginMetadata } from "@/shared/mcp-tool-origin-metadata";

function unwrapJsonEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const record = current as Record<string, unknown>;
    if (record.type !== "json" || !("value" in record)) {
      return current;
    }
    current = record.value;
  }
  return current;
}

function isModelVisibleImageOutput(value: unknown): boolean {
  const output = unwrapJsonEnvelope(value);
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  if (record.type !== "content" || !Array.isArray(record.value)) {
    return false;
  }
  return record.value.some((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      return (
        partRecord.text.startsWith("[image omitted:") ||
        partRecord.text.startsWith("[resource link omitted:") ||
        partRecord.text.startsWith("[embedded image resource omitted:")
      );
    }
    return (
      (partRecord.type === "media" || partRecord.type === "image-data") &&
      typeof partRecord.mediaType === "string" &&
      partRecord.mediaType.startsWith("image/")
    );
  });
}

/**
 * Approval-free check for a tool-call name.
 *
 * The progressive-discovery meta-tools (`search_mcp_tools`,
 * `load_mcp_tools`) are exempt from approval because gating discovery
 * itself behind N approvals defeats the point — see the module docstring.
 * But the exemption is name-only, and we cannot trust the name in
 * isolation: when progressive mode is **off** there are no meta-tools in
 * the toolset, but a real MCP server is free to expose a tool literally
 * named `search_mcp_tools`. Honoring the exemption in that case would
 * silently let a real, approval-required tool execute without the user's
 * confirmation.
 *
 * Require `progressivePlan?.enabled` as a precondition — that's the only
 * mode in which the orchestrator actually mints the meta-tools (and it
 * also fails fast on real-tool name collisions in `prepareChatV2`, so a
 * matching name truly is one of our meta-tools).
 */
function isApprovalFreeMetaToolName(
  name: string,
  progressivePlan: ProgressiveToolPlan | undefined
): boolean {
  if (!progressivePlan?.enabled) return false;
  return META_TOOL_NAMES.includes(name);
}
import { logger } from "./logger";
import {
  applyPrepareAdvertisedTools,
  gateToolsToAdvertisedSubset,
  type PrepareAdvertisedTools,
} from "./advertised-tools";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { normalizeFinishReason } from "@/shared/eval-trace";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import type { PersistedTurnTrace } from "./chat-ingestion";
import { StreamTurnDriver } from "./stream-turn-driver.js";
import {
  pushAiSdkTrailingErrorSpan,
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  wrapBackendToolsForTrace,
} from "../services/evals/eval-trace-capture";
import {
  emitRequestPayload,
  emitTraceSnapshot,
  generateLiveTraceTurnId,
  getPromptIndex,
  getPromptMessageStartIndex,
  readToolServerId,
  setToolSpanMessageRangesFromResults,
  toTraceRecord,
  writeTraceEvent,
} from "./live-chat-trace-stream";
import {
  buildResolvedModelRequestPayload,
  normalizeSystemPromptForProvider,
} from "./model-request-payload";
import { hashGuestSpendIp } from "./guest-spend-ip.js";
import { isAbortError } from "@/shared/abort-errors";

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const STEP_LOG_THRESHOLD = 20;
const GUEST_IP_HASH_HEADER = "x-mcpjam-guest-ip-hash";

function readLinkedMcpResourceWithManager(
  mcpClientManager: MCPClientManager
): (params: {
  serverId: string;
  uri: string;
  options?: { abortSignal?: AbortSignal };
}) => Promise<unknown> {
  return ({ serverId, uri, options }) => {
    const requestOptions = options?.abortSignal
      ? { signal: options.abortSignal }
      : undefined;
    return mcpClientManager.readResource(serverId, { uri }, requestOptions);
  };
}
const streamChunkSchema = zodSchema(z.unknown());

let warnedMissingAbortSignal = false;
/**
 * Dev-only warning fired once per process when the inbound chat request has
 * no abort signal. Real production traffic on Hono always populates
 * `c.req.raw.signal`; absence here means a runtime/adapter change has
 * regressed cancellation. Silent in prod and tests.
 */
export function warnIfChatAbortSignalMissing(
  signal: AbortSignal | undefined,
  source: string
): void {
  if (signal || warnedMissingAbortSignal) return;
  warnedMissingAbortSignal = true;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.NODE_ENV === "test") return;
  logger.warn(
    "[mcpjam-stream-handler] inbound chat request has no AbortSignal; " +
      "client disconnect will not cancel the agentic loop",
    { source }
  );
}

/**
 * Event payloads for the chunk-level + step-level callbacks exposed by
 * the chat engine to its callers. Engine consolidation PR 5b-pre
 * (`~/mcpjam-docs/unification.md`) adds these so eval's backend stream
 * runner can wire SSE events from engine signals when PR 5b collapses
 * `streamIterationViaBackend` onto the shared engine. Chat + synthetic
 * pass nothing today and are unaffected.
 *
 * `promptIndex` mirrors `traceTurn.promptIndex` — eval needs it for
 * trace span correlation; chat / synthetic ignore it.
 */
export interface MCPJamToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
  stepIndex: number;
  promptIndex: number;
  serverId: string | undefined;
}

export interface MCPJamToolResultEvent {
  toolCallId: string;
  /** May be undefined when the chunk lacks toolName (older Convex versions). */
  toolName: string | undefined;
  output: unknown;
  /**
   * Browser-rendered MCP App eval PR 14: the raw, unscrubbed implementation
   * result the tool's `execute` returned (the `result:` extra
   * `executeToolCallsFromMessages` stamps on the part for UI hydration).
   * `output` above is the LLM-facing view — for MCP App tools that view is
   * scrubbed of `_meta` / `structuredContent`, which the eval runner's widget
   * render hook needs to feed the OpenAI-compat shim with full fidelity.
   * Undefined for tools that don't carry the raw extra (e.g. `toModelOutput`
   * tools, denial results).
   */
  rawResult?: unknown;
  /** `true` when the tool execution returned an error result (vs. an OK output). */
  isError: boolean;
  stepIndex: number;
  promptIndex: number;
  serverId: string | undefined;
}

export interface MCPJamStepFinishEvent {
  stepIndex: number;
  promptIndex: number;
  /**
   * Cumulative usage for this TURN as of step completion (the engine
   * tracks per-turn aggregates, not per-step deltas). Callers compute
   * per-step deltas across successive `onStepFinish` invocations if
   * they need them. Undefined when the engine has no usage signal for
   * this step.
   */
  turnUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /**
   * **Step SETTLED, not necessarily successful.** `onStepFinish` fires
   * once per `processOneStep` return, regardless of outcome — including
   * the non-OK HTTP / no-body / decode-error branches that emit an
   * `error` UI chunk + failure trace event and return
   * `didEmitFinish: false`. Callers that map this to a higher-level
   * "step succeeded" SSE event (eval's `step_finish`) MUST gate on
   * `settledWithError === false`, OR consume failure events from the
   * UI/trace stream and treat `onStepFinish` as a settle-once
   * notification.
   *
   * Marcelo's PR 5b-pre review caveat: if PR 5b wires this directly to
   * eval `step_finish` SSE, failed backend steps would emit
   * `step_finish` where the pre-collapse runner only emitted error /
   * failure trace. Surfacing the settle state on the event lets the
   * wire-up decide.
   */
  settledWithError: boolean;
  /**
   * PR 5b-followup-2: snapshot of the engine's per-turn spans as of
   * step settlement. The engine accumulates LLM-step + tool spans on
   * `traceTurn.turnSpans` while the agentic loop runs but only
   * surfaces them post-turn via `PersistedTurnTrace.spans`. Eval's
   * mid-turn `step_finish` `trace_snapshot` (Cursor #5b "Step
   * snapshots omit LLM spans") would otherwise show only prior-turn
   * spans + the runner's local tool-instrumentation spans, dropping
   * the active turn's engine-recorded per-step LLM timing. The shape
   * is a SNAPSHOT (defensive copy) — callers may retain it across
   * step boundaries without race risk against the engine's continued
   * mutation of `traceTurn.turnSpans`. Empty array when the engine
   * has no spans yet for this turn (failed first step, etc).
   */
  turnSpans: EvalTraceSpan[];
}

/**
 * PR 5b-followup-2: structured error event fired when the engine
 * catches an error mid-step and routes it through the writer as an
 * `error` UI chunk. Eval's backend stream runner consumes this to
 * surface guardrail detail (e.g. 429 daily-cap "Daily MCPJam model
 * limit reached. Use BYOK or try again tomorrow.") on its `error`
 * SSE event — without the callback, `streamSink: "none"` consumers
 * only see the engine's generic fallback message because the UI
 * chunk goes to the no-op writer.
 *
 * Three fire sites in the engine:
 *  1. Non-OK Convex `/stream` HTTP response in `processOneStep` —
 *     structured fields populated when the body parsed as
 *     `{ code?, error, details? }` (the standard guardrail shape).
 *  2. `processStream` / tool-execution catch in `processOneStep` —
 *     `message` only (decode / tool-throw error).
 *  3. Outer agentic-loop catch in `runChatEngineLoop` — `message`
 *     only (anything else that escaped the per-step handlers).
 */
export interface MCPJamEngineErrorEvent {
  /**
   * Human-readable display message. For site (1) when the body
   * parsed structured, this is `"<error> <details>"`; otherwise the
   * raw response text or the Error.message.
   */
  message: string;
  /** Structured error code when the body parsed as a guardrail response. */
  code?: string;
  /** Structured details string when the body parsed as a guardrail response. */
  details?: string;
  /** HTTP status when the error came from a non-OK response (site 1 only). */
  httpStatus?: number;
  /**
   * Raw response body / `Error.message` text — always present for
   * logging / debugging. Callers should prefer `message` for display.
   */
  rawText: string;
  promptIndex: number;
  /** Step index when fired inside `processOneStep`; omitted for site (3). */
  stepIndex?: number;
}

export interface MCPJamHandlerOptions {
  messages: ModelMessage[];
  modelId: string;
  /**
   * Logical provider for span metadata (OTel `gen_ai.provider.name`, e.g.
   * "anthropic"). Threaded from the caller's model config — never derived from
   * `modelId`. Optional: when omitted, llm/step spans simply lack `provider`.
   */
  provider?: string;
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  /**
   * MCPJam's own server-executed built-in tools (e.g. web_search) as a subset
   * of `tools`. The emulated engine reads them from `tools`; the harness path
   * needs them SEPARATELY because the harness's MCP-server tools arrive via
   * `.mcp.json` — only these host-executed tools are forwarded to
   * `HarnessAgent({ tools })`, where the runtime calls them and the agent runs
   * their `execute()` back on this server. Excludes appTools (no execute —
   * browser-fulfilled) and skills (the harness has its own).
   */
  builtInTools?: ToolSet;
  /**
   * WS5 foundation: reusable instruction bundles for the harness runtime,
   * forwarded to `new HarnessAgent({ skills })`. Harness-only (emulated ignores).
   * Empty/unset today — hosted-mode skills authoring is a separate workstream.
   */
  skills?: unknown[];
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  projectId?: string;
  chatSessionId?: string;
  sourceType?: string;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  /** Real agent harness for this turn (absent ⇒ MCPJam's emulated engine).
   *  When "claude-code", handleMCPJamFreeChatModel routes to runHarnessTurn. */
  harness?: Harness;
  /** Which MCP-proxy plane the harness uses to route its MCP through MCPJam —
   *  set by the CALLER ROUTE (local `/api/mcp/*` vs hosted `/api/web/*`), not a
   *  global env. Absent ⇒ harness runs without proxied MCP. See
   *  `harness-proxy-strategy.ts`. */
  harnessMcpProxy?: HarnessMcpProxyStrategy;
  requireToolApproval?: boolean;
  /**
   * Host/client policy for eligible MCP tool-result content/resources.
   * Controls only model-facing tool output; raw results remain available to
   * UI/debug history.
   */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Approval-pause policy. `"prompt"` (default) is the real-chat path:
   * approval-required tool calls pause the loop until the user answers
   * via the next round-trip. `"auto-deny"` is the synthetic-session
   * path: each approval-required tool call resolves with an
   * `approval-denied (synthetic session)` error result and the loop
   * continues so the model can adapt. Real chat call sites pass
   * `"prompt"` (or omit the option); the synthetic-session runner
   * passes `"auto-deny"`.
   */
  approvalMode?: "prompt" | "auto-deny";
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace,
    // §3: present only for chat-backed harness turns — the resume-state commit
    // to apply atomically with the transcript via /ingest-chat.
    harnessSessionCommit?: HarnessSessionCommitPayload
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onLiveTextDelta?: (delta: string) => void;
  /**
   * Engine consolidation PR 5b-pre — fires from the chunk-processing
   * switch when Convex emits a `tool-input-available` chunk (the AI
   * SDK v6 equivalent of `tool-call`). Eval's backend stream runner
   * uses this to emit the `tool_call` SSE event. Chat / synthetic
   * omit; the engine writer still writes the `tool-input-available`
   * UI chunk verbatim regardless.
   */
  onToolCall?: (event: MCPJamToolCallEvent) => void;
  /**
   * Engine consolidation PR 5b-pre — fires from the local tool-result
   * persistence path AFTER the engine writes the `tool-output-available`
   * UI chunk and the `tool_result` trace event. Eval's backend stream
   * runner uses this to emit the `tool_result` SSE event. Chat /
   * synthetic omit.
   *
   * Browser-rendered MCP App eval PR 14: a returned promise is AWAITED
   * before the engine proceeds to the next step. The eval runner's widget
   * render hook relies on this ordering — the harness must have the widget
   * mounted before the next step's `prepareAdvertisedTools` gate decides
   * whether to advertise `computer` / `finish_widget`. Sync callbacks
   * (chat / eval SSE emitters) are unaffected.
   */
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>;
  /**
   * Engine consolidation PR 5b-pre — fires from `runChatEngineLoop`
   * after each `processOneStep` returns and the step counter
   * increments. Eval's backend stream runner uses this to emit the
   * `step_finish` SSE event. Chat / synthetic omit.
   */
  onStepFinish?: (event: MCPJamStepFinishEvent) => void;
  /**
   * PR 5b-followup-2: structured-error callback. Fires when the
   * engine catches a non-OK Convex `/stream` response (e.g. 429 daily
   * spend cap), a `processStream` / tool-execution throw, or any
   * outer agentic-loop error — i.e. every site that emits a writer
   * `error` UI chunk + a trace `error` event. For non-OK responses,
   * the structured `{ code?, error, details? }` body is parsed and
   * populated on the event so `streamSink: "none"` consumers (eval's
   * backend stream runner) can surface guardrail detail on their own
   * error SSE event instead of dropping the actual reason. Chat /
   * synthetic omit; the writer-side error chunk still fires regardless.
   */
  onEngineError?: (event: MCPJamEngineErrorEvent) => void;
  /**
   * Browser-rendered MCP App eval PR 2 — optional per-step hook that narrows
   * the *advertised* tool set the model sees this step. Called inside
   * `processOneStep` after the active tool subset is resolved, with
   * `{ stepIndex, defaultToolNames }` (the names that would otherwise be
   * advertised). Returns the subset of names to keep, or `undefined` for "no
   * narrowing". Names not in `defaultToolNames` are ignored (defense-in-depth:
   * a caller can't smuggle in a non-advertised tool). A throw is logged and
   * falls back to the default set. This is *runtime-conditional advertising*
   * (e.g. hide `computer` / `finish_widget` until a widget has rendered) and
   * is distinct from progressive discovery (lazy MCP tool catalogs). Chat /
   * synthetic omit; the eval runner closes over harness state to decide.
   */
  prepareAdvertisedTools?: PrepareAdvertisedTools;
  /**
   * Override the Convex endpoint path for the per-step LLM call.
   * Defaults to "/stream". Org BYOK chat uses "/stream/org".
   */
  endpointPath?: string;
  /**
   * Extra headers added to every per-step Convex request. The standard
   * authHeader is forwarded so Convex can resolve the caller for /stream and
   * /stream/org.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Extra body fields merged into every per-step Convex request. Used by org
   * BYOK chat to send the providerKey alongside the model id.
   */
  extraBodyFields?: Record<string, unknown>;
  /**
   * Originating client IP from the inbound request. Hashed and forwarded as
   * `x-mcpjam-guest-ip-hash` so Convex can apply the per-IP daily spend cap
   * for guests in addition to the per-cookie cap. Null when no IP is
   * available (dev / missing forwarded-for), in which case the header is
   * omitted and Convex falls back to the per-cookie guest cap.
   */
  clientIp?: string | null;
  /**
   * Inbound request signal. Forwarded into the per-step Convex fetch and the
   * local tool executor. When aborted, the agentic loop terminates silently:
   * no error chunk, no synthetic finish, no `turn_finish`, no
   * `onConversationComplete`. `onStreamComplete` still runs so callers can
   * release per-request resources (e.g. MCPClientManager teardown).
   */
  abortSignal?: AbortSignal;
  /**
   * Idle heartbeat interval. While the stream has been silent for at least
   * this many ms, the handler writes a transient `heartbeat` trace event so
   * LB/proxy idle timers don't sever the SSE connection. Defaults to
   * 15_000ms. `0` disables (used by tests).
   */
  heartbeatIntervalMs?: number;
  /**
   * Total per-turn step budget. The loop terminates when
   * `promptStepBaseIndex + steps >= maxSteps` so resumed approval requests
   * cannot keep extending the budget. Defaults to 30.
   */
  maxSteps?: number;
  /**
   * Optional progressive discovery context. When `plan.enabled === true` the
   * handler computes the per-step active tool definitions instead of sending
   * the full tool list on every Convex request. When omitted or
   * `plan.enabled === false`, behavior is unchanged.
   */
  progressivePlan?: ProgressiveToolPlan;
  /** Mutated by load_mcp_tools execute() — read between steps to rebuild defs. */
  discoveryState?: ToolDiscoveryState;
}

interface StepContext {
  writer: {
    write: (chunk: UIMessageChunk) => void;
  };
  messageHistory: ModelMessage[];
  /**
   * Full serialized tool list. In non-progressive mode this is what's sent
   * to Convex. In progressive mode the handler filters to active tools per
   * step using `progressivePlan` + `discoveryState`.
   */
  toolDefs: ToolDefinition[];
  /** Map from model-facing tool name → serialized def, for progressive mode. */
  toolDefsByName: Map<string, ToolDefinition>;
  tools: ToolSet;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  projectId?: string;
  chatSessionId?: string;
  sourceType?: string;
  modelId: string;
  /** Logical provider for span metadata (OTel gen_ai.provider.name). */
  provider?: string;
  systemPrompt: string;
  temperature?: number;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  requireToolApproval?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  approvalMode?: "prompt" | "auto-deny";
  stepIndex: number;
  usedToolCallIds: Set<string>;
  traceTurn: LiveTraceTurnContext;
  endpointPath: string;
  extraHeaders?: Record<string, string>;
  extraBodyFields?: Record<string, unknown>;
  clientIp?: string | null;
  onLiveTextDelta?: (delta: string) => void;
  // PR 5b-pre: chunk-level + step-level callbacks. Threaded to the
  // chunk-processing switch (onToolCall / onToolResult) and to the
  // step loop (onStepFinish). All optional.
  onToolCall?: (event: MCPJamToolCallEvent) => void;
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>;
  onStepFinish?: (event: MCPJamStepFinishEvent) => void;
  // PR 5b-followup-2: structured-error callback. Fires at every site
  // that emits a writer `error` UI chunk (non-OK Convex response in
  // processOneStep, processStream/tool-execution catch, outer
  // agentic-loop catch). Optional.
  onEngineError?: (event: MCPJamEngineErrorEvent) => void;
  // Browser-rendered MCP App eval PR 2: per-step advertised-tool narrowing.
  prepareAdvertisedTools?: MCPJamHandlerOptions["prepareAdvertisedTools"];
  abortSignal?: AbortSignal;
}

type PersistedAssistantPart = TextPart | ToolCallPart | ReasoningUIPart;

interface LiveTraceTurnContext {
  turnId: string;
  promptIndex: number;
  promptMessageStartIndex: number;
  turnStartedAt: number;
  turnSpans: EvalTraceSpan[];
  turnUsage?: LiveChatTraceUsage;
}

interface StreamResult {
  contentParts: PersistedAssistantPart[];
  hasToolCalls: boolean;
  finishChunk: UIMessageChunk | null;
  /**
   * Absolute Date.now() of the first emitted stream chunk, for
   * time-to-first-chunk (OTel gen_ai.response.time_to_first_chunk). Undefined
   * if the stream produced no chunks.
   */
  firstChunkAt?: number;
}

/**
 * Generate a unique tool call ID
 */
function generateToolCallId(): string {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function collectUsedToolCallIds(messages: ModelMessage[]): Set<string> {
  const usedToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (
          (part.type === "tool-call" ||
            part.type === "tool-approval-request") &&
          typeof part.toolCallId === "string"
        ) {
          usedToolCallIds.add(part.toolCallId);
        }
      }
      continue;
    }

    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (
          part.type === "tool-result" &&
          typeof part.toolCallId === "string"
        ) {
          usedToolCallIds.add(part.toolCallId);
        }
      }
    }
  }

  return usedToolCallIds;
}

function hasUnresolvedClientFulfilledToolCalls(
  messages: ModelMessage[],
  tools: ToolSet
): boolean {
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    const toolMsg = msg as ToolModelMessage;
    if (!Array.isArray(toolMsg.content)) continue;
    for (const part of toolMsg.content) {
      if (part.type === "tool-result") resultIds.add(part.toolCallId);
    }
  }

  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    const assistantMsg = msg as AssistantModelMessage;
    if (!Array.isArray(assistantMsg.content)) continue;
    for (const part of assistantMsg.content) {
      if (part.type !== "tool-call" || resultIds.has(part.toolCallId)) {
        continue;
      }
      const toolName = part.toolName;
      const toolEntry = (
        tools as Record<string, { execute?: unknown } | undefined>
      )[toolName];
      if (
        isClientFulfilledToolName(toolName) &&
        toolEntry &&
        typeof toolEntry.execute !== "function"
      ) {
        return true;
      }
    }
  }
  return false;
}

function generateUniqueToolCallId(
  usedToolCallIds: Set<string>,
  prefix = "tc"
): string {
  const MAX_ATTEMPTS = 100;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const nextId = `${prefix}_${generateToolCallId()}`;
    if (!usedToolCallIds.has(nextId)) {
      usedToolCallIds.add(nextId);
      return nextId;
    }
  }
  // Fallback: use a counter-based ID that is guaranteed unique
  const fallbackId = `${prefix}_fallback_${Date.now()}_${usedToolCallIds.size}`;
  usedToolCallIds.add(fallbackId);
  return fallbackId;
}

function createToolCallIdNormalizer(
  usedToolCallIds: Set<string>,
  stepIndex: number
): (rawToolCallId?: string) => string {
  const perStepMap = new Map<string, string>();
  let collisionCounter = 0;

  return (rawToolCallId?: string): string => {
    if (!rawToolCallId) {
      return generateUniqueToolCallId(usedToolCallIds, `step${stepIndex + 1}`);
    }

    const existing = perStepMap.get(rawToolCallId);
    if (existing) return existing;

    let normalized = rawToolCallId;
    if (usedToolCallIds.has(normalized)) {
      do {
        collisionCounter += 1;
        normalized = `${rawToolCallId}__s${stepIndex + 1}_${collisionCounter}`;
      } while (usedToolCallIds.has(normalized));
    }

    perStepMap.set(rawToolCallId, normalized);
    usedToolCallIds.add(normalized);
    return normalized;
  };
}

function getPromptAssistantStepBaseIndex(
  messageHistory: ModelMessage[],
  promptMessageStartIndex: number
): number {
  let assistantCount = 0;
  for (
    let index = promptMessageStartIndex;
    index < messageHistory.length;
    index += 1
  ) {
    if (messageHistory[index]?.role === "assistant") {
      assistantCount += 1;
    }
  }
  return assistantCount;
}

function readUsageFromFinishChunk(
  finishChunk: UIMessageChunk | null
): LiveChatTraceUsage | undefined {
  if (!finishChunk || finishChunk.type !== "finish") {
    return undefined;
  }

  // The Convex /stream endpoint sends token data via `messageMetadata` on the
  // finish chunk (using toUIMessageStreamResponse's messageMetadata callback).
  // Fall back to `totalUsage` for compatibility with test mocks / future changes.
  const chunk = finishChunk as UIMessageChunk & {
    totalUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    messageMetadata?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  const usage = chunk.messageMetadata ?? chunk.totalUsage;
  if (!usage) {
    return undefined;
  }

  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number") {
    next.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    next.outputTokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    next.totalTokens = usage.totalTokens;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Read the model finish reason off a per-step `finish` chunk and normalize it
 * to the canonical span vocabulary. Returns undefined when absent — span
 * capture never fabricates one.
 */
function readFinishReasonFromChunk(
  finishChunk: UIMessageChunk | null
): string | undefined {
  type FinishUIMessageChunk = Extract<UIMessageChunk, { type: "finish" }>;
  const source = finishChunk as Partial<FinishUIMessageChunk> | null;
  return normalizeFinishReason(source?.finishReason);
}

function createClientFinishChunk(
  finishChunk: UIMessageChunk | null,
  traceTurn: LiveTraceTurnContext | null,
  fallbackReason: "length" | "stop"
): UIMessageChunk {
  type FinishUIMessageChunk = Extract<UIMessageChunk, { type: "finish" }>;
  const source = finishChunk as Partial<FinishUIMessageChunk> | null;
  // Prefer the turn-level aggregate so multi-step (tool-call) turns report the
  // sum across all LLM calls, not just the final step.
  const aggregateUsage = traceTurn?.turnUsage;
  const usage =
    aggregateUsage ??
    (finishChunk
      ? readUsageFromFinishChunk(finishChunk)
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const metadata = source?.messageMetadata;
  const messageMetadata =
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    usage
      ? { ...metadata, ...usage }
      : metadata ?? usage;

  return buildFinishChunk({
    finishReason: source?.finishReason ?? fallbackReason,
    messageMetadata,
  });
}

function setStepSpanMessageRanges(
  spans: EvalTraceSpan[],
  promptIndex: number,
  stepIndex: number,
  messageStartIndex: number | undefined,
  messageEndIndex: number | undefined
): void {
  if (
    typeof messageStartIndex !== "number" ||
    typeof messageEndIndex !== "number" ||
    messageEndIndex < messageStartIndex
  ) {
    return;
  }

  for (const span of spans) {
    if (
      (span.promptIndex ?? 0) !== promptIndex ||
      span.stepIndex !== stepIndex
    ) {
      continue;
    }
    if (typeof span.messageStartIndex !== "number") {
      span.messageStartIndex = messageStartIndex;
    }
    if (typeof span.messageEndIndex !== "number") {
      span.messageEndIndex = messageEndIndex;
    }
  }
}

/**
 * Strip UI-only fields from reasoning parts so the backend payload matches
 * the provider/model-message shape. `state: "done"` is added by
 * `processStream` while buffering reasoning chunks, but the AI SDK provider
 * shape does not include it; passing it through is a runtime no-op but
 * shows up in the wire payload and can trip strict validators.
 */
function normalizePreservedReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const assistantMsg = msg as AssistantModelMessage;
    if (!Array.isArray(assistantMsg.content)) return msg;
    let changed = false;
    const nextContent = assistantMsg.content.map((part) => {
      if (part?.type !== "reasoning") return part;
      const reasoningPart = part as unknown as Record<string, unknown>;
      if (!("state" in reasoningPart)) {
        return part;
      }
      const { state: _state, ...rest } = reasoningPart;
      changed = true;
      return rest as unknown as typeof part;
    });
    return changed ? ({ ...msg, content: nextContent } as ModelMessage) : msg;
  });
}

/**
 * Scrub messages for sending to the backend LLM.
 * Removes UI-specific metadata that shouldn't be sent to the model.
 *
 * `preserveReasoningFromIndex` is the index of the first message in the
 * *current* user turn (post the latest user message). Messages at or after
 * that index keep their reasoning parts so a thinking model can see its
 * own scratchpad between tool steps. Messages before that index still get
 * reasoning pruned to match prior behavior.
 */
function scrubMessagesForBackend(
  messages: ModelMessage[],
  tools: ToolSet,
  mcpClientManager: MCPClientManager,
  selectedServers?: string[],
  preserveReasoningFromIndex?: number
): ModelMessage[] {
  let pruned: ModelMessage[];
  if (
    typeof preserveReasoningFromIndex === "number" &&
    preserveReasoningFromIndex > 0 &&
    preserveReasoningFromIndex < messages.length
  ) {
    const priorTurn = messages.slice(0, preserveReasoningFromIndex);
    const currentTurn = messages.slice(preserveReasoningFromIndex);
    const prunedPrior = pruneMessages({
      messages: priorTurn,
      reasoning: "all",
    }) as unknown as ModelMessage[];
    // Strip UI-only `state` field from reasoning parts that survive the
    // current-turn slice; the backend/provider doesn't recognize it.
    const normalizedCurrent = normalizePreservedReasoning(currentTurn);
    pruned = [...prunedPrior, ...normalizedCurrent];
  } else {
    pruned = pruneMessages({
      messages,
      reasoning: "all",
    }) as unknown as ModelMessage[];
  }

  // First strip approval-specific parts that Convex/OpenRouter doesn't understand
  const stripped: ModelMessage[] = pruned.map((msg) => {
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) return msg;
      const filtered = assistantMsg.content.filter(
        (part) => part.type !== "tool-approval-request"
      );
      if (filtered.length === assistantMsg.content.length) return msg;
      return { ...msg, content: filtered } as ModelMessage;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      const filtered = toolMsg.content.filter(
        (part) => part.type !== "tool-approval-response"
      );
      if (filtered.length === toolMsg.content.length) return msg;
      return { ...msg, content: filtered } as ModelMessage;
    }

    return msg;
  });

  const withoutUnavailableToolHistory = scrubUnavailableToolHistoryForBackend(
    stripped,
    Object.keys(tools as Record<string, unknown>)
  );

  const scrubbed = scrubChatGPTAppsToolResultsForBackend(
    scrubMcpAppsToolResultsForBackend(
      withoutUnavailableToolHistory,
      mcpClientManager,
      selectedServers
    ),
    mcpClientManager,
    selectedServers
  );
  return normalizeModelMessagesForConvex(scrubbed);
}

function safelyEmitLiveTextDelta(
  onLiveTextDelta: ((delta: string) => void) | undefined,
  delta: string
) {
  if (!onLiveTextDelta) return;
  safelyInvoke("[mcpjam-stream-handler] onLiveTextDelta", () =>
    onLiveTextDelta(delta),
  );
}

/**
 * PR 5b-followup-2: parse a Convex `/stream` non-OK response body as
 * the standard guardrail JSON shape `{ code?, error, details? }`.
 * Falls back to a generic `<status> <text>` message when the body
 * isn't structured. Mirrors the legacy
 * `describeBackendStreamError` shape that lived in
 * evals-runner before PR 5b's collapse — moved into the engine here
 * so `onEngineError` consumers see the same parsed display message.
 */
function parseEngineErrorBody(
  status: number | undefined,
  bodyText: string
): { message: string; code?: string; details?: string } {
  try {
    const body = JSON.parse(bodyText) as {
      code?: string;
      error?: string;
      details?: string;
    };
    if (body?.error) {
      return {
        message: body.details ? `${body.error} ${body.details}` : body.error,
        ...(body.code ? { code: body.code } : {}),
        ...(body.details ? { details: body.details } : {}),
      };
    }
  } catch {
    // body wasn't JSON — fall through to generic shape
  }
  return {
    message:
      status !== undefined
        ? `Backend stream error: ${status} ${bodyText}`
        : bodyText,
  };
}

/**
 * PR 5b-followup-2: safe-fire wrapper for `onEngineError`. Mirrors
 * the chunk-callback shape (try/catch + `logger.warn`) so a buggy
 * eval emitter can't crash the agentic loop.
 */
function safelyEmitEngineError(
  onEngineError: ((event: MCPJamEngineErrorEvent) => void) | undefined,
  event: MCPJamEngineErrorEvent
) {
  if (!onEngineError) return;
  safelyInvoke("[mcpjam-stream-handler] onEngineError", () =>
    onEngineError(event),
  );
}

/**
 * Process the SSE stream from Convex and extract content parts.
 * Forwards relevant chunks to the client while building up the message content.
 */
async function processStream(
  body: ReadableStream<Uint8Array>,
  writer: StepContext["writer"],
  normalizeToolCallId: (toolCallId?: string) => string,
  traceTurn: LiveTraceTurnContext,
  stepIndex: number,
  tools: ToolSet,
  requireToolApproval?: boolean,
  onLiveTextDelta?: (delta: string) => void,
  abortSignal?: AbortSignal,
  progressivePlan?: ProgressiveToolPlan,
  // PR 5b-pre: chunk-level callbacks. Optional; only fired when
  // supplied. Chat / synthetic omit (handler still writes the UI
  // chunk + trace event unchanged).
  onToolCall?: (event: MCPJamToolCallEvent) => void
): Promise<StreamResult> {
  const contentParts: PersistedAssistantPart[] = [];
  let pendingText = "";
  let pendingReasoning = "";
  let pendingReasoningId: string | null = null;
  let hasToolCalls = false;
  let finishChunk: UIMessageChunk | null = null;
  let firstChunkAt: number | undefined;

  const flushText = () => {
    if (pendingText) {
      contentParts.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  const flushReasoning = () => {
    if (pendingReasoning) {
      contentParts.push({
        type: "reasoning",
        text: pendingReasoning,
        state: "done",
      });
      pendingReasoning = "";
    }
    pendingReasoningId = null;
  };

  const parsedStream = parseJsonEventStream({
    stream: body,
    schema: streamChunkSchema as any,
  });
  const reader = parsedStream.getReader();

  // Wire abort to reader cancellation so `reader.read()` unblocks
  // immediately when the client disconnects. The listener is removed in the
  // finally below to prevent leaks across steps.
  let abortListener: (() => void) | undefined;
  if (abortSignal) {
    if (abortSignal.aborted) {
      reader.cancel().catch(() => undefined);
    } else {
      abortListener = () => {
        reader.cancel().catch(() => undefined);
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (!value?.success) {
        // PR 5b-followup-2 review fix (CodeRabbit Major "Parser failures
        // still bypass onEngineError and the real failure path"): the
        // pre-fix shape wrote an error UI chunk and `break`'d out of
        // the loop. processStream then returned NORMALLY with whatever
        // contentParts had accumulated, processOneStep ran its
        // post-stream epilogue, and the outer agentic loop marked the
        // turn successful (runSucceeded = true) — `onEngineError`
        // never fired and the eval runner's failure detection didn't
        // trip. Throw instead so the failure lands in
        // `runChatEngineLoop`'s outer catch, which fires
        // `onEngineError` (site #3), writes the error+turn_finish
        // trace events, and skips the success epilogue. The thrown
        // Error carries the parser's message so the engine-error
        // contract stays consistent.
        const parseErr = (value as { error?: unknown })?.error;
        throw parseErr instanceof Error
          ? parseErr
          : new Error(
              typeof parseErr === "object" &&
              parseErr !== null &&
              "message" in parseErr &&
              typeof (parseErr as { message?: unknown }).message === "string"
                ? (parseErr as { message: string }).message
                : "stream parse failed"
            );
      }

      const chunk = value.value as UIMessageChunk & {
        totalUsage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        [key: string]: unknown;
      };

      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }

      // Skip backend stub tool outputs - we execute tools locally
      if (
        chunk?.type === "tool-output-available" ||
        chunk?.type === "tool-output-error"
      ) {
        continue;
      }

      // Handle chunk by type
      switch (chunk?.type) {
        case "text-start":
          flushReasoning();
          flushText();
          writer.write(chunk);
          break;

        case "text-delta":
          flushReasoning();
          pendingText += chunk.delta ?? "";
          if (chunk.delta) {
            safelyEmitLiveTextDelta(onLiveTextDelta, chunk.delta);
          }
          writer.write(chunk);
          if (chunk.delta) {
            writeTraceEvent(writer, {
              type: "text_delta",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex,
              delta: chunk.delta,
            });
          }
          break;

        case "text-end":
          flushText();
          writer.write(chunk);
          break;

        case "reasoning-start":
          flushText();
          flushReasoning();
          pendingReasoningId = chunk.id;
          writer.write(chunk);
          break;

        case "reasoning-delta":
          flushText();
          if (pendingReasoningId !== null && chunk.id !== pendingReasoningId) {
            flushReasoning();
          }
          pendingReasoningId = chunk.id;
          pendingReasoning += chunk.delta ?? "";
          writer.write(chunk);
          break;

        case "reasoning-end":
          if (pendingReasoningId !== null && chunk.id !== pendingReasoningId) {
            flushReasoning();
            pendingReasoningId = chunk.id;
          }
          flushReasoning();
          writer.write(chunk);
          break;

        case "tool-input-start":
        case "tool-input-delta":
        case "tool-input-error": {
          flushText();
          flushReasoning();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          writer.write({ ...chunk, toolCallId });
          break;
        }

        case "tool-input-available": {
          flushText();
          flushReasoning();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          const serverIdForToolCall = readToolServerId(tools, chunk.toolName);
          const providerMetadata = mergeMcpToolOriginMetadata(
            chunk.providerMetadata,
            serverIdForToolCall
          );
          contentParts.push({
            type: "tool-call",
            toolCallId,
            toolName: chunk.toolName,
            input: chunk.input ?? {},
            ...(providerMetadata ? { providerOptions: providerMetadata } : {}),
          });
          hasToolCalls = true;
          writer.write({
            ...chunk,
            toolCallId,
            ...(providerMetadata ? { providerMetadata } : {}),
          });
          writeTraceEvent(writer, {
            type: "tool_call",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
            stepIndex,
            toolCallId,
            toolName: chunk.toolName,
            input: toTraceRecord(chunk.input),
            serverId: serverIdForToolCall,
          });
          // PR 5b-pre: fire chunk-level callback so eval's backend
          // stream runner (PR 5b) can emit the `tool_call` SSE event.
          // Chat / synthetic don't supply this callback.
          if (onToolCall) {
            try {
              onToolCall({
                toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
                stepIndex,
                promptIndex: traceTurn.promptIndex,
                serverId: serverIdForToolCall,
              });
            } catch (error) {
              logger.warn(
                "[mcpjam-stream-handler] onToolCall callback failed",
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }

          if (
            requireToolApproval &&
            !isApprovalFreeMetaToolName(chunk.toolName, progressivePlan)
          ) {
            emitToolApprovalRequest(writer, {
              approvalId: generateToolCallId(),
              toolCallId,
            });
          }
          break;
        }

        case "start":
          // Skip Convex's start chunk — its messageId would override the
          // SDK's message identity, causing a new assistant message instead
          // of continuing the existing one.
          break;

        case "finish":
          finishChunk = chunk;
          // Don't write finish yet - wait until we know we're done
          break;

        default:
          // Forward other chunks (step-start, etc.)
          writer.write(chunk);
      }
    }
  } finally {
    if (abortListener && abortSignal) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }

  flushText();
  flushReasoning();
  // If we exited the read loop because of an abort, surface it so the
  // caller can take the silent-cancellation path (no error, no finish).
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  }
  return { contentParts, hasToolCalls, finishChunk, firstChunkAt };
}

/**
 * Emit tool results to the client stream.
 * Called after tools have been executed locally.
 */
async function emitToolResults(
  writer: StepContext["writer"],
  mcpClientManager: MCPClientManager,
  newMessages: ModelMessage[],
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
  // PR 5b-pre: optional chunk-level callback so eval's backend stream
  // runner (PR 5b) can emit the `tool_result` SSE event. Chat /
  // synthetic don't supply this callback — the UI writer + trace event
  // still fire unchanged. PR 14: a returned promise is awaited so the
  // eval render hook completes before the engine's next step.
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>
): Promise<void> {
  for (const msg of newMessages) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          const toolName =
            typeof (part as any).toolName === "string"
              ? ((part as any).toolName as string)
              : undefined;
          const serverId =
            typeof (part as any).serverId === "string"
              ? ((part as any).serverId as string)
              : undefined;
          // Some tool outputs have a model-facing `output` and a raw MCP
          // `result`. UI must use the raw result when the model-facing copy
          // drops fields widgets need (structuredContent) or turns images into
          // media parts for the model.
          const rawResult = (part as any).result;
          const rawOutput =
            rawResult &&
            typeof rawResult === "object" &&
            ("structuredContent" in rawResult ||
              isModelVisibleImageOutput(part.output))
              ? rawResult
              : part.output ?? rawResult;

          let outputForUi: unknown = rawOutput;
          if (rawOutput && typeof rawOutput === "object") {
            const rawOutputObj = rawOutput as Record<string, unknown>;
            const existingMeta =
              rawOutputObj._meta &&
              typeof rawOutputObj._meta === "object" &&
              rawOutputObj._meta !== null
                ? (rawOutputObj._meta as Record<string, unknown>)
                : {};
            const toolMeta =
              serverId && toolName
                ? mcpClientManager.getAllToolsMetadata(serverId)[toolName] ?? {}
                : {};

            // Include descriptor metadata in streamed output so shared/minimal chat
            // can render app widgets without a tools/list prefetch.
            outputForUi = {
              ...rawOutputObj,
              _meta: {
                ...toolMeta,
                ...existingMeta,
                ...(serverId ? { _serverId: serverId } : {}),
              },
            };
          }

          // Prefer full result (with _meta/structuredContent) for UI. No
          // providerExecuted: emulated tools are client/Convex-executed.
          emitToolOutput(writer, {
            toolCallId: part.toolCallId,
            output: outputForUi,
          });

          if (traceTurn && typeof stepIndex === "number") {
            const errorText =
              part.output?.type === "error-text" &&
              typeof part.output.value === "string"
                ? part.output.value
                : undefined;
            writeTraceEvent(writer, {
              type: "tool_result",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex,
              toolCallId: part.toolCallId,
              toolName: toolName ?? part.toolName ?? "unknown",
              output: outputForUi,
              errorText,
              serverId,
            });
            // PR 5b-pre: fire chunk-level callback. `isError` matches
            // the AI SDK's error-text output discriminator (same shape
            // PR 5a's adapter uses for its `tool_result` SSE event).
            if (onToolResult) {
              try {
                await onToolResult({
                  toolCallId: part.toolCallId,
                  toolName: toolName ?? part.toolName,
                  output: outputForUi,
                  // PR 14: raw implementation result (unscrubbed) for the
                  // eval widget render hook; absent on parts without the
                  // `result:` UI-hydration extra.
                  rawResult: (part as { result?: unknown }).result,
                  isError: part.output?.type === "error-text",
                  stepIndex,
                  promptIndex: traceTurn.promptIndex,
                  serverId,
                });
              } catch (error) {
                logger.warn(
                  "[mcpjam-stream-handler] onToolResult callback failed",
                  {
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                );
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Emit tool-input-available events for inherited unresolved tool calls.
 * These are tool calls from previous messages that haven't been executed yet.
 */
function emitInheritedToolCalls(
  writer: StepContext["writer"],
  messageHistory: ModelMessage[],
  beforeStepLength: number,
  // PR 5b-pre review fix (Cursor Medium "Resumed approvals skip
  // onToolCall"): symmetric counterpart of the denial-path
  // `onToolResult` fix. This path writes `tool-input-available` UI
  // chunks for inherited unresolved calls — eval's PR 5b wiring needs
  // `onToolCall` to fire here too, otherwise it would see orphan
  // `tool_result` events later without a matching `tool_call`.
  tools?: ToolSet,
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
  onToolCall?: (event: MCPJamToolCallEvent) => void
) {
  // Collect existing tool result IDs
  const existingResultIds = new Set<string>();
  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }
  }

  // Emit for inherited tool calls (before this step) that don't have results
  for (let i = 0; i < beforeStepLength; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (
          part.type === "tool-call" &&
          !existingResultIds.has(part.toolCallId)
        ) {
          emitToolInput(writer, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? {},
            ...(part.providerOptions
              ? { providerMetadata: part.providerOptions }
              : {}),
          });
          // PR 5b-pre review fix (Cursor Medium): fire `onToolCall`
          // for inherited unresolved calls so PR 5b's eval wiring
          // sees a matching `tool_call` before any `tool_result`.
          if (onToolCall && traceTurn && typeof stepIndex === "number") {
            try {
              onToolCall({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                stepIndex,
                promptIndex: traceTurn.promptIndex,
                serverId: tools
                  ? readToolServerId(tools, part.toolName)
                  : undefined,
              });
            } catch (error) {
              logger.warn(
                "[mcpjam-stream-handler] onToolCall callback failed (inherited)",
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Handle pending tool approvals from the previous request.
 * When the client responds with approval/denial decisions, this function
 * processes them: executes approved tools and emits denied notifications.
 *
 * Returns true if approvals were found and handled (agentic loop should continue).
 */
async function handlePendingApprovals(
  writer: StepContext["writer"],
  messageHistory: ModelMessage[],
  tools: ToolSet,
  mcpClientManager: MCPClientManager,
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
  abortSignal?: AbortSignal,
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults,
  // PR 5b-pre: propagate the chunk-level callbacks so denial /
  // resumed-approval / approved-tool-result emissions all fire them.
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>,
  // PR 5b-pre review fix (Cursor Medium): resumed-approval branch
  // emits `tool-input-available` UI chunks — `onToolCall` must fire
  // here too so PR 5b's wiring doesn't see orphan `tool_result`.
  onToolCall?: (event: MCPJamToolCallEvent) => void
): Promise<boolean> {
  // Build approvalId → toolCallId map, toolCallId → toolName map,
  // and toolCallId → assistant message index map from assistant messages
  const approvalIdToToolCallId = new Map<string, string>();
  const toolCallIdToToolName = new Map<string, string>();
  const toolCallIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messageHistory.length; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (part.type === "tool-approval-request" && part.approvalId) {
          approvalIdToToolCallId.set(part.approvalId, part.toolCallId);
        }
        if (part.type === "tool-call" && part.toolCallId) {
          toolCallIdToToolName.set(part.toolCallId, part.toolName);
          toolCallIdToAssistantIdx.set(part.toolCallId, i);
        }
      }
    }
  }

  if (approvalIdToToolCallId.size === 0) return false;

  // Scan tool messages for approval responses
  const approvedToolCallIds = new Set<string>();
  const deniedToolCallIds = new Set<string>();

  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-approval-response" && part.approvalId) {
          const toolCallId = approvalIdToToolCallId.get(part.approvalId);
          if (!toolCallId) continue;

          if (part.approved) {
            approvedToolCallIds.add(toolCallId);
          } else {
            deniedToolCallIds.add(toolCallId);
          }
        }
      }
    }
  }

  if (approvedToolCallIds.size === 0 && deniedToolCallIds.size === 0) {
    return false;
  }

  // Collect existing tool-result IDs once to avoid re-processing approvals
  const existingResultIds = new Set<string>();
  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }
  }

  let didHandle = false;

  // Emit denied tool notifications to the client and add tool-result entries
  // to messageHistory so the LLM knows which tools were denied.
  // NOTE: convertToModelMessages does NOT produce tool-results for denied tools
  // because the client-side state is 'approval-responded', not 'output-denied'.
  if (deniedToolCallIds.size > 0) {
    // Group denied results by assistant message index
    const deniedByAssistantIdx = new Map<number, ToolResultPart[]>();

    for (const toolCallId of deniedToolCallIds) {
      if (existingResultIds.has(toolCallId)) continue;
      const toolName = toolCallIdToToolName.get(toolCallId) ?? "unknown";
      emitToolOutputDenied(writer, { toolCallId });

      if (traceTurn && typeof stepIndex === "number") {
        writeTraceEvent(writer, {
          type: "tool_result",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          toolCallId,
          toolName,
          output: {
            type: "error-text",
            value: "Tool execution denied by user.",
          },
          errorText: "Tool execution denied by user.",
        });
        // PR 5b-pre review fix (Cursor Medium "Denied approval skips
        // onToolResult"): the denial path writes the trace event
        // inline without going through `emitToolResults`, so the
        // `onToolResult` callback wasn't firing. Auto-deny via
        // `processOneStep` does fire it through the
        // `emitToolResults` → callback chain; denial via
        // `handlePendingApprovals` needs the symmetric call here so
        // PR 5b's eval wiring sees `tool_result` SSE events for
        // denied tools on resumed approval turns.
        if (onToolResult) {
          try {
            await onToolResult({
              toolCallId,
              toolName,
              output: {
                type: "error-text",
                value: "Tool execution denied by user.",
              },
              isError: true,
              stepIndex,
              promptIndex: traceTurn.promptIndex,
              serverId: undefined,
            });
          } catch (error) {
            logger.warn(
              "[mcpjam-stream-handler] onToolResult callback failed (denial path)",
              {
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }
      }

      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "error-text",
          value: "Tool execution denied by user.",
        },
      };

      const assistantIdx = toolCallIdToAssistantIdx.get(toolCallId);
      if (assistantIdx !== undefined) {
        if (!deniedByAssistantIdx.has(assistantIdx))
          deniedByAssistantIdx.set(assistantIdx, []);
        deniedByAssistantIdx.get(assistantIdx)!.push(part);
      }
    }

    if (deniedByAssistantIdx.size > 0) {
      // Insert right after corresponding assistant messages (reverse order to preserve indices)
      const sortedKeys = [...deniedByAssistantIdx.keys()].sort((a, b) => b - a);
      for (const idx of sortedKeys) {
        messageHistory.splice(idx + 1, 0, {
          role: "tool",
          content: deniedByAssistantIdx.get(idx)!,
        } as ModelMessage);
      }
      didHandle = true;
    }
  }

  // Execute approved tools: collect tool calls that were approved but don't have results yet.
  // NOTE: This must run AFTER denied results are spliced in above.
  // executeToolCallsFromMessages skips tool-call IDs that already have results
  // (via existingToolResultIds), so the denied results prevent double-execution.
  const needsExecution = [...approvedToolCallIds].some(
    (id) => !existingResultIds.has(id)
  );

  if (needsExecution) {
    // Emit tool-input-available for approved tool calls so the AI SDK client
    // can attach the upcoming tool-output-available chunks. Without this, the
    // stream consumer throws "No tool invocation found for tool call ID …"
    // because the matching tool-call was on a prior assistant message and
    // this resumed stream hasn't introduced it yet.
    for (const toolCallId of approvedToolCallIds) {
      if (existingResultIds.has(toolCallId)) continue;
      const assistantIdx = toolCallIdToAssistantIdx.get(toolCallId);
      if (assistantIdx === undefined) continue;
      const assistantMsg = messageHistory[
        assistantIdx
      ] as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (part.type === "tool-call" && part.toolCallId === toolCallId) {
          emitToolInput(writer, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? {},
            ...(part.providerOptions
              ? { providerMetadata: part.providerOptions }
              : {}),
          });
          // PR 5b-pre review fix (Cursor Medium "Resumed approvals
          // skip onToolCall"): fire `onToolCall` for resumed approved
          // tools so PR 5b's eval wiring sees a matching `tool_call`
          // before the `tool_result` `emitToolResults` produces below.
          if (onToolCall && traceTurn && typeof stepIndex === "number") {
            try {
              onToolCall({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                stepIndex,
                promptIndex: traceTurn.promptIndex,
                serverId: readToolServerId(tools, part.toolName),
              });
            } catch (error) {
              logger.warn(
                "[mcpjam-stream-handler] onToolCall callback failed (approval)",
                {
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }
          break;
        }
      }
    }

    const newMessages = await executeToolCallsFromMessages(messageHistory, {
      tools: tools as Record<string, any>,
      modelVisibleMcpToolResults,
      readLinkedResource: readLinkedMcpResourceWithManager(mcpClientManager),
      ...(abortSignal ? { abortSignal } : {}),
    });

    await emitToolResults(
      writer,
      mcpClientManager,
      newMessages,
      traceTurn,
      stepIndex,
      onToolResult
    );
    didHandle = true;
  }

  return didHandle;
}

/**
 * Process a single step of the agentic loop.
 * Calls Convex, streams the response, and executes tools if needed.
 */
async function processOneStep(
  ctx: StepContext
): Promise<{ shouldContinue: boolean; didEmitFinish: boolean }> {
  const {
    writer,
    messageHistory,
    toolDefs,
    toolDefsByName,
    tools,
    authHeader,
    chatboxId,
    accessVersion,
    projectId,
    modelId,
    provider,
    systemPrompt,
    temperature,
    mcpClientManager,
    selectedServers,
    requireToolApproval,
    modelVisibleMcpToolResults,
    approvalMode,
    stepIndex,
    usedToolCallIds,
    traceTurn,
    progressivePlan,
    discoveryState,
    // PR 5b-pre chunk-level callbacks (optional, propagated from
    // MCPJamHandlerOptions through runChatEngineLoop).
    onToolCall,
    onToolResult,
    // PR 5b-followup-2 structured-error callback.
    onEngineError,
    // Browser-rendered MCP App eval PR 2: advertised-tool narrowing hook.
    prepareAdvertisedTools,
  } = ctx;

  // Pick the active tool subset for this step. In non-progressive mode
  // (`progressivePlan` undefined or plan.enabled === false) this collapses
  // to the full list and matches prior behavior. In progressive mode the
  // model only sees meta-tools + loaded + pending-approval + newly-loaded —
  // PLUS tools injected into the map after the catalog was built (e.g. the
  // eval Computer Use tools, PR 14): they have no catalog toolId, so
  // `load_mcp_tools` can never activate them and dropping them here would
  // make them permanently invisible. Their per-step visibility stays
  // governed by `prepareAdvertisedTools` below (parity with
  // direct-chat-turn's `withInjectedTools`).
  let activeToolDefs: ToolDefinition[] =
    progressivePlan && progressivePlan.enabled && discoveryState
      ? (() => {
          const activeNames = resolveActiveToolNames(
            progressivePlan,
            discoveryState
          );
          const cataloged = new Set(
            progressivePlan.catalog.map((entry) => entry.modelName)
          );
          const seen = new Set(activeNames);
          for (const def of toolDefs) {
            if (!cataloged.has(def.name) && !seen.has(def.name)) {
              activeNames.push(def.name);
            }
          }
          return activeNames
            .map((name) => toolDefsByName.get(name))
            .filter((def): def is ToolDefinition => def !== undefined);
        })()
      : toolDefs;

  // Browser-rendered MCP App eval PR 2: runtime-conditional advertised-tool
  // narrowing. The hook receives the names that would otherwise be advertised
  // this step (`defaultToolNames`) and returns the subset to keep, or
  // `undefined` for no narrowing. Filtering against the resolved set means any
  // returned name not already advertised is ignored (defense-in-depth), and a
  // throw is logged + falls back to the default set so a buggy hook can't
  // crash the loop. Applied here so both the request_payload trace snapshot
  // and the Convex `/stream` request see the same narrowed set.
  if (prepareAdvertisedTools) {
    const advertised = new Set(
      applyPrepareAdvertisedTools({
        defaultToolNames: activeToolDefs.map((def) => def.name),
        stepIndex,
        prepareAdvertisedTools,
        onWarn: (message, meta) =>
          logger.warn(`[mcpjam-stream-handler] ${message}`, meta),
      })
    );
    activeToolDefs = activeToolDefs.filter((def) => advertised.has(def.name));
  }

  const forcedToolChoice =
    shouldForceInitialToolSearch(progressivePlan, discoveryState, stepIndex) &&
    activeToolDefs.some((def) => def.name === META_TOOL_SEARCH)
      ? { type: "tool" as const, toolName: META_TOOL_SEARCH }
      : undefined;

  const { abortSignal } = ctx;
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  }

  const beforeStepLength = messageHistory.length;
  const stepStartAbs = Date.now();
  const llmStartAbs = stepStartAbs;
  const providerSystemPrompt = normalizeSystemPromptForProvider(systemPrompt);

  // Scrub messages before sending to backend. Preserve reasoning on
  // assistant messages added during the current turn so thinking models can
  // see their own scratchpad across tool steps.
  const scrubbedMessages = scrubMessagesForBackend(
    messageHistory,
    tools,
    mcpClientManager,
    selectedServers,
    traceTurn.promptMessageStartIndex
  );

  const normalizeToolCallId = createToolCallIdNormalizer(
    usedToolCallIds,
    stepIndex
  );

  // The trace payload must reflect the *advertised* subset — `activeToolDefs`
  // after BOTH progressive-discovery narrowing AND the prepareAdvertisedTools
  // hook — so request_payload snapshots match what Convex actually received in
  // `tools: activeToolDefs` below. Derived unconditionally: in the no-narrowing
  // case `activeToolDefs === toolDefs`, so this reconstructs the full set.
  const toolsForPayload: ToolSet = Object.fromEntries(
    activeToolDefs
      .map((def): [string, unknown] | null => {
        const t = (tools as Record<string, unknown>)[def.name];
        return t === undefined ? null : [def.name, t];
      })
      .filter((pair): pair is [string, unknown] => pair !== null)
  ) as ToolSet;

  emitRequestPayload(writer, {
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    stepIndex,
    payload: buildResolvedModelRequestPayload({
      systemPrompt,
      tools: toolsForPayload,
      messages: scrubbedMessages,
    }),
  });

  // Call the Convex streaming endpoint. The default endpoint is /stream
  // (MCPJam-provided models); org BYOK chat targets /stream/org and adds
  // provider/project fields via extraBodyFields.
  const {
    endpointPath,
    extraHeaders,
    extraBodyFields,
    chatSessionId,
    sourceType,
    clientIp,
    onLiveTextDelta,
  } = ctx;
  // Hash the originating IP for the per-IP daily spend cap. Hashing here
  // (server-side) keeps the raw IP off the wire to Convex. If no hash can be
  // produced, omit the header so Convex uses its cookie-only guest fallback
  // instead of pooling unrelated guests in a shared unknown-IP bucket.
  const ipHash = clientIp ? await hashGuestSpendIp(clientIp) : null;
  const convexHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(authHeader ? { authorization: authHeader } : {}),
    ...(extraHeaders ?? {}),
  };
  for (const header of Object.keys(convexHeaders)) {
    if (header.toLowerCase() === GUEST_IP_HASH_HEADER) {
      delete convexHeaders[header];
    }
  }
  if (ipHash) {
    convexHeaders[GUEST_IP_HASH_HEADER] = ipHash;
  }
  let res: Response;
  try {
    res = await fetch(`${process.env.CONVEX_HTTP_URL}${endpointPath}`, {
      method: "POST",
      headers: convexHeaders,
      body: JSON.stringify({
        mode: "stream",
        // Persist only once at the end of the full agentic loop via
        // onConversationComplete to avoid storing partial per-step traces.
        skipChatIngestion: true,
        messages: JSON.stringify(scrubbedMessages),
        model: modelId,
        systemPrompt: providerSystemPrompt,
        ...(temperature !== undefined ? { temperature } : {}),
        tools: activeToolDefs,
        ...(chatboxId ? { chatboxId } : {}),
        ...(chatboxId && Number.isFinite(accessVersion)
          ? { accessVersion }
          : {}),
        ...(projectId ? { projectId } : {}),
        ...(chatSessionId ? { chatSessionId } : {}),
        ...(sourceType ? { sourceType } : {}),
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
        ...(forcedToolChoice ? { toolChoice: forcedToolChoice } : {}),
        ...(extraBodyFields ?? {}),
      }),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  } catch (error) {
    // AbortError on fetch is the standard cancellation signal — propagate
    // it without writing a fail span. Real network errors fall through to
    // the existing failure path via the !res.ok branch (we synthesize a
    // 500-shaped error below for parity).
    if (isAbortError(error)) {
      throw error;
    }
    throw error;
  }

  if (!res.ok || !res.body) {
    const errorText = await res.text().catch(() => "stream failed");
    const failAbs = Date.now();
    const stepMessageEndIndex =
      messageHistory.length > traceTurn.promptMessageStartIndex
        ? messageHistory.length - 1
        : undefined;
    pushBackendStepLlmFailureSpans(
      traceTurn.turnSpans,
      traceTurn.turnStartedAt,
      traceTurn.promptIndex,
      stepIndex,
      stepStartAbs,
      llmStartAbs,
      failAbs,
      {
        modelId,
        messageStartIndex:
          stepMessageEndIndex != null
            ? traceTurn.promptMessageStartIndex
            : undefined,
        messageEndIndex: stepMessageEndIndex,
      }
    );
    setStepSpanMessageRanges(
      traceTurn.turnSpans,
      traceTurn.promptIndex,
      stepIndex,
      stepMessageEndIndex != null
        ? traceTurn.promptMessageStartIndex
        : undefined,
      stepMessageEndIndex
    );
    emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
    writeTraceEvent(writer, {
      type: "error",
      turnId: traceTurn.turnId,
      promptIndex: traceTurn.promptIndex,
      stepIndex,
      errorText,
    });
    emitError(writer, errorText);
    // PR 5b-followup-2: surface the structured guardrail body to
    // `streamSink: "none"` consumers (eval backend stream runner). The
    // writer-side `error` chunk above is fire-and-forget here; the
    // callback gives the eval runner the parsed
    // `{ code?, error, details? }` shape so it can show the actual
    // 429 reason on its SSE error event instead of the generic
    // "Backend stream failed during iteration" fallback.
    const parsed = parseEngineErrorBody(res.status, errorText);
    safelyEmitEngineError(onEngineError, {
      message: parsed.message,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.details ? { details: parsed.details } : {}),
      httpStatus: res.status,
      rawText: errorText,
      promptIndex: traceTurn.promptIndex,
      stepIndex,
    });
    return { shouldContinue: false, didEmitFinish: false };
  }

  // Process the stream
  const { contentParts, finishChunk, firstChunkAt } = await processStream(
    res.body,
    writer,
    normalizeToolCallId,
    traceTurn,
    stepIndex,
    tools,
    requireToolApproval,
    onLiveTextDelta,
    abortSignal,
    progressivePlan,
    onToolCall
  );
  const llmEndAbs = Date.now();
  traceTurn.turnUsage = mergeLiveChatTraceUsage(
    traceTurn.turnUsage,
    readUsageFromFinishChunk(finishChunk)
  );

  // Update message history with assistant response
  if (contentParts.length > 0) {
    messageHistory.push({
      role: "assistant",
      content: contentParts,
    } as ModelMessage);
  }

  const stepMessageEndIndex =
    messageHistory.length > traceTurn.promptMessageStartIndex
      ? messageHistory.length - 1
      : undefined;
  const stepMessageStartIndex =
    stepMessageEndIndex != null ? traceTurn.promptMessageStartIndex : undefined;
  const stepUsage = readUsageFromFinishChunk(finishChunk);

  // GenAI harness metadata for this step's llm/step spans (OTel-aligned).
  // `finishChunk` is per-step, so `finishReason` is correct per step (e.g.
  // "tool-calls" on a tool step, "stop"/"length" on the terminal step). TTFC is
  // first-chunk relative to the LLM request start. Spread into every
  // pushBackendStepSuccessSpans call below.
  const harnessSpanMeta = {
    provider,
    finishReason: readFinishReasonFromChunk(finishChunk),
    ttfcMs:
      typeof firstChunkAt === "number"
        ? Math.max(0, firstChunkAt - llmStartAbs)
        : undefined,
  };

  // Check for unresolved tool calls and execute them
  if (hasUnresolvedToolCalls(messageHistory)) {
    // Meta-tools (search_mcp_tools / load_mcp_tools) are approval-free even
    // when the user enabled `requireToolApproval` — gating progressive
    // discovery itself behind N approvals defeats the point. We only pause
    // when at least one unresolved tool call is a real MCP tool. Pure-meta
    // turns fall through to execute and continue the loop.
    const hasUnresolvedRealToolCall = (() => {
      const resultIds = new Set<string>();
      for (const msg of messageHistory) {
        if (msg?.role !== "tool") continue;
        for (const part of (msg as ToolModelMessage).content) {
          if (part.type === "tool-result") resultIds.add(part.toolCallId);
        }
      }
      for (const msg of messageHistory) {
        if (msg?.role !== "assistant") continue;
        const content = (msg as AssistantModelMessage).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (
            part.type === "tool-call" &&
            !resultIds.has(part.toolCallId) &&
            !isApprovalFreeMetaToolName(part.toolName, progressivePlan)
          ) {
            return true;
          }
        }
      }
      return false;
    })();

    if (
      requireToolApproval &&
      hasUnresolvedRealToolCall &&
      approvalMode === "auto-deny"
    ) {
      // Synthetic-session path: instead of pausing the loop for a
      // human approval that will never come, synthesize a denial
      // tool-result for every approval-required unresolved real
      // tool call so the model can react and continue. Meta-tool
      // calls in the same step still execute normally below.
      const resultIds = new Set<string>();
      for (const msg of messageHistory) {
        if (msg?.role !== "tool") continue;
        for (const part of (msg as ToolModelMessage).content) {
          if (part.type === "tool-result") resultIds.add(part.toolCallId);
        }
      }
      const deniedByAssistantIdx = new Map<number, ToolResultPart[]>();
      for (let i = 0; i < messageHistory.length; i++) {
        const msg = messageHistory[i];
        if (msg?.role !== "assistant") continue;
        const content = (msg as AssistantModelMessage).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (
            part.type !== "tool-call" ||
            resultIds.has(part.toolCallId) ||
            isApprovalFreeMetaToolName(part.toolName, progressivePlan)
          ) {
            continue;
          }
          const denial: ToolResultPart = {
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: {
              type: "error-text",
              value: "approval-denied (synthetic session)",
            },
          };
          const bucket = deniedByAssistantIdx.get(i) ?? [];
          bucket.push(denial);
          deniedByAssistantIdx.set(i, bucket);
        }
      }
      if (deniedByAssistantIdx.size > 0) {
        const denialMessages: ModelMessage[] = [];
        const sortedKeys = [...deniedByAssistantIdx.keys()].sort(
          (a, b) => b - a
        );
        for (const idx of sortedKeys) {
          const denialContent = deniedByAssistantIdx.get(idx)!;
          const denialMsg = {
            role: "tool",
            content: denialContent,
          } as ModelMessage;
          messageHistory.splice(idx + 1, 0, denialMsg);
          denialMessages.push(denialMsg);
        }
        await emitToolResults(
          writer,
          mcpClientManager,
          denialMessages,
          traceTurn,
          stepIndex,
          onToolResult
        );
      }
      // Fall through to the normal tool-execution branch below so
      // meta-tools still run and the loop continues. The synthesized
      // denials count as resolved tool-results for the next step.
    }

    if (
      requireToolApproval &&
      hasUnresolvedRealToolCall &&
      approvalMode !== "auto-deny"
    ) {
      // Drain any unresolved meta-tool calls (search/load) before pausing
      // for approval on real tools. Otherwise mixed-step turns (model
      // emits a load_mcp_tools + a real tool in one assistant message)
      // leave the meta-tool unresolved through the approval pause, and
      // the resumed turn loses the discovery side effect — the loaded
      // tools never get promoted into `discoveryState.loadedToolIds`,
      // so the next step still only shows meta-tools.
      const metaTracedTools = wrapBackendToolsForTrace(
        tools as Record<string, any>,
        {
          runStartedAt: traceTurn.turnStartedAt,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          spans: traceTurn.turnSpans,
        }
      );
      const metaMessages = await executeToolCallsFromMessages(messageHistory, {
        tools: metaTracedTools as Record<string, any>,
        filterToolName: (name) =>
          isApprovalFreeMetaToolName(name, progressivePlan),
        modelVisibleMcpToolResults,
        readLinkedResource: readLinkedMcpResourceWithManager(mcpClientManager),
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (metaMessages.length > 0) {
        await emitToolResults(
          writer,
          mcpClientManager,
          metaMessages,
          traceTurn,
          stepIndex,
          onToolResult
        );
        // Promote any ids the model just loaded so a subsequent
        // resumed-after-approval step sees them as loaded.
        if (progressivePlan?.enabled && discoveryState) {
          commitNewlyLoaded(discoveryState);
        }
      }

      pushBackendStepSuccessSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        undefined,
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndex,
          messageEndIndex: stepMessageEndIndex,
          status: "ok",
          ...harnessSpanMeta,
        }
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndex,
        stepMessageEndIndex
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
      if (finishChunk) {
        writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
      }
      return { shouldContinue: false, didEmitFinish: !!finishChunk };
    }

    // Emit inherited tool calls that need execution
    emitInheritedToolCalls(
      writer,
      messageHistory,
      beforeStepLength,
      tools,
      traceTurn,
      stepIndex,
      onToolCall
    );

    const toolsStartAbs = Date.now();
    try {
      const tracedTools = wrapBackendToolsForTrace(
        tools as Record<string, any>,
        {
          runStartedAt: traceTurn.turnStartedAt,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          spans: traceTurn.turnSpans,
        }
      );

      // Progressive mode: gate execution to the active subset. Visibility
      // is already narrowed by `activeToolDefs`, but a model can still
      // emit a remembered/hallucinated call to a non-active name; gating
      // turns that into a structured error the model can recover from
      // via `load_mcp_tools` instead of executing an ungated tool.
      let executableTools = gateToolsToActiveSubset(
        tracedTools as Record<string, unknown>,
        progressivePlan,
        () => discoveryState
      );
      // advertise = ENFORCE: when prepareAdvertisedTools narrowed the advertised
      // set (`activeToolDefs`), gate execution to it too so a remembered /
      // hallucinated call to a hidden tool (e.g. `computer` before a widget
      // renders) becomes a recoverable tool-error instead of executing.
      if (prepareAdvertisedTools) {
        const advertised = new Set(activeToolDefs.map((def) => def.name));
        executableTools = gateToolsToAdvertisedSubset(
          executableTools,
          () => advertised
        );
      }

      // Client-fulfilled tools (SEP-1865 app aliases + WebMCP `ui_*` tools)
      // have no `execute` function because they run in the browser via
      // `useChat.onToolCall`. With `skipNonExecutableTools`, the helper
      // executes server tools in-place and leaves only registered
      // client-fulfilled names unresolved. Unknown other tools still become
      // normal tool-result errors so the agent can recover instead of
      // hanging.
      const newMessages = await executeToolCallsFromMessages(messageHistory, {
        tools: executableTools as Record<string, any>,
        skipNonExecutableTools: true,
        modelVisibleMcpToolResults,
        readLinkedResource: readLinkedMcpResourceWithManager(mcpClientManager),
        ...(abortSignal ? { abortSignal } : {}),
      });
      const toolsEndAbs = Date.now();

      const newToolCallIds = new Set<string>();
      for (const msg of newMessages) {
        if (msg?.role !== "tool") {
          continue;
        }
        const toolMsg = msg as ToolModelMessage;
        for (const part of toolMsg.content) {
          if (
            part.type === "tool-result" &&
            typeof part.toolCallId === "string"
          ) {
            newToolCallIds.add(part.toolCallId);
          }
        }
      }
      setToolSpanMessageRangesFromResults(
        traceTurn.turnSpans,
        messageHistory,
        traceTurn.promptIndex,
        stepIndex,
        newToolCallIds
      );
      const stepMessageEndIndexAfterTools =
        messageHistory.length > traceTurn.promptMessageStartIndex
          ? messageHistory.length - 1
          : undefined;
      const stepMessageStartIndexAfterTools =
        stepMessageEndIndexAfterTools != null
          ? traceTurn.promptMessageStartIndex
          : undefined;

      pushBackendStepSuccessSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        {
          startAbs: toolsStartAbs,
          endAbs: toolsEndAbs,
          pushAggregateSpan: newMessages.length === 0,
        },
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndexAfterTools,
          messageEndIndex: stepMessageEndIndexAfterTools,
          status: "ok",
          ...harnessSpanMeta,
        }
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndexAfterTools,
        stepMessageEndIndexAfterTools
      );

      // Emit results for newly executed tools
      await emitToolResults(
        writer,
        mcpClientManager,
        newMessages,
        traceTurn,
        stepIndex,
        onToolResult
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

      // Progressive discovery bookkeeping: any tool ids the model just
      // loaded via load_mcp_tools are now staged in
      // `discoveryState.newlyLoadedToolIds`. Promote them into the
      // persistent loaded set so the next step's active subset includes
      // them.
      if (progressivePlan?.enabled && discoveryState) {
        commitNewlyLoaded(discoveryState);
      }

      // Client-fulfilled tools (app aliases + `ui_*`): pause only for
      // unresolved registered client-fulfilled calls. Other unresolved calls
      // should keep the legacy loop behavior; in normal execution they have
      // already been converted to error tool-results above.
      if (hasUnresolvedClientFulfilledToolCalls(messageHistory, tools)) {
        if (finishChunk) {
          writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
        }
        return { shouldContinue: false, didEmitFinish: !!finishChunk };
      }
    } catch (error) {
      // Aborts surface here when the signal fires mid-tool. Bubble up so
      // the outer handler can take the silent-cancellation path; don't
      // pollute fail-spans or push an error chunk.
      if (isAbortError(error)) {
        throw error;
      }
      const failAbs = Date.now();
      pushBackendStepToolFailureSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        toolsStartAbs,
        failAbs,
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndex,
          messageEndIndex: stepMessageEndIndex,
          pushAggregateSpan: false,
        }
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndex,
        stepMessageEndIndex
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

      const errorText = error instanceof Error ? error.message : String(error);
      writeTraceEvent(writer, {
        type: "error",
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
        errorText,
      });
      emitError(writer, errorText);
      // PR 5b-followup-2: surface the error to `streamSink: "none"`
      // consumers (eval backend stream runner). The processStream /
      // tool-execution catch path doesn't have a structured body, so
      // `message` is just the error text; `code` / `details` /
      // `httpStatus` are omitted.
      safelyEmitEngineError(onEngineError, {
        message: errorText,
        rawText: errorText,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
      });
      return { shouldContinue: false, didEmitFinish: false };
    }

    return { shouldContinue: true, didEmitFinish: false };
  }

  pushBackendStepSuccessSpans(
    traceTurn.turnSpans,
    traceTurn.turnStartedAt,
    traceTurn.promptIndex,
    stepIndex,
    stepStartAbs,
    { startAbs: llmStartAbs, endAbs: llmEndAbs },
    undefined,
    {
      modelId,
      inputTokens: stepUsage?.inputTokens,
      outputTokens: stepUsage?.outputTokens,
      totalTokens: stepUsage?.totalTokens,
      messageStartIndex: stepMessageStartIndex,
      messageEndIndex: stepMessageEndIndex,
      status: "ok",
      ...harnessSpanMeta,
    }
  );
  setStepSpanMessageRanges(
    traceTurn.turnSpans,
    traceTurn.promptIndex,
    stepIndex,
    stepMessageStartIndex,
    stepMessageEndIndex
  );
  emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

  // No more tool calls - emit finish and stop
  const didEmitFinish = !!finishChunk;
  if (finishChunk) {
    writer.write(createClientFinishChunk(finishChunk, traceTurn, "stop"));
  }

  // We're done with this conversation turn
  return { shouldContinue: false, didEmitFinish };
}

/**
 * Result returned from {@link runChatEngineLoop}.
 *
 * - `streamSink: "ui"` callers get a Hono-shaped Response built from
 *   {@link createUIMessageStreamResponse}, exactly as the live `/stream`
 *   route expects. The Response's body, when drained, runs the agent
 *   loop and fires `onConversationComplete` via `onFinish`.
 *
 * - `streamSink: "none"` callers (synthetic runner) get the captured
 *   `messageHistory` synchronously — the engine ran inline with a no-op
 *   writer, no `createUIMessageStream`, no Response. `messageHistory`
 *   is the same array reference that was passed to
 *   `onConversationComplete` (if `runSucceeded && !aborted`).
 */
export interface ChatEngineLoopResult {
  response?: Response;
  messageHistory: ModelMessage[];
  turnTrace?: PersistedTurnTrace;
  aborted: boolean;
}

/**
 * Core engine for the MCPJam agentic chat loop.
 *
 * This is the body that used to live inside `handleMCPJamFreeChatModel`.
 * It owns the per-step Convex `/stream` fetch + local tool execution
 * cycle, the trace event emission, and the conversation persistence tap.
 *
 * Two delivery modes:
 *
 * - `streamSink: "ui"` wraps the loop in `createUIMessageStream` +
 *   `createUIMessageStreamResponse` and returns a Hono Response. This is
 *   byte-for-byte the same chunk sequence as before the extraction
 *   (covered by `mcpjam-stream-handler-snapshot.test.ts`).
 *
 * - `streamSink: "none"` runs the same `execute` closure with a no-op
 *   writer and then calls `onFinish` directly. No `Response` is built;
 *   the synthetic runner reads the transcript out of the returned
 *   `messageHistory` (also delivered via `onConversationComplete`).
 *
 * `handleMCPJamFreeChatModel` is now a thin wrapper around this in
 * `streamSink: "ui"` mode; `runAssistantTurn` calls it in either mode
 * depending on the caller's `streamSink` choice.
 */
export async function runChatEngineLoop(
  options: MCPJamHandlerOptions,
  streamSink: "ui" | "none"
): Promise<ChatEngineLoopResult> {
  const {
    messages,
    modelId,
    provider,
    systemPrompt,
    temperature,
    tools,
    authHeader,
    chatboxId,
    accessVersion,
    projectId,
    mcpClientManager,
    selectedServers,
    requireToolApproval,
    modelVisibleMcpToolResults,
    approvalMode,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    endpointPath,
    extraHeaders,
    extraBodyFields,
    chatSessionId,
    sourceType,
    clientIp,
    onLiveTextDelta,
    // PR 5b-pre callbacks.
    onToolCall,
    onToolResult,
    onStepFinish,
    // PR 5b-followup-2 callback.
    onEngineError,
    // Browser-rendered MCP App eval PR 2: advertised-tool narrowing hook.
    prepareAdvertisedTools,
    abortSignal,
    heartbeatIntervalMs,
    maxSteps,
    progressivePlan,
    discoveryState,
  } = options;
  const resolvedEndpointPath = endpointPath ?? "/stream";
  const resolvedMaxSteps =
    typeof maxSteps === "number" && Number.isFinite(maxSteps) && maxSteps > 0
      ? Math.floor(maxSteps)
      : DEFAULT_MAX_STEPS;
  const resolvedHeartbeatMs =
    typeof heartbeatIntervalMs === "number" &&
    Number.isFinite(heartbeatIntervalMs) &&
    heartbeatIntervalMs >= 0
      ? Math.floor(heartbeatIntervalMs)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;

  const toolDefs = serializeToolsForConvex(tools);
  const toolDefsByName = new Map<string, ToolDefinition>();
  for (const def of toolDefs) {
    toolDefsByName.set(def.name, def);
  }
  const messageHistory = [...messages];

  // Seed the pending-approval set from history so resumed turns keep
  // exposing the tool whose approval the user is about to answer. This is
  // a no-op in non-progressive mode.
  if (progressivePlan?.enabled && discoveryState) {
    const resultIds = new Set<string>();
    for (const msg of messageHistory) {
      if (msg?.role !== "tool") continue;
      for (const part of (msg as ToolModelMessage).content) {
        if (part.type === "tool-result") resultIds.add(part.toolCallId);
      }
    }
    for (const msg of messageHistory) {
      if (msg?.role !== "assistant") continue;
      const content = (msg as AssistantModelMessage).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (
          part.type === "tool-call" &&
          !resultIds.has(part.toolCallId) &&
          !META_TOOL_NAMES.includes(part.toolName)
        ) {
          const id = lookupToolIdByModelName(
            progressivePlan.catalog,
            part.toolName
          );
          if (id) discoveryState.pendingApprovalToolIds.add(id);
        }
      }
    }
  }
  const usedToolCallIds = collectUsedToolCallIds(messageHistory);
  const traceTurn: LiveTraceTurnContext = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messageHistory),
    promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
    turnStartedAt: Date.now(),
    turnSpans: [],
  };
  // Shared per-turn ritual (turn_start / onStepFinish / turn_finish /
  // PersistedTurnTrace), sharing `traceTurn`'s span array + clock so the live
  // snapshots (still emitted against `traceTurn`) and the driver stay in lockstep.
  const driver = new StreamTurnDriver({
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    modelId,
    engine: "emulated",
    traceBaseMs: traceTurn.turnStartedAt,
    spans: traceTurn.turnSpans,
    onStepFinish,
  });
  const promptStepBaseIndex = getPromptAssistantStepBaseIndex(
    messageHistory,
    traceTurn.promptMessageStartIndex
  );
  let steps = 0;
  let runSucceeded = false;
  let aborted = false;

  // Engine `execute` closure. Factored so it can be invoked either via
  // `createUIMessageStream` (streamSink: "ui") or directly with a no-op
  // writer (streamSink: "none"). Captures the engine's shared state
  // (`messageHistory`, `traceTurn`, `steps`, `runSucceeded`, `aborted`)
  // via closure exactly as before.
  const executeEngine = async ({
    writer,
  }: {
    writer: { write: (chunk: UIMessageChunk) => void };
  }) => {
    let finishEmitted = false;
    let streamClosed = false;
    let lastWriteAt = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    // Wrap the writer to track quiescence (for idle heartbeat) and to
    // swallow write errors after the underlying stream has been torn
    // down. The latter prevents a stray heartbeat or trace event from
    // bringing down the agentic loop after a client disconnect.
    // The narrowed `{ write }` shape matches StepContext.writer and
    // MCPJamHandlerOptions.onStreamWriterReady, both of which only need
    // the writer for chunk forwarding.
    const safeWriter: { write: (chunk: UIMessageChunk) => void } = {
      write: (chunk: UIMessageChunk) => {
        lastWriteAt = Date.now();
        if (streamClosed) return;
        try {
          writer.write(chunk);
        } catch (writeError) {
          // The SDK closes the underlying controller on client
          // disconnect; subsequent writes throw. Treat this as a
          // signal that the stream is gone and stop further writes.
          streamClosed = true;
          if (!aborted) {
            logger.warn(
              "[mcpjam-stream-handler] writer.write failed; marking stream closed",
              {
                error:
                  writeError instanceof Error
                    ? writeError.message
                    : String(writeError),
              }
            );
          }
        }
      },
    };

    const effectiveSteps = () => promptStepBaseIndex + steps;
    const hitStepCap = () => effectiveSteps() >= resolvedMaxSteps;

    // Idle heartbeat: only fires when the stream has been quiet for at
    // least `resolvedHeartbeatMs`. Skipped during teardown and during
    // an active abort. Errors are swallowed — heartbeats must never
    // surface as user-visible failures.
    const startHeartbeat = () => {
      if (resolvedHeartbeatMs <= 0) return;
      heartbeatTimer = setInterval(() => {
        if (streamClosed || aborted) return;
        const sinceLastWrite = Date.now() - lastWriteAt;
        if (sinceLastWrite < resolvedHeartbeatMs) return;
        try {
          writeTraceEvent(safeWriter, {
            type: "heartbeat",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
          });
        } catch (error) {
          // Should not happen — safeWriter swallows write errors —
          // but a final guard here keeps a misbehaving writeTraceEvent
          // from killing the loop.
          logger.warn("[mcpjam-stream-handler] heartbeat emit failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, Math.max(250, Math.floor(resolvedHeartbeatMs / 2)));
    };

    // External abort listener: marks `aborted` so downstream catch
    // branches take the silent-cancellation path. The actual stream
    // reader cancellation happens inside processStream.
    let abortListener: (() => void) | undefined;
    if (abortSignal) {
      if (abortSignal.aborted) {
        aborted = true;
      } else {
        abortListener = () => {
          aborted = true;
        };
        abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      onStreamWriterReady?.(safeWriter);

      if (aborted) {
        // Already aborted before we even started — bail silently.
        return;
      }

      driver.emitTurnStart(safeWriter);

      startHeartbeat();

      // Process any pending approval responses from a previous request
      if (requireToolApproval) {
        const handled = await handlePendingApprovals(
          safeWriter,
          messageHistory,
          tools,
          mcpClientManager,
          traceTurn,
          effectiveSteps(),
          abortSignal,
          modelVisibleMcpToolResults,
          onToolResult,
          onToolCall
        );
        if (handled) {
          // Approvals were processed — if there are still unresolved tool
          // calls (shouldn't happen normally), fall through to the loop.
          // Otherwise the loop will call Convex with the new tool results.
        }
      }

      while (effectiveSteps() < resolvedMaxSteps) {
        if (aborted) break;
        const { shouldContinue, didEmitFinish } = await processOneStep({
          writer: safeWriter,
          messageHistory,
          toolDefs,
          toolDefsByName,
          tools,
          progressivePlan,
          discoveryState,
          authHeader,
          chatboxId,
          accessVersion,
          projectId,
          chatSessionId,
          sourceType,
          modelId,
          provider,
          systemPrompt,
          temperature,
          mcpClientManager,
          selectedServers,
          requireToolApproval,
          modelVisibleMcpToolResults,
          approvalMode,
          stepIndex: effectiveSteps(),
          usedToolCallIds,
          traceTurn,
          endpointPath: resolvedEndpointPath,
          extraHeaders,
          extraBodyFields,
          clientIp,
          onLiveTextDelta,
          // PR 5b-pre: chunk-level callbacks. Passed through to the
          // step processor where the chunk-switch (onToolCall) +
          // tool-result emission (onToolResult) sites fire them.
          onToolCall,
          onToolResult,
          // PR 5b-followup-2: structured-error callback. Fires from
          // the two `processOneStep` error sites (non-OK Convex
          // response + processStream/tool catch).
          onEngineError,
          // Browser-rendered MCP App eval PR 2: advertised-tool narrowing.
          prepareAdvertisedTools,
          abortSignal,
        });

        steps++;
        if (didEmitFinish) {
          finishEmitted = true;
        }

        // PR 5b-pre: step-level callback. Fires after each
        // `processOneStep` returns and the step counter increments,
        // so the runner sees one event per completed step in order.
        // Routed through the shared driver (cumulative `turnUsage` from the
        // shared span/usage state, defensive `turnSpans` copy). The engine's
        // failure branches return `shouldContinue: false` + `didEmitFinish:
        // false` after emitting an error UI chunk; `settledWithError`
        // surfaces that so the runner can map it to eval's `step_finish`.
        driver.usage = traceTurn.turnUsage;
        driver.fireStepFinish(
          effectiveSteps() - 1,
          !didEmitFinish && !shouldContinue
        );

        if (!shouldContinue) {
          break;
        }
      }

      // Silent cancellation gate: an abort that fired between steps
      // exits the loop above via `if (aborted) break`, but the rest of
      // the success epilogue (high-step log, synthetic finish,
      // turn_finish, runSucceeded=true) would still run. Bail here so
      // the writer sees no terminal chunk and `onFinish` keeps the
      // turn out of persistence. `onStreamComplete` still runs via the
      // `finally` below.
      if (aborted || abortSignal?.aborted) {
        aborted = true;
        return;
      }

      // One structured log per turn that reached the historical "loose"
      // cap so we can validate whether 30 is the right new default
      // before tuning down. Fires only on success paths to avoid
      // double-logging abort/error turns.
      if (effectiveSteps() >= STEP_LOG_THRESHOLD) {
        logger.info("[mcpjam-stream-handler] turn reached high step count", {
          effectiveSteps: effectiveSteps(),
          maxSteps: resolvedMaxSteps,
          modelId,
          turnId: traceTurn.turnId,
        });
      }

      // Safety: ensure we always emit a finish event
      if (!finishEmitted) {
        safeWriter.write(
          createClientFinishChunk(
            null,
            traceTurn,
            hitStepCap() ? "length" : "stop"
          )
        );
        finishEmitted = true;
      }

      // Shared ritual: turn_finish + success flag (finish chunk already
      // emitted by the step or the safety block above).
      driver.usage = traceTurn.turnUsage;
      driver.finishReason = hitStepCap() ? "length" : "stop";
      driver.finishTurn(safeWriter, { alreadyEmittedFinish: true });

      runSucceeded = true;
    } catch (error) {
      // Abort is the cooperative cancellation signal — silent path:
      // no error chunk, no synthetic finish, no turn_finish, no
      // failure spans, no conversation persistence. The downstream
      // controller is already being torn down by the client.
      if (isAbortError(error) || abortSignal?.aborted) {
        aborted = true;
      } else {
        logger.error("[mcpjam-stream-handler] Error in agentic loop", error);
        const failAbs = Date.now();
        const errorText =
          error instanceof Error ? error.message : String(error);
        pushAiSdkTrailingErrorSpan(
          traceTurn.turnSpans,
          traceTurn.turnStartedAt,
          traceTurn.turnStartedAt,
          failAbs,
          traceTurn.promptIndex
        );
        emitTraceSnapshot(safeWriter, messageHistory, tools, traceTurn);
        writeTraceEvent(safeWriter, {
          type: "error",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          errorText,
        });
        writeTraceEvent(safeWriter, {
          type: "turn_finish",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          usage: traceTurn.turnUsage,
        });
        emitError(safeWriter, errorText);
        // PR 5b-followup-2: surface to `streamSink: "none"` consumers.
        // Site (3) — outer agentic-loop catch. No structured body,
        // no stepIndex.
        safelyEmitEngineError(onEngineError, {
          message: errorText,
          rawText: errorText,
          promptIndex: traceTurn.promptIndex,
        });
      }
    } finally {
      streamClosed = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
      }
      if (abortListener && abortSignal) {
        abortSignal.removeEventListener("abort", abortListener);
      }
    }
  };

  // Engine `onFinish` closure. Same logic that used to live as the
  // `onFinish` option on `createUIMessageStream`. Captures the latest
  // `turnTrace` (if produced) so the engine result can surface it to
  // synthetic-runner callers via {@link ChatEngineLoopResult.turnTrace}.
  let capturedTurnTrace: PersistedTurnTrace | undefined;
  const onFinishEngine = async () => {
    try {
      // Persist only successful, non-aborted turns. An aborted turn is
      // partial by definition — recording it as a completed conversation
      // would corrupt history and reverse the cost-safety win.
      if (runSucceeded && !aborted) {
        const trace: PersistedTurnTrace = driver.buildPersistedTrace();
        capturedTurnTrace = trace;
        try {
          await onConversationComplete?.([...messageHistory], trace);
        } catch (persistenceError) {
          logger.error(
            "[mcpjam-stream-handler] Error while persisting conversation",
            persistenceError
          );
        }
      }
    } finally {
      try {
        await onStreamComplete?.();
      } catch (cleanupError) {
        logger.error(
          "[mcpjam-stream-handler] Error while running stream cleanup",
          cleanupError
        );
      }
    }
  };

  if (streamSink === "ui") {
    const stream = createUIMessageStream({
      execute: executeEngine,
      onFinish: onFinishEngine,
    });
    const response = createUIMessageStreamResponse({ stream });
    return {
      response,
      messageHistory,
      aborted: false,
      // turnTrace will be captured inside `onFinish` once the caller
      // drains the Response body; we don't surface it on the eager
      // result for the UI-sink path because the live route doesn't
      // need it (persistence runs via `onConversationComplete`).
    };
  }

  // streamSink === "none": run the engine inline against a no-op writer.
  // The agent loop, trace events, and `onConversationComplete` tap all
  // still fire — we just discard the SSE chunks. No `Response` is
  // constructed and no body is drained, so `runAssistantTurn` can return
  // the captured transcript synchronously without the previous
  // facade-style drain dance.
  const noopWriter = {
    write: (_chunk: UIMessageChunk) => {
      // Discard. The agent-loop trace/persistence side-effects fire via
      // closures over engine state, not via the writer.
    },
  };
  try {
    await executeEngine({ writer: noopWriter });
  } finally {
    await onFinishEngine();
  }
  return {
    messageHistory,
    aborted,
    ...(capturedTurnTrace ? { turnTrace: capturedTurnTrace } : {}),
  };
}

/**
 * Main handler for MCPJam-provided models.
 *
 * Thin wrapper around {@link runChatEngineLoop} for the live `/stream`
 * path. The engine produces an SSE Response that the chat-v2 routes
 * hand directly back to Hono.
 *
 * The signature is preserved so `handleHostedOrgChatModel` (org BYOK
 * delegation chain) can continue forwarding `endpointPath: "/stream/org"`
 * and `extraBodyFields: { providerKey }` without modification.
 */
export async function handleMCPJamFreeChatModel(
  options: MCPJamHandlerOptions
): Promise<Response> {
  // A host with a `harness` selected (claude-code | codex) runs the real runtime
  // via runHarnessTurn; otherwise the emulated engine. `harness` is already a
  // validated HarnessId (readHarness → isHarness) or undefined, so a truthiness
  // check is the right gate — runHarnessTurn re-resolves the adapter defensively.
  // Both satisfy the same ChatEngineLoopResult contract (streamSink "ui" → Response).
  const result = await (options.harness
    ? runHarnessTurn(options, "ui")
    : runChatEngineLoop(options, "ui"));
  if (!result.response) {
    throw new Error(
      `${options.harness ? "runHarnessTurn" : "runChatEngineLoop"}(streamSink: 'ui') returned no Response — internal invariant violated`
    );
  }
  return result.response;
}
