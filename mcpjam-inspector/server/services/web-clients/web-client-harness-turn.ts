import { inspectorDiscoveryRunMetadata } from "../../utils/discovery-run-metadata";
/**
 * A web client turn in the shape every harness turn returns, so the
 * Playground, evals, swarms and compare run it through the lifecycle they
 * already have: `runHarnessTurn` hands a web runtime's turn here first.
 *
 * Success adds the vendor's reply and the wire's tool calls to the
 * transcript and persists a turn trace with the forwarded route's receipt. A
 * page that could not be driven throws `WebClientRunError`, which every
 * caller already treats as a failed turn: the run failed, and nothing was
 * learned about the server. It still carries the calls that reached the
 * server first. A setting the vendor's app can't honor throws
 * `WebClientTurnRefusedError` before anything runs.
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { approvalAnswerOf } from "@/shared/tool-approval";
import {
  WEB_CLIENT_DISPLAY_NAMES,
  webClientVendorForRuntime,
  type WebClientRuntimeId,
} from "@/shared/web-clients";
import type { PersistedTurnTrace } from "../../utils/chat-ingestion.js";
import type { InfraFailureEvidence } from "../../utils/infra-failure-evidence.js";
import { writeTraceEvent } from "../../utils/live-chat-trace-stream.js";
import { buildHarnessMcpAtTurn } from "../../utils/harness/harness-mcp-receipt.js";
import { resolveHarnessMcpPlan } from "../../utils/harness/harness-mcp-plan.js";
import {
  harnessSystemPromptRefusalReason,
  type HarnessUnavailableKind,
} from "../../utils/harness/harness-availability.js";
import type { HarnessPolicyBlockRecord } from "../../utils/harness/harness-proxy-policy-enforcement.js";
import { harnessToolApprovalRefusalReason } from "../../utils/harness/harness-tool-approval.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import type { RealUiFailure } from "../../utils/harness/real-ui/page-module.js";
import {
  createUiChunkProvenanceSigner,
  historyProvenanceContextFor,
} from "../../utils/history-provenance.js";
import type {
  ChatEngineLoopResult,
  MCPJamHandlerOptions,
} from "../../utils/mcpjam-stream-handler.js";
import { runWebClientTurn } from "./run-web-client-turn.js";
import { webClientEnvironmentFor } from "./web-client-environment.js";
import { WebAccountUnavailableError, rotateRunAccounts } from "./web-client-run.js";
import { webTurnMessages, webTurnSpans } from "./web-client-trace.js";
import {
  ambiguousExecutionMessage,
  runRecoverableWebTurn,
  webRecovery,
  type RecoverableWebTurnResult,
  type WebRunStop,
  type WebTurnPauseListener,
} from "./recovery/turn-recovery.js";

/** A run that stopped on the vendor's page. Never a server failure. */
export class WebClientRunError extends Error {
  readonly infrastructure = true;
  constructor(
    readonly failure: RealUiFailure,
    message: string,
    /** Set when recovery paused the run for a person, or found a call that may have run. */
    readonly stop?: WebRunStop,
    /** The calls that reached the server before the page stopped, on an errored step. */
    readonly turnTrace?: PersistedTurnTrace,
  ) {
    super(message);
    this.name = "WebClientRunError";
  }
}

/** The stop as structured evidence, for the eval infra classifier. */
export function webClientFailureEvidenceOf(
  error: unknown,
): InfraFailureEvidence | undefined {
  if (!(error instanceof WebClientRunError)) return undefined;
  return { source: "web_client", code: error.failure.kind };
}

/** What a person reads when the run stopped, and what fixes it. */
export function webClientFailureMessage(name: string, failure: RealUiFailure): string {
  switch (failure.kind) {
    case "needs_sign_in":
      return `${name} needs sign-in. ${failure.message} Sign in again, then send again.`;
    case "plan_limit":
      return `${failure.message} The server was not graded.`;
    case "send_ambiguous":
      return `${failure.message} Open the chat in ${name} to see whether it ran.`;
    case "turn_running":
      return `${failure.message} Wait for it to finish, then send again.`;
    default:
      return `${name} stopped before the reply finished. ${failure.message} The server was not graded; retry the run.`;
  }
}

const lastUserMessage = (messages: readonly ModelMessage[]) =>
  [...messages].reverse().find((message) => message.role === "user");

