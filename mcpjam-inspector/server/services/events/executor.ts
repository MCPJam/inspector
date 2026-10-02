/**
 * The event-job executor (contract C6).
 *
 * Claims one scheduled trigger run at a time from the backend
 * (`runs/claim`), and runs it as ONE unattended assistant turn:
 *
 *   1. The owner's delegated bearer (`getConvexBearerForDelegation`); C7
 *      "Execute tools": `createAuthorizedManager` re-authorizes every server
 *      for that user.
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

import type { ModelMessage, ToolSet } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import { renderEventTurnMessages } from "@mcpjam/sdk/events";
import type { ModelDefinition } from "@/shared/types";
import { isTransientSpendRefusal } from "@/shared/swarm-attempt-error";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  EventsBackendClient,
  StaleLeaseError,
  ToolOutcomeUnknownError,
  isEventsBackendConfigured,
  type EventRunClaim,
  type EventRunInput,
} from "./backend-client.js";
import { defaultEventsHolder, isEventsExecutorEnabled } from "./config.js";
import { registerEventsExecutorBell } from "./executor-bell.js";
import {
  eventTriggerChatSessionId,
  persistEventRunTranscript,
  type TranscriptPort,
} from "./run-transcript.js";
import type { SyntheticModelSource } from "../../utils/org-model-config.js";

/**
 * Model for a trigger that names none and whose environment names none: the
 * hosted default evals use for generated suites (`DEFAULT_SUITE_MODEL` in
 * `routes/v1/agent.ts`), billed to the owner's organization like any turn.
 */
export const DEFAULT_EVENT_RUN_MODEL_ID = "anthropic/claude-haiku-4.5";

const POLL_INTERVAL_MS = 5_000;
const POLL_JITTER_MS = 1_000;
const ERROR_BACKOFF_MS = 30_000;
/** Below the backend's 120 s run lease; each checkpoint renews it. */
const HEARTBEAT_MS = 45_000;
const MAX_RESULT_TEXT_CHARS = 4_000;
const MAX_ERROR_CHARS = 300;

/** Progressive discovery meta-tools: pure reads of the catalog, not journaled. */
const CATALOG_META_TOOLS = new Set(["search_mcp_tools", "load_mcp_tools"]);

/** Backend denial codes that mean "the spend precheck refused this step". */
const SPEND_REFUSAL_CODES = new Set([
  "platform_free_budget_exhausted",
  "account_suspended",
  "guest_model_not_allowed",
  "guest_input_too_large",
  "user_rate_limit",
  "wallet_locked",
  "org_rate_limit",
  "billing_limit_reached",
  "billing_feature_not_included",
  "spend_budget_reached",
  "free_tier_model_restricted",
  "spending_reservation_busy",
]);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The run's prompt, in the ONE shape event turns use everywhere (the SDK's
 * `renderEventTurnMessages`, shared with evals so an eval measures what runs
 * unattended): the trigger's instructions are the only instruction, and the
 * event is a JSON block marked untrusted whose contents cannot close it.
 */
export function buildEventRunMessages(
  input: EventRunInput,
  options: { serverName?: string } = {},
): {
  systemPrompt: string;
  messages: ModelMessage[];
} {
  const data = input.event.data;
  const { systemPrompt, userMessage } = renderEventTurnMessages({
    instructions: input.trigger.instructions,
    event: {
      ...(input.event.eventId ? { eventId: input.event.eventId } : {}),
      name: input.event.name,
      ...(input.event.timestamp ? { timestamp: input.event.timestamp } : {}),
      data:
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : { value: data ?? null },
    },
    ...(options.serverName ? { source: { serverName: options.serverName } } : {}),
  });
  return {
    systemPrompt: `${systemPrompt}\n\nNo person is watching this run and no one can answer questions. When you are done, reply with a short summary of what you did.`,
    messages: [{ role: "user", content: userMessage }],
  };
}

// ---------------------------------------------------------------------------
// Tool journal
// ---------------------------------------------------------------------------

