import { Hono } from "hono";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ToolSet,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import { listLocalRuntimeSkills } from "../../utils/skill-tools.js";
import {
  listCloudRuntimeSkills,
  skillsFailureFrom,
} from "../../utils/computers/cloud-skill-tools.js";
import { buildLiveEffectiveCapabilities } from "../../services/environments/effective-capabilities.js";
import type { RuntimeStandaloneSkill } from "../../services/environments/effective-capabilities.js";
import type { SkillsFetchFailure } from "../../utils/computers/cloud-skill-tools.js";
import { getCanonicalModelId } from "@/shared/types";
import type { ModelProvider } from "@/shared/types";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import { getClientIp } from "../../utils/client-ip.js";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { logger } from "../../utils/logger";
import { WEBMCP_INSPECTOR_ENABLED } from "../../config";
import { fetchScenarioRuntimeConfig } from "../../utils/scenario-runtime-config";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import { checkHarnessRuntimeAvailable } from "../../utils/harness/harness-availability.js";
import {
  handleMCPJamFreeChatModel,
  warnIfChatAbortSignalMissing,
} from "../../utils/mcpjam-stream-handler";
import { resolveToolTaskSeam } from "../../utils/task-seam.js";
import { TaskCreatedSink } from "@mcpjam/sdk";
import type { UIMessageChunk } from "ai";
import { HostedTaskCreatedBridge } from "../../utils/hosted-task-created-bridge.js";
import {
  handleHostedOrgChatModel,
  handleLocalOrgChatModel,
} from "../../utils/org-model-stream-handler.js";
import { createRequestStreamFailureReporter } from "../../utils/stream-failure-reporter.js";
import {
  deriveOrgProviderKey,
  isLocalRuntimeEligible,
  resolveHostModelDefinition,
  resolveOrgProviderRuntime,
  type OrgProviderRuntime,
} from "../../utils/org-model-config.js";
import {
  buildDirectHostConfig,
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
  stampSenderUserIdsOnSessionMessages,
  writePersistReceipt,
  type PersistChatOutcome,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  buildWidgetModelContextSystemPrompt,
  prepareChatV2,
  validateAppToolEntries,
  AppToolValidationError,
  validatePageToolEntries,
  PageToolValidationError,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
} from "../../utils/chat-v2-orchestration";
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "../../utils/provider-error-normalization";
import {
  describeError,
  describeAsSlug,
  readXaaEnterprisePolicy,
} from "@mcpjam/sdk";
import {
  reportRouteFailure,
  reportRouteFailureForResponse,
  readRequestJson,
} from "../../utils/route-error-report.js";
import { type LiveChatTraceUsage } from "@/shared/live-chat-trace";
import { isAbortError } from "@/shared/abort-errors";
import {
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import {
  runDirectChatTurn,
  withMcpToolOriginChunkMetadata,
  type RunDirectChatTurnHandle,
} from "../../utils/direct-chat-turn";
import { buildDirectChatTraceCallbacks } from "../../utils/direct-chat-sse-callbacks";
import { resolveExecutionContext } from "../../utils/host-execution-context";
import { resolveHostTools } from "../../utils/built-in-tools/registry.js";
import { BASH_TOOL_NAME } from "../../utils/built-in-tools/bash.js";
import { maybeAppendEnvironmentContext } from "../../utils/computers/environment-context.js";
import { resolvePersonalComputerEngine } from "../../utils/computers/engine.js";
import {
  LOCAL_CONSENT_HEADER,
  verifyLocalComputerConsent,
} from "../../utils/computers/local-consent.js";
import { isGuestChatRequest } from "../../utils/computers/local-engine-request.js";
import { convertToMcpjamModelMessages } from "../../utils/mcp-tool-result-model-output.js";
import { type ExecutionScope } from "../../utils/execution-scope.js";
import {
  scopeStepUpInfoFromToolError,
  wrapToolsWithScopeStepUp,
} from "../../utils/insufficient-scope-step-up.js";
import type { ElicitationChunkWriter } from "../web/hosted-elicitation.js";
import {
  parseScopeStepUpCancelRequest,
  parseScopeStepUpResumeRequest,
  SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
  SCOPE_STEP_UP_VERSION,
  type ScopeStepUpCancelRequest,
  type ScopeStepUpResumeRequest,
} from "@/shared/scope-step-up";
import {
  cancelLocalScopeStepUpContinuation,
  cancelLocalScopeStepUpContinuationForRequest,
  claimLocalScopeStepUpContinuation,
  completeLocalScopeStepUpContinuation,
  createLocalScopeStepUpContinuation,
  failLocalScopeStepUpContinuation,
  markLocalScopeStepUpWireStarted,
} from "../../utils/scope-step-up-continuation.js";
import { executeToolCallsFromMessages } from "@/shared/http-tool-calls";
import type {
  MrtrChatResumeResolution,
  MrtrEngineResume,
} from "../../utils/mrtr-hosted-chat.js";
import {
  isSuspendedScopeStepUpOutputChunk,
  resumeScopeStepUpBeforeDirectTurn,
} from "../../utils/direct-chat-scope-step-up.js";

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

function toPersistedUsage(
  usage: LiveChatTraceUsage | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (
    typeof usage?.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number"
  ) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function buildScopeStepUpErrorToolResult(
  toolCallId: string,
  toolName: string,
  message: string,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "error-text", value: message },
      },
    ],
  } as unknown as ModelMessage;
}

function readProtectedResourceUrl(
  mcpClientManager: {
    getServerConfig?: (serverId: string) => unknown;
  },
  serverId: string,
): string | undefined {
  const config = mcpClientManager.getServerConfig?.(serverId);
  if (!config || typeof config !== "object") return undefined;
  const raw = (config as { url?: unknown }).url;
  if (typeof raw === "string") return raw;
  if (raw instanceof URL) return raw.toString();
  return undefined;
}

function buildLocalScopeStepUpResume(input: {
  request: ScopeStepUpResumeRequest;
  bindingKey: string;
  tools: ToolSet;
  modelVisibleMcpToolResults?: ChatV2Request["modelVisibleMcpToolResults"];
}): MrtrEngineResume {
  return {
    toolCallId: input.request.toolCallId,
    resolve: async (write): Promise<MrtrChatResumeResolution> => {
      let claimed;
      try {
        claimed = claimLocalScopeStepUpContinuation({
          continuationId: input.request.continuationId,
          toolCallId: input.request.toolCallId,
          bindingKey: input.bindingKey,
        });
      } catch (error) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      const originalTool = (input.tools as Record<string, any>)[
        claimed.toolName
      ];
      if (
        !originalTool ||
        typeof originalTool.execute !== "function" ||
        (typeof originalTool._serverId === "string" &&
          originalTool._serverId !== claimed.serverId)
      ) {
        failLocalScopeStepUpContinuation(
          claimed.continuationId,
          "original tool is no longer available",
        );
        return {
          kind: "halted",
          outcome: "failed",
          reason: "original tool is no longer available",
        };
      }

      let replayError: unknown;
      const execute = originalTool.execute.bind(originalTool);
      const replayTool = {
        ...originalTool,
        execute: async (toolInput: unknown, options: unknown) => {
          markLocalScopeStepUpWireStarted(claimed.continuationId);
          try {
            return await execute(toolInput, options);
          } catch (error) {
            replayError = error;
            throw error;
          }
        },
      };
      const replayHistory: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: claimed.toolCallId,
              toolName: claimed.toolName,
              input: claimed.input,
            },
          ],
        } as ModelMessage,
      ];

      let resultMessage: ModelMessage | undefined;
      try {
        const results = await executeToolCallsFromMessages(replayHistory, {
          tools: { [claimed.toolName]: replayTool },
          parallelToolExecution: false,
          modelVisibleMcpToolResults: input.modelVisibleMcpToolResults,
        });
        resultMessage = results[0];
      } catch (error) {
        replayError = replayError ?? error;
      }

      if (replayError) {
        const repeatedChallenge = scopeStepUpInfoFromToolError({
          error: replayError,
          serverId: claimed.serverId,
          toolCallId: claimed.toolCallId,
        });
        if (repeatedChallenge) {
          failLocalScopeStepUpContinuation(
            claimed.continuationId,
            "insufficient_scope repeated after authorization",
          );
          return {
            kind: "recover",
            reason: "insufficient_scope repeated after authorization",
            toolResultMessage:
              resultMessage ??
              buildScopeStepUpErrorToolResult(
                claimed.toolCallId,
                claimed.toolName,
                "Authorization completed, but the server still rejected the requested scope.",
              ),
          };
        }
        cancelLocalScopeStepUpContinuation(
          claimed.continuationId,
          "tool replay failed after the request started",
        );
        return {
          kind: "halted",
          outcome: "indeterminate",
          reason:
            "The retried tool call lost its connection after starting and may have run.",
        };
      }

      if (!resultMessage) {
        failLocalScopeStepUpContinuation(
          claimed.continuationId,
          "tool replay returned no result",
        );
        return {
          kind: "halted",
          outcome: "failed",
          reason: "tool replay returned no result",
        };
      }
      completeLocalScopeStepUpContinuation(claimed.continuationId);
      write({
        type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
        data: {
          version: SCOPE_STEP_UP_VERSION,
          continuationId: claimed.continuationId,
          serverId: claimed.serverId,
          operation: {
            method: "tools/call",
            operation: claimed.toolName,
          },
          outcome: "completed",
        },
        transient: true,
      } as unknown as UIMessageChunk);
      return { kind: "complete", toolResultMessage: resultMessage };
    },
  };
}

