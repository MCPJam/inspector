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
import { withOrgInlineReasoningExtracted } from "./inline-reasoning";
import {
  isClientFulfilledToolName,
  type UiToolApprovalClassification,
} from "@/shared/client-fulfilled-tools";
import {
  writePersistReceipt,
  type PersistChatOutcome,
  type PersistedTurnTrace,
} from "./chat-ingestion";
import { handleMCPJamFreeChatModel } from "./mcpjam-stream-handler.js";
import { logger } from "./logger.js";
import {
  createSystemStreamFailureReporter,
  oncePerTurn,
  type StreamFailureReporter,
} from "./stream-failure-reporter.js";
import {
  runDirectChatTurn,
  withMcpToolOriginChunkMetadata,
  type DirectChatTurnPersistEvent,
  type DirectChatTurnTraceEvents,
  type RunDirectChatTurnHandle,
} from "./direct-chat-turn.js";
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
import type { MrtrEngineResume } from "./mrtr-hosted-chat.js";
import {
  isSuspendedScopeStepUpOutputChunk,
  resumeScopeStepUpBeforeDirectTurn,
} from "./direct-chat-scope-step-up.js";

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
  /** Per-tool ui_* approval policy (see `classifyUiToolApprovals`). */
  uiToolApprovals?: UiToolApprovalClassification;
  /** Host/client policy for eligible MCP tool-result content/resources. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Approval mode forwarded into the wrapped MCPJam handler. Synthetic
   * callers pass `"auto-deny"` so approval-required tool calls auto-deny
   * inside the loop instead of pausing for a human (there is no visitor
   * in a synthetic run). Direct chatters omit or pass `"prompt"`.
   */
  approvalMode?: "prompt" | "auto-deny";
  /**
   * Persist tap. May return the ingest's outcome so the rail can stream a
   * `data-persist-receipt` before closing. See `PersistChatOutcome`.
   */
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void | PersistChatOutcome> | void | PersistChatOutcome;
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
   * Resolved scenario identity (post-redeem). Forwarded to /stream/org so
   * Convex can authorize the actor against the scenario + project.
   */
  scenarioId?: string;
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
  scopeStepUpResume?: MrtrEngineResume;
  /**
   * Extra body fields merged into the per-step Convex `/stream/org` POST.
   * Swarm runs use this to thread `journeyRunId` so the backend BYOK writer
   * can stamp it onto `llmUsageRecord` for per-run spend attribution.
   * Sibling fields from the handler (providerKey, serverIds) take precedence
   * on collision.
   */
  extraBodyFields?: Record<string, unknown>;
  /**
   * Typed-telemetry seam for mid-stream failures; forwarded verbatim into
   * the wrapped MCPJam handler. See stream-failure-reporter.ts.
   */
  failureReporter?: StreamFailureReporter;
}

// ---------------------------------------------------------------------------
// Helpers shared between local and hosted handlers
// ---------------------------------------------------------------------------

function readErrorString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate
    : undefined;
}

function readErrorNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function stringifyErrorObject(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const direct =
      readErrorString(value, "message") ||
      readErrorString(value, "error") ||
      readErrorString(value, "details");
    if (direct) return direct;

    const nested = (value as Record<string, unknown>).error;
    const nestedMessage =
      readErrorString(nested, "message") ||
      readErrorString(nested, "error") ||
      readErrorString(nested, "details");
    if (nestedMessage) return nestedMessage;
  }
  return String(value);
}

function readLocalStreamErrorFields(error: unknown): {
  message: string;
  statusCode?: number;
  responseBody?: string;
} {
  const message = stringifyErrorObject(error);
  if (!error || typeof error !== "object") return { message };

  const statusCode =
    readErrorNumber(error, "statusCode") || readErrorNumber(error, "status");
  // Only surface STRING body fields the provider SDK populates with its own
  // error text. Never JSON-stringify arbitrary `data`/`value` objects into the
  // client-visible details: those can carry request payloads, headers, or the
  // scoped credential, which is exactly what this helper exists to withhold.
  const responseBody =
    readErrorString(error, "responseBody") ||
    readErrorString(error, "responseText") ||
    readErrorString(error, "body");

  return { message, statusCode, responseBody };
}

