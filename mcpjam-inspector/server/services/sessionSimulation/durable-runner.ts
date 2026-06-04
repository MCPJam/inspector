/**
 * Durable, horizontally-safe synthesis pump (plan v4 §F).
 *
 * Each Inspector process runs one pump. On a tick (~1.5s) the pump:
 *   1. Calls `POST /session-simulation/jobs/claim` with its
 *      `workerInstanceId` + `workerScope` and a per-turn cost estimate.
 *   2. If a job is returned, drives one persona/session attempt
 *      end-to-end straight from the claim response — descriptor,
 *      persona, maxTurns all arrive on the claim so the worker
 *      doesn't make a second Convex round-trip. It builds an
 *      MCPClientManager via the descriptor (no user bearer), loops
 *      persona-next-turn/worker ↔ runAssistantTurn until the persona
 *      ends or maxTurns is reached, persists the chat-session row via
 *      ingestMode='worker', then `complete`s the job.
 *   3. Errors during execution terminal-fail the job with a
 *      classification: `lease_lost` (409 mid-flight → silent abort),
 *      `refresh_unavailable` (501 from descriptor/refresh-tokens),
 *      `missing_descriptor` (claim returned `runtimeDescriptor: null`,
 *      i.e. a legacy pre-§C run row), else `execution_error`.
 *
 * Gated behind `SYNTHESIS_RUNNER_MODE` env. Default flipped 2026-06-04
 * to `'durable'` after the backend descriptor + worker-ingest endpoints
 * landed. Operators can roll back to the in-process path by setting
 * `SYNTHESIS_RUNNER_MODE=in_process` explicitly — the in-process
 * runner in `runner.ts` is still wired and runnable.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import { getModelById, type ModelDefinition } from "@/shared/types";
import { logger } from "../../utils/logger.js";
import { workerInstanceId } from "../../utils/worker-identity.js";
import {
  buildSynthesisManager,
  type SynthesisRuntimeDescriptor,
  type SynthesisChatboxConfig,
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
  type ClaimedJob,
} from "../session-agent.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";

const TICK_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TURNS = 6;

/**
 * Inspector reads a single env literal for the runner mode. The
 * default is `'durable'` (this file's pump); set
 * `SYNTHESIS_RUNNER_MODE=in_process` to opt back into the in-process
 * runner in `runner.ts`. Any other value falls through to the
 * `'durable'` default so a typo doesn't silently switch runners.
 */
export function getRunnerMode(): "durable" | "in_process" {
  const raw = process.env.SYNTHESIS_RUNNER_MODE;
  return raw === "in_process" ? "in_process" : "durable";
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

/**
 * Lazily read the inspector service token. The durable runner is the
 * only caller that should ever hit this in production; the bearer
 * paths route around it. Throwing here (vs returning "") surfaces a
 * deployment misconfiguration as a terminal `execution_error` for the
 * one job that triggered it, rather than silently posting unauthorized
 * requests that get rejected later.
 */
function inspectorServiceToken(): string {
  const tok = process.env.INSPECTOR_SERVICE_TOKEN;
  if (typeof tok !== "string" || tok.length === 0) {
    throw new Error(
      "INSPECTOR_SERVICE_TOKEN env var is not set; the durable synthesis runner cannot authenticate to the backend",
    );
  }
  return tok;
}

interface RunOneJobArgs {
  convexHttpUrl: string;
  job: ClaimedJob;
  abortSignal: AbortSignal;
}

/**
 * Coerce a `runtimeDescriptor` carried verbatim on the claim into the
 * typed shape the manager builder consumes. The wire shape is
 * already validated by the backend `parseRuntimeDescriptor`; this is
 * just the local type cast + chatbox-config narrowing so the runner
 * doesn't have to inline `Record<string, unknown>` everywhere.
 */
function narrowDescriptor(
  raw: Record<string, unknown>,
): SynthesisRuntimeDescriptor {
  return raw as unknown as SynthesisRuntimeDescriptor;
}

async function runOneJob(args: RunOneJobArgs): Promise<void> {
  const { convexHttpUrl, job, abortSignal } = args;
  const leaseOwner = job.leaseOwner;

  // Legacy v2 runs predate `runtimeDescriptor` persistence (plan §C).
  // The pump can't synthesize the manager without it, so terminal-fail
  // the job immediately with the dedicated classification so the
  // dialog/UI can tell the operator the run can't be resumed.
  if (!job.runtimeDescriptor) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "missing_descriptor",
      message:
        "Run has no runtimeDescriptor (legacy v2 run created before plan v4 §C); the durable runner cannot rebuild the MCP manager without it",
    });
    return;
  }

  const descriptor = narrowDescriptor(job.runtimeDescriptor);
  const chatboxConfig: SynthesisChatboxConfig = descriptor.chatboxConfig ?? {};
  const modelId = chatboxConfig.modelId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message:
        "runtimeDescriptor.chatboxConfig.modelId missing; cannot resolve model definition",
    });
    return;
  }
  const modelDefinition: ModelDefinition | undefined = getModelById(modelId);
  if (!modelDefinition) {
    await safelyFailJob(convexHttpUrl, job.jobId, leaseOwner, {
      code: "execution_error",
      message: `Unknown modelId: ${modelId}`,
    });
    return;
  }

  const persona = job.persona;
  const built = buildSynthesisManager({
    descriptor,
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
  const requireToolApproval = chatboxConfig.requireToolApproval === true;

  try {
    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
      modelDefinition,
      systemPrompt: chatboxConfig.systemPrompt ?? "",
      temperature: chatboxConfig.temperature,
      requireToolApproval,
      respectToolVisibility: chatboxConfig.respectToolVisibility,
      ...(chatboxConfig.progressiveToolDiscovery !== undefined
        ? {
            progressiveToolDiscovery: {
              enabled: chatboxConfig.progressiveToolDiscovery,
            },
          }
        : {}),
    });

    let messageHistory: ModelMessage[] = [];
    const lastTranscript: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];

    const maxTurns = job.maxTurns ?? DEFAULT_MAX_TURNS;
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
        projectId: job.projectId,
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
        projectId: job.projectId,
        chatboxId: job.chatboxId,
        modelDefinition,
        systemPrompt: prepared.enhancedSystemPrompt,
        temperature: prepared.resolvedTemperature,
        selectedServerIds,
        mcpClientManager: manager,
        authContext: {
          kind: "service_token",
          token: inspectorServiceToken(),
        },
        sourceType: "chatbox",
        surface: "share_link",
        approvalMode: "auto-deny",
        requireToolApproval,
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
      ingestMode: "worker",
      serviceToken: inspectorServiceToken(),
      projectId: job.projectId,
      sourceType: "chatbox",
      surface: "share_link",
      chatboxId: job.chatboxId,
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
