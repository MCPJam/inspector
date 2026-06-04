/**
 * Durable, horizontally-safe synthesis pump (plan v4 §F).
 *
 * Each Inspector process runs one pump. On a tick (~1.5s) the pump:
 *   1. Calls `POST /session-simulation/jobs/claim` with its
 *      `workerInstanceId` + `workerScope` and a per-turn cost estimate.
 *   2. If a job is returned, drives one persona/session attempt
 *      end-to-end: fetch the run record for the persona + descriptor,
 *      build an MCPClientManager via the descriptor (no user bearer),
 *      loop persona-next-turn/worker ↔ runAssistantTurn until the
 *      persona ends or maxTurns is reached, persist the chat-session
 *      row, then `complete` the job.
 *   3. Errors during execution terminal-fail the job with a
 *      classification: `lease_lost` (409 mid-flight → silent abort),
 *      `refresh_unavailable` (501 from descriptor/refresh-tokens),
 *      else `execution_error`.
 *
 * Gated behind `SYNTHESIS_RUNNER_MODE` env. Default `'in_process'`;
 * Commit G flips the default to `'durable'`.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import { getModelById, type ModelDefinition } from "@/shared/types";
import { logger } from "../../utils/logger.js";
import { workerInstanceId } from "../../utils/worker-identity.js";
import {
  buildSynthesisManager,
  type SynthesisRuntimeDescriptor,
} from "../../utils/synthesis-manager-build.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { persistChatSessionToConvex } from "../../utils/chat-ingestion.js";
import { runAssistantTurn } from "../../utils/assistant-turn.js";
import {
  claimJob,
  heartbeatJob,
  completeJob,
  failJob,
  personaNextTurnWorker,
  SessionWorkerLeaseLostError,
  SessionWorkerRefreshUnavailableError,
  type PersonaSlate,
  type ClaimedJob,
} from "../session-agent.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";

const TICK_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TURNS = 6;

/**
 * Backend uses a single env literal for the runner mode. `durable`
 * enables the pump in this file; anything else leaves the in-process
 * runner in `runner.ts` in charge.
 */
export function getRunnerMode(): "durable" | "in_process" {
  const raw = process.env.SYNTHESIS_RUNNER_MODE;
  return raw === "durable" ? "durable" : "in_process";
}

/**
 * Inspector strict-mode flag (mirrors `app.ts:150` `HOSTED_MODE`).
 * Hosted inspectors stamp `workerScope: 'any'` so any peer can pick
 * up the job; local Inspectors stamp `local:${workerInstanceId}` so
 * the job is pinned to the process that created it.
 */
function deriveWorkerScope(): string {
  const hosted = process.env.HOSTED_MODE === "true";
  return hosted ? "any" : `local:${workerInstanceId}`;
}

interface PumpRuntime {
  convexHttpUrl: string;
  abortController: AbortController;
  pumpPromise: Promise<void>;
  currentJobDonePromise: Promise<void> | null;
  setCurrentJob: (p: Promise<void> | null) => void;
}

let activePump: PumpRuntime | null = null;

export interface StartDurablePumpOptions {
  convexHttpUrl: string;
  /** Test-only override. Production picks one fresh from env at boot. */
  workerScopeOverride?: string;
  /** Test-only override of the tick interval. */
  tickIntervalMs?: number;
}

export function startDurablePump(opts: StartDurablePumpOptions): void {
  if (activePump) {
    logger.warn(
      "[sessionSimulation.durable-runner] startDurablePump called while a pump is already active; ignoring",
    );
    return;
  }
  const workerScope = opts.workerScopeOverride ?? deriveWorkerScope();
  const tickMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  const abortController = new AbortController();
  let currentJobDone: Promise<void> | null = null;
  const runtime: PumpRuntime = {
    convexHttpUrl: opts.convexHttpUrl,
    abortController,
    currentJobDonePromise: null,
    setCurrentJob: (p) => {
      runtime.currentJobDonePromise = p;
      currentJobDone = p;
    },
    pumpPromise: pumpLoop({
      convexHttpUrl: opts.convexHttpUrl,
      workerScope,
      tickMs,
      abortSignal: abortController.signal,
      setCurrentJob: (p) => {
        runtime.currentJobDonePromise = p;
        currentJobDone = p;
      },
    }),
  };
  activePump = runtime;
  void currentJobDone;
  logger.info("[sessionSimulation.durable-runner] pump started", {
    workerScope,
    workerInstanceId,
  });
}