/** Thrown inside a tool when the run must stop (the turn is aborted too). */
export class EventRunHaltError extends Error {
  constructor(
    readonly reason: "tool_outcome_unknown" | "lease_lost" | "checkpoint_failed",
  ) {
    super(
      reason === "tool_outcome_unknown"
        ? "A tool call from an earlier attempt of this run has an unknown outcome; the run is parked instead of repeating it."
        : reason === "checkpoint_failed"
          ? "The run's checkpoint could not be saved, so no further tool may run."
          : "This executor lost the run's lease.",
    );
    this.name = "EventRunHaltError";
  }
}

/** One tool call the model asked for, as a checkpoint records it. */
export interface EventRunToolIntent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Every tool-call / tool-result id a message list mentions. */
export function toolCallIdsIn(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const id = (part as { toolCallId?: unknown } | null)?.toolCallId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

export interface ToolJournalPort {
  beginCall(args: {
    runId: string;
    token: string;
    callId: string;
    operation: string;
    input: unknown;
    replayable: boolean;
  }): Promise<{ replay: boolean; result?: unknown }>;
  finishCall(args: {
    runId: string;
    token: string;
    callId: string;
    result: unknown;
  }): Promise<void>;
}

const DENIED_WRITE_RESULT = {
  content: [
    {
      type: "text",
      text: "Denied by the trigger's approval policy (deny_writes): this tool is not declared read-only.",
    },
  ],
  isError: true,
};

/** Tool names declared `readOnlyHint: true` on every server that offers them. */
export function readOnlyToolNames(
  manager: Pick<MCPClientManager, "getAllToolAnnotations">,
  serverIds: string[],
): Set<string> {
  const readOnly = new Set<string>();
  const notReadOnly = new Set<string>();
  for (const serverId of serverIds) {
    let annotations: Record<string, Record<string, unknown> | undefined> = {};
    try {
      annotations = manager.getAllToolAnnotations(serverId);
    } catch {
      annotations = {};
    }
    for (const [name, value] of Object.entries(annotations)) {
      if (value?.readOnlyHint === true) readOnly.add(name);
      else notReadOnly.add(name);
    }
  }
  for (const name of notReadOnly) readOnly.delete(name);
  return readOnly;
}

/**
 * Journal every tool call of one run (C6). Mutates and returns `tools`.
 *
 * `halt` is called — and an {@link EventRunHaltError} thrown — when the
 * journal says the run must stop: `tool_outcome_unknown` (park) or a lost
 * lease (someone else owns the run now).
 *
 * A call that is not replayable runs only once its intent is durable:
 * `ensureDurable` resolves when a checkpoint the backend acknowledged names
 * the call, so a worker that dies after the effect resumes from a checkpoint
 * that still holds the call, and the journal replays its result instead of
 * the model asking again under a new id. Once the run has halted (`halted`
 * returns a reason) no tool runs at all.
 */
export function wrapToolsForEventRun(
  tools: ToolSet,
  options: {
    journal: ToolJournalPort;
    runId: string;
    token: string;
    approvalPolicy: "deny_writes" | "auto_deny";
    readOnlyTools?: ReadonlySet<string>;
    halt: (reason: EventRunHaltError["reason"]) => void;
    halted?: () => EventRunHaltError["reason"] | undefined;
    ensureDurable?: (intent: EventRunToolIntent) => Promise<void>;
  },
): ToolSet {
  for (const [name, definition] of Object.entries(tools)) {
    const execute = (definition as { execute?: (...args: any[]) => any }).execute;
    if (typeof execute !== "function") continue;
    if (CATALOG_META_TOOLS.has(name)) continue;
    const readOnly = options.readOnlyTools?.has(name) === true;
    (definition as { execute: (...args: any[]) => any }).execute = async (
      input: unknown,
      callOptions: { toolCallId?: string } & Record<string, unknown>,
    ) => {
      if (options.approvalPolicy === "deny_writes" && !readOnly) {
        // Denied before any effect, so there is nothing to journal.
        return DENIED_WRITE_RESULT;
      }
      const callId = callOptions?.toolCallId;
      if (!callId) throw new Error("Event run tool call has no identity.");
      const stopped = options.halted?.();
      if (stopped) throw new EventRunHaltError(stopped);
      // Intent before effect. A read-only call may simply run again.
      if (!readOnly && options.ensureDurable) {
        await options.ensureDurable({
          toolCallId: callId,
          toolName: name,
          input: input ?? null,
        });
      }
      let begun: { replay: boolean; result?: unknown };
      try {
        begun = await options.journal.beginCall({
          runId: options.runId,
          token: options.token,
          callId,
          operation: name,
          input: input ?? null,
          replayable: readOnly,
        });
      } catch (error) {
        if (error instanceof ToolOutcomeUnknownError) {
          options.halt("tool_outcome_unknown");
          throw new EventRunHaltError("tool_outcome_unknown");
        }
        if (error instanceof StaleLeaseError) {
          options.halt("lease_lost");
          throw new EventRunHaltError("lease_lost");
        }
        throw error;
      }
      if (begun.replay) return begun.result;
      const result = await execute(input, callOptions);
      try {
        await options.journal.finishCall({
          runId: options.runId,
          token: options.token,
          callId,
          result: result ?? null,
        });
      } catch (error) {
        if (error instanceof StaleLeaseError) {
          options.halt("lease_lost");
          throw new EventRunHaltError("lease_lost");
        }
        throw error;
      }
      return result;
    };
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface RunCheckpointer {
  /** A real conversation state (resume, a hosted step, the end of the turn). */
  checkpoint(messages: ModelMessage[], step: number): Promise<void>;
  /** Resolves once a written checkpoint names `intent.toolCallId`. */
  ensureDurable(intent: EventRunToolIntent): Promise<void>;
  /** Rewrites the current state (lease renewal). */
  heartbeat(): Promise<void>;
}

/**
 * The run's durable state, written through ONE queue so no write lands behind
 * an older one: a heartbeat can never overwrite a newer intent.
 *
 * `base` is the last real conversation; `intents` are tool calls made since
 * that `base` does not hold yet (the direct engine has no per-step hook).
 * The stored checkpoint is `base` plus one assistant message naming those
 * calls, so a run resumed after a crash finds them unresolved and finishes
 * them through the journal: a completed one replays its recorded result, an
 * unfinished one parks the run. Neither repeats the effect.
 */
export function createRunCheckpointer(args: {
  write: (state: { messages: ModelMessage[]; step: number }) => Promise<void>;
  messages: ModelMessage[];
  step: number;
  /** True when `messages` is already what the backend holds (a resume). */
  stored: boolean;
}): RunCheckpointer {
  let base = args.messages;
  let step = args.step;
  let intents: EventRunToolIntent[] = [];
  let written = args.stored ? toolCallIdsIn(base) : new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const state = () => ({
    messages:
      intents.length === 0
        ? base
        : [
            ...base,
            {
              role: "assistant",
              content: intents.map((intent) => ({
                type: "tool-call",
                toolCallId: intent.toolCallId,
                toolName: intent.toolName,
                input: intent.input,
              })),
            } as ModelMessage,
          ],
    step,
  });

  const enqueue = (change?: () => void): Promise<void> => {
    const run = queue.then(async () => {
      change?.();
      const next = state();
      await args.write(next);
      written = toolCallIdsIn(next.messages);
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    checkpoint(messages, nextStep) {
      return enqueue(() => {
        base = messages;
        step = Math.max(step, nextStep);
        const held = toolCallIdsIn(messages);
        intents = intents.filter((intent) => !held.has(intent.toolCallId));
      });
    },
    async ensureDurable(intent) {
      if (written.has(intent.toolCallId)) return;
      await enqueue(() => {
        const held = toolCallIdsIn(base);
        if (
          !held.has(intent.toolCallId) &&
          !intents.some((known) => known.toolCallId === intent.toolCallId)
        )
          intents = [...intents, intent];
      });
    },
    heartbeat: () => enqueue(),
  };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function toolResultOk(output: unknown): boolean {
  if (!output || typeof output !== "object") return true;
  const typed = output as { type?: unknown; value?: unknown };
  if (typeof typed.type === "string") {
    if (typed.type.startsWith("error") || typed.type === "execution-denied") {
      return false;
    }
    const value = typed.value as { isError?: unknown } | undefined;
    if (value && typeof value === "object" && value.isError === true) return false;
    return true;
  }
  return (output as { isError?: unknown }).isError !== true;
}

function textOf(message: ModelMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("");
}

export interface EventRunResultSummary {
  text: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  steps: number;
}

export function summarizeEventRun(result: {
  newMessages: ModelMessage[];
  toolCalls: Array<{ toolCallId: string; toolName: string }>;
  toolResults: Array<{ toolCallId: string; output: unknown }>;
}): EventRunResultSummary {
  const assistants = result.newMessages.filter((message) => message.role === "assistant");
  const lastText = [...assistants].reverse().map(textOf).find((text) => text.trim()) ?? "";
  const outputs = new Map(result.toolResults.map((entry) => [entry.toolCallId, entry.output]));
  return {
    text:
      lastText.length > MAX_RESULT_TEXT_CHARS
        ? `${lastText.slice(0, MAX_RESULT_TEXT_CHARS)}…`
        : lastText,
    toolCalls: result.toolCalls.map((call) => ({
      name: call.toolName,
      ok: outputs.has(call.toolCallId) ? toolResultOk(outputs.get(call.toolCallId)) : false,
    })),
    steps: assistants.length,
  };
}

export function isSpendRefusal(event: {
  code?: string;
  refusalReason?: string;
} | undefined): boolean {
  if (!event?.code) return false;
  return (
    SPEND_REFUSAL_CODES.has(event.code) ||
    isTransientSpendRefusal(event.code, event.refusalReason)
  );
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface EventRunConnection {
  manager: MCPClientManager;
  close(): Promise<void>;
}

export interface EventExecutorDeps {
  backend: Pick<
    EventsBackendClient,
    "claimRun" | "checkpointRun" | "beginCall" | "finishCall" | "finishRun"
  >;
  getBearer?: (ownerExternalId: string, organizationId: string) => Promise<string>;
  /** Which servers the run connects (C6). Default: environment → subscription. */
  resolveServers?: (args: {
    claim: EventRunClaim;
    input: EventRunInput;
    bearer: string;
  }) => Promise<{ serverIds: string[]; serverNames?: string[]; environmentModelId?: string }>;
  connect?: (args: {
    projectId: string;
    bearer: string;
    serverIds: string[];
    serverNames?: string[];
  }) => Promise<EventRunConnection>;
  resolveModel?: (args: {
    modelId: string;
    projectId: string;
    bearer: string;
  }) => Promise<ModelDefinition>;
  /**
   * Default: `resolveTurnRuntime` with `sourceType: "event"`, attributing the
   * turn's model usage to `runId` (the backend charges the trigger's spend
   * cap from those usage records).
   */
  resolveRuntime?: (args: {
    modelDefinition: ModelDefinition;
    projectId: string;
    authHeader: string;
    runId: string;
    chatSessionId: string;
    tools: ToolSet;
    messages: ModelMessage[];
  }) => Promise<{ runtime: any; modelSource?: SyntheticModelSource }>;
  /**
   * Where each run's turn is appended (one chat thread per trigger). `false`
   * disables it. Default: `/ingest-chat` via `persistChatSessionToConvex`.
   */
  transcript?: TranscriptPort | false;
  runTurn?: (options: any) => Promise<any>;
  prepareChat?: (options: any) => Promise<{
    allTools: ToolSet;
    enhancedSystemPrompt: string;
    progressivePlan?: unknown;
    discoveryState?: unknown;
  }>;
}

async function defaultResolveServers(args: {
  claim: EventRunClaim;
  input: EventRunInput;
  bearer: string;
}): Promise<{ serverIds: string[]; serverNames?: string[]; environmentModelId?: string }> {
  const environmentId =
    args.input.trigger.environmentId ?? args.input.subscription.environmentId ?? null;
  if (!environmentId) return { serverIds: [args.input.subscription.serverId] };
  const [
    { createConvexClient },
    {
      EVAL_LAUNCH_SERVER_SOURCE,
      environmentServerIds,
      environmentServerNames,
      resolveEnvironmentForLaunch,
    },
  ] = await Promise.all([
    import("../evals/route-helpers.js"),
    import("../environments/resolve.js"),
  ]);
  // The environment's closed server set and nothing else — the same rule an
  // eval launch applies, for the same reason: the run must be what the
  // environment says it is.
  const resolved = await resolveEnvironmentForLaunch(createConvexClient(args.bearer), {
    projectId: String(args.claim.run.projectId),
    environmentId,
    serverSource: EVAL_LAUNCH_SERVER_SOURCE,
  });
  return {
    serverIds: environmentServerIds(resolved),
    serverNames: environmentServerNames(resolved),
    ...(resolved.effectiveModelId ? { environmentModelId: resolved.effectiveModelId } : {}),
  };
}

async function defaultConnect(args: {
  projectId: string;
  bearer: string;
  serverIds: string[];
  serverNames?: string[];
}): Promise<EventRunConnection> {
  const { createAuthorizedManager } = await import("../../routes/web/auth.js");
  const { manager } = await createAuthorizedManager(
    {},
    args.bearer,
    args.projectId,
    args.serverIds,
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    args.serverNames && args.serverNames.length > 0
      ? { serverNames: args.serverNames }
      : undefined,
  );
  return {
    manager,
    close: () => manager.disconnectAllServers().catch(() => undefined),
  };
}

async function defaultResolveModel(args: {
  modelId: string;
  projectId: string;
  bearer: string;
}): Promise<ModelDefinition> {
  const { resolveHostModelDefinition } = await import("../../utils/org-model-config.js");
  return resolveHostModelDefinition({
    modelId: args.modelId,
    projectId: args.projectId,
    auth: { bearerToken: args.bearer },
  });
}

async function defaultResolveRuntime(args: {
  modelDefinition: ModelDefinition;
  projectId: string;
  authHeader: string;
  runId: string;
  chatSessionId: string;
  tools: ToolSet;
  messages: ModelMessage[];
}) {
  const { resolveTurnRuntime } = await import("../../utils/resolve-turn-runtime.js");
  return resolveTurnRuntime({
    modelDefinition: args.modelDefinition,
    projectId: args.projectId,
    authHeader: args.authHeader,
    sourceType: "event",
    // Every billed model call names the run, on the hosted `/stream` body and
    // on the local-runtime usage writeback alike: the backend charges the
    // trigger's daily spend cap from those usage records (C6).
    extraBodyFields: { eventRunId: args.runId },
    attribution: { eventRunId: args.runId },
    chatSessionId: args.chatSessionId,
    tools: args.tools,
    messages: args.messages,
  });
}

async function defaultGetBearer(ownerExternalId: string, organizationId: string) {
  const { getConvexBearerForDelegation } = await import("../../utils/v1-convex-token.js");
  return getConvexBearerForDelegation(ownerExternalId, organizationId);
}

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
    connection = await (deps.connect ?? defaultConnect)({
      projectId,
      bearer,
      serverIds: servers.serverIds,
      ...(servers.serverNames ? { serverNames: servers.serverNames } : {}),
    });
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
    const prepareChat =
      deps.prepareChat ??
      (async (options: any) =>
        (await import("../../utils/chat-v2-orchestration.js")).prepareChatV2(options));
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
    const hosted = rt.runtime?.kind === "hosted";
    const runTurn =
      deps.runTurn ??
      (async (options: any) =>
        (await import("../../utils/turn-execution.js")).runUnifiedAssistantTurn(options));
    const common = {
      runtime: rt.runtime,
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
        : common,
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
    if (connection) await connection.close().catch(() => undefined);
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
