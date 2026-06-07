import {
  generateText,
  streamText,
  type ModelMessage,
  type Tool as AiTool,
  type ToolChoice,
  stepCountIs,
} from "ai";
import {
  evaluateMultiTurnResults,
  type EvaluationResult,
  type MultiTurnEvaluationResult,
  type UsageTotals,
} from "./evals/types";
import { buildIterationMetadata } from "./evals/iteration-metadata";
import { buildIterationUsageMetadata } from "./evals/iteration-usage-metadata";
import {
  applyVisibilityPolicyAndCountSignals,
  buildHostIterationMetadata,
  type HostExecutionPolicy,
  type ToolExposureSignals,
} from "@mcpjam/sdk/host-config/internal";
import {
  finalizePassedForEval,
  type MCPClientManager,
} from "@mcpjam/sdk";
import {
  createLlmModel,
  type BaseUrls,
  type CustomProviderConfig,
} from "../utils/chat-helpers";
import { logger } from "../utils/logger";
import { captureMcpAppWidgetSnapshots } from "../utils/mcp-app-widget-capture";
import {
  buildLlmRuntimeConfigFromOrgConfig,
  deriveOrgProviderKey,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntimeForTarget,
  type ResolveOrgModelConfigTarget,
  type ResolvedOrgModelConfig,
} from "../utils/org-model-config";
import {
  getCanonicalModelId,
  getModelById,
  isMCPJamProvidedModel,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import { z } from "zod";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import {
  buildIterationTranscript,
  evaluatePredicates,
} from "@/shared/eval-matching";
import type { ConvexHttpClient } from "convex/browser";
import {
  createSuiteRunRecorder,
  type SuiteRunRecorder,
} from "./evals/recorder";
import {
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  wrapBackendToolsForTrace,
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "./evals/eval-trace-capture";
import type {
  EvalTraceBlobV1,
  EvalTraceSpan,
  PromptTraceSummary,
  EvalTraceWidgetSnapshot,
} from "@/shared/eval-trace";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import {
  deriveLegacyPromptFields,
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PromptTurn,
} from "@/shared/prompt-turns";
import { withHostContextSystemPrompt } from "@/shared/host-context-prompt";
import { normalizeToolChoice, type EvalToolChoice } from "@/shared/tool-choice";
import {
  prepareChatV2,
  type PrepareChatV2Result,
} from "../utils/chat-v2-orchestration.js";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "./evals/persist-eval-trace.js";
import type {
  EvalStreamEvent,
  EvalStreamToolCall,
} from "@/shared/eval-stream-events";

/**
 * Turn a non-OK backend stream response into a human-readable message. The
 * Convex stream endpoint returns structured JSON for guardrails like the daily
 * spend cap — e.g. { code: "user_rate_limit", error: "Daily MCPJam model limit
 * reached. Use BYOK or try again tomorrow.", details: "Try again in N minutes." }.
 * Surface that instead of the bare HTTP status text ("Too Many Requests"), and
 * flag 429s as expected guardrails (not faults) so callers can log them quietly.
 */
function describeBackendStreamError(
  status: number,
  bodyText: string,
): { message: string; code?: string; expected: boolean } {
  const expected = status === 429;
  try {
    const body = JSON.parse(bodyText) as {
      code?: string;
      error?: string;
      details?: string;
    };
    if (body?.error) {
      const message = body.details
        ? `${body.error} ${body.details}`
        : body.error;
      return { message, code: body.code, expected };
    }
  } catch {
    // body wasn't JSON — fall through to the generic shape
  }
  return { message: `Backend stream error: ${status} ${bodyText}`, expected };
}

export type EvalTestCase = {
  title: string;
  query: string;
  runs: number;
  model: string;
  provider: string;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  expectedOutput?: string;
  promptTurns?: PromptTurn[];
  advancedConfig?: {
    system?: string;
    temperature?: number;
    toolChoice?: EvalToolChoice | string;
  } & Record<string, unknown>;
  /**
   * Effective per-iteration match options. Suite-level runs receive this
   * pre-resolved from Convex `precreateIterationsForRun`; single-case
   * runs resolve it in the route handler.
   */
  matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
  /**
   * Optional state-based predicate gate evaluated over the iteration
   * transcript after tool-call matching. Definitions are runtime/corpus data
   * in V1 (carried on the case object through the runner, like `matchOptions`);
   * verdicts are persisted to `testIteration.metadata.predicates`. A case
   * passes the predicate gate iff every predicate passes; an absent/empty list
   * is no gate. See `shared/predicates`.
   */
  successPredicates?: import("@/shared/eval-matching").Predicate[];
  /**
   * Per-Run override layered on top of the suite's hostConfig. Carries
   * the editor's in-place tweaks (locale, timezone, hostContext,
   * hostCapabilitiesOverride, hostStyle, etc.) for this iteration only.
   * NOT a property of the test case — present on this type only because
   * it rides alongside the case through the runner, the same way
   * `matchOptions` does. Stamped onto `testCaseSnapshot.hostConfigOverride`
   * for the iteration row. Single-case runs populate it from the
   * request; suite runs leave it undefined.
   */
  hostConfigOverride?: Record<string, unknown>;
  testCaseId?: string;
};

export type RunEvalSuiteOptions = {
  suiteId: string;
  runId: string | null; // null for quick runs
  config: {
    tests: EvalTestCase[];
    environment: {
      /**
       * Legacy display/compat refs. These may be friendly names, not
       * connected server identities; preserve serverBindings with any
       * snapshotted environment before resolving tools for execution.
       */
      servers: string[];
      serverBindings?: Array<{
        serverName: string;
        projectServerId?: string;
      }>;
    };
  };
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexClient: ConvexHttpClient;
  convexHttpUrl: string;
  convexAuthToken: string;
  mcpClientManager: MCPClientManager;
  recorder?: SuiteRunRecorder | null;
  testCaseId?: string; // For quick runs, associate iterations with a specific test case
  compareRunId?: string; // For quick compare runs, group related iterations in metadata
  /**
   * Resolved compat-runtime flag for the suite's host config. When
   * true, widget snapshots captured during this run will have the
   * OpenAI Apps SDK `window.openai` shim injected before they're
   * persisted. Default `false` — caller (route handler) resolves
   * from the suite's `mcpProfile.apps.compatRuntime` + `hostStyle`
   * preset. Absent/undefined preserves SEP-1865 honest behavior.
   */
  suiteInjectOpenAiCompat?: boolean;
  /**
   * Host execution policy extracted from the run's hostConfig snapshot.
   * When present, the runner applies visibility filtering, computes tool
   * exposure signals, and stamps scalar metadata on each iteration for the
   * cross-host dashboard.
   */
  hostExecutionPolicy?: HostExecutionPolicy;
};

/** One executed iteration inside a suite/quick run (evaluation + optional persisted iteration id). */
export type EvalIterationOutcome = {
  evaluation: EvaluationResult;
  iterationId?: string;
};

/**
 * True when the provider/backend actually reported token usage. `accumulatedUsage`
 * is initialized to a zero object, so a zero total is indistinguishable from
 * "unmetered" — passing that into the transcript would let `tokenBudgetUnder`
 * pass on runs with no usage data. Only forward usage when something was
 * reported so the predicate can fail closed otherwise.
 */
function hasReportedUsage(usage: UsageTotals): boolean {
  return (
    (usage.totalTokens ?? 0) > 0 ||
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0
  );
}

export type RunEvalSuiteWithAiSdkResult = {
  /** Only set when `runId === null` (quick run); one entry per (test × run index) in suite order. */
  quickRunIterationOutcomes?: EvalIterationOutcome[];
};

const MAX_STEPS = 20;

type ToolSet = Record<string, any>;
type ToolCall = { toolName: string; arguments: Record<string, any> };
type TraceSnapshotKind = "step_finish" | "turn_finish" | "failure";

function resolveConfiguredServerIds(args: {
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined;
  mcpClientManager: MCPClientManager;
}): string[] {
  const configuredServerRefs = args.environment?.servers ?? [];
  if (configuredServerRefs.length === 0) {
    return [];
  }

  const availableServerIds = args.mcpClientManager.listServers();
  if (availableServerIds.length === 0) {
    return configuredServerRefs;
  }

  const availableServerIdsSet = new Set(availableServerIds);
  const availableServerIdByLowercase = new Map(
    availableServerIds.map((serverId) => [serverId.toLowerCase(), serverId]),
  );
  const projectServerIdByName = new Map<string, string>();
  const serverNameByProjectServerId = new Map<string, string>();

  for (const binding of args.environment?.serverBindings ?? []) {
    if (typeof binding.serverName !== "string") {
      continue;
    }
    const serverName = binding.serverName.trim();
    const projectServerId =
      typeof binding.projectServerId === "string"
        ? binding.projectServerId.trim()
        : "";
    if (!serverName || !projectServerId) {
      continue;
    }
    projectServerIdByName.set(serverName.toLowerCase(), projectServerId);
    serverNameByProjectServerId.set(projectServerId.toLowerCase(), serverName);
  }

  const resolvedServerIds: string[] = [];
  const seen = new Set<string>();

  for (const serverRef of configuredServerRefs) {
    if (typeof serverRef !== "string") {
      continue;
    }
    const trimmedServerRef = serverRef.trim();
    if (!trimmedServerRef) {
      continue;
    }

    const normalizedServerId =
      availableServerIdsSet.has(trimmedServerRef)
        ? trimmedServerRef
        : availableServerIdByLowercase.get(trimmedServerRef.toLowerCase()) ??
          (() => {
            const projectServerId = projectServerIdByName.get(
              trimmedServerRef.toLowerCase(),
            );
            if (projectServerId) {
              return (
                (availableServerIdsSet.has(projectServerId)
                  ? projectServerId
                  : undefined) ??
                availableServerIdByLowercase.get(projectServerId.toLowerCase())
              );
            }

            const serverName = serverNameByProjectServerId.get(
              trimmedServerRef.toLowerCase(),
            );
            if (serverName) {
              return (
                (availableServerIdsSet.has(serverName) ? serverName : undefined) ??
                availableServerIdByLowercase.get(serverName.toLowerCase())
              );
            }

            return undefined;
          })() ??
          trimmedServerRef;

    if (seen.has(normalizedServerId)) {
      continue;
    }
    seen.add(normalizedServerId);
    resolvedServerIds.push(normalizedServerId);
  }

  return resolvedServerIds;
}

type ResolvedEvalTestCase = {
  promptTurns: PromptTurn[];
  query: string;
  expectedToolCalls: ToolCall[];
  expectedOutput?: string;
  advancedConfig?: Record<string, unknown>;
};

function resolveEvalTestCase(test: EvalTestCase): ResolvedEvalTestCase {
  const promptTurns = resolvePromptTurns(test);
  const legacy = deriveLegacyPromptFields(promptTurns);
  return {
    promptTurns,
    query: legacy.query,
    expectedToolCalls: legacy.expectedToolCalls,
    expectedOutput: legacy.expectedOutput,
    advancedConfig: stripPromptTurnsFromAdvancedConfig(test.advancedConfig),
  };
}

function buildPromptTraceSummaries(
  evaluation: MultiTurnEvaluationResult,
): PromptTraceSummary[] {
  return evaluation.promptSummaries.map((summary) => ({
    promptIndex: summary.promptIndex,
    prompt: summary.prompt,
    expectedToolCalls: summary.expectedToolCalls,
    actualToolCalls: summary.actualToolCalls,
    expectedOutput: summary.expectedOutput,
    passed: summary.passed,
    missing: summary.missing,
    unexpected: summary.unexpected,
    argumentMismatches: summary.argumentMismatches.map((mismatch) => {
      const mismatchedArguments = new Set<string>([
        ...Object.keys(mismatch.expectedArgs ?? {}),
        ...Object.keys(mismatch.actualArgs ?? {}),
      ]);

      return {
        expected: {
          toolName: mismatch.toolName,
          arguments: mismatch.expectedArgs,
        },
        actual: {
          toolName: mismatch.toolName,
          arguments: mismatch.actualArgs,
        },
        mismatchedArguments: Array.from(mismatchedArguments).filter(
          (key) =>
            JSON.stringify(mismatch.expectedArgs?.[key]) !==
            JSON.stringify(mismatch.actualArgs?.[key]),
        ),
      };
    }),
  }));
}

function extractToolCallsFromConversation(params: {
  steps?: ReadonlyArray<any>;
  messages: ModelMessage[];
}): ToolCall[] {
  const toolsCalled: ToolCall[] = [];

  if (params.steps && Array.isArray(params.steps)) {
    for (const step of params.steps) {
      const stepToolCalls = (step as any).toolCalls || [];
      for (const call of stepToolCalls) {
        if (call?.toolName || call?.name) {
          toolsCalled.push({
            toolName: call.toolName ?? call.name,
            arguments: call.args ?? call.input ?? {},
          });
        }
      }
    }
  }

  for (const msg of params.messages) {
    if (msg?.role === "assistant" && Array.isArray((msg as any).content)) {
      for (const item of (msg as any).content) {
        if (item?.type === "tool-call") {
          const name = item.toolName ?? item.name;
          if (name) {
            const argumentsValue =
              item.input ?? item.parameters ?? item.args ?? {};
            const alreadyAdded = toolsCalled.some(
              (toolCall) =>
                toolCall.toolName === name &&
                JSON.stringify(toolCall.arguments) ===
                  JSON.stringify(argumentsValue),
            );
            if (!alreadyAdded) {
              toolsCalled.push({
                toolName: name,
                arguments: argumentsValue,
              });
            }
          }
        }
      }
    }

    if (msg?.role === "assistant" && Array.isArray((msg as any).toolCalls)) {
      for (const call of (msg as any).toolCalls) {
        if (call?.toolName || call?.name) {
          const toolName = call.toolName ?? call.name;
          const argumentsValue = call.args ?? call.input ?? {};
          const alreadyAdded = toolsCalled.some(
            (toolCall) =>
              toolCall.toolName === toolName &&
              JSON.stringify(toolCall.arguments) ===
                JSON.stringify(argumentsValue),
          );
          if (!alreadyAdded) {
            toolsCalled.push({
              toolName,
              arguments: argumentsValue,
            });
          }
        }
      }
    }
  }

  return toolsCalled;
}

function toolCallIdentity(toolCall: ToolCall): string {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.arguments ?? {})}`;
}

function mergeToolCalls(
  existingToolCalls: ToolCall[],
  incomingToolCalls: ToolCall[],
): ToolCall[] {
  const seen = new Set(existingToolCalls.map(toolCallIdentity));
  const merged = [...existingToolCalls];

  for (const toolCall of incomingToolCalls) {
    const identity = toolCallIdentity(toolCall);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    merged.push(toolCall);
  }

  return merged;
}

function appendPartialToolCallsToPrompt(params: {
  toolsCalledByPrompt: ToolCall[][];
  promptIndex: number;
  partialResponseMessages: ModelMessage[];
}) {
  if (params.promptIndex < 0 || params.partialResponseMessages.length === 0) {
    return;
  }

  const partialToolCalls = extractToolCallsFromConversation({
    messages: params.partialResponseMessages,
  });
  if (partialToolCalls.length === 0) {
    return;
  }

  const existingToolCalls = Array.isArray(
    params.toolsCalledByPrompt[params.promptIndex],
  )
    ? params.toolsCalledByPrompt[params.promptIndex]!
    : [];

  params.toolsCalledByPrompt[params.promptIndex] = mergeToolCalls(
    existingToolCalls,
    partialToolCalls,
  );
}

function toStreamToolCalls(toolCalls: ToolCall[]): EvalStreamToolCall[] {
  return toolCalls.map((toolCall) => ({
    toolName: toolCall.toolName,
    arguments: toolCall.arguments,
  }));
}

/**
 * Parse the backend's UI Message Stream (SSE format produced by
 * `toUIMessageStreamResponse()` in AI SDK v6) into chunk objects.
 *
 * Wire format: `data: <JSON>\n\n` per event, terminated by `data: [DONE]\n\n`.
 */
async function* parseBackendUIMessageSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            /* ignore malformed JSON */
          }
        }
      }
    }
    // Flush remaining buffer
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function buildTraceSnapshotEvent(params: {
  turnIndex: number;
  stepIndex?: number;
  snapshotKind: TraceSnapshotKind;
  messages: ModelMessage[];
  spans: EvalTraceSpan[];
  usage: UsageTotals;
  actualToolCalls: ToolCall[];
  prompts?: PromptTraceSummary[];
}): Extract<EvalStreamEvent, { type: "trace_snapshot" }> {
  const trace: EvalTraceBlobV1 = {
    traceVersion: 1,
    messages: params.messages,
    ...(params.spans.length > 0 ? { spans: params.spans } : {}),
    ...(params.prompts && params.prompts.length > 0
      ? { prompts: params.prompts }
      : {}),
  };

  return {
    type: "trace_snapshot",
    turnIndex: params.turnIndex,
    ...(typeof params.stepIndex === "number"
      ? { stepIndex: params.stepIndex }
      : {}),
    snapshotKind: params.snapshotKind,
    trace: sanitizeForConvexTransport(trace),
    actualToolCalls: sanitizeForConvexTransport(
      toStreamToolCalls(params.actualToolCalls),
    ),
    usage: {
      inputTokens: params.usage.inputTokens ?? 0,
      outputTokens: params.usage.outputTokens ?? 0,
      totalTokens: params.usage.totalTokens ?? 0,
    },
  };
}

// Helper to create iteration directly (for quick runs without a recorder)
async function createIterationDirectly(
  convexClient: ConvexHttpClient,
  params: {
    testCaseId?: string;
    testCaseSnapshot: {
      title: string;
      query: string;
      provider: string;
      model: string;
      runs?: number;
      expectedToolCalls: any[];
      expectedOutput?: string;
      promptTurns?: PromptTurn[];
      advancedConfig?: Record<string, unknown>;
      matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
    };
    iterationNumber: number;
    startedAt: number;
  },
): Promise<string | undefined> {
  try {
    const result = await convexClient.mutation(
      "testSuites:recordIterationStartWithoutRun" as any,
      {
        testCaseId: params.testCaseId,
        testCaseSnapshot: sanitizeForConvexTransport(params.testCaseSnapshot),
        iterationNumber: params.iterationNumber,
        startedAt: params.startedAt,
      },
    );

    return result?.iterationId as string | undefined;
  } catch (error) {
    logger.error("[evals] Failed to create iteration:", error);
    return undefined;
  }
}

// Helper to finish iteration directly (for quick runs without a recorder)
async function finishIterationDirectly(
  convexClient: ConvexHttpClient,
  params: {
    iterationId?: string;
    passed: boolean;
    toolsCalled: Array<{ toolName: string; arguments: Record<string, any> }>;
    usage: UsageTotals;
    messages: ModelMessage[];
    spans?: EvalTraceSpan[];
    prompts?: PromptTraceSummary[];
    widgetSnapshots?: EvalTraceWidgetSnapshot[];
    status?: "completed" | "failed" | "cancelled";
    startedAt?: number;
    error?: string;
    errorDetails?: string;
    resultSource?: "reported" | "derived";
    metadata?: Record<string, string | number | boolean>;
  },
): Promise<void> {
  if (!params.iterationId) return;

  // Check if iteration was cancelled before trying to update
  try {
    const iteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId: params.iterationId },
    );
    if (iteration?.status === "cancelled") {
      logger.debug(
        "[evals] Skipping update for cancelled iteration:",
        params.iterationId,
      );
      return;
    }
  } catch (error) {
    // If we can't check status, continue anyway
  }

  const iterationStatus =
    params.status ?? (params.passed ? "completed" : "failed");
  const result = params.passed ? "passed" : "failed";

  // PR-2 eval→chatSessions fanout. Mirrors recorder.finishIteration —
  // see persist-eval-trace.ts for the contract. Fanout writes per-turn
  // rows BEFORE updateTestIteration; the chatSessions lock fires AFTER
  // updateTestIteration succeeds (PR-2 review fix #2). When the
  // backend flag is off, today's legacy behavior runs unchanged.
  // lockReason describes the transcript LIFECYCLE, not the verdict —
  // see recorder.ts for the full rationale. A failed-verdict iteration
  // that ran cleanly still gets eval_completed; eval_failed is reserved
  // for cycle failures (provider errors, transport crashes, etc.).
  //
  // The `params.error` check covers a runner quirk (Codex review on
  // #2446): some backend eval paths set `iterationError` but still
  // pass `status: "completed"` to finishIteration (see
  // evals-runner.ts:2079-2082 / :3962-3965). Treating those as
  // eval_completed would lock an error transcript with the wrong reason.
  const isCycleFailure =
    iterationStatus === "failed" ||
    (params.error !== undefined && params.error !== "");
  const terminalReason: "eval_completed" | "eval_failed" | "eval_cancelled" =
    iterationStatus === "cancelled"
      ? "eval_cancelled"
      : isCycleFailure
        ? "eval_failed"
        : "eval_completed";
  const fanout = await persistEvalTraceFanout({
    convexClient,
    iterationId: params.iterationId,
    iterationStartedAt: params.startedAt,
    messages: params.messages,
    spans: params.spans,
    prompts: params.prompts,
    widgetSnapshots: params.widgetSnapshots,
  });
  if (fanout?.persisted === false) {
    logger.warn(
      "[evals] persistEvalTraceFanout failed (quick run); falling back to forced-legacy-blob path",
      { iterationId: params.iterationId, error: fanout.error.message },
    );
  }
  const sendTraceFieldsToUpdate = fanout?.persisted !== true;
  // See recorder.ts for the rationale — same fallback escape hatch.
  const forceLegacyTraceBlob = fanout?.persisted === false;

  // PR-2 review #5 (Cursor "Update failure after successful fanout"):
  // track iteration-gone state so the lock can fire even when the
  // update throws a transient error. Mirrors recorder.finishIteration.
  let iterationGoneOrCancelled = false;
  try {
    await convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId: params.iterationId,
      result,
      status: iterationStatus,
      actualToolCalls: sanitizeForConvexTransport(params.toolsCalled),
      tokensUsed: params.usage.totalTokens ?? 0,
      ...(forceLegacyTraceBlob ? { forceLegacyTraceBlob: true } : {}),
      ...(sendTraceFieldsToUpdate
        ? {
            messages: sanitizeForConvexTransport(params.messages),
            ...(params.spans?.length
              ? { spans: sanitizeForConvexTransport(params.spans) }
              : {}),
            ...(params.prompts?.length
              ? { prompts: sanitizeForConvexTransport(params.prompts) }
              : {}),
            ...(params.widgetSnapshots?.length
              ? {
                  widgetSnapshots: sanitizeForConvexTransport(
                    params.widgetSnapshots,
                  ),
                }
              : {}),
          }
        : {}),
      error: params.error,
      errorDetails: params.errorDetails,
      resultSource: params.resultSource,
      // Merge user-provided metadata with token usage breakdown, then
      // sanitize: metadata can carry nested predicate rows whose authored
      // args may contain $-prefixed keys Convex rejects at the boundary.
      metadata: sanitizeForConvexTransport({
        ...(params.metadata ?? {}),
        ...buildIterationUsageMetadata(params.usage),
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Silently skip if iteration was deleted or cancelled
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("cancelled")
    ) {
      iterationGoneOrCancelled = true;
    } else {
      logger.error(
        "[evals] Failed to finish iteration:",
        new Error(errorMessage),
      );
      // Fall through to the lock step. See recorder.ts for the
      // rationale: chatSessions transcript is complete from the
      // fanout's perspective; locking prevents partial writes on a
      // retry. Iteration row's terminal status may stay stale until
      // a retry/cron sweep — acceptable because the chatSessions
      // layer is consistent.
    }
  }

  // Lock the chatSession when fanout succeeded. Runs in BOTH the
  // success branch and the transient-failure branch; skipped only
  // when the iteration is gone. Mirrors recorder.finishIteration's
  // pattern — see there for full rationale.
  if (
    fanout?.persisted === true &&
    params.iterationId &&
    !iterationGoneOrCancelled
  ) {
    await lockEvalSessionAfterUpdate({
      convexClient,
      iterationId: params.iterationId,
      reason: terminalReason,
    });
  }
}

/**
 * Persist a failed iteration row when iteration setup throws BEFORE the
 * per-prompt loop can start (e.g. `prepareChatV2` rejects on Anthropic
 * tool-name validation or meta-tool collisions). Used by the backend
 * runners, which lack the outer try/catch the AI-SDK runners have.
 */
async function persistSetupFailedIteration(args: {
  iterationId: string | undefined;
  runStartedAt: number;
  errorMessage: string;
  iterationMetadataBase: Record<string, string | number | boolean>;
  recorder: SuiteRunRecorder | null;
  convexClient: ConvexHttpClient;
}): Promise<void> {
  const failParams = {
    ...(args.iterationId ? { iterationId: args.iterationId } : {}),
    passed: false,
    toolsCalled: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    messages: [] as ModelMessage[],
    status: "failed" as const,
    startedAt: args.runStartedAt,
    error: args.errorMessage,
    resultSource: "reported" as const,
    metadata: { ...args.iterationMetadataBase },
  };
  if (args.recorder) {
    await args.recorder.finishIteration(failParams);
  } else {
    await finishIterationDirectly(args.convexClient, failParams);
  }
}

type RunIterationBaseParams = {
  test: EvalTestCase;
  runIndex: number;
  /**
   * Suite-level raw tool set, kept for `toolSignals` telemetry only.
   * Iteration runners route the actual tool prep through `prepareChatV2`
   * (per PR 1 of the engine consolidation) so eval gets skill tools,
   * progressive-discovery meta-tools, Anthropic name validation, and the
   * system-prompt assembly chat already applies. Removed in a later PR.
   */
  tools: ToolSet;
  /** Server ids the iteration runner hands to `prepareChatV2`. */
  selectedServers: string[];
  mcpClientManager: MCPClientManager;
  recorder: SuiteRunRecorder | null;
  testCaseId?: string;
  suiteId?: string;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexClient: ConvexHttpClient;
  runId: string | null; // For cancellation checks
  abortSignal?: AbortSignal; // For aborting in-flight requests
  compareRunId?: string;
  /**
   * If supplied, the runner skips the upfront `recordIterationStartWithoutRun`
   * call and reuses this id. Used by `streamTestCase` when `runs > 1` so all N
   * pending rows appear in the iteration history immediately, before iteration
   * #1 finishes.
   */
  precreatedIterationId?: string;
  /**
   * Suite-level resolved compat-runtime flag — propagated from
   * `RunEvalSuiteOptions.suiteInjectOpenAiCompat`. When true, widget
   * snapshots captured during this iteration get the OpenAI Apps SDK
   * `window.openai` shim injected before persistence. Default behavior
   * (absent/undefined or false) leaves snapshots un-shimmed.
   */
  injectOpenAiCompat?: boolean;
  /** Resolved host execution policy from the run's hostConfig snapshot. */
  hostPolicy?: HostExecutionPolicy;
  /** Pre-computed tool exposure signals for this run (set by runEvalSuiteWithAiSdk). */
  toolSignals?: ToolExposureSignals;
};

type RunIterationAiSdkParams = RunIterationBaseParams & {
  modelDefinition: ModelDefinition;
};

type RunIterationBackendParams = RunIterationBaseParams & {
  convexHttpUrl: string;
  convexAuthToken: string;
  modelId: string;
  /** Resolved model definition — fed to `prepareChatV2` for Anthropic name validation. */
  modelDefinition: ModelDefinition;
  endpointPath?: "/stream" | "/stream/org";
  extraBodyFields?: Record<string, unknown>;
};

function parseCustomProviderName(modelId: string): string | undefined {
  if (!modelId.startsWith("custom:")) return undefined;

  const [, providerName] = modelId.split(":");
  return providerName || undefined;
}

const buildModelDefinition = (test: EvalTestCase): ModelDefinition => {
  const supportedModel = getModelById(test.model);
  if (
    supportedModel &&
    supportedModel.provider.toLowerCase() === test.provider.toLowerCase()
  ) {
    return supportedModel;
  }

  const provider = test.provider as ModelProvider;
  return {
    id: test.model,
    name: test.title || String(test.model),
    provider,
    ...(provider === "custom"
      ? { customProviderName: parseCustomProviderName(test.model) }
      : {}),
  };
};

function lookupProviderApiKey(
  modelApiKeys: Record<string, string> | undefined,
  provider: string,
): string | undefined {
  return modelApiKeys?.[provider] ?? modelApiKeys?.[provider.toLowerCase()];
}

function hasBaseUrls(baseUrls: BaseUrls): boolean {
  return Boolean(baseUrls.ollama || baseUrls.azure);
}

function resolveEvalModelRuntime(args: {
  test: EvalTestCase;
  modelDefinition: ModelDefinition;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
}): {
  apiKey: string;
  baseUrls?: BaseUrls;
  customProviders?: CustomProviderConfig[];
} {
  const orgRuntime = args.orgModelConfig
    ? buildLlmRuntimeConfigFromOrgConfig(args.orgModelConfig)
    : undefined;
  const apiKey =
    lookupProviderApiKey(args.modelApiKeys, args.test.provider) ??
    lookupProviderApiKey(orgRuntime?.modelApiKeys, args.test.provider) ??
    "";

  const provider = args.modelDefinition.provider;
  if (!apiKey && provider !== "ollama" && provider !== "custom") {
    throw new Error(
      `Missing API key for provider ${args.test.provider} (test: ${args.test.title})`,
    );
  }

  return {
    apiKey,
    ...(orgRuntime?.baseUrls && hasBaseUrls(orgRuntime.baseUrls)
      ? { baseUrls: orgRuntime.baseUrls }
      : {}),
    ...(orgRuntime?.customProviders.length
      ? { customProviders: orgRuntime.customProviders }
      : {}),
  };
}

function hasExplicitModelApiKeys(
  modelApiKeys: Record<string, string> | undefined,
): boolean {
  return Boolean(modelApiKeys && Object.keys(modelApiKeys).length > 0);
}

function readBackendUsage(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const record =
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>)
      : {};
  const inputTokens =
    typeof record.inputTokens === "number"
      ? record.inputTokens
      : typeof record.promptTokens === "number"
        ? record.promptTokens
        : 0;
  const outputTokens =
    typeof record.outputTokens === "number"
      ? record.outputTokens
      : typeof record.completionTokens === "number"
        ? record.completionTokens
        : 0;
  const totalTokens =
    typeof record.totalTokens === "number" ? record.totalTokens : 0;
  return { inputTokens, outputTokens, totalTokens };
}

function resolveOrgTargetForEval(
  test: EvalTestCase,
  explicitTarget?: ResolveOrgModelConfigTarget,
): ResolveOrgModelConfigTarget | undefined {
  if (explicitTarget) return explicitTarget;
  const maybeProjectId = (test as { projectId?: unknown }).projectId;
  if (typeof maybeProjectId === "string" && maybeProjectId.trim()) {
    return { projectId: maybeProjectId.trim() };
  }
  return undefined;
}

async function resolveOrgByokEvalRuntime(args: {
  test: EvalTestCase;
  modelDefinition: ModelDefinition;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexAuthToken: string;
}): Promise<
  | {
      kind: "cloud";
      providerKey: string;
      target: ResolveOrgModelConfigTarget;
    }
  | {
      kind: "local";
      orgModelConfig: ResolvedOrgModelConfig;
    }
  | undefined
> {
  if (hasExplicitModelApiKeys(args.modelApiKeys)) return undefined;

  const providerKeyResult = deriveOrgProviderKey(args.modelDefinition);
  if (!providerKeyResult.ok) return undefined;

  const target = resolveOrgTargetForEval(args.test, args.orgModelConfigTarget);
  if (!target) return undefined;

  const providerKey = providerKeyResult.key;
  if (!isLocalRuntimeEligible(providerKey)) {
    return { kind: "cloud", providerKey, target };
  }

  if ("organizationId" in target) {
    return { kind: "cloud", providerKey, target };
  }

  const runtime = await resolveOrgProviderRuntimeForTarget(
    target,
    providerKey,
    String(args.modelDefinition.id),
    { bearerToken: args.convexAuthToken },
  );
  if (runtime.runtimeLocation === "cloud") {
    return { kind: "cloud", providerKey: runtime.providerKey, target };
  }

  return {
    kind: "local",
    orgModelConfig: { providers: [runtime.provider] },
  };
}

const runIterationWithAiSdk = async ({
  test,
  runIndex,
  // `tools` is the suite-level raw set kept for `toolSignals` telemetry;
  // this runner now goes through prepareChatV2 below for its actual tool prep.
  tools: _suiteTools,
  selectedServers,
  mcpClientManager,
  recorder,
  testCaseId,
  suiteId,
  modelDefinition,
  modelApiKeys,
  orgModelConfig,
  convexClient,
  runId,
  abortSignal,
  compareRunId,
  precreatedIterationId,
  injectOpenAiCompat,
  hostPolicy,
  toolSignals,
}: RunIterationAiSdkParams) => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      // If run not found, it was likely deleted - skip iteration
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    advancedConfig,
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
  } = resolvedTest;
  const system = withHostContextSystemPrompt(
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const modelRuntime = resolveEvalModelRuntime({
    test,
    modelDefinition,
    modelApiKeys,
    orgModelConfig,
  });

  const runStartedAt = Date.now();
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }
  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
      matchOptions: test.matchOptions,
      hostConfigOverride: test.hostConfigOverride,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
      ? await recorder.startIteration(iterationParams)
      : await createIterationDirectly(convexClient, iterationParams);

  // `conversationMessages` starts empty; the system message is pushed below
  // inside the try block, AFTER `prepareChatV2` (which can throw on Anthropic
  // name validation / meta-tool collisions / skill-tool prep). Building it
  // inside the try lets the catch path persist a failed iteration row.
  let conversationMessages: ModelMessage[] = [];
  const recordedSpans: EvalTraceSpan[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  let accumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let activePromptIndex = -1;
  let activePromptInputMessages: ModelMessage[] = [];
  let activePartialResponseMessages: ModelMessage[] = [];
  let activeCompletedStepCount = 0;
  let activeTraceCtx: ReturnType<typeof createAiSdkEvalTraceContext> | null =
    null;

  try {
    // Adopt the chat-side tool/system/temperature pipeline. Eval used to skip
    // this and call `getToolsForAiSdk` + an inline system/temperature wiring,
    // missing skill tools, Anthropic name validation, and skills-prompt
    // assembly. Called inside the try so prep failures become a recorded
    // failed iteration rather than an uncaught setup error.
    const prepared = await prepareChatV2({
      mcpClientManager,
      selectedServers,
      modelDefinition,
      systemPrompt: system,
      temperature,
      respectToolVisibility: hostPolicy?.respectToolVisibility,
      customProviders: modelRuntime.customProviders,
      priorMessages: [],
    });
    if (prepared.enhancedSystemPrompt) {
      conversationMessages.push({
        role: "system",
        content: prepared.enhancedSystemPrompt,
      });
    }

    const llmModel = createLlmModel(
      modelDefinition,
      modelRuntime.apiKey,
      modelRuntime.baseUrls,
      modelRuntime.customProviders,
    );

    if (
      toolChoice &&
      typeof toolChoice === "object" &&
      !Object.hasOwn(prepared.allTools, toolChoice.toolName)
    ) {
      throw new Error(
        `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`,
      );
    }

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      activePromptInputMessages = [
        ...conversationMessages,
        { role: "user", content: promptTurn.prompt },
      ];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;
      activeTraceCtx = createAiSdkEvalTraceContext(runStartedAt);
      const tracedTools = wrapToolSetForEvalTrace(
        prepared.allTools,
        activeTraceCtx,
        promptIndex,
      );

      const result = await generateText({
        model: llmModel,
        messages: activePromptInputMessages,
        tools: tracedTools,
        stopWhen: stepCountIs(20),
        ...(prepared.resolvedTemperature == null
          ? {}
          : { temperature: prepared.resolvedTemperature }),
        ...(toolChoice
          ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
          : {}),
        ...(abortSignal ? { abortSignal } : {}),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "evals.generateText",
          recordInputs: false,
          recordOutputs: false,
          metadata: {
            source: "evals",
            ...(suiteId ? { suiteId } : {}),
            ...(runId ? { runId } : {}),
            ...(testCaseId ? { testCaseId } : {}),
            ...(iterationId ? { iterationId } : {}),
            iterationNumber: runIndex + 1,
            provider: test.provider,
            model: test.model,
            promptIndex,
          },
        },
        prepareStep: ({ stepNumber }) => {
          registerAiSdkPrepareStep(activeTraceCtx!, stepNumber, {
            modelId: test.model,
            promptIndex,
          });
          return undefined;
        },
        onStepFinish: async (step) => {
          activeCompletedStepCount += 1;
          const stepFinishedAt = Date.now();
          const responseMessages = step.response?.messages ?? [];
          const responseMessageCountBeforeAppend =
            activePartialResponseMessages.length;
          const messageStartIndex =
            responseMessages.length > 0
              ? activePromptInputMessages.length +
                responseMessageCountBeforeAppend
              : undefined;
          appendDedupedModelMessages(
            activePartialResponseMessages,
            responseMessages as ModelMessage[],
          );
          const appendedMessageCount =
            activePartialResponseMessages.length -
            responseMessageCountBeforeAppend;
          const messageEndIndex =
            messageStartIndex != null && appendedMessageCount > 0
              ? messageStartIndex + appendedMessageCount - 1
              : undefined;
          emitAiSdkOnStepFinish(activeTraceCtx!, stepFinishedAt, {
            modelId: step.response?.modelId ?? test.model,
            inputTokens: step.usage?.inputTokens,
            outputTokens: step.usage?.outputTokens,
            totalTokens: step.usage?.totalTokens,
            messageStartIndex,
            messageEndIndex,
            status: "ok",
          });
        },
        onFinish: async () => {
          /* Final messages read from `result` after await; hook kept for symmetry with AI SDK lifecycle. */
        },
      });

      const finalMessagesRaw = result.response?.messages as
        | ModelMessage[]
        | undefined;
      const promptResponseMessages =
        finalMessagesRaw && finalMessagesRaw.length > 0
          ? finalMessagesRaw
          : activePartialResponseMessages;

      if (activeTraceCtx.recordedSpans.length > 0) {
        patchAiSdkRecordedSpansMessageRangesFromSteps(
          activeTraceCtx.recordedSpans,
          activePromptInputMessages.length,
          result.steps,
          promptIndex,
        );
      }

      const promptToolsCalled = extractToolCallsFromConversation({
        steps: result.steps,
        messages: promptResponseMessages,
      });
      toolsCalledByPrompt.push(promptToolsCalled);
      recordedSpans.push(...activeTraceCtx.recordedSpans);

      conversationMessages = [
        ...activePromptInputMessages,
        ...promptResponseMessages,
      ];

      accumulatedUsage.inputTokens =
        (accumulatedUsage.inputTokens ?? 0) + (result.usage?.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        (accumulatedUsage.outputTokens ?? 0) +
        (result.usage?.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        (accumulatedUsage.totalTokens ?? 0) + (result.usage?.totalTokens ?? 0);

      activeTraceCtx = null;
      activePromptInputMessages = [];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;
    }

    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    );
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

    const failOnToolError =
      (advancedConfig as { failOnToolError?: boolean } | undefined)
        ?.failOnToolError !== false;
    const traceForGate =
      recordedSpans.length > 0 || conversationMessages.length > 0
        ? {
            ...(recordedSpans.length > 0 ? { spans: recordedSpans } : {}),
            messages: conversationMessages as ModelMessage[] as Array<{
              role: string;
              content: unknown;
            }>,
          }
        : undefined;
    const predicateResults = test.successPredicates?.length
      ? evaluatePredicates(
          buildIterationTranscript({
            trace: traceForGate,
            toolCalls: evaluation.toolsCalled,
            usage: hasReportedUsage(accumulatedUsage)
              ? accumulatedUsage
              : undefined,
          }),
          test.successPredicates,
        )
      : [];
    const passed = finalizePassedForEval({
      matchPassed: evaluation.passed,
      trace: traceForGate,
      failOnToolError,
      predicateResults,
    });
    // Reflect the gated verdict (match AND tool-error gate AND predicates) in
    // the returned evaluation so totals built from `evaluation.passed` agree
    // with the persisted iteration result.
    evaluation.passed = passed;

    const usage: UsageTotals = {
      inputTokens: accumulatedUsage.inputTokens,
      outputTokens: accumulatedUsage.outputTokens,
      totalTokens: accumulatedUsage.totalTokens,
    };
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({ injectOpenAiCompat,
      messages: conversationMessages,
      mcpClientManager,
      convexClient,
    });

    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage,
      messages: conversationMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
        ...(predicateResults.length ? { predicates: predicateResults } : {}),
        ...(hostPolicy && toolSignals
          ? buildHostIterationMetadata(
              hostPolicy,
              toolSignals,
              evaluation.toolsCalled.length,
              injectOpenAiCompat === true,
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finishIterationDirectly(convexClient, finishParams);
    }

    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } catch (error) {
    // Check if request was aborted
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[evals] iteration aborted due to cancellation");
      // Don't record anything for aborted iterations
      return {
        evaluation: evaluateMultiTurnResults(
          promptTurns,
          toolsCalledByPrompt,
          test.isNegativeTest,
          test.matchOptions,
        ),
        iterationId: undefined,
      };
    }

    logger.error("[evals] iteration failed", error);

    let errorMessage: string | undefined = undefined;
    let errorDetails: string | undefined = undefined;

    if (error instanceof Error) {
      errorMessage = error.message || error.toString();

      const responseBody = (error as any).responseBody;
      if (responseBody && typeof responseBody === "string") {
        errorDetails = responseBody;
      }
    } else if (typeof error === "string") {
      errorMessage = error;
    } else {
      errorMessage = String(error);
    }

    const failAt = Date.now();
    if (activeTraceCtx) {
      finalizeAiSdkTraceOnFailure(activeTraceCtx, failAt, {
        completedStepCount: activeCompletedStepCount,
        lastStepEndedAt: activeTraceCtx.lastStepClosedEndAt,
        modelId: test.model,
        promptIndex: activePromptIndex >= 0 ? activePromptIndex : 0,
      });
      recordedSpans.push(...activeTraceCtx.recordedSpans);
    }
    appendPartialToolCallsToPrompt({
      toolsCalledByPrompt,
      promptIndex: activePromptIndex,
      partialResponseMessages: activePartialResponseMessages,
    });
    const failMessages =
      activePromptInputMessages.length > 0
        ? activeCompletedStepCount > 0 ||
          activePartialResponseMessages.length > 0
          ? [...activePromptInputMessages, ...activePartialResponseMessages]
          : activePromptInputMessages
        : conversationMessages;
    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    );
    // Suite summary aggregates `evaluation.passed` (see runEvalSuiteWithAiSdk).
    // The persisted iteration is hard-coded `passed: false` below, but the
    // returned evaluation could still report `passed: true` on negative tests
    // or tests with no expected tools when the catch fires before any tools
    // are called — that would inflate suite-pass counts. Force false here so
    // the persisted and returned verdicts agree.
    evaluation.passed = false;
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({ injectOpenAiCompat,
      messages: failMessages,
      mcpClientManager,
      convexClient,
    });

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: evaluation.toolsCalled,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      messages: failMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      status: "failed" as const,
      startedAt: runStartedAt,
      error: errorMessage,
      errorDetails,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
        ...(hostPolicy && toolSignals
          ? buildHostIterationMetadata(
              hostPolicy,
              toolSignals,
              evaluation.toolsCalled.length,
              injectOpenAiCompat === true,
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finishIterationDirectly(convexClient, failParams);
    }
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  }
};

const runIterationViaBackend = async ({
  test,
  runIndex,
  // Suite-level raw set retained for `toolSignals`; per-iteration tool prep
  // is delegated to prepareChatV2 below.
  tools: _suiteTools,
  selectedServers,
  mcpClientManager,
  recorder,
  testCaseId,
  convexHttpUrl,
  convexAuthToken,
  modelId,
  modelDefinition,
  orgModelConfig,
  endpointPath = "/stream",
  extraBodyFields,
  convexClient,
  runId,
  abortSignal,
  compareRunId,
  precreatedIterationId,
  injectOpenAiCompat,
  hostPolicy,
  toolSignals,
}: RunIterationBackendParams) => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      // If run not found, it was likely deleted - skip iteration
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
    advancedConfig,
  } = resolvedTest;
  const systemPrompt = withHostContextSystemPrompt(
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const messageHistory: ModelMessage[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const runStartedAt = Date.now();
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }

  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
      matchOptions: test.matchOptions,
      hostConfigOverride: test.hostConfigOverride,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
      ? await recorder.startIteration(iterationParams)
      : await createIterationDirectly(convexClient, iterationParams);

  // Adopt the chat-side tool/system/temperature pipeline. Same change as the
  // local-AI-SDK runner: pulls in skill tools, progressive-discovery meta-
  // tools, Anthropic name validation, and the assembled system prompt. The
  // backend path serializes `prepared.allTools` to `toolDefs` below and
  // executes them locally on tool-call events. Run AFTER iteration creation
  // and inside a try/catch so prep failures persist as a failed iteration row
  // rather than rejecting the test case with no iteration record.
  //
  // `customProviders` is derived from `orgModelConfig` so Anthropic name
  // validation fires for hosted-org BYOK runs that use Anthropic-compatible
  // custom providers (matches the local-AI-SDK runner, which threads the same
  // shape via `resolveEvalModelRuntime`).
  const backendCustomProviders = orgModelConfig
    ? buildLlmRuntimeConfigFromOrgConfig(orgModelConfig).customProviders
    : undefined;
  let prepared: PrepareChatV2Result;
  try {
    prepared = await prepareChatV2({
      mcpClientManager,
      selectedServers,
      modelDefinition,
      systemPrompt,
      temperature,
      respectToolVisibility: hostPolicy?.respectToolVisibility,
      ...(backendCustomProviders?.length
        ? { customProviders: backendCustomProviders }
        : {}),
      priorMessages: [],
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger.error("[evals] iteration setup failed (prepareChatV2)", error);
    await persistSetupFailedIteration({
      iterationId,
      runStartedAt,
      errorMessage,
      iterationMetadataBase,
      recorder,
      convexClient,
    });
    // Suite summary aggregates `evaluation.passed`; a fresh
    // `evaluateMultiTurnResults([], ...)` returns `passed: true` for negative
    // tests and for positive tests with no expected tools, so setup failures
    // would silently count as suite passes if we returned that as-is.
    const failedEvaluation = evaluateMultiTurnResults(
      promptTurns,
      [],
      test.isNegativeTest,
      test.matchOptions,
    );
    failedEvaluation.passed = false;
    return {
      evaluation: failedEvaluation,
      iterationId,
    };
  }

  const toolDefs = Object.entries(prepared.allTools).map(([name, tool]) => {
    const schema = (tool as any)?.inputSchema;
    let serializedSchema: Record<string, unknown> | undefined;
    if (schema) {
      if (
        typeof schema === "object" &&
        schema !== null &&
        "jsonSchema" in (schema as Record<string, unknown>)
      ) {
        serializedSchema = (schema as any).jsonSchema as Record<
          string,
          unknown
        >;
      } else if (typeof schema === "object" && "safeParse" in (schema as any)) {
        try {
          serializedSchema = z.toJSONSchema(schema) as Record<string, unknown>;
        } catch {
          serializedSchema = undefined;
        }
      } else {
        serializedSchema = schema as Record<string, unknown>;
      }
    }

    return {
      name,
      description: (tool as any)?.description,
      inputSchema:
        serializedSchema ??
        ({
          type: "object",
          properties: {},
          additionalProperties: false,
        } as Record<string, unknown>),
    };
  });

  const authHeader = convexAuthToken
    ? { Authorization: `Bearer ${convexAuthToken}` }
    : ({} as Record<string, string>);

  let accumulatedUsage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  const capturedSpans: EvalTraceSpan[] = [];
  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    const promptTurn = promptTurns[promptIndex]!;
    const promptToolsCalled: ToolCall[] = [];
    toolsCalledByPrompt.push(promptToolsCalled);
    messageHistory.push({
      role: "user",
      content: promptTurn.prompt,
    });

    let steps = 0;
    while (steps < MAX_STEPS) {
      const stepStartAbs = Date.now();
      const stepIndex = steps;
      const llmStartAbs = stepStartAbs;
      const stepMessageStartIndex = messageHistory.length;
      try {
        const res = await fetch(`${convexHttpUrl}${endpointPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authHeader ? { ...authHeader } : {}),
          },
          body: JSON.stringify({
            mode: "step",
            messages: JSON.stringify(messageHistory),
            model: modelId,
            ...(prepared.enhancedSystemPrompt
              ? { systemPrompt: prepared.enhancedSystemPrompt }
              : {}),
            ...(prepared.resolvedTemperature == null
              ? {}
              : { temperature: prepared.resolvedTemperature }),
            ...(toolChoice ? { toolChoice } : {}),
            tools: toolDefs,
            maxOutputTokens: 16384,
            ...(extraBodyFields ?? {}),
          }),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => res.statusText);
          const { message, expected } = describeBackendStreamError(
            res.status,
            errorText,
          );
          iterationError = message;
          iterationErrorDetails = errorText;
          if (expected) {
            // Daily spend cap / concurrency guardrail — expected, and with N
            // cases running concurrently it fires once per case. Log a single
            // quiet line with the real reason, not an alarming per-case stack.
            logger.warn(`[evals] run halted: ${message}`);
          } else {
            logger.error("[evals] backend stream error", new Error(message));
          }
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
          );
          break;
        }

        const json: any = await res.json();
        const llmEndAbs = Date.now();
        if (!json?.ok || !Array.isArray(json.messages)) {
          iterationError = "Invalid backend response payload";
          iterationErrorDetails = JSON.stringify(json, null, 2);
          logger.error(
            "[evals] invalid backend response payload",
            new Error("Invalid backend response payload"),
          );
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
            {
              modelId,
            },
          );
          break;
        }

        const stepUsage = readBackendUsage(json.usage);
        accumulatedUsage.inputTokens =
          (accumulatedUsage.inputTokens || 0) + stepUsage.inputTokens;
        accumulatedUsage.outputTokens =
          (accumulatedUsage.outputTokens || 0) + stepUsage.outputTokens;
        accumulatedUsage.totalTokens =
          (accumulatedUsage.totalTokens || 0) + stepUsage.totalTokens;

        for (const msg of json.messages as any[]) {
          if (msg?.role === "assistant" && Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (item?.type === "tool-call") {
                const name = item.toolName ?? item.name;
                if (name) {
                  promptToolsCalled.push({
                    toolName: name,
                    arguments: item.input ?? item.parameters ?? item.args ?? {},
                  });
                }
                if (!item.toolCallId) {
                  item.toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                }
                if (item.input == null) {
                  item.input = item.parameters ?? item.args ?? {};
                }
              }
            }
          }
          messageHistory.push(msg);
        }

        if (hasUnresolvedToolCalls(messageHistory as any)) {
          const toolsStartAbs = Date.now();
          const tracedBackendTools = wrapBackendToolsForTrace(prepared.allTools as any, {
            runStartedAt,
            promptIndex,
            stepIndex,
            spans: capturedSpans,
          });
          try {
            const newToolMessages = await executeToolCallsFromMessages(
              messageHistory as any,
              {
                tools: tracedBackendTools as any,
              },
            );
            const toolsEndAbs = Date.now();
            const toolMessageIndexByCallId = new Map<string, number>();
            for (let index = 0; index < messageHistory.length; index++) {
              const msg = messageHistory[index] as any;
              if (msg?.role !== "tool" || !Array.isArray(msg.content)) {
                continue;
              }
              for (const part of msg.content) {
                if (
                  part?.type === "tool-result" &&
                  typeof part.toolCallId === "string"
                ) {
                  toolMessageIndexByCallId.set(part.toolCallId, index);
                }
              }
            }
            for (const span of capturedSpans) {
              if (
                span.stepIndex !== stepIndex ||
                (span.promptIndex ?? 0) !== promptIndex ||
                typeof span.toolCallId !== "string" ||
                typeof span.messageStartIndex === "number"
              ) {
                continue;
              }
              const toolMessageIndex = toolMessageIndexByCallId.get(
                span.toolCallId,
              );
              if (typeof toolMessageIndex === "number") {
                span.messageStartIndex = toolMessageIndex;
                span.messageEndIndex = toolMessageIndex;
              }
            }
            const stepMessageEndIndex =
              messageHistory.length > stepMessageStartIndex
                ? messageHistory.length - 1
                : undefined;
            pushBackendStepSuccessSpans(
              capturedSpans,
              runStartedAt,
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              {
                startAbs: toolsStartAbs,
                endAbs: toolsEndAbs,
                pushAggregateSpan: newToolMessages.length === 0,
              },
              {
                modelId,
                inputTokens: stepUsage.inputTokens,
                outputTokens: stepUsage.outputTokens,
                totalTokens: stepUsage.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
                messageEndIndex: stepMessageEndIndex,
                status: "ok",
              },
            );
          } catch (toolErr) {
            const failAbs = Date.now();
            const stepMessageEndIndex =
              messageHistory.length > stepMessageStartIndex
                ? messageHistory.length - 1
                : undefined;
            pushBackendStepToolFailureSpans(
              capturedSpans,
              runStartedAt,
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              toolsStartAbs,
              failAbs,
              {
                modelId,
                inputTokens: stepUsage.inputTokens,
                outputTokens: stepUsage.outputTokens,
                totalTokens: stepUsage.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
                messageEndIndex: stepMessageEndIndex,
                pushAggregateSpan: false,
              },
            );
            iterationError =
              toolErr instanceof Error ? toolErr.message : String(toolErr);
            logger.error("[evals] tool execution failed", toolErr);
            break;
          }
        } else {
          const stepMessageEndIndex =
            messageHistory.length > stepMessageStartIndex
              ? messageHistory.length - 1
              : undefined;
          pushBackendStepSuccessSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            { startAbs: llmStartAbs, endAbs: llmEndAbs },
            undefined,
            {
              modelId,
              inputTokens: stepUsage.inputTokens,
              outputTokens: stepUsage.outputTokens,
              totalTokens: stepUsage.totalTokens,
              messageStartIndex:
                stepMessageEndIndex != null ? stepMessageStartIndex : undefined,
              messageEndIndex: stepMessageEndIndex,
              status: "ok",
            },
          );
        }

        steps += 1;

        const finishReason: string | undefined = json.finishReason;
        if (finishReason && finishReason !== "tool-calls") {
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.debug("[evals] backend iteration aborted due to cancellation");
          return {
            evaluation: evaluateMultiTurnResults(
              promptTurns,
              toolsCalledByPrompt,
              test.isNegativeTest,
              test.matchOptions,
            ),
            iterationId: undefined,
          };
        }

        if (error instanceof Error) {
          iterationError = error.message || error.toString();

          const responseBody = (error as any).responseBody;
          if (responseBody && typeof responseBody === "string") {
            iterationErrorDetails = responseBody;
          }
        } else if (typeof error === "string") {
          iterationError = error;
        } else {
          iterationError = String(error);
        }

        if (iterationError && iterationError.length > 500) {
          iterationError = iterationError.substring(0, 497) + "...";
        }

        logger.error("[evals] backend fetch failed", error);
        const failAbs = Date.now();
        pushBackendStepLlmFailureSpans(
          capturedSpans,
          runStartedAt,
          promptIndex,
          stepIndex,
          stepStartAbs,
          llmStartAbs,
          failAbs,
          {
            modelId,
          },
        );
        break;
      }
    }

    if (iterationError) {
      break;
    }
  }

  const evaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
    test.matchOptions,
  );
  const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

  const failOnToolError =
    (advancedConfig as { failOnToolError?: boolean } | undefined)
      ?.failOnToolError !== false;
  const traceForGate =
    capturedSpans.length > 0 || messageHistory.length > 0
      ? {
          ...(capturedSpans.length > 0 ? { spans: capturedSpans } : {}),
          messages: messageHistory as ModelMessage[] as Array<{
            role: string;
            content: unknown;
          }>,
        }
      : undefined;
  const predicateResults = test.successPredicates?.length
    ? evaluatePredicates(
        buildIterationTranscript({
          trace: traceForGate,
          toolCalls: evaluation.toolsCalled,
          usage: hasReportedUsage(accumulatedUsage)
            ? accumulatedUsage
            : undefined,
        }),
        test.successPredicates,
      )
    : [];
  const passed = finalizePassedForEval({
    matchPassed: evaluation.passed,
    trace: traceForGate,
    iterationError,
    failOnToolError,
    predicateResults,
  });
  // Reflect the gated verdict (match AND tool-error gate AND predicates) in the
  // returned evaluation so totals built from `evaluation.passed` agree with the
  // persisted iteration result.
  evaluation.passed = passed;
  const widgetSnapshots = await captureMcpAppWidgetSnapshots({ injectOpenAiCompat,
    messages: messageHistory,
    mcpClientManager,
    convexClient,
  });

  const finishParams = {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
    ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
    status: "completed" as const,
    startedAt: runStartedAt,
    error: iterationError,
    errorDetails: iterationErrorDetails,
    resultSource: "reported" as const,
    metadata: {
      ...iterationMetadataBase,
      ...buildIterationMetadata(evaluation),
      ...(predicateResults.length ? { predicates: predicateResults } : {}),
      ...(hostPolicy && toolSignals
        ? buildHostIterationMetadata(
            hostPolicy,
            toolSignals,
            evaluation.toolsCalled.length,
            injectOpenAiCompat === true,
          )
        : {}),
    },
  };

  if (recorder) {
    await recorder.finishIteration(finishParams);
  } else {
    await finishIterationDirectly(convexClient, finishParams);
  }

  return {
    evaluation,
    iterationId: iterationId ?? undefined,
  };
};

