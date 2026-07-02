import { type ModelMessage } from "ai";
import {
  evaluateMultiTurnResults,
  type EvaluationResult,
  type MultiTurnEvaluationResult,
  type UsageTotals,
} from "./evals/types";
import { buildEvalIterationVerdict } from "./evals/iteration-verdict";
import { createStepExecutionState, executeSteps } from "./evals/step-executor";
import {
  buildLocalStepHandlers,
  buildHostedStepHandlers,
} from "./evals/step-handlers";
import { buildHostedEvalSinks } from "./evals/hosted-eval-sinks";
import { buildStepResultRecords, buildStepScriptedCheckFailures, resolveTurnCheckResultsFromStepExecution } from "./evals/step-verdict-adapters";

import {
  applyVisibilityPolicyAndCountSignals,
  type HostExecutionPolicy,
  type ToolExposureSignals,
} from "@mcpjam/sdk/host-config/internal";
import { type MCPClientManager } from "@mcpjam/sdk";
import {
  createLlmModel,
  type BaseUrls,
  type CustomProviderConfig,
} from "../utils/chat-helpers";
import { resolveExecutionContext } from "../utils/host-execution-context";
import { resolveHostTools } from "../utils/built-in-tools/registry.js";
import {
  buildEvalBashTool,
  EVAL_BASH_TOOL_NAME,
} from "../utils/built-in-tools/eval-bash.js";
import {
  isComputersDataPlaneConfigured,
  provisionEvalSandbox,
  releaseEvalSandbox,
} from "../utils/computers/control-plane-client.js";
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
  mergeToolCallsByPromptIndex,
  summarizeRenderObservations,
  widgetToolCallsByPromptIndex,
  type PredicateResult,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../routes/web/errors";
import {
  createSuiteRunRecorder,
  type SuiteRunRecorder,
} from "./evals/recorder";
import { finalizeAiSdkTraceOnFailure } from "./evals/eval-trace-capture";
import type {
  EvalTraceBlobV1,
  EvalTraceSpan,
  PromptTraceSummary,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import {
  deriveLegacyPromptFields,
  isPinnedOnly,
  isPinnedTurn,
  turnsNeedModel,
  resolvePromptTurns,
  resolvePromptTurnsWithLegacyProbe,
  stripPromptTurnsFromAdvancedConfig,
  type PinnedToolCall,
  type PromptTurn,
} from "@/shared/steps";
import {
  normalizeSteps,
  promptTurnsToSteps,
  stepsToPromptTurns,
  type TestStep,
} from "@/shared/steps";
import { withHostContextSystemPrompt } from "@/shared/host-context-prompt";
import { normalizeToolChoice, type EvalToolChoice } from "@/shared/tool-choice";
import {
  prepareChatV2,
  type PrepareChatV2Result,
} from "../utils/chat-v2-orchestration.js";
import type {
  LocalEvalTurnAcc,
  LocalEvalTurnSinks,
} from "./evals/drive-local-eval-turn.js";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";
import {
  finalizeEvalIteration,
  buildIterationFinishParams,
} from "./evals/finalize-iteration.js";
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
  /**
   * Unified `TestStep[]` model (Phase 3). When present this is the source of
   * truth for execution and the single sequential step executor runs it
   * directly. `promptTurns`/`caseType`/`probeConfig` are the legacy fallback
   * the runner converts via `resolveSteps` until the backend emits `steps`.
   */
  steps?: TestStep[];
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

// ── Run-lifecycle guards ────────────────────────────────────────────────────
// A suite run must always terminate: a hung LLM call or browser render can
// otherwise leave the run "running" forever (and hold a headless Chromium).
// These bound it — a 20-min whole-run cap, a 10-min per-iteration cap, periodic
// liveness heartbeats, and a cancellation poll — all surfacing through one
// `EvalRunStoppedError` that aborts in-flight work and finalizes the run.
const EVAL_RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const EVAL_ITERATION_TIMEOUT_MS = 10 * 60 * 1000;
const EVAL_CANCEL_POLL_MS = 10 * 1000;
const EVAL_ABORT_GRACE_MS = 30 * 1000;
const EVAL_HEARTBEAT_MS = 15 * 1000;

type EvalRunStopReason = "user_cancelled" | "run_timeout" | "iteration_timeout";

class EvalRunStoppedError extends Error {
  readonly stopReason: EvalRunStopReason;
  readonly terminalStatus: "cancelled" | "timed_out";
  readonly notes: string;

  constructor(args: {
    stopReason: EvalRunStopReason;
    terminalStatus: "cancelled" | "timed_out";
    notes: string;
  }) {
    super(args.notes);
    this.name = "EvalRunStoppedError";
    this.stopReason = args.stopReason;
    this.terminalStatus = args.terminalStatus;
    this.notes = args.notes;
  }
}

const RUN_CANCELLED_ERROR = new EvalRunStoppedError({
  stopReason: "user_cancelled",
  terminalStatus: "cancelled",
  notes: "Run cancelled by user",
});

const RUN_TIMEOUT_ERROR = new EvalRunStoppedError({
  stopReason: "run_timeout",
  terminalStatus: "timed_out",
  notes: "Run timed out after 20 minutes",
});

const ITERATION_TIMEOUT_ERROR = new EvalRunStoppedError({
  stopReason: "iteration_timeout",
  terminalStatus: "timed_out",
  notes: "Run timed out because an iteration exceeded 10 minutes",
});

function isEvalRunStoppedError(error: unknown): error is EvalRunStoppedError {
  return error instanceof EvalRunStoppedError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ToolSet = Record<string, any>;
type ToolCall = { toolName: string; arguments: Record<string, any> };
type TraceSnapshotKind = "step_finish" | "turn_finish" | "failure";

function getServerLabelForEvalError(
  serverId: string,
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined
): string {
  const binding = environment?.serverBindings?.find(
    (entry) =>
      entry.projectServerId === serverId ||
      entry.projectServerId?.toLowerCase() === serverId.toLowerCase()
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
          args.environment
        );
        if (isMissingRuntimeServerError(error)) {
          throw new WebRouteError(
            409,
            ErrorCode.SERVER_UNREACHABLE,
            `Could not start eval because "${serverLabel}" is not connected. Reconnect the server and try again.`,
            { serverId, serverName: serverLabel }
          );
        }
        const cause = error instanceof Error ? error.message : String(error);
        throw new WebRouteError(
          502,
          ErrorCode.SERVER_UNREACHABLE,
          `Could not start eval because "${serverLabel}" failed to list tools. Reconnect the server and try again.`,
          { serverId, serverName: serverLabel, cause }
        );
      }
    })
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
  // Backend + route now emit `steps` (no promptTurns). The legacy per-turn
  // execution loops still consume `PromptTurn[]`, so bridge steps → turns here
  // (the single resolver every loop reads). Falls back to the legacy
  // promptTurns/probe path when a case carries no steps.
  const promptTurns =
    Array.isArray(test.steps) && test.steps.length > 0
      ? stepsToPromptTurns(normalizeSteps(test.steps))
      : resolvePromptTurns(test);
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
 * Resolve a test case into the unified `TestStep[]` the sequential step
 * executor consumes. Prefers an explicit `test.steps` (the forward contract,
 * once the backend emits it); otherwise converts the legacy `promptTurns`
 * (including a legacy `widget_probe`'s top-level `probeConfig`, surfaced as a
 * pinned turn) via `promptTurnsToSteps`. This is the single bridge from the
 * legacy per-turn model to `Step[]` on the server.
 */
