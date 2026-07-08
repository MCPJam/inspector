/**
 * Org BYOK Stream Handler
 *
 * Hosted-mode org BYOK chat: the LLM either lives in Convex (cloud runtime,
 * vault-resolved org keys never leave Convex) or runs directly in the inspector
 * (local runtime, API key returned by /stream/org/resolve for this request only).
 *
 * handleHostedOrgChatModel → cloud: wraps handleMCPJamFreeChatModel and
 *   points it at /stream/org with the user auth header + providerKey.
 *
 * handleLocalOrgChatModel → local: builds the AI SDK model directly in the
 *   inspector using buildOrgModelFromResolvedConfig, then drives
 *   `runDirectChatTurn` through the shared SSE-callback factory used by
 *   route 4 (`streamDirectChatWithLiveTrace` in `mcp/chat-v2.ts`). Posts
 *   usage back to /stream/org/local-usage on successful completion.
 *
 *   Engine consolidation route 3 collapse: this handler used to own its
 *   own inline `streamText({...})` block (~390 LOC) that duplicated the
 *   driver in `runDirectChatTurn`. The collapse keeps the route-specific
 *   pieces here (the `requireToolApproval` guard, the local-runtime
 *   config validation, the `postLocalUsage` writeback) and delegates
 *   streaming + trace + persistence to the shared engine.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config/internal";
import {
  buildOrgModelFromResolvedConfig,
  assertOrgModelAllowed,
  OrgProviderConfigError,
  type OrgProviderResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import type { PersistedTurnTrace } from "./chat-ingestion";
import { handleMCPJamFreeChatModel } from "./mcpjam-stream-handler.js";
import { logger } from "./logger.js";
import {
  consumeDirectChatTurnHeadless,
  runDirectChatTurn,
  withMcpToolOriginChunkMetadata,
  type DirectChatTurnPersistEvent,
  type DirectChatTurnTraceEvents,
  type RunDirectChatTurnHandle,
} from "./direct-chat-turn.js";
import type { PrepareAdvertisedTools } from "./advertised-tools.js";
import { buildDirectChatTraceCallbacks } from "./direct-chat-sse-callbacks.js";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "./provider-error-normalization.js";
import { type LiveChatTraceUsage } from "@/shared/live-chat-trace";
import { isAbortError } from "@/shared/abort-errors";
import {
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";

export interface OrgModelHandlerOptions {
  projectId: string;
  providerKey: string;
  /** Progressive discovery — forwarded into handleMCPJamFreeChatModel. */
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  modelId: string;
  chatSessionId?: string;
  sourceType?: string;
  messages: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  serverIds?: string[];
  requireToolApproval?: boolean;
  /** Read-only ui_* names exempt from the approval gate (see MCPJam loop). */
  approvalFreeUiToolNames?: ReadonlySet<string>;
  /** Host/client policy for eligible MCP tool-result content/resources. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Approval mode forwarded into the wrapped MCPJam handler. Synthetic
   * callers pass `"auto-deny"` so approval-required tool calls auto-deny
   * inside the loop instead of pausing for a human (there is no visitor
   * in a synthetic run). Direct chatters omit or pass `"prompt"`.
   */
  approvalMode?: "prompt" | "auto-deny";
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onLiveTextDelta?: (delta: string) => void;
  /**
   * The end user's Authorization header from the inbound request. Forwarded
   * to /stream/org so Convex can re-authorize the user against the project.
   * This is the auth boundary for org BYOK runtime requests.
   */
  authHeader?: string;
  /**
   * Resolved chatbox identity (post-redeem). Forwarded to /stream/org so
   * Convex can authorize the actor against the chatbox + project.
   */
  chatboxId?: string;
  accessVersion?: number;
  clientIp?: string | null;
  /**
   * Inbound request abort signal. Forwarded to the wrapped MCPJam handler so
   * a client disconnect cancels the Convex fetch, the SSE reader, and the
   * local tool executor end-to-end.
   */
  abortSignal?: AbortSignal;
  /**
   * See MCPJamHandlerOptions.heartbeatIntervalMs. Forwarded as-is.
   */
  heartbeatIntervalMs?: number;
  /**
   * See MCPJamHandlerOptions.maxSteps. Forwarded as-is.
   */
  maxSteps?: number;
  /**
   * Extra body fields merged into the per-step Convex `/stream/org` POST.
   * Synthetic chatbox runs use this to thread `synthesisRunId` so the
   * backend BYOK writer can stamp it onto `llmUsageRecord` for per-run
   * spend attribution. Sibling fields from the handler (providerKey,
   * serverIds) take precedence on collision.
   */
  extraBodyFields?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers shared between local and hosted handlers
