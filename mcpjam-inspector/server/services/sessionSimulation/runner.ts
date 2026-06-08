import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import { ConvexHttpClient } from "convex/browser";
import type { ModelDefinition } from "@/shared/types";
import { getModelById, isMCPJamProvidedModel } from "@/shared/types";
import { logger } from "../../utils/logger.js";
import {
  handleMCPJamFreeChatModel,
  type MCPJamHandlerOptions,
} from "../../utils/mcpjam-stream-handler.js";
import {
  handleHostedOrgChatModel,
  handleLocalOrgChatModel,
} from "../../utils/org-model-stream-handler.js";
import {
  deriveOrgProviderKey,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntime,
  type OrgProviderRuntime,
} from "../../utils/org-model-config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import {
  persistChatSessionToConvex,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "../../utils/export-helpers.js";
import { captureMcpAppWidgetSnapshots } from "../../utils/mcp-app-widget-capture.js";
import type { EvalTraceWidgetSnapshot } from "@/shared/eval-trace";
import {
  evalTraceSnapshotToPayload,
  sanitizeWidgetForBackend,
} from "@/shared/widget-snapshot";
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
  status: "running" | "completed" | "partial" | "failed" | "rate_limited" | undefined,
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
  /**
   * Optional hosted-chat access version. Forwarded into
   * `chatSessions:createWidgetSnapshot` so the optimistic-concurrency check
   * fires if the chatbox's access surface (mode/allowlist/grants) shifted
   * mid-run. Omitting it is safe — the project owner running synthesis is
   * authorized regardless; the version gate is a guest/visitor stale-cache
   * guard.
   */
  accessVersion?: number;
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
    accessVersion,
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
          accessVersion,
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
    // When the whole batch trips the spend cap (no successes, no hard
    // failures), surface "rate_limited" so the dialog's amber treatment
    // applies. The RunRecord type already permits this terminal state.
    const status: "completed" | "partial" | "failed" | "rate_limited" =
      totalSucceeded === total
        ? "completed"
        : totalSucceeded === 0 && totalFailed === 0 && totalRateLimited > 0
          ? "rate_limited"
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
  accessVersion?: number;
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
    accessVersion,
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
    // Captured from the first drained turn so per-session persist calls
    // (including the empty-history fallback below) stamp the correct
    // modelSource on chatSessions. The chatbox modelId is pinned at start,
    // so this is stable across turns.
    let sessionModelSource: SyntheticModelSource | undefined;

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

      const {
        history: updatedHistory,
        turnTrace,
        modelSource: turnModelSource,
      } = await drainAssistantTurn({
        messages: messageHistory,
        modelId: String(modelDefinition.id),
        modelDefinition,
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
        // The chatbox runtime-config redeem returns an accessVersion that
        // /stream/org/resolve uses to authorize the actor against the
        // versioned chatbox; threading the value (instead of undefined)
        // matches what real-visitor synthetic-equivalent chats send.
        accessVersion,
        projectId,
        authHeader,
        abortSignal,
        // Threaded into the per-step /stream (or /stream/org) body and the
        // /stream/org/local-usage writeback so the backend BYOK and
        // JAM-paid writers can stamp synthesisRunId onto llmUsageRecord
        // for per-run spend attribution.
        synthesisRunId: runId,
      });
      // Track the first turn's modelSource for the per-session persist
      // calls. modelSource is stable across turns within a session because
      // chatbox modelId is pinned by `fetchChatboxRuntimeConfig` at start.
      if (sessionModelSource === undefined) {
        sessionModelSource = turnModelSource;
      }

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
        modelSource: sessionModelSource ?? "mcpjam",
        authHeader,
        projectId,
        sourceType: "chatbox",
        // Synthetic chatbox simulation — distinguished from real chatbox
        // traffic by the `synthetic: true` flag already on the row, not by
        // origin. Training filters should combine `origin === 'chatbox'`
        // with `synthetic !== true` to keep these out.
        origin: "chatbox",
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

      // Capture + persist MCP App widget snapshots for any tool calls in this
      // session so the Sessions viewer renders the actual widget (e.g.
      // Excalidraw `create_view`) instead of a collapsed tool pill. Mirrors
      // what the live browser capture hook
      // (`useSharedChatWidgetCapture`) does for real visitor sessions, just
      // server-side using the runner's MCP manager. Best-effort: a failure
      // here never aborts the run.
      await captureAndPersistWidgetSnapshotsForSession({
        messages: messageHistory,
        mcpClientManager: manager,
        convexAuthToken,
        chatSessionId,
        chatboxId,
        accessVersion,
      });
    }

    if (!anyTurnPersisted) {
      // Session ended before any assistant turn completed (persona returned
      // endSession on turn 0, or every turn aborted). Persist once with no
      // trace so the chatSessions row exists and the run summary lines up.
      // No turn ever ran, so sessionModelSource is undefined. Derive it
      // from the same dispatch shape `drainAssistantTurn` uses so a local-
      // runtime org-BYOK chatbox doesn't get mis-attributed as cloud
      // byok on the fallback row.
      let emptySessionModelSource: SyntheticModelSource;
      const modelIdForEmpty = String(modelDefinition.id);
      if (isMCPJamProvidedModel(modelIdForEmpty)) {
        emptySessionModelSource = "mcpjam";
      } else {
        const keyResult = deriveOrgProviderKey(modelDefinition);
        if (!keyResult.ok) {
          // Couldn't derive a key — fall back to cloud byok rather than
          // crashing this attribution path. Real turns would have failed
          // before reaching the persist.
          emptySessionModelSource = "byok";
        } else if (isLocalRuntimeEligible(keyResult.key)) {
          const runtime = await resolveOrgProviderRuntime(
            projectId,
            keyResult.key,
            modelIdForEmpty,
            {
              authHeader,
              chatboxId,
              accessVersion,
              serverIds: selectedServerIds,
            },
          );
          emptySessionModelSource =
            runtime.runtimeLocation === "local" ? "local_byok" : "byok";
        } else {
          emptySessionModelSource = "byok";
        }
      }
      await persistChatSessionToConvex({
        chatSessionId,
        modelId: String(modelDefinition.id),
        modelSource: emptySessionModelSource,
        authHeader,
        projectId,
        sourceType: "chatbox",
        origin: "chatbox",
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
 * Walk the synthetic session's message history for MCP App tool calls,
 * fetch each widget's HTML via `MCPClientManager.readResource()`, upload it
 * to Convex storage, and persist a `sharedChatWidgetSnapshots` row through
 * `chatSessions:createWidgetSnapshot`. Without this, the Chatbox Sessions
 * viewer's `getWidgetSnapshots` query returns empty for synthetic threads
 * and MCP App tool calls collapse to a plain pill instead of rendering the
 * actual widget (e.g. Excalidraw `create_view`).
 *
 * Best-effort end-to-end: any failure (missing accessVersion, mutation
 * error, transient network) is logged and swallowed — never aborts the
 * synthetic run. The Convex mutation patches existing rows on
 * `(sessionId, toolCallId)` so re-running this per turn is idempotent.
 */
async function captureAndPersistWidgetSnapshotsForSession(args: {
  messages: ModelMessage[];
  mcpClientManager: MCPClientManager;
  convexAuthToken: string;
  chatSessionId: string;
  chatboxId: string;
  accessVersion: number | undefined;
}): Promise<void> {
  const {
    messages,
    mcpClientManager,
    convexAuthToken,
    chatSessionId,
    chatboxId,
    accessVersion,
  } = args;

  // `convexHttpUrl` is the `.convex.site` HTTP-actions endpoint (the runner
  // uses it for `/session-simulation/*` fetches). `ConvexHttpClient` wants
  // the deployment URL (`.convex.cloud`) so it can call queries/mutations.
  // The evals runner pulls the same env via `createConvexClient` in
  // `server/services/evals/route-helpers.ts`; we read it directly here to
  // avoid cross-importing an eval-flavored helper.
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    logger.warn(
      "[sessionSimulation.runner] CONVEX_URL not set; skipping widget snapshot capture",
      { chatSessionId, chatboxId },
    );
    return;
  }

  let convexClient: ConvexHttpClient;
  try {
    convexClient = new ConvexHttpClient(convexUrl);
    convexClient.setAuth(convexAuthToken);
  } catch (err) {
    logger.warn("[sessionSimulation.runner] convex client setup failed", {
      chatSessionId,
      convexUrl,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }

  let snapshots: EvalTraceWidgetSnapshot[] | undefined;
  try {
    snapshots = await captureMcpAppWidgetSnapshots({
      messages,
      mcpClientManager,
      convexClient,
    });
  } catch (err) {
    logger.warn("[sessionSimulation.runner] widget snapshot capture failed", {
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!snapshots || snapshots.length === 0) {
    return;
  }

  await Promise.allSettled(
    snapshots.map(async (snap) => {
      // The capture helper short-circuits when readResource fails or the
      // resource is missing HTML, but it still emits a snapshot stub.
      // `evalTraceSnapshotToPayload` returns null in that case so we
      // drop the stub instead of sending an invalid call.
      const widgetPayload = evalTraceSnapshotToPayload(snap);
      if (!widgetPayload) return;
      // Sanitize for Convex transport — `widgetPermissions` is free-form
      // and JSON Schema fragments use $-prefixed keys (`$ref`, `$schema`)
      // which Convex rejects at the argument-validator boundary.
      const sanitized = sanitizeWidgetForBackend(widgetPayload);
      try {
        await convexClient.mutation(
          "chatSessions:createWidgetSnapshot" as any,
          {
            chatboxId,
            ...(accessVersion !== undefined ? { accessVersion } : {}),
            chatSessionId,
            ...sanitized,
          },
        );
      } catch (err) {
        logger.warn(
          "[sessionSimulation.runner] createWidgetSnapshot failed",
          {
            chatSessionId,
            toolCallId: snap.toolCallId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }),
  );
}

type SyntheticModelSource = "mcpjam" | "byok" | "local_byok";

/**
 * Drive one assistant turn through the appropriate model handler:
 *   - MCPJam-provided modelId → `handleMCPJamFreeChatModel` (JAM-paid)
 *   - Org-BYOK cloud runtime → `handleHostedOrgChatModel`
 *   - Org-BYOK local runtime → `handleLocalOrgChatModel`
 *
 * Mirrors `web-chat-turn.ts`'s three-way dispatch but re-implements the
 * minimum branch logic here because the shared dispatcher's surface is
 * UIMessage-shaped and bakes in persist/SSE concerns that synthetic runs
 * own themselves (per-turn `persistChatSessionToConvex` from
 * `runOneSession` with `synthetic: true`, `personaId`, `synthesisRunId`).
 *
 * User-API-key direct chats are NOT supported on the synthetic path —
 * there's no "visitor" whose key to use. Such chatboxes are rejected at
 * the route boundary; this dispatcher's only fallthrough is for an
 * unexpected `resolveOrgProviderRuntime` shape, which throws.
 *
 * Returns the post-turn message history, the per-turn trace captured by
 * `onConversationComplete`, and the resolved `modelSource` so the caller
 * can stamp `persistChatSessionToConvex` correctly.
 *
 * Drains the SSE response body (`createUIMessageStreamResponse` requires
 * the consumer to read the stream before `onFinish` runs).
 */
export async function drainAssistantTurn(
  args: Omit<MCPJamHandlerOptions, "onConversationComplete" | "onStreamComplete"> & {
    chatSessionId: string;
    /** Resolved provider info for org-BYOK dispatch. Falls back to lookup. */
    modelDefinition: ModelDefinition;
    /** Synthesis run id — stamped onto BYOK usage records for attribution. */
    synthesisRunId: string;
  },
): Promise<{
  history: ModelMessage[];
  turnTrace: PersistedTurnTrace | undefined;
  modelSource: SyntheticModelSource;
}> {
  let captured: ModelMessage[] = [];
  let capturedTurnTrace: PersistedTurnTrace | undefined;
  const {
    chatSessionId: _omitSession,
    modelDefinition,
    synthesisRunId,
    extraBodyFields,
    ...rest
  } = args;

  const modelIdStr = String(modelDefinition.id);
  const onConversationComplete = (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace,
  ) => {
    captured = [...fullHistory];
    capturedTurnTrace = turnTrace;
  };

  let response: Response;
  let modelSource: SyntheticModelSource;

  if (isMCPJamProvidedModel(modelIdStr)) {
    // MCPJam-paid path: synthesisRunId rides via extraBodyFields on /stream
    // so the JAM-paid forwarder stamps it onto the llmUsageRecord.
    modelSource = "mcpjam";
    const options: MCPJamHandlerOptions = {
      ...rest,
      approvalMode: "auto-deny",
      extraBodyFields: { ...(extraBodyFields ?? {}), synthesisRunId },
      onConversationComplete,
    };
    response = await handleMCPJamFreeChatModel(options);
  } else {
    // Org-BYOK path: derive providerKey from the model definition, then
    // resolve the runtime location (cloud vs local) the same way
    // web-chat-turn does for real chats.
    const providerKeyResult = deriveOrgProviderKey(modelDefinition);
    if (!providerKeyResult.ok) {
      throw new Error(
        `Synthetic dispatch failed to derive org provider key: ${providerKeyResult.error}`,
      );
    }
    const providerKey = providerKeyResult.key;

    const orgRuntime: OrgProviderRuntime = isLocalRuntimeEligible(providerKey)
      ? await resolveOrgProviderRuntime(
          args.projectId ?? "",
          providerKey,
          modelIdStr,
          {
            authHeader: args.authHeader,
            chatboxId: args.chatboxId,
            accessVersion: args.accessVersion,
            serverIds: args.selectedServers,
          },
        )
      : { runtimeLocation: "cloud", providerKey };

    if (orgRuntime.runtimeLocation === "local") {
      modelSource = "local_byok";
      // Local-runtime org providers don't have an approval loop today —
      // handleLocalOrgChatModel rejects synchronously with
      // `tool_approval_unsupported` when requireToolApproval is true and
      // any tools are exposed. Cloud BYOK paths handle this via
      // `approvalMode: "auto-deny"` (the loop denies each call and
      // continues); the local path has no equivalent yet, so a synthetic
      // run on an approval-required chatbox would have every turn fail
      // with the same error. Refuse upfront with a clear message rather
      // than letting the per-turn errors stack up silently. Disable
      // approval on the chatbox or switch the provider to cloud runtime
      // to unblock.
      if (
        args.requireToolApproval === true &&
        args.tools &&
        Object.keys(args.tools as Record<string, unknown>).length > 0
      ) {
        throw new Error(
          "Synthetic runs on local-runtime org BYOK models don't yet support approval-required tool calls. Disable tool approval on this chatbox or switch the provider to cloud runtime.",
        );
      }
      response = handleLocalOrgChatModel({
        provider: orgRuntime.provider,
        projectId: args.projectId ?? "",
        modelId: modelIdStr,
        chatSessionId: args.chatSessionId,
        sourceType: args.sourceType,
        messages: args.messages,
        systemPrompt: args.systemPrompt,
        temperature: args.temperature,
        tools: args.tools as ToolSet,
        progressivePlan: args.progressivePlan,
        discoveryState: args.discoveryState,
        authHeader: args.authHeader,
        chatboxId: args.chatboxId,
        accessVersion: args.accessVersion,
        selectedServers: args.selectedServers,
        serverIds: args.selectedServers,
        requireToolApproval: args.requireToolApproval,
        onConversationComplete,
        abortSignal: args.abortSignal,
        synthesisRunId,
      });
    } else {
      modelSource = "byok";
      response = await handleHostedOrgChatModel({
        projectId: args.projectId ?? "",
        providerKey: orgRuntime.providerKey,
        modelId: modelIdStr,
        chatSessionId: args.chatSessionId,
        sourceType: args.sourceType,
        messages: args.messages,
        systemPrompt: args.systemPrompt,
        temperature: args.temperature,
        tools: args.tools as ToolSet,
        progressivePlan: args.progressivePlan,
        discoveryState: args.discoveryState,
        authHeader: args.authHeader,
        chatboxId: args.chatboxId,
        accessVersion: args.accessVersion,
        mcpClientManager: args.mcpClientManager,
        selectedServers: args.selectedServers,
        serverIds: args.selectedServers,
        requireToolApproval: args.requireToolApproval,
        // Synthetic runs have no human-in-the-loop. Auto-deny any
        // approval-required tool call inside the loop so the run can
        // make forward progress instead of pausing forever waiting for
        // an approval that will never arrive. Matches the MCPJam-paid
        // branch above.
        approvalMode: "auto-deny",
        onConversationComplete,
        abortSignal: args.abortSignal,
        // Threaded through to /stream/org so the BYOK forwarder stamps
        // synthesisRunId onto the resulting llmUsageRecord.
        extraBodyFields: { ...(extraBodyFields ?? {}), synthesisRunId },
      });
    }
  }

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
    modelSource,
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
