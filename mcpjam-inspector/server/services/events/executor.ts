/**
 * The event-job executor (contract C6).
 *
 * Claims one scheduled trigger run at a time from the backend
 * (`runs/claim`), and runs it as ONE unattended assistant turn:
 *
 *   1. The owner's delegated bearer (`getConvexBearerForDelegation`); C7
 *      "Execute tools": `createAuthorizedManager` re-authorizes every server
 *      for that user — the subscription's own server with the OAuth
 *      connection it was created under (`input.subscription
 *      .oauthConnectionId`), never the owner's current default. A refusal
 *      ends the run `authorization_lost`, which parks the subscription.
 *   2. The servers of the environment named in the FROZEN snapshot
 *      (`input.trigger.environmentId`, else the subscription's), resolved
 *      with `resolveEnvironmentForLaunch`; with no environment, just the
 *      subscription's own server. The tool catalog is built by
 *      `prepareChatV2` from THOSE servers only — never the platform-operation
 *      tools `routes/v1/agent.ts` gives MCPJam's own agent.
 *   3. Every tool's `execute` is journaled: `runs/begin-call` before,
 *      `runs/finish-call` after. A call the journal already completed is
 *      replayed from its recorded result; a call that BEGAN and never finished
 *      (`409 tool_outcome_unknown`) aborts the turn and parks the run — it is
 *      never re-executed, because it may already have happened. A call that
 *      is not read-only runs only once a checkpoint the backend acknowledged
 *      names it (`createRunCheckpointer`), in both engines: a worker that dies
 *      after the effect resumes with the call still in its history, so the
 *      journal replays it instead of the model asking again under a new id.
 *      A checkpoint that cannot be saved stops the run (`checkpoint_failed`).
 *   4. The trigger's instructions are the ONLY instructions. The event is
 *      rendered as a delimited, JSON-escaped DATA block marked untrusted, and
 *      no event text is ever interpolated into an instruction.
 *   5. `runUnifiedAssistantTurn` with `sourceType: "event"`, `origin:
 *      "event"`, `streamSink: "none"`, `persistMode: "caller"`,
 *      `approvalMode: "auto-deny"`. A spend refusal from the `/stream`
 *      precheck finishes the run `failed` with `spend_refused` — no retry
 *      loop; the claim mutation's budgets decide when the next run may start.
 *   6. The run's turn is appended to its trigger's ONE chat thread
 *      (`event-trigger-<triggerId>`, `origin: "event"`) so event runs appear
 *      in the Playground, and that id is reported with `runs/finish`.
 *
 * Env-gated: `EVENTS_EXECUTOR_ENABLED === "1"`. The inbox's dispatch rings
 * `kickEventsExecutor()` (via `/api/internal/events/enqueue`) so a scheduled
 * run starts without waiting for the next poll.
 */

import type { ModelMessage } from "ai";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { logger } from "../../utils/logger.js";
import {
  EventsBackendClient,
  StaleLeaseError,
  isEventsBackendConfigured,
  type EventRunClaim,
} from "./backend-client.js";
import { defaultEventsHolder, isEventsExecutorEnabled } from "./config.js";
import { registerEventsExecutorBell } from "./executor-bell.js";
import {
  DEFAULT_EVENT_RUN_MODEL_ID,
  defaultConnect,
  defaultGetBearer,
  defaultPrepareChat,
  defaultResolveModel,
  defaultResolveRuntime,
  defaultResolveServers,
  defaultRunTurn,
  type EventExecutorDeps,
  type EventRunConnection,
} from "./executor-deps.js";
import { isOwnerAuthorizationRefusal, pinnedConnectionIds } from "./owner-connection.js";
import { createRunCheckpointer } from "./run-checkpointer.js";
import { eventTriggerChatSessionId, persistEventRunTranscript } from "./run-transcript.js";
import {
  buildEventRunMessages,
  isSpendRefusal,
  shortError,
  summarizeEventRun,
  type EventRunResultSummary,
} from "./run-turn.js";
import { EventRunHaltError, readOnlyToolNames, wrapToolsForEventRun } from "./tool-journal.js";

export {
  DEFAULT_EVENT_RUN_MODEL_ID,
  type EventExecutorDeps,
  type EventRunConnection,
} from "./executor-deps.js";
export { createRunCheckpointer, type RunCheckpointer } from "./run-checkpointer.js";
export {
  buildEventRunMessages,
  isSpendRefusal,
  summarizeEventRun,
  type EventRunResultSummary,
} from "./run-turn.js";
export {
  EventRunHaltError,
  readOnlyToolNames,
  toolCallIdsIn,
  wrapToolsForEventRun,
  type EventRunToolIntent,
  type ToolJournalPort,
} from "./tool-journal.js";