const runTestCase = async (params: {
  test: EvalTestCase;
  tools: ToolSet;
  selectedServers: string[];
  mcpClientManager: MCPClientManager;
  recorder: SuiteRunRecorder | null;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexHttpUrl: string;
  convexAuthToken: string;
  convexClient: ConvexHttpClient;
  testCaseId?: string;
  suiteId?: string;
  runId: string | null;
  abortSignal?: AbortSignal;
  compareRunId?: string;
  /** Suite-level compat-runtime flag; forwarded to each iteration. */
  injectOpenAiCompat?: boolean;
  /** Host execution policy for metadata stamping. */
  hostPolicy?: HostExecutionPolicy;
  /** Pre-computed tool exposure signals for metadata stamping. */
  toolSignals?: ToolExposureSignals;
}) => {
  const {
    test,
    tools,
    selectedServers,
    mcpClientManager,
    recorder,
    modelApiKeys,
    orgModelConfig,
    orgModelConfigTarget,
    convexHttpUrl,
    convexAuthToken,
    convexClient,
    testCaseId: parentTestCaseId,
    suiteId,
    runId,
    abortSignal,
    compareRunId,
    injectOpenAiCompat,
    hostPolicy,
    toolSignals,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const modelDefinition = buildModelDefinition(test);
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider,
  );
  const isJamModel = isMCPJamProvidedModel(
    resolvedModelId,
    modelDefinition.provider,
  );
  const orgByokRuntime = isJamModel
    ? undefined
    : await resolveOrgByokEvalRuntime({
        test,
        modelDefinition,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        convexAuthToken,
      });
  // MCPJam-paid models bill an org wallet; backend `/stream` rejects the
  // request without a projectId. Same target the org-BYOK path threads.
  const jamBillingTarget = isJamModel
    ? resolveOrgTargetForEval(test, orgModelConfigTarget)
    : undefined;

  const outcomes: EvalIterationOutcome[] = [];

  // Mirrors `streamTestCase`: pre-create all N pending iteration rows for
  // quick-run paths with runs > 1 so the iteration history shows every row
  // immediately, not one-at-a-time as the loop progresses.
  const shouldPrecreateIterations =
    recorder == null && runId == null && test.runs > 1;
  const precreatedIterationIds: (string | undefined)[] = [];
  if (shouldPrecreateIterations) {
    const resolvedTestForPrecreate = resolveEvalTestCase(test);
    const precreatedAt = Date.now();
    for (let runIndex = 0; runIndex < test.runs; runIndex++) {
      try {
        const iterationParams = {
          testCaseId: test.testCaseId ?? testCaseId,
          testCaseSnapshot: {
            title: test.title,
            query: resolvedTestForPrecreate.query,
            provider: test.provider,
            model: test.model,
            runs: test.runs,
            expectedToolCalls: resolvedTestForPrecreate.expectedToolCalls,
            isNegativeTest: test.isNegativeTest,
            expectedOutput: resolvedTestForPrecreate.expectedOutput,
            promptTurns: resolvedTestForPrecreate.promptTurns,
            advancedConfig: resolvedTestForPrecreate.advancedConfig,
            matchOptions: test.matchOptions,
            hostConfigOverride: test.hostConfigOverride,
          },
          iterationNumber: runIndex + 1,
          startedAt: precreatedAt,
        };
        const id = await createIterationDirectly(
          convexClient,
          iterationParams,
        );
        precreatedIterationIds.push(id);
      } catch (error) {
        logger.warn(
          "[evals] Failed to precreate iteration row; falling back to per-loop create",
          {
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        precreatedIterationIds.push(undefined);
      }
    }
  }

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    const precreatedIterationId = shouldPrecreateIterations
      ? precreatedIterationIds[runIndex]
      : undefined;
    if (isJamModel) {
      const iterationOutcome = await runIterationViaBackend({
        test,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: resolvedModelId,
        modelDefinition,
        extraBodyFields: jamBillingTarget ? { ...jamBillingTarget } : undefined,
        convexClient,
        modelApiKeys,
        orgModelConfig,
        runId,
        abortSignal,
        compareRunId,
        precreatedIterationId,
        injectOpenAiCompat,
        hostPolicy,
        toolSignals,
      });
      outcomes.push(iterationOutcome);
      continue;
    }

    if (orgByokRuntime?.kind === "cloud") {
      const iterationOutcome = await runIterationViaBackend({
        test,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: String(modelDefinition.id),
        modelDefinition,
        endpointPath: "/stream/org",
        extraBodyFields: {
          providerKey: orgByokRuntime.providerKey,
          ...orgByokRuntime.target,
        },
        convexClient,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        runId,
        abortSignal,
        compareRunId,
        precreatedIterationId,
        injectOpenAiCompat,
        hostPolicy,
        toolSignals,
      });
      outcomes.push(iterationOutcome);
      continue;
    }

    const iterationOutcome = await runIterationWithAiSdk({
      test,
      runIndex,
      tools,
      selectedServers,
      mcpClientManager,
      recorder,
      testCaseId,
      suiteId,
      modelDefinition,
      modelApiKeys,
      orgModelConfig:
        orgByokRuntime?.kind === "local"
          ? orgByokRuntime.orgModelConfig
          : orgModelConfig,
      orgModelConfigTarget,
      convexClient,
      runId,
      abortSignal,
      compareRunId,
      precreatedIterationId,
      injectOpenAiCompat,
      hostPolicy,
      toolSignals,
    });
    outcomes.push(iterationOutcome);
  }

  return outcomes;
};

export const runEvalSuiteWithAiSdk = async ({
  suiteId,
  runId,
  config,
  modelApiKeys,
  orgModelConfig,
  orgModelConfigTarget,
  convexClient,
  convexHttpUrl,
  convexAuthToken,
  mcpClientManager,
  recorder: providedRecorder,
  testCaseId,
  compareRunId,
  suiteInjectOpenAiCompat,
  hostExecutionPolicy,
}: RunEvalSuiteOptions): Promise<RunEvalSuiteWithAiSdkResult | undefined> => {
  const injectOpenAiCompat = suiteInjectOpenAiCompat === true;
  const tests = config.tests ?? [];
  const serverIds = resolveConfiguredServerIds({
    environment: config.environment,
    mcpClientManager,
  });

  if (!tests.length) {
    throw new Error("No tests supplied for eval run");
  }

  // For quick runs (runId === null), we don't need a recorder
  const recorder =
    runId === null
      ? null
      : (providedRecorder ??
        createSuiteRunRecorder({
          convexClient,
          suiteId,
          runId,
        }));

  // When a host policy is present we need the full tool set (including
  // app-only) so `applyVisibilityPolicyAndCountSignals` can:
  //   1. Count `toolsTotalBefore` honestly, and
  //   2. Keep app-only tools when the host opted out of visibility filtering.
  // Without this, getToolsForAiSdk pre-strips app-only tools and the policy
  // sees a partial set — drops are reported as 0 even when tools were hidden.
  const tools = (hostExecutionPolicy
    ? await mcpClientManager.getToolsForAiSdk(serverIds, {
        includeAppOnly: true,
      })
    : await mcpClientManager.getToolsForAiSdk(serverIds)) as ToolSet;

  // Apply visibility filtering when a host policy is present. The filter
  // mutates `tools` in place (same as prepareChatV2) so downstream iteration
  // runners see the post-filter set.
  const resolvedToolSignals = hostExecutionPolicy
    ? applyVisibilityPolicyAndCountSignals(
        tools as Record<string, unknown>,
        mcpClientManager,
        hostExecutionPolicy,
      )
    : undefined;

  // Note: Iterations are now pre-created in startSuiteRunWithRecorder
  // This code is no longer needed as precreateIterationsForRun is called there

  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
  };

  try {
    // Check if run has been cancelled before starting (only for suite runs)
    if (runId !== null) {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        {
          runId,
        },
      );

      if (currentRun?.status === "cancelled") {
        if (recorder) {
          await recorder.finalize({
            status: "cancelled",
            notes: "Run cancelled by user",
          });
        }
        return undefined;
      }
    }

    // Create AbortController to cancel in-flight requests
    const abortController = new AbortController();

    // Run all tests in parallel
    const testPromises = tests.map((test) =>
      runTestCase({
        test,
        tools,
        selectedServers: serverIds,
        mcpClientManager,
        recorder,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        convexHttpUrl,
        convexAuthToken,
        convexClient,
        testCaseId,
        compareRunId,
        suiteId,
        runId,
        abortSignal: abortController.signal,
        injectOpenAiCompat,
        hostPolicy: hostExecutionPolicy,
        toolSignals: resolvedToolSignals,
      }),
    );

    // Create a cancellation checker that polls every 2s
    let stopPolling = false;
    const createCancellationChecker = async () => {
      if (runId === null) return; // Quick runs can't be cancelled

      while (!stopPolling) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (stopPolling) return;
        try {
          const currentRun = await convexClient.query(
            "testSuites:getTestSuiteRun" as any,
            { runId },
          );
          if (currentRun?.status === "cancelled") {
            // Abort all in-flight LLM requests
            abortController.abort();
            throw new Error("RUN_CANCELLED");
          }
        } catch (error) {
          if (error instanceof Error && error.message === "RUN_CANCELLED") {
            throw error;
          }
          // If run not found, it was deleted - treat as cancelled
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes("not found") ||
            errorMessage.includes("unauthorized")
          ) {
            // Abort all in-flight LLM requests
            abortController.abort();
            throw new Error("RUN_CANCELLED");
          }
        }
      }
    };

    let results: PromiseSettledResult<EvalIterationOutcome[]>[];

    try {
      // Race between all tests completing and cancellation check
      results = await Promise.race([
        Promise.allSettled(testPromises),
        createCancellationChecker().then(() => {
          // This will never resolve, only reject if cancelled
          return new Promise<never>(() => {});
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "RUN_CANCELLED") {
        logger.debug(
          "[evals] Run was cancelled, all in-flight requests aborted",
        );

        // Finalize the run as cancelled
        if (recorder) {
          await recorder.finalize({
            status: "cancelled",
            notes: "Run cancelled by user",
          });
        }
        return undefined;
      }
      throw error;
    } finally {
      stopPolling = true;
    }

    const quickRunOutcomes: EvalIterationOutcome[] = [];

    // Aggregate results from all tests
    for (const result of results) {
      if (result.status === "fulfilled") {
        const outcomes = result.value;
        for (const { evaluation } of outcomes) {
          summary.total += 1;
          if (evaluation.passed) {
            summary.passed += 1;
          } else {
            summary.failed += 1;
          }
        }
        if (runId === null) {
          quickRunOutcomes.push(...outcomes);
        }
      } else {
        // Test failed entirely - log error but continue
        logger.error("[evals] Test case failed:", result.reason);
        // Count as one failed test
        summary.total += 1;
        summary.failed += 1;
      }
    }

    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

    // Only finalize if we have a recorder (suite runs, not quick runs)
    if (recorder) {
      await recorder.finalize({
        status: "completed",
        summary: {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          passRate,
        },
      });
    }

    if (runId === null) {
      return { quickRunIterationOutcomes: quickRunOutcomes };
    }
    return undefined;
  } catch (error) {
    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

    // Only finalize if we have a recorder (suite runs, not quick runs)
    if (recorder) {
      await recorder.finalize({
        status: "failed",
        summary:
          summary.total > 0
            ? {
                total: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                passRate,
              }
            : undefined,
      });
    }

    throw error;
  }
};

export type StreamEmit = (event: EvalStreamEvent) => void;

const streamIterationWithAiSdk = async ({
  test,
  runIndex,
  // Suite-level raw set retained for `toolSignals`; per-iteration tool prep
  // is delegated to prepareChatV2 below.
  tools: _suiteTools,
  selectedServers,
  mcpClientManager,
  recorder,
  testCaseId,
  suiteId,
  modelDefinition,
  modelApiKeys,
  orgModelConfig,
  convexClient,
  runId,
  abortSignal,
  emit,
  compareRunId,
  precreatedIterationId,
  injectOpenAiCompat,
  hostPolicy,
  toolSignals,
}: RunIterationAiSdkParams & {
  emit: StreamEmit;
}): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    advancedConfig,
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
  } = resolvedTest;
  const system = withHostContextSystemPrompt(
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const modelRuntime = resolveEvalModelRuntime({
    test,
    modelDefinition,
    modelApiKeys,
    orgModelConfig,
  });

  const runStartedAt = Date.now();
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }
  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
      matchOptions: test.matchOptions,
      hostConfigOverride: test.hostConfigOverride,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
      ? await recorder.startIteration(iterationParams)
      : await createIterationDirectly(convexClient, iterationParams);

  // `conversationMessages` starts empty; the system message is pushed below
  // inside the try block, AFTER `prepareChatV2`. See the suite-style runner
  // for the rationale (prep failures persist as failed iteration rows).
  let conversationMessages: ModelMessage[] = [];
  const recordedSpans: EvalTraceSpan[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const accumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let activePromptIndex = -1;
  let activePromptInputMessages: ModelMessage[] = [];
  let activePartialResponseMessages: ModelMessage[] = [];
  let activeCompletedStepCount = 0;
  let activeTraceCtx: ReturnType<typeof createAiSdkEvalTraceContext> | null =
    null;

  try {
    // See `runIterationWithAiSdk`: adopt the chat-side pipeline inside the try
    // so prep failures become a recorded failed iteration.
    const prepared = await prepareChatV2({
      mcpClientManager,
      selectedServers,
      modelDefinition,
      systemPrompt: system,
      temperature,
      respectToolVisibility: hostPolicy?.respectToolVisibility,
      customProviders: modelRuntime.customProviders,
      priorMessages: [],
    });
    if (prepared.enhancedSystemPrompt) {
      conversationMessages.push({
        role: "system",
        content: prepared.enhancedSystemPrompt,
      });
    }

    const llmModel = createLlmModel(
      modelDefinition,
      modelRuntime.apiKey,
      modelRuntime.baseUrls,
      modelRuntime.customProviders,
    );

    if (
      toolChoice &&
      typeof toolChoice === "object" &&
      !Object.hasOwn(prepared.allTools, toolChoice.toolName)
    ) {
      throw new Error(
        `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`,
      );
    }

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      activePromptInputMessages = [
        ...conversationMessages,
        { role: "user", content: promptTurn.prompt },
      ];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;
      activeTraceCtx = createAiSdkEvalTraceContext(runStartedAt);
      const tracedTools = wrapToolSetForEvalTrace(
        prepared.allTools,
        activeTraceCtx,
        promptIndex,
      );

      emit({
        type: "turn_start",
        turnIndex: promptIndex,
        prompt: promptTurn.prompt,
      });

      const result = streamText({
        model: llmModel,
        messages: activePromptInputMessages,
        tools: tracedTools,
        stopWhen: stepCountIs(20),
        ...(prepared.resolvedTemperature == null
          ? {}
          : { temperature: prepared.resolvedTemperature }),
        ...(toolChoice
          ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
          : {}),
        ...(abortSignal ? { abortSignal } : {}),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "evals.streamText",
          recordInputs: false,
          recordOutputs: false,
          metadata: {
            source: "evals",
            ...(suiteId ? { suiteId } : {}),
            ...(runId ? { runId } : {}),
            ...(testCaseId ? { testCaseId } : {}),
            ...(iterationId ? { iterationId } : {}),
            iterationNumber: runIndex + 1,
            provider: test.provider,
            model: test.model,
            promptIndex,
          },
        },
        prepareStep: ({ stepNumber }) => {
          registerAiSdkPrepareStep(activeTraceCtx!, stepNumber, {
            modelId: test.model,
            promptIndex,
          });
          return undefined;
        },
        onStepFinish: async (step) => {
          activeCompletedStepCount += 1;
          const stepFinishedAt = Date.now();
          accumulatedUsage.inputTokens += step.usage?.inputTokens ?? 0;
          accumulatedUsage.outputTokens += step.usage?.outputTokens ?? 0;
          accumulatedUsage.totalTokens += step.usage?.totalTokens ?? 0;
          const responseMessages = step.response?.messages ?? [];
          const responseMessageCountBeforeAppend =
            activePartialResponseMessages.length;
          const messageStartIndex =
            responseMessages.length > 0
              ? activePromptInputMessages.length +
                responseMessageCountBeforeAppend
              : undefined;
          appendDedupedModelMessages(
            activePartialResponseMessages,
            responseMessages as ModelMessage[],
          );
          const appendedMessageCount =
            activePartialResponseMessages.length -
            responseMessageCountBeforeAppend;
          const messageEndIndex =
            messageStartIndex != null && appendedMessageCount > 0
              ? messageStartIndex + appendedMessageCount - 1
              : undefined;
          emitAiSdkOnStepFinish(activeTraceCtx!, stepFinishedAt, {
            modelId: step.response?.modelId ?? test.model,
            inputTokens: step.usage?.inputTokens,
            outputTokens: step.usage?.outputTokens,
            totalTokens: step.usage?.totalTokens,
            messageStartIndex,
            messageEndIndex,
            status: "ok",
          });
          const snapshotMessages = [
            ...activePromptInputMessages,
            ...activePartialResponseMessages,
          ];
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex: activeCompletedStepCount - 1,
              snapshotKind: "step_finish",
              messages: snapshotMessages,
              spans: [...recordedSpans, ...activeTraceCtx!.recordedSpans],
              actualToolCalls: extractToolCallsFromConversation({
                messages: snapshotMessages,
              }),
              usage: accumulatedUsage,
            }),
          );
        },
        onFinish: async () => {
          /* Final messages read from `result` after await; hook kept for symmetry with AI SDK lifecycle. */
        },
      });

      // Consume the full stream and emit events
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            emit({ type: "text_delta", content: part.text });
            break;
          case "tool-call":
            emit({
              type: "tool_call",
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              args: (part.input ?? {}) as Record<string, unknown>,
            });
            break;
          case "tool-result":
            emit({
              type: "tool_result",
              toolCallId: part.toolCallId,
              result: part.output,
              isError: false,
            });
            break;
          case "tool-error":
            emit({
              type: "tool_result",
              toolCallId: part.toolCallId,
              result: part.error,
              isError: true,
            });
            break;
          case "finish-step":
            emit({
              type: "step_finish",
              stepNumber: activeCompletedStepCount,
              usage: {
                inputTokens: part.usage?.inputTokens ?? 0,
                outputTokens: part.usage?.outputTokens ?? 0,
              },
            });
            break;
        }
      }

      // After stream completes, resolve the promises on the streamText result
      const steps = await result.steps;
      const responseObj = await result.response;
      const finalMessagesRaw = responseObj?.messages as
        | ModelMessage[]
        | undefined;
      const promptResponseMessages =
        finalMessagesRaw && finalMessagesRaw.length > 0
          ? finalMessagesRaw
          : activePartialResponseMessages;

      if (activeTraceCtx.recordedSpans.length > 0) {
        patchAiSdkRecordedSpansMessageRangesFromSteps(
          activeTraceCtx.recordedSpans,
          activePromptInputMessages.length,
          steps,
          promptIndex,
        );
      }

      const promptToolsCalled = extractToolCallsFromConversation({
        steps,
        messages: promptResponseMessages,
      });
      toolsCalledByPrompt.push(promptToolsCalled);
      recordedSpans.push(...activeTraceCtx.recordedSpans);

      conversationMessages = [
        ...activePromptInputMessages,
        ...promptResponseMessages,
      ];

      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          snapshotKind: "turn_finish",
          messages: conversationMessages,
          spans: recordedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: conversationMessages,
          }),
          usage: accumulatedUsage,
        }),
      );

      activeTraceCtx = null;
      activePromptInputMessages = [];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;

      emit({ type: "turn_finish", turnIndex: promptIndex });
    }

    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    );
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

    const failOnToolError =
      (advancedConfig as { failOnToolError?: boolean } | undefined)
        ?.failOnToolError !== false;
    const traceForGate =
      recordedSpans.length > 0 || conversationMessages.length > 0
        ? {
            ...(recordedSpans.length > 0 ? { spans: recordedSpans } : {}),
            messages: conversationMessages as ModelMessage[] as Array<{
              role: string;
              content: unknown;
            }>,
          }
        : undefined;
    const predicateResults = test.successPredicates?.length
      ? evaluatePredicates(
          buildIterationTranscript({
            trace: traceForGate,
            toolCalls: evaluation.toolsCalled,
            usage: hasReportedUsage(accumulatedUsage)
              ? accumulatedUsage
              : undefined,
          }),
          test.successPredicates,
        )
      : [];
    const passed = finalizePassedForEval({
      matchPassed: evaluation.passed,
      trace: traceForGate,
      failOnToolError,
      predicateResults,
    });
    // Reflect the gated verdict (match AND tool-error gate AND predicates) in
    // the returned evaluation so totals built from `evaluation.passed` agree
    // with the persisted iteration result.
    evaluation.passed = passed;

    const usageFinal: UsageTotals = {
      inputTokens: accumulatedUsage.inputTokens,
      outputTokens: accumulatedUsage.outputTokens,
      totalTokens: accumulatedUsage.totalTokens,
    };
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({ injectOpenAiCompat,
      messages: conversationMessages,
      mcpClientManager,
      convexClient,
    });

    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage: usageFinal,
      messages: conversationMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
        ...(predicateResults.length ? { predicates: predicateResults } : {}),
        ...(hostPolicy && toolSignals
          ? buildHostIterationMetadata(
              hostPolicy,
              toolSignals,
              evaluation.toolsCalled.length,
              injectOpenAiCompat === true,
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finishIterationDirectly(convexClient, finishParams);
    }

    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[evals] streaming iteration aborted due to cancellation");
      return {
        evaluation: evaluateMultiTurnResults(
          promptTurns,
          toolsCalledByPrompt,
          test.isNegativeTest,
          test.matchOptions,
        ),
        iterationId: undefined,
      };
    }

    logger.error("[evals] streaming iteration failed", error);

    let errorMessage: string | undefined = undefined;
    let errorDetails: string | undefined = undefined;

    if (error instanceof Error) {
      errorMessage = error.message || error.toString();

      const responseBody = (error as any).responseBody;
      if (responseBody && typeof responseBody === "string") {
        errorDetails = responseBody;
      }
    } else if (typeof error === "string") {
      errorMessage = error;
    } else {
      errorMessage = String(error);
    }

    const failAt = Date.now();
    if (activeTraceCtx) {
      finalizeAiSdkTraceOnFailure(activeTraceCtx, failAt, {
        completedStepCount: activeCompletedStepCount,
        lastStepEndedAt: activeTraceCtx.lastStepClosedEndAt,
        modelId: test.model,
        promptIndex: activePromptIndex >= 0 ? activePromptIndex : 0,
      });
      recordedSpans.push(...activeTraceCtx.recordedSpans);
    }
    appendPartialToolCallsToPrompt({
      toolsCalledByPrompt,
      promptIndex: activePromptIndex,
      partialResponseMessages: activePartialResponseMessages,
    });
    const failMessages =
      activePromptInputMessages.length > 0
        ? activeCompletedStepCount > 0 ||
          activePartialResponseMessages.length > 0
          ? [...activePromptInputMessages, ...activePartialResponseMessages]
          : activePromptInputMessages
        : conversationMessages;
    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    );
    // Suite summary aggregates `evaluation.passed` (see runEvalSuiteWithAiSdk).
    // The persisted iteration is hard-coded `passed: false` below, but the
    // returned evaluation could still report `passed: true` on negative tests
    // or tests with no expected tools when the catch fires before any tools
    // are called — that would inflate suite-pass counts. Force false here so
    // the persisted and returned verdicts agree.
    evaluation.passed = false;
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({ injectOpenAiCompat,
      messages: failMessages,
      mcpClientManager,
      convexClient,
    });

    emit(
      buildTraceSnapshotEvent({
        turnIndex: activePromptIndex >= 0 ? activePromptIndex : 0,
        ...(activeCompletedStepCount > 0
          ? { stepIndex: activeCompletedStepCount - 1 }
          : {}),
        snapshotKind: "failure",
        messages: failMessages,
        spans: recordedSpans,
        actualToolCalls: extractToolCallsFromConversation({
          messages: failMessages,
        }),
        usage: {
          inputTokens: accumulatedUsage.inputTokens,
          outputTokens: accumulatedUsage.outputTokens,
          totalTokens: accumulatedUsage.totalTokens,
        },
        prompts: promptTraceSummaries,
      }),
    );
    emit({
      type: "error",
      message: errorMessage ?? "Eval iteration failed",
      details: errorDetails,
    });

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: evaluation.toolsCalled,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      messages: failMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      status: "failed" as const,
      startedAt: runStartedAt,
      error: errorMessage,
      errorDetails,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
        ...(hostPolicy && toolSignals
          ? buildHostIterationMetadata(
              hostPolicy,
              toolSignals,
              evaluation.toolsCalled.length,
              injectOpenAiCompat === true,
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finishIterationDirectly(convexClient, failParams);
    }
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  }
};

