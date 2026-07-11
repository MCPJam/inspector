import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import type { MCPClientManager, Harness } from "@mcpjam/sdk";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import { ConvexHttpClient } from "convex/browser";
import type { ModelDefinition } from "@/shared/types";
// `getModelById` lookup is now wrapped by `buildSyntheticModelDefinition`
// (org-model-config.ts) — that helper falls back to BYOK provider parsing
// when the chatbox modelId isn't in SUPPORTED_MODELS, which is the common
// case for org-BYOK chatboxes (Ollama, custom: providers, OpenRouter ids).
import { logger } from "../../utils/logger.js";
import type { MCPJamHandlerOptions } from "../../utils/mcpjam-stream-handler.js";
import {
  resolveLocalOrgMaxSteps,
  type RunLocalOrgChatTurnHeadlessOptions,
} from "../../utils/org-model-stream-handler.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import { resolveTurnRuntime } from "../../utils/resolve-turn-runtime.js";
import {
  buildSyntheticModelDefinition,
  resolveSyntheticModelSource,
  type SyntheticModelSource,
} from "../../utils/org-model-config.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import {
  resolveHostTools,
  type HostComputerResource,
} from "../../utils/built-in-tools/registry.js";
import { shouldEnableCloudSkillTools } from "../../utils/computers/cloud-skill-tools.js";
import {
  persistChatSessionToConvex,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "../../utils/export-helpers.js";
import { captureMcpAppWidgetSnapshots } from "../../utils/mcp-app-widget-capture.js";
import {
  createBrowserSessionContext,
  type BrowserSessionContext,
} from "../browser-session-context.js";
import {
  serializeBrowserStepsForBackend,
  serializeRenderObservationsForBackend,
  toBrowserStepPayload,
  toObservationPayload,
} from "../browser-artifact-serialization.js";
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
  status:
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "rate_limited"
    | undefined,
  context: string,
  errorMessage?: string
): Promise<void> {
  try {
    await updateRun(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      delta,
      status,
      errorMessage
    );
    return;
  } catch (err) {
    logger.warn("[sessionSimulation.runner] updateRun failed; retrying", {
      runId,
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await new Promise((resolve) =>
    setTimeout(resolve, UPDATE_RUN_RETRY_DELAY_MS)
  );
  try {
    await updateRun(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      delta,
      status,
      errorMessage
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
   * Built-in tool ids from the chatbox's pinned HostConfigV2 (e.g.
   * `["web_search"]`). Resolved per session via the shared registry so a
   * synthetic visitor sees the same tool set a real chatbox visitor gets.
   */
  builtInToolIds?: string[];
  /**
   * Host/client policy for eligible MCP tool-result content/resources.
   * Undefined keeps prepareChatV2's default behavior.
   */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /**
   * Human-facing rendering policy for MCP tool-returned images.
   * Undefined keeps prepareChatV2's default behavior.
   */
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  /**
   * Personal-computer attachment from the chatbox's pinned HostConfigV2. This
   * is the resource gate for computer-backed built-ins like `bash`; capabilities
   * still ride `builtInToolIds`.
   */
  computer?: HostComputerResource;
  /**
   * Host harness selector mirrored from the chatbox's pinned HostConfigV2.
   * When "claude-code" the synthetic visitor's turns run the real Claude Code
   * runtime; absent ⇒ emulated. Forward-compatible: only activates once the
   * backend runtime-config endpoint serves it.
   */
  harness?: Harness;
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
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS
): Promise<void> {
  const handles = Array.from(runningRuns.entries());
  for (const [, handle] of handles) {
    handle.abort();
  }
  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, timeoutMs)
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
        "shutdown-straggler"
      )
    )
  );
}