const POLL_INTERVAL_MS = 5_000;
const POLL_JITTER_MS = 1_000;
const ERROR_BACKOFF_MS = 30_000;
/** Below the backend's 120 s run lease; each checkpoint renews it. */
const HEARTBEAT_MS = 45_000;

export type EventRunOutcome =
  | { status: "completed"; result: EventRunResultSummary }
  | { status: "failed"; error: string }
  | { status: "parked"; error: string }
  | { status: "lease_lost" };

/** The terminal state a halted run reports. */
function haltedOutcome(reason: EventRunHaltError["reason"]): EventRunOutcome {
  if (reason === "lease_lost") return { status: "lease_lost" };
  if (reason === "tool_outcome_unknown") {
    return { status: "parked", error: "tool_outcome_unknown" };
  }
  return { status: "failed", error: "checkpoint_failed" };
}

/**
 * Execute one claimed run end to end and report its terminal state. Never
 * throws; a lost lease is the only outcome that writes nothing back (the run
 * belongs to someone else by then).
 */
export async function executeClaimedEventRun(
  claim: EventRunClaim,
  deps: EventExecutorDeps,
): Promise<EventRunOutcome> {
  const runId = String(claim.run._id);
  const token = claim.token;
  const projectId = String(claim.run.projectId);
  const logContext = { runId, triggerId: String(claim.run.triggerId) };

  const finish = async (
    outcome: EventRunOutcome,
    extras: { chatSessionId?: string } = {},
  ): Promise<EventRunOutcome> => {
    if (outcome.status === "lease_lost") return outcome;
    try {
      await deps.backend.finishRun({
        runId,
        token,
        status: outcome.status,
        ...(outcome.status === "completed"
          ? { result: outcome.result }
          : { error: outcome.error }),
        ...(extras.chatSessionId ? { chatSessionId: extras.chatSessionId } : {}),
      });
    } catch (error) {
      if (error instanceof StaleLeaseError) return { status: "lease_lost" };
      logger.warn("[events-executor] finish failed", {
        ...logContext,
        error: shortError(error),
      });
    }
    return outcome;
  };

  const input = claim.input;
  if (!input || !input.trigger || !input.event || !input.subscription) {
    return finish({ status: "failed", error: "missing_input" });
  }

  const abortController = new AbortController();
  let halted: EventRunHaltError["reason"] | undefined;
  const halt = (reason: EventRunHaltError["reason"]) => {
    halted ??= reason;
    if (!abortController.signal.aborted) abortController.abort(new EventRunHaltError(reason));
  };

  let connection: EventRunConnection | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const bearer = await (deps.getBearer ?? defaultGetBearer)(
      claim.ownerExternalId,
      claim.organizationId,
    );
    const servers = await (deps.resolveServers ?? defaultResolveServers)({
      claim,
      input,
      bearer,
    });
    // The subscription's server with the connection it was created under
    // (C2), never the owner's current default. If that connection cannot be
    // used the run stops as `authorization_lost`, which parks the
    // subscription for reauthorization.
    const pinned = pinnedConnectionIds(
      input.subscription.serverId,
      input.subscription.oauthConnectionId,
    );
    try {
      connection = await (deps.connect ?? defaultConnect)({
        projectId,
        bearer,
        serverIds: servers.serverIds,
        ...(servers.serverNames ? { serverNames: servers.serverNames } : {}),
        ...(pinned ?? {}),
      });
    } catch (error) {
      // Only the subscription's own server parks the subscription; a refusal
      // for another server of the environment fails this run like any error.
      if (!isOwnerAuthorizationRefusal(error, input.subscription.serverId)) throw error;
      logger.warn("[events-executor] owner authorization refused", {
        ...logContext,
        error: shortError(error),
      });
      return finish({ status: "failed", error: "authorization_lost" });
    }
    const manager = connection.manager;

    const modelId =
      (typeof input.trigger.modelId === "string" && input.trigger.modelId.trim()) ||
      servers.environmentModelId ||
      DEFAULT_EVENT_RUN_MODEL_ID;
    const modelDefinition = await (deps.resolveModel ?? defaultResolveModel)({
      modelId,
      projectId,
      bearer,
    });

    const subscriptionServerIndex = servers.serverIds.indexOf(input.subscription.serverId);
    const serverName =
      subscriptionServerIndex >= 0 ? servers.serverNames?.[subscriptionServerIndex] : undefined;
    const built = buildEventRunMessages(input, serverName ? { serverName } : {});
    const prepareChat = deps.prepareChat ?? defaultPrepareChat;
    // The environment's servers, and only them: no built-ins, no skills, no
    // platform operations (C6).
    const prepared = await prepareChat({
      mcpClientManager: manager,
      selectedServers: servers.serverIds,
      modelDefinition,
      systemPrompt: built.systemPrompt,
      requireToolApproval: false,
      skillsSource: { kind: "none" },
    });
    // Resume from the checkpoint when there is one; its unresolved tool calls
    // (if the last attempt died between the model and the tools) are finished
    // first, through the SAME journal — completed calls replay, unknown ones
    // park.
    const resumed = Array.isArray(claim.messages) && claim.messages.length > 0;
    let messages: ModelMessage[] = resumed
      ? (claim.messages as ModelMessage[])
      : built.messages;
    const lastStep = Math.max(0, claim.step ?? 0);
    const checkpointer = createRunCheckpointer({
      messages,
      step: lastStep,
      stored: resumed,
      write: (state) =>
        deps.backend.checkpointRun({
          runId,
          token,
          messages: state.messages,
          step: state.step,
        }),
    });
    // A checkpoint the run depends on: if it cannot be saved, the turn stops
    // and no further tool runs (`halted` is set before the error surfaces).
    const durable = async (write: Promise<void>) => {
      try {
        await write;
      } catch (error) {
        if (error instanceof EventRunHaltError) throw error;
        const reason = error instanceof StaleLeaseError ? "lease_lost" : "checkpoint_failed";
        if (reason === "checkpoint_failed") {
          logger.warn("[events-executor] checkpoint failed; stopping the run", {
            ...logContext,
            error: shortError(error),
          });
        }
        halt(reason);
        throw new EventRunHaltError(reason);
      }
    };
    heartbeat = setInterval(() => {
      // Lease renewal only: it rewrites state that is already durable, so a
      // transient failure loses nothing. A lost lease still stops the run.
      void checkpointer.heartbeat().catch((error) => {
        if (error instanceof StaleLeaseError) halt("lease_lost");
      });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const tools = wrapToolsForEventRun(prepared.allTools, {
      journal: deps.backend,
      runId,
      token,
      approvalPolicy: input.trigger.approvalPolicy,
      readOnlyTools: readOnlyToolNames(manager, servers.serverIds),
      halt,
      halted: () => halted,
      ensureDurable: (intent) => durable(checkpointer.ensureDurable(intent)),
    });

    if (resumed && hasUnresolvedToolCalls(messages)) {
      try {
        const results = await executeToolCallsFromMessages(messages, {
          tools,
          skipNonExecutableTools: true,
          abortSignal: abortController.signal,
        });
        messages = [...messages, ...results];
        await durable(checkpointer.checkpoint(messages, lastStep));
      } catch (error) {
        if (!halted) throw error;
      }
    }
    if (halted) return finish(haltedOutcome(halted));

    // ONE chat thread per trigger: usage is attributed to it, and each run's
    // transcript is appended to it (see `run-transcript.ts`).
    const chatSessionId = eventTriggerChatSessionId(String(claim.run.triggerId ?? input.trigger.id));
    const runStartedAt = Date.now();
    const rt = await (deps.resolveRuntime ?? defaultResolveRuntime)({
      modelDefinition,
      projectId,
      authHeader: `Bearer ${bearer}`,
      runId,
      chatSessionId,
      tools,
      messages,
    });

    let lastEngineError:
      | { message: string; code?: string; refusalReason?: string; httpStatus?: number }
      | undefined;
    const stepBase = lastStep;
    const runtime = rt.runtime;
    const hosted = runtime?.kind === "hosted";
    const runTurn = deps.runTurn ?? defaultRunTurn;
    const common = {
      streamSink: "none" as const,
      messages,
      systemPrompt: prepared.enhancedSystemPrompt,
      tools,
      maxSteps: input.trigger.maxSteps,
      abortSignal: abortController.signal,
      ...(prepared.progressivePlan ? { progressivePlan: prepared.progressivePlan } : {}),
      ...(prepared.discoveryState ? { discoveryState: prepared.discoveryState } : {}),
      onEngineError: (event: {
        message: string;
        code?: string;
        refusalReason?: string;
        httpStatus?: number;
      }) => {
        lastEngineError = event;
      },
    };
    const result = await runTurn(
      hosted
        ? {
            ...common,
            runtime,
            persistMode: "caller",
            approvalMode: "auto-deny",
            sourceType: "event",
            origin: "event",
            modelDefinition,
            mcpClientManager: manager,
            authContext: { kind: "user_bearer", token: `Bearer ${bearer}` },
            projectId,
            chatSessionId,
            // The handler awaits this before the next external effect (the
            // `tools` phase holds the model's tool calls before any runs), so
            // a failure here stops the turn instead of being logged past.
            durableCheckpoint: (state: {
              phase: string;
              messages: ModelMessage[];
              step: number;
            }) => durable(checkpointer.checkpoint(state.messages, stepBase + state.step)),
          }
        : { ...common, runtime },
    );

    if (halted) return finish(haltedOutcome(halted));
    const finalMessages: ModelMessage[] = Array.isArray(result?.messages)
      ? result.messages
      : messages;
    if (!hosted) {
      // Crash insurance before the terminal write. Every effect is already
      // covered by an intent checkpoint, so a failure here loses nothing.
      await checkpointer
        .checkpoint(finalMessages, stepBase + (result?.newMessages?.length ?? 0))
        .catch((error) => {
          if (error instanceof StaleLeaseError) halt("lease_lost");
        });
    }
    if (halted) return finish(haltedOutcome(halted));
    const outcome: EventRunOutcome = lastEngineError
      ? isSpendRefusal(lastEngineError)
        ? { status: "failed", error: "spend_refused" }
        : {
            status: "failed",
            error: `engine_error: ${shortError(lastEngineError.message)}`,
          }
      : result?.aborted
        ? { status: "failed", error: "aborted" }
        : {
            status: "completed",
            result: summarizeEventRun({
              newMessages: result?.newMessages ?? [],
              toolCalls: result?.toolCalls ?? [],
              toolResults: result?.toolResults ?? [],
            }),
          };

    // The run's turn goes into the trigger's chat thread when it produced
    // anything — a completed run, or a failure after the model had spoken.
    let persistedChatSessionId: string | undefined;
    const produced = Array.isArray(result?.newMessages) && result.newMessages.length > 0;
    if (deps.transcript !== false && produced) {
      const persisted = await persistEventRunTranscript({
        ...(deps.transcript ? { port: deps.transcript } : {}),
        triggerId: String(claim.run.triggerId ?? input.trigger.id),
        runId,
        projectId,
        bearer,
        modelId: String(modelDefinition.id),
        modelSource: rt.modelSource ?? "mcpjam",
        systemPrompt: prepared.enhancedSystemPrompt,
        runMessages: finalMessages,
        ...(result?.turnTrace ? { turnTrace: result.turnTrace } : {}),
        startedAt: runStartedAt,
      }).catch((error: unknown) => {
        logger.warn("[events-executor] transcript persist failed", {
          ...logContext,
          error: shortError(error),
        });
        return { chatSessionId, persisted: false };
      });
      if (persisted.persisted) persistedChatSessionId = persisted.chatSessionId;
    }
    return finish(
      outcome,
      persistedChatSessionId ? { chatSessionId: persistedChatSessionId } : {},
    );
  } catch (error) {
    if (error instanceof StaleLeaseError) halt("lease_lost");
    if (halted) return finish(haltedOutcome(halted));
    logger.warn("[events-executor] run failed", { ...logContext, error: shortError(error) });
    return finish({ status: "failed", error: shortError(error) });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        // The outcome is already decided; closing is cleanup only.
        logger.debug("[events-executor] close failed", { ...logContext, error: shortError(error) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface EventsExecutorHandle {
  stop(): Promise<void>;
  kick(): void;
}

export { kickEventsExecutor } from "./executor-bell.js";

export function startEventsExecutor(options?: {
  claimedBy?: string;
  deps?: EventExecutorDeps;
  force?: boolean;
  intervalMs?: number;
}): EventsExecutorHandle {
  if (!options?.force && !isEventsExecutorEnabled()) {
    return { stop: async () => {}, kick: () => {} };
  }
  if (!options?.deps && !isEventsBackendConfigured()) {
    logger.warn(
      "[events-executor] enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting",
    );
    return { stop: async () => {}, kick: () => {} };
  }
  const deps: EventExecutorDeps = options?.deps ?? { backend: new EventsBackendClient() };
  const holder = options?.claimedBy ?? defaultEventsHolder("inspector-events-executor");
  const intervalMs = options?.intervalMs ?? POLL_INTERVAL_MS;
  const abort = new AbortController();
  let wake: (() => void) | undefined;
  let kicked = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (kicked) {
        kicked = false;
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", done);
        wake = undefined;
        resolve();
      }
      wake = done;
      abort.signal.addEventListener("abort", done, { once: true });
    });

  logger.info("[events-executor] started", { holder });
  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs = intervalMs + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const claim = await deps.backend.claimRun(holder);
        if (claim) {
          const outcome = await executeClaimedEventRun(claim, deps);
          logger.info("[events-executor] run settled", {
            runId: String(claim.run._id),
            status: outcome.status,
          });
          // Drain: another run may be queued behind this one.
          waitMs = 0;
        }
      } catch (error) {
        logger.warn("[events-executor] claim failed", { error: shortError(error) });
        waitMs = ERROR_BACKOFF_MS;
      }
      if (abort.signal.aborted) break;
      await sleep(waitMs);
    }
    logger.info("[events-executor] stopped");
  })();

  const kick = () => {
    if (wake) wake();
    else kicked = true;
  };
  const unregister = registerEventsExecutorBell(kick);
  return {
    stop: async () => {
      unregister();
      abort.abort();
      await loop;
    },
    kick,
  };
}