function buildLocalScopeStepUpCancellation(input: {
  request: ScopeStepUpCancelRequest;
  bindingKey: string;
}): MrtrEngineResume {
  return {
    toolCallId: input.request.toolCallId,
    resolve: async (write): Promise<MrtrChatResumeResolution> => {
      try {
        const cancelled = cancelLocalScopeStepUpContinuationForRequest({
          continuationId: input.request.continuationId,
          toolCallId: input.request.toolCallId,
          bindingKey: input.bindingKey,
          reason: "authorization was not completed",
        });
        write({
          type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
          data: {
            version: SCOPE_STEP_UP_VERSION,
            continuationId: input.request.continuationId,
            serverId: cancelled.serverId,
            operation: {
              method: "tools/call",
              operation: cancelled.toolName,
            },
            outcome: "cancelled",
          },
          transient: true,
        } as unknown as UIMessageChunk);
        return {
          kind: "recover",
          reason: "authorization was not completed",
          toolResultMessage: buildScopeStepUpErrorToolResult(
            input.request.toolCallId,
            cancelled.toolName,
            "Authorization was not completed, so the tool was not retried.",
          ),
        };
      } catch (error) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * Chat user-API-key path. The `streamText` driver, trace span management,
 * abort wiring, and progressive-discovery gating live in
 * `runDirectChatTurn` (`server/utils/direct-chat-turn.ts`). This function
 * is the SSE terminal — it wraps the helper's trace-event callbacks in
 * `createUIMessageStream` writer events and drives the result through
 * `result.toUIMessageStream(...)` into the writer.
 *
 * Eval's local-BYOK suite path (PR 4b) uses the same helper with the
 * headless terminal (`consumeDirectChatTurnHeadless`).
 */
function streamDirectChatWithLiveTrace(options: {
  llmModel: ReturnType<typeof createLlmModel>;
  modelId: string;
  provider?: ModelProvider;
  messageHistory: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  abortSignal?: AbortSignal;
  /**
   * Invoked with the live stream writer before the turn starts. Every
   * dispatch path with a tasks seam must attach the task-created bridge here,
   * BEFORE the first tool call can fire — the sink dispatches synchronously
   * from the tool loop, so a late attach means the bridge warn-drops the part
   * and the task is orphaned (see `server/utils/web-chat-turn.ts`).
   */
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onPersist?: (event: {
    responseMessages: ModelMessage[];
    assistantText: string;
    toolCalls: unknown[];
    toolResults: unknown[];
    usage?: LiveChatTraceUsage;
    finishReason?: string;
    turnTrace: PersistedTurnTrace;
  }) => Promise<void | PersistChatOutcome> | void | PersistChatOutcome;
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

  const stream = createUIMessageStream({
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
      reportRouteFailure("[mcp/chat-v2] stream error", error, {
        source: "mcp.chat-v2.stream",
        hop: "user_server_hop",
      });
      return formatStreamError(error, provider);
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
        onPersistError: (error) => {
          logger.warn("[mcp/chat-v2] onFinish ingestion error", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
        // Trace-event factory shared with route 3 (local-org BYOK) so
        // both routes emit byte-identical SSE wire output. See
        // `server/utils/direct-chat-sse-callbacks.ts`.
        traceEvents: buildDirectChatTraceCallbacks(writer),
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
            reportRouteFailure("[mcp/chat-v2] direct stream error", error, {
              source: "mcp.chat-v2.direct-stream",
              hop: "user_server_hop",
            });
            return formatStreamError(error, provider);
          },
        })) {
          if (
            isSuspendedScopeStepUpOutputChunk(chunk, suspendedToolCallId?.())
          ) {
            continue;
          }
          writer.write(
            withMcpToolOriginChunkMetadata(chunk, turnOptions.tools),
          );
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

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  try {
    const body = (await readRequestJson(c)) as ChatV2Request & {
      // Phase F: when the local inspector serves an owner-preview of a
      // scenario (the share-link surface running in /mcp), the client
      // passes the resolved scenario identity so persistence reads
      // `sourceType: "scenario"` + the right surface telemetry instead
      // of being filed as a direct chat.
      scenarioId?: string;
      accessVersion?: number;
      surface?: "preview" | "share_link";
      // Saved host being previewed (Playground over /mcp). See web/chat-v2.ts.
      hostId?: string;
      // Local⇄Cloud engine preference for the PERSONAL computer. Selects
      // WHERE the host-attached computer executes, never WHETHER one exists
      // (computer still comes only from the server-resolved runtime config).
      // "local" additionally requires the consent capability header.
      computerEngine?: "local" | "cloud";
    };
    const mcpClientManager = c.mcpClientManager;
    const rawScopeStepUpResume = body.scopeStepUpResume;
    const scopeStepUpResumeRequest =
      parseScopeStepUpResumeRequest(rawScopeStepUpResume);
    if (rawScopeStepUpResume !== undefined && !scopeStepUpResumeRequest) {
      return c.json({ error: "Malformed scopeStepUpResume descriptor" }, 400);
    }
    const rawScopeStepUpCancel = body.scopeStepUpCancel;
    const scopeStepUpCancelRequest =
      parseScopeStepUpCancelRequest(rawScopeStepUpCancel);
    if (rawScopeStepUpCancel !== undefined && !scopeStepUpCancelRequest) {
      return c.json({ error: "Malformed scopeStepUpCancel descriptor" }, 400);
    }
    if (scopeStepUpResumeRequest && scopeStepUpCancelRequest) {
      return c.json(
        { error: "Only one scope step-up continuation action is allowed" },
        400,
      );
    }
    const {
      messages,
      apiKey,
      model,
      systemPrompt: bodySystemPrompt,
      temperature: bodyTemperature,
      selectedServers,
      selectedServerIds: bodySelectedServerIds,
      requireToolApproval: bodyRequireToolApproval,
      respectToolVisibility: bodyRespectToolVisibility,
      scenarioId: bodyScenarioId,
      accessVersion: bodyAccessVersion,
      surface: bodySurface,
      hostId: bodyHostId,
    } = body;
    // Local execution cannot run a Project Environment, and must say so rather
    // than quietly ignoring the target and running an ad-hoc turn. Resolving an
    // environment needs a member-authorized Convex read plus the hosted
    // authorization plane that primes the manager from the resolved server set;
    // this route has neither. Fail clearly, at ingress, before anything else
    // reads the body.
    if ((body as { executionTarget?: unknown }).executionTarget !== undefined) {
      return c.json(
        {
          error:
            "Project Environments can't run on local /api/mcp execution — use the hosted chat route.",
        },
        400,
      );
    }
    const isScenarioSession = Boolean(bodyScenarioId);
    const chatSessionSourceType: "scenario" | "direct" = isScenarioSession
      ? "scenario"
      : "direct";
    // Mirrors the sourceType branch — scenario surface stays "scenario", the
    // non-scenario case is the inspector playground over MCP. The docs agent
    // has its own route (web/mcpjam-agent.ts) and never lands here.
    const chatSessionOrigin: "scenario" | "playground" = isScenarioSession
      ? "scenario"
      : "playground";
    const chatSessionSurface: "preview" | "share_link" | undefined =
      isScenarioSession ? (bodySurface ?? "preview") : undefined;

    // Scenario-bound turns re-resolve execution config from Convex so the
    // host's hostConfigs row is the source of truth (model / prompt /
    // temperature / requireToolApproval). Mirrors the web/chat-v2 path.
    // FAIL CLOSED on fetch failure — same rationale as the host-bound branch
    // below: the fetched config is the only source of `harness`/`computer`
    // and of every host-wins protection, so falling back to body values
    // would silently downgrade a harness scenario to the emulated engine and
    // reopen the tampered-body window.
    //
    // PR 4c of the engine consolidation (`~/mcpjam-docs/unification.md`):
    // the field-by-field merge between body and `fetchScenarioRuntimeConfig`
    // was duplicated across `mcp/chat-v2.ts` and `web/chat-v2.ts` and
    // drifted from eval's separate hostConfig resolver. Routed through the
    // shared `resolveExecutionContext` so a single helper owns the merge,
    // the precedence (`host-wins` for scenario security model — body
    // values are warned-and-overwritten), and the drift surfacing. Pure
    // refactor: resolved values for the existing fields are byte-identical
    // to the inline code below by construction (snapshot tests in
    // `host-execution-context.test.ts` lock the contract).
    let resolvedModelOverride: typeof model | null = null;
    let hostRuntimeConfig: Record<string, unknown> | null = null;
    if (isScenarioSession && bodyScenarioId) {
      // Scenario config resolution must NEVER be skipped: the fetched config is
      // the only source of host-owned harness/computer/executionScope and of
      // every host-wins protection. A bearer-less request is NOT a hard stop on
      // this route (the MCPJam-model path lazily mints a guest bearer below),
      // so resolve the SAME process-cached production guest bearer here first —
      // and fail closed if no bearer can be obtained at all.
      let bearer = c.req.header("authorization") ?? "";
      if (!bearer) {
        try {
          bearer = (await getProductionGuestAuthHeader()) ?? "";
        } catch {
          bearer = "";
        }
      }
      if (!bearer) {
        return c.json(
          {
            error:
              "Couldn't authenticate this scenario turn to load its settings — sign in (or retry) to continue.",
          },
          401,
        );
      }
      {
        const runtime = await fetchScenarioRuntimeConfig({
          scenarioId: bodyScenarioId,
          bearer,
          // Opt this turn into backend version enforcement — see
          // web/chat-v2.ts for the rationale.
          accessVersion: bodyAccessVersion,
        });
        if (runtime.ok) {
          // Cast the typed `ScenarioRuntimeConfig` to a plain record so
          // `resolveExecutionContext` can read it — the type narrowing
          // re-enters via the resolver's per-field typeof checks.
          hostRuntimeConfig = runtime.config as unknown as Record<
            string,
            unknown
          >;
        } else {
          logger.warn(
            "[mcp/chat-v2] runtime-config fetch failed; failing closed",
            {
              scenarioId: bodyScenarioId,
              status: runtime.status,
              error: runtime.error,
            },
          );
          const failClosedMessage = `Couldn't load this scenario's settings, so the turn was stopped to avoid running with the wrong configuration. ${runtime.error}`;
          // This route hand-rolls its error envelope (no WebRouteError), so
          // the access code rides as a top-level `code` — which is exactly
          // where the client's `readRouteError` looks. Only the access
          // verdicts carry one; every other status keeps the pre-existing
          // shape.
          if (runtime.code === "SCENARIO_ACCESS_STALE") {
            return c.json(
              { error: failClosedMessage, code: "SCENARIO_ACCESS_STALE" },
              409,
            );
          }
          if (runtime.status === 403) {
            return c.json(
              { error: failClosedMessage, code: "SCENARIO_ACCESS_DENIED" },
              403,
            );
          }
          return c.json(
            { error: failClosedMessage },
            runtime.status >= 500
              ? 502
              : (runtime.status as 400 | 401 | 403 | 409),
          );
        }
      }
    } else if (!isScenarioSession && bodyHostId) {
      // Host-bound direct session (Playground). FAIL CLOSED on fetch failure —
      // see web/chat-v2.ts for the rationale (a harness host must never quietly
      // fall back to the emulated engine).
      const bearer = c.req.header("authorization") ?? "";
      const runtime = await fetchHostRuntimeConfig({
        hostId: bodyHostId,
        bearer,
        signal: c.req.raw.signal as AbortSignal | undefined,
      });
      if (runtime.ok) {
        hostRuntimeConfig = runtime.config as unknown as Record<
          string,
          unknown
        >;
      } else {
        logger.warn(
          "[mcp/chat-v2] host runtime-config fetch failed; failing closed",
          { hostId: bodyHostId, status: runtime.status, error: runtime.error },
        );
        return c.json(
          {
            error: `Couldn't load this host's settings, so the turn was stopped to avoid running with the wrong engine. ${runtime.error}`,
          },
          runtime.status >= 500 ? 502 : (runtime.status as 400 | 401 | 403),
        );
      }
    }
    const resolvedExecution = resolveExecutionContext({
      hostConfig: hostRuntimeConfig,
      overrides: {
        systemPrompt: bodySystemPrompt,
        temperature: bodyTemperature,
        requireToolApproval: bodyRequireToolApproval,
        respectToolVisibility: bodyRespectToolVisibility,
        progressiveToolDiscovery: body.progressiveToolDiscovery,
        modelVisibleMcpToolResults: body.modelVisibleMcpToolResults,
        mcpToolResultImageRendering: body.mcpToolResultImageRendering,
        hostStyle:
          body.hostStyle ?? (!isScenarioSession ? "claude" : undefined),
        builtInToolIds: body.builtInToolIds,
      },
      // Scenario: published host wins. Host preview: owner's body tweaks win,
      // harness/computer stay host-only (not overridable). See web/chat-v2.ts.
      precedence: isScenarioSession ? "host-wins" : "override-wins",
    });
    // Preserve the per-field warnings the inline code emitted — the
    // resolver returns drift as data so the call site can keep its
    // existing log shape unchanged.
    for (const entry of resolvedExecution.drift) {
      if (entry.field === "requireToolApproval") {
        logger.warn(
          "[mcp/chat-v2] client requireToolApproval differs from host; using host value",
          {
            scenarioId: bodyScenarioId,
            body: entry.overrideValue,
            host: entry.hostValue,
          },
        );
      } else if (entry.field === "progressiveToolDiscovery") {
        logger.warn(
          "[mcp/chat-v2] client progressiveToolDiscovery differs from host; using host value",
          {
            scenarioId: bodyScenarioId,
            body: entry.overrideValue,
            host: entry.hostValue,
          },
        );
      } else if (entry.field === "respectToolVisibility") {
        logger.warn(
          "[mcp/chat-v2] client respectToolVisibility differs from host; using host value",
          {
            scenarioId: bodyScenarioId,
            body: entry.overrideValue,
            host: entry.hostValue,
          },
        );
      } else if (
        entry.field === "modelVisibleMcpToolResults" ||
        entry.field === "mcpToolResultImageRendering"
      ) {
        logger.warn(
          `[mcp/chat-v2] client ${entry.field} differs from host; using host value`,
          {
            scenarioId: bodyScenarioId,
            body: entry.overrideValue,
            host: entry.hostValue,
          },
        );
      }
    }
    // `modelId` stays special-cased: the resolver yields the resolved
    // string, and `resolveHostModelDefinition` lifts it (catalog hit →
    // full def; miss → org provider config lookup, then id-shape
    // inference). The provider must come from the host id + org config,
    // never the body model: org-only ids (Bedrock, custom:NAME, OpenRouter
    // selections with vendor-prefixed ids) would otherwise inherit the
    // body's provider and route to the wrong runtime.
    if (
      isScenarioSession &&
      hostRuntimeConfig &&
      model &&
      resolvedExecution.modelId &&
      resolvedExecution.modelId !== model.id
    ) {
      const hostModelId = resolvedExecution.modelId;
      const hostModel = await resolveHostModelDefinition({
        modelId: hostModelId,
        projectId: typeof body.projectId === "string" ? body.projectId : null,
        auth: {
          authHeader: c.req.header("authorization") ?? undefined,
          scenarioId: bodyScenarioId,
        },
      });
      logger.warn(
        "[mcp/chat-v2] client model differs from host; using host model",
        {
          scenarioId: bodyScenarioId,
          body: model.id,
          host: hostModelId,
          provider: hostModel.provider,
        },
      );
      resolvedModelOverride = hostModel;
    }
    const systemPrompt = resolvedExecution.systemPrompt;
    const temperature = resolvedExecution.temperature;
    const requireToolApproval = resolvedExecution.requireToolApproval;
    const respectToolVisibility = resolvedExecution.respectToolVisibility;
    const resolvedProgressiveToolDiscovery =
      resolvedExecution.progressiveToolDiscovery;
    const { modelVisibleMcpToolResults, mcpToolResultImageRendering } =
      resolvedExecution.hostPolicy;
    const inboundMcpToolResultModelOutputOptions = {
      modelVisibleMcpToolResults,
      // Browser-sent history can replay already-resolved media, but must not
      // trigger new linked resource reads. Fresh server-side tool execution
      // resolves resource_link results through trusted tool-origin metadata.
      abortSignal: c.req.raw.signal as AbortSignal | undefined,
    };

    // Local-mode `selectedServers` is server *names*, not Convex Ids. The
    // backend's `hostConfigPayloadValidator` requires `v.array(v.id('servers'))`,
    // so emitting hostConfig with names would 400 the entire ingest call and
    // drop the transcript. The client only supplies `selectedServerIds` when
    // every selected name resolved to an Id (length-matched), or when no
    // servers were selected at all (both arrays empty — still a valid
    // hostConfig the backend can dedupe on). Any other shape — array missing,
    // shorter than the names array, or names present without ids — falls
    // through to "no real Ids available" and skips hostConfig (backend
    // persists transcript with hostConfigId=null, same as pre-rollout
    // behavior).
    const hostConfigServerIds: string[] | undefined =
      Array.isArray(bodySelectedServerIds) &&
      bodySelectedServerIds.length === (selectedServers?.length ?? 0)
        ? bodySelectedServerIds
        : undefined;

    // Validation
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = resolvedModelOverride ?? model;
    if (!modelDefinition) {
      return c.json({ error: "model is not supported" }, 400);
    }

    const requestAuthHeader = c.req.header("authorization");
    // Provider-aware, matching streamWebChatTurn's dispatch: bare hosted ids
    // (`gpt-5-nano` + `openai`) only canonicalize to their prefixed MCPJam form
    // with the provider — a provider-blind check here routes them into
    // org/BYOK below even after they passed the harness preflight.
    const isMcpJamProvidedModel = Boolean(
      modelDefinition.id &&
      isHostedCatalogModel(modelDefinition.id, modelDefinition.provider),
    );
    // Guests may use any hosted model — model curation for guests is gone;
    // the backend enforces spend caps (a soft postpaid guard), not an
    // allowlist. A guest MCPJam-model request still gets its bearer minted
    // lazily below (resolveMcpJamAuthHeader).
    let mcpJamAuthHeader = requestAuthHeader;
    const resolveMcpJamAuthHeader = async () => {
      if (mcpJamAuthHeader || !isMcpJamProvidedModel) return mcpJamAuthHeader;
      try {
        mcpJamAuthHeader = (await getProductionGuestAuthHeader()) ?? undefined;
      } catch {
        mcpJamAuthHeader = undefined;
      }
      return mcpJamAuthHeader;
    };

    // Guest MCPJam-model requests get their bearer lazily server-side. Resolve
    // it before tool prep too, otherwise host-enabled built-ins are omitted
    // even though the later MCPJam model path can authenticate the turn.
    if (
      isMcpJamProvidedModel &&
      !mcpJamAuthHeader &&
      process.env.CONVEX_HTTP_URL
    ) {
      await resolveMcpJamAuthHeader();
    }

    // Convert the inbound UI messages once so prepareChatV2 can replay
    // prior `load_mcp_tools` calls into discovery state. The downstream
    // paths call convertToModelMessages again; that's intentional and
    // independent — this conversion is solely for hydration.
    const priorModelMessages = await convertToMcpjamModelMessages(
      messages,
      inboundMcpToolResultModelOutputOptions,
    );

    // SEP-1865 App-Provided Tools: validate the client snapshot at the
    // boundary. The chat request body is not trusted; oversize / malformed
    // entries 400 with a clean message instead of crashing prepareChatV2.
    let validatedAppTools;
    try {
      validatedAppTools = validateAppToolEntries(body.appTools);
    } catch (error) {
      if (error instanceof AppToolValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    // WebMCP page tools: same boundary treatment as the app-tool snapshot, and
    // gated on the kill switch — a turn must not be able to advertise page
    // tools on an inspector where the feature is off.
    let validatedPageTools;
    try {
      validatedPageTools = WEBMCP_INSPECTOR_ENABLED
        ? validatePageToolEntries(body.pageTools)
        : [];
    } catch (error) {
      if (error instanceof PageToolValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    // `body.uiTools` is intentionally ignored here, not rejected: MCPJam UI
    // tools are agent-route-only (server/routes/web/mcpjam-agent.ts), but
    // cached pre-cutover clients may still send the field. Without a
    // validated snapshot no MCPJam UI approval/free-name classification
    // exists on this route — an MCP server tool named `ui_*` is a normal
    // executable tool with ordinary approval semantics.

    let validatedWidgetModelContext;
    try {
      validatedWidgetModelContext = validateWidgetModelContextEntries(
        body.widgetModelContext,
      );
    } catch (error) {
      if (error instanceof WidgetModelContextValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    // Harness preflight: fail closed with a clear message when a host-resolved
    // harness (claude-code | codex) can't run on this server (never silent-
    // fallback). Capability-driven (computer / approval / MCP / model eligibility).
    if (resolvedExecution.harness) {
      const availability = checkHarnessRuntimeAvailable({
        harnessId: resolvedExecution.harness,
        requireToolApproval: resolvedExecution.requireToolApproval,
        hasSelectedMcpServers: (selectedServers?.length ?? 0) > 0,
        // The RESOLVED definition — eligibility and the canonical id are both
        // derived from it inside the gate, so no call site can compute the two
        // inconsistently.
        model: {
          id: String(modelDefinition.id),
          provider: modelDefinition.provider,
        },
        // Fail closed rather than let a harness turn bypass the host's
        // enterprise-managed policy: the harness proxy token carries no
        // host, so that route can't enforce it (see the flag's docstring).
        // Read from the server-resolved host config, never the body.
        xaaEnterprisePolicyOn:
          readXaaEnterprisePolicy(
            (hostRuntimeConfig as { mcpProfile?: unknown } | null)?.mcpProfile,
          ).kind !== "off",
      });
      if (!availability.ok) {
        return c.json(
          {
            error: `This host runs the ${resolvedExecution.harness} harness, which isn't available: ${availability.reason}.`,
          },
          503,
        );
      }
    }

    // Built-in tools (e.g. web_search) bill MCPJam credits via a Convex
    // HTTP action, which needs a bearer + projectId to authorize. Local
    // requests without either (anonymous local mode, no project) omit the
    // tools — same degradation as a host that never enabled them.
    const builtInAuthHeader = mcpJamAuthHeader ?? requestAuthHeader;
    // Phase 3: thread the server-resolved runtime config's executionScope into
    // the computer-backed (bash) tool so the reserve call re-resolves live
    // access (per-swarm isolation/caps). Absent ⇒ legacy projectId reserve.
    const executionScope = (
      hostRuntimeConfig as
        { executionScope?: ExecutionScope } | null | undefined
    )?.executionScope;

    // Local⇄Cloud engine preference — a LOCAL-ROUTE-ONLY channel (this route
    // is not mounted hosted). The field selects WHERE the host-attached
    // computer executes; the consent CAPABILITY in the header — never the
    // field — is the proof the human clicked Allow on this machine. An
    // ineligible request degrades to the legacy cloud family; an eligible
    // explicit ask that can't be honored resolves `unavailable`, never
    // silently cloud.
    const rawEnginePref = body.computerEngine;
    const enginePref =
      rawEnginePref === "local" || rawEnginePref === "cloud"
        ? rawEnginePref
        : undefined;
    // A GUEST must never resolve the local engine — bash on the local machine
    // has no backend reserve gate (unlike the cloud path), so the request-level
    // guest check IS the boundary (see isGuestChatRequest).
    const requestIsGuest = isGuestChatRequest(requestAuthHeader);
    const localPrefEligible =
      enginePref === "local" && !requestIsGuest && !isScenarioSession;
    if (enginePref === "local" && !localPrefEligible) {
      logger.debug(
        "[mcp/chat-v2] computerEngine=local ignored for an ineligible request",
        { isScenarioSession, isGuest: requestIsGuest },
      );
    }
    const localConsentValid = localPrefEligible
      ? await verifyLocalComputerConsent(c.req.header(LOCAL_CONSENT_HEADER))
      : false;
    if (localPrefEligible && !localConsentValid) {
      logger.warn(
        "[mcp/chat-v2] computerEngine=local without a valid consent capability; local engine unavailable for this turn",
      );
    }
    const computerEngine = resolvePersonalComputerEngine({
      ...(localPrefEligible
        ? { preference: "local" as const }
        : enginePref === "cloud"
          ? { preference: "cloud" as const }
          : {}),
      localConsentValid,
    });

    const builtInTools = resolveHostTools(
      {
        builtInToolIds: resolvedExecution.builtInToolIds,
        // Computer comes from the server-resolved runtime config (scenario OR
        // host-by-id), never the request body.
        computer: hostRuntimeConfig
          ? (hostRuntimeConfig as { computer?: unknown }).computer
          : undefined,
      },
      builtInAuthHeader && typeof body.projectId === "string" && body.projectId
        ? {
            authHeader: builtInAuthHeader,
            projectId: body.projectId,
            // A request with no user-supplied Authorization is an anonymous
            // guest (the route mints a production guest bearer for it), so the
            // resolver withholds bash on the personal-project path — matching
            // web/chat-v2's `isGuest: Boolean(c.get("guestId"))`. Bash is kept
            // only for a host-funded swarm executionScope.
            isGuest: !requestAuthHeader,
            ...(executionScope ? { executionScope } : {}),
            ...(body.chatSessionId
              ? { chatSessionId: body.chatSessionId }
              : {}),
            // Host approval policy — previously not threaded on this route,
            // so playground bash silently ran with needsApproval:false
            // whatever the host said. Cloud bash now honors it; local bash
            // requires approval regardless (see bash.ts).
            requireToolApproval: resolvedExecution.requireToolApproval === true,
            computerEngine,
            localComputerRequested: localPrefEligible,
          }
        : null,
    );

    // Blueprint knowledge/maintenance: when this turn advertises bash, append
    // the pinned image's model-facing context to the system prompt (threaded
    // through prepareChatV2's enhanced prompt). Tri-state fetch inside — a
    // Convex blip degrades to "no extra context", never a broken turn. The
    // persisted direct-chat/resume configs keep the RAW user prompt; the env
    // block is turn-injected, not user configuration.
    const effectiveSystemPrompt = await maybeAppendEnvironmentContext({
      systemPrompt,
      // The environment context describes the pinned E2B image — the WRONG
      // machine when this turn's bash runs on the user's own computer.
      hasBashTool:
        computerEngine !== "local" && Boolean(builtInTools?.[BASH_TOOL_NAME]),
      bearer: builtInAuthHeader,
      projectId:
        typeof body.projectId === "string" ? body.projectId : undefined,
      ...(executionScope ? { executionScope } : {}),
    });

    // COMP-16: the host-configured computer working directory — the SAME
    // `computer.workdir` the bash tool runs in — threaded into the harness path
    // so its Shell roots under the same directory. Server-resolved config only.
    const computerWorkdir = (
      hostRuntimeConfig as { computer?: { workdir?: unknown } } | undefined
    )?.computer?.workdir;
    const harnessComputerWorkdir =
      typeof computerWorkdir === "string" ? computerWorkdir : undefined;

    // Host-only, exactly as in the hosted route: a scenario session's body must
    // not be able to opt into tasks the host disabled. `tasksPolicy` never
    // enters the override path, so `override-wins` above cannot reach it.
    //
    // The sink carries a stream bridge, and that is not optional: the
    // extension wire has NO `tasks/list` (`resolveTasksSupport` reports
    // `list: false`), so the browser tracker is the ONLY way a task on such a
    // server can ever be found again. A seam with nowhere to deliver would log
    // the handle server-side and orphan the task.
    //
    // No `hostedTasksVersion` gate here, unlike the hosted route. That
    // handshake exists because a hosted browser can be running a cached bundle
    // older than the server; a desktop install ships both halves together and
    // cannot skew. An older bundle would ignore the part anyway — the data-part
    // chain has no terminal `else`.
    const tasksSink = new TaskCreatedSink();
    const tasksSeam = resolveToolTaskSeam({
      tasksPolicy: resolvedExecution.tasksPolicy,
      surface: "chat",
      sink: tasksSink,
    });
    // Local server ids ARE the display names, so the payload's `serverId`
    // already carries what the tracker keys by and no name map is needed.
    const taskCreatedBridge = tasksSeam
      ? new HostedTaskCreatedBridge({ serverNamesById: {} })
      : undefined;
    if (taskCreatedBridge) {
      tasksSink.register({
        name: "task-created-bridge",
        handle: taskCreatedBridge.handle,
      });
    }

    // ONE catalog for this turn, replacing the exclusive either/or the
    // orchestrator used to pick between.
    //
    // Local files are always in it (this route only runs where there IS a local
    // filesystem). The project's skills join them when the request is
    // authenticated and names a project — the same three conditions
    // `shouldEnableCloudSkillTools` applies on the hosted routes, restated here
    // because this route derives guest-ness from the absence of an
    // Authorization header rather than from a guest id.
    //
    // Signed out, or with no project: local-only, which is exactly what this
    // route did before. What is new is that signing IN no longer means choosing.
    const localRuntimeSkills = await listLocalRuntimeSkills().catch((error) => {
      logger.warn(
        "[chat-v2] local skill scan failed; continuing without them",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return [];
    });
    let cloudRuntimeSkills: RuntimeStandaloneSkill[] = [];
    let skillsFetchFailed: SkillsFetchFailure | undefined;
    if (requestAuthHeader && body.projectId) {
      const startedAt = Date.now();
      try {
        cloudRuntimeSkills = await listCloudRuntimeSkills({
          authHeader: requestAuthHeader,
          projectId: body.projectId,
        });
      } catch (error) {
        // A failed catalog fetch is NOT an empty project, and the difference is
        // what tells "this user has no skills" from "we lost their skills this
        // turn". Same signal the hosted path already reports — measured, since
        // a timeout and a refusal are the same class with different latencies.
        skillsFetchFailed = skillsFailureFrom(error, Date.now() - startedAt);
        logger.warn("[chat-v2] project skill catalog fetch failed", {
          projectId: body.projectId,
          message: skillsFetchFailed.message,
        });
      }
    }
    const turnCapabilities = buildLiveEffectiveCapabilities({
      standaloneSkills: cloudRuntimeSkills,
      localSkills: localRuntimeSkills,
    });

    let prepared;
    try {
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt: effectiveSystemPrompt,
        temperature,
        requireToolApproval,
        respectToolVisibility,
        modelVisibleMcpToolResults,
        customProviders: body.customProviders,
        priorMessages: priorModelMessages,
        ...(resolvedExecution.harness
          ? { harness: resolvedExecution.harness }
          : {}),
        ...(tasksSeam ? { tasks: tasksSeam } : {}),
        ...(builtInTools ? { builtInTools } : {}),
        // A harness turn takes its skills on-box and must be handed none here —
        // the two delivery channels are deliberately disjoint.
        skillsSource: resolvedExecution.harness
          ? { kind: "none" as const }
          : {
              kind: "resolved" as const,
              capabilities: turnCapabilities,
              // Live surface: server skills come from the connected servers,
              // not from a captured set.
              composeLiveServerSkills: true,
              // A lazy body or file read outlives the request that asked for
              // it otherwise: the fetch runs to its own timeout after the user
              // has already navigated away.
              ...(c.req.raw.signal
                ? { abortSignal: c.req.raw.signal as AbortSignal }
                : {}),
            },
        // Body for direct chat (project default), host-re-resolved for
        // scenario-bound sessions. undefined → auto policy.
        ...(resolvedProgressiveToolDiscovery !== undefined
          ? {
              progressiveToolDiscovery: {
                enabled: resolvedProgressiveToolDiscovery,
              },
            }
          : {}),
        appTools: validatedAppTools,
        pageTools: validatedPageTools,
      });
    } catch (error) {
      // prepareChatV2 throws on Anthropic validation errors — return 400.
      // All other errors (e.g. getToolsForAiSdk failure) propagate to the
      // outer catch which returns 500.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Invalid tool name(s) for Anthropic")) {
        return c.json({ error: msg }, 400);
      }
      // Any user-server attribution is marked inside `prepareChatV2`, on the
      // single await that leaves MCPJam. Marking the whole call here would
      // silence a genuine bug in the preparation work that follows it.
      throw error;
    }

    const {
      allTools: preparedTools,
      enhancedSystemPrompt,
      resolvedTemperature,
      scrubMessages,
      progressivePlan,
      discoveryState,
    } = prepared;
    const authenticatedUserId = c.var.requestLogContext?.userId ?? null;
    const scopeStepUpBindingKey = JSON.stringify([
      authenticatedUserId ?? "local-anonymous",
      body.projectId ?? "",
      body.chatSessionId ?? "",
    ]);
    // The stream writer is created after tools are prepared, so the wrapper
    // resolves it lazily when a tool actually reports a scope challenge.
    let scopeChallengeWriter: ElicitationChunkWriter | null = null;
    let suspendedScopeStepUpToolCallId: string | undefined;
    const createScopeStepUpContinuation = ({
      info,
      toolName,
      toolInput,
    }: {
      info: Parameters<
        typeof createLocalScopeStepUpContinuation
      >[0]["challenge"] & {
        toolCallId: string;
      };
      toolName: string;
      toolInput: unknown;
    }) => {
      const resourceUrl = readProtectedResourceUrl(
        mcpClientManager,
        info.serverId,
      );
      const event = createLocalScopeStepUpContinuation({
        bindingKey: scopeStepUpBindingKey,
        serverId: info.serverId,
        ...(resourceUrl ? { resourceUrl } : {}),
        toolCallId: info.toolCallId,
        toolName,
        toolInput,
        challenge: info,
        serverName: info.serverId,
      });
      suspendedScopeStepUpToolCallId = event.toolCallId;
      return event;
    };
    const allTools = wrapToolsWithScopeStepUp(
      preparedTools,
      () => scopeChallengeWriter,
      {
        createContinuation: ({ info, toolName, toolInput }) =>
          createScopeStepUpContinuation({
            info: { ...info, toolCallId: info.toolCallId! },
            toolName,
            toolInput,
          }),
      },
    );
    const scopeStepUpEngineResume = scopeStepUpResumeRequest
      ? buildLocalScopeStepUpResume({
          request: scopeStepUpResumeRequest,
          bindingKey: scopeStepUpBindingKey,
          tools: preparedTools,
          modelVisibleMcpToolResults,
        })
      : scopeStepUpCancelRequest
        ? buildLocalScopeStepUpCancellation({
            request: scopeStepUpCancelRequest,
            bindingKey: scopeStepUpBindingKey,
          })
        : undefined;
    const widgetModelContextSystemPrompt = buildWidgetModelContextSystemPrompt(
      validatedWidgetModelContext,
    );
    const effectiveEnhancedSystemPrompt = [
      enhancedSystemPrompt,
      widgetModelContextSystemPrompt,
    ]
      .filter((section) => section.trim().length > 0)
      .join("\n\n");

    // Shared across all three persist call sites below. All three paths are
    // hardcoded `sourceType: "direct"` and pass the same model/temperature/
    // server config, so the payload is identical — compute it once.
    const directHostConfig = hostConfigServerIds
      ? buildDirectHostConfig({
          modelId: String(modelDefinition.id),
          // Phase 3: forward the chat tab's resolved host style so the
          // backend writes a v2 hostConfig with a real (non-`'direct'`)
          // hostStyle. Defaults to `'claude'` when omitted by the
          // caller — see DirectChatHostStyle docs.
          hostStyle: body.hostStyle,
          systemPrompt,
          requestedTemperature: temperature,
          resolvedTemperature,
          requireToolApproval,
          respectToolVisibility,
          modelVisibleMcpToolResults:
            resolvedExecution.modelVisibleMcpToolResults,
          mcpToolResultImageRendering:
            resolvedExecution.mcpToolResultImageRendering,
          selectedServerIds: hostConfigServerIds,
        })
      : undefined;

    // MCPJam-provided models: delegate to stream handler
    if (isMcpJamProvidedModel && modelDefinition.id) {
      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500,
        );
      }

      // Resolve auth header: use client-provided token (WorkOS) if present,
      // otherwise fetch a production guest token for guest-allowed models.
      const authHeader = await resolveMcpJamAuthHeader();
      if (!authHeader) {
        return c.json(
          {
            error:
              "Unable to authenticate with MCPJam servers. Please try again or sign in.",
          },
          503,
        );
      }

      const modelMessages = await convertToMcpjamModelMessages(
        messages,
        inboundMcpToolResultModelOutputOptions,
      );
      const sessionStartedAt = Date.now();

      const chatSessionId = body.chatSessionId;

      const inboundAbortSignalMcp = c.req.raw.signal as AbortSignal | undefined;
      warnIfChatAbortSignalMissing(inboundAbortSignalMcp, "mcp/chat-v2");

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        failureReporter: createRequestStreamFailureReporter(c, "chat"),
        modelId: String(modelDefinition.id),
        provider: modelDefinition.provider,
        systemPrompt: effectiveEnhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader,
        clientIp: getClientIp(c),
        mcpClientManager,
        selectedServers,
        requireToolApproval,
        modelVisibleMcpToolResults,
        // Harness engine only: it builds its own MCP tool set (host-executed
        // delivery) rather than consuming `allTools`, so the host's
        // tool-construction policies have to reach it separately. Inert on the
        // emulated path, which is handed tools already built by prepareChatV2.
        respectToolVisibility,
        ...(tasksSeam ? { tasks: tasksSeam } : {}),
        ...(scopeStepUpEngineResume
          ? { scopeStepUpResume: scopeStepUpEngineResume }
          : {}),
        ...(resolvedExecution.harness
          ? {
              createHarnessScopeStepUpContinuation:
                createScopeStepUpContinuation,
            }
          : {}),
        onStreamWriterReady: (writer: {
          write: (chunk: UIMessageChunk) => void;
        }) => {
          scopeChallengeWriter = writer;
          taskCreatedBridge?.attachStreamWriter(writer);
        },
        ...(resolvedExecution.harness
          ? {
              harness: resolvedExecution.harness,
              // Harness MCP-server tools execute out of process through
              // `.mcp.json`, bypassing `allTools`. runHarnessTurn adds a
              // per-turn correlation header and bridges actionable challenges
              // from adapter-http back into this chat stream. Host-executed
              // harness tools remain covered by the wrapper above.
              // LOCAL-MCP plane: this is an /api/mcp request (desktop), so the
              // harness reaches the private inspector via a tunnel landing on
              // adapter-http (the persistent singleton manager).
              harnessMcpProxy: { plane: "local-mcp" as const },
              // Multi-turn continuity: runHarnessTurn claims the harnessSessions
              // lane from the chat OWNER (chatSessionId + sourceType). The web
              // route threads these via streamWebChatTurn's persist; this route
              // calls the handler directly, so without them the continuity gate
              // is skipped and every harness turn starts a fresh (amnesiac)
              // Claude Code session. Scoped to the harness branch — the emulated
              // path persists via onConversationComplete and doesn't read these.
              ...(chatSessionId ? { chatSessionId } : {}),
              sourceType: chatSessionSourceType,
              ...(bodyScenarioId ? { scenarioId: bodyScenarioId } : {}),
            }
          : {}),
        // Server-executed built-ins forwarded separately so the harness path
        // can hand them to HarnessAgent (MCP-server tools arrive via .mcp.json).
        ...(builtInTools ? { builtInTools } : {}),
        // COMP-16: root the harness Shell at the configured working directory.
        ...(harnessComputerWorkdir
          ? { computerWorkdir: harnessComputerWorkdir }
          : {}),
        projectId: body.projectId,
        // Phase 3: thread the runtime-config execution scope into the harness
        // path (sandbox reserve, skills, broker, session-state, commit).
        ...(executionScope ? { executionScope } : {}),
        abortSignal: inboundAbortSignalMcp,
        onConversationComplete: chatSessionId
          ? async (fullHistory, turnTrace, harnessSessionCommit) => {
              // Returned so the engine can stream the turn's persist receipt.
              return await persistChatSessionToConvex({
                chatSessionId,
                modelId: String(modelDefinition.id),
                modelSource: "mcpjam",
                sourceType: chatSessionSourceType,
                origin: chatSessionOrigin,
                ...(!isScenarioSession && body.rewind
                  ? { rewind: body.rewind }
                  : {}),
                ...(chatSessionSurface ? { surface: chatSessionSurface } : {}),
                ...(bodyScenarioId ? { scenarioId: bodyScenarioId } : {}),
                authHeader,
                sessionMessages: stampSenderUserIdsOnSessionMessages(
                  fullHistory,
                  messages,
                  { authenticatedUserId },
                ),
                startedAt: sessionStartedAt,
                lastActivityAt: Date.now(),
                // §3: chat-backed harness resume-state commit, applied
                // atomically with the transcript inside the ingest mutation
                // (matches the web route). Absent on non-harness turns.
                ...(harnessSessionCommit ? { harnessSessionCommit } : {}),
                ...(body.projectId ? { projectId: body.projectId } : {}),
                ...(isScenarioSession
                  ? {}
                  : {
                      directVisibility: body.directVisibility,
                      resumeConfig: {
                        systemPrompt,
                        temperature,
                        requireToolApproval,
                        respectToolVisibility,
                        modelVisibleMcpToolResults,
                        mcpToolResultImageRendering,
                        selectedServers,
                      },
                      ...(directHostConfig
                        ? { hostConfig: directHostConfig }
                        : {}),
                    }),
                expectedVersion: body.expectedVersion,
                turnTrace,
                forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
              });
            }
          : undefined,
      });
    }

    // Org BYOK: when Convex is reachable, the request carries a projectId,
    // and the caller hasn't supplied a client-side apiKey, use the org's
    // Convex config. Cloud runtime stays in Convex; local runtime resolves a
    // scoped provider config and executes in this inspector.
    if (
      process.env.CONVEX_HTTP_URL &&
      typeof body.projectId === "string" &&
      body.projectId &&
      !apiKey
    ) {
      const providerKeyResult = deriveOrgProviderKey(modelDefinition);
      if (!providerKeyResult.ok) {
        return c.json({ error: providerKeyResult.error }, 400);
      }
      const providerKey = providerKeyResult.key;
      const modelMessages = scrubMessages(
        await convertToMcpjamModelMessages(
          messages,
          inboundMcpToolResultModelOutputOptions,
        ),
      );
      const sessionStartedAt = Date.now();
      const chatSessionId = body.chatSessionId;
      const modelId = String(modelDefinition.id);
      const inboundAbortSignalOrg = c.req.raw.signal as AbortSignal | undefined;
      warnIfChatAbortSignalMissing(inboundAbortSignalOrg, "mcp/chat-v2");
      // When a selected MCP server is local-only (stdio / localhost / private
      // IP), the tool loop must run in THIS inspector process — only it can
      // reach that server. Force the CLOUD runtime so the org key stays in
      // Convex and the model call is proxied through /stream/org; the tool loop
      // still executes locally against the local MCP connection. Without this,
      // a local-eligible provider would resolve to the "local" runtime and pull
      // the org key onto this machine, which org BYOK must never do.
      const localMcpRuntimeRequired = body.localMcpRuntimeRequired === true;
      const runtime: OrgProviderRuntime =
        !localMcpRuntimeRequired && isLocalRuntimeEligible(providerKey)
          ? await resolveOrgProviderRuntime(
              body.projectId,
              providerKey,
              modelId,
              {
                authHeader: requestAuthHeader,
                scenarioId: bodyScenarioId,
                accessVersion: bodyAccessVersion,
                serverIds: hostConfigServerIds,
              },
            )
          : { runtimeLocation: "cloud", providerKey };
      const onConversationComplete = chatSessionId
        ? async (
            fullHistory: ModelMessage[],
            turnTrace: PersistedTurnTrace,
          ) => {
            // Returned so the rail can stream the turn's persist receipt.
            return await persistChatSessionToConvex({
              chatSessionId,
              modelId,
              modelSource:
                runtime.runtimeLocation === "local" ? "local_byok" : "byok",
              sourceType: chatSessionSourceType,
              origin: chatSessionOrigin,
              ...(!isScenarioSession && body.rewind
                ? { rewind: body.rewind }
                : {}),
              ...(chatSessionSurface ? { surface: chatSessionSurface } : {}),
              ...(bodyScenarioId ? { scenarioId: bodyScenarioId } : {}),
              authHeader: requestAuthHeader,
              sessionMessages: stampSenderUserIdsOnSessionMessages(
                fullHistory,
                messages,
                { authenticatedUserId },
              ),
              startedAt: sessionStartedAt,
              lastActivityAt: Date.now(),
              projectId: body.projectId,
              ...(isScenarioSession
                ? {}
                : {
                    directVisibility: body.directVisibility,
                    resumeConfig: {
                      systemPrompt,
                      temperature,
                      requireToolApproval,
                      respectToolVisibility,
                      modelVisibleMcpToolResults,
                      mcpToolResultImageRendering,
                      selectedServers,
                    },
                    ...(directHostConfig
                      ? { hostConfig: directHostConfig }
                      : {}),
                  }),
              expectedVersion: body.expectedVersion,
              turnTrace,
              forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
            });
          }
        : undefined;

      if (runtime.runtimeLocation === "local") {
        return handleLocalOrgChatModel({
          provider: runtime.provider,
          failureReporter: createRequestStreamFailureReporter(c, "chat"),
          projectId: body.projectId,
          modelId,
          chatSessionId,
          sourceType: chatSessionSourceType,
          messages: modelMessages,
          systemPrompt: effectiveEnhancedSystemPrompt,
          temperature: resolvedTemperature,
          tools: allTools as ToolSet,
          progressivePlan,
          discoveryState,
          authHeader: requestAuthHeader,
          scenarioId: bodyScenarioId,
          accessVersion: bodyAccessVersion,
          selectedServers,
          serverIds: hostConfigServerIds,
          requireToolApproval,
          scopeStepUpResume: scopeStepUpEngineResume,
          shouldPauseAfterStep: () =>
            suspendedScopeStepUpToolCallId !== undefined,
          suspendedToolCallId: () => suspendedScopeStepUpToolCallId,
          abortSignal: inboundAbortSignalOrg,
          onConversationComplete,
          // Every dispatch path with a tasks seam must attach the bridge
          // before the first tool call can fire — the sink dispatches
          // synchronously from the tool loop, so a missing attach means the
          // bridge warn-drops the task-created part and the task is orphaned
          // (see `server/utils/web-chat-turn.ts`).
          onStreamWriterReady: (writer: {
            write: (chunk: UIMessageChunk) => void;
          }) => {
            scopeChallengeWriter = writer;
            taskCreatedBridge?.attachStreamWriter(writer);
          },
        });
      }

      return handleHostedOrgChatModel({
        projectId: body.projectId,
        failureReporter: createRequestStreamFailureReporter(c, "chat"),
        providerKey,
        modelId,
        messages: modelMessages,
        systemPrompt: effectiveEnhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader: requestAuthHeader,
        clientIp: getClientIp(c),
        mcpClientManager,
        selectedServers,
        serverIds: hostConfigServerIds,
        requireToolApproval,
        modelVisibleMcpToolResults,
        scopeStepUpResume: scopeStepUpEngineResume,
        abortSignal: inboundAbortSignalOrg,
        onConversationComplete,
        // Same invariant as the local-org call above: attach the bridge
        // before the first tool call, or created tasks are orphaned.
        onStreamWriterReady: (writer: {
          write: (chunk: UIMessageChunk) => void;
        }) => {
          scopeChallengeWriter = writer;
          taskCreatedBridge?.attachStreamWriter(writer);
        },
      });
    }

    // BYOK is organization-based: cloud provider keys come from the org's
    // Convex config, never from a client-supplied apiKey. On a Convex-attached
    // deployment the only supported cloud paths are MCPJam-provided models and
    // org BYOK (projectId, no apiKey) — both handled above. So a request that
    // still carries a client apiKey for a CLOUD provider is a personal-BYOK
    // attempt we don't support; reject it regardless of the caller's identity.
    //
    // Ollama (local daemon, "local" placeholder apiKey) and `custom`
    // (self-hosted OpenAI-compatible endpoints) are exempt — they're local /
    // self-hosted, not a shared cloud account, and the org surface doesn't
    // model them. Local OSS (no CONVEX_HTTP_URL) is exempt too; the frontend
    // hook is the only enforcement on `npx`.
    const isCloudByokProvider =
      modelDefinition.provider !== "ollama" &&
      modelDefinition.provider !== "custom";
    if (process.env.CONVEX_HTTP_URL && isCloudByokProvider && apiKey) {
      return c.json(
        {
          error:
            "Personal provider keys aren't supported. Configure cloud models in your organization's settings (Organization Models).",
          code: "personal_byok_unsupported",
        },
        401,
      );
    }

    // User-provided models: direct streamText
    const llmModel = createLlmModel(
      modelDefinition,
      apiKey ?? "",
      {
        ollama: body.ollamaBaseUrl,
        azure: body.azureBaseUrl,
      },
      body.customProviders,
    );

    const modelMessages = await convertToMcpjamModelMessages(
      messages,
      inboundMcpToolResultModelOutputOptions,
    );

    const streamStartedAt = Date.now();
    const authHeader = c.req.header("authorization");
    const chatSessionId = body.chatSessionId;
    const inboundAbortSignalDirect = c.req.raw.signal as
      AbortSignal | undefined;
    warnIfChatAbortSignalMissing(inboundAbortSignalDirect, "mcp/chat-v2");

    const scrubbedModelMessages = scrubMessages(
      modelMessages as ModelMessage[],
    );

    return streamDirectChatWithLiveTrace({
      llmModel,
      modelId: String(modelDefinition.id),
      ...(chatSessionId ? { chatSessionId } : {}),
      // Server-side model definitions always carry a concrete provider (the
      // widened `string` branch on ModelDefinition.provider is a client
      // catalog concern), so narrowing back to ModelProvider here is safe.
      provider: modelDefinition.provider as ModelProvider,
      messageHistory: [...scrubbedModelMessages],
      systemPrompt: effectiveEnhancedSystemPrompt,
      temperature: resolvedTemperature,
      tools: allTools as ToolSet,
      progressivePlan,
      discoveryState,
      scopeStepUpResume: scopeStepUpEngineResume,
      shouldPauseAfterStep: () => suspendedScopeStepUpToolCallId !== undefined,
      suspendedToolCallId: () => suspendedScopeStepUpToolCallId,
      abortSignal: inboundAbortSignalDirect,
      // Same invariant as the org-BYOK calls above: attach the bridge before
      // the first tool call, or created tasks are orphaned.
      onStreamWriterReady: (writer: {
        write: (chunk: UIMessageChunk) => void;
      }) => {
        scopeChallengeWriter = writer;
        taskCreatedBridge?.attachStreamWriter(writer);
      },
      onPersist: chatSessionId
        ? async ({
            responseMessages,
            assistantText,
            toolCalls,
            toolResults,
            usage,
            finishReason,
            turnTrace,
          }) => {
            const persistedUsage = toPersistedUsage(usage);
            // Returned so the rail can stream the turn's persist receipt.
            return await persistChatSessionToConvex({
              chatSessionId,
              modelId: String(modelDefinition.id),
              modelSource: "byok",
              sourceType: chatSessionSourceType,
              origin: chatSessionOrigin,
              ...(!isScenarioSession && body.rewind
                ? { rewind: body.rewind }
                : {}),
              ...(chatSessionSurface ? { surface: chatSessionSurface } : {}),
              ...(bodyScenarioId ? { scenarioId: bodyScenarioId } : {}),
              messages: stampSenderUserIdsOnSessionMessages(
                modelMessages as ModelMessage[],
                messages,
                { authenticatedUserId },
              ),
              systemPrompt: enhancedSystemPrompt,
              ...(responseMessages.length > 0 ? { responseMessages } : {}),
              assistantText,
              toolCalls,
              toolResults,
              ...(persistedUsage ? { usage: persistedUsage } : {}),
              finishReason,
              authHeader,
              startedAt: streamStartedAt,
              lastActivityAt: Date.now(),
              ...(body.projectId ? { projectId: body.projectId } : {}),
              ...(isScenarioSession
                ? {}
                : {
                    directVisibility: body.directVisibility,
                    resumeConfig: {
                      systemPrompt,
                      temperature,
                      requireToolApproval,
                      respectToolVisibility,
                      modelVisibleMcpToolResults,
                      mcpToolResultImageRendering,
                      selectedServers,
                    },
                    ...(directHostConfig
                      ? { hostConfig: directHostConfig }
                      : {}),
                  }),
              expectedVersion: body.expectedVersion,
              turnTrace,
              forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
            });
          }
        : undefined,
    });
  } catch (error) {
    // This catch wraps MCPJam's OWN request handling — config resolution,
    // backend dispatch, stream setup — not a hop into the user's MCP server,
    // so an unrecognized throw here is ours by default and the boundary
    // declaration says so. Without it, `internal/unknown` classifies
    // `ambiguous` and this route would go quiet in Sentry.
    const { origin } = reportRouteFailureForResponse(
      "[mcp/chat-v2] failed to process chat request",
      error,
      { source: "mcp.chat-v2.request", hop: "mcpjam_internal" },
    );
    // Also a HEADER, not just the body. By the time the failure reaches the
    // client's reporter the Response is gone — the AI SDK throws
    // `new Error(await response.text())` — so the body's `origin` is
    // unreachable without re-reading a consumed stream. The header is captured
    // alongside the status in `ChatResponseMeta`, which is what stops the
    // client's "our route answered 5xx, so it's ours" fallback from
    // overwriting a failure we just attributed to the user's server.
    return c.json({ error: "Unexpected error", origin }, 500, {
      "x-mcpjam-error-origin": origin,
    });
  }
});

export default chatV2;