// ---------------------------------------------------------------------------

function formatLocalStreamError(error: unknown): string {
  if (error instanceof OrgProviderConfigError) {
    return JSON.stringify({ code: error.code, message: error.message });
  }
  if (!(error instanceof Error)) return String(error);
  const statusCode = (error as any).statusCode as number | undefined;
  const responseBody = (error as any).responseBody as string | undefined;
  if (
    isProviderOverloadError({
      message: error.message,
      statusCode,
      responseBody,
    })
  ) {
    return formatProviderOverloadError({ statusCode, responseBody });
  }
  const lowerBody = responseBody?.toLowerCase() ?? "";
  const isAuthError =
    statusCode === 401 ||
    lowerBody.includes("incorrect api key") ||
    lowerBody.includes("invalid api key") ||
    lowerBody.includes("api key not valid") ||
    lowerBody.includes("api_key_invalid") ||
    lowerBody.includes("authentication_error") ||
    lowerBody.includes("authentication fails") ||
    lowerBody.includes("invalid x-api-key");
  if (isAuthError) {
    return JSON.stringify({
      code: "auth_error",
      message: `Invalid API key for the org provider. Please check your organization's LLM provider settings.`,
      statusCode,
    });
  }
  if (responseBody && typeof responseBody === "string") {
    return JSON.stringify({ message: error.message, details: responseBody });
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// Local org BYOK handler
// ---------------------------------------------------------------------------

export interface OrgLocalModelHandlerOptions {
  /** The resolved local provider config (from /stream/org/resolve). */
  provider: OrgProviderResolvedConfig;
  projectId: string;
  modelId: string;
  chatSessionId?: string;
  sourceType?: string;
  messages: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  selectedServers?: string[];
  serverIds?: string[];
  requireToolApproval?: boolean;
  /** Forwarded to /stream/org/local-usage for identity resolution. */
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onLiveTextDelta?: (delta: string) => void;
  /**
   * Inbound request abort signal. Passed to streamText so a client
   * disconnect cancels the upstream provider call.
   */
  abortSignal?: AbortSignal;
  /**
   * Total per-turn step budget enforced via the AI SDK's `stepCountIs`.
   * Defaults to 30 to match the hosted MCPJam path so users don't see
   * fewer agentic steps when routed through a local provider.
   */
  maxSteps?: number;
  /**
   * Progressive tool discovery plan. When `plan.enabled === true`, each
   * step's `activeTools` is recomputed from `discoveryState` via the AI SDK
   * `prepareStep` hook.
   */
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  /**
   * Synthesis run id for chatbox-session simulation runs. Forwarded to
   * `/stream/org/local-usage` so the backend BYOK writer can stamp it
   * onto the resulting `llmUsageRecord` for per-run spend attribution.
   * Omitted for real chat traffic.
   */
  synthesisRunId?: string;
}

export function handleLocalOrgChatModel(
  options: OrgLocalModelHandlerOptions
): Response {
  const {
    provider,
    modelId,
    messages,
    systemPrompt,
    temperature,
    tools,
    requireToolApproval,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    onLiveTextDelta,
  } = options;

  if (requireToolApproval && Object.keys(tools).length > 0) {
    const stream = createUIMessageStream({
      onError: (error) => formatLocalStreamError(error),
      onFinish: async () => {
        await onStreamComplete?.();
      },
      execute: async ({ writer }) => {
        onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });
        writer.write({
          type: "error",
          errorText: JSON.stringify({
            code: "tool_approval_unsupported",
            message:
              "Tool approval is not supported for local-runtime org providers yet. Disable tool approval or switch this provider to cloud runtime.",
          }),
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // Validate and build the AI SDK model before opening the stream.
  // If config/allowlist checks fail, return a formatted error stream rather
  // than letting the exception propagate as a 500.
  let llmModel: ReturnType<typeof buildOrgModelFromResolvedConfig>;
  try {
    assertOrgModelAllowed(provider, modelId);
    llmModel = buildOrgModelFromResolvedConfig(provider, modelId);
  } catch (configErr) {
    const stream = createUIMessageStream({
      onError: (error) => formatLocalStreamError(error),
      onFinish: async () => {
        await onStreamComplete?.();
      },
      execute: async ({ writer }) => {
        onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });
        writer.write({
          type: "error",
          errorText: formatLocalStreamError(configErr),
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const resolvedMaxSteps = resolveLocalOrgMaxSteps(options.maxSteps);

  // Declared before `createUIMessageStream` so the top-level `onError`
  // (which can fire before `execute` runs) can read it; assigned inside
  // `execute` once the engine is configured. Mirrors the route-4 pattern
  // in `streamDirectChatWithLiveTrace`.
  let handle: RunDirectChatTurnHandle | undefined;

  const stream = createUIMessageStream({
    onError: (error) => {
      // Silent-cancel invariant — match route 4: abort either reads from
      // the inbound signal directly or from the engine's `isAborted`. A
      // non-AbortError that arrives after the signal flipped is still
      // suppressed because the downstream controller is being torn down.
      if (
        options.abortSignal?.aborted ||
        handle?.isAborted() ||
        isAbortError(error)
      ) {
        return "";
      }
      logger.error("[org/local] stream error", error);
      return formatLocalStreamError(error);
    },
    onFinish: async () => {
      await onStreamComplete?.();
    },
    execute: async ({ writer }) => {
      onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });

      // Cursor PR-review fix (Medium "Failed turns persist sessions"):
      // legacy route 3 gated `onConversationComplete` on `!streamErrored`
      // so a provider error mid-stream skipped chat ingestion (post-error
      // partials weren't persisted). `runDirectChatTurn.onPersist` fires
      // regardless of prior error (only gates on abort). Capture the
      // error state here via `onEngineError` — the engine's parity
      // callback fires from its `streamText` `onError` branch — and
      // gate `onConversationComplete` below.
      let streamErrored = false;

      handle = runDirectChatTurn({
        // The org-resolved model is typed as the AI SDK `LanguageModel`
        // union, while `RunDirectChatTurnOptions.llmModel` is typed as
        // the narrower `createLlmModel` return (a provider-specific
        // union). Both reach the same `streamText(model: ...)` slot and
        // the SDK accepts both at runtime; cast to bridge the typing
        // gap rather than widen the engine's option shape.
        llmModel: llmModel as unknown as Parameters<
          typeof runDirectChatTurn
        >[0]["llmModel"],
        modelId,
        messageHistory: messages,
        systemPrompt,
        ...(temperature !== undefined ? { temperature } : {}),
        tools,
        progressivePlan: options.progressivePlan,
        discoveryState: options.discoveryState,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(onLiveTextDelta ? { onLiveTextDelta } : {}),
        maxSteps: resolvedMaxSteps,
        // Shared SSE-callback factory — byte-identical wire output with
        // route 4 (`streamDirectChatWithLiveTrace`).
        traceEvents: buildDirectChatTraceCallbacks(writer),
        // Cursor PR-review fix (Medium "Failed turns persist sessions"):
        // capture the engine-error state so `onPersist` below can skip
        // ingestion on provider errors, matching legacy behavior.
        // `postLocalUsage` still fires regardless (billing — matches
        // legacy unconditional usage writeback). Per-turn `onTurnError`
        // (SSE) still fires through `buildDirectChatTraceCallbacks`.
        onEngineError: () => {
          streamErrored = true;
        },
        // Route-3-only persistence wrapper: fire `onConversationComplete`
        // (chat ingestion) AND post usage back to Convex. Silent-cancel
        // is enforced by `runDirectChatTurn` — `onPersist` only fires on
        // non-aborted completion, preserving the legacy `postLocalUsage`
        // semantics (success only, never on abort).
        onPersist: buildLocalOrgOnPersist({
          options,
          isStreamErrored: () => streamErrored,
          onConversationComplete,
        }),
        onPersistError: (err) => {
          logger.warn("[org/local] onFinish ingestion error", {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      });

      try {
        for await (const chunk of handle.result.toUIMessageStream({
          messageMetadata: ({ part }) => {
            if (part.type === "finish-step") {
              return {
                inputTokens: part.usage.inputTokens,
                outputTokens: part.usage.outputTokens,
                totalTokens: part.usage.totalTokens,
              };
            }
          },
          onError: (error) => {
            if (handle!.isAborted() || isAbortError(error)) return "";
            return formatLocalStreamError(error);
          },
        })) {
          writer.write(withMcpToolOriginChunkMetadata(chunk, options.tools));
        }
      } catch (error) {
        if (handle.isAborted() || isAbortError(error)) {
          return;
        }
        throw error;
      } finally {
        handle.cleanup();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

// ---------------------------------------------------------------------------
// Shared local-runtime turn pieces (SSE handler + headless variant)
// ---------------------------------------------------------------------------

/**
 * `maxSteps`: legacy route 3 defaulted to 30 + accepted caller override.
 * CodeRabbit PR-review fix (Major "Do not silently drop maxSteps"): honor the
 * caller-supplied ceiling AND preserve the legacy default. Route 4 and eval
 * headless still get the engine default (20) because they omit the option.
 */
function resolveLocalOrgMaxSteps(maxSteps: number | undefined): number {
  return typeof maxSteps === "number" &&
    Number.isFinite(maxSteps) &&
    maxSteps > 0
    ? Math.floor(maxSteps)
    : 30;
}

/**
 * Route-3 persistence wrapper shared by the SSE handler and the headless
 * variant: post usage back to Convex AND fire `onConversationComplete`
 * (chat ingestion / transcript capture). Silent-cancel is enforced by
 * `runDirectChatTurn` — `onPersist` only fires on non-aborted completion,
 * preserving the legacy `postLocalUsage` semantics (success only, never on
 * abort).
 */
function buildLocalOrgOnPersist(params: {
  options: OrgLocalModelHandlerOptions;
  isStreamErrored: () => boolean;
  onConversationComplete: OrgLocalModelHandlerOptions["onConversationComplete"];
}): (event: DirectChatTurnPersistEvent) => Promise<void> {
  const { options, isStreamErrored, onConversationComplete } = params;
  return async (event) => {
    // Post usage to Convex (best-effort, non-blocking on failure).
    // Preserves the legacy fire-and-forget behavior so an ingestion
    // failure can't block the usage writeback or vice versa.
    postLocalUsage({
      projectId: options.projectId,
      providerKey: options.provider.providerKey,
      model: options.modelId,
      usage: event.usage,
      finishReason: event.finishReason,
      chatSessionId: options.chatSessionId,
      sourceType: options.sourceType,
      turnId: event.turnTrace.turnId,
      promptIndex: event.turnTrace.promptIndex,
      authHeader: options.authHeader,
      chatboxId: options.chatboxId,
      accessVersion: options.accessVersion,
      selectedServers: options.selectedServers,
      serverIds: options.serverIds,
      synthesisRunId: options.synthesisRunId,
    }).catch((err) => {
      logger.warn("[org/local] Failed to post local usage", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Cursor PR-review fix (Medium "Failed turns persist sessions"):
    // skip ingestion when the stream errored mid-flight; matches
    // legacy `if (!streamErrored)` gate at the old
    // `onConversationComplete` site. Billing already happened
    // above so the only thing we're suppressing is persistence
    // of a partial transcript.
    if (isStreamErrored() || !onConversationComplete) return;

    // Cursor PR-review fix (Medium "History rebuild skips
    // deduplication"): legacy code did
    // `appendDedupedModelMessages(traceHistory, responseMessages)`
    // against the FULL prefix (initial messages + accumulated
    // responses). The engine dedupes `responseMessages` against
    // itself across steps; the wrapper now dedupes again against
    // the initial-messages prefix so messages that overlap by
    // id / JSON identity don't double-write into the persisted
    // transcript. Real-world impact is low (AI SDK rarely emits
    // overlapping content with the prompt prefix), but restores
    // the legacy defensive-dedup semantics.
    const fullHistory: ModelMessage[] = [...options.messages];
    appendDedupedModelMessages(fullHistory, event.responseMessages);
    await onConversationComplete(fullHistory, event.turnTrace);
  };
}

// ---------------------------------------------------------------------------
// Headless local org BYOK turn (synthetic-session runner)
// ---------------------------------------------------------------------------

export interface RunLocalOrgChatTurnHeadlessOptions
  extends Omit<
    OrgLocalModelHandlerOptions,
    | "onConversationComplete"
    | "onStreamComplete"
    | "onStreamWriterReady"
    | "onLiveTextDelta"
  > {
  /** Per-step advertised-tool narrowing (browser session context gate). */
  prepareAdvertisedTools?: PrepareAdvertisedTools;
  /** Awaited per tool result (browser session context render hook). */
  onToolResultChunk?: DirectChatTurnTraceEvents["onToolResultChunk"];
}

/**
 * Headless sibling of {@link handleLocalOrgChatModel} for callers with no SSE
 * consumer (the synthetic-session runner). Drives `runDirectChatTurn` via
 * `consumeDirectChatTurnHeadless` — no `createUIMessageStream`, no Response
 * to drain — and shares the SSE handler's route-3 invariants through the
 * helpers above: model validation, the 30-step default, the unconditional
 * `postLocalUsage` writeback, the `streamErrored` ingestion gate, and the
 * deduped history rebuild.
 *
 * Error contract: where the SSE handler writes error chunks into the stream,
 * this variant THROWS — config/allowlist failures, the
 * `tool_approval_unsupported` guard, and mid-turn engine errors all surface
 * to the caller (usage writeback for completed steps has already fired via
 * `onPersist` where the engine ran far enough to produce one).
 */
export async function runLocalOrgChatTurnHeadless(
  options: RunLocalOrgChatTurnHeadlessOptions
): Promise<{
  messages: ModelMessage[];
  turnTrace?: PersistedTurnTrace;
  aborted: boolean;
}> {
  const { provider, modelId, messages, systemPrompt, temperature, tools } =
    options;

  if (options.requireToolApproval && Object.keys(tools).length > 0) {
    throw new Error(
      "Tool approval is not supported for local-runtime org providers yet. Disable tool approval or switch this provider to cloud runtime."
    );
  }

  // Same validation the SSE handler runs before opening its stream; headless
  // callers get the typed error (OrgProviderConfigError) instead of a
  // formatted error chunk.
  assertOrgModelAllowed(provider, modelId);
  const llmModel = buildOrgModelFromResolvedConfig(provider, modelId);

  let streamErrored = false;
  let engineErrorText: string | undefined;
  let capturedHistory: ModelMessage[] | undefined;
  let capturedTrace: PersistedTurnTrace | undefined;

  const handle = runDirectChatTurn({
    // Same typing bridge as the SSE handler: the org-resolved model is the
    // AI SDK `LanguageModel` union; the engine option is the narrower
    // `createLlmModel` return. Both reach the same `streamText` slot.
    llmModel: llmModel as unknown as Parameters<
      typeof runDirectChatTurn
    >[0]["llmModel"],
    modelId,
    messageHistory: messages,
    systemPrompt,
    ...(temperature !== undefined ? { temperature } : {}),
    tools,
    progressivePlan: options.progressivePlan,
    discoveryState: options.discoveryState,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    maxSteps: resolveLocalOrgMaxSteps(options.maxSteps),
    ...(options.prepareAdvertisedTools
      ? { prepareAdvertisedTools: options.prepareAdvertisedTools }
      : {}),
    ...(options.onToolResultChunk
      ? { traceEvents: { onToolResultChunk: options.onToolResultChunk } }
      : {}),
    onEngineError: (event) => {
      streamErrored = true;
      engineErrorText = event.message;
    },
    onPersist: buildLocalOrgOnPersist({
      options,
      isStreamErrored: () => streamErrored,
      onConversationComplete: (fullHistory, turnTrace) => {
        capturedHistory = fullHistory;
        capturedTrace = turnTrace;
      },
    }),
    onPersistError: (err) => {
      logger.warn("[org/local] headless onPersist error", {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const headless = await consumeDirectChatTurnHeadless(handle);
  if (headless.aborted) {
    return { messages, aborted: true };
  }
  if (streamErrored) {
    throw new Error(
      engineErrorText ?? "Local org-BYOK turn failed mid-stream."
    );
  }

  // `onPersist` fired on every non-aborted completion, so `capturedHistory`
  // is normally set; the rebuild below is a defensive fallback with the same
  // dedup semantics.
  if (!capturedHistory) {
    capturedHistory = [...messages];
    appendDedupedModelMessages(capturedHistory, headless.messages);
  }
  return {
    messages: capturedHistory,
    ...(capturedTrace ? { turnTrace: capturedTrace } : {}),
    aborted: false,
  };
}

async function postLocalUsage(params: {
  projectId: string;
  providerKey: string;
  model: string;
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  chatSessionId?: string;
  sourceType?: string;
  turnId?: string;
  promptIndex?: number;
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  selectedServers?: string[];
  serverIds?: string[];
  /**
   * Synthesis run id for chatbox-session simulation runs. Backend BYOK
   * writer stamps it onto `llmUsageRecord` so dashboards can query
   * "all spend for synthesisRunId X" in one hop. Omitted for real chat.
   */
  synthesisRunId?: string;
}): Promise<void> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) return;

  const url = `${convexHttpUrl.replace(/\/$/, "")}/stream/org/local-usage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.authHeader ? { Authorization: params.authHeader } : {}),
      },
      body: JSON.stringify({
        projectId: params.projectId,
        providerKey: params.providerKey,
        model: params.model,
        ...(params.usage ? { usage: params.usage } : {}),
        ...(params.finishReason ? { finishReason: params.finishReason } : {}),
        ...(params.chatSessionId
          ? { chatSessionId: params.chatSessionId }
          : {}),
        ...(params.sourceType ? { sourceType: params.sourceType } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(typeof params.promptIndex === "number"
          ? { promptIndex: params.promptIndex }
          : {}),
        ...(params.chatboxId ? { chatboxId: params.chatboxId } : {}),
        ...(params.chatboxId && Number.isFinite(params.accessVersion)
          ? { accessVersion: params.accessVersion }
          : {}),
        ...((params.serverIds ?? params.selectedServers)?.length
          ? { serverIds: params.serverIds ?? params.selectedServers }
          : {}),
        ...(params.synthesisRunId
          ? { synthesisRunId: params.synthesisRunId }
          : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const preview = await response.text().catch(() => "");
      logger.warn("[org/local] local-usage writeback non-2xx", {
        status: response.status,
        preview: preview.slice(0, 200),
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Hosted (cloud) org BYOK handler
// ---------------------------------------------------------------------------

export async function handleHostedOrgChatModel(
  options: OrgModelHandlerOptions
): Promise<Response> {
  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  return handleMCPJamFreeChatModel({
    messages: options.messages,
    modelId: options.modelId,
    chatSessionId: options.chatSessionId,
    sourceType: options.sourceType,
    systemPrompt: options.systemPrompt,
    temperature: options.temperature,
    tools: options.tools,
    projectId: options.projectId,
    authHeader: options.authHeader,
    chatboxId: options.chatboxId,
    accessVersion: options.accessVersion,
    mcpClientManager: options.mcpClientManager,
    selectedServers: options.selectedServers,
    requireToolApproval: options.requireToolApproval,
    approvalFreeUiToolNames: options.approvalFreeUiToolNames,
    modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
    ...(options.approvalMode !== undefined
      ? { approvalMode: options.approvalMode }
      : {}),
    onConversationComplete: options.onConversationComplete,
    onStreamComplete: options.onStreamComplete,
    onStreamWriterReady: options.onStreamWriterReady,
    onLiveTextDelta: options.onLiveTextDelta,
    clientIp: options.clientIp,
    abortSignal: options.abortSignal,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    maxSteps: options.maxSteps,
    progressivePlan: options.progressivePlan,
    discoveryState: options.discoveryState,
    endpointPath: "/stream/org",
    extraBodyFields: {
      // Caller-provided fields first; sibling fields from this handler
      // (providerKey, serverIds) override on collision so the hosted
      // contract can't be silently broken by a downstream caller.
      ...(options.extraBodyFields ?? {}),
      providerKey: options.providerKey,
      // chatboxId / accessVersion are set on the body by
      // handleMCPJamFreeChatModel itself.
      ...((options.serverIds ?? options.selectedServers)?.length
        ? { serverIds: options.serverIds ?? options.selectedServers }
        : {}),
    },
  });
}
