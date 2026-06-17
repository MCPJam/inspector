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
import { finalizePassedForEval, type MCPClientManager } from "@mcpjam/sdk";
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
import { resolveHostTools } from "../utils/built-in-tools/registry.js";
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
  summarizeRenderObservations,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../routes/web/errors";
import {
  createSuiteRunRecorder,
  type SuiteRunRecorder,
} from "./evals/recorder";
import { runPinnedTurn } from "./evals/pinned-turn";
import {
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  registerAiSdkPrepareStep,
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
  isPinnedOnly,
  isPinnedTurn,
  legacyProbeToPinnedTurn,
  needsModel,
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PinnedToolCall,
  type PromptTurn,
} from "@/shared/prompt-turns";
import { withHostContextSystemPrompt } from "@/shared/host-context-prompt";
import { normalizeToolChoice, type EvalToolChoice } from "@/shared/tool-choice";
import {
  prepareChatV2,
  type PrepareChatV2Result,
} from "../utils/chat-v2-orchestration.js";
import type {
  MCPJamStepFinishEvent,
  MCPJamToolCallEvent,
  MCPJamToolResultEvent,
} from "../utils/mcpjam-stream-handler.js";
import { driveHostedEvalTurn } from "./evals/drive-hosted-eval-turn.js";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";
import { finalizeEvalIteration } from "./evals/finalize-iteration.js";
import {
  createBrowserSessionContext,
  type BrowserSessionContext,
} from "./browser-session-context.js";
import type {
  EvalStreamEvent,
  EvalStreamToolCall,
} from "@/shared/eval-stream-events";

/**
 * Max render-check (`widget_probe`) cases that may execute at once. Each one
 * launches a headless Chromium (~hundreds of MB), so a monitoring suite full
 * of render checks would otherwise spawn one browser PER case in parallel and
 * exhaust the worker's memory. LLM-only cases are network-bound and run
 * unbounded. Override with MCPJAM_MAX_CONCURRENT_RENDER_CHECKS.
 */
const MAX_CONCURRENT_RENDER_CHECKS = (() => {
  const raw = Number(process.env.MCPJAM_MAX_CONCURRENT_RENDER_CHECKS);
  return Number.isInteger(raw) && raw >= 1 ? raw : 4;
})();

/**
 * Minimal async concurrency limiter: returns a function that runs at most
 * `max` thunks concurrently and queues the rest. A slot is released when its
 * thunk SETTLES (resolve or reject), so a slot can never leak even if the work
 * throws — unlike tying the cap to a browser's dispose() call.
 */
export function createConcurrencyLimiter(max: number) {
  const limit = Math.max(1, max);
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(thunk: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = async () => {
        try {
          resolve(await thunk());
        } catch (err) {
          reject(err);
        } finally {
          active--;
          pump();
        }
      };
      queue.push(run);
      pump();
    });
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
  /**
   * Case kind. Absent ⇒ prompt case. `widget_probe` carries `probeConfig`
   * and skips the LLM path entirely (`runTestCase` forks before any model
   * resolution); `model`/`provider` hold display-only sentinels on probe
   * entries and are never resolved.
   */
  caseType?: import("@/shared/probe-config").TestCaseType;
  /** Pinned tool call for `widget_probe` cases. */
  probeConfig?: import("@/shared/probe-config").ProbeConfig;
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

function getServerLabelForEvalError(
  serverId: string,
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined,
): string {
  const binding = environment?.serverBindings?.find(
    (entry) =>
      entry.projectServerId === serverId ||
      entry.projectServerId?.toLowerCase() === serverId.toLowerCase(),
  );
  return binding?.serverName || serverId;
}

function isMissingRuntimeServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unknown mcp server/i.test(message) ||
    /not connected/i.test(message) ||
    /server .* is not connected/i.test(message)
  );
}

async function getEvalToolsForAiSdkOrThrow(args: {
  mcpClientManager: MCPClientManager;
  serverIds: string[];
  includeAppOnly: boolean;
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined;
}): Promise<ToolSet> {
  const perServerTools = await Promise.all(
    args.serverIds.map(async (serverId) => {
      try {
        return args.includeAppOnly
          ? await args.mcpClientManager.getToolsForAiSdk([serverId], {
              includeAppOnly: true,
            })
          : await args.mcpClientManager.getToolsForAiSdk([serverId]);
      } catch (error) {
        const serverLabel = getServerLabelForEvalError(
          serverId,
          args.environment,
        );
        if (isMissingRuntimeServerError(error)) {
          throw new WebRouteError(
            409,
            ErrorCode.SERVER_UNREACHABLE,
            `Could not start eval because "${serverLabel}" is not connected. Reconnect the server and try again.`,
            { serverId, serverName: serverLabel },
          );
        }
        const cause = error instanceof Error ? error.message : String(error);
        throw new WebRouteError(
          502,
          ErrorCode.SERVER_UNREACHABLE,
          `Could not start eval because "${serverLabel}" failed to list tools. Reconnect the server and try again.`,
          { serverId, serverName: serverLabel, cause },
        );
      }
    }),
  );

  const flattened: ToolSet = {};
  for (const toolset of perServerTools) {
    Object.assign(flattened, toolset);
  }
  return flattened;
}