export function formatLocalStreamError(error: unknown): string {
  if (error instanceof OrgProviderConfigError) {
    return JSON.stringify({ code: error.code, message: error.message });
  }
  const { message, statusCode, responseBody } =
    readLocalStreamErrorFields(error);
  if (
    isProviderOverloadError({
      message,
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
    return JSON.stringify({ message, details: responseBody });
  }
  return message;
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
  scenarioId?: string;
  accessVersion?: number;
  /**
   * Persist tap. May return the ingest's outcome so the rail can stream a
   * `data-persist-receipt` before closing. See `PersistChatOutcome`.
   */
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void | PersistChatOutcome> | void | PersistChatOutcome;
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
  scopeStepUpResume?: MrtrEngineResume;
  shouldPauseAfterStep?: () => boolean;
  suspendedToolCallId?: () => string | undefined;
  /**
   * Progressive tool discovery plan. When `plan.enabled === true`, each
   * step's `activeTools` is recomputed from `discoveryState` via the AI SDK
   * `prepareStep` hook.
   */
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  /**
   * Typed-telemetry seam for mid-stream failures (route.operation.failed);
   * see stream-failure-reporter.ts. Constructed at the route layer where a
   * Hono context exists.
   */
  failureReporter?: StreamFailureReporter;
}

/**
 * Whether this local-runtime turn hits the approval gap the handler cannot
 * serve, and must fail loudly instead.
 *
 * The gap is SERVER-EXECUTED tools: approving one resumes the turn by running
 * it here, and that resume path has never been supported (or tested) on the
 * local org runtime.
 *
 * Client-fulfilled tools (`ui_*`, `app_*`) don't need it. Their approval is
 * emitted natively by `streamText` from the per-tool `needsApproval` that
 * `buildUiTools` set, and an approval is resolved by the BROWSER executing the
 * tool and supplying the result via `addToolOutput` — the engine only has to
 * accept a history that already contains the output. That is the same path
 * route 4 (personal BYOK) drives through this very engine today, so refusing
 * it here would break the UI-only agent surface for local-runtime orgs while
 * protecting nothing.
 */
function hasUnsupportedLocalApprovalGate(
  tools: ToolSet,
  requireToolApproval: boolean | undefined
): boolean {
  if (!requireToolApproval) return false;
  return Object.entries(tools).some(([name, tool]) => {
    if (!isClientFulfilledToolName(name)) return true;
    // Name is necessary but NOT sufficient. A real MCP server tool called
    // `ui_foo` matches the namespace regex while still having an `execute`,
    // and exempting it on the name alone would let it run here without the
    // approval support this guard exists to demand. Same reason the client
    // dispatches on registry membership rather than the `ui_` prefix: the
    // property that matters is "the browser fulfills this", and only the
    // missing `execute` actually proves it.
    return (
      typeof (tool as { execute?: unknown } | undefined)?.execute === "function"
    );
  });
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

  // One typed route.operation.failed per turn across this handler's failure
  // sites; system fallback keeps the invariant if a future caller forgets it.
  const failureReporter = oncePerTurn(
    options.failureReporter ??
      createSystemStreamFailureReporter("org-local-stream")
  );

  // Deliberately NOT reported as an operation failure: this is a declared
  // product limitation surfaced to the user, not something that broke.
  if (hasUnsupportedLocalApprovalGate(tools, requireToolApproval)) {
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
    llmModel = withOrgInlineReasoningExtracted(
      buildOrgModelFromResolvedConfig(provider, modelId),
    );
  } catch (configErr) {
    // The response is still a 200 stream whose first chunk is the error, so
    // the HTTP failure events never see this — the typed event is the only
    // machine-readable record. Silent-cancel invariant: skip the report when
    // the request was already aborted before validation failed.
    if (!options.abortSignal?.aborted) {
      failureReporter({
        message: "[org/local] model config/allowlist failure",
        error: configErr,
        source: "web.chat-v2.org-local-config",
        hop: "user_server_hop",
        transport: "http_stream",
        context: { providerKey: provider.providerKey, modelId },
      });
    }
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
      // Reporter, not a bare logger.error: the old call captured to Sentry
      // unconditionally and left no typed record (this is a 200 stream).
      failureReporter({
        message: "[org/local] stream error",
        error,
        source: "web.chat-v2.org-local-stream",
        hop: "user_server_hop",
        transport: "http_stream",
        context: { providerKey: provider.providerKey, modelId },
      });
      return formatLocalStreamError(error);
    },
    onFinish: async () => {
      await onStreamComplete?.();
    },
    execute: async ({ writer }) => {
      onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });
      const shouldRunModel = await resumeScopeStepUpBeforeDirectTurn({
        writer,
        messageHistory: messages,
        resume: options.scopeStepUpResume,
      });
      if (!shouldRunModel) return;

      // Cursor PR-review fix (Medium "Failed turns persist sessions"):
      // legacy route 3 gated `onConversationComplete` on `!streamErrored`
      // so a provider error mid-stream skipped chat ingestion (post-error
      // partials weren't persisted). `runDirectChatTurn.onPersist` fires
      // regardless of prior error (only gates on abort). Capture the
      // error state here via `onEngineError` — the engine's parity
      // callback fires from its `streamText` `onError` branch — and
      // gate `onConversationComplete` below.
      let streamErrored = false;
      let persistReceipt:
        | { outcome: PersistChatOutcome; turnId: string }
        | undefined;

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
        shouldPauseAfterStep: options.shouldPauseAfterStep,
        suspendedToolCallId: options.suspendedToolCallId,
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
          onOutcome: (outcome, turnId) => {
            persistReceipt = { outcome, turnId };
          },
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
            // toUIMessageStream CONSUMES the error (no rethrow), so the
            // top-level onError above never sees it — this is the only
            // chance to record it. The two sites are exclusive per error.
            failureReporter({
              message: "[org/local] direct stream error",
              error,
              source: "web.chat-v2.org-local-direct-stream",
              hop: "user_server_hop",
              transport: "http_stream",
              context: { providerKey: provider.providerKey, modelId },
            });
            return formatLocalStreamError(error);
          },
        })) {
          if (
            isSuspendedScopeStepUpOutputChunk(
              chunk,
              options.suspendedToolCallId?.()
            )
          ) {
            continue;
          }
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

      // Safe to read here: `streamText`'s own `onFinish` — which is what
      // `onPersist` runs inside — resolves before the UI-message stream this
      // loop drains can end, so the persist has settled by the time we exit it.
      // The stream itself is still open until `execute` returns.
      if (persistReceipt && options.chatSessionId) {
        writePersistReceipt(writer, persistReceipt.outcome, {
          chatSessionId: options.chatSessionId,
          turnId: persistReceipt.turnId,
        });
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
export function resolveLocalOrgMaxSteps(maxSteps: number | undefined): number {
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
  /**
   * Hands the persist result back to the caller's scope. `runDirectChatTurn`
   * awaits `onPersist` but discards whatever it returns, so an outer closure is
   * the only way for the streaming rail to learn the outcome and emit its
   * receipt. Widening the engine's own signature would touch every headless
   * caller for no benefit.
   */
  onOutcome?: (outcome: PersistChatOutcome, turnId: string) => void;
}): (event: DirectChatTurnPersistEvent) => Promise<void> {
  const { options, isStreamErrored, onConversationComplete, onOutcome } =
    params;
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
      scenarioId: options.scenarioId,
      accessVersion: options.accessVersion,
      selectedServers: options.selectedServers,
      serverIds: options.serverIds,
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
    const outcome = await onConversationComplete(fullHistory, event.turnTrace);
    if (outcome) {
      onOutcome?.(outcome, event.turnTrace.turnId);
    }
  };
}