export async function startSimulation(
  partial: Omit<RunSimulationOptions, "runId"> & {
    /** Returned by backend `createRun`. */
    runId: string;
  }
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
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
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
    builtInToolIds,
    modelVisibleMcpToolResults,
    mcpToolResultImageRendering,
    computer,
    harness,
    accessVersion,
    convexHttpUrl,
    convexAuthToken,
    authHeader,
    managerFactory,
    abortSignal,
  } = opts;

  // Resolve a ModelDefinition for the chatbox modelId. Catalog hits return
  // unchanged; BYOK shapes (Ollama, custom: providers, OpenRouter-style
  // ids) get a derived provider so the BYOK dispatch can run. Pre-fix this
  // was a hard `Unknown modelId for simulation` failure before any BYOK
  // dispatch ran.
  const modelDefinition = buildSyntheticModelDefinition(modelId);

  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalRateLimited = 0;
  // First failure diagnostic — persisted onto the run record so the dialog
  // can show *why* sessions failed (e.g. an org-resolve rejection) instead
  // of a bare "Failed" while the real message rots in server logs.
  let firstErrorMessage: string | undefined;

  const heartbeat = setInterval(() => {
    if (abortSignal?.aborted) return;
    updateRun(convexHttpUrl, convexAuthToken, projectId, runId, {}).catch(
      (err) => {
        logger.warn("[sessionSimulation.runner] heartbeat updateRun failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );
  }, HEARTBEAT_INTERVAL_MS);

  try {
    outer: for (const persona of personas) {
      for (let sessionIdx = 0; sessionIdx < sessionsPerPersona; sessionIdx++) {
        if (abortSignal?.aborted) break outer;
        const { outcome, errorMessage } = await runOneSession({
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
          builtInToolIds,
          modelVisibleMcpToolResults,
          mcpToolResultImageRendering,
          computer,
          harness,
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

        // Persist the first failure's message with its own progress write
        // so the dialog surfaces the diagnostic while the run is still
        // going, not only at the terminal update.
        const carriesFirstError =
          outcome === "failed" && !firstErrorMessage && !!errorMessage;
        if (carriesFirstError) firstErrorMessage = errorMessage;

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
          carriesFirstError ? firstErrorMessage : undefined
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
      totalFailed > 0 ? firstErrorMessage : undefined
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[sessionSimulation.runner] run failed", {
      runId,
      error: message,
    });
    await tryUpdateRunWithRetry(
      convexHttpUrl,
      convexAuthToken,
      projectId,
      runId,
      {},
      "failed",
      "run-failed",
      // Run-level abort (setup/heartbeat-adjacent crash) trumps any earlier
      // per-session diagnostic — it explains why the run stopped.
      message
    );
  } finally {
    clearInterval(heartbeat);
  }
}

type SessionOutcome = "succeeded" | "failed" | "rate_limited";

// `errorMessage` rides along on failures so the batch loop can persist the
// first one onto the run record (RunRecord.error) — previously the message
// only reached server logs and the dialog rendered a bare "Failed".
interface SessionResult {
  outcome: SessionOutcome;
  errorMessage?: string;
}

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
  builtInToolIds?: string[];
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  computer?: HostComputerResource;
  harness?: Harness;
  accessVersion?: number;
  convexHttpUrl: string;
  convexAuthToken: string;
  authHeader: string;
  managerFactory: SimulationManagerFactory;
  abortSignal?: AbortSignal;
}): Promise<SessionResult> {
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
    builtInToolIds,
    modelVisibleMcpToolResults,
    mcpToolResultImageRendering,
    computer,
    harness,
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
  // Browser-rendered MCP App pipeline (same machinery as eval iterations):
  // declared before the try so the finally can dispose a launched Chromium
  // on every exit. Construction is cheap; Chromium launches lazily on the
  // first widget render, so sessions that never touch an MCP App pay nothing.
  let browser: BrowserSessionContext | undefined;

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
      ...(modelVisibleMcpToolResults !== undefined
        ? { modelVisibleMcpToolResults }
        : {}),
      ...(mcpToolResultImageRendering !== undefined
        ? { mcpToolResultImageRendering }
        : {}),
      selectedServers:
        Array.isArray(selectedServerNames) &&
        selectedServerNames.length === selectedServerIds.length
          ? selectedServerNames
          : selectedServerIds,
    };

    // Built-in tools from the chatbox host config (e.g. web_search) resolve
    // the same way a real visitor's chat-v2 turn would: billed via Convex
    // against this project, namespaced under the synthetic session id.
    const builtInTools = resolveHostTools(
      { builtInToolIds, computer },
      {
        authHeader,
        projectId,
        chatSessionId,
        isChatboxSession: true,
        requireToolApproval,
      }
    );

    // Cloud Skills parity with a real chat-v2 visitor: a synthetic session is
    // always member-initiated (the route authenticates the generator), so the
    // guest gate never trips here. Skills are delivered the same two ways chat
    // does — natively via the harness `skills` param when the turn runs the
    // real Claude Code runtime, or as the emulated `listSkills`/`loadSkill`
    // tools otherwise. `shouldEnableCloudSkillTools` returns false on the
    // harness path (it delivers skills itself), so this only wires the emulated
    // tools, mirroring `web/chat-v2.ts`.
    //
    // BUT skip skills entirely when the chatbox requires tool approval. A
    // synthetic visitor is headless and can't grant approval: the local-runtime
    // BYOK path fail-closes on ANY non-empty tool set when approval is on (see
    // `drainAssistantTurn` below), and the cloud/MCPJam paths auto-deny every
    // call — so advertising the `listSkills`/`loadSkill` meta-tools (always 2
    // tools, even for a project with no skills) would turn an otherwise-toolless
    // approval simulation into one that fails every session for no benefit.
    const cloudSkillsEnabled =
      !requireToolApproval &&
      Boolean(authHeader) &&
      Boolean(projectId) &&
      shouldEnableCloudSkillTools({
        isGuest: false,
        harness,
        modelId: String(modelDefinition.id),
        provider: modelDefinition.provider,
        hasProjectId: Boolean(projectId),
      });

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
      modelDefinition,
      systemPrompt,
      temperature,
      requireToolApproval,
      respectToolVisibility,
      modelVisibleMcpToolResults,
      ...(harness ? { harness } : {}),
      ...(progressiveToolDiscovery !== undefined
        ? {
            progressiveToolDiscovery: {
              enabled: progressiveToolDiscovery,
            },
          }
        : {}),
      ...(builtInTools ? { builtInTools } : {}),
      ...(cloudSkillsEnabled
        ? { cloudSkills: { authHeader, projectId } }
        : {}),
    });

    // One browser context per session: renders MCP App tool results in the
    // headless harness (render observations for every model) and, for assistant
    // models with vision + tool calling, adds the `computer` / `finish_widget` tools so the
    // simulated assistant can interact with rendered widgets (interaction
    // steps). `injectOpenAiCompat` is omitted to match the snapshot capture
    // below — the chatbox runtime config doesn't carry the flag.
    browser = await createBrowserSessionContext({
      model: String(modelDefinition.id),
      // Session simulation is the ONE surface that opts into Computer Use: its
      // agentic personas drive rendered widgets by screenshots. Evals stay
      // deterministic and never enable it.
      enableComputerUse: true,
      mcpClientManager: manager,
      logScope: "sessionSimulation",
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
      if (abortSignal?.aborted) return { outcome: "failed" };

      const next = await personaNextTurn(
        convexHttpUrl,
        convexAuthToken,
        projectId,
        runId,
        persona.id,
        lastTranscript
      );

      if (next.endSession) break;

      messageHistory.push({
        role: "user",
        content: next.message,
      } as ModelMessage);
      lastTranscript.push({ role: "user", content: next.message });

      // Stamp artifacts with this persona turn and start it with a clean
      // widget surface — a widget kept mounted by the previous turn must not
      // be advertised/targeted before this turn's own MCP App tool runs
      // (same per-turn hygiene as the eval runners).
      browser.setActivePromptIndex(turn);
      await browser.dismissCarriedWidget();

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
        // `computer` / `finish_widget` merge into the advertised set; the
        // prepareAdvertisedTools hook hides them until a widget is mounted.
        tools: { ...prepared.allTools, ...browser.computerWidgetTools },
        hooks: {
          onToolCall: (event) => browser!.noteToolCallInput(event),
          onToolResult: (event) => browser!.handleEngineToolResult(event),
          ...(browser.prepareAdvertisedTools
            ? { prepareAdvertisedTools: browser.prepareAdvertisedTools }
            : {}),
          onToolResultChunk: (chunk) =>
            browser!.handleDirectToolResultChunk(chunk),
        },
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        mcpClientManager: manager,
        selectedServers: selectedServerIds,
        requireToolApproval,
        ...(harness ? { harness } : {}),
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

      if (!turnTrace) {
        // No-trace turns skip persistence (today only the aborted local-BYOK
        // path reaches here — failed turns throw above). Discard whatever the
        // browser context collected during this turn: a later turn's drain
        // would otherwise sweep these rows up and persist them under ITS
        // batch promptIndex, misattributing artifacts across turns
        // (CodeRabbit, PR 2610).
        browser.drainNewArtifacts();
        continue;
      }

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
          toolSnapshot =
            await exportConnectedServerToolSnapshotForEvalAuthoring(
              liveManager,
              knownIds,
              { logPrefix: "sessionSimulation.persist" }
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

      // Persist this turn's browser-rendered artifacts (render observations
      // + Computer Use steps) — additive to the inert HTML snapshots above,
      // which keep powering the viewer's interactive Data/Sandbox iframe.
      // Best-effort like the snapshot capture; the session row exists (the
      // turn persist above just ran), so there's no /ingest-chat race here.
      await persistBrowserArtifactsForTurn({
        browser,
        convexAuthToken,
        chatSessionId,
        chatboxId,
        accessVersion,
        promptIndex: turn,
      });
    }

    if (!anyTurnPersisted) {
      // Session ended before any assistant turn completed (persona returned
      // endSession on turn 0, or every turn aborted). Persist once with no
      // trace so the chatSessions row exists and the run summary lines up.
      // No turn ever ran, so sessionModelSource is undefined. Use the same
      // resolver `drainAssistantTurn` uses so a local-runtime org-BYOK
      // chatbox doesn't get mis-attributed as cloud byok on the fallback
      // row. Soft-fall-back to "byok" on resolver failure — real turns
      // would have errored before reaching this persist; we're best-effort
      // labeling an attribution row that exists only because the run
      // ended before any turn ran.
      let emptySessionModelSource: SyntheticModelSource;
      try {
        const resolution = await resolveSyntheticModelSource({
          modelDefinition,
          projectId,
          authHeader,
          chatboxId,
          accessVersion,
          serverIds: selectedServerIds,
        });
        emptySessionModelSource = resolution.source;
      } catch {
        emptySessionModelSource = "byok";
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

    return { outcome: "succeeded" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/rate.?limit|spend|cap/i.test(message)) {
      return { outcome: "rate_limited" };
    }
    logger.warn("[sessionSimulation.runner] session failed", {
      runId,
      personaId: persona.id,
      sessionIdx,
      error: message,
    });
    return { outcome: "failed", errorMessage: message };
  } finally {
    // Tear down the browser harness (and its headless Chromium, if launched)
    // before the manager: the harness's widget bridge dispatches tools/call
    // through the manager, so it must die first.
    if (browser) {
      try {
        await browser.dispose();
      } catch (err) {
        logger.warn("[sessionSimulation.runner] browser dispose failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
      { chatSessionId, chatboxId }
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
          }
        );
      } catch (err) {
        logger.warn("[sessionSimulation.runner] createWidgetSnapshot failed", {
          chatSessionId,
          toolCallId: snap.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}

/**
 * Drain the browser session context's artifacts collected during this turn
 * (render observations + Computer Use interaction steps), upload screenshots,
 * and persist via `chatSessions:recordBrowserArtifacts` — the synthetic
 * sibling of the eval finalizer's artifact hand-off. Idempotent backend
 * upserts (`(sessionId, toolCallId)` / `(sessionId, toolCallId, stepIndex)`)
 * make a retried turn-write safe.
 *
 * Best-effort end-to-end, mirroring the widget-snapshot capture above: any
 * failure is logged and swallowed — never aborts the synthetic run. (The
 * drained rows are dropped on failure; the next turn's drain only carries
 * new artifacts. Screenshots are the only loss — statuses for re-rendered
 * widgets re-upsert on later renders.)
 */
async function persistBrowserArtifactsForTurn(args: {
  browser: BrowserSessionContext;
  convexAuthToken: string;
  chatSessionId: string;
  chatboxId: string;
  accessVersion: number | undefined;
  promptIndex: number;
}): Promise<void> {
  const { observations, steps } = args.browser.drainNewArtifacts();
  if (observations.length === 0 && steps.length === 0) {
    return;
  }

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    logger.warn(
      "[sessionSimulation.runner] CONVEX_URL not set; skipping browser artifact persist",
      { chatSessionId: args.chatSessionId, chatboxId: args.chatboxId }
    );
    return;
  }

  try {
    const convexClient = new ConvexHttpClient(convexUrl);
    convexClient.setAuth(args.convexAuthToken);

    // Serialize uploads the transient base64 screenshots → blob ids; the
    // payload mappers strip the per-row promptIndex (the mutation stamps the
    // batch-level value server-side).
    const serializedObservations = (
      await serializeRenderObservationsForBackend(observations, convexClient)
    ).map(toObservationPayload);
    const serializedSteps = (
      await serializeBrowserStepsForBackend(steps, convexClient)
    ).map(toBrowserStepPayload);

    await convexClient.mutation("chatSessions:recordBrowserArtifacts" as any, {
      chatboxId: args.chatboxId,
      ...(args.accessVersion !== undefined
        ? { accessVersion: args.accessVersion }
        : {}),
      chatSessionId: args.chatSessionId,
      promptIndex: args.promptIndex,
      ...(serializedObservations.length
        ? { widgetRenderObservations: serializedObservations }
        : {}),
      ...(serializedSteps.length
        ? { browserInteractionSteps: serializedSteps }
        : {}),
    });
  } catch (err) {
    logger.warn("[sessionSimulation.runner] browser artifact persist failed", {
      chatSessionId: args.chatSessionId,
      observations: observations.length,
      steps: steps.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// `SyntheticModelSource` is imported from `org-model-config.ts` so the
// runner and the shared resolver stay in lockstep.

/**
 * Hooks a caller can attach to the assistant turn (the browser session
 * context wires these so MCP App tool results render in the headless
 * harness and Computer Use tools gate on a live widget mount).
 */
export interface DrainAssistantTurnHooks {
  /** Engine branches (`/stream`, `/stream/org`): MCPJamHandlerOptions pass-throughs. */
  onToolCall?: MCPJamHandlerOptions["onToolCall"];
  onToolResult?: MCPJamHandlerOptions["onToolResult"];
  /** All branches: per-step advertised-tool narrowing. */
  prepareAdvertisedTools?: MCPJamHandlerOptions["prepareAdvertisedTools"];
  /** Local AI-SDK branch: awaited per-tool-result render hook. */
  onToolResultChunk?: RunLocalOrgChatTurnHeadlessOptions["onToolResultChunk"];
}

/**
 * TEMPORARY COMPATIBILITY ADAPTER (PR 3a). `drainAssistantTurn` is now a thin
 * wrapper over {@link resolveTurnRuntime} + {@link runUnifiedAssistantTurn}: it
 * resolves the concrete {@link TurnRuntime} (MCPJam `/stream`, cloud-BYOK
 * `/stream/org`, or the direct in-process engine for local BYOK), drives ONE
 * turn through the shared facade, applies the synthetic error contract, and
 * fires the local-BYOK usage writeback. It exists only to keep `runOneSession`
 * unchanged while the shared adapter lands; it will be inlined/removed at
 * legacy cleanup — it is NOT a permanent second facade.
 *
 * No SSE Response is built or drained: the facade runs `streamSink: "none"` /
 * `persistMode: "caller"` (the hosted agent loop and transcript capture
 * complete before it returns; the direct engine consumes headlessly). Synthetic
 * runs own persistence themselves (per-turn `persistChatSessionToConvex` from
 * `runOneSession` with `synthetic: true`, `personaId`, `synthesisRunId`).
 *
 * Error contract (byte-preserved from the pre-facade dispatch): turn failures
 * THROW. Hosted engines signal failure with a MISSING turnTrace on a
 * non-aborted turn (recovered per-step errors keep their trace and succeed);
 * the direct engine always produces a trace, so it signals failure via
 * `onEngineError`. Surfacing the failure lets `runOneSession`'s classifier see
 * real spend-cap / rate-limit errors (→ `"rate_limited"`) and genuine provider
 * failures (→ `"failed"`).
 *
 * Returns the post-turn message history, the per-turn trace, and the resolved
 * `modelSource` so the caller can stamp `persistChatSessionToConvex` correctly.
 */
export async function drainAssistantTurn(
  args: Omit<
    MCPJamHandlerOptions,
    "onConversationComplete" | "onStreamComplete"
  > & {
    chatSessionId: string;
    /** Resolved provider info for org-BYOK dispatch. Falls back to lookup. */
    modelDefinition: ModelDefinition;
    /** Synthesis run id — stamped onto BYOK usage records for attribution. */
    synthesisRunId: string;
    /** Optional turn hooks (browser session context attachment points). */
    hooks?: DrainAssistantTurnHooks;
  }
): Promise<{
  history: ModelMessage[];
  turnTrace: PersistedTurnTrace | undefined;
  modelSource: SyntheticModelSource;
}> {
  const { modelDefinition, synthesisRunId, extraBodyFields, hooks } = args;

  // Narrow MCPJamHandlerOptions' open `sourceType` string to the engine union;
  // the simulation runner always passes "chatbox".
  const sourceType =
    args.sourceType === "direct" || args.sourceType === "eval"
      ? args.sourceType
      : ("chatbox" as const);

  // Provider/runtime resolution + local usage writeback + approval guard, in
  // one shared adapter. Uses the same resolver the empty-session fallback
  // persist uses, so the two attribution paths can't drift.
  const rt = await resolveTurnRuntime({
    modelDefinition,
    projectId: args.projectId ?? "",
    authHeader: args.authHeader,
    chatboxId: args.chatboxId,
    accessVersion: args.accessVersion,
    serverIds: args.selectedServers,
    sourceType,
    chatSessionId: args.chatSessionId,
    requireToolApproval: args.requireToolApproval,
    tools: args.tools as ToolSet,
    ...(args.harness ? { harness: args.harness } : {}),
    ...(extraBodyFields ? { extraBodyFields } : {}),
    attribution: { synthesisRunId },
  });

  // Engine-error signal. Structural type covers both the hosted
  // `MCPJamEngineErrorEvent` and the direct `DirectChatTurnEngineErrorEvent`.
  let lastEngineError:
    | { message: string; code?: string; httpStatus?: number }
    | undefined;
  const captureEngineError = (event: {
    message: string;
    code?: string;
    httpStatus?: number;
  }) => {
    lastEngineError = event;
  };

  if (rt.runtime.kind === "direct") {
    // Local-runtime org BYOK → the in-process AI-SDK engine. `maxSteps` mirrors
    // the local handler's 30-step default (the direct engine's own default is
    // 20). Browser hooks flow through the facade's inert callback extensions.
    const result = await runUnifiedAssistantTurn({
      runtime: rt.runtime,
      streamSink: "none",
      messages: args.messages,
      systemPrompt: args.systemPrompt,
      ...(args.temperature !== undefined
        ? { temperature: args.temperature }
        : {}),
      tools: args.tools as ToolSet,
      maxSteps: resolveLocalOrgMaxSteps(args.maxSteps),
      ...(args.progressivePlan
        ? { progressivePlan: args.progressivePlan }
        : {}),
      ...(args.discoveryState ? { discoveryState: args.discoveryState } : {}),
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      ...(hooks?.prepareAdvertisedTools
        ? { prepareAdvertisedTools: hooks.prepareAdvertisedTools }
        : {}),
      ...(hooks?.onToolResultChunk
        ? { onToolResultChunk: hooks.onToolResultChunk }
        : {}),
      onEngineError: captureEngineError,
    });

    // Aborted mid-turn: drop it (no writeback, no persist). Return the INPUT
    // history unchanged, matching the old `runLocalOrgChatTurnHeadless` abort
    // contract (`{ messages, aborted: true }`).
    if (result.aborted) {
      return {
        history: args.messages,
        turnTrace: undefined,
        modelSource: rt.modelSource,
      };
    }

    // The direct engine always produces a trace, so a turn-terminating failure
    // is signalled by `onEngineError` (its `onError` fires only for fatal
    // errors; recovered per-step tool errors never reach here). Throw with the
    // same message shape the old headless path did.
    if (lastEngineError) {
      throw new Error(
        lastEngineError.message || "Local org-BYOK turn failed mid-stream."
      );
    }

    await rt.finalizeUsage(result);
    return {
      history: result.messages,
      turnTrace: result.turnTrace,
      modelSource: rt.modelSource,
    };
  }

  // Hosted engines (JAM-paid `/stream`, cloud org-BYOK `/stream/org`). The
  // endpoint + extra body fields + harness selector ride `rt.runtime`.
  const result = await runUnifiedAssistantTurn({
    runtime: rt.runtime,
    streamSink: "none",
    persistMode: "caller",
    messages: args.messages,
    modelDefinition,
    systemPrompt: args.systemPrompt,
    ...(args.temperature !== undefined
      ? { temperature: args.temperature }
      : {}),
    tools: args.tools as ToolSet,
    mcpClientManager: args.mcpClientManager,
    authContext: { kind: "user_bearer", token: args.authHeader ?? "" },
    sourceType,
    origin: "chatbox",
    // Synthetic runs have no human-in-the-loop. Auto-deny approval-required
    // tool calls inside the loop so the run makes forward progress.
    approvalMode: "auto-deny",
    chatSessionId: args.chatSessionId,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.chatboxId ? { chatboxId: args.chatboxId } : {}),
    ...(args.accessVersion !== undefined
      ? { accessVersion: args.accessVersion }
      : {}),
    ...(args.selectedServers
      ? { selectedServerIds: args.selectedServers }
      : {}),
    ...(args.requireToolApproval !== undefined
      ? { requireToolApproval: args.requireToolApproval }
      : {}),
    ...(args.modelVisibleMcpToolResults !== undefined
      ? { modelVisibleMcpToolResults: args.modelVisibleMcpToolResults }
      : {}),
    ...(args.progressivePlan ? { progressivePlan: args.progressivePlan } : {}),
    ...(args.discoveryState ? { discoveryState: args.discoveryState } : {}),
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    // `runAssistantTurn` appends synthesisRunId to extraBodyFields last, so the
    // merged `/stream` body matches the old handler-built shape.
    synthesisRunId,
    ...(hooks?.onToolCall ? { onToolCall: hooks.onToolCall } : {}),
    ...(hooks?.onToolResult ? { onToolResult: hooks.onToolResult } : {}),
    ...(hooks?.prepareAdvertisedTools
      ? { prepareAdvertisedTools: hooks.prepareAdvertisedTools }
      : {}),
    onEngineError: captureEngineError,
  });

  // A produced turnTrace means the turn semantically succeeded (recovered
  // per-step engine errors keep their trace). A MISSING turnTrace on a
  // non-aborted turn always means the engine failed — throw even when no
  // `onEngineError` event was captured, so a failed turn can't silently record
  // an empty assistant reply and skip persistence.
  if (!result.turnTrace && !args.abortSignal?.aborted) {
    if (lastEngineError) {
      const detail = [
        lastEngineError.code,
        lastEngineError.httpStatus !== undefined
          ? `HTTP ${lastEngineError.httpStatus}`
          : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        detail
          ? `${lastEngineError.message} (${detail})`
          : lastEngineError.message
      );
    }
    throw new Error(
      "Assistant turn failed: the engine returned no turn trace (stream error or empty response)"
    );
  }

  await rt.finalizeUsage(result); // no-op for hosted engines
  return {
    history: result.messages,
    turnTrace: result.turnTrace,
    modelSource: rt.modelSource,
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
          typeof (part as { text?: unknown }).text === "string"
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