export function resolveConfiguredServerIds(args: {
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
    availableServerIds.map((serverId) => [serverId.toLowerCase(), serverId])
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

    const normalizedServerId = availableServerIdsSet.has(trimmedServerRef)
      ? trimmedServerRef
      : availableServerIdByLowercase.get(trimmedServerRef.toLowerCase()) ??
        (() => {
          const projectServerId = projectServerIdByName.get(
            trimmedServerRef.toLowerCase()
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
            trimmedServerRef.toLowerCase()
          );
          if (serverName) {
            return (
              (availableServerIdsSet.has(serverName)
                ? serverName
                : undefined) ??
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

/**
 * Represent a legacy `widget_probe` row as a single model-free pinned turn so
 * the unified engine sees ONE shape (routing, server resolution, the iteration
 * loop). Post-migration rows already carry the pinned turn, so this is a no-op
 * for them. Idempotent.
 */
function normalizeTestForPinnedTurns(test: EvalTestCase): EvalTestCase {
  if (
    test.caseType === "widget_probe" &&
    test.probeConfig &&
    !resolvePromptTurns(test).some(isPinnedTurn)
  ) {
    return {
      ...test,
      promptTurns: [legacyProbeToPinnedTurn(test.probeConfig as PinnedToolCall)],
    };
  }
  return test;
}

/**
 * Resolve a pinned turn's server reference (stable id first, display-name
 * fallback) to a connected manager key, through the same binding maps the LLM
 * path uses. `undefined` ⇒ not connected in this run (the iteration records a
 * not-connected failure instead of throwing the whole run away). Lifted from
 * the former `widget_probe` fork.
 */
function resolvePinnedServerKey(
  pinned: PinnedToolCall,
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined,
  selectedServers: string[],
  mcpClientManager: MCPClientManager,
): string | undefined {
  const connected = new Set(selectedServers);
  const candidates = [pinned.serverId, pinned.serverName].filter(
    (ref): ref is string => !!ref,
  );
  for (const candidate of candidates) {
    const [resolved] = resolveConfiguredServerIds({
      environment: {
        servers: [candidate],
        serverBindings: environment?.serverBindings,
      },
      mcpClientManager,
    });
    if (resolved && connected.has(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

function buildPromptTraceSummaries(
  evaluation: MultiTurnEvaluationResult
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
            JSON.stringify(mismatch.actualArgs?.[key])
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
                  JSON.stringify(argumentsValue)
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
                JSON.stringify(argumentsValue)
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
  incomingToolCalls: ToolCall[]
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
    params.toolsCalledByPrompt[params.promptIndex]
  )
    ? params.toolsCalledByPrompt[params.promptIndex]!
    : [];

  params.toolsCalledByPrompt[params.promptIndex] = mergeToolCalls(
    existingToolCalls,
    partialToolCalls
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
      toStreamToolCalls(params.actualToolCalls)
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
  }
): Promise<string | undefined> {
  try {
    const result = await convexClient.mutation(
      "testSuites:recordIterationStartWithoutRun" as any,
      {
        testCaseId: params.testCaseId,
        testCaseSnapshot: sanitizeForConvexTransport(params.testCaseSnapshot),
        iterationNumber: params.iterationNumber,
        startedAt: params.startedAt,
      }
    );

    return result?.iterationId as string | undefined;
  } catch (error) {
    logger.error("[evals] Failed to create iteration:", error);
    return undefined;
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
    await finalizeEvalIteration({
      ...failParams,
      convexClient: args.convexClient,
    });
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
  /**
   * Run environment snapshot (servers + serverBindings). Consulted to resolve
   * a pinned-tool-call turn's server reference (id first, display-name
   * fallback) to a manager key — the same binding maps the LLM path uses for
   * its environment. Absent on quick-run paths that pre-resolve servers.
   */
  environment?: RunEvalSuiteOptions["config"]["environment"];
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
  provider: string
): string | undefined {
  return modelApiKeys?.[provider] ?? modelApiKeys?.[provider.toLowerCase()];
}

function hasBaseUrls(baseUrls: BaseUrls): boolean {
  return Boolean(baseUrls.ollama || baseUrls.azure || baseUrls.bedrock);
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
      `Missing API key for provider ${args.test.provider} (test: ${args.test.title})`
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
  modelApiKeys: Record<string, string> | undefined
): boolean {
  return Boolean(modelApiKeys && Object.keys(modelApiKeys).length > 0);
}

function resolveOrgTargetForEval(
  test: EvalTestCase,
  explicitTarget?: ResolveOrgModelConfigTarget
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
    { bearerToken: args.convexAuthToken }
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
  environment,
}: RunIterationAiSdkParams) => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId }
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions
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
            test.matchOptions
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
    test.hostConfigOverride?.hostContext as Record<string, unknown> | undefined
  );
  const temperature = resolvedExecution.temperature;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  // A case whose turns are ALL pinned tool calls is model-free: every
  // model/BYOK setup step below is skipped (a pinned-only case carries
  // display-only model sentinels that must never reach the runtime resolver,
  // which throws on a missing API key). Hybrid cases keep full model setup;
  // their pinned turns run via runPinnedTurn inside the loop.
  const caseNeedsModel = needsModel({
    caseType: test.caseType,
    promptTurns,
  });
  // First pinned turn's render-budget override; applied to the shared harness.
  const pinnedRenderTimeoutMs = promptTurns.find(
    (t) =>
      isPinnedTurn(t) && typeof t.pinnedToolCall?.renderTimeoutMs === "number",
  )?.pinnedToolCall?.renderTimeoutMs;

  const modelRuntime = caseNeedsModel
    ? resolveEvalModelRuntime({
        test,
        modelDefinition,
        modelApiKeys,
        orgModelConfig,
      })
    : null;

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
  // Tool errors from pinned (model-free) turns. No trace exists for a direct
  // tool call, so these are threaded into the transcript explicitly (the
  // `toolErrors` input to buildIterationTranscript) so `noToolErrors` gates.
  const pinnedToolErrors: ToolErrorRecord[] = [];
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

  // Browser-rendered MCP App eval (PR 5): render MCP App tool results in the
  // headless-Chromium harness and (for models with vision + tool calling) drive
  // them with Computer Use. The shared context owns the harness, the Computer Use tools,
  // the advertised-tool gate, and the artifact collectors; construction is
  // cheap and Chromium launches lazily on the first widget render, so
  // prompt-only / no-widget iterations pay nothing.
  const browser = await createBrowserSessionContext({
    // Model-free (pinned-only) iterations pass no model: no Computer Use, but
    // the harness still renders pinned widgets and records observations.
    ...(caseNeedsModel ? { model: test.model } : {}),
    mcpClientManager,
    injectOpenAiCompat,
    ...(pinnedRenderTimeoutMs ? { renderTimeoutMs: pinnedRenderTimeoutMs } : {}),
  });

  try {
    // Adopt the chat-side tool/system/temperature pipeline. Eval used to skip
    // this and call `getToolsForAiSdk` + an inline system/temperature wiring,
    // missing skill tools, Anthropic name validation, and skills-prompt
    // assembly. Called inside the try so prep failures become a recorded
    // failed iteration rather than an uncaught setup error.
    //
    // `builtInTools` stays absent on this local-AI-SDK BYOK path: built-in
    // tools (web_search) execute via a Convex HTTP action billed in MCPJam
    // credits, and BYOK iterations carry no Convex auth — advertising a tool
    // whose execute can only fail is worse than omitting it. The null-ctx
    // helper call debug-logs when the suite hostConfig requested ids anyway.
    // Model-free (pinned-only) iterations skip tool/system/model prep: there
    // is no LLM to advertise tools to or instantiate. `prepared`/`llmModel`
    // stay null and are only read inside the model-turn branch, unreachable
    // when `caseNeedsModel` is false.
    let prepared: PrepareChatV2Result | null = null;
    let llmModel: ReturnType<typeof createLlmModel> | null = null;
    if (caseNeedsModel) {
      resolveHostTools(
        { builtInToolIds: resolvedExecution.builtInToolIds },
        null
      );
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt: system,
        temperature,
        respectToolVisibility: hostPolicy?.respectToolVisibility,
        customProviders: modelRuntime!.customProviders,
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

      llmModel = createLlmModel(
        modelDefinition,
        modelRuntime!.apiKey,
        modelRuntime!.baseUrls,
        modelRuntime!.customProviders
      );

      if (
        toolChoice &&
        typeof toolChoice === "object" &&
        !Object.hasOwn(prepared.allTools, toolChoice.toolName) &&
        // `computer` / `finish_widget` are merged into the tool map below, so a
        // forced tool choice naming one of them is valid on computer-capable drivers.
        !Object.hasOwn(browser.computerWidgetTools, toolChoice.toolName)
      ) {
        throw new Error(
          `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`
        );
      }
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
        test.matchOptions
      ),
      iterationId: undefined,
    });

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      if (localIsAborted()) return returnLocalCancelled();
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      browser.setActivePromptIndex(promptIndex);

      // Model-free pinned turn: execute the fixed tool call and render its
      // widget through the SAME browser harness the model turns use — no LLM.
      // The pinned call is fixture input, not model behavior, so it is excluded
      // from tool-call matching (see evaluateMultiTurnResults) but still flows
      // into the transcript's toolCalls for predicate visibility.
      if (isPinnedTurn(promptTurn) && promptTurn.pinnedToolCall) {
        await browser.dismissCarriedWidget();
        const pinned = promptTurn.pinnedToolCall;
        const serverKey = resolvePinnedServerKey(
          pinned,
          environment,
          selectedServers,
          mcpClientManager
        );
        const pinnedResult = await runPinnedTurn({
          pinned,
          resolvedServerKey: serverKey,
          mcpClientManager,
          browser,
          promptIndex,
        });
        conversationMessages.push({
          role: "user",
          content: `Pinned tool call: ${pinned.toolName} on "${pinned.serverName}"`,
        });
        conversationMessages.push({
          role: "assistant",
          content: pinnedResult.summary,
        });
        toolsCalledByPrompt.push(
          pinnedResult.toolCall ? [pinnedResult.toolCall] : []
        );
        if (pinnedResult.toolError) {
          pinnedToolErrors.push(pinnedResult.toolError);
        }
        if (pinnedResult.iterationError && !iterationError) {
          iterationError = pinnedResult.iterationError;
        }
        continue;
      }

      // A non-pinned turn implies the case needs the model, which means the
      // gated setup above ran. Narrow the nullable handles for the rest of the
      // loop body (and fail loudly if that invariant is ever violated).
      if (!llmModel || !prepared) {
        throw new Error(
          "eval: model-driven turn reached without model setup (caseNeedsModel invariant violated)"
        );
      }

      // Browser-rendered MCP App eval (PR 5): start each prompt turn with a
      // clean widget surface. A widget kept mounted by a previous turn must not
      // bleed into this one — otherwise Computer Use could be advertised (and
      // `computer` actions routed) against the prior turn's widget before this
      // turn's own MCP App tool runs.
      await browser.dismissCarriedWidget();
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
        tools: { ...prepared.allTools, ...browser.computerWidgetTools },
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        // Browser-rendered MCP App eval (PR 5): gate Computer Use tools so the
        // model only sees `computer` / `finish_widget` once a widget has
        // actually rendered in the harness (PR 2's prepareAdvertisedTools hook).
        ...(browser.prepareAdvertisedTools
          ? { prepareAdvertisedTools: browser.prepareAdvertisedTools }
          : {}),
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
              promptInputLength
            ) as ModelMessage[];
          },
          // Browser-rendered MCP App eval (PR 5): render each MCP App tool
          // result in the harness and record a WidgetRenderObservation. Awaited
          // (direct-chat-turn awaits this callback) so a rendered widget is
          // mounted before the next step's Computer Use gate runs.
          onToolResultChunk: (chunk) =>
            browser.handleDirectToolResultChunk(chunk),
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
          "[evals] local-BYOK iteration aborted mid-turn; skipping record"
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
          promptIndex
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
          "[evals] streamText returned no new messages this turn; treating as cycle failure"
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
          !(span as { toolCallId?: string }).toolCallId
      );
      if (stepErrorSpan) {
        iterationError = `Local-BYOK step failed mid-turn: ${stepErrorSpan.name}`;
        logger.error(
          `[evals] streamText recorded non-tool error span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`
        );
        recordedSpans.push(...activeTraceCtx.recordedSpans);
        toolsCalledByPrompt.push(
          extractToolCallsFromConversation({
            steps: headless.steps,
            messages: promptResponseMessages,
          })
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
      test.matchOptions
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
    // A pinned-only case (today's render check) with no authored predicates
    // defaults to "the widget rendered" — the model-free equivalent of the
    // legacy probe verdict (`toolCallOk && rendered`). An errored/non-renderable
    // pinned call produces no `rendered` observation, so this fails closed.
    // Hybrid/model cases keep the normal match-driven verdict when unauthored.
    const effectivePredicates = test.successPredicates?.length
      ? test.successPredicates
      : isPinnedOnly({ caseType: test.caseType, promptTurns })
        ? ([{ type: "widgetRendered" }] as NonNullable<
            typeof test.successPredicates
          >)
        : undefined;
    const predicateResults = effectivePredicates?.length
      ? evaluatePredicates(
          buildIterationTranscript({
            trace: traceForGate,
            toolCalls: evaluation.toolsCalled,
            usage: hasReportedUsage(accumulatedUsage)
              ? accumulatedUsage
              : undefined,
            renderObservations: summarizeRenderObservations(
              browser.widgetRenderObservations,
            ),
            // Pinned turns have no trace; thread their tool errors explicitly.
            toolErrors: pinnedToolErrors,
          }),
          effectivePredicates
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
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
      messages: conversationMessages,
      mcpClientManager,
      convexClient,
    });

    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt` (persisted to
    // `chatSessions.systemPrompt`, first-write-wins). The
    // persistence-side `{role:"system",...}` prepend on `messages` was
    // removed — the wire shape and the persisted shape now agree on
    // "system carried out-of-band". Live SSE `trace_snapshot` events
    // still apply the prefix via `withSystemPrefix` closures in the
    // streaming runners (different consumer: live test-runner UI vs.
    // stored transcript).
    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage,
      messages: conversationMessages,
      ...(enhancedSystemPromptForPersist
        ? { systemPrompt: enhancedSystemPromptForPersist }
        : {}),
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      // PR 6b: per-iteration browser artifacts, non-empty only on this local
      // AI-SDK Computer Use path. finalizeEvalIteration serializes them once
      // (screenshot upload + sanitize) for both the W2 and W1 persistence paths.
      ...(browser.widgetRenderObservations.length
        ? { widgetRenderObservations: browser.widgetRenderObservations }
        : {}),
      ...(browser.browserInteractionSteps.length
        ? { browserInteractionSteps: browser.browserInteractionSteps }
        : {}),
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
              injectOpenAiCompat === true
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finalizeEvalIteration({ ...finishParams, convexClient });
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
          test.matchOptions
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
      test.matchOptions
    );
    // Suite summary aggregates `evaluation.passed` (see runEvalSuiteWithAiSdk).
    // The persisted iteration is hard-coded `passed: false` below, but the
    // returned evaluation could still report `passed: true` on negative tests
    // or tests with no expected tools when the catch fires before any tools
    // are called — that would inflate suite-pass counts. Force false here so
    // the persisted and returned verdicts agree.
    evaluation.passed = false;
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
      messages: failMessages,
      mcpClientManager,
      convexClient,
    });
    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. Same threading as the success
    // path. Catches that fire BEFORE `prepareChatV2` returned leave the
    // value `undefined` — backend's first-write-wins tolerates a never-
    // set systemPrompt cleanly.
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
      ...(enhancedSystemPromptForPersist
        ? { systemPrompt: enhancedSystemPromptForPersist }
        : {}),
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      // PR 6b: browser artifacts collected before the failure still persist.
      ...(browser.widgetRenderObservations.length
        ? { widgetRenderObservations: browser.widgetRenderObservations }
        : {}),
      ...(browser.browserInteractionSteps.length
        ? { browserInteractionSteps: browser.browserInteractionSteps }
        : {}),
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
              injectOpenAiCompat === true
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finalizeEvalIteration({ ...failParams, convexClient });
    }
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } finally {
    // Browser-rendered MCP App eval (PR 5): tear down the harness (and its
    // headless Chromium, if launched) regardless of success/failure. No-op
    // when the harness was never constructed or never launched.
    await browser.dispose();
  }
};

const runIterationViaBackend = async (params: RunIterationBackendParams) => {
  // Browser-rendered MCP App eval (PR 14): hosted-path harness context — the
  // engine-attached equivalent of the local runners' inline harness wiring
  // (computer tools, advertised-tool gate, render hook, artifact collectors).
  // The wrapper owns disposal: try/finally guarantees a launched Chromium is
  // torn down on EVERY exit (cancellation early-returns, setup failures,
  // finalize throws), which per-exit dispose calls could miss.
  const browser = await createBrowserSessionContext({
    model: params.test.model,
    mcpClientManager: params.mcpClientManager,
    injectOpenAiCompat: params.injectOpenAiCompat,
  });
  try {
    return await runIterationViaBackendWithBrowser(params, browser);
  } finally {
    await browser.dispose();
  }
};

const runIterationViaBackendWithBrowser = async (
  {
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
    orgModelConfigTarget,
  }: RunIterationBackendParams,
  browser: BrowserSessionContext
) => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId }
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions
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
            test.matchOptions
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
    test.hostConfigOverride?.hostContext as Record<string, unknown> | undefined
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
  // Suite hostConfig `builtInToolIds` (e.g. web_search) resolve to runnable
  // tools the same way chat does. The tool's execute bills MCPJam credits
  // via Convex, so the auth context reuses the iteration's bearer plus the
  // same project target the org-BYOK/jam billing paths derive
  // (`resolveOrgTargetForEval`). Org-level targets carry no projectId —
  // the Exa route requires one — so those omit the tools.
  const builtInTarget = resolveOrgTargetForEval(test, orgModelConfigTarget);
  const builtInTools = resolveHostTools(
    { builtInToolIds: resolvedExecution.builtInToolIds },
    builtInTarget && "projectId" in builtInTarget
      ? { authHeader: convexAuthToken, projectId: builtInTarget.projectId }
      : null
  );
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
      ...(builtInTools ? { builtInTools } : {}),
    });
    // PR 4d review fix (Codex P2 / Cursor Medium): stash the resolved
    // system prompt for the persistence prefix below. The engine
    // (`runAssistantTurn`) sends it to the model via its `systemPrompt:`
    // arg, but the returned message history doesn't carry a system entry
    // and `appendEvalTurnTrace` has no `systemPrompt` slot. Prepend at
    // persistence time — same shape as the local runners' Codex-P2 fix.
    backendEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
      test.matchOptions
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
      test.matchOptions
    ),
    iterationId: undefined,
  });

  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    // Cancellation between turns: bail without recording.
    if (isAborted()) {
      logger.debug(
        "[evals] backend iteration aborted between turns; skipping record"
      );
      return returnCancelled();
    }

    // Shared hosted-turn body (engine call + browser pipeline + accumulator
    // drains + three-shape failure detection) — see driveHostedEvalTurn.
    // This batch runner layers no SSE sinks.
    const outcome = await driveHostedEvalTurn({
      promptIndex,
      prompt: promptTurns[promptIndex]!.prompt,
      browser,
      prepared,
      modelDefinition,
      modelId,
      selectedServers,
      mcpClientManager,
      evalAuthContext,
      endpointPath,
      extraBodyFields,
      toolChoice,
      abortSignal,
      maxSteps: MAX_STEPS,
      runStartedAt,
      isAborted,
      // Harness selector + host approval intent (forwarded only for harness
      // turns inside driveHostedEvalTurn; emulated evals are unaffected).
      harness: resolvedExecution.harness,
      requireToolApproval: resolvedExecution.requireToolApproval,
      ...(builtInTarget && "projectId" in builtInTarget
        ? { projectId: builtInTarget.projectId }
        : {}),
      extractToolCalls: (messages) =>
        extractToolCallsFromConversation({ messages }),
      acc: {
        messageHistory,
        capturedSpans,
        accumulatedUsage,
        toolsCalledByPrompt,
      },
    });
    if (outcome.kind === "cancelled") return returnCancelled();
    if (outcome.kind === "failed") {
      iterationError = outcome.iterationError;
      iterationErrorDetails = outcome.iterationErrorDetails;
      break;
    }
  }

  const evaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
    test.matchOptions
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
          renderObservations: summarizeRenderObservations(
            browser.widgetRenderObservations,
          ),
        }),
        test.successPredicates
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
  const widgetSnapshots = await captureMcpAppWidgetSnapshots({
    injectOpenAiCompat,
    messages: messageHistory,
    mcpClientManager,
    convexClient,
  });
  // PR (this change): the resolved system prompt now flows through
  // `appendEvalTurnTrace.systemPrompt` (persisted to
  // `chatSessions.systemPrompt`, first-write-wins). Engine still sends
  // it via `runAssistantTurn`'s `systemPrompt:` arg for the model wire.
  const finishParams = {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(backendEnhancedSystemPromptForPersist
      ? { systemPrompt: backendEnhancedSystemPromptForPersist }
      : {}),
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
    ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
    // Browser-rendered MCP App eval (PR 14): hosted-path browser artifacts.
    // finalizeEvalIteration serializes them once (screenshot upload +
    // sanitize) for both the W2 and W1 persistence paths — same machinery
    // the local AI-SDK runners feed (PR 6b/9).
    ...(browser.widgetRenderObservations.length
      ? { widgetRenderObservations: browser.widgetRenderObservations }
      : {}),
    ...(browser.browserInteractionSteps.length
      ? { browserInteractionSteps: browser.browserInteractionSteps }
      : {}),
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
            injectOpenAiCompat === true
          )
        : {}),
    },
  };

  if (recorder) {
    await recorder.finishIteration(finishParams);
  } else {
    await finalizeEvalIteration({ ...finishParams, convexClient });
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
  /**
   * Run environment snapshot (servers + serverBindings). Only consulted by
   * the widget-probe fork below to resolve the probe's pinned server
   * reference to a manager key; the LLM path receives its servers
   * pre-resolved via `selectedServers`.
   */
  environment?: RunEvalSuiteOptions["config"]["environment"];
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
    environment,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;

  // Normalize legacy `widget_probe` rows into a single model-free pinned turn
  // so the unified engine sees one shape. No-op for already-pinned / prompt
  // cases.
  const normalizedTest = normalizeTestForPinnedTurns(test);

  // Pinned-only case (today's render check): no model turns at all. Run it
  // through the same `runIterationWithAiSdk` engine, model-free — it skips all
  // model/BYOK setup and executes each pinned turn via runPinnedTurn. Never
  // routes to a hosted backend (there is no model to bill / drive).
  if (
    !needsModel({
      caseType: normalizedTest.caseType,
      promptTurns: normalizedTest.promptTurns,
    })
  ) {
    const outcomes: EvalIterationOutcome[] = [];
    const pinnedRuns = Math.max(1, Math.floor(normalizedTest.runs || 1));
    for (let runIndex = 0; runIndex < pinnedRuns; runIndex++) {
      if (abortSignal?.aborted) break;
      outcomes.push(
        await runIterationWithAiSdk({
          test: normalizedTest,
          runIndex,
          tools,
          selectedServers,
          mcpClientManager,
          recorder,
          testCaseId,
          suiteId,
          // Unused when the case is model-free (caseNeedsModel === false), but
          // the param is required. A real id is never resolved.
          modelDefinition: {
            id: "pinned-only",
            provider: "none",
          } as unknown as ModelDefinition,
          modelApiKeys,
          orgModelConfig,
          orgModelConfigTarget,
          convexClient,
          runId,
          abortSignal,
          ...(compareRunId ? { compareRunId } : {}),
          injectOpenAiCompat,
          hostPolicy,
          toolSignals,
          suiteHostConfig,
          environment,
        })
      );
    }
    return outcomes;
  }

  // Hybrid (model turns + pinned turns) on a hosted model is not yet wired:
  // the backend engine drives turns server-side and cannot interleave a
  // locally-executed pinned turn. Local BYOK hybrids work (the pinned branch
  // lives in runIterationWithAiSdk). Fail loudly rather than silently send a
  // pinned turn's empty prompt to the model.
  const caseHasPinnedTurn = normalizedTest.promptTurns?.some(isPinnedTurn) ||
    resolveEvalTestCase(normalizedTest).promptTurns.some(isPinnedTurn);

  const modelDefinition = buildModelDefinition(test);
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider
  );
  const isJamModel = isMCPJamProvidedModel(
    resolvedModelId,
    modelDefinition.provider
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

  if (caseHasPinnedTurn && (isJamModel || orgByokRuntime?.kind === "cloud")) {
    throw new Error(
      "Pinned tool-call turns are not yet supported with hosted models. Use a BYOK (local) model for cases that pin a tool call."
    );
  }

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
        const id = await createIterationDirectly(convexClient, iterationParams);
        precreatedIterationIds.push(id);
      } catch (error) {
        logger.warn(
          "[evals] Failed to precreate iteration row; falling back to per-loop create",
          {
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          }
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
      environment,
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
      : providedRecorder ??
        createSuiteRunRecorder({
          convexClient,
          suiteId,
          runId,
        });

  // When a host policy is present we need the full tool set (including
  // app-only) so `applyVisibilityPolicyAndCountSignals` can:
  //   1. Count `toolsTotalBefore` honestly, and
  //   2. Keep app-only tools when the host opted out of visibility filtering.
  // Without this, getToolsForAiSdk pre-strips app-only tools and the policy
  // sees a partial set — drops are reported as 0 even when tools were hidden.
  const tools = await getEvalToolsForAiSdkOrThrow({
    mcpClientManager,
    serverIds,
    includeAppOnly: Boolean(hostExecutionPolicy),
    environment: config.environment,
  });

  // Apply visibility filtering when a host policy is present. The filter
  // mutates `tools` in place (same as prepareChatV2) so downstream iteration
  // runners see the post-filter set.
  const resolvedToolSignals = hostExecutionPolicy
    ? applyVisibilityPolicyAndCountSignals(
        tools as Record<string, unknown>,
        mcpClientManager,
        hostExecutionPolicy
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
        }
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

    // Run tests in parallel, but cap concurrent render checks: each
    // `widget_probe` case launches a headless Chromium, so an all-render-check
    // monitoring suite would otherwise spawn one browser per case at once and
    // exhaust the worker. LLM-only cases are network-bound and stay unbounded.
    // The limiter releases a slot when each case settles, so it can't leak.
    const renderCheckLimit = createConcurrencyLimiter(
      MAX_CONCURRENT_RENDER_CHECKS
    );
    const runOne = (test: (typeof tests)[number]) =>
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
        environment: config.environment,
      });
    const testPromises = tests.map((test) =>
      test.caseType === "widget_probe"
        ? renderCheckLimit(() => runOne(test))
        : runOne(test)
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
            { runId }
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
          "[evals] Run was cancelled, all in-flight requests aborted"
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
        { runId }
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions
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
            test.matchOptions
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
    test.hostConfigOverride?.hostContext as Record<string, unknown> | undefined
  );
  const temperature = resolvedExecution.temperature;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  // A case whose turns are ALL pinned tool calls is model-free: every
  // model/BYOK setup step below is skipped (a pinned-only case carries
  // display-only model sentinels that must never reach the runtime resolver,
  // which throws on a missing API key). Hybrid cases keep full model setup;
  // their pinned turns run via runPinnedTurn inside the loop.
  const caseNeedsModel = needsModel({
    caseType: test.caseType,
    promptTurns,
  });
  // First pinned turn's render-budget override; applied to the shared harness.
  const pinnedRenderTimeoutMs = promptTurns.find(
    (t) =>
      isPinnedTurn(t) && typeof t.pinnedToolCall?.renderTimeoutMs === "number",
  )?.pinnedToolCall?.renderTimeoutMs;

  const modelRuntime = caseNeedsModel
    ? resolveEvalModelRuntime({
        test,
        modelDefinition,
        modelApiKeys,
        orgModelConfig,
      })
    : null;

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

  // Browser-rendered MCP App eval (PR 9): mirror runIterationWithAiSdk on the
  // streamed path — render MCP App tool results in the headless-Chromium harness
  // and (for models with vision + tool calling) drive them with Computer
  // Use. Declared BEFORE the
  // try so the finally can dispose even on a mid-stream abort.
  const browser = await createBrowserSessionContext({
    // Model-free (pinned-only) iterations pass no model: no Computer Use, but
    // the harness still renders pinned widgets and records observations.
    ...(caseNeedsModel ? { model: test.model } : {}),
    mcpClientManager,
    injectOpenAiCompat,
    ...(pinnedRenderTimeoutMs ? { renderTimeoutMs: pinnedRenderTimeoutMs } : {}),
  });

  try {
    // See `runIterationWithAiSdk`: adopt the chat-side pipeline inside the try
    // so prep failures become a recorded failed iteration. Like that runner,
    // `builtInTools` stays absent on the local BYOK path (no Convex auth to
    // bill web_search against) — the null-ctx call just debug-logs requests.
    // Model-free (pinned-only) iterations skip tool/system/model prep — see
    // `runIterationWithAiSdk`. `prepared`/`llmModel` stay null and are only
    // read inside the model-turn branch, unreachable when caseNeedsModel false.
    let prepared: PrepareChatV2Result | null = null;
    let llmModel: ReturnType<typeof createLlmModel> | null = null;
    if (caseNeedsModel) {
      resolveHostTools(
        { builtInToolIds: resolvedExecution.builtInToolIds },
        null
      );
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt: system,
        temperature,
        respectToolVisibility: hostPolicy?.respectToolVisibility,
        customProviders: modelRuntime!.customProviders,
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

      llmModel = createLlmModel(
        modelDefinition,
        modelRuntime!.apiKey,
        modelRuntime!.baseUrls,
        modelRuntime!.customProviders
      );

      if (
        toolChoice &&
        typeof toolChoice === "object" &&
        !Object.hasOwn(prepared.allTools, toolChoice.toolName) &&
        // `computer` / `finish_widget` are merged into the tool map below, so a
        // forced tool choice naming one of them is valid on computer-capable drivers.
        !Object.hasOwn(browser.computerWidgetTools, toolChoice.toolName)
      ) {
        throw new Error(
          `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`
        );
      }
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
        test.matchOptions
      ),
      iterationId: undefined,
    });

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      if (localIsAborted()) return returnLocalCancelled();
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      browser.setActivePromptIndex(promptIndex);
      // Streaming quick-run does not execute pinned turns (a case carrying one
      // is rejected up front in `streamTestCase`), so the model always exists
      // here. Narrow the nullable handles for the model-driven body below.
      if (!llmModel || !prepared) {
        throw new Error(
          "eval: model-driven turn reached without model setup (caseNeedsModel invariant violated)"
        );
      }
      // PR 9 (mirror PR 5): start each turn with a clean widget surface so a
      // widget kept mounted by a previous turn can't be advertised/targeted
      // before this turn's own MCP App tool runs.
      await browser.dismissCarriedWidget();
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
        tools: { ...prepared.allTools, ...browser.computerWidgetTools },
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        // PR 9 (mirror PR 5): gate Computer Use tools so the model only sees
        // `computer` / `finish_widget` once a widget has actually rendered in
        // the harness (the same live-widget source `getActiveToolCallId` reads).
        ...(browser.prepareAdvertisedTools
          ? { prepareAdvertisedTools: browser.prepareAdvertisedTools }
          : {}),
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
              promptInputLength
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
              })
            );
          },
          // PR 9 (mirror PR 5): render each MCP App tool result in the harness
          // and record an observation. `onToolResultChunk` fires on the stream
          // path too; awaited so a rendered widget is mounted before the next
          // step's Computer Use gate runs.
          onToolResultChunk: (chunk) =>
            browser.handleDirectToolResultChunk(chunk),
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
            "[evals] streaming local-BYOK iteration aborted mid-turn; skipping record"
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
            promptIndex
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
            "[evals] streamText returned no new messages this turn; treating as cycle failure"
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
            })
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
            !(span as { toolCallId?: string }).toolCallId
        );
        if (stepErrorSpan) {
          iterationError = `Local-BYOK step failed mid-turn: ${stepErrorSpan.name}`;
          logger.error(
            `[evals] streamText recorded non-tool error span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`
          );
          recordedSpans.push(...activeTraceCtx.recordedSpans);
          toolsCalledByPrompt.push(
            extractToolCallsFromConversation({
              steps,
              messages: promptResponseMessages,
            })
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
            })
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
          })
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
      test.matchOptions
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
            renderObservations: summarizeRenderObservations(
              browser.widgetRenderObservations,
            ),
          }),
          test.successPredicates
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
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
      messages: conversationMessages,
      mcpClientManager,
      convexClient,
    });
    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. The `withSystemPrefix`
    // closure above still applies the prefix to LIVE SSE
    // `trace_snapshot` events for the test-runner UI (different
    // consumer than the stored transcript).
    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage: usageFinal,
      messages: conversationMessages,
      ...(streamEnhancedSystemPromptForPersist
        ? { systemPrompt: streamEnhancedSystemPromptForPersist }
        : {}),
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      // PR 9: browser artifacts from the streamed Computer Use path.
      ...(browser.widgetRenderObservations.length
        ? { widgetRenderObservations: browser.widgetRenderObservations }
        : {}),
      ...(browser.browserInteractionSteps.length
        ? { browserInteractionSteps: browser.browserInteractionSteps }
        : {}),
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
              injectOpenAiCompat === true
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finalizeEvalIteration({ ...finishParams, convexClient });
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
          test.matchOptions
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
      test.matchOptions
    );
    // Suite summary aggregates `evaluation.passed` (see runEvalSuiteWithAiSdk).
    // The persisted iteration is hard-coded `passed: false` below, but the
    // returned evaluation could still report `passed: true` on negative tests
    // or tests with no expected tools when the catch fires before any tools
    // are called — that would inflate suite-pass counts. Force false here so
    // the persisted and returned verdicts agree.
    evaluation.passed = false;
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
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
      })
    );
    emit({
      type: "error",
      message: errorMessage ?? "Eval iteration failed",
      details: errorDetails,
    });

    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. Same threading as the
    // success path.
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
      ...(streamEnhancedSystemPromptForPersist
        ? { systemPrompt: streamEnhancedSystemPromptForPersist }
        : {}),
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
      // PR 9: browser artifacts collected before the failure still persist.
      ...(browser.widgetRenderObservations.length
        ? { widgetRenderObservations: browser.widgetRenderObservations }
        : {}),
      ...(browser.browserInteractionSteps.length
        ? { browserInteractionSteps: browser.browserInteractionSteps }
        : {}),
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
              injectOpenAiCompat === true
            )
          : {}),
      },
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finalizeEvalIteration({ ...failParams, convexClient });
    }
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } finally {
    // PR 9: tear down the harness (and its headless Chromium, if launched) on
    // success, failure, OR mid-stream abort. No-op when never constructed.
    await browser.dispose();
  }
};

const streamIterationViaBackend = async (
  params: RunIterationBackendParams & {
    emit: StreamEmit;
  }
): Promise<EvalIterationOutcome> => {
  // Browser-rendered MCP App eval (PR 14): hosted-path harness context for
  // the streaming runner — same wiring as `runIterationViaBackend`; the
  // wrapper's try/finally guarantees Chromium teardown on every exit.
  const browser = await createBrowserSessionContext({
    model: params.test.model,
    mcpClientManager: params.mcpClientManager,
    injectOpenAiCompat: params.injectOpenAiCompat,
  });
  try {
    return await streamIterationViaBackendWithBrowser(params, browser);
  } finally {
    await browser.dispose();
  }
};

const streamIterationViaBackendWithBrowser = async (
  {
    test,
    runIndex,
    // Suite-level raw set retained for `toolSignals`; per-iteration tool prep
    // is delegated to prepareChatV2 below.
    tools: _suiteTools,
    selectedServers,
    mcpClientManager,
    recorder,
    testCaseId,
    // PR 5b: `convexHttpUrl` is in the `RunIterationBackendParams` type
    // (shared with the non-stream runner + the iterative path) but
    // unused here — `runAssistantTurn` owns the Convex `/stream` fetch
    // and reads its base URL from `CONVEX_HTTP_URL` env / the configured
    // chat-orchestration helpers. Kept on the params type so the caller
    // shape stays uniform across runners.
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
    orgModelConfigTarget,
  }: RunIterationBackendParams & {
    emit: StreamEmit;
  },
  browser: BrowserSessionContext
): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId }
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
            test.matchOptions
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
            test.matchOptions
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
    test.hostConfigOverride?.hostContext as Record<string, unknown> | undefined
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
  // Same shape as the non-stream backend runner: suite hostConfig
  // `builtInToolIds` resolve via the shared registry, billed against the
  // project target the org-BYOK/jam billing paths derive.
  const builtInTarget = resolveOrgTargetForEval(test, orgModelConfigTarget);
  const builtInTools = resolveHostTools(
    { builtInToolIds: resolvedExecution.builtInToolIds },
    builtInTarget && "projectId" in builtInTarget
      ? { authHeader: convexAuthToken, projectId: builtInTarget.projectId }
      : null
  );
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
      ...(builtInTools ? { builtInTools } : {}),
    });
    // PR 4d review fix (Codex P2 / Cursor Medium): same persistence
    // prefix shape as the non-stream backend runner.
    backendEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
      test.matchOptions
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
      test.matchOptions
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
        "[evals] backend streaming iteration aborted between turns; skipping record"
      );
      return returnCancelled();
    }

    const promptTurn = promptTurns[promptIndex]!;

    // Shared hosted-turn body (engine call + browser pipeline + accumulator
    // drains + three-shape failure detection) — see driveHostedEvalTurn.
    // This SSE runner layers its emitters through `buildSinks`; the factory
    // runs once per turn so the per-turn accumulators (partial-response
    // builders, step counters, usage deltas) reset naturally.
    const outcome = await driveHostedEvalTurn({
      promptIndex,
      prompt: promptTurn.prompt,
      browser,
      prepared,
      modelDefinition,
      modelId,
      selectedServers,
      mcpClientManager,
      evalAuthContext,
      endpointPath,
      extraBodyFields,
      toolChoice,
      abortSignal,
      maxSteps: MAX_STEPS,
      runStartedAt,
      isAborted,
      // Harness selector + host approval intent (forwarded only for harness
      // turns inside driveHostedEvalTurn; emulated evals are unaffected).
      harness: resolvedExecution.harness,
      requireToolApproval: resolvedExecution.requireToolApproval,
      ...(builtInTarget && "projectId" in builtInTarget
        ? { projectId: builtInTarget.projectId }
        : {}),
      logSuffix: " (stream)",
      extractToolCalls: (messages) =>
        extractToolCallsFromConversation({ messages }),
      acc: {
        messageHistory,
        capturedSpans,
        accumulatedUsage,
        toolsCalledByPrompt,
      },
      buildSinks: ({ baselineUsage, traceCtx, promptToolsCalled }) => {
        // Track engine-emitted step events so the post-turn `turn_finish`
        // trace_snapshot has a stable last-step index, and so failure
        // branches can carry stepIndex when available.
        let activeCompletedStepCount = 0;
        let lastSettledStepIndex: number | undefined;
        // Engine reports turn-cumulative usage on each `onStepFinish`. The
        // legacy inline loop emitted PER-STEP token counts on `step_finish`
        // SSE, so we track the previous step's cumulative and emit the delta.
        // (Cursor PR 5b review fix: "Step finish reports cumulative usage".)
        let prevStepCumulativeInput = 0;
        let prevStepCumulativeOutput = 0;

        // In-flight partial-response accumulator. Mid-turn `step_finish`
        // trace_snapshot needs to carry the assistant/tool content that
        // already streamed within the turn — the engine doesn't roll its own
        // `messageHistory` ref forward until the turn settles, so
        // `messageHistory` here is stale (prior turns + this turn's user
        // prompt). Mirror PR 5a's `activePartialResponseMessages` shape.
        // (Cursor PR 5b review fix: "Step snapshots omit in-turn messages".)
        let partialAssistantText = "";
        const partialAssistantToolCalls: Array<{
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: unknown;
        }> = [];
        const partialToolResultMessages: ModelMessage[] = [];
        const buildPartialResponseMessages = (): ModelMessage[] => {
          const content: unknown[] = [];
          if (partialAssistantText) {
            content.push({ type: "text", text: partialAssistantText });
          }
          content.push(...partialAssistantToolCalls);
          const out: ModelMessage[] = [];
          if (content.length > 0) {
            out.push({ role: "assistant", content } as ModelMessage);
          }
          out.push(...partialToolResultMessages);
          return out;
        };

        // Engine callbacks → SSE events, mirroring the legacy inline loop:
        //  - `onLiveTextDelta` → `text_delta` SSE + rolling assistant text
        //  - `onToolCall`      → `tool_call` SSE + push to partial assistant
        //                        (the input cache write happens in the shared
        //                        helper before this sink fires)
        //  - `onToolResult`    → `tool_result` SSE + synthetic tool msg (the
        //                        harness render happens in the shared helper
        //                        AFTER this sink — live consumers shouldn't
        //                        wait on Chromium)
        //  - `onStepFinish`    → `step_finish` SSE (per-step usage DELTA) +
        //                        step_finish trace snapshot, gated on
        //                        `settledWithError === false`
        //  - `onTurnFailure`   → failure trace_snapshot + `error` SSE
        //  - `onTurnSuccess`   → turn_finish trace_snapshot + `turn_finish`
        return {
          onTurnStart: () =>
            emit({
              type: "turn_start",
              turnIndex: promptIndex,
              prompt: promptTurn.prompt,
            }),
          onLiveTextDelta: (delta: string) => {
            if (typeof delta !== "string" || delta.length === 0) return;
            partialAssistantText += delta;
            emit({ type: "text_delta", content: delta });
          },
          onToolCall: (event: MCPJamToolCallEvent) => {
            if (!event.toolName) return;
            const args = (event.input ?? {}) as Record<string, unknown>;
            promptToolsCalled.push({
              toolName: event.toolName,
              arguments: args as Record<string, any>,
            });
            partialAssistantToolCalls.push({
              type: "tool-call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: args,
            });
            emit({
              type: "tool_call",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              args,
            });
          },
          onToolResult: (event: MCPJamToolResultEvent) => {
            partialToolResultMessages.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: event.toolCallId,
                  ...(event.toolName ? { toolName: event.toolName } : {}),
                  output: event.output,
                  ...(event.isError ? { isError: true } : {}),
                },
              ],
            } as ModelMessage);
            emit({
              type: "tool_result",
              toolCallId: event.toolCallId,
              result: event.output,
              isError: event.isError,
            });
          },
          onStepFinish: (event: MCPJamStepFinishEvent) => {
            // Marcelo's PR 5b-pre review caveat: only emit `step_finish` for
            // settled-OK steps; failed backend steps surface through the
            // post-turn failure detection.
            if (event.settledWithError) return;
            activeCompletedStepCount += 1;
            lastSettledStepIndex = event.stepIndex;
            // Per-step delta = cumulative-now − cumulative-at-prev-step.
            const cumulativeInput = event.turnUsage?.inputTokens ?? 0;
            const cumulativeOutput = event.turnUsage?.outputTokens ?? 0;
            const cumulativeTotal = event.turnUsage?.totalTokens ?? 0;
            const stepDeltaInput = Math.max(
              0,
              cumulativeInput - prevStepCumulativeInput
            );
            const stepDeltaOutput = Math.max(
              0,
              cumulativeOutput - prevStepCumulativeOutput
            );
            prevStepCumulativeInput = cumulativeInput;
            prevStepCumulativeOutput = cumulativeOutput;
            // Roll `accumulatedUsage` forward to the engine's reported
            // turn-cumulative + the pre-turn baseline (multi-turn runs).
            accumulatedUsage.inputTokens =
              baselineUsage.inputTokens + cumulativeInput;
            accumulatedUsage.outputTokens =
              baselineUsage.outputTokens + cumulativeOutput;
            accumulatedUsage.totalTokens =
              baselineUsage.totalTokens + cumulativeTotal;
            emit({
              type: "step_finish",
              stepNumber: activeCompletedStepCount,
              usage: {
                inputTokens: stepDeltaInput,
                outputTokens: stepDeltaOutput,
              },
            });
            // Live trace snapshot for the step: stale `messageHistory`
            // (prior turns + this turn's user prompt) PLUS the in-flight
            // partial response; spans = prior turns' merged spans + this
            // turn's tool-instrumentation spans + the engine's per-step
            // LLM spans (PR 5b-followup-2).
            const snapshotMessages = [
              ...messageHistory,
              ...buildPartialResponseMessages(),
            ];
            emit(
              buildTraceSnapshotEvent({
                turnIndex: promptIndex,
                stepIndex: event.stepIndex,
                snapshotKind: "step_finish",
                messages: withSystemPrefix(snapshotMessages),
                spans: [
                  ...capturedSpans,
                  ...traceCtx.recordedSpans,
                  ...event.turnSpans,
                ],
                actualToolCalls: extractToolCallsFromConversation({
                  messages: snapshotMessages,
                }),
                usage: accumulatedUsage,
              })
            );
            // NO per-step reset of the partial-response accumulators: during
            // the turn they are the ONLY source of in-flight content for
            // snapshot fidelity; they reset naturally with the next turn's
            // sink factory.
          },
          onTurnFailure: (failure) => {
            // Mirror the in-stream failure signal the legacy inline loop
            // emitted: failure trace_snapshot + error event before the break
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
              })
            );
            emit({
              type: "error",
              message: failure.iterationError,
              ...(failure.iterationErrorDetails
                ? { details: failure.iterationErrorDetails }
                : {}),
            });
          },
          onTurnSuccess: () => {
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
              })
            );
            emit({ type: "turn_finish", turnIndex: promptIndex });
          },
        };
      },
    });
    if (outcome.kind === "cancelled") return returnCancelled();
    if (outcome.kind === "failed") {
      iterationError = outcome.iterationError;
      iterationErrorDetails = outcome.iterationErrorDetails;
      break;
    }
  }

  const evaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
    test.matchOptions
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
          renderObservations: summarizeRenderObservations(
            browser.widgetRenderObservations,
          ),
        }),
        test.successPredicates
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
  const widgetSnapshots = await captureMcpAppWidgetSnapshots({
    injectOpenAiCompat,
    messages: messageHistory,
    mcpClientManager,
    convexClient,
  });
  // PR (this change): the resolved system prompt now flows through
  // `appendEvalTurnTrace.systemPrompt`. The `withSystemPrefix` closure
  // above still applies the prefix to LIVE SSE `trace_snapshot` events
  // for the test-runner UI (different consumer than the stored
  // transcript).
  const finishParams = {
    iterationId,
    passed,
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(backendEnhancedSystemPromptForPersist
      ? { systemPrompt: backendEnhancedSystemPromptForPersist }
      : {}),
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
    ...(widgetSnapshots?.length ? { widgetSnapshots } : {}),
    // Browser-rendered MCP App eval (PR 14): hosted-path browser artifacts
    // (see the non-stream backend runner).
    ...(browser.widgetRenderObservations.length
      ? { widgetRenderObservations: browser.widgetRenderObservations }
      : {}),
    ...(browser.browserInteractionSteps.length
      ? { browserInteractionSteps: browser.browserInteractionSteps }
      : {}),
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
            injectOpenAiCompat === true
          )
        : {}),
    },
  };

  if (recorder) {
    await recorder.finishIteration(finishParams);
  } else {
    await finalizeEvalIteration({ ...finishParams, convexClient });
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
  // Streaming quick-run does not yet execute pinned (model-free) turns: the
  // SSE loop has no pinned branch and builds the model eagerly. Pinned-only
  // render checks run via the suite path (`runTestCase`); reject a pinned case
  // here rather than send an empty prompt to the model.
  if (resolveEvalTestCase(test).promptTurns.some(isPinnedTurn)) {
    throw new Error(
      "Pinned tool-call turns are not yet supported in streaming quick-run. Run the case as part of a suite."
    );
  }
  const modelDefinition = buildModelDefinition(test);
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider
  );
  const isJamModel = isMCPJamProvidedModel(
    resolvedModelId,
    modelDefinition.provider
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
        const id = await createIterationDirectly(convexClient, iterationParams);
        precreatedIterationIds.push(id);
      } catch (error) {
        logger.warn(
          "[evals] Failed to precreate streaming iteration row; will fall back to per-loop create",
          {
            runIndex,
            error: error instanceof Error ? error.message : String(error),
          }
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