const streamIterationViaBackend = async ({
  test,
  runIndex,
  // Suite-level raw set retained for `toolSignals`; per-iteration tool prep
  // is delegated to prepareChatV2 below.
  tools: _suiteTools,
  selectedServers,
  mcpClientManager,
  recorder,
  testCaseId,
  convexHttpUrl,
  convexAuthToken,
  modelId,
  modelDefinition,
  orgModelConfig,
  endpointPath = "/stream",
  extraBodyFields,
  convexClient,
  runId,
  abortSignal,
  emit,
  compareRunId,
  precreatedIterationId,
  injectOpenAiCompat,
  hostPolicy,
  toolSignals,
}: RunIterationBackendParams & {
  emit: StreamEmit;
}): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
    advancedConfig,
  } = resolvedTest;
  const systemPrompt = withHostContextSystemPrompt(
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const messageHistory: ModelMessage[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const runStartedAt = Date.now();
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }

  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
      matchOptions: test.matchOptions,
      hostConfigOverride: test.hostConfigOverride,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
      ? await recorder.startIteration(iterationParams)
      : await createIterationDirectly(convexClient, iterationParams);

  // Adopt the chat-side tool/system/temperature pipeline. Same change as the
  // local-AI-SDK runner: pulls in skill tools, progressive-discovery meta-
  // tools, Anthropic name validation, and the assembled system prompt. The
  // backend path serializes `prepared.allTools` to `toolDefs` below and
  // executes them locally on tool-call events. Run AFTER iteration creation
  // and inside a try/catch so prep failures persist as a failed iteration row
  // rather than rejecting the test case with no iteration record.
  //
  // `customProviders` is derived from `orgModelConfig` so Anthropic name
  // validation fires for hosted-org BYOK runs that use Anthropic-compatible
  // custom providers (matches the local-AI-SDK runner, which threads the same
  // shape via `resolveEvalModelRuntime`).
  const backendCustomProviders = orgModelConfig
    ? buildLlmRuntimeConfigFromOrgConfig(orgModelConfig).customProviders
    : undefined;
  let prepared: PrepareChatV2Result;
  try {
    prepared = await prepareChatV2({
      mcpClientManager,
      selectedServers,
      modelDefinition,
      systemPrompt,
      temperature,
      respectToolVisibility: hostPolicy?.respectToolVisibility,
      ...(backendCustomProviders?.length
        ? { customProviders: backendCustomProviders }
        : {}),
      priorMessages: [],
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger.error("[evals] iteration setup failed (prepareChatV2)", error);
    await persistSetupFailedIteration({
      iterationId,
      runStartedAt,
      errorMessage,
      iterationMetadataBase,
      recorder,
      convexClient,
    });
    // Suite summary aggregates `evaluation.passed`; a fresh
    // `evaluateMultiTurnResults([], ...)` returns `passed: true` for negative
    // tests and for positive tests with no expected tools, so setup failures
    // would silently count as suite passes if we returned that as-is.
    const failedEvaluation = evaluateMultiTurnResults(
      promptTurns,
      [],
      test.isNegativeTest,
      test.matchOptions,
    );
    failedEvaluation.passed = false;
    return {
      evaluation: failedEvaluation,
      iterationId,
    };
  }

  const toolDefs = Object.entries(prepared.allTools).map(([name, tool]) => {
    const schema = (tool as any)?.inputSchema;
    let serializedSchema: Record<string, unknown> | undefined;
    if (schema) {
      if (
        typeof schema === "object" &&
        schema !== null &&
        "jsonSchema" in (schema as Record<string, unknown>)
      ) {
        serializedSchema = (schema as any).jsonSchema as Record<
          string,
          unknown
        >;
      } else if (typeof schema === "object" && "safeParse" in (schema as any)) {
        try {
          serializedSchema = z.toJSONSchema(schema) as Record<string, unknown>;
        } catch {
          serializedSchema = undefined;
        }
      } else {
        serializedSchema = schema as Record<string, unknown>;
      }
    }

    return {
      name,
      description: (tool as any)?.description,
      inputSchema:
        serializedSchema ??
        ({
          type: "object",
          properties: {},
          additionalProperties: false,
        } as Record<string, unknown>),
    };
  });

  const authHeader = convexAuthToken
    ? { Authorization: `Bearer ${convexAuthToken}` }
    : ({} as Record<string, string>);

  let accumulatedUsage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  const capturedSpans: EvalTraceSpan[] = [];
  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    const promptTurn = promptTurns[promptIndex]!;
    const promptToolsCalled: ToolCall[] = [];
    toolsCalledByPrompt.push(promptToolsCalled);
    messageHistory.push({
      role: "user",
      content: promptTurn.prompt,
    });

    emit({
      type: "turn_start",
      turnIndex: promptIndex,
      prompt: promptTurn.prompt,
    });

    let steps = 0;
    while (steps < MAX_STEPS) {
      const stepStartAbs = Date.now();
      const stepIndex = steps;
      const llmStartAbs = stepStartAbs;
      const stepMessageStartIndex = messageHistory.length;
      try {
        const res = await fetch(`${convexHttpUrl}${endpointPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authHeader ? { ...authHeader } : {}),
          },
          body: JSON.stringify({
            skipChatIngestion: true,
            messages: JSON.stringify(messageHistory),
            model: modelId,
            ...(prepared.enhancedSystemPrompt
              ? { systemPrompt: prepared.enhancedSystemPrompt }
              : {}),
            ...(prepared.resolvedTemperature == null
              ? {}
              : { temperature: prepared.resolvedTemperature }),
            ...(toolChoice ? { toolChoice } : {}),
            tools: toolDefs,
            maxOutputTokens: 16384,
            ...(extraBodyFields ?? {}),
          }),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => res.statusText);
          const { message, expected } = describeBackendStreamError(
            res.status,
            errorText,
          );
          iterationError = message;
          iterationErrorDetails = errorText;
          if (expected) {
            // Daily spend cap / concurrency guardrail — expected, and with N
            // cases running concurrently it fires once per case. Log a single
            // quiet line with the real reason, not an alarming per-case stack.
            logger.warn(`[evals] run halted: ${message}`);
          } else {
            logger.error("[evals] backend stream error", new Error(message));
          }
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
          );
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex,
              snapshotKind: "failure",
              messages: messageHistory,
              spans: capturedSpans,
              actualToolCalls: extractToolCallsFromConversation({
                messages: messageHistory,
              }),
              usage: accumulatedUsage,
            }),
          );
          emit({
            type: "error",
            message: iterationError,
            details: iterationErrorDetails,
          });
          break;
        }

        if (!res.body) {
          iterationError = "No response body from backend stream";
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
            { modelId },
          );
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex,
              snapshotKind: "failure",
              messages: messageHistory,
              spans: capturedSpans,
              actualToolCalls: extractToolCallsFromConversation({
                messages: messageHistory,
              }),
              usage: accumulatedUsage,
            }),
          );
          emit({
            type: "error",
            message: iterationError,
          });
          break;
        }

        // Consume SSE stream from the backend (real-time text deltas)
        let stepText = "";
        const stepToolCalls: Array<{
          toolCallId: string;
          toolName: string;
          input: unknown;
        }> = [];
        let stepFinishReason: string | undefined;
        let stepUsage: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        } = {};

        for await (const chunk of parseBackendUIMessageSSE(res.body)) {
          switch (chunk.type) {
            case "text-delta":
              stepText += (chunk.delta as string) ?? "";
              emit({
                type: "text_delta",
                content: (chunk.delta as string) ?? "",
              });
              break;
            case "tool-input-available": {
              const tcId =
                (chunk.toolCallId as string) ??
                `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const tcName = chunk.toolName as string;
              const tcInput = (chunk.input ?? {}) as Record<string, unknown>;
              stepToolCalls.push({
                toolCallId: tcId,
                toolName: tcName,
                input: tcInput,
              });
              if (tcName) {
                emit({
                  type: "tool_call",
                  toolName: tcName,
                  toolCallId: tcId,
                  args: tcInput,
                });
              }
              break;
            }
            case "finish": {
              stepFinishReason = chunk.finishReason as string | undefined;
              const metadata = chunk.messageMetadata as
                | Record<string, number>
                | undefined;
              if (metadata) {
                stepUsage = {
                  inputTokens: metadata.inputTokens,
                  outputTokens: metadata.outputTokens,
                  totalTokens: metadata.totalTokens,
                };
              }
              break;
            }
            case "error":
              iterationError =
                (chunk.errorText as string) ?? "Backend stream error";
              break;
          }
        }

        if (iterationError) {
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
            { modelId },
          );
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex,
              snapshotKind: "failure",
              messages: messageHistory,
              spans: capturedSpans,
              actualToolCalls: extractToolCallsFromConversation({
                messages: messageHistory,
              }),
              usage: accumulatedUsage,
            }),
          );
          emit({
            type: "error",
            message: iterationError,
            details: iterationErrorDetails,
          });
          break;
        }

        const llmEndAbs = Date.now();

        // Update accumulated usage from stream metadata
        accumulatedUsage.inputTokens =
          (accumulatedUsage.inputTokens || 0) +
          (stepUsage.inputTokens || 0);
        accumulatedUsage.outputTokens =
          (accumulatedUsage.outputTokens || 0) +
          (stepUsage.outputTokens || 0);
        accumulatedUsage.totalTokens =
          (accumulatedUsage.totalTokens || 0) +
          (stepUsage.totalTokens || 0);

        // Reconstruct assistant message from stream chunks
        const assistantContent: unknown[] = [];
        if (stepText) {
          assistantContent.push({ type: "text", text: stepText });
        }
        for (const tc of stepToolCalls) {
          assistantContent.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input ?? {},
          });
          promptToolsCalled.push({
            toolName: tc.toolName,
            arguments: (tc.input ?? {}) as Record<string, any>,
          });
        }
        if (assistantContent.length > 0) {
          messageHistory.push({
            role: "assistant",
            content: assistantContent,
          } as ModelMessage);
        }

        if (hasUnresolvedToolCalls(messageHistory as any)) {
          const toolsStartAbs = Date.now();
          const tracedBackendTools = wrapBackendToolsForTrace(prepared.allTools as any, {
            runStartedAt,
            promptIndex,
            stepIndex,
            spans: capturedSpans,
          });
          try {
            const newToolMessages = await executeToolCallsFromMessages(
              messageHistory as any,
              {
                tools: tracedBackendTools as any,
              },
            );
            const toolsEndAbs = Date.now();

            // Emit tool_result events for each tool result message
            for (const toolMsg of newToolMessages) {
              if (
                (toolMsg as any)?.role === "tool" &&
                Array.isArray((toolMsg as any).content)
              ) {
                for (const part of (toolMsg as any).content) {
                  if (
                    part?.type === "tool-result" &&
                    typeof part.toolCallId === "string"
                  ) {
                    emit({
                      type: "tool_result",
                      toolCallId: part.toolCallId,
                      result: part.result,
                      isError: part.isError,
                    });
                  }
                }
              }
            }

            const toolMessageIndexByCallId = new Map<string, number>();
            for (let index = 0; index < messageHistory.length; index++) {
              const msg = messageHistory[index] as any;
              if (msg?.role !== "tool" || !Array.isArray(msg.content)) {
                continue;
              }
              for (const part of msg.content) {
                if (
                  part?.type === "tool-result" &&
                  typeof part.toolCallId === "string"
                ) {
                  toolMessageIndexByCallId.set(part.toolCallId, index);
                }
              }
            }
            for (const span of capturedSpans) {
              if (
                span.stepIndex !== stepIndex ||
                (span.promptIndex ?? 0) !== promptIndex ||
                typeof span.toolCallId !== "string" ||
                typeof span.messageStartIndex === "number"
              ) {
                continue;
              }
              const toolMessageIndex = toolMessageIndexByCallId.get(
                span.toolCallId,
              );
              if (typeof toolMessageIndex === "number") {
                span.messageStartIndex = toolMessageIndex;
                span.messageEndIndex = toolMessageIndex;
              }
            }
            const stepMessageEndIndex =
              messageHistory.length > stepMessageStartIndex
                ? messageHistory.length - 1
                : undefined;
            pushBackendStepSuccessSpans(
              capturedSpans,
              runStartedAt,
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              {
                startAbs: toolsStartAbs,
                endAbs: toolsEndAbs,
                pushAggregateSpan: newToolMessages.length === 0,
              },
              {
                modelId,
                inputTokens: stepUsage.inputTokens,
                outputTokens: stepUsage.outputTokens,
                totalTokens: stepUsage.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
                messageEndIndex: stepMessageEndIndex,
                status: "ok",
              },
            );
          } catch (toolErr) {
            const failAbs = Date.now();
            const stepMessageEndIndex =
              messageHistory.length > stepMessageStartIndex
                ? messageHistory.length - 1
                : undefined;
            pushBackendStepToolFailureSpans(
              capturedSpans,
              runStartedAt,
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              toolsStartAbs,
              failAbs,
              {
                modelId,
                inputTokens: stepUsage.inputTokens,
                outputTokens: stepUsage.outputTokens,
                totalTokens: stepUsage.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
                messageEndIndex: stepMessageEndIndex,
                pushAggregateSpan: false,
              },
            );
            iterationError =
              toolErr instanceof Error ? toolErr.message : String(toolErr);
            logger.error("[evals] tool execution failed", toolErr);
            emit(
              buildTraceSnapshotEvent({
                turnIndex: promptIndex,
                stepIndex,
                snapshotKind: "failure",
                messages: messageHistory,
                spans: capturedSpans,
                actualToolCalls: extractToolCallsFromConversation({
                  messages: messageHistory,
                }),
                usage: accumulatedUsage,
              }),
            );
            emit({
              type: "error",
              message: iterationError,
              details: iterationErrorDetails,
            });
            break;
          }
        } else {
          const stepMessageEndIndex =
            messageHistory.length > stepMessageStartIndex
              ? messageHistory.length - 1
              : undefined;
          pushBackendStepSuccessSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            { startAbs: llmStartAbs, endAbs: llmEndAbs },
            undefined,
            {
              modelId,
              inputTokens: stepUsage.inputTokens,
              outputTokens: stepUsage.outputTokens,
              totalTokens: stepUsage.totalTokens,
              messageStartIndex:
                stepMessageEndIndex != null ? stepMessageStartIndex : undefined,
              messageEndIndex: stepMessageEndIndex,
              status: "ok",
            },
          );
        }

        steps += 1;

        emit({
          type: "step_finish",
          stepNumber: steps,
          usage: {
            inputTokens: stepUsage.inputTokens ?? 0,
            outputTokens: stepUsage.outputTokens ?? 0,
          },
        });
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            stepIndex,
            snapshotKind: "step_finish",
            messages: messageHistory,
            spans: capturedSpans,
            actualToolCalls: extractToolCallsFromConversation({
              messages: messageHistory,
            }),
            usage: accumulatedUsage,
          }),
        );

        if (stepFinishReason && stepFinishReason !== "tool-calls") {
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.debug(
            "[evals] backend streaming iteration aborted due to cancellation",
          );
          return {
            evaluation: evaluateMultiTurnResults(
              promptTurns,
              toolsCalledByPrompt,
              test.isNegativeTest,
              test.matchOptions,
            ),
            iterationId: undefined,
          };
        }

        if (error instanceof Error) {
          iterationError = error.message || error.toString();

          const responseBody = (error as any).responseBody;
          if (responseBody && typeof responseBody === "string") {
            iterationErrorDetails = responseBody;
          }
        } else if (typeof error === "string") {
          iterationError = error;
        } else {
          iterationError = String(error);
        }

        if (iterationError && iterationError.length > 500) {
          iterationError = iterationError.substring(0, 497) + "...";
        }

        logger.error("[evals] backend fetch failed", error);
        const failAbs = Date.now();
        pushBackendStepLlmFailureSpans(
          capturedSpans,
          runStartedAt,
          promptIndex,
          stepIndex,
          stepStartAbs,
          llmStartAbs,
          failAbs,
          {
            modelId,
          },
        );
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            stepIndex,
            snapshotKind: "failure",
            messages: messageHistory,
            spans: capturedSpans,
            actualToolCalls: extractToolCallsFromConversation({
              messages: messageHistory,
            }),
            usage: accumulatedUsage,
          }),
        );
        emit({
          type: "error",
          message: iterationError,
          details: iterationErrorDetails,
        });
        break;
      }
    }

    if (iterationError) {
      break;
    }

    emit(
      buildTraceSnapshotEvent({
        turnIndex: promptIndex,
        snapshotKind: "turn_finish",
        messages: messageHistory,
        spans: capturedSpans,
        actualToolCalls: extractToolCallsFromConversation({
          messages: messageHistory,
        }),
        usage: accumulatedUsage,
      }),
    );
    emit({ type: "turn_finish", turnIndex: promptIndex });
  }

  const evaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
    test.matchOptions,
  );
  const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

  const failOnToolError =
    (advancedConfig as { failOnToolError?: boolean } | undefined)
      ?.failOnToolError !== false;
  const traceForGate =
    capturedSpans.length > 0 || messageHistory.length > 0
      ? {
          ...(capturedSpans.length > 0 ? { spans: capturedSpans } : {}),
          messages: messageHistory as ModelMessage[] as Array<{
            role: string;
            content: unknown;
          }>,
        }
      : undefined;
  const predicateResults = test.successPredicates?.length
    ? evaluatePredicates(
        buildIterationTranscript({
          trace: traceForGate,
          toolCalls: evaluation.toolsCalled,
          usage: hasReportedUsage(accumulatedUsage)
            ? accumulatedUsage
            : undefined,
        }),
        test.successPredicates,
      )
    : [];
  const passed = finalizePassedForEval({
    matchPassed: evaluation.passed,
    trace: traceForGate,
    iterationError,
    failOnToolError,
    predicateResults,
  });
  // Reflect the gated verdict (match AND tool-error gate AND predicates) in the
  // returned evaluation so totals built from `evaluation.passed` agree with the
  // persisted iteration result.
  evaluation.passed = passed;
  const widgetSnapshots = await captureMcpAppWidgetSnapshots({ injectOpenAiCompat,
    messages: messageHistory,
    mcpClientManager,
    convexClient,
  });

  const finishParams = {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
    ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
    status: "completed" as const,
    startedAt: runStartedAt,
    error: iterationError,
    errorDetails: iterationErrorDetails,
    resultSource: "reported" as const,
    metadata: {
      ...iterationMetadataBase,
      ...buildIterationMetadata(evaluation),
      ...(predicateResults.length ? { predicates: predicateResults } : {}),
      ...(hostPolicy && toolSignals
        ? buildHostIterationMetadata(
            hostPolicy,
            toolSignals,
            evaluation.toolsCalled.length,
            injectOpenAiCompat === true,
          )
        : {}),
    },
  };

  if (recorder) {
    await recorder.finishIteration(finishParams);
  } else {
    await finishIterationDirectly(convexClient, finishParams);
  }

  return {
    evaluation,
    iterationId: iterationId ?? undefined,
  };
};

