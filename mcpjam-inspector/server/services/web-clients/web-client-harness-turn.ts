/**
 * A web client turn in the shape every harness turn returns, so the
 * Playground, evals, swarms and compare run it through the lifecycle they
 * already have: `runHarnessTurn` hands a web runtime's turn here first.
 *
 * Success adds the vendor's reply and the wire's tool calls to the
 * transcript and persists a turn trace with the forwarded route's receipt. A
 * page that could not be driven throws `WebClientRunError`, which every
 * caller already treats as a failed turn: the run failed, and nothing was
 * learned about the server.
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
} from "ai";
import { approvalAnswerOf } from "@/shared/tool-approval";
import {
  WEB_CLIENT_DISPLAY_NAMES,
  webClientVendorForRuntime,
} from "@/shared/web-clients";
import type { PersistedTurnTrace } from "../../utils/chat-ingestion.js";
import { buildHarnessMcpAtTurn } from "../../utils/harness/harness-mcp-receipt.js";
import { resolveHarnessMcpPlan } from "../../utils/harness/harness-mcp-plan.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import type { RealUiFailure } from "../../utils/harness/real-ui/page-module.js";
import type {
  ChatEngineLoopResult,
  MCPJamHandlerOptions,
} from "../../utils/mcpjam-stream-handler.js";
import { runWebClientTurn } from "./run-web-client-turn.js";
import { webClientEnvironmentFor } from "./web-client-environment.js";
import { rotateRunAccounts } from "./web-client-run.js";
import { webTurnMessages, webTurnSpans } from "./web-client-trace.js";

/** A run that stopped on the vendor's page. Never a server failure. */
export class WebClientRunError extends Error {
  readonly infrastructure = true;
  constructor(
    readonly failure: RealUiFailure,
    message: string,
  ) {
    super(message);
    this.name = "WebClientRunError";
  }
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

function lastUserText(messages: readonly ModelMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
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
  const name = WEB_CLIENT_DISPLAY_NAMES[vendor];
  if (!options.projectId) {
    throw new Error(`${name} runs on a project's web account. Open a project, then send again.`);
  }
  const runId = options.evalIterationId ?? options.chatSessionId ?? options.journeyRunId ?? "playground";
  const evalRun = options.webClientRun;
  const environment = await webClientEnvironmentFor({
    runtimeId,
    projectId: options.projectId,
    runId,
    ...(options.evalIterationId ? { iterationId: options.evalIterationId } : {}),
    ...(options.chatSessionId ? { chatSessionId: options.chatSessionId } : {}),
    ...(options.authHeader ? { bearer: options.authHeader } : {}),
    ...(evalRun?.actor ? { actor: evalRun.actor } : {}),
    ...(evalRun?.webAccountIds
      ? { runWebAccountIds: rotateRunAccounts(evalRun.runId, evalRun.webAccountIds) }
      : {}),
  });
  if (!environment) {
    throw new Error(`${name} isn't set up on this server. Ask an admin to turn on web clients, then send again.`);
  }
  const messages = options.messages;
  const promptIndex = Math.max(0, messages.filter((m) => m.role === "user").length - 1);
  const run = async (): Promise<ChatEngineLoopResult> => {
    const result = await runWebClientTurn({
      runtimeId,
      projectId: options.projectId!,
      serverIds: options.selectedServers ?? [],
      prompt: lastUserText(messages),
      runId,
      approval: {
        requireToolApproval: options.requireToolApproval === true,
        answer: approvalAnswerOf(options.approvalMode),
      },
      environment,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    if (!result.ok) {
      throw new WebClientRunError(result.failure, webClientFailureMessage(name, result.failure));
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
      turnId: result.turnId,
      promptIndex,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      spans: webTurnSpans({
        calls: result.toolCalls,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        promptIndex,
        modelId: options.modelId,
      }),
      finishReason: "stop",
      modelId: options.modelId,
      ...(harnessMcpAtTurn ? { harnessMcpAtTurn } : {}),
    };
    const messageHistory = [
      ...messages,
      ...webTurnMessages(result.page.conversation, result.toolCalls),
    ];
    await options.onConversationComplete?.(messageHistory, turnTrace);
    return { messageHistory, turnTrace, aborted: false };
  };

  if (streamSink === "none") return run();
  let settled: ChatEngineLoopResult = { messageHistory: messages, aborted: false };
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      settled = await run();
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
    response: createUIMessageStreamResponse({ stream }),
  };
}
