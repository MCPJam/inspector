import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import { describeError, describeAsSlug } from "@mcpjam/sdk";
import type { ModelProvider } from "@/shared/types";
import type {
  ProgressiveToolPlan,
  ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import { isAbortError } from "@/shared/abort-errors";
import type { PersistChatOutcome } from "../../utils/chat-ingestion.js";
import { writePersistReceipt } from "../../utils/chat-ingestion.js";
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "../../utils/provider-error-normalization.js";
import {
  runDirectChatTurn,
  withMcpToolOriginChunkMetadata,
  type RunDirectChatTurnHandle,
  type RunDirectChatTurnOptions,
  type DirectChatTurnPersistEvent,
} from "../../utils/direct-chat-turn.js";
import { buildDirectChatTraceCallbacks } from "../../utils/direct-chat-sse-callbacks.js";
import {
  createEmptyTurnWatcher,
  hasSettledToolCallThisPrompt,
} from "../../utils/empty-step-failure.js";
import { emitError } from "../../utils/chat-stream-chunks.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { logger } from "../../utils/logger.js";
import {
  resumeScopeStepUpBeforeDirectTurn,
  isSuspendedScopeStepUpOutputChunk,
} from "../../utils/direct-chat-scope-step-up.js";
import type { MrtrEngineResume } from "../../utils/mrtr-hosted-chat.js";

function formatStreamError(error: unknown, provider?: ModelProvider): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Run the cross-stack describer first so every stream-error branch can
  // attach a `normalized` block — clients pull this out for ErrorCard
  // rendering without re-classifying from the raw message.
  const normalized = describeError(error);

  // Duck-type statusCode/responseBody — APICallError.isInstance() can fail
  // when multiple copies of @ai-sdk/provider are bundled (symbol mismatch).
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  const responseBody =
    "responseBody" in error && typeof error.responseBody === "string"
      ? error.responseBody
      : undefined;
  if (
    isProviderOverloadError({
      message: error.message,
      statusCode,
      responseBody,
    })
  ) {
    return formatProviderOverloadError({ statusCode, responseBody });
  }

  // 401 is the standard "unauthorized" HTTP status — always means bad/missing key.
  const isAuthStatus = statusCode === 401;

  // Some providers (Google, xAI) return 400 instead of 401 for invalid keys.
  // We check the response body for phrases that unambiguously indicate an auth error.
  const lowerBody = responseBody?.toLowerCase() ?? "";
  const isAuthBody =
    lowerBody.includes("incorrect api key") ||
    lowerBody.includes("invalid api key") ||
    lowerBody.includes("api key not valid") ||
    lowerBody.includes("api_key_invalid") ||
    lowerBody.includes("authentication_error") ||
    lowerBody.includes("authentication fails") ||
    lowerBody.includes("invalid x-api-key");

  if (isAuthStatus || isAuthBody) {
    const providerName = provider || "your AI provider";
    // The generic describer would tag this as `auth/http_401` (MCP server
    // re-auth). We have provider context the describer doesn't, so override
    // the slug to point at LLM-provider-key guidance + docs anchor.
    const providerNormalized = describeAsSlug("provider/auth_error", error);

    return JSON.stringify({
      code: "auth_error",
      message: `Invalid API key for ${providerName}. Check your organization's model providers configuration.`,
      statusCode,
      normalized: providerNormalized,
    });
  }

  // For non-auth API errors, include the response body as details
  if (responseBody && typeof responseBody === "string") {
    return JSON.stringify({
      message: error.message,
      details: responseBody,
      normalized,
    });
  }

  // Even bare-message branches surface the normalized block so clients can
  // render an ErrorCard for unclassified provider failures.
  return JSON.stringify({
    message: error.message,
    normalized,
  });
}

