import {
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
import {
  consumeDirectChatTurnHeadless,
  runDirectChatTurn,
} from "../utils/direct-chat-turn";
import { consumeFullStreamAsEvalEvents } from "./evals/stream-adapter";
import { resolveExecutionContext } from "../utils/host-execution-context";
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
import { runAssistantTurn } from "../utils/assistant-turn.js";
import type {
  MCPJamStepFinishEvent,
  MCPJamToolCallEvent,
  MCPJamToolResultEvent,
} from "../utils/mcpjam-stream-handler.js";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "./evals/persist-eval-trace.js";
import type {
  EvalStreamEvent,
  EvalStreamToolCall,
} from "@/shared/eval-stream-events";


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
  /**
   * Raw suite hostConfig record. PR 4d threads this through so per-iteration
   * runners can resolve CONFIG fields (`systemPrompt` / `temperature` /
   * `selectedServerIds`) via `resolveExecutionContext` — the runner used
   * to read `advancedConfig.system` only and ignore the suite default.
   */
  suiteHostConfig?: Record<string, unknown> | null;
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
  // Fall back to the W1 single-call path ONLY when the fanout failed
  // before any turn landed. See recorder.ts / persist-eval-trace.ts.
  const useW1Fallback =
    fanout.persisted === false && fanout.turnsWritten === 0;
  if (fanout.persisted === false) {
    logger.warn(
      useW1Fallback
        ? "[evals] persistEvalTraceFanout failed before any turn landed (quick run); falling back to W1 single-call save"
        : "[evals] persistEvalTraceFanout failed mid-stream (quick run); iteration finalized without re-attempting (would orphan partial turns)",
      {
        iterationId: params.iterationId,
        turnsWritten: fanout.turnsWritten,
        error: fanout.error.message,
      },
    );
  }

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
      ...(useW1Fallback
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
  /**
   * Raw suite hostConfig record — the same one the route layer feeds
   * to `extractHostExecutionPolicy` for the `hostPolicy` field above.
   * PR 4d of the engine consolidation (`~/mcpjam-docs/unification.md`)
   * threads this through so per-iteration runners can resolve CONFIG
   * fields (`systemPrompt` / `temperature` / `selectedServerIds`) off
   * it via `resolveExecutionContext` — the runner used to read
   * `advancedConfig.system` only, leaving the suite-default systemPrompt
   * unused at runtime even though the eval client deliberately omits
   * it from per-case `advancedConfig` (see comment at
   * `client/src/components/evals/use-eval-handlers.ts:302`).
   *
   * Optional so quick-run paths that don't load a suite hostConfig keep
   * working — the resolver treats `null`/`undefined` as "no host opinion;
   * use overrides as-is."
   */
  suiteHostConfig?: Record<string, unknown> | null;
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
  suiteHostConfig,
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
  // PR 4d of the engine consolidation (`~/mcpjam-docs/unification.md`):
  // resolve `systemPrompt` and `temperature` via the shared
  // `resolveExecutionContext` so the suite-level hostConfig's
  // `systemPrompt` / `temperature` act as defaults under the per-case
  // `advancedConfig` overrides. Pre-4d the runner ignored
  // `suiteHostConfig.systemPrompt` / `.temperature` entirely — even
  // though the eval client deliberately omits suite defaults from per-case
  // advancedConfig (see comment at
  // `client/src/components/evals/use-eval-handlers.ts:302`) on the
  // understanding that the runtime applies them. `override-wins`
  // precedence keeps per-case overrides authoritative; the hostConfig
  // fills the gap when the per-case value is absent.
  //
  // `withHostContextSystemPrompt` runs AFTER the resolver because
  // `{{var}}` substitution context is per-RUN
  // (`test.hostConfigOverride.hostContext`), not part of the suite
  // hostConfig.
  const resolvedExecution = resolveExecutionContext({
    hostConfig: suiteHostConfig ?? null,
    overrides: {
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
    },
    precedence: "override-wins",
  });
  const system = withHostContextSystemPrompt(
    resolvedExecution.systemPrompt,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature = resolvedExecution.temperature;
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
  // PR 4b of the engine consolidation: caller-side failure detection.
  // `runDirectChatTurn` can return cleanly with empty response messages or
  // a non-tool error span when the AI SDK silently swallows a step failure.
  // Capturing the error into `iterationError` lets `finishParams` record
  // the failure via `status:"completed"` + `error` (mirrors the PR 3
  // backend-loop shape). The post-loop verdict gate
  // (`finalizePassedForEval`) also reads this so a failed cycle can't
  // sneak through as `passed:true` on negative tests / zero-expected
  // tool cases.
  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  // PR 4d review fix (Codex P2 "Persist the resolved system prompt with
  // eval traces"): chat ships the system via the helper's `system:`
  // field, but eval's persistence path (`finishIteration` →
  // `persistEvalTraceFanout`'s `appendEvalTurnTrace` payload) has no
  // dedicated `systemPrompt` slot. Pre-4d, the system rode along as
  // the first entry in `conversationMessages` and was naturally
  // persisted. PR 4d dropped that push to align with chat's wire shape,
  // and accidentally removed the only path the persistence layer had
  // for capturing it. Hoist the resolved system prompt to outer scope
  // so we can prepend it to the messages array AT PERSISTENCE TIME
  // (not in `conversationMessages` — that stays system-free so the
  // streamText `system:` field isn't double-sent). The persisted
  // shape now matches pre-4d (system is the first message in
  // `messages`) while the wire shape stays chat-aligned.
  let enhancedSystemPromptForPersist: string | undefined = undefined;

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
    // PR 4d of the engine consolidation: drop the PR 4b
    // `systemPrompt: ""` quirk. Pre-4d, eval pushed
    // `prepared.enhancedSystemPrompt` as a `role: "system"` message into
    // `conversationMessages` and passed `systemPrompt: ""` to the
    // helper — `normalizeSystemPromptForProvider("")` resolved to
    // `undefined` so streamText received the system via messages, not
    // the dedicated `system:` field. That worked but was a latent
    // footgun: any refactor of `normalizeSystemPromptForProvider` to
    // emit `""` would have double-sent the system. Match chat's shape —
    // `enhancedSystemPrompt` flows to `runDirectChatTurn` via the
    // `systemPrompt:` argument below; `conversationMessages` no longer
    // carries a system message entry. PR 4d review fix (Codex P2):
    // hoist the resolved value so it can be prepended to the messages
    // array at persistence time, since eval's wire shape to Convex
    // (`appendEvalTurnTrace`) has no dedicated `systemPrompt` slot.
    enhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;

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

    // PR 4b helper: abort happened during the cleanup window between the
    // pre-turn cancellation check and `consumeStream()`. Mirrors PR 3's
    // backend-path cancellation shape and the closed #2458's local-BYOK
    // shape: drop the iteration entirely (no record).
    const localIsAborted = () => abortSignal?.aborted === true;
    const returnLocalCancelled = () => ({
      evaluation: evaluateMultiTurnResults(
        promptTurns,
        toolsCalledByPrompt,
        test.isNegativeTest,
        test.matchOptions,
      ),
      iterationId: undefined,
    });

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      if (localIsAborted()) return returnLocalCancelled();
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      // PR 4b invariant (carried from closed #2458, originally PR 3 round 2):
      // push the user prompt to `conversationMessages` BEFORE the driver
      // call so a failed turn still records the prompt in the persisted
      // transcript. Without this, suite UI shows an empty failed
      // iteration that's unactionable.
      conversationMessages.push({ role: "user", content: promptTurn.prompt });
      activePromptInputMessages = [...conversationMessages];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;

      // PR 4b: drive `runDirectChatTurn` headless (no SSE — eval is
      // batch). The helper owns the streamText config, span recording,
      // abort wiring, progressive-discovery gating, and prepareStep.
      // Eval owns failure detection + persistence + grading, layered
      // on top of `consumeDirectChatTurnHeadless`'s assembled return.
      //
      // PR 4d: `systemPrompt: prepared.enhancedSystemPrompt` matches
      // chat's shape — the helper passes it to streamText via the
      // dedicated `system:` field. `conversationMessages` no longer
      // contains a system message; the persisted transcript carries
      // the system via its own column (chatSession.systemPrompt /
      // testIteration column), same as chat's path.
      // PR 4b review fix (Cursor "Partial messages never mirrored" +
      // Codex P2): the legacy `generateText` loop updated
      // `activePartialResponseMessages` and `activeCompletedStepCount`
      // from its own `onStepFinish`. The outer catch + the no-msg
      // fallback in this loop still depend on those locals to persist
      // partial transcripts when `consumeStream()` rejects mid-turn.
      // Wire the helper's `onStepSnapshot` callback to mirror the
      // helper's running `traceHistory` into the eval-side locals so
      // mid-turn throws don't lose successful tool calls + assistant
      // messages from the failed iteration. `traceHistory` starts as
      // a copy of `messageHistory` and the helper appends step
      // responses to it, so slicing from `promptInputLength` yields
      // just this turn's accumulated response.
      const promptInputLength = activePromptInputMessages.length;
      const handle = runDirectChatTurn({
        llmModel,
        modelId: test.model,
        messageHistory: activePromptInputMessages,
        // Cursor PR 5a review fix (also applies to PR 4b's non-stream
        // runner): anchor trace span offsets to the iteration start so
        // multi-turn timelines don't collapse to start-at-zero per
        // turn. The helper defaults to `Date.now()` for the chat /
        // single-turn case.
        traceStartedAt: runStartedAt,
        systemPrompt: prepared.enhancedSystemPrompt ?? "",
        ...(prepared.resolvedTemperature == null
          ? {}
          : { temperature: prepared.resolvedTemperature }),
        tools: prepared.allTools,
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        ...(abortSignal ? { abortSignal } : {}),
        ...(toolChoice
          ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
          : {}),
        experimentalTelemetry: {
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
        traceEvents: {
          onStepSnapshot: ({ traceHistory }) => {
            activeCompletedStepCount += 1;
            // The helper's `traceHistory` contains prompt input plus
            // every step response it has appended so far. The
            // post-prompt-input slice IS this turn's running response.
            activePartialResponseMessages = traceHistory.slice(
              promptInputLength,
            ) as ModelMessage[];
          },
        },
      });
      // `runDirectChatTurn` exposes its internal traceContext so eval
      // can fold its spans into `recordedSpans` after each turn,
      // matching the per-turn cadence the old generateText path used
      // with its own `activeTraceCtx`.
      activeTraceCtx = handle.traceContext;

      const headless = await consumeDirectChatTurnHeadless(handle);

      // PR 4b invariant (carried from closed #2458, originally PR 3
      // "Abort no longer skips persistence"): streamText can swallow
      // AbortError silently. `handle.isAborted()` is also reflected in
      // `headless.aborted`; check the outer signal here too in case
      // the abort fired between consume and check.
      if (headless.aborted || localIsAborted()) {
        logger.debug(
          "[evals] local-BYOK iteration aborted mid-turn; skipping record",
        );
        return returnLocalCancelled();
      }

      const promptResponseMessages =
        headless.messages.length > 0
          ? headless.messages
          : activePartialResponseMessages;

      if (activeTraceCtx.recordedSpans.length > 0) {
        patchAiSdkRecordedSpansMessageRangesFromSteps(
          activeTraceCtx.recordedSpans,
          activePromptInputMessages.length,
          headless.steps,
          promptIndex,
        );
      }

      // PR 4b review fix (Cursor "Failed turn drops token usage"):
      // accumulate `totalUsage` BEFORE the failure-detection branches.
      // `headless.totalUsage` reflects what the model actually consumed
      // up to (and including) the failing step; the persisted iteration
      // should report it regardless of which exit path the turn takes.
      // Failure branches `break` after this so the persisted token
      // totals match reality even when the cycle fails.
      accumulatedUsage.inputTokens =
        (accumulatedUsage.inputTokens ?? 0) +
        (headless.totalUsage?.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        (accumulatedUsage.outputTokens ?? 0) +
        (headless.totalUsage?.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        (accumulatedUsage.totalTokens ?? 0) +
        (headless.totalUsage?.totalTokens ?? 0);

      // PR 4b failure-detection shape (mirrors PR 3 backend-path):
      //
      //  (a) No new messages → driver returned nothing (network failure
      //      that fell through, model returned empty, …).
      //  (b) Non-tool error span captured during the run (LLM step
      //      failure, scrub failure, …). Tool error spans
      //      (category "tool") flow through the existing
      //      `failOnToolError` gate below — DON'T treat them as cycle
      //      failures here.
      if (promptResponseMessages.length === 0) {
        iterationError =
          "Stream returned no content (local-BYOK driver failed)";
        logger.error(
          "[evals] streamText returned no new messages this turn; treating as cycle failure",
        );
        recordedSpans.push(...activeTraceCtx.recordedSpans);
        toolsCalledByPrompt.push([]);
        break;
      }
      const stepErrorSpan = activeTraceCtx.recordedSpans.find(
        // Codex PR 5a review fix (also applies to PR 4b's non-stream
        // runner): when a tool call fails, `wrapToolSetForEvalTrace`
        // records BOTH a `category:"tool"` span AND a child
        // `category:"error"` span carrying `toolCallId`/`toolName`
        // (see eval-trace-capture.ts:258-275). The simple
        // `category !== "tool"` filter catches the child error span
        // and treats failed tool calls as cycle failures even when
        // `advancedConfig.failOnToolError === false`. Excluding any
        // span associated with a tool (carries `toolCallId`) restores
        // the intended deferral to the `failOnToolError` gate.
        (span) =>
          span.status === "error" &&
          span.category !== "tool" &&
          !(span as { toolCallId?: string }).toolCallId,
      );
      if (stepErrorSpan) {
        iterationError = `Local-BYOK step failed mid-turn: ${stepErrorSpan.name}`;
        logger.error(
          `[evals] streamText recorded non-tool error span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`,
        );
        recordedSpans.push(...activeTraceCtx.recordedSpans);
        toolsCalledByPrompt.push(
          extractToolCallsFromConversation({
            steps: headless.steps,
            messages: promptResponseMessages,
          }),
        );
        // PR 4b review fix (Cursor "Step error drops assistant
        // transcript"): merge the partial response into
        // `conversationMessages` so persisted iterations include
        // whatever the model produced before the failure. The break
        // short-circuits the normal merge below, so do it explicitly.
        conversationMessages = [
          ...activePromptInputMessages,
          ...promptResponseMessages,
        ];
        break;
      }

      const promptToolsCalled = extractToolCallsFromConversation({
        steps: headless.steps,
        messages: promptResponseMessages,
      });
      toolsCalledByPrompt.push(promptToolsCalled);
      recordedSpans.push(...activeTraceCtx.recordedSpans);

      conversationMessages = [
        ...activePromptInputMessages,
        ...promptResponseMessages,
      ];
      // Note: `accumulatedUsage` was merged above (before the failure
      // branches) so token totals stay correct whether the loop
      // continues, breaks on the no-messages path, or breaks on the
      // step-error path.

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
      // PR 4b (mirrors PR 3 invariant): if the per-turn loop set
      // `iterationError` via the failure-detection branch (no new
      // messages, non-tool error span), feed it to the gate so a
      // failed cycle doesn't sneak through as a verdict pass on
      // negative tests / zero-expected-tool cases.
      iterationError,
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

    // PR 4d review fix (Codex P2): prepend the resolved system prompt
    // so persisted eval transcripts carry it. The streamText `system:`
    // field already covered the wire shape to the model; this restores
    // the pre-4d persistence shape (first message is `role: "system"`)
    // for downstream consumers of `appendEvalTurnTrace.sessionMessages`
    // and the legacy `testIteration.blob` fallback.
    const persistedMessages: ModelMessage[] = enhancedSystemPromptForPersist
      ? [
          { role: "system", content: enhancedSystemPromptForPersist },
          ...conversationMessages,
        ]
      : conversationMessages;

    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage,
      messages: persistedMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
      ...(iterationError ? { error: iterationError } : {}),
      ...(iterationErrorDetails ? { errorDetails: iterationErrorDetails } : {}),
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
    // PR 4d review fix (Codex P2): same prefix as the success path — if
    // `prepared` ran far enough to populate
    // `enhancedSystemPromptForPersist`, surface the resolved system in
    // the persisted failure transcript. Catches that fire BEFORE
    // `prepareChatV2` returned leave the prefix empty (no system to
    // persist anyway). Applied only in `runIterationWithAiSdk`; the
    // streaming variant still pushes the system into
    // `conversationMessages` itself (PR 5 territory).
    const persistedFailMessages: ModelMessage[] = enhancedSystemPromptForPersist
      ? [
          { role: "system", content: enhancedSystemPromptForPersist },
          ...failMessages,
        ]
      : failMessages;

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: evaluation.toolsCalled,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      messages: persistedFailMessages,
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
  // `convexHttpUrl` is in the RunIterationBackendParams type because the
  // streaming variant (`streamIterationViaBackend`) still uses it for
  // its legacy per-step fetch loop (PR 5 collapses that). The non-stream
  // path now drives `runAssistantTurn`, which reads
  // `process.env.CONVEX_HTTP_URL` directly — so the runner-level param
  // is dead here. Kept in the type signature (no API churn) but no
  // longer destructured.
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
  suiteHostConfig,
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
  // PR 4d of the engine consolidation: same resolver shape as
  // `runIterationWithAiSdk` above — suite hostConfig provides defaults,
  // per-case `advancedConfig` overrides win. `withHostContextSystemPrompt`
  // applies {{var}} substitution on the resolved value.
  const resolvedExecution = resolveExecutionContext({
    hostConfig: suiteHostConfig ?? null,
    overrides: {
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
    },
    precedence: "override-wins",
  });
  const systemPrompt = withHostContextSystemPrompt(
    resolvedExecution.systemPrompt,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature = resolvedExecution.temperature;
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
  // PR 4d review fix (Codex P2 / Cursor Medium): hoisted up-front (above
  // the `prepareChatV2` try) so the catch path and the assignment
  // inside the try are both in scope. Stays `undefined` if prepareChatV2
  // throws — the setup-failure persistence path doesn't need a system
  // prefix.
  let backendEnhancedSystemPromptForPersist: string | undefined = undefined;
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
    // PR 4d review fix (Codex P2 / Cursor Medium): stash the resolved
    // system prompt for the persistence prefix below. The engine
    // (`runAssistantTurn`) sends it to the model via its `systemPrompt:`
    // arg, but the returned message history doesn't carry a system entry
    // and `appendEvalTurnTrace` has no `systemPrompt` slot. Prepend at
    // persistence time — same shape as the local runners' Codex-P2 fix.
    backendEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
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

  // PR 3 of the engine consolidation: drive the per-step fetch + local-tool
  // loop through `runAssistantTurn` (the same engine chat / playground /
  // synthetic use) instead of an eval-specific while loop. The contract test
  // at `server/utils/__tests__/assistant-turn-eval-contract.test.ts` (PR 2)
  // locks in the exact configuration we pass here.
  //
  // What this swap drops vs. the legacy backend loop:
  //   - Per-step LLM spans (`pushBackendStepLlmFailureSpans`,
  //     `pushBackendStepSuccessSpans`, `pushBackendStepToolFailureSpans`). The
  //     legacy loop emitted span-per-step granularity for the trace UI; the
  //     engine handles its own step traces internally and `runAssistantTurn`
  //     surfaces them as `result.turnTrace`, but that format is the chat-side
  //     `PersistedTurnTrace` shape, not the eval `EvalTraceSpan[]` shape.
  //     Converting between them is out of scope here; PR 5/6 can address.
  //   - Friendly "[evals] run halted: <reason>" log distinction for
  //     daily-spend-cap errors. The engine throws on backend failures; we map
  //     to `iterationError` uniformly. Spend-cap halts still record cleanly,
  //     just without the warn-vs-error split.
  // What this swap keeps:
  //   - Tool-execution spans via `wrapToolSetForEvalTrace` (the wrapped tools
  //     are passed to the engine; their `execute` hooks fire span capture).
  //   - Cancellation via `abortSignal`.
  //   - `iterationError` accumulation for the existing post-loop verdict gate.
  let accumulatedUsage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  const capturedSpans: EvalTraceSpan[] = [];
  // PR 4d review fix (Codex P2 / Cursor Medium): see hoist above the
  // `prepareChatV2` try.

  // Eval supplies its bearer token via `convexAuthToken`. The engine wraps it
  // into the Convex `/stream` (or `/stream/org`) request the same way live
  // chat does.
  const evalAuthContext = {
    kind: "user_bearer" as const,
    token: `Bearer ${convexAuthToken}`,
  };

  // Cursor review fix: the legacy `runIterationViaBackend` returned
  // early on AbortError without recording the iteration. The engine
  // swallows AbortError internally (sets its `aborted` flag, omits
  // `turnTrace`, doesn't throw out of `runAssistantTurn`), and
  // `RunAssistantTurnResult` doesn't expose the engine's `aborted`
  // flag — so we read `abortSignal.aborted` directly as the
  // authoritative cancellation signal. Used at the top of each
  // iteration AND after every per-turn call (success or catch).
  const isAborted = () => abortSignal?.aborted === true;
  const returnCancelled = () => ({
    evaluation: evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    ),
    iterationId: undefined,
  });

  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    // Cancellation between turns: bail without recording.
    if (isAborted()) {
      logger.debug(
        "[evals] backend iteration aborted between turns; skipping record",
      );
      return returnCancelled();
    }

    const promptTurn = promptTurns[promptIndex]!;

    // Per-turn span-capture context. `wrapToolSetForEvalTrace` instruments
    // each tool's `execute` to push to `traceCtx.recordedSpans`; we drain
    // into `capturedSpans` after the engine finishes.
    const traceCtx = createAiSdkEvalTraceContext(runStartedAt);
    const tracedTools = wrapToolSetForEvalTrace(
      prepared.allTools,
      traceCtx,
      promptIndex,
    );

    // Cursor review round-2 fix: push the user prompt into
    // `messageHistory` BEFORE the engine call so a failed turn still
    // persists the user side of the transcript. The legacy backend
    // loop pushed the user message at the top of its per-step while
    // loop; that meant `finishIteration` saw the user prompt even
    // when the iteration failed mid-step. Recording the input keeps
    // the transcript honest about WHICH turn errored.
    messageHistory.push({
      role: "user",
      content: promptTurn.prompt,
    });
    const messageCountBeforeTurn = messageHistory.length;
    const inputMessages: ModelMessage[] = [...messageHistory];

    // Cursor + Codex review fix: thread `toolChoice` AND
    // `maxOutputTokens` through `extraBodyFields` since the engine's
    // `RunAssistantTurnOptions` / `MCPJamHandlerOptions` don't expose
    // them as first-class fields. The Convex `/stream` (and
    // `/stream/org`) handlers already accept both in the request body
    // — the engine spreads `extraBodyFields` into the body unchanged.
    // `maxOutputTokens: 16384` matches the legacy per-step Convex body
    // (Cursor round-2 finding "Dropped eval maxOutputTokens limit"):
    // without it, hosted backend eval turns would inherit the
    // `/stream` handler's default, which can truncate long multi-step
    // tool loops differently than the historical eval cap.
    const mergedExtraBodyFields: Record<string, unknown> = {
      maxOutputTokens: 16384,
      ...(extraBodyFields ?? {}),
      ...(toolChoice ? { toolChoice } : {}),
    };

    let turnResult: Awaited<ReturnType<typeof runAssistantTurn>>;
    try {
      turnResult = await runAssistantTurn({
        messages: inputMessages,
        // Eval's `runTestCase` already resolved the canonical model id
        // (`getCanonicalModelId(modelDefinition.id, provider)`) and threads
        // it in as `modelId` — for the JAM-paid path that's e.g.
        // `anthropic/claude-haiku-4.5`. The engine reads
        // `modelDefinition.id` for the wire payload, so override here so
        // backend wallet/quota lookup keys match what live chat sends.
        modelDefinition: { ...modelDefinition, id: modelId },
        systemPrompt: prepared.enhancedSystemPrompt,
        ...(prepared.resolvedTemperature != null
          ? { temperature: prepared.resolvedTemperature }
          : {}),
        tools: tracedTools,
        ...(selectedServers.length
          ? { selectedServerIds: selectedServers }
          : {}),
        mcpClientManager,
        authContext: evalAuthContext,
        sourceType: "eval",
        origin: "eval",
        streamSink: "none",
        persistMode: "caller",
        approvalMode: "auto-deny",
        endpointPath,
        extraBodyFields: mergedExtraBodyFields,
        ...(abortSignal ? { abortSignal } : {}),
        maxSteps: MAX_STEPS,
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
      });
    } catch (error) {
      // Cancellation: bail without recording. AbortError can surface
      // either as a thrown exception (when fetch is aborted mid-flight)
      // or as the engine's internal silent-cancellation path (handled
      // by the `isAborted()` check after the success path below). Check
      // `abortSignal.aborted` to catch BOTH paths consistently.
      if (
        isAborted() ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        logger.debug(
          "[evals] backend iteration aborted due to cancellation",
        );
        return returnCancelled();
      }

      // Non-abort runtime error from the engine. Map to `iterationError`
      // for the post-loop verdict gate; preserve a truncated message and,
      // when available, a `responseBody` for `errorDetails`.
      if (error instanceof Error) {
        iterationError = error.message || error.toString();
        const responseBody = (error as { responseBody?: unknown })
          .responseBody;
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
      logger.error("[evals] runAssistantTurn failed", error);
      break;
    }

    // Cursor review fix: cancellation that fired DURING
    // `runAssistantTurn` without surfacing as a throw. The engine
    // catches AbortError, sets its internal `aborted` flag, omits the
    // `turnTrace`, and returns normally. Without this check we'd fall
    // through to the silent-cycle-failure branch below and record an
    // aborted run as a verdict failure.
    if (isAborted()) {
      logger.debug(
        "[evals] backend iteration aborted mid-turn; skipping record",
      );
      return returnCancelled();
    }

    // Drain per-turn outputs into the iteration-level accumulators
    // BEFORE the failure checks below. Doing it first preserves
    // whatever partial good state the engine produced (tool spans,
    // partial transcript, usage), so the persisted iteration shows
    // what completed before the failure point.
    //
    // Codex round-3 (P2 "Preserve backend tool step indices"):
    // `wrapToolSetForEvalTrace` records tool spans in
    // `traceCtx.recordedSpans` but never gets `prepareStep` updates
    // from the engine (eval is no longer calling `generateText`
    // directly), so those spans land with `stepIndex: -1`. The engine
    // emits its OWN correctly-indexed LLM-step spans into
    // `turnTrace.spans` (already `EvalTraceSpan[]` shape — see
    // `PersistedTurnTrace` in chat-ingestion.ts). Merge both: the
    // engine's LLM spans give per-step granularity; the wrap's tool
    // spans give per-tool-call detail. Tool spans still have
    // `stepIndex: -1` for now — fixing that requires correlating
    // each tool span back to its parent LLM step via the engine's
    // step events, which is a separate workstream.
    capturedSpans.push(...traceCtx.recordedSpans);
    if (turnResult.turnTrace?.spans?.length) {
      capturedSpans.push(...turnResult.turnTrace.spans);
    }
    if (turnResult.usage) {
      accumulatedUsage.inputTokens =
        (accumulatedUsage.inputTokens || 0) +
        (turnResult.usage.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        (accumulatedUsage.outputTokens || 0) +
        (turnResult.usage.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        (accumulatedUsage.totalTokens || 0) +
        (turnResult.usage.totalTokens ?? 0);
    }

    // Extract per-turn tool calls from the new messages only (engine
    // returns the FULL transcript; slice from `messageCountBeforeTurn`
    // to get just this turn's appended assistant + tool messages so
    // prior turns' calls aren't double-counted).
    const newMessages = turnResult.messages.slice(messageCountBeforeTurn);
    const promptToolsCalled = extractToolCallsFromConversation({
      messages: newMessages,
    });
    toolsCalledByPrompt.push(promptToolsCalled);

    // Roll the engine's transcript forward as the next turn's starting
    // point. Includes prior conversation + this turn's user prompt + this
    // turn's assistant/tool messages.
    messageHistory.length = 0;
    messageHistory.push(...turnResult.messages);

    // Failure detection (ordered most-specific → least-specific).
    // Three engine failure shapes the runner must catch:
    //
    //  (a) Cursor round-3 ("Partial turn hides engine failures"):
    //      Engine catch fired AFTER partial messages were appended
    //      (some text deltas / partial tool call landed before the
    //      error). The engine's `executeEngine` `try { ... }
    //      catch (error) { logger.error; emit error chunk; ... }` at
    //      mcpjam-stream-handler.ts:2227 leaves `runSucceeded:
    //      false` → `turnTrace` is NOT captured even though
    //      `messages.length > messageCountBeforeTurn`. The
    //      message-count check and the error-span check both miss
    //      this. `!turnTrace` is the reliable signal.
    //
    //  (b) Codex P1 round-1 + the original silent-cycle-failure:
    //      Engine succeeded (turnTrace captured) but produced no new
    //      content (step-level non-OK at
    //      mcpjam-stream-handler.ts:1384 returns
    //      `shouldContinue:false`, synthetic finish, runSucceeded
    //      true). Detect via `messages.length <=
    //      messageCountBeforeTurn`.
    //
    //  (c) Codex P1 round-2 ("Fail turns when later backend steps
    //      error"): step 1 succeeded, step 2 errored. `turnTrace`
    //      captured, `messages.length` grew, but `turnTrace.spans`
    //      includes an `EvalTraceSpan` with `status:"error"`.
    if (!turnResult.turnTrace) {
      iterationError =
        "Backend stream failed during iteration (engine caught an error mid-turn)";
      logger.error(
        `[evals] runAssistantTurn returned no turnTrace (engine runSucceeded=false); treating as cycle failure (messagesGrew=${newMessages.length > 0})`,
      );
      break;
    }
    if (newMessages.length === 0) {
      iterationError =
        "Backend step returned no content (stream error or empty response)";
      logger.error(
        "[evals] runAssistantTurn produced no new messages this turn; treating as cycle failure",
      );
      break;
    }
    // Codex P1 round-3 ("Don't treat tool-result error spans as
    // backend failures"): `wrapBackendToolsForTrace` records ORDINARY
    // local tool-result errors (MCP tool returned `isError: true`,
    // tool execution threw, ...) as `status: "error"` with
    // `category: "tool"`. The original match-any-error-span check
    // would set `iterationError` and break before
    // `finalizePassedForEval` could apply the configured
    // `failOnToolError` policy — so otherwise-passing evals were
    // force-failed when a tool returned a recoverable error and the
    // model recovered. Filter to backend step / LLM failure spans
    // only (categories `"step" | "llm" | "error"`); tool-category
    // error spans flow through the existing tool-error gate (see
    // `finalizePassedForEval` + `advancedConfig.failOnToolError`).
    const stepErrorSpan = turnResult.turnTrace.spans.find(
      (span) => span.status === "error" && span.category !== "tool",
    );
    if (stepErrorSpan) {
      iterationError = `Backend step failed mid-turn: ${stepErrorSpan.name}`;
      logger.error(
        `[evals] runAssistantTurn turnTrace has non-tool error-status span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`,
      );
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
  // PR 4d review fix (Codex P2 / Cursor Medium): prepend the resolved
  // system at persistence so the backend's transcript carries it.
  // Engine sent it via `runAssistantTurn`'s `systemPrompt:` arg.
  const persistedBackendMessages: ModelMessage[] =
    backendEnhancedSystemPromptForPersist
      ? [
          {
            role: "system",
            content: backendEnhancedSystemPromptForPersist,
          },
          ...messageHistory,
        ]
      : messageHistory;

  const finishParams = {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: persistedBackendMessages,
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
  /** Raw suite hostConfig record. PR 4d — see RunIterationBaseParams. */
  suiteHostConfig?: Record<string, unknown> | null;
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
    suiteHostConfig,
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
        suiteHostConfig,
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
        suiteHostConfig,
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
      suiteHostConfig,
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
  suiteHostConfig,
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
        suiteHostConfig,
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
  suiteHostConfig,
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
  // PR 4d of the engine consolidation (`~/mcpjam-docs/unification.md`):
  // resolve `systemPrompt` and `temperature` via the shared
  // `resolveExecutionContext` so the suite-level hostConfig's
  // `systemPrompt` / `temperature` act as defaults under the per-case
  // `advancedConfig` overrides. Pre-4d the runner ignored
  // `suiteHostConfig.systemPrompt` / `.temperature` entirely — even
  // though the eval client deliberately omits suite defaults from per-case
  // advancedConfig (see comment at
  // `client/src/components/evals/use-eval-handlers.ts:302`) on the
  // understanding that the runtime applies them. `override-wins`
  // precedence keeps per-case overrides authoritative; the hostConfig
  // fills the gap when the per-case value is absent.
  //
  // `withHostContextSystemPrompt` runs AFTER the resolver because
  // `{{var}}` substitution context is per-RUN
  // (`test.hostConfigOverride.hostContext`), not part of the suite
  // hostConfig.
  const resolvedExecution = resolveExecutionContext({
    hostConfig: suiteHostConfig ?? null,
    overrides: {
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
    },
    precedence: "override-wins",
  });
  const system = withHostContextSystemPrompt(
    resolvedExecution.systemPrompt,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature = resolvedExecution.temperature;
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
  // PR 5a of the engine consolidation (`~/mcpjam-docs/unification.md`):
  // streaming-runner equivalents of PR 4b's `iterationError` /
  // `iterationErrorDetails` hoists. The streaming runner historically
  // threw on driver failures and relied on the outer catch; PR 5a
  // adopts the non-stream runner's three-signal failure detection
  // (no-new-messages, non-tool error span) which records the failure
  // via `status:"completed"` + `error` on `finishParams` so the run
  // continues to complete cleanly while flagging the failure.
  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  // PR 4d review fix (CodeRabbit): hoisted so persistence sites in the
  // success + catch paths can prepend the resolved system prompt to
  // the messages array. Mirrors `enhancedSystemPromptForPersist` in
  // `runIterationWithAiSdk`. Empty when `prepareChatV2` throws before
  // returning.
  let streamEnhancedSystemPromptForPersist: string | undefined = undefined;
  // PR 4d review fix (Cursor Low "Stream snapshots drop system prompt"):
  // PR 4d dropped the `conversationMessages.push({role:"system"})` in
  // this runner, but `buildTraceSnapshotEvent` reads from those arrays
  // mid-run — live SSE traces during a streamed quick run no longer
  // include the resolved system until the final persistence prepend.
  // Wrap message slices with the system prefix everywhere the SSE
  // snapshot consumes them so trace UI viewers see the system as the
  // first message throughout the run.
  const withSystemPrefix = (msgs: ModelMessage[]): ModelMessage[] =>
    streamEnhancedSystemPromptForPersist
      ? [
          {
            role: "system",
            content: streamEnhancedSystemPromptForPersist,
          },
          ...msgs,
        ]
      : msgs;

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
    // PR 4d review fix (CodeRabbit "Use the dedicated system: field in
    // streamIterationWithAiSdk"): align the streaming local-BYOK runner
    // with the non-stream variant's chat-aligned shape. Pre-fix this
    // runner pushed the system into `conversationMessages` AND omitted
    // `system:` on the `streamText({...})` call below, so a streamed
    // eval and a non-stream eval of the same case produced different
    // transcript shapes. Now the system flows via the dedicated
    // `system:` field, the runner-side `conversationMessages` stays
    // system-free, and persistence prepends the resolved value at write
    // time (mirroring the non-stream runner's PR 4d Codex P2 fix).
    streamEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;

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

    // PR 5a abort helpers — mirror the non-stream runner's pattern so
    // a cancellation between consume and check drops the iteration
    // record without persisting cancelled state.
    const localIsAborted = () => abortSignal?.aborted === true;
    const returnLocalCancelled = () => ({
      evaluation: evaluateMultiTurnResults(
        promptTurns,
        toolsCalledByPrompt,
        test.isNegativeTest,
        test.matchOptions,
      ),
      iterationId: undefined,
    });

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      if (localIsAborted()) return returnLocalCancelled();
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      // PR 5a invariant (mirror PR 4b round 2): push the user prompt to
      // `conversationMessages` BEFORE the driver call so a failed turn
      // still records the prompt in the persisted transcript. Without
      // this, suite UI shows an empty failed iteration that's
      // unactionable.
      conversationMessages.push({ role: "user", content: promptTurn.prompt });
      activePromptInputMessages = [...conversationMessages];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;

      emit({
        type: "turn_start",
        turnIndex: promptIndex,
        prompt: promptTurn.prompt,
      });

      // PR 5a: drive `runDirectChatTurn`. The helper owns the streamText
      // config, span recording, abort wiring, progressive-discovery
      // gating, and prepareStep. Eval owns SSE event emission (via the
      // adapter on `handle.result.fullStream`), failure detection,
      // persistence, and grading.
      //
      // `traceEvents.onStepSnapshot` is the eval-side per-step hook:
      // increment step counter, mirror partial state (so the outer
      // catch + no-msg fallback can persist a partial transcript),
      // update accumulatedUsage from `traceTurn.turnUsage` delta (so
      // mid-run `trace_snapshot` events show running totals, and the
      // PR 4b "totalUsage merged BEFORE failure branches" invariant
      // holds — each completed step's usage lands before the next
      // potential failure branch fires), and emit the `trace_snapshot`
      // SSE event with `withSystemPrefix` applied.
      const promptInputLength = activePromptInputMessages.length;
      const accumulatedUsageBeforeTurn = {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      };
      const handle = runDirectChatTurn({
        llmModel,
        modelId: test.model,
        messageHistory: activePromptInputMessages,
        // Cursor PR 5a review fix (also applies to PR 4b's non-stream
        // runner): anchor trace span offsets to the iteration start so
        // multi-turn timelines don't collapse to start-at-zero per
        // turn. The helper defaults to `Date.now()` for the chat /
        // single-turn case.
        traceStartedAt: runStartedAt,
        systemPrompt: prepared.enhancedSystemPrompt ?? "",
        ...(prepared.resolvedTemperature == null
          ? {}
          : { temperature: prepared.resolvedTemperature }),
        tools: prepared.allTools,
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        ...(abortSignal ? { abortSignal } : {}),
        ...(toolChoice
          ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
          : {}),
        experimentalTelemetry: {
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
        traceEvents: {
          onStepSnapshot: ({ traceHistory, traceTurn }) => {
            activeCompletedStepCount += 1;
            // Slice from `promptInputLength` to get just this turn's
            // running response (PR 4d pattern).
            activePartialResponseMessages = traceHistory.slice(
              promptInputLength,
            ) as ModelMessage[];
            // Recompute accumulatedUsage from this turn's cumulative
            // usage so far + the snapshot taken at turn start. This
            // keeps the running total correct across multi-turn runs
            // AND across the failure branches below (since the
            // accumulated value is up-to-date by the time the
            // for-await loop returns).
            accumulatedUsage.inputTokens =
              accumulatedUsageBeforeTurn.inputTokens +
              (traceTurn.turnUsage?.inputTokens ?? 0);
            accumulatedUsage.outputTokens =
              accumulatedUsageBeforeTurn.outputTokens +
              (traceTurn.turnUsage?.outputTokens ?? 0);
            accumulatedUsage.totalTokens =
              accumulatedUsageBeforeTurn.totalTokens +
              (traceTurn.turnUsage?.totalTokens ?? 0);
            const snapshotMessages = [
              ...activePromptInputMessages,
              ...activePartialResponseMessages,
            ];
            emit(
              buildTraceSnapshotEvent({
                turnIndex: promptIndex,
                stepIndex: activeCompletedStepCount - 1,
                snapshotKind: "step_finish",
                messages: withSystemPrefix(snapshotMessages),
                // Spans available on `traceTurn.turnSpans` so we don't
                // need to reach into the closed-over handle, which the
                // arrow function can't reference yet during option
                // construction.
                spans: [...recordedSpans, ...traceTurn.turnSpans],
                actualToolCalls: extractToolCallsFromConversation({
                  messages: snapshotMessages,
                }),
                usage: accumulatedUsage,
              }),
            );
          },
        },
      });
      // `runDirectChatTurn` exposes its internal traceContext so eval
      // can fold its spans into `recordedSpans` after each turn,
      // matching the per-turn cadence the old in-runner `activeTraceCtx`
      // used.
      activeTraceCtx = handle.traceContext;

      // Cursor PR 5a review fix (Low "Stream throw skips handle
      // cleanup"): wrap the stream drain + terminal-promise reads in a
      // try/finally so `handle.cleanup()` always runs (idempotent), even
      // when `consumeFullStreamAsEvalEvents` or any subsequent await
      // throws into the outer catch. The abort listener inside the
      // helper would otherwise leak when control jumps to a scope where
      // `handle` is unreachable.
      try {
        // Drive the stream via the shared adapter — emits text_delta /
        // tool_call / tool_result / step_finish SSE events. The runner
        // owns the step counter via `getStepIndex` so the adapter stays
        // stateless.
        await consumeFullStreamAsEvalEvents(handle.result.fullStream, {
          emit,
          getStepIndex: () => activeCompletedStepCount,
        });

        // PR 5a abort check (mirror PR 4b): streamText can swallow
        // AbortError silently when the underlying fetch is cancelled.
        // Check the outer signal directly after the for-await loop
        // resolves so cancelled runs drop without persisting.
        if (handle.isAborted() || localIsAborted()) {
          logger.debug(
            "[evals] streaming local-BYOK iteration aborted mid-turn; skipping record",
          );
          return returnLocalCancelled();
        }

      // Cursor PR 5a review round 2 fix (Medium "Streaming omits
      // totalUsage before failures"): the per-step delta-update inside
      // `onStepSnapshot` only captures usage for steps where the
      // snapshot fired. If the stream resolves with zero completed
      // steps — the same path the no-content failure branch handles —
      // `accumulatedUsage` stays at the pre-turn baseline even when
      // `handle.result.totalUsage` reports billed tokens. The
      // non-stream runner (PR 4b) reads `headless.totalUsage` and
      // merges before failure branches; PR 5a now does the same.
      // Reconciles to the canonical post-stream total so failure
      // branches + finishParams see the real billed value.
      const finalTurnUsage = await handle.result.totalUsage;
      accumulatedUsage.inputTokens =
        accumulatedUsageBeforeTurn.inputTokens +
        (finalTurnUsage?.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        accumulatedUsageBeforeTurn.outputTokens +
        (finalTurnUsage?.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        accumulatedUsageBeforeTurn.totalTokens +
        (finalTurnUsage?.totalTokens ?? 0);

      // After stream completes, resolve the helper's terminal promises.
      const steps = await handle.result.steps;
      const responseObj = await handle.result.response;
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

      // PR 5a failure-detection (mirror PR 4b / 4d three-signal shape):
      //   (a) No new messages → driver returned nothing (network
      //       failure, model returned empty, …).
      //   (b) Non-tool error span captured during the run (LLM step
      //       failure, scrub failure, …). Tool error spans
      //       (category "tool") flow through the existing
      //       `failOnToolError` gate below — DON'T treat them as cycle
      //       failures here.
      // `accumulatedUsage` is already up-to-date from the last
      // `onStepSnapshot`, so failure branches inherit correct token
      // totals (PR 4b "totalUsage before failure" invariant).
      if (promptResponseMessages.length === 0) {
        iterationError =
          "Stream returned no content (local-BYOK driver failed)";
        logger.error(
          "[evals] streamText returned no new messages this turn; treating as cycle failure",
        );
        recordedSpans.push(...activeTraceCtx.recordedSpans);
        toolsCalledByPrompt.push([]);
        // Cursor PR 5a review fix (Medium "Soft failure skips streaming
        // error events"): emit the failure trace_snapshot + error event
        // before `break` so live SSE consumers see the failure signal
        // immediately. Without these, a turn that already emitted
        // `turn_start` ends silently from the consumer's POV.
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            ...(activeCompletedStepCount > 0
              ? { stepIndex: activeCompletedStepCount - 1 }
              : {}),
            snapshotKind: "failure",
            messages: withSystemPrefix(activePromptInputMessages),
            spans: recordedSpans,
            actualToolCalls: extractToolCallsFromConversation({
              messages: activePromptInputMessages,
            }),
            usage: accumulatedUsage,
          }),
        );
        emit({ type: "error", message: iterationError });
        handle.cleanup();
        break;
      }
      const stepErrorSpan = activeTraceCtx.recordedSpans.find(
        // Codex PR 5a review fix (also applies to PR 4b's non-stream
        // runner): when a tool call fails, `wrapToolSetForEvalTrace`
        // records BOTH a `category:"tool"` span AND a child
        // `category:"error"` span carrying `toolCallId`/`toolName`
        // (see eval-trace-capture.ts:258-275). The simple
        // `category !== "tool"` filter catches the child error span
        // and treats failed tool calls as cycle failures even when
        // `advancedConfig.failOnToolError === false`. Excluding any
        // span associated with a tool (carries `toolCallId`) restores
        // the intended deferral to the `failOnToolError` gate.
        (span) =>
          span.status === "error" &&
          span.category !== "tool" &&
          !(span as { toolCallId?: string }).toolCallId,
      );
      if (stepErrorSpan) {
        iterationError = `Local-BYOK step failed mid-turn: ${stepErrorSpan.name}`;
        logger.error(
          `[evals] streamText recorded non-tool error span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`,
        );
        recordedSpans.push(...activeTraceCtx.recordedSpans);
        toolsCalledByPrompt.push(
          extractToolCallsFromConversation({
            steps,
            messages: promptResponseMessages,
          }),
        );
        // PR 4b review fix (Cursor "Step error drops assistant
        // transcript"): merge the partial response into
        // `conversationMessages` so persisted iterations include
        // whatever the model produced before the failure.
        conversationMessages = [
          ...activePromptInputMessages,
          ...promptResponseMessages,
        ];
        // Cursor PR 5a review fix (Medium "Soft failure skips
        // streaming error events"): emit the failure trace_snapshot +
        // error event before `break` (mirror the no-msg branch above).
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            ...(activeCompletedStepCount > 0
              ? { stepIndex: activeCompletedStepCount - 1 }
              : {}),
            snapshotKind: "failure",
            messages: withSystemPrefix(conversationMessages),
            spans: recordedSpans,
            actualToolCalls: extractToolCallsFromConversation({
              messages: conversationMessages,
            }),
            usage: accumulatedUsage,
          }),
        );
        emit({ type: "error", message: iterationError });
        handle.cleanup();
        break;
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
      // Note: `accumulatedUsage` was updated incrementally via
      // `onStepSnapshot`; no post-loop merge needed.

        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            snapshotKind: "turn_finish",
            messages: withSystemPrefix(conversationMessages),
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
      } finally {
        // Cursor PR 5a review fix (Low "Stream throw skips handle
        // cleanup"): unconditional cleanup. Idempotent (the helper
        // tracks `listenerAttached`), so the existing explicit
        // `handle.cleanup()` calls inside the failure branches above
        // are now safe redundancies — kept there for symmetry with
        // PR 4b's pattern, but the real guarantee is here.
        handle.cleanup();
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
      // PR 5a (mirror PR 4b): if the per-turn loop set `iterationError`
      // via the failure-detection branch, feed it to the gate so a
      // failed cycle doesn't sneak through as a verdict pass on
      // negative tests / zero-expected-tool cases.
      iterationError,
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
    // PR 4d review fix (CodeRabbit): prepend the resolved system at
    // persistence time so the streamed eval's transcript matches the
    // non-stream runner's shape (`role: "system"` first entry).
    const persistedStreamMessages: ModelMessage[] =
      streamEnhancedSystemPromptForPersist
        ? [
            {
              role: "system",
              content: streamEnhancedSystemPromptForPersist,
            },
            ...conversationMessages,
          ]
        : conversationMessages;

    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage: usageFinal,
      messages: persistedStreamMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
      // PR 5a (mirror PR 4b): if the per-turn loop set `iterationError`
      // via the failure-detection branch, surface it on the persisted
      // iteration via `status:"completed"` + `error` — the run
      // completed cleanly but the cycle failed.
      ...(iterationError ? { error: iterationError } : {}),
      ...(iterationErrorDetails ? { errorDetails: iterationErrorDetails } : {}),
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
        messages: withSystemPrefix(failMessages),
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

    // PR 4d review fix (CodeRabbit): mirror the non-stream runner — if
    // `prepared` populated the resolved system prompt before the throw,
    // prepend it to the persisted failure transcript.
    const persistedStreamFailMessages: ModelMessage[] =
      streamEnhancedSystemPromptForPersist
        ? [
            {
              role: "system",
              content: streamEnhancedSystemPromptForPersist,
            },
            ...failMessages,
          ]
        : failMessages;

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: evaluation.toolsCalled,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      messages: persistedStreamFailMessages,
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
  suiteHostConfig,
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
  // PR 4d of the engine consolidation: same resolver shape as
  // `runIterationWithAiSdk` above — suite hostConfig provides defaults,
  // per-case `advancedConfig` overrides win. `withHostContextSystemPrompt`
  // applies {{var}} substitution on the resolved value.
  const resolvedExecution = resolveExecutionContext({
    hostConfig: suiteHostConfig ?? null,
    overrides: {
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
    },
    precedence: "override-wins",
  });
  const systemPrompt = withHostContextSystemPrompt(
    resolvedExecution.systemPrompt,
    test.hostConfigOverride?.hostContext as
      | Record<string, unknown>
      | undefined,
  );
  const temperature = resolvedExecution.temperature;
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
  // PR 4d review fix (Codex P2 / Cursor Medium): hoisted up-front (above
  // the `prepareChatV2` try) so the catch path and the assignment
  // inside the try are both in scope. Stays `undefined` if prepareChatV2
  // throws — the setup-failure persistence path doesn't need a system
  // prefix.
  let backendEnhancedSystemPromptForPersist: string | undefined = undefined;
  // PR 5a folds in the deferred 4d Cursor-Low fix: mid-run SSE
  // snapshot events (`buildTraceSnapshotEvent`) in this streaming
  // backend variant read from `messageHistory` directly. PR 4d
  // round 2 added a `withSystemPrefix` closure to
  // `streamIterationWithAiSdk` but deferred the equivalent here.
  // The full runner-engine collapse stays for PR 5b; the
  // snapshot-prefix shape is small and isolated, so it folds into
  // PR 5a alongside the local stream rewrite. Closes the
  // "live-on-main UI gap" risk entry in unification.md.
  const withSystemPrefix = (msgs: ModelMessage[]): ModelMessage[] =>
    backendEnhancedSystemPromptForPersist
      ? [
          {
            role: "system",
            content: backendEnhancedSystemPromptForPersist,
          },
          ...msgs,
        ]
      : msgs;
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
    // PR 4d review fix (Codex P2 / Cursor Medium): same persistence
    // prefix shape as the non-stream backend runner.
    backendEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
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
    // Mirror the in-stream failure signal `streamIterationWithAiSdk` already
    // sends from its outer catch. Without this, the live test-runner UI
    // watching `streamTestCase` SSE finishes silently on hosted-model /
    // hosted-org-BYOK setup errors while the local-AI-SDK stream variant
    // emits an `error` event for the same failure mode.
    emit({
      type: "error",
      message: errorMessage,
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

  // PR 5b: drive the per-turn loop through `runAssistantTurn` (the same
  // engine chat / playground / synthetic / non-stream eval already use).
  // Engine owns the Convex `/stream` per-step loop, tool execution,
  // trace persistence, abort plumbing, progressive discovery, and
  // approval handling. Eval owns the per-turn `runAssistantTurn` call,
  // SSE callback wiring (text deltas via `onLiveTextDelta`, tool
  // call/result/step events via the PR 5b-pre callbacks), failure
  // detection, persistence, and grading.
  //
  // `runAssistantTurn` reads `authContext.token` and forwards it as the
  // Authorization header on the per-step Convex fetch — same shape used
  // by `runIterationViaBackend` above (PR 3/4d).
  const evalAuthContext = {
    kind: "user_bearer" as const,
    token: `Bearer ${convexAuthToken}`,
  };

  // Cursor review fix (mirrors PR 4b for the non-stream backend
  // runner): the engine swallows AbortError internally (sets its
  // `aborted` flag, omits `turnTrace`, doesn't throw out of
  // `runAssistantTurn`). Read `abortSignal.aborted` directly as the
  // authoritative cancellation signal, used at the top of each
  // iteration AND after every per-turn call (success or catch).
  const isAborted = () => abortSignal?.aborted === true;
  const returnCancelled = () => ({
    evaluation: evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
      test.matchOptions,
    ),
    iterationId: undefined,
  });

  let accumulatedUsage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  const capturedSpans: EvalTraceSpan[] = [];
  // PR 4d review fix (Codex P2 / Cursor Medium): see hoist above the
  // `prepareChatV2` try.
  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    if (isAborted()) {
      logger.debug(
        "[evals] backend streaming iteration aborted between turns; skipping record",
      );
      return returnCancelled();
    }

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

    // Per-turn span-capture context. `wrapToolSetForEvalTrace`
    // instruments each tool's `execute` to push to
    // `traceCtx.recordedSpans`; we drain into `capturedSpans` after the
    // engine finishes (same shape as the non-stream backend runner).
    const traceCtx = createAiSdkEvalTraceContext(runStartedAt);
    const tracedTools = wrapToolSetForEvalTrace(
      prepared.allTools,
      traceCtx,
      promptIndex,
    );

    const messageCountBeforeTurn = messageHistory.length;
    const inputMessages: ModelMessage[] = [...messageHistory];
    const accumulatedUsageBeforeTurn = {
      inputTokens: accumulatedUsage.inputTokens ?? 0,
      outputTokens: accumulatedUsage.outputTokens ?? 0,
      totalTokens: accumulatedUsage.totalTokens ?? 0,
    };
    // Track engine-emitted step events so the post-turn `turn_finish`
    // trace_snapshot has a stable last-step index, and so failure
    // branches can carry stepIndex when available.
    let activeCompletedStepCount = 0;
    let lastSettledStepIndex: number | undefined;

    // Engine callbacks → SSE events. These mirror the events the old
    // inline backend stream loop emitted from its chunk-processing
    // switch:
    //  - `onToolCall`     → `tool_call` SSE (was `tool-input-available`
    //                       chunk branch).
    //  - `onToolResult`   → `tool_result` SSE (was post-tool-execution
    //                       loop over new tool messages).
    //  - `onStepFinish`   → `step_finish` SSE + step_finish trace
    //                       snapshot, gated on `settledWithError ===
    //                       false` per Marcelo's PR 5b-pre review
    //                       caveat. Failed backend steps surface via
    //                       the failure detection branches below; we
    //                       don't emit `step_finish` for them.
    // `onLiveTextDelta`  → `text_delta` SSE (was the `text-delta`
    //                       chunk branch).
    //
    // `promptToolsCalled` mirrors the legacy local accumulator; the
    // engine's `messageHistory` is the source of truth post-turn, so
    // we also rebuild from there for the eval grader (see
    // `extractToolCallsFromConversation` below). Pushing into
    // `promptToolsCalled` here keeps the SSE consumer's running view
    // aligned with the trace snapshot's `actualToolCalls`.
    const onLiveTextDelta = (delta: string) => {
      if (typeof delta === "string" && delta.length > 0) {
        emit({ type: "text_delta", content: delta });
      }
    };
    const onToolCall = (event: MCPJamToolCallEvent) => {
      if (!event.toolName) return;
      const args = (event.input ?? {}) as Record<string, unknown>;
      promptToolsCalled.push({
        toolName: event.toolName,
        arguments: args as Record<string, any>,
      });
      emit({
        type: "tool_call",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args,
      });
    };
    const onToolResult = (event: MCPJamToolResultEvent) => {
      emit({
        type: "tool_result",
        toolCallId: event.toolCallId,
        result: event.output,
        isError: event.isError,
      });
    };
    const onStepFinish = (event: MCPJamStepFinishEvent) => {
      // Marcelo's PR 5b-pre review caveat: only emit `step_finish` for
      // settled-OK steps; failed backend steps surface through the
      // post-turn failure detection (no `turnTrace`, error span, etc).
      if (event.settledWithError) return;
      activeCompletedStepCount += 1;
      lastSettledStepIndex = event.stepIndex;
      // Per-step usage delta = current cumulative - pre-turn baseline +
      // last step's running total. The engine reports turn-cumulative
      // usage on each onStepFinish; recompute accumulated usage from
      // the snapshot taken at turn start so mid-run trace_snapshot
      // events show the right running total even when this is step N
      // of a multi-step turn.
      accumulatedUsage.inputTokens =
        accumulatedUsageBeforeTurn.inputTokens +
        (event.turnUsage?.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        accumulatedUsageBeforeTurn.outputTokens +
        (event.turnUsage?.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        accumulatedUsageBeforeTurn.totalTokens +
        (event.turnUsage?.totalTokens ?? 0);
      emit({
        type: "step_finish",
        stepNumber: activeCompletedStepCount,
        usage: {
          inputTokens: event.turnUsage?.inputTokens ?? 0,
          outputTokens: event.turnUsage?.outputTokens ?? 0,
        },
      });
      // Live trace snapshot for the step. Spans accumulate on
      // `traceCtx.recordedSpans` (tool spans) + the engine's own LLM
      // step spans (delivered on `turnResult.turnTrace.spans` AFTER
      // the turn finishes). Mid-turn we only have the tool spans; the
      // engine's LLM-step spans land at `turn_finish`.
      const snapshotMessages = [...messageHistory];
      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          stepIndex: event.stepIndex,
          snapshotKind: "step_finish",
          messages: withSystemPrefix(snapshotMessages),
          spans: [...capturedSpans, ...traceCtx.recordedSpans],
          actualToolCalls: extractToolCallsFromConversation({
            messages: snapshotMessages,
          }),
          usage: accumulatedUsage,
        }),
      );
    };

    // `runAssistantTurn` call shape mirrors `runIterationViaBackend`
    // (the non-stream backend runner) with SSE callback wires added.
    // The contract bullets carried since PR 5a:
    //  - Wire shape: `systemPrompt:` arg (engine sends `system:` field
    //    to Convex `/stream`).
    //  - Persistence prefix: `backendEnhancedSystemPromptForPersist`
    //    prepended at finishParams (see post-loop section).
    //  - SSE prefix: `withSystemPrefix` applied at every
    //    `buildTraceSnapshotEvent` call site.
    //  - Eval correctness invariants: progressive discovery, skill
    //    tools, anthropic name validation flow from `prepareChatV2`.
    //  - Resolver wire-up: `resolveExecutionContext` + suite
    //    hostConfig already in place (PR 4d).
    //  - UI event contract preserved: text_delta / tool_call /
    //    tool_result / step_finish / turn_finish / trace_snapshot all
    //    still emit in the same order as the legacy inline loop.
    const mergedExtraBodyFields: Record<string, unknown> = {
      maxOutputTokens: 16384,
      ...(extraBodyFields ?? {}),
      ...(toolChoice ? { toolChoice } : {}),
    };

    let turnResult: Awaited<ReturnType<typeof runAssistantTurn>>;
    try {
      turnResult = await runAssistantTurn({
        messages: inputMessages,
        modelDefinition: { ...modelDefinition, id: modelId },
        systemPrompt: prepared.enhancedSystemPrompt,
        ...(prepared.resolvedTemperature != null
          ? { temperature: prepared.resolvedTemperature }
          : {}),
        tools: tracedTools,
        ...(selectedServers.length
          ? { selectedServerIds: selectedServers }
          : {}),
        mcpClientManager,
        authContext: evalAuthContext,
        sourceType: "eval",
        origin: "eval",
        streamSink: "none",
        persistMode: "caller",
        approvalMode: "auto-deny",
        endpointPath,
        extraBodyFields: mergedExtraBodyFields,
        ...(abortSignal ? { abortSignal } : {}),
        maxSteps: MAX_STEPS,
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        onLiveTextDelta,
        onToolCall,
        onToolResult,
        onStepFinish,
      });
    } catch (error) {
      // Cancellation: bail without recording. AbortError can surface
      // either as a thrown exception or as the engine's internal
      // silent-cancellation path; check `isAborted()` to catch both.
      if (
        isAborted() ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        logger.debug(
          "[evals] backend streaming iteration aborted due to cancellation",
        );
        return returnCancelled();
      }

      if (error instanceof Error) {
        iterationError = error.message || error.toString();
        const responseBody = (error as { responseBody?: unknown })
          .responseBody;
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
      logger.error("[evals] runAssistantTurn (stream) failed", error);
      // Mirror the in-stream failure signal the legacy inline loop
      // emitted: failure trace_snapshot + error event before `break`
      // so live SSE consumers don't see a silent end.
      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          ...(lastSettledStepIndex != null
            ? { stepIndex: lastSettledStepIndex }
            : {}),
          snapshotKind: "failure",
          messages: withSystemPrefix(messageHistory),
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

    // Cancellation that fired DURING `runAssistantTurn` without
    // surfacing as a throw (engine catches AbortError, sets internal
    // `aborted` flag, omits `turnTrace`, returns normally).
    if (isAborted()) {
      logger.debug(
        "[evals] backend streaming iteration aborted mid-turn; skipping record",
      );
      return returnCancelled();
    }

    // Drain per-turn outputs into iteration-level accumulators BEFORE
    // failure checks. Same shape as `runIterationViaBackend` (PR 3/4d).
    //
    // Tool spans from `wrapToolSetForEvalTrace` land in
    // `traceCtx.recordedSpans` with `stepIndex: -1` (no `prepareStep`
    // bridge to the engine yet); the engine's own LLM-step spans land
    // on `turnResult.turnTrace.spans` with correct per-step indices.
    // Merge both for the persisted run.
    capturedSpans.push(...traceCtx.recordedSpans);
    if (turnResult.turnTrace?.spans?.length) {
      capturedSpans.push(...turnResult.turnTrace.spans);
    }
    // Reconcile accumulated usage to the engine's canonical post-turn
    // total. The per-step `onStepFinish` callback already updates
    // `accumulatedUsage` for each completed step, but if the engine
    // resolved with zero settled-OK steps (no-content failure path),
    // the baseline is the only source of truth — fold in `turnTrace.usage`
    // to match the non-stream runner's "totalUsage merged BEFORE
    // failure branches" invariant from PR 4b.
    if (turnResult.usage) {
      accumulatedUsage.inputTokens =
        accumulatedUsageBeforeTurn.inputTokens +
        (turnResult.usage.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        accumulatedUsageBeforeTurn.outputTokens +
        (turnResult.usage.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        accumulatedUsageBeforeTurn.totalTokens +
        (turnResult.usage.totalTokens ?? 0);
    }

    // Per-turn tool calls — rebuild from the new messages only so
    // prior turns' calls aren't double-counted. The engine returns
    // the full transcript; slice from `messageCountBeforeTurn`.
    const newMessages = turnResult.messages.slice(messageCountBeforeTurn);
    // `promptToolsCalled` was already populated via the `onToolCall`
    // callback during the run. Reconcile against the engine's
    // transcript so the grader sees the canonical post-turn shape
    // (handles cases where `onToolCall` arguments were `undefined`).
    const canonicalPromptToolsCalled = extractToolCallsFromConversation({
      messages: newMessages,
    });
    promptToolsCalled.length = 0;
    promptToolsCalled.push(...canonicalPromptToolsCalled);

    // Roll the engine's transcript forward as the next turn's input.
    messageHistory.length = 0;
    messageHistory.push(...turnResult.messages);

    // Failure detection — same three-signal shape as the non-stream
    // backend runner (PR 3/4d):
    //   (a) Engine catch fired mid-turn (`!turnTrace`) — engine
    //       runSucceeded=false, partial messages may exist.
    //   (b) Engine succeeded but produced no new content
    //       (`newMessages.length === 0`).
    //   (c) Engine succeeded and produced content, but a later step
    //       errored (non-tool error span on `turnTrace.spans`).
    if (!turnResult.turnTrace) {
      iterationError =
        "Backend stream failed during iteration (engine caught an error mid-turn)";
      logger.error(
        `[evals] runAssistantTurn (stream) returned no turnTrace (engine runSucceeded=false); treating as cycle failure (messagesGrew=${newMessages.length > 0})`,
      );
      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          ...(lastSettledStepIndex != null
            ? { stepIndex: lastSettledStepIndex }
            : {}),
          snapshotKind: "failure",
          messages: withSystemPrefix(messageHistory),
          spans: capturedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: messageHistory,
          }),
          usage: accumulatedUsage,
        }),
      );
      emit({ type: "error", message: iterationError });
      break;
    }
    if (newMessages.length === 0) {
      iterationError =
        "Backend step returned no content (stream error or empty response)";
      logger.error(
        "[evals] runAssistantTurn (stream) produced no new messages this turn; treating as cycle failure",
      );
      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          ...(lastSettledStepIndex != null
            ? { stepIndex: lastSettledStepIndex }
            : {}),
          snapshotKind: "failure",
          messages: withSystemPrefix(messageHistory),
          spans: capturedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: messageHistory,
          }),
          usage: accumulatedUsage,
        }),
      );
      emit({ type: "error", message: iterationError });
      break;
    }
    // Cursor / Codex PR 5a review fix applied here too: filter to
    // backend step / LLM failure spans only (exclude `category: "tool"`
    // AND any span carrying a `toolCallId` — the child error span that
    // `wrapToolSetForEvalTrace` emits alongside a failed tool span).
    // Tool-category error spans flow through the `failOnToolError`
    // gate below; treating them as cycle failures here would defeat
    // that policy.
    const stepErrorSpan = turnResult.turnTrace.spans.find(
      (span) =>
        span.status === "error" &&
        span.category !== "tool" &&
        !(span as { toolCallId?: string }).toolCallId,
    );
    if (stepErrorSpan) {
      iterationError = `Backend step failed mid-turn: ${stepErrorSpan.name}`;
      logger.error(
        `[evals] runAssistantTurn (stream) turnTrace has non-tool error-status span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`,
      );
      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          ...(lastSettledStepIndex != null
            ? { stepIndex: lastSettledStepIndex }
            : {}),
          snapshotKind: "failure",
          messages: withSystemPrefix(messageHistory),
          spans: capturedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: messageHistory,
          }),
          usage: accumulatedUsage,
        }),
      );
      emit({ type: "error", message: iterationError });
      break;
    }

    emit(
      buildTraceSnapshotEvent({
        turnIndex: promptIndex,
        snapshotKind: "turn_finish",
        messages: withSystemPrefix(messageHistory),
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
  // PR 4d review fix (Codex P2 / Cursor Medium): prepend the resolved
  // system at persistence so the backend's transcript carries it.
  // Engine sent it via `runAssistantTurn`'s `systemPrompt:` arg.
  const persistedBackendMessages: ModelMessage[] =
    backendEnhancedSystemPromptForPersist
      ? [
          {
            role: "system",
            content: backendEnhancedSystemPromptForPersist,
          },
          ...messageHistory,
        ]
      : messageHistory;

  const finishParams = {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: persistedBackendMessages,
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
  /** Raw suite hostConfig record. PR 4d — see RunIterationBaseParams. */
  suiteHostConfig?: Record<string, unknown> | null;
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
    suiteHostConfig,
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
        suiteHostConfig,
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
        suiteHostConfig,
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
      suiteHostConfig,
    });
    outcomes.push(iterationOutcome);
  }

  return outcomes;
};