export async function stopDurablePump(): Promise<void> {
  if (!activePump) return;
  const pump = activePump;
  activePump = null;
  pump.abortController.abort();
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, SHUTDOWN_TIMEOUT_MS),
  );
  await Promise.race([
    Promise.allSettled([pump.pumpPromise, pump.currentJobDonePromise]),
    timeout,
  ]);
}

interface PumpLoopArgs {
  convexHttpUrl: string;
  workerScope: string;
  tickMs: number;
  abortSignal: AbortSignal;
  setCurrentJob: (p: Promise<void> | null) => void;
}

async function pumpLoop(args: PumpLoopArgs): Promise<void> {
  const { convexHttpUrl, workerScope, tickMs, abortSignal, setCurrentJob } =
    args;
  while (!abortSignal.aborted) {
    try {
      const claim = await claimJob(convexHttpUrl, {
        workerInstanceId,
        workerScope,
      });
      if (claim.kind === "claimed") {
        const jobPromise = runOneJob({
          convexHttpUrl,
          job: claim,
          abortSignal,
        }).catch((err) => {
          logger.warn("[sessionSimulation.durable-runner] runOneJob failed", {
            jobId: claim.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        setCurrentJob(jobPromise);
        await jobPromise;
        setCurrentJob(null);
        continue;
      }
      // Either `no_job` or `budget_cap_terminated` — both are
      // non-actionable here; sleep before next tick.
    } catch (err) {
      logger.warn("[sessionSimulation.durable-runner] claim tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(tickMs, abortSignal);
  }
}

function sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (abortSignal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// Internal helper exposed for tests so the run/persona/descriptor
// fetch shape can be stubbed without spinning up the whole pump.
export interface DurableRunSnapshot {
  runId: string;
  projectId: string;
  chatboxId: string;
  personas: PersonaSlate[];
  maxTurns: number;
  modelId: string;
  systemPrompt: string;
  temperature?: number;
  requireToolApproval: boolean;
  respectToolVisibility?: boolean;
  progressiveToolDiscovery?: boolean;
  runtimeDescriptor: SynthesisRuntimeDescriptor;
}

export type FetchRunSnapshot = (
  convexHttpUrl: string,
  runId: string,
) => Promise<DurableRunSnapshot | null>;

/**
 * The pump fetches the snapshot via the existing service-token-authed
 * `getSynthesisRun` HTTP route. The implementation hits the backend
 * `internal.sessionSimulation.routes.getSynthesisRun` via the
 * `/session-simulation/persona-next-turn/worker` path's same fetch
 * pattern; refactor into a shared helper once the backend exposes a
 * dedicated GET endpoint. For now we surface the contract here so
 * tests can override it.
 */
export let fetchRunSnapshot: FetchRunSnapshot = async () => {
  throw new Error(
    "fetchRunSnapshot is not yet wired against the backend; the durable runner cannot resolve a claimed job without it. Wire via SYNTHESIS_RUNNER_MODE='in_process' until then.",
  );
};

export function __setFetchRunSnapshotForTesting(fn: FetchRunSnapshot): void {
  fetchRunSnapshot = fn;
}

interface RunOneJobArgs {
  convexHttpUrl: string;
  job: ClaimedJob;
  abortSignal: AbortSignal;
}

async function runOneJob(args: RunOneJobArgs): Promise<void> {
  const { convexHttpUrl, job, abortSignal } = args;
  const leaseOwner = workerInstanceId;

  let snapshot: DurableRunSnapshot | null;
  try {
    snapshot = await fetchRunSnapshot(convexHttpUrl, job.runId);
  } catch (err) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message: `fetchRunSnapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (!snapshot) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message: "Run snapshot not found",
    });
    return;
  }

  const persona = snapshot.personas.find((p) => p.id === job.personaId);
  if (!persona) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message: `Persona ${job.personaId} not found on run`,
    });
    return;
  }

  const modelDefinition: ModelDefinition | undefined = getModelById(
    snapshot.modelId,
  );
  if (!modelDefinition) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message: `Unknown modelId: ${snapshot.modelId}`,
    });
    return;
  }

  const built = buildSynthesisManager({
    descriptor: snapshot.runtimeDescriptor,
    timeoutMs: WEB_STREAM_TIMEOUT_MS,
  });
  const manager: MCPClientManager = built.manager;
  const selectedServerIds = built.connectedServerIds;

  let lastHeartbeatAt = Date.now();
  const beatIfDue = async () => {
    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeatAt = now;
    try {
      await heartbeatJob(convexHttpUrl, { jobId: job.jobId, leaseOwner });
    } catch (err) {
      if (err instanceof SessionWorkerLeaseLostError) throw err;
      logger.warn(
        "[sessionSimulation.durable-runner] heartbeat failed (non-lease)",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  };

  const chatSessionId = `synth_${job.runId}_${persona.id}_${job.sessionIndex}`;
  const sessionStartedAt = Date.now();

  try {
    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
      modelDefinition,
      systemPrompt: snapshot.systemPrompt,
      temperature: snapshot.temperature,
      requireToolApproval: snapshot.requireToolApproval,
      respectToolVisibility: snapshot.respectToolVisibility,
      ...(snapshot.progressiveToolDiscovery !== undefined
        ? {
            progressiveToolDiscovery: {
              enabled: snapshot.progressiveToolDiscovery,
            },
          }
        : {}),
    });

    let messageHistory: ModelMessage[] = [];
    const lastTranscript: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];

    const maxTurns = snapshot.maxTurns ?? DEFAULT_MAX_TURNS;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortSignal.aborted) {
        await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
          code: "execution_error",
          message: "Worker aborted mid-turn (shutdown)",
        });
        return;
      }
      await beatIfDue();

      const next = await personaNextTurnWorker(convexHttpUrl, {
        projectId: snapshot.projectId,
        runId: job.runId,
        jobId: job.jobId,
        personaId: persona.id,
        transcriptSoFar: lastTranscript,
      });
      if (next.endSession) break;

      messageHistory.push({
        role: "user",
        content: next.message,
      } as ModelMessage);
      lastTranscript.push({ role: "user", content: next.message });

      const turnResult = await runAssistantTurn({
        messages: messageHistory,
        projectId: snapshot.projectId,
        chatboxId: snapshot.chatboxId,
        modelDefinition,
        systemPrompt: prepared.enhancedSystemPrompt,
        temperature: prepared.resolvedTemperature,
        selectedServerIds,
        mcpClientManager: manager,
        authContext: {
          kind: "service_token",
          token: process.env.INSPECTOR_SERVICE_TOKEN ?? "",
        },
        sourceType: "chatbox",
        surface: "share_link",
        approvalMode: "auto-deny",
        requireToolApproval: snapshot.requireToolApproval,
        streamSink: "none",
        persistMode: "caller",
        synthesisRunId: job.runId,
        synthesisJobId: job.jobId,
        tools: prepared.allTools,
        chatSessionId,
        progressivePlan: prepared.progressivePlan,
        discoveryState: prepared.discoveryState,
        abortSignal,
      });

      messageHistory = turnResult.messages;
      const assistantText = extractAssistantText(messageHistory);
      lastTranscript.push({ role: "assistant", content: assistantText });
    }

    await beatIfDue();

    await persistChatSessionToConvex({
      chatSessionId,
      modelId: String(modelDefinition.id),
      modelSource: "mcpjam",
      authHeader: "", // service-token path; ingestion accepts empty bearer
      projectId: snapshot.projectId,
      sourceType: "chatbox",
      surface: "share_link",
      chatboxId: snapshot.chatboxId,
      sessionMessages: messageHistory,
      startedAt: sessionStartedAt,
      lastActivityAt: Date.now(),
      synthetic: true,
      personaId: persona.id,
      personaLabel: persona.name,
      visitorDisplayName: persona.name,
      synthesisRunId: job.runId,
    });

    try {
      await completeJob(convexHttpUrl, {
        jobId: job.jobId,
        leaseOwner,
        resultChatSessionId: chatSessionId,
      });
    } catch (err) {
      if (err instanceof SessionWorkerLeaseLostError) {
        // Recovery cron handles this; silent abort.
        return;
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof SessionWorkerLeaseLostError) {
      // Heartbeat/complete lost the lease — abandon silently; recovery
      // cron will re-queue or terminal-fail the job per its policy.
      return;
    }
    if (err instanceof SessionWorkerRefreshUnavailableError) {
      await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
        code: "refresh_unavailable",
        message: err.message,
      });
      return;
    }
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      await built.dispose();
    } catch (err) {
      logger.warn("[sessionSimulation.durable-runner] manager dispose failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function safelyFailJob(
  convexHttpUrl: string,
  jobId: string,
  leaseOwner: string,
  err: { code: string; message: string },
): Promise<void> {
  try {
    await failJob(convexHttpUrl, {
      jobId,
      leaseOwner,
      errorCode: err.code,
      errorMessage: err.message,
    });
  } catch (failErr) {
    if (failErr instanceof SessionWorkerLeaseLostError) return;
    logger.warn(
      "[sessionSimulation.durable-runner] failJob HTTP call itself failed",
      {
        jobId,
        errorCode: err.code,
        failError: failErr instanceof Error ? failErr.message : String(failErr),
      },
    );
  }
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

export const __internals = {
  runOneJob,
  deriveWorkerScope,
  pumpLoop,
};