function lastUserText(messages: readonly ModelMessage[]): string {
  const last = lastUserMessage(messages);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

/**
 * A turn refused before its page is driven, for a setting the vendor's app
 * can't honor. `kind` is the one the preflight refuses the same setting with.
 */
export class WebClientTurnRefusedError extends Error {
  constructor(
    readonly kind: Extract<HarnessUnavailableKind, "tool-approval" | "setting-unsupported">,
    message: string,
  ) {
    super(message);
    this.name = "WebClientTurnRefusedError";
  }
}

/**
 * The app runs its own tools where nothing can pause them, so a turn that
 * asks for approval is refused whole by the gate every runtime passes, never
 * denied call by call. It has no place for a host's system prompt either:
 * typed into the user's message it would change the chat being measured.
 * Only the message's text is typed, so a file or image would be dropped.
 */
function refuseUnsupportedSettings(runtimeId: WebClientRuntimeId, options: MCPJamHandlerOptions): void {
  const adapter = getHarnessAdapter(runtimeId);
  const approvalRefusal = harnessToolApprovalRefusalReason({
    adapter,
    mcpClient: "harness",
    requireToolApproval: options.requireToolApproval === true,
    hasSelectedMcpServers: (options.selectedServers?.length ?? 0) > 0,
  });
  if (approvalRefusal) throw new WebClientTurnRefusedError("tool-approval", approvalRefusal);
  const promptRefusal = harnessSystemPromptRefusalReason({
    adapter,
    systemPrompt: options.systemPrompt,
  });
  if (promptRefusal)
    throw new WebClientTurnRefusedError("setting-unsupported", promptRefusal);
  const latest = lastUserMessage(options.messages);
  if (latest && typeof latest.content !== "string" && latest.content.some((part) => part.type !== "text")) {
    throw new WebClientTurnRefusedError(
      "setting-unsupported",
      `${adapter.displayName} can only send text to ${HARNESS_DESCRIPTORS[runtimeId].runtimeName}, so it can't take attachments. Remove the attachment or choose another client.`,
    );
  }
}

export async function runWebClientHarnessTurn(
  options: MCPJamHandlerOptions,
  streamSink: "ui" | "none",
): Promise<ChatEngineLoopResult> {
  const runtimeId = options.harness;
  const vendor = webClientVendorForRuntime(runtimeId);
  if (!runtimeId || !vendor || (runtimeId !== "claude-web" && runtimeId !== "chatgpt-web")) {
    throw new Error("This turn is not a web client turn.");
  }
  refuseUnsupportedSettings(runtimeId, options);
  const name = WEB_CLIENT_DISPLAY_NAMES[vendor];
  if (!options.projectId) {
    throw new Error(`${name} runs on a project's web account. Open a project, then send again.`);
  }
  const runId = options.evalIterationId ?? options.chatSessionId ?? options.journeyRunId ?? "playground";
  const runContext = options.webClientRun;
  const environment = await webClientEnvironmentFor({
    runtimeId,
    projectId: options.projectId,
    runId,
    ...(options.evalIterationId ? { iterationId: options.evalIterationId } : {}),
    ...(options.chatSessionId ? { chatSessionId: options.chatSessionId } : {}),
    ...(options.authHeader ? { bearer: options.authHeader } : {}),
    mcpClientManager: options.mcpClientManager,
    ...(runContext?.actor ? { actor: runContext.actor } : {}),
    ...(runContext?.webAccountIds
      ? {
          runWebAccountIds: rotateRunAccounts({
            runId: runContext.runId,
            ...(options.evalIterationId ? { iterationId: options.evalIterationId } : {}),
            webAccountIds: runContext.webAccountIds,
          }),
        }
      : {}),
  });
  if (!environment) {
    throw new Error(`${name} isn't set up on this server. Ask an admin to turn on web clients, then send again.`);
  }
  const messages = options.messages;
  const promptIndex = Math.max(0, messages.filter((m) => m.role === "user").length - 1);
  const run = async (
    onPaused?: WebTurnPauseListener,
  ): Promise<ChatEngineLoopResult> => {
    const turn = {
      runtimeId,
      projectId: options.projectId!,
      serverIds: options.selectedServers ?? [],
      prompt: lastUserText(messages),
      runId,
      ...(options.evalIterationId ? { iterationId: options.evalIterationId } : {}),
      approval: {
        requireToolApproval: options.requireToolApproval === true,
        answer: approvalAnswerOf(options.approvalMode),
      },
      // Accounted where the other runtimes' blocks are (`onHarnessPolicyBlocks`).
      ...(options.harnessToolPolicy
        ? {
            toolPolicy: {
              snapshots: options.harnessToolPolicy,
              onBlock: (block: HarnessPolicyBlockRecord) => options.onHarnessPolicyBlocks?.([block]),
            },
          }
        : {}),
      environment,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    };
    const recovery = webRecovery();
    let result: RecoverableWebTurnResult;
    try {
      result = recovery
        ? await runRecoverableWebTurn(turn, recovery, onPaused)
        : await runWebClientTurn(turn);
    } catch (error) {
      // The run's account is gone, so the run's pool stops handing it out.
      if (error instanceof WebAccountUnavailableError) runContext?.onAccountLost?.(error.message);
      // A Stop while the turn still waited its turn, before any page was
      // driven, ends it as the person's too, like a Stop on the page below.
      if (options.abortSignal?.aborted)
        return { messageHistory: messages, aborted: true };
      throw error;
    }
    const traceOf = (failed: boolean): PersistedTurnTrace => ({
      ...inspectorDiscoveryRunMetadata(undefined, true),
      turnId: result.turnId,
      promptIndex,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      spans: webTurnSpans({
        calls: result.toolCalls,
        turnId: result.turnId,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        promptIndex,
        modelId: options.modelId,
        failed,
      }),
      finishReason: failed ? "error" : "stop",
      modelId: options.modelId,
    });
    // A Stop ends the turn as the person's, whatever the page was doing.
    if (!result.ok && options.abortSignal?.aborted) return { messageHistory: messages, aborted: true };
    if (!result.ok) {
      const message =
        result.stop?.kind === "ambiguous_execution"
          ? ambiguousExecutionMessage(name, result.stop)
          : webClientFailureMessage(name, result.failure);
      // A signed-out account can't serve the run's later sessions either.
      if (result.failure.kind === "needs_sign_in") runContext?.onAccountLost?.(message);
      // What reached the server stays on the record; the run still failed.
      throw new WebClientRunError(result.failure, message, result.stop, traceOf(true));
    }
    const adapter = getHarnessAdapter(runtimeId);
    const plan = resolveHarnessMcpPlan({
      dispatch: { mcpClient: "harness" },
      forwardingRuntime: undefined,
      forwardingOrganization: true,
      accountRouting: false,
      forwardingEnabled: true,
      plane: undefined,
      selectedServerCount: options.selectedServers?.length ?? 0,
      localExecution: false,
      webConnector: true,
      admit: () => ({ gaps: [] }),
    });
    const harnessMcpAtTurn = buildHarnessMcpAtTurn({
      plan,
      // The vendor's own client did the handshake, so no profile of MCPJam's
      // is digested; the page module's version is the adapter's.
      connection: {
        plane: "web-authorized",
        serverCount: options.selectedServers?.length ?? 0,
        profileDigest: () => "",
      },
      pinnedRuntimeVersion: adapter.pinnedRuntimeVersion,
      observedRuntimeVersion: undefined,
      adapterVersion: adapter.pinnedRuntimeVersion,
      requireNativeToolDiscovery: false,
    });
    const turnTrace: PersistedTurnTrace = {
      ...inspectorDiscoveryRunMetadata(undefined, true),
      ...traceOf(false),
      ...(harnessMcpAtTurn ? { harnessMcpAtTurn } : {}),
    };
    const messageHistory = [
      ...messages,
      ...webTurnMessages(result.page.conversation, result.toolCalls, result.turnId),
    ];
    await options.onConversationComplete?.(messageHistory, turnTrace);
    return { messageHistory, turnTrace, aborted: false };
  };

  if (streamSink === "none") return run();
  // The reply is signed as this server's own as it streams (MJ-009), as every
  // engine's is, so it stays in model context when the conversation goes on
  // with another client. A no-op where nothing can be signed.
  const provenance = historyProvenanceContextFor(
    options.projectId,
    options.chatSessionId,
  );
  const signChunk = provenance && createUiChunkProvenanceSigner(provenance);
  let settled: ChatEngineLoopResult = { messageHistory: messages, aborted: false };
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // The pause panel's data: who can finish signing in, and the request.
      settled = await run((paused, turnId) => {
        writer.write({ type: "data-web-run-paused", data: { ...paused, clientName: name } });
        const interval = options.heartbeatIntervalMs ?? 15_000;
        if (!Number.isFinite(interval) || interval < 1) return;
        const timer = setInterval(() => {
          writeTraceEvent(writer, { type: "heartbeat", turnId, promptIndex });
        }, interval);
        return () => clearInterval(timer);
      });
      if (settled.aborted) return;
      const reply = settled.messageHistory.at(-1);
      const text =
        reply && Array.isArray(reply.content)
          ? reply.content.map((part) => (part.type === "text" ? part.text : "")).join("")
          : "";
      writer.write({ type: "text-start", id: "web-reply" });
      writer.write({ type: "text-delta", id: "web-reply", delta: text });
      writer.write({ type: "text-end", id: "web-reply" });
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return {
    get messageHistory() {
      return settled.messageHistory;
    },
    get turnTrace() {
      return settled.turnTrace;
    },
    aborted: false,
    response: createUIMessageStreamResponse({
      stream: signChunk
        ? stream.pipeThrough(
            new TransformStream<UIMessageChunk, UIMessageChunk>({
              transform(chunk, controller) {
                for (const out of signChunk(chunk)) controller.enqueue(out);
              },
            }),
          )
        : stream,
    }),
  };
}