export const streamTestCase = async (params: {
  test: EvalTestCase;
  tools: ToolSet;
  selectedServers: string[];
  mcpClientManager: MCPClientManager;
  recorder: SuiteRunRecorder | null;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  orgModelConfigTarget?: ResolveOrgModelConfigTarget;
  convexHttpUrl: string;
  convexAuthToken: string;
  convexClient: ConvexHttpClient;
  testCaseId?: string;
  suiteId?: string;
  runId: string | null;
  abortSignal?: AbortSignal;
  emit: StreamEmit;
  compareRunId?: string;
  /**
   * Resolved compat-runtime flag for the suite. Forwarded to widget
   * snapshot capture in each iteration so persisted blobs match the
   * host config's `mcpProfile.apps.compatRuntime`. Absent → default
   * off (SEP-1865 honest behavior).
   */
  injectOpenAiCompat?: boolean;
  /** Resolved host execution policy (mirrors runEvalSuiteWithAiSdk). */
  hostPolicy?: HostExecutionPolicy;
  /** Pre-computed tool exposure signals for the stream run. */
  toolSignals?: ToolExposureSignals;
}) => {
  const {
    test,
    tools,
    selectedServers,
    mcpClientManager,
    recorder,
    modelApiKeys,
    orgModelConfig,
    orgModelConfigTarget,
    convexHttpUrl,
    convexAuthToken,
    convexClient,
    testCaseId: parentTestCaseId,
    suiteId,
    runId,
    abortSignal,
    emit,
    compareRunId,
    injectOpenAiCompat,
    hostPolicy,
    toolSignals,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const modelDefinition = buildModelDefinition(test);
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider,
  );
  const isJamModel = isMCPJamProvidedModel(
    resolvedModelId,
    modelDefinition.provider,
  );
  const orgByokRuntime = isJamModel
    ? undefined
    : await resolveOrgByokEvalRuntime({
        test,
        modelDefinition,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        convexAuthToken,
      });
  // MCPJam-paid models bill an org wallet; backend `/stream` rejects the
  // request without a projectId. Same target the org-BYOK path threads.
  const jamBillingTarget = isJamModel
    ? resolveOrgTargetForEval(test, orgModelConfigTarget)
    : undefined;

  const outcomes: EvalIterationOutcome[] = [];

  // Quick-run streaming with runs > 1: pre-create all N pending iteration
  // rows so they appear in the iteration history immediately. The suite
  // path already pre-creates upstream via precreateIterationsForRun, so we
  // only do this when there's no recorder (no suite run) and no runId.
  // Failures here are non-fatal — fall back to per-loop creation inside the
  // iteration runners (the existing behavior).
  const shouldPrecreateIterations =
    recorder == null && runId == null && test.runs > 1;
  const precreatedIterationIds: (string | undefined)[] = [];
  if (shouldPrecreateIterations) {
    const resolvedTestForPrecreate = resolveEvalTestCase(test);
    const precreatedAt = Date.now();
    for (let runIndex = 0; runIndex < test.runs; runIndex++) {
      try {
        const iterationParams = {
          testCaseId: test.testCaseId ?? testCaseId,
          testCaseSnapshot: {
            title: test.title,
            query: resolvedTestForPrecreate.query,
            provider: test.provider,
            model: test.model,
            runs: test.runs,
            expectedToolCalls: resolvedTestForPrecreate.expectedToolCalls,
            isNegativeTest: test.isNegativeTest,
            expectedOutput: resolvedTestForPrecreate.expectedOutput,
            promptTurns: resolvedTestForPrecreate.promptTurns,
            advancedConfig: resolvedTestForPrecreate.advancedConfig,
            matchOptions: test.matchOptions,
            hostConfigOverride: test.hostConfigOverride,
          },
          iterationNumber: runIndex + 1,
          startedAt: precreatedAt,
        };
        const id = await createIterationDirectly(
          convexClient,
          iterationParams,
        );
        precreatedIterationIds.push(id);
      } catch (error) {
        logger.warn(
          "[evals] Failed to precreate streaming iteration row; will fall back to per-loop create",
          {
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        precreatedIterationIds.push(undefined);
      }
    }
  }

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    const precreatedIterationId = shouldPrecreateIterations
      ? precreatedIterationIds[runIndex]
      : undefined;
    if (isJamModel) {
      const iterationOutcome = await streamIterationViaBackend({
        test,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: resolvedModelId,
        modelDefinition,
        extraBodyFields: jamBillingTarget ? { ...jamBillingTarget } : undefined,
        convexClient,
        modelApiKeys,
        orgModelConfig,
        runId,
        abortSignal,
        emit,
        compareRunId,
        precreatedIterationId,
        injectOpenAiCompat,
        hostPolicy,
        toolSignals,
      });
      outcomes.push(iterationOutcome);
      continue;
    }

    if (orgByokRuntime?.kind === "cloud") {
      const iterationOutcome = await streamIterationViaBackend({
        test,
        runIndex,
        tools,
        selectedServers,
        mcpClientManager,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: String(modelDefinition.id),
        modelDefinition,
        endpointPath: "/stream/org",
        extraBodyFields: {
          providerKey: orgByokRuntime.providerKey,
          ...orgByokRuntime.target,
        },
        convexClient,
        modelApiKeys,
        orgModelConfig,
        orgModelConfigTarget,
        runId,
        abortSignal,
        emit,
        compareRunId,
        precreatedIterationId,
        injectOpenAiCompat,
        hostPolicy,
        toolSignals,
      });
      outcomes.push(iterationOutcome);
      continue;
    }

    const iterationOutcome = await streamIterationWithAiSdk({
      test,
      runIndex,
      tools,
      selectedServers,
      mcpClientManager,
      recorder,
      testCaseId,
      suiteId,
      modelDefinition,
      modelApiKeys,
      orgModelConfig:
        orgByokRuntime?.kind === "local"
          ? orgByokRuntime.orgModelConfig
          : orgModelConfig,
      orgModelConfigTarget,
      convexClient,
      runId,
      abortSignal,
      emit,
      compareRunId,
      precreatedIterationId,
      injectOpenAiCompat,
      hostPolicy,
      toolSignals,
    });
    outcomes.push(iterationOutcome);
  }

  return outcomes;
};