export function resolveSteps(test: EvalTestCase): TestStep[] {
  if (Array.isArray(test.steps) && test.steps.length > 0) {
    return normalizeSteps(test.steps);
  }
  const turns = resolvePromptTurnsWithLegacyProbe(test);
  return promptTurnsToSteps(turns);
}

/**
 * Represent a legacy `widget_probe` row as a single model-free pinned turn so
 * the unified engine sees ONE shape (routing, server resolution, the iteration
 * loop). Post-migration rows already carry the pinned turn, so this is a no-op
 * for them. Idempotent.
 */
function normalizeTestForPinnedTurns(test: EvalTestCase): EvalTestCase {
  if (test.caseType !== "widget_probe" || !test.probeConfig) {
    return test;
  }
  // Shared with the editor's editForm seeding so the legacy-detection rule
  // lives in one place.
  const turns = resolvePromptTurnsWithLegacyProbe(test);
  return turns.some(isPinnedTurn) ? { ...test, promptTurns: turns } : test;
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
  mcpClientManager: MCPClientManager
): string | undefined {
  const connected = new Set(selectedServers);
  const candidates = [pinned.serverId, pinned.serverName].filter(
    (ref): ref is string => !!ref
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
  evaluation: MultiTurnEvaluationResult,
  turnCheckResults: PredicateResult[] = []
): PromptTraceSummary[] {
  return evaluation.promptSummaries.map((summary) => {
    const perTurn = turnCheckResults.filter(
      (r) =>
        r.scope?.kind === "turn" && r.scope.promptIndex === summary.promptIndex
    );
    return {
      promptIndex: summary.promptIndex,
      prompt: summary.prompt,
      expectedToolCalls: summary.expectedToolCalls,
      actualToolCalls: summary.actualToolCalls,
      expectedOutput: summary.expectedOutput,
      passed: summary.passed,
      ...(perTurn.length ? { predicateResults: perTurn } : {}),
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
    };
  });
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

/**
 * The Convex `testCaseSnapshot` validator moved to the unified `steps` model and
 * REJECTS the legacy `promptTurns` field — `ArgumentValidationError: Object
 * contains extra field 'promptTurns'`. That error is swallowed by the
 * iteration-create try/catch, so the run streams a result but NOTHING lands in
 * Runs. Convert `promptTurns → steps` (the canonical adapter) and drop the
 * legacy field so the write validates. No-op when there's no `promptTurns`
 * (already steps-shaped) — and prefers an existing `steps` array if present.
 */
function snapshotWithStepsForConvex(
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !("promptTurns" in snapshot)
  ) {
    return snapshot;
  }
  const { promptTurns, steps, ...rest } = snapshot as Record<string, unknown>;
  const resolvedSteps =
    Array.isArray(steps) && steps.length > 0
      ? steps
      : Array.isArray(promptTurns)
      ? promptTurnsToSteps(promptTurns as PromptTurn[])
      : undefined;
  return resolvedSteps ? { ...rest, steps: resolvedSteps } : rest;
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
      isNegativeTest?: boolean;
      expectedOutput?: string;
      steps?: TestStep[];
      promptTurns?: PromptTurn[];
      advancedConfig?: Record<string, unknown>;
      matchOptions?: import("@/shared/eval-matching").MatchOptionsDTO;
      hostConfigOverride?: Record<string, unknown>;
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
        testCaseSnapshot: sanitizeForConvexTransport(
          snapshotWithStepsForConvex(params.testCaseSnapshot)
        ),
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

/**
 * Shared terminal finalize step for the browser-bearing iteration runners
 * (local + backend, stream + non-stream, success + failure branches). It exists
 * because the iteration's replay `.webm` must be collected from the harness
 * BEFORE the runner's `finally { browser.dispose() }` tears Chromium down — and
 * that ordering has to hold at every finalize site, not just one. Centralizing
 * it here means each site swaps its inline `recorder ? finishIteration :
 * finalizeEvalIteration` branch for this call and the lifecycle is correct by
 * construction.
 *
 * `collectVideo()` is idempotent + fail-soft, so this is safe even when the
 * harness never launched (prompt-only iterations → `videoBytes` is null).
 */
async function finalizeIterationWithBrowserArtifacts(args: {
  browser: BrowserSessionContext;
  recorder: SuiteRunRecorder | null;
  convexClient: ConvexHttpClient;
  finishParams: Parameters<SuiteRunRecorder["finishIteration"]>[0];
}): Promise<void> {
  const videoBytes = await args.browser.collectVideo();
  const finishParams = {
    ...args.finishParams,
    ...(videoBytes ? { videoBytes } : {}),
  };
  if (args.recorder) {
    await args.recorder.finishIteration(finishParams);
  } else {
    await finalizeEvalIteration({
      ...finishParams,
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
  /** Run caller's Convex bearer — used to provision/release the reproducible
   * eval sandbox when the suite pins a computerEnvironment. */
  convexAuthToken: string;
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

// PR6: single hosted wrapper for both modes (emit optional). Owns the browser
// harness lifecycle (try/finally guarantees Chromium teardown on every exit).
const runHostedIteration = async (
  params: RunIterationBackendParams & { emit?: StreamEmit }
): Promise<EvalIterationOutcome> => {
  const browser = await createBrowserSessionContext({
    model: params.test.model,
    mcpClientManager: params.mcpClientManager,
    injectOpenAiCompat: params.injectOpenAiCompat,
  });
  try {
    return await runHostedIterationWithBrowser(params, browser);
  } finally {
    await browser.dispose();
  }
};

// PR4: one dispatcher for both quick-run modes. `emit` present ⇒ streaming
// (SSE iteration runners); absent ⇒ batch (suite/quick-run, recorder terminal).
// The model resolution, precreate-iterations, and run loop are identical; only
// the guard-vs-model-free-fork at the top and the per-branch runner family
// differ. `runTestCase` / `streamTestCase` are thin wrappers below.
// Locate the pending/running iteration row for a (test, runIndex) so a timeout
// can mark it `timed_out`. Prefers the precreated id; otherwise matches on
// testCaseId (model-free) or snapshot identity + iteration number.
async function findIterationIdForTimeout(args: {
  convexClient: ConvexHttpClient;
  runId: string | null;
  precreatedIterationId?: string;
  test: EvalTestCase;
  runIndex: number;
}): Promise<string | undefined> {
  if (args.precreatedIterationId) {
    return args.precreatedIterationId;
  }
  if (args.runId === null) {
    return undefined;
  }

  const resolvedTest = resolveEvalTestCase(args.test);
  const shouldMatchByTestCaseOnly =
    !turnsNeedModel({
      caseType: args.test.caseType,
      promptTurns: resolvedTest.promptTurns,
    }) && Boolean(args.test.testCaseId);
  try {
    const response = await args.convexClient.query(
      "testSuites:getTestSuiteRunDetails" as any,
      { runId: args.runId }
    );
    const iterations = response?.iterations ?? [];
    const matching = iterations.find((iteration: any) => {
      if (
        shouldMatchByTestCaseOnly &&
        iteration.testCaseId === args.test.testCaseId &&
        iteration.iterationNumber === args.runIndex + 1 &&
        (iteration.status === "pending" || iteration.status === "running")
      ) {
        return true;
      }

      const snapshot = iteration.testCaseSnapshot ?? {};
      return (
        snapshot.title === args.test.title &&
        snapshot.query === resolvedTest.query &&
        snapshot.model === args.test.model &&
        snapshot.provider === args.test.provider &&
        iteration.iterationNumber === args.runIndex + 1 &&
        (iteration.status === "pending" || iteration.status === "running")
      );
    });
    return matching?._id as string | undefined;
  } catch (error) {
    logger.warn("[evals] Failed to locate iteration for timeout", {
      runId: args.runId,
      runIndex: args.runIndex,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function markIterationTimedOut(args: {
  convexClient: ConvexHttpClient;
  runId: string | null;
  precreatedIterationId?: string;
  test: EvalTestCase;
  runIndex: number;
}): Promise<void> {
  const iterationId = await findIterationIdForTimeout(args);
  if (!iterationId) {
    return;
  }

  const message = "Iteration timed out after 10 minutes";
  try {
    await args.convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId,
      status: "timed_out",
      result: "timed_out",
      actualToolCalls: [],
      tokensUsed: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages: [{ role: "assistant", content: message }],
      error: message,
      resultSource: "derived",
      metadata: { stopReason: "iteration_timeout" },
    });
  } catch (error) {
    logger.warn("[evals] Failed to mark timed-out iteration", {
      iterationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Race a single iteration against the 10-minute per-iteration cap. On timeout
// the loser (`onTimeout`) aborts the run and marks the row; a finished or
// already-aborted iteration skips the timeout cleanly.
export async function runIterationWithTimeout<T>(args: {
  run: () => Promise<T>;
  onTimeout: () => Promise<void>;
  shouldSkipTimeout: () => boolean;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      args.run(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          if (args.shouldSkipTimeout()) {
            return;
          }
          reject(ITERATION_TIMEOUT_ERROR);
          void args.onTimeout().catch((error) => {
            logger.warn("[evals] Iteration timeout cleanup failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, EVAL_ITERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const executeTestCase = async (params: {
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
  /** Lifecycle abort hook: an iteration timeout aborts the whole run through it. */
  abortRun?: (error: EvalRunStoppedError) => void;
  compareRunId?: string;
  /** Present ⇒ streaming mode: SSE events flow here and iterations run on the
   *  stream* runners. Absent ⇒ batch mode. */
  emit?: StreamEmit;
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
    abortRun,
    compareRunId,
    emit,
    injectOpenAiCompat,
    hostPolicy,
    toolSignals,
    suiteHostConfig,
    environment,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const streaming = emit != null;

  // Normalize legacy `widget_probe` rows into a single model-free pinned turn
  // so the unified engine sees one shape. No-op for already-pinned / prompt
  // cases.
  const normalizedTest = normalizeTestForPinnedTurns(test);

  // Run a single iteration under the per-iteration timeout + run-abort guards.
  // Bails immediately if the run was already stopped; on timeout it aborts the
  // whole run (via `abortRun`) and marks the row `timed_out`.
  const runSingleIteration = async <T extends EvalIterationOutcome>(
    runner: () => Promise<T>,
    precreatedIterationId: string | undefined,
    runIndex: number,
    timeoutTest: EvalTestCase = normalizedTest
  ): Promise<T> => {
    if (abortSignal?.aborted) {
      const reason = abortSignal.reason;
      throw reason instanceof Error ? reason : RUN_CANCELLED_ERROR;
    }
    return await runIterationWithTimeout({
      run: runner,
      shouldSkipTimeout: () => abortSignal?.aborted === true,
      onTimeout: async () => {
        abortRun?.(ITERATION_TIMEOUT_ERROR);
        await markIterationTimedOut({
          convexClient,
          runId,
          precreatedIterationId,
          test: timeoutTest,
          runIndex,
        });
      },
    });
  };

  // Pinned-only case (today's render check): no model turns at all. Run it
  // through the local AI-SDK engine, model-free — it skips all model/BYOK setup
  // and executes each pinned turn via runPinnedTurn. Never routes to a hosted
  // backend (there is no model to bill / drive). PR5: streams too — the local
  // driver's pinned branch synthesizes the SSE sequence via `onPinnedTurn`.
  if (
    !turnsNeedModel({
      caseType: normalizedTest.caseType,
      promptTurns: resolveEvalTestCase(normalizedTest).promptTurns,
    })
  ) {
    const outcomes: EvalIterationOutcome[] = [];
    const pinnedRuns = Math.max(1, Math.floor(normalizedTest.runs || 1));
    for (let runIndex = 0; runIndex < pinnedRuns; runIndex++) {
      if (abortSignal?.aborted) break;
      const modelFreeParams = {
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
        convexAuthToken,
        ...(compareRunId ? { compareRunId } : {}),
        injectOpenAiCompat,
        hostPolicy,
        toolSignals,
        suiteHostConfig,
        environment,
      };
      outcomes.push(
        await runSingleIteration(
          () =>
            runLocalIteration({
              ...modelFreeParams,
              ...(streaming ? { emit: emit! } : {}),
            }),
          undefined,
          runIndex,
          normalizedTest
        )
      );
    }
    return outcomes;
  }

  // Hybrid (model turns + pinned turns) on a hosted model is not yet wired:
  // the backend engine drives turns server-side and cannot interleave a
  // locally-executed pinned turn. Local BYOK hybrids work (the pinned branch
  // lives in runIterationWithAiSdk). Fail loudly rather than silently send a
  // pinned turn's empty prompt to the model.
  // Steps-aware: resolveEvalTestCase bridges `steps` → turns, so a `toolCall`
  // step is correctly seen as a pinned turn here.
  const caseHasPinnedTurn =
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
    const resolvedStepsForPrecreate = resolveSteps(test);
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
            steps: resolvedStepsForPrecreate,
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
      const backendParams = {
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
        environment,
      };
      const iterationOutcome = await runSingleIteration(
        () =>
          runHostedIteration({
            ...backendParams,
            ...(streaming ? { emit: emit! } : {}),
          }),
        precreatedIterationId,
        runIndex,
        test
      );
      outcomes.push(iterationOutcome);
      continue;
    }

    if (orgByokRuntime?.kind === "cloud") {
      const backendParams = {
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
        endpointPath: "/stream/org" as const,
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
        environment,
      };
      const iterationOutcome = await runSingleIteration(
        () =>
          runHostedIteration({
            ...backendParams,
            ...(streaming ? { emit: emit! } : {}),
          }),
        precreatedIterationId,
        runIndex,
        test
      );
      outcomes.push(iterationOutcome);
      continue;
    }

    const localParams = {
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
      // `environment` resolves a pinned turn's server (local hybrids); harmless
      // for prompt-only cases.
      environment,
      convexAuthToken,
    };
    const iterationOutcome = await runSingleIteration(
      () =>
        runLocalIteration({
          ...localParams,
          ...(streaming ? { emit: emit! } : {}),
        }),
      precreatedIterationId,
      runIndex,
      test
    );
    outcomes.push(iterationOutcome);
  }

  return outcomes;
};

// Thin batch wrapper (no `emit`) — preserves the call site in
// `runEvalSuiteWithAiSdk` and tests with zero churn.
const runTestCase = (
  params: Omit<Parameters<typeof executeTestCase>[0], "emit">
) => executeTestCase(params);

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

  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
  };

  try {
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
    // Abort the whole run with a reason (cancel vs timeout). The reason rides on
    // the AbortSignal so iteration runners and the catch below can distinguish
    // user-cancel from a hard timeout.
    const abortRun = (error: EvalRunStoppedError) => {
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
    };
    let stopControls = false;
    let runTimeoutId: ReturnType<typeof setTimeout> | undefined;

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
        abortRun,
        injectOpenAiCompat,
        hostPolicy: hostExecutionPolicy,
        toolSignals: resolvedToolSignals,
        suiteHostConfig,
        environment: config.environment,
      });
    const testPromises = tests.map((test) =>
      // Cap concurrent headless browsers for every model-free render check
      // (legacy widget_probe OR a unified case whose turns are all pinned),
      // not just the legacy discriminator — otherwise a monitoring suite of
      // new pinned-only cases launches one Chromium per case at once.
      isPinnedOnly({
        caseType: test.caseType,
        promptTurns: resolveEvalTestCase(test).promptTurns,
      })
        ? renderCheckLimit(() => runOne(test))
        : runOne(test)
    );

    // Poll the run status: user cancellation, or a `timed_out` status set
    // elsewhere (e.g. a sibling worker), both abort the run with a reason.
    const createCancellationChecker = async () => {
      if (runId === null) return; // Quick runs can't be cancelled

      while (!stopControls) {
        await delay(EVAL_CANCEL_POLL_MS);
        if (stopControls) return;
        try {
          const currentRun = await convexClient.query(
            "testSuites:getTestSuiteRun" as any,
            { runId }
          );
          if (currentRun?.status === "cancelled") {
            abortRun(RUN_CANCELLED_ERROR);
            throw RUN_CANCELLED_ERROR;
          }
          if (currentRun?.status === "timed_out") {
            abortRun(RUN_TIMEOUT_ERROR);
            throw RUN_TIMEOUT_ERROR;
          }
        } catch (error) {
          if (isEvalRunStoppedError(error)) {
            throw error;
          }
          // If run not found, it was deleted - treat as cancelled
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes("not found") ||
            errorMessage.includes("unauthorized")
          ) {
            abortRun(RUN_CANCELLED_ERROR);
            throw RUN_CANCELLED_ERROR;
          }
        }
      }
    };

    // Periodic liveness ping so the run isn't reaped as stalled while working.
    const createHeartbeatLoop = async () => {
      if (runId === null) return;
      while (!stopControls) {
        try {
          await convexClient.mutation(
            "testSuites:heartbeatTestSuiteRun" as any,
            { runId }
          );
        } catch (error) {
          logger.warn("[evals] Failed to heartbeat eval run", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await delay(EVAL_HEARTBEAT_MS);
      }
    };

    // Hard whole-run timeout: aborts in-flight work and rejects the race.
    // Returns Promise<never> (only ever rejects) so the race result type stays
    // PromiseSettledResult[].
    const createRunTimeout = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        runTimeoutId = setTimeout(() => {
          abortRun(RUN_TIMEOUT_ERROR);
          reject(RUN_TIMEOUT_ERROR);
        }, EVAL_RUN_TIMEOUT_MS);
      });

    // Surface an `EvalRunStoppedError` thrown by ANY iteration immediately
    // (e.g. a per-iteration timeout). `Promise.allSettled` would otherwise
    // swallow it, so the run-level race would never see the stop.
    const never = () => new Promise<never>(() => {});
    const firstLifecycleStop = Promise.race(
      testPromises.map((promise) =>
        promise.then(never, (error) => {
          if (isEvalRunStoppedError(error)) {
            throw error;
          }
          return never();
        })
      )
    );
    const allTestsSettled = Promise.allSettled(testPromises);

    let results: PromiseSettledResult<EvalIterationOutcome[]>[];
    const heartbeatLoop = createHeartbeatLoop().catch((error) => {
      logger.warn("[evals] Eval heartbeat loop stopped unexpectedly", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    try {
      // Race tests completing, a lifecycle stop from an iteration, user
      // cancellation, and the hard run timeout.
      results = await Promise.race([
        Promise.race([allTestsSettled, firstLifecycleStop]),
        createCancellationChecker().then(() => {
          // This will never resolve, only reject if cancelled
          return new Promise<never>(() => {});
        }),
        createRunTimeout(),
      ]);
    } catch (error) {
      if (isEvalRunStoppedError(error)) {
        logger.debug("[evals] Run stopped by lifecycle guard", {
          reason: error.stopReason,
        });

        // Give in-flight iterations a brief grace to settle after the abort
        // before we finalize, so partial rows can flush.
        await Promise.race([
          Promise.allSettled(testPromises),
          delay(EVAL_ABORT_GRACE_MS),
        ]);
        if (recorder) {
          await recorder.finalize({
            status: error.terminalStatus,
            notes: error.notes,
            stopReason: error.stopReason,
          });
        }
        return undefined;
      }
      throw error;
    } finally {
      stopControls = true;
      if (runTimeoutId) {
        clearTimeout(runTimeoutId);
      }
      void heartbeatLoop;
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

// PR6: the single local (BYOK) iteration runner for BOTH quick-run modes.
// `emit` present ⇒ streaming (SSE sinks built per turn); absent ⇒ batch (no
// sinks → driveLocalEvalTurn runs headless via a no-op terminal). Replaces the
// former runIterationWithAiSdk + streamIterationWithAiSdk pair, which differed
// only in SSE emission.
const runLocalIteration = async ({
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
  environment,
  convexAuthToken,
}: RunIterationAiSdkParams & {
  emit?: StreamEmit;
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
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions
            ),
            passed: false,
          },
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
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions
            ),
            passed: false,
          },
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
  const caseNeedsModel = turnsNeedModel({
    caseType: test.caseType,
    promptTurns,
  });
  // First pinned turn's render-budget override; applied to the shared harness.
  const pinnedRenderTimeoutMs = promptTurns.find(
    (t) =>
      isPinnedTurn(t) && typeof t.pinnedToolCall?.renderTimeoutMs === "number"
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
  const resolvedSteps = resolveSteps(test);
  const testCaseSnapshot = {
    title: test.title,
    query,
    provider: test.provider,
    model: test.model,
    runs: test.runs,
    expectedToolCalls,
    isNegativeTest: test.isNegativeTest,
    expectedOutput,
    steps: resolvedSteps,
    advancedConfig,
    matchOptions: test.matchOptions,
    hostConfigOverride: test.hostConfigOverride,
  };
  const iterationParamsBase = {
    testCaseId: test.testCaseId ?? testCaseId,
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };
  const shouldOmitSnapshotForPairing =
    !caseNeedsModel &&
    (precreatedIterationId !== undefined || recorder !== null);
  const iterationParams = {
    ...iterationParamsBase,
    // Model-free (pinned-only) iterations omit the testCaseSnapshot so the
    // recorder pairs the pre-created row by testCaseId + iterationNumber. The
    // snapshot's query is synthesized ("Pinned tool call: …") and would never
    // match the pre-created row's stored query, leaving the row unpaired and
    // perpetually pending. Mirrors the old probe path, which passed no snapshot.
    ...(shouldOmitSnapshotForPairing ? {} : { testCaseSnapshot }),
  };

  const iterationId = precreatedIterationId
    ? precreatedIterationId
    : recorder
    ? await recorder.startIteration(iterationParams)
    : await createIterationDirectly(convexClient, {
        ...iterationParamsBase,
        testCaseSnapshot,
      });

  // PR2: shared per-iteration accumulator (mirrors the batch runner). The
  // streaming runner threads it through `driveLocalEvalTurn` and reads it
  // post-loop / in the catch. `conversationMessages` starts empty; the system
  // is carried out-of-band via `withSystemPrefix` (SSE) + persistence. Pinned
  // fields stay empty/false here (streaming quick-run rejects pinned/model-free
  // up front in `streamTestCase` until PR5).
  const acc: LocalEvalTurnAcc = {
    conversationMessages: [],
    capturedSpans: [],
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    toolsCalledByPrompt: [],
    assistantMessageByPrompt: [],
    toolErrorsByPrompt: [],
    pinnedToolErrors: [],
    activePromptIndex: -1,
    activePromptInputMessages: [],
    activePartialResponseMessages: [],
    activeCompletedStepCount: 0,
    activeTraceCtx: null,
    iterationError: undefined,
    iterationErrorDetails: undefined,
    pinnedSetupFailure: false,
  };
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
    ...(pinnedRenderTimeoutMs
      ? { renderTimeoutMs: pinnedRenderTimeoutMs }
      : {}),
  });

  // Reproducible-evals sandbox: provisioned per-iteration inside the try (so a
  // failure is a recorded failed iteration), released in the finally. Declared
  // here so the finally always sees it.
  let evalSandbox: Awaited<ReturnType<typeof provisionEvalSandbox>> | null =
    null;

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
        ...(resolvedExecution.harness
          ? { harness: resolvedExecution.harness }
          : {}),
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

      // Reproducible evals: boot a fresh ephemeral sandbox from the suite's
      // pinned image and expose it to the agent as a `bash` tool. The personal
      // computer stays banned; this is the per-iteration reproducible path. A
      // provision failure becomes a recorded failed iteration (we're in the
      // try); the finally releases the box. Runs BEFORE the toolChoice check
      // below so a forced `toolChoice: { toolName: "bash" }` on a pinned-env run
      // sees `bash` in `prepared.allTools` instead of failing "not available".
      //
      // This whole block is under `caseNeedsModel` BY DESIGN: a model-free
      // (pinned-only) iteration has no agent turn, so nothing would ever invoke
      // the bash tool — provisioning a paid sandbox for it would be pure waste.
      const pinnedEnvironmentId = (
        environment as { computerEnvironmentId?: string } | undefined
      )?.computerEnvironmentId;
      if (pinnedEnvironmentId && runId !== null) {
        // Don't provision unless this server is a fully-configured data plane.
        // Provisioning only needs the user bearer, but EXEC needs E2B_API_KEY
        // and RELEASE needs COMPUTERS_DATA_PLANE_SECRET — without them
        // releaseEvalSandbox silently no-ops, so each iteration would boot a
        // paid box only the backend TTL GC could reap. Fail loudly instead.
        if (!isComputersDataPlaneConfigured()) {
          throw new Error(
            "This eval pins a reproducible computer environment, but this server isn't configured as a computers data plane (needs CONVEX_HTTP_URL, COMPUTERS_DATA_PLANE_SECRET, and E2B_API_KEY) — it could provision a sandbox but not exec or release it."
          );
        }
        evalSandbox = await provisionEvalSandbox({
          bearer: convexAuthToken,
          runId: String(runId),
          ...(iterationId ? { iterationId: String(iterationId) } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!evalSandbox.ok) {
          throw new Error(
            `Could not provision the eval's reproducible sandbox: ${evalSandbox.error}`
          );
        }
        prepared.allTools[EVAL_BASH_TOOL_NAME] = buildEvalBashTool({
          sandboxId: evalSandbox.value.sandboxId,
        });
      }

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
      // Aborted mid-iteration — never score as passed (a pinned-only case would
      // otherwise short-circuit to passed:true).
      evaluation: {
        ...evaluateMultiTurnResults(
          promptTurns,
          acc.toolsCalledByPrompt,
          test.isNegativeTest,
          test.matchOptions
        ),
        passed: false,
      },
      iterationId: undefined,
    });

    // Streaming play-by-play, built once and consumed by the executeSteps handlers
    // (per turn). `undefined` in batch mode (no `emit`) → headless. The per-turn
    // `step_status` it emits coexists with executeSteps' per-step status (different
    // reducer keys; the editor prefers per-step).
    const makeSinks:
      | ((turnIndex: number, prompt: string) => LocalEvalTurnSinks)
      | undefined = emit
      ? (turnIndex, prompt) => ({
          emit,
          getStepIndex: () => acc.activeCompletedStepCount,
          onTurnStart: () => {
            emit({ type: "turn_start", turnIndex, prompt });
            emit({
              type: "step_status",
              turnIndex,
              kind: "prompt",
              status: "running",
            });
          },
          onStepSnapshot: ({ stepIndex, messages, spans, usage }) => {
            emit(
              buildTraceSnapshotEvent({
                turnIndex,
                stepIndex,
                snapshotKind: "step_finish",
                messages: withSystemPrefix(messages),
                spans,
                actualToolCalls: extractToolCallsFromConversation({ messages }),
                usage,
              })
            );
          },
          onTurnFailure: ({
            messages,
            spans,
            usage,
            stepIndex,
            iterationError: turnError,
          }) => {
            emit(
              buildTraceSnapshotEvent({
                turnIndex,
                ...(stepIndex != null ? { stepIndex } : {}),
                snapshotKind: "failure",
                messages: withSystemPrefix(messages),
                spans,
                actualToolCalls: extractToolCallsFromConversation({ messages }),
                usage,
              })
            );
            emit({
              type: "step_status",
              turnIndex,
              kind: "prompt",
              status: "fail",
              detail: turnError,
            });
            emit({ type: "error", message: turnError });
          },
          onTurnSuccess: ({ messages, spans, usage }) => {
            emit(
              buildTraceSnapshotEvent({
                turnIndex,
                snapshotKind: "turn_finish",
                messages: withSystemPrefix(messages),
                spans,
                actualToolCalls: extractToolCallsFromConversation({ messages }),
                usage,
              })
            );
            emit({ type: "turn_finish", turnIndex });
            emit({
              type: "step_status",
              turnIndex,
              kind: "prompt",
              status: "ok",
            });
          },
          onPinnedTurn: ({
            prompt: pinnedPrompt,
            messages,
            spans,
            usage,
            toolCall,
            toolCallId,
            toolResult,
            toolResultIsError,
            toolError,
            iterationError: pinnedErr,
          }) => {
            const failureDetail =
              pinnedErr ??
              toolError?.message ??
              (toolResultIsError ? "Pinned tool call failed" : undefined);
            emit({ type: "turn_start", turnIndex, prompt: pinnedPrompt });
            emit({
              type: "step_status",
              turnIndex,
              kind: "toolCall",
              status: "running",
            });
            if (toolCall && toolCallId) {
              emit({
                type: "tool_call",
                toolName: toolCall.toolName,
                toolCallId,
                args: toolCall.arguments,
              });
              emit({
                type: "tool_result",
                toolCallId,
                result: toolResult,
                ...(toolResultIsError ? { isError: true } : {}),
              });
            }
            emit(
              buildTraceSnapshotEvent({
                turnIndex,
                snapshotKind: failureDetail ? "failure" : "turn_finish",
                messages: withSystemPrefix(messages),
                spans,
                actualToolCalls: toolCall ? [toolCall] : [],
                usage,
              })
            );
            emit({ type: "turn_finish", turnIndex });
            emit({
              type: "step_status",
              turnIndex,
              kind: "toolCall",
              status: failureDetail ? "fail" : "ok",
              ...(failureDetail ? { detail: failureDetail } : {}),
            });
            if (failureDetail) {
              emit({ type: "error", message: failureDetail });
            }
          },
        })
      : undefined;

    // Fail-fast skipped steps (PR6) → persisted to metadata.skippedSteps.
    let stepSkippedSteps: unknown[] = [];
    // One verdict row per authored step → persisted to metadata.stepResults
    // (the clean per-step contract the public /steps API projects).
    let stepResults: unknown[] = [];
    // §2: failed interact / widget-DOM-assert steps recorded in StepExecutionState
    // (not in browser.scriptedCheckFailures) — folded into the verdict's
    // scripted-check gate so they actually fail the iteration.
    let stepScriptedFailures: { toolName: string; reason: string }[] = [];
    // Drive the iteration through the sequential executeSteps engine: the handlers
    // wrap driveLocalEvalTurn (which mutates `acc`), so the post-loop verdict +
    // finishParams below consume `acc` + the executor's StepExecutionState.
    const steps = resolveSteps(test);
    const stepHandlers = buildLocalStepHandlers({
      acc,
      browser,
      mcpClientManager,
      selectedServers,
      resolvePinnedServerKey: (pinned) =>
        resolvePinnedServerKey(
          pinned,
          environment,
          selectedServers,
          mcpClientManager
        ),
      prepared,
      llmModel,
      test,
      runStartedAt,
      runIndex,
      iterationId,
      suiteId,
      runId,
      testCaseId,
      abortSignal,
      toolChoice,
      extractToolCalls: extractToolCallsFromConversation,
      // Per-turn streaming play-by-play (headless in batch).
      buildSinks: makeSinks,
    });
    const stepState = createStepExecutionState();
    await executeSteps({
      steps,
      state: stepState,
      browser,
      handlers: stepHandlers,
      isAborted: localIsAborted,
      // PR5: per-step status → SSE (keyed by stepId for per-card ticking).
      ...(emit
        ? {
            onStepStatus: (e) =>
              emit({
                type: "step_status",
                turnIndex: e.turnOrdinal,
                stepId: e.stepId,
                kind: e.kind,
                status: e.status,
              }),
          }
        : {}),
    });
    // Fail-fast skipped steps (PR6) → persisted to metadata.skippedSteps.
    stepSkippedSteps = stepState.skippedSteps;
    // One verdict row per authored step → metadata.stepResults.
    stepResults = buildStepResultRecords(stepState, steps);
    // §2: interact / widget-assert failures → the scripted-check gate below.
    stepScriptedFailures = buildStepScriptedCheckFailures(stepState);
    if (localIsAborted()) return returnLocalCancelled();

    // Widget→host tool calls (a tool a widget invoked, e.g. from an authored
    // click) live outside the model transcript. Fold them into each turn's
    // actual-call set ONCE here, so a single "tool was called" check sees them
    // whether it's authored as an expected tool call (matcher, below) OR as a
    // predicate (per-turn `checks` + case-level, which read `evaluation`'s
    // flattened calls). Widget calls are real tool calls, so they participate in
    // matching uniformly — including counting as actuals for extras/negative
    // accounting (a click that fires a tool the case forbade SHOULD fail it).
    const toolsCalledByPromptWithWidgets = mergeToolCallsByPromptIndex(
      acc.toolsCalledByPrompt,
      widgetToolCallsByPromptIndex(browser.browserInteractionSteps)
    );
    // Per-turn predicate results from step assert execution facts (not a
    // re-evaluation of promptTurns.checks — avoids duplicates vs executeSteps).
    const turnCheckResults = resolveTurnCheckResultsFromStepExecution(
      stepState,
      steps,
    );
    const failOnToolError =
      (advancedConfig as { failOnToolError?: boolean } | undefined)
        ?.failOnToolError !== false;
    const traceForGate =
      acc.capturedSpans.length > 0 || acc.conversationMessages.length > 0
        ? {
            ...(acc.capturedSpans.length > 0
              ? { spans: acc.capturedSpans }
              : {}),
            messages: acc.conversationMessages as ModelMessage[] as Array<{
              role: string;
              content: unknown;
            }>,
          }
        : undefined;
    // A pinned-only case (render check) with no authored predicates defaults to
    // "the widget rendered" — the model-free equivalent of the legacy probe
    // verdict. Mirrors the former runIterationWithAiSdk post-loop.
    const effectivePredicates = test.successPredicates?.length
      ? test.successPredicates
      : isPinnedOnly({ caseType: test.caseType, promptTurns })
      ? ([{ type: "widgetRendered" }] as NonNullable<
          typeof test.successPredicates
        >)
      : undefined;
    // Flush the last turn's groups so a trailing turn's unrun checks still fail
    // closed, before the shared verdict reads scripted-check failures. (Flush
    // only mutates `scriptedCheckFailures`, which no earlier gate reads, so
    // doing it here is equivalent to the former post-finalize position.)
    browser.flushActiveWidgetChecks();
    // Single verdict boundary — matcher + case predicates + ordering + all gates.
    const { evaluation, passed, predicateResults } = buildEvalIterationVerdict({
      promptTurns,
      toolsCalledByPrompt: toolsCalledByPromptWithWidgets,
      isNegativeTest: test.isNegativeTest,
      matchOptions: test.matchOptions,
      turnCheckResults,
      effectivePredicates,
      trace: traceForGate,
      usage: hasReportedUsage(acc.accumulatedUsage)
        ? acc.accumulatedUsage
        : undefined,
      renderObservations: summarizeRenderObservations(
        browser.widgetRenderObservations
      ),
      toolErrors: acc.pinnedToolErrors,
      iterationError: acc.iterationError,
      failOnToolError,
      pinnedToolErrors: acc.pinnedToolErrors,
      // §2: legacy push-model failures + executeSteps interact/widget-assert failures.
      scriptedCheckFailures: [
        ...browser.scriptedCheckFailures,
        ...stepScriptedFailures,
      ],
    });
    const promptTraceSummaries = buildPromptTraceSummaries(
      evaluation,
      turnCheckResults
    );
    // Reflect the gated verdict (match AND tool-error gate AND predicates) in
    // the returned evaluation so totals built from `evaluation.passed` agree
    // with the persisted iteration result.
    evaluation.passed = passed;

    const usageFinal: UsageTotals = {
      inputTokens: acc.accumulatedUsage.inputTokens,
      outputTokens: acc.accumulatedUsage.outputTokens,
      totalTokens: acc.accumulatedUsage.totalTokens,
    };
    const widgetSnapshots = await captureMcpAppWidgetSnapshots({
      injectOpenAiCompat,
      messages: acc.conversationMessages,
      mcpClientManager,
      convexClient,
    });
    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. The `withSystemPrefix`
    // closure above still applies the prefix to LIVE SSE
    // `trace_snapshot` events for the test-runner UI (different
    // consumer than the stored transcript).
    const finishParams = buildIterationFinishParams({
      iterationId,
      passed,
      evaluation,
      usage: usageFinal,
      messages: acc.conversationMessages,
      ...(streamEnhancedSystemPromptForPersist
        ? { systemPrompt: streamEnhancedSystemPromptForPersist }
        : {}),
      spans: acc.capturedSpans,
      prompts: promptTraceSummaries,
      ...(widgetSnapshots ? { widgetSnapshots } : {}),
      // PR 9: browser artifacts from the streamed Computer Use path.
      widgetRenderObservations: browser.widgetRenderObservations,
      browserInteractionSteps: browser.browserInteractionSteps,
      // A model-free pinned setup failure (server not connected) records as
      // "failed"; everything else completes (a failed verdict is still a
      // completed run). Mirrors the former runIterationWithAiSdk.
      status: acc.pinnedSetupFailure ? "failed" : "completed",
      startedAt: runStartedAt,
      // PR 5a (mirror PR 4b): if the per-turn loop set `iterationError`
      // via the failure-detection branch, surface it on the persisted
      // iteration via `status:"completed"` + `error` — the run
      // completed cleanly but the cycle failed.
      ...(acc.iterationError ? { error: acc.iterationError } : {}),
      ...(acc.iterationErrorDetails
        ? { errorDetails: acc.iterationErrorDetails }
        : {}),
      predicateResults,
      ...(stepSkippedSteps.length ? { skippedSteps: stepSkippedSteps } : {}),
      ...(stepResults.length ? { stepResults } : {}),
      iterationMetadataBase,
      ...(hostPolicy ? { hostPolicy } : {}),
      ...(toolSignals ? { toolSignals } : {}),
      injectOpenAiCompat,
    });

    await finalizeIterationWithBrowserArtifacts({
      browser,
      recorder,
      convexClient,
      finishParams,
    });

    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[evals] streaming iteration aborted due to cancellation");
      // Force passed:false (see the non-stream runner) so an all-pinned case
      // can't score a pass on abort.
      return {
        evaluation: {
          ...evaluateMultiTurnResults(
            promptTurns,
            acc.toolsCalledByPrompt,
            test.isNegativeTest,
            test.matchOptions
          ),
          passed: false,
        },
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
    if (acc.activeTraceCtx) {
      finalizeAiSdkTraceOnFailure(acc.activeTraceCtx, failAt, {
        completedStepCount: acc.activeCompletedStepCount,
        lastStepEndedAt: acc.activeTraceCtx.lastStepClosedEndAt,
        modelId: test.model,
        promptIndex: acc.activePromptIndex >= 0 ? acc.activePromptIndex : 0,
      });
      acc.capturedSpans.push(...acc.activeTraceCtx.recordedSpans);
    }
    appendPartialToolCallsToPrompt({
      toolsCalledByPrompt: acc.toolsCalledByPrompt,
      promptIndex: acc.activePromptIndex,
      partialResponseMessages: acc.activePartialResponseMessages,
    });
    const failMessages =
      acc.activePromptInputMessages.length > 0
        ? acc.activeCompletedStepCount > 0 ||
          acc.activePartialResponseMessages.length > 0
          ? [
              ...acc.activePromptInputMessages,
              ...acc.activePartialResponseMessages,
            ]
          : acc.activePromptInputMessages
        : acc.conversationMessages;
    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      acc.toolsCalledByPrompt,
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

    // PR6: SSE failure signal only in streaming mode (batch has no emit).
    if (emit) {
      emit(
        buildTraceSnapshotEvent({
          turnIndex: acc.activePromptIndex >= 0 ? acc.activePromptIndex : 0,
          ...(acc.activeCompletedStepCount > 0
            ? { stepIndex: acc.activeCompletedStepCount - 1 }
            : {}),
          snapshotKind: "failure",
          messages: withSystemPrefix(failMessages),
          spans: acc.capturedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: failMessages,
          }),
          usage: {
            inputTokens: acc.accumulatedUsage.inputTokens,
            outputTokens: acc.accumulatedUsage.outputTokens,
            totalTokens: acc.accumulatedUsage.totalTokens,
          },
          prompts: promptTraceSummaries,
        })
      );
      emit({
        type: "error",
        message: errorMessage ?? "Eval iteration failed",
        details: errorDetails,
      });
    }

    // PR (this change): the resolved system prompt now flows through
    // `appendEvalTurnTrace.systemPrompt`. Same threading as the
    // success path.
    const failParams = buildIterationFinishParams({
      iterationId,
      passed: false,
      evaluation,
      usage: {
        inputTokens: acc.accumulatedUsage.inputTokens,
        outputTokens: acc.accumulatedUsage.outputTokens,
        totalTokens: acc.accumulatedUsage.totalTokens,
      },
      messages: failMessages,
      ...(streamEnhancedSystemPromptForPersist
        ? { systemPrompt: streamEnhancedSystemPromptForPersist }
        : {}),
      spans: acc.capturedSpans,
      prompts: promptTraceSummaries,
      ...(widgetSnapshots ? { widgetSnapshots } : {}),
      // PR 9: browser artifacts collected before the failure still persist.
      widgetRenderObservations: browser.widgetRenderObservations,
      browserInteractionSteps: browser.browserInteractionSteps,
      status: "failed",
      startedAt: runStartedAt,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(errorDetails ? { errorDetails } : {}),
      iterationMetadataBase,
      ...(hostPolicy ? { hostPolicy } : {}),
      ...(toolSignals ? { toolSignals } : {}),
      injectOpenAiCompat,
    });

    await finalizeIterationWithBrowserArtifacts({
      browser,
      recorder,
      convexClient,
      finishParams: failParams,
    });
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } finally {
    // Tear down the per-iteration eval sandbox (idempotent; GC reaps any miss).
    if (evalSandbox?.ok) {
      await releaseEvalSandbox({
        sandboxRowId: evalSandbox.value.sandboxRowId,
      }).catch(() => {});
    }
    // PR 9: tear down the harness (and its headless Chromium, if launched) on
    // success, failure, OR mid-stream abort. No-op when never constructed.
    await browser.dispose();
  }
};

// PR6: the single hosted iteration runner for BOTH quick-run modes. `emit`
// present ⇒ streaming (buildSinks wires SSE into driveHostedEvalTurn); absent ⇒
// batch (no buildSinks → driveHostedEvalTurn runs headless). Replaces the
// runIterationViaBackendWithBrowser + streamIterationViaBackendWithBrowser pair.
const runHostedIterationWithBrowser = async (
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
    // Pinned reproducible-env id lives on the run environment; drives per-
    // iteration eval-sandbox provisioning + the bash tool (hosted parity with
    // the local runner).
    environment,
  }: RunIterationBackendParams & {
    emit?: StreamEmit;
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
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions
            ),
            passed: false,
          },
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
          // A cancelled / deleted-run iteration never executed — never score it
          // as passed. evaluateMultiTurnResults returns passed:true for an
          // all-pinned case with no calls, so override explicitly.
          evaluation: {
            ...evaluateMultiTurnResults(
              resolvedTest.promptTurns,
              [],
              test.isNegativeTest,
              test.matchOptions
            ),
            passed: false,
          },
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
  const resolvedSteps = resolveSteps(test);

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
      steps: resolvedSteps,
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
  // Reproducible-eval sandbox for this hosted iteration (parity with the local
  // runner). Provisioned inside the prepareChatV2 try so a failure records a
  // clean failed iteration; released right after the agent run below.
  let evalSandbox: Awaited<ReturnType<typeof provisionEvalSandbox>> | null =
    null;
  const releaseEvalSandboxIfAny = async (): Promise<void> => {
    if (evalSandbox?.ok) {
      const { sandboxRowId } = evalSandbox.value;
      evalSandbox = null;
      await releaseEvalSandbox({ sandboxRowId }).catch(() => {});
    }
  };
  let prepared: PrepareChatV2Result;
  try {
    prepared = await prepareChatV2({
      mcpClientManager,
      selectedServers,
      modelDefinition,
      systemPrompt,
      temperature,
      respectToolVisibility: hostPolicy?.respectToolVisibility,
      ...(resolvedExecution.harness
        ? { harness: resolvedExecution.harness }
        : {}),
      ...(backendCustomProviders?.length
        ? { customProviders: backendCustomProviders }
        : {}),
      priorMessages: [],
      ...(builtInTools ? { builtInTools } : {}),
    });
    // PR 4d review fix (Codex P2 / Cursor Medium): same persistence
    // prefix shape as the non-stream backend runner.
    backendEnhancedSystemPromptForPersist = prepared.enhancedSystemPrompt;
    // Pinned env → boot a fresh ephemeral sandbox and add the `bash` tool to
    // prepared.allTools (the hosted path serializes those to toolDefs for the
    // backend agent, then executes tool calls inspector-side). A provision
    // failure throws → the catch below persists a failed iteration.
    const pinnedEnvironmentId = (
      environment as { computerEnvironmentId?: string } | undefined
    )?.computerEnvironmentId;
    if (pinnedEnvironmentId && runId !== null) {
      if (!isComputersDataPlaneConfigured()) {
        throw new Error(
          "This eval pins a reproducible computer environment, but this server isn't configured as a computers data plane (needs CONVEX_HTTP_URL, COMPUTERS_DATA_PLANE_SECRET, and E2B_API_KEY) — it could provision a sandbox but not exec or release it."
        );
      }
      evalSandbox = await provisionEvalSandbox({
        bearer: convexAuthToken,
        runId: String(runId),
        ...(iterationId ? { iterationId: String(iterationId) } : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      if (!evalSandbox.ok) {
        throw new Error(
          `Could not provision the eval's reproducible sandbox: ${evalSandbox.error}`
        );
      }
      prepared.allTools[EVAL_BASH_TOOL_NAME] = buildEvalBashTool({
        sandboxId: evalSandbox.value.sandboxId,
      });
    }
  } catch (error) {
    // Release any sandbox provisioned before a later line in the try threw.
    await releaseEvalSandboxIfAny();
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
    // emits an `error` event for the same failure mode. (Batch: no emit.)
    emit?.({
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
  // Per-turn streaming play-by-play for the executeSteps handlers (headless in batch).
  const hostedBuildSinks = emit
    ? buildHostedEvalSinks({
        emit,
        messageHistory,
        capturedSpans,
        accumulatedUsage,
        withSystemPrefix,
        extractToolCalls: (messages) =>
          extractToolCallsFromConversation({ messages }),
        buildTraceSnapshotEvent,
      })
    : undefined;
  // §2 + fail-fast facts from the executeSteps path.
  let hostedStepSkippedSteps: unknown[] = [];
  let hostedStepResults: unknown[] = [];
  let hostedStepScriptedFailures: { toolName: string; reason: string }[] = [];
  // Hosted unify: drive the iteration through executeSteps; the handlers wrap
  // driveHostedEvalTurn (which mutates the acc), so the post-loop verdict +
  // finishParams below consume `acc` + the executor's StepExecutionState.
  const steps = resolveSteps(test);
  const hostedHandlers = buildHostedStepHandlers({
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
    harness: resolvedExecution.harness,
    requireToolApproval: resolvedExecution.requireToolApproval,
    ...(builtInTarget && "projectId" in builtInTarget
      ? { projectId: builtInTarget.projectId }
      : {}),
    logSuffix: emit ? " (stream)" : "",
    extractToolCalls: (messages) =>
      extractToolCallsFromConversation({ messages }),
    acc: {
      messageHistory,
      capturedSpans,
      accumulatedUsage,
      toolsCalledByPrompt,
    },
    buildSinks: hostedBuildSinks,
  });
  const stepState = createStepExecutionState();
  let result: Awaited<ReturnType<typeof executeSteps>>;
  try {
    result = await executeSteps({
      steps,
      state: stepState,
      browser,
      handlers: hostedHandlers,
      isAborted,
      ...(emit
        ? {
            onStepStatus: (e) =>
              emit({
                type: "step_status",
                turnIndex: e.turnOrdinal,
                stepId: e.stepId,
                kind: e.kind,
                status: e.status,
              }),
          }
        : {}),
    });
  } finally {
    // The eval sandbox is only used during the agent run; release as soon as it
    // finishes or throws — the verdict/finalize below don't need it, and the
    // backend GC reaps anything this misses.
    await releaseEvalSandboxIfAny();
  }
  if (isAborted()) return returnCancelled();
  if (result.iterationError) {
    iterationError = result.iterationError;
    iterationErrorDetails = result.iterationErrorDetails;
  }
  hostedStepSkippedSteps = stepState.skippedSteps;
  hostedStepResults = buildStepResultRecords(stepState, steps);
  hostedStepScriptedFailures = buildStepScriptedCheckFailures(stepState);

  // Fold widget→host tool calls into each turn's actual-call set once (see the
  // local path) so a single "tool was called" check covers widget-initiated
  // calls whether authored as an expected tool call or a predicate.
  const toolsCalledByPromptWithWidgets = mergeToolCallsByPromptIndex(
    toolsCalledByPrompt,
    widgetToolCallsByPromptIndex(browser.browserInteractionSteps)
  );
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
  // Per-turn predicate results from step assert execution (hosted parity).
  const turnCheckResults = resolveTurnCheckResultsFromStepExecution(
    stepState,
    steps,
  );
  const effectivePredicates = test.successPredicates?.length
    ? test.successPredicates
    : isPinnedOnly({ caseType: test.caseType, promptTurns })
      ? ([{ type: "widgetRendered" }] as NonNullable<
          typeof test.successPredicates
        >)
      : undefined;
  // Flush before the shared verdict reads scripted-check failures (see local path).
  browser.flushActiveWidgetChecks();
  const { evaluation, passed, predicateResults } = buildEvalIterationVerdict({
    promptTurns,
    toolsCalledByPrompt: toolsCalledByPromptWithWidgets,
    isNegativeTest: test.isNegativeTest,
    matchOptions: test.matchOptions,
    turnCheckResults,
    effectivePredicates,
    trace: traceForGate,
    usage: hasReportedUsage(accumulatedUsage) ? accumulatedUsage : undefined,
    renderObservations: summarizeRenderObservations(
      browser.widgetRenderObservations
    ),
    iterationError,
    failOnToolError,
    pinnedToolErrors: [],
    // §2: legacy push-model failures + executeSteps interact/widget-assert failures.
    scriptedCheckFailures: [
      ...browser.scriptedCheckFailures,
      ...hostedStepScriptedFailures,
    ],
  });
  const promptTraceSummaries = buildPromptTraceSummaries(
    evaluation,
    turnCheckResults,
  );
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
  const finishParams = buildIterationFinishParams({
    iterationId,
    passed,
    evaluation,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(backendEnhancedSystemPromptForPersist
      ? { systemPrompt: backendEnhancedSystemPromptForPersist }
      : {}),
    spans: capturedSpans,
    prompts: promptTraceSummaries,
    ...(widgetSnapshots ? { widgetSnapshots } : {}),
    // Browser-rendered MCP App eval (PR 14): hosted-path browser artifacts
    // (see the non-stream backend runner).
    widgetRenderObservations: browser.widgetRenderObservations,
    browserInteractionSteps: browser.browserInteractionSteps,
    status: "completed",
    startedAt: runStartedAt,
    ...(iterationError ? { error: iterationError } : {}),
    ...(iterationErrorDetails ? { errorDetails: iterationErrorDetails } : {}),
    predicateResults,
    ...(hostedStepSkippedSteps.length
      ? { skippedSteps: hostedStepSkippedSteps }
      : {}),
    ...(hostedStepResults.length ? { stepResults: hostedStepResults } : {}),
    iterationMetadataBase,
    ...(hostPolicy ? { hostPolicy } : {}),
    ...(toolSignals ? { toolSignals } : {}),
    injectOpenAiCompat,
  });

  await finalizeIterationWithBrowserArtifacts({
    browser,
    recorder,
    convexClient,
    finishParams,
  });

  return {
    evaluation,
    iterationId: iterationId ?? undefined,
  };
};

// Thin streaming wrapper (`emit` required) — preserves the SSE call site in
// `streamEvalTestCaseWithManager` and the streaming tests.
export const streamTestCase = (
  params: Omit<Parameters<typeof executeTestCase>[0], "emit"> & {
    emit: StreamEmit;
  }
) => executeTestCase(params);