/**
 * Chat user-API-key path. The `streamText` driver, trace span management,
 * abort wiring, and progressive-discovery gating live in
 * `runDirectChatTurn` (`server/utils/direct-chat-turn.ts`). This function
 * is the SSE terminal — it wraps the helper's trace-event callbacks in
 * `createUIMessageStream` writer events and drives the result through
 * `result.toUIMessageStream(...)` into the writer.
 * Eval's local-BYOK suite path (PR 4b) uses the same helper with the
 * headless terminal (`consumeDirectChatTurnHeadless`).
 */
export function streamDirectChatWithLiveTrace(options: {
  llmModel: RunDirectChatTurnOptions["llmModel"];
  modelId: string;
  provider?: ModelProvider;
  messageHistory: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  providerOptions?: ProviderOptions;
  tools: ToolSet;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  onLiveTextDelta?: RunDirectChatTurnOptions["onLiveTextDelta"];
  onEngineError?: RunDirectChatTurnOptions["onEngineError"];
  transformStepMessages?: RunDirectChatTurnOptions["transformStepMessages"];
  onPersistError?: RunDirectChatTurnOptions["onPersistError"];
  onStreamComplete?: () => void | Promise<void>;
  formatError?: (error: unknown) => string;
  reportError?: (
    error: unknown,
    phase: "stream" | "direct-stream" | "empty-step",
  ) => void;
  mapChunk?: (chunk: UIMessageChunk) => UIMessageChunk[];
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onPersist?: (
    event: DirectChatTurnPersistEvent,
  ) => Promise<void | PersistChatOutcome> | void | PersistChatOutcome;
  /** Session this stream persists to; required to attribute a persist receipt. */
  chatSessionId?: string;
  scopeStepUpResume?: MrtrEngineResume;
  shouldPauseAfterStep?: () => boolean;
  suspendedToolCallId?: () => string | undefined;
}): Response {
  const {
    provider,
    abortSignal,
    onStreamWriterReady,
    onPersist,
    onStreamComplete,
    formatError,
    reportError,
    mapChunk,
    onPersistError,
    chatSessionId: receiptChatSessionId,
    scopeStepUpResume,
    shouldPauseAfterStep,
    suspendedToolCallId,
    ...turnOptions
  } = options;
  // `runDirectChatTurn` awaits `onPersist` but discards its return value, so
  // the outcome reaches this scope through a closure rather than the callback
  // chain — cheaper than widening the engine's signature for every headless
  // caller that will never emit a receipt.
  let persistReceipt:
    { outcome: PersistChatOutcome; turnId: string } | undefined;
  // Declared before `createUIMessageStream` so the top-level `onError`
  // (which can fire before `execute` runs) can read it; assigned inside
  // `execute` once the helper is configured.
  let handle: RunDirectChatTurnHandle | undefined;

  const report = (
    error: unknown,
    phase: "stream" | "direct-stream" | "empty-step",
  ) => {
    if (reportError) return reportError(error, phase);
    reportRouteFailure(`[mcp/chat-v2] ${phase} error`, error, {
      source: `mcp.chat-v2.${phase}`,
      hop: "user_server_hop",
      context: { provider, modelId: options.modelId },
    });
  };
  const format =
    formatError ?? ((error: unknown) => formatStreamError(error, provider));
  const stream = createUIMessageStream({
    onFinish: async () => {
      await onStreamComplete?.();
    },
    onError: (error) => {
      // Cursor PR 4a review #1: the top-level `onError` can fire BEFORE
      // `execute` runs (e.g., stream creation failure), or for an
      // error that isn't `AbortError`. The pre-refactor code captured
      // `aborted` from an abort-listener attached at function entry so
      // either condition still suppressed formatting. Mirror that by
      // reading `abortSignal?.aborted` directly here — `handle` may be
      // undefined and `isAbortError` only matches the throw shape, not
      // a generic provider error that arrived after the signal flipped.
      if (abortSignal?.aborted || handle?.isAborted() || isAbortError(error)) {
        return "";
      }
      // Deliberately NO `mcpjam_internal` boundary here, unlike the route's
      // outer catch. Everything a turn touches fails through this handler: the
      // user's MCP server timing out mid-tool-call, a BYO provider key hitting
      // a quota wall, a model refusing a schema. That is precisely the traffic
      // that has been paging us for other people's outages, so the catalog's
      // verdict stands on its own and only MCPJam-fault slugs escalate.
      report(error, "stream");
      return format(error);
    },
    execute: async ({ writer }) => {
      // FIRST, before `runDirectChatTurn` configures the tool loop: the
      // task-created sink dispatches synchronously from inside a tool call,
      // so the bridge must already hold the writer or the part is warn-dropped
      // and the task handle never reaches the browser tracker.
      onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });
      const shouldRunModel = await resumeScopeStepUpBeforeDirectTurn({
        writer,
        messageHistory: turnOptions.messageHistory,
        resume: scopeStepUpResume,
      });
      if (!shouldRunModel) return;
      handle = runDirectChatTurn({
        ...turnOptions,
        // Logical provider for span metadata (OTel gen_ai.provider.name).
        // Pulled out of `turnOptions` above for error formatting; thread it
        // back in so llm/step spans carry it.
        provider,
        abortSignal,
        onPersist: onPersist
          ? async (event) => {
              const outcome = await onPersist(event);
              if (outcome) {
                persistReceipt = { outcome, turnId: event.turnTrace.turnId };
              }
            }
          : undefined,
        shouldPauseAfterStep,
        suspendedToolCallId,
        onPersistError:
          onPersistError ??
          ((error) => {
            logger.warn("[mcp/chat-v2] onFinish ingestion error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        // Trace-event factory shared with route 3 (local-org BYOK) so
        // both routes emit byte-identical SSE wire output. See
        // `server/utils/direct-chat-sse-callbacks.ts`.
        traceEvents: buildDirectChatTraceCallbacks(writer),
      });

      // `streamText` finishes an empty last step as if it were a reply, which
      // left a blank bubble and no record. Same verdict as the hosted engine.
      const emptyTurn = createEmptyTurnWatcher({
        settledToolBeforeStream: hasSettledToolCallThisPrompt(
          turnOptions.messageHistory,
          handle.traceTurn.promptMessageStartIndex,
        ),
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
            // `toUIMessageStream` CONSUMES the error here and emits an error
            // chunk; it does not rethrow to the enclosing
            // `createUIMessageStream` handler. Without this call, every model,
            // provider, and tool failure on the direct-stream path produced a
            // client error and no telemetry at all.
            report(error, "direct-stream");
            return format(error);
          },
        })) {
          if (
            isSuspendedScopeStepUpOutputChunk(chunk, suspendedToolCallId?.())
          ) {
            continue;
          }
          emptyTurn.observe(chunk);
          const emptyTurnMessage =
            chunk.type === "finish" && !handle.isAborted()
              ? emptyTurn.failureFor(chunk)
              : undefined;
          if (emptyTurnMessage) {
            // The error REPLACES the finish chunk, as on the hosted engine,
            // and is written before the report so a reporter throw cannot
            // swallow it.
            emitError(writer, emptyTurnMessage);
            report(new Error(emptyTurnMessage), "empty-step");
            continue;
          }
          const outgoing = withMcpToolOriginChunkMetadata(
            chunk,
            turnOptions.tools,
          );
          for (const mapped of mapChunk ? mapChunk(outgoing) : [outgoing]) {
            writer.write(mapped);
          }
        }
      } catch (error) {
        if (handle.isAborted() || isAbortError(error)) {
          return;
        }
        throw error;
      } finally {
        handle.cleanup();
      }

      // The persist has settled by here: it runs inside `streamText`'s
      // `onFinish`, which gates the UI-message stream this loop just drained.
      // The outer stream stays open until `execute` returns.
      if (persistReceipt && receiptChatSessionId) {
        writePersistReceipt(writer, persistReceipt.outcome, {
          chatSessionId: receiptChatSessionId,
          turnId: persistReceipt.turnId,
        });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
