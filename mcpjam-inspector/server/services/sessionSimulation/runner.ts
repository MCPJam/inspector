import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import { getModelById } from "@/shared/types";
import { logger } from "../../utils/logger.js";
import {
  handleMCPJamFreeChatModel,
  type MCPJamHandlerOptions,
} from "../../utils/mcpjam-stream-handler.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import {
  persistChatSessionToConvex,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "../../utils/export-helpers.js";
import {
  createRun,
  getRun,
  personaNextTurn,
  updateRun,
  type PersonaSlate,
} from "../session-agent.js";

const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const UPDATE_RUN_RETRY_DELAY_MS = 250;

/**
 * Best-effort persisted status write that tolerates one transient Convex
 * failure. Used for per-session progress writes inside the batch loop and
 * the final terminal write — neither should abort the batch on a single
 * blip. The second failure is logged and swallowed.
 */
async function tryUpdateRunWithRetry(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string,
  delta: { succeeded?: number; failed?: number; rateLimited?: number },
  status: "running" | "completed" | "partial" | "failed" | undefined,
  context: string,
): Promise<void> {
  try {
    await updateRun(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      delta,
      status,
    );
    return;
  } catch (err) {
    logger.warn("[sessionSimulation.runner] updateRun failed; retrying", {
      runId,
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, UPDATE_RUN_RETRY_DELAY_MS));
  try {
    await updateRun(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      delta,
      status,
    );
  } catch (err) {
    logger.error("[sessionSimulation.runner] updateRun failed after retry", {
      runId,
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface SimulationManagerFactory {
  /**
   * Builds a fresh, fully-connected MCPClientManager for one session, scoped
   * to the chatbox's `selectedServerIds`. The runner disposes it after the
   * session completes (success or failure).
   *
   * Implemented by the route handler so the runner stays free of authorize
   * + secrets fetch wiring.
   */
  (): Promise<{
    manager: MCPClientManager;
    /** Server IDs that successfully connected (skip-listed OAuth servers excluded). */
    connectedServerIds: string[];
    /**
     * Optional human-readable names aligned 1:1 with `connectedServerIds`.
     * Persisted into the session's `resumeConfig.selectedServers` so the
     * Chatbox Sessions viewer can reconnect the right servers when the user
     * opens the session later (live `readResource()` for MCP App widgets).
     */
    connectedServerNames?: string[];
    /** Async cleanup invoked after the session terminates. */
    dispose: () => Promise<void>;
  }>;
}

export interface RunSimulationOptions {
  runId: string;
  chatboxId: string;
  projectId: string;
  personas: PersonaSlate[];
  sessionsPerPersona: number;
  maxTurns: number;
  modelId: string;
  systemPrompt: string;
  temperature?: number;
  /** When true, approval-required tool calls auto-deny inside the loop. */
  requireToolApproval: boolean;
  /**
   * Mirrors the chatbox-host SEP-1865 visibility filter. Undefined → host's
   * runtime config didn't include it (older backend) and prepareChatV2 uses
   * its default (filter on).
   */
  respectToolVisibility?: boolean;
  /**
   * Mirrors the chatbox-host progressive-discovery toggle. Undefined →
   * prepareChatV2 falls back to its auto policy, matching what a real
   * visitor would get.
   */
  progressiveToolDiscovery?: boolean;
  convexHttpUrl: string;
  convexAuthToken: string;
  authHeader: string;
  managerFactory: SimulationManagerFactory;
  /** Aborts the runner mid-batch on inspector shutdown. */
  abortSignal?: AbortSignal;
}

interface RunningRunHandle {
  abort: () => void;
  /** Resolves when the run loop's `finally` has cleared the registry. */
  done: Promise<void>;
  convexHttpUrl: string;
  convexAuthToken: string;
  projectId: string;
}

const runningRuns = new Map<string, RunningRunHandle>();

export function getRunningSimulationCount(): number {
  return runningRuns.size;
}

/**
 * Graceful shutdown for the runner registry. Aborts every active runner and
 * actually awaits each loop's `finally` (which writes the failure status)
 * up to `timeoutMs`. Any run still active after the timeout gets a
 * best-effort "failed" status write so the UI doesn't see a permanently
 * "running" run.
 */
export async function shutdownRunningSimulations(
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const handles = Array.from(runningRuns.entries());
  for (const [, handle] of handles) {
    handle.abort();
  }
  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, timeoutMs),
  );
  await Promise.race([
    Promise.allSettled(handles.map(([, h]) => h.done)),
    timeoutPromise,
  ]);
  // Anything still in the registry didn't finish before the deadline.
  // Mark it failed best-effort so the UI doesn't show a stuck "running".
  const stragglers = Array.from(runningRuns.entries());
  await Promise.allSettled(
    stragglers.map(([runId, handle]) =>
      tryUpdateRunWithRetry(
        handle.convexHttpUrl,
        handle.convexAuthToken,
        handle.projectId,
        runId,
        {},
        "failed",
        "shutdown-straggler",
      ),
    ),
  );
}

export async function startSimulation(
  partial: Omit<RunSimulationOptions, "runId"> & {
    /** Returned by backend `createRun`. */
    runId: string;
  },
): Promise<void> {
  const controller = new AbortController();
  const composed = composeAbortSignals(partial.abortSignal, controller.signal);
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  runningRuns.set(partial.runId, {
    abort: () => controller.abort(),
    done,
    convexHttpUrl: partial.convexHttpUrl,
    convexAuthToken: partial.convexAuthToken,
    projectId: partial.projectId,
  });
  try {
    await runSimulationLoop({ ...partial, abortSignal: composed });
  } finally {
    runningRuns.delete(partial.runId);
    resolveDone();
  }
}

function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}

async function runSimulationLoop(opts: RunSimulationOptions): Promise<void> {
  const {
    runId,
    chatboxId,
    projectId,
    personas,
    sessionsPerPersona,
    maxTurns,
    modelId,
    systemPrompt,
    temperature,
    requireToolApproval,
    respectToolVisibility,
    progressiveToolDiscovery,
    convexHttpUrl,
    convexAuthToken,
    authHeader,
    managerFactory,
    abortSignal,
  } = opts;

  const modelDefinition = getModelById(modelId);
  if (!modelDefinition) {
    await tryUpdateRunWithRetry(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      {},
      "failed",
      "unknown-model",
    );
    throw new Error(`Unknown modelId for simulation: ${modelId}`);
  }

  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalRateLimited = 0;

  const heartbeat = setInterval(() => {
    if (abortSignal?.aborted) return;
    updateRun(convexHttpUrl, convexAuthToken, projectId, runId, {}).catch(
      (err) => {
        logger.warn("[sessionSimulation.runner] heartbeat updateRun failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }, HEARTBEAT_INTERVAL_MS);

  try {
    outer: for (const persona of personas) {
      for (let sessionIdx = 0; sessionIdx < sessionsPerPersona; sessionIdx++) {
        if (abortSignal?.aborted) break outer;
        const outcome = await runOneSession({
          persona,
          sessionIdx,
          runId,
          chatboxId,
          projectId,
          maxTurns,
          modelDefinition,
          systemPrompt,
          temperature,
          requireToolApproval,
          respectToolVisibility,
          progressiveToolDiscovery,
          convexHttpUrl,
          convexAuthToken,
          authHeader,
          managerFactory,
          abortSignal,
        });

        if (outcome === "succeeded") totalSucceeded++;
        else if (outcome === "rate_limited") totalRateLimited++;
        else totalFailed++;

        await tryUpdateRunWithRetry(
          convexHttpUrl,
          convexAuthToken,
          projectId,
          runId,
          {
            succeeded: outcome === "succeeded" ? 1 : 0,
            failed: outcome === "failed" ? 1 : 0,
            rateLimited: outcome === "rate_limited" ? 1 : 0,
          },
          undefined,
          "per-session-progress",
        );

        if (outcome === "rate_limited") {
          // Skip remaining sessions for this persona on rate-limit, per plan.
          break;
        }
      }
    }

    const total = personas.length * sessionsPerPersona;
    const status =
      totalSucceeded === total
        ? "completed"
        : totalSucceeded === 0
          ? "failed"
          : "partial";
    await tryUpdateRunWithRetry(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      {},
      status,
      "final-status",
    );
  } catch (error) {
    logger.error("[sessionSimulation.runner] run failed", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    await tryUpdateRunWithRetry(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      {},
      "failed",
      "run-failed",
    );
  } finally {
    clearInterval(heartbeat);
  }
}

type SessionOutcome = "succeeded" | "failed" | "rate_limited";

async function runOneSession(args: {
  persona: PersonaSlate;
  sessionIdx: number;
  runId: string;
  chatboxId: string;
  projectId: string;
  maxTurns: number;
  modelDefinition: ModelDefinition;
  systemPrompt: string;
  temperature?: number;
  requireToolApproval: boolean;
  respectToolVisibility?: boolean;
  progressiveToolDiscovery?: boolean;
  convexHttpUrl: string;
  convexAuthToken: string;
  authHeader: string;
  managerFactory: SimulationManagerFactory;
  abortSignal?: AbortSignal;
}): Promise<SessionOutcome> {
  const {
    persona,
    sessionIdx,
    runId,
    chatboxId,
    projectId,
    maxTurns,
    modelDefinition,
    systemPrompt,
    temperature,
    requireToolApproval,
    respectToolVisibility,
    progressiveToolDiscovery,
    convexHttpUrl,
    convexAuthToken,
    authHeader,
    managerFactory,
    abortSignal,
  } = args;

  const sessionStartedAt = Date.now();
  const chatSessionId = `synth_${runId}_${persona.id}_${sessionIdx}`;
  let manager: MCPClientManager | undefined;
  let dispose: (() => Promise<void>) | undefined;

  try {
    const built = await managerFactory();
    manager = built.manager;
    dispose = built.dispose;
    const selectedServerIds = built.connectedServerIds;
    const selectedServerNames = built.connectedServerNames;

    // Mirror chat-v2's direct-chat resumeConfig shape so the Chatbox Sessions
    // viewer can reconnect the same servers when the user opens this session
    // later. Without this, `readResource()` for MCP App widgets fails at
    // replay time and `create_view` collapses to a tool pill.
    const resumeConfig = {
      systemPrompt,
      ...(temperature !== undefined ? { temperature } : {}),
      requireToolApproval,
      ...(respectToolVisibility !== undefined ? { respectToolVisibility } : {}),
      selectedServers:
        Array.isArray(selectedServerNames) &&
        selectedServerNames.length === selectedServerIds.length
          ? selectedServerNames
          : selectedServerIds,
    };

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
      modelDefinition,
      systemPrompt,
      temperature,
      requireToolApproval,
      respectToolVisibility,
      ...(progressiveToolDiscovery !== undefined
        ? {
            progressiveToolDiscovery: {
              enabled: progressiveToolDiscovery,
            },
          }
        : {}),
    });

    let messageHistory: ModelMessage[] = [];
    let lastTranscript: Array<{ role: "user" | "assistant"; content: string }> =
      [];
    let anyTurnPersisted = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortSignal?.aborted) return "failed";

      const next = await personaNextTurn(
        convexHttpUrl,
        convexAuthToken,
        projectId,
        runId,
        persona.id,
        lastTranscript,
      );

      if (next.endSession) break;

      messageHistory.push({
        role: "user",
        content: next.message,
      } as ModelMessage);
      lastTranscript.push({ role: "user", content: next.message });

      const { history: updatedHistory, turnTrace } = await drainAssistantTurn({
        messages: messageHistory,
        modelId: String(modelDefinition.id),
        chatSessionId,
        sourceType: "chatbox",
        systemPrompt: prepared.enhancedSystemPrompt,
        temperature: prepared.resolvedTemperature,
        tools: prepared.allTools,
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        mcpClientManager: manager,
        selectedServers: selectedServerIds,
        requireToolApproval,
        chatboxId,
        accessVersion: undefined,
        projectId,
        authHeader,
        abortSignal,
      });

      messageHistory = updatedHistory;
      const assistantText = extractAssistantText(updatedHistory);
      lastTranscript.push({ role: "assistant", content: assistantText });

      if (!turnTrace) continue;

      // Mirror chat-v2's per-turn persistence so the Trace tab and the
      // tool-snapshot/serverInspections fan-out work identically for
      // synthetic sessions and Playground sessions. Snapshot failures
      // must never block the persist.
      let toolSnapshot: unknown;
      try {
        const liveManager = built.manager;
        const knownIds =
          typeof liveManager.hasServer === "function"
            ? selectedServerIds.filter((id) => liveManager.hasServer(id))
            : selectedServerIds;
        if (knownIds.length > 0) {
          toolSnapshot = await exportConnectedServerToolSnapshotForEvalAuthoring(
            liveManager,
            knownIds,
            { logPrefix: "sessionSimulation.persist" },
          );
        }
      } catch {
        toolSnapshot = undefined;
      }

      await persistChatSessionToConvex({
        chatSessionId,
        modelId: String(modelDefinition.id),
        modelSource: "mcpjam",
        authHeader,
        projectId,
        sourceType: "chatbox",
        surface: "share_link",
        chatboxId,
        sessionMessages: messageHistory,
        startedAt: sessionStartedAt,
        lastActivityAt: Date.now(),
        synthetic: true,
        personaId: persona.id,
        personaLabel: persona.name,
        synthesisRunId: runId,
        turnTrace,
        resumeConfig,
        ...(toolSnapshot ? { toolSnapshot } : {}),
      });
      anyTurnPersisted = true;
    }

    if (!anyTurnPersisted) {
      // Session ended before any assistant turn completed (persona returned
      // endSession on turn 0, or every turn aborted). Persist once with no
      // trace so the chatSessions row exists and the run summary lines up.
      await persistChatSessionToConvex({
        chatSessionId,
        modelId: String(modelDefinition.id),
        modelSource: "mcpjam",
        authHeader,
        projectId,
        sourceType: "chatbox",
        surface: "share_link",
        chatboxId,
        sessionMessages: messageHistory,
        startedAt: sessionStartedAt,
        lastActivityAt: Date.now(),
        synthetic: true,
        personaId: persona.id,
        personaLabel: persona.name,
        synthesisRunId: runId,
        resumeConfig,
      });
    }

    return "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/rate.?limit|spend|cap/i.test(message)) {
      return "rate_limited";
    }
    logger.warn("[sessionSimulation.runner] session failed", {
      runId,
      personaId: persona.id,
      sessionIdx,
      error: message,
    });
    return "failed";
  } finally {
    if (dispose) {
      try {
        await dispose();
      } catch (err) {
        logger.warn("[sessionSimulation.runner] manager dispose failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Drive one assistant turn through `handleMCPJamFreeChatModel`, returning the
 * post-turn message history and the per-turn trace captured by
 * `onConversationComplete`. The caller persists each successful turn through
 * the same `chat-ingestion.ts` path Playground uses, so synthetic sessions
 * look identical to normal Playground sessions in the Trace tab and the
 * Convex `chatSessionTurnTraces` table.
 *
 * Drains the SSE response body (`createUIMessageStreamResponse` requires the
 * consumer to read the stream before `onFinish` runs).
 */
async function drainAssistantTurn(
  args: Omit<MCPJamHandlerOptions, "onConversationComplete" | "onStreamComplete"> & {
    chatSessionId: string;
  },
): Promise<{ history: ModelMessage[]; turnTrace: PersistedTurnTrace | undefined }> {
  let captured: ModelMessage[] = [];
  let capturedTurnTrace: PersistedTurnTrace | undefined;
  const { chatSessionId: _omit, ...rest } = args;
  const options: MCPJamHandlerOptions = {
    ...rest,
    approvalMode: "auto-deny",
    onConversationComplete: (fullHistory, turnTrace) => {
      captured = [...fullHistory];
      capturedTurnTrace = turnTrace;
    },
  };
  const response = await handleMCPJamFreeChatModel(options);
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }
  return {
    history: captured.length > 0 ? captured : args.messages,
    turnTrace: capturedTurnTrace,
  };
}

function extractAssistantText(history: ModelMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
    return text;
  }
  return "";
}

// Re-export for the route — keeps `createRun`/`getRun` co-located with the
// runner from the route's perspective.
export { createRun, getRun };