/**
 * Post a local-runtime BYOK usage record to Convex's
 * `/stream/org/local-usage` writeback endpoint. Exported so the shared
 * {@link resolveTurnRuntime} adapter can emit the byte-identical request the
 * SSE/headless local handlers do — the body shape is the source of truth for
 * per-run BYOK spend attribution, so it must never drift between call sites.
 */
export async function postLocalUsage(params: {
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
  scenarioId?: string;
  accessVersion?: number;
  selectedServers?: string[];
  serverIds?: string[];
  /**
   * Journey run id for swarm (journey-execution) synthetic sessions. The
   * backend stamps it onto `llmUsageRecord` so per-journey-run spend rolls
   * up in one query. Omitted for real chat.
   */
  journeyRunId?: string;
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
        ...(params.scenarioId ? { scenarioId: params.scenarioId } : {}),
        ...(params.scenarioId && Number.isFinite(params.accessVersion)
          ? { accessVersion: params.accessVersion }
          : {}),
        ...((params.serverIds ?? params.selectedServers)?.length
          ? { serverIds: params.serverIds ?? params.selectedServers }
          : {}),
        ...(params.journeyRunId ? { journeyRunId: params.journeyRunId } : {}),
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
    scenarioId: options.scenarioId,
    accessVersion: options.accessVersion,
    mcpClientManager: options.mcpClientManager,
    selectedServers: options.selectedServers,
    requireToolApproval: options.requireToolApproval,
    uiToolApprovals: options.uiToolApprovals,
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
    scopeStepUpResume: options.scopeStepUpResume,
    progressivePlan: options.progressivePlan,
    discoveryState: options.discoveryState,
    failureReporter: options.failureReporter,
    endpointPath: "/stream/org",
    extraBodyFields: {
      // Caller-provided fields first; sibling fields from this handler
      // (providerKey, serverIds) override on collision so the hosted
      // contract can't be silently broken by a downstream caller.
      ...(options.extraBodyFields ?? {}),
      providerKey: options.providerKey,
      // scenarioId / accessVersion are set on the body by
      // handleMCPJamFreeChatModel itself.
      ...((options.serverIds ?? options.selectedServers)?.length
        ? { serverIds: options.serverIds ?? options.selectedServers }
        : {}),
    },
  });
}
