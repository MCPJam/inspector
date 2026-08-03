/**
 * SDK canary for `ui_ask_user` — runs against the REAL `ai` / `@ai-sdk/react`
 * packages (scripted transport, no HTTP). Sibling of
 * `webmcp-approval-sdk-ordering.test.tsx`.
 *
 * Two SDK behaviors that the ask-user design DEPENDS on, neither of which is
 * documented, both of which an `ai` upgrade could silently flip. They were
 * established by measurement (an earlier comment in `agent-chat-instances.ts`
 * asserted the OPPOSITE of #1 and was wrong), so they are pinned here rather
 * than believed:
 *
 *   1. While a client-fulfilled tool call is parked — `onToolCall` awaited,
 *      no output yet — `chat.status` stays `"streaming"`, NOT `"ready"`.
 *      The agent's instance eviction has to special-case parked sessions
 *      because of this; if the SDK ever reaches `ready` here, that
 *      special-casing becomes dead weight and this test says so.
 *
 *   2. Supplying a DISMISSED ask-user result does NOT resume the turn. The
 *      result must still be recorded (a dangling tool call is an invalid
 *      message history for Anthropic and OpenAI), but abandonment is not a
 *      prompt — a user who pressed Stop must not get an answer to the
 *      question they walked away from. `shouldAutoResumeTurn` enforces this;
 *      the canary proves the enforcement reaches the real SDK loop.
 */
import { describe, expect, it, vi } from "vitest";

import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import { shouldAutoResumeTurn } from "@/lib/chat-auto-resume";
import {
  __resetUiToolExecutorForTests,
  handleUiToolCall,
} from "@/lib/webmcp/ui-tool-executor";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "@/lib/webmcp/ui-tools-registry";
import {
  ASK_USER_TOOL_NAME,
  dismissAskUserQuestions,
  registerAskUserQuestion,
  __resetAskUserStoreForTests,
} from "@/lib/webmcp/ask-user-store";
import { waitForTerminalToolParts } from "@/lib/webmcp/wait-for-tool-output";

const TOOL_CALL_ID = "tc-ask-canary";

function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** The model asks a clarifying question; the server pauses for the browser. */
const ASK_TURN: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: TOOL_CALL_ID,
    toolName: ASK_USER_TOOL_NAME,
    input: { question: "Which one?", options: [] },
    dynamic: true,
  },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

const TEXT_TURN: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "ok." },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
] as UIMessageChunk[];

const settleMacrotasks = (ms = 80) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parks `execute` until the returned release fn supplies `answer`. */
function setupParkedAsk(answerPayload: unknown) {
  __resetUiToolExecutorForTests();
  useUiToolsRegistry.setState({ tools: new Map(), shippedNames: new Set() });

  let release: (() => void) | null = null;
  const def: UiToolDefinition = {
    name: ASK_USER_TOOL_NAME,
    description: "Ask the user",
    readOnly: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              content: [
                { type: "text", text: JSON.stringify(answerPayload) },
              ],
            });
        }),
    ),
  };
  useUiToolsRegistry.getState().registerUiTool(def);

  const requests: string[] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async () => {
      requests.push("request");
      return chunkStream(requests.length === 1 ? ASK_TURN : TEXT_TURN);
    },
    reconnectToStream: async () => null,
  };

  const chat = new Chat<UIMessage>({
    id: `ask-canary-${requests.length}`,
    transport,
    onToolCall: async ({ toolCall }) => {
      await handleUiToolCall({
        toolName: (toolCall as { toolName: string }).toolName,
        toolCallId: (toolCall as { toolCallId: string }).toolCallId,
        input: (toolCall as { input: unknown }).input,
        addToolOutput: (output) => chat.addToolOutput(output),
        telemetryScope: "ask-canary",
      });
    },
    sendAutomaticallyWhen: shouldAutoResumeTurn,
  });

  return { chat, requests, release: () => release?.() };
}

describe("ui_ask_user — SDK canary (real ai package)", () => {
  it("PIN #1: a parked question keeps the chat 'streaming', never 'ready'", async () => {
    const { chat } = setupParkedAsk({ ok: true, data: { kind: "selected" } });

    void chat.sendMessage({ parts: [{ type: "text", text: "hi" }] });
    await settleMacrotasks();

    // If this ever reads "ready", `evictIdleInstances` no longer needs its
    // parked-session special case — and the comment there is stale.
    expect(chat.status).toBe("streaming");
  });

  it("PIN #2: a DISMISSED answer is recorded but does NOT resume the turn", async () => {
    const { chat, requests, release } = setupParkedAsk({
      ok: true,
      data: { kind: "dismissed" },
    });

    void chat.sendMessage({ parts: [{ type: "text", text: "hi" }] });
    await settleMacrotasks();
    expect(requests).toHaveLength(1);

    release();
    await settleMacrotasks(150);

    // Recorded: the tool part is terminal, so the message history stays valid
    // for the next request (a dangling tool call would 400 both providers).
    // `dynamic: true` on the chunk means the part is a `dynamic-tool`, so
    // match on the call id rather than the type prefix.
    const toolPart = chat.messages
      .at(-1)
      ?.parts.find(
        (p) => (p as { toolCallId?: string }).toolCallId === TOOL_CALL_ID,
      ) as { state?: string } | undefined;
    expect(toolPart?.state).toBe("output-available");

    // NOT generated from: no second request, so the model never answers the
    // question the user walked away from.
    expect(requests).toHaveLength(1);
  });

  it("PIN #3: the message after a dismissal carries no unresolved tool call", async () => {
    // Settling only resolves the parked promise — `execute` returns on a later
    // microtask and the executor writes the output after that. Sending
    // synchronously snapshots the assistant message with the tool part still
    // `input-available`: a tool call with no result, which both Anthropic and
    // OpenAI reject. `submit()` therefore waits for the terminal part first,
    // and this pins that the wait is actually sufficient against the real SDK.
    __resetAskUserStoreForTests();
    __resetUiToolExecutorForTests();
    useUiToolsRegistry.setState({ tools: new Map(), shippedNames: new Set() });

    const def: UiToolDefinition = {
      name: ASK_USER_TOOL_NAME,
      description: "Ask the user",
      readOnly: true,
      execute: async (_args, ctx) => {
        const answer = await registerAskUserQuestion({
          toolCallId: ctx!.toolCallId,
          question: "Which one?",
          options: [
            { label: "Local", value: "local" },
            { label: "Remote", value: "remote" },
          ],
          scope: "pin3",
        });
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, data: answer }) },
          ],
        };
      },
    };
    useUiToolsRegistry.getState().registerUiTool(def);

    const requestToolStates: string[][] = [];
    let turn = 0;
    const transport: ChatTransport<UIMessage> = {
      sendMessages: async (options) => {
        requestToolStates.push(
          (options.messages as UIMessage[]).flatMap((m) =>
            m.parts
              .filter((part) => (part as { toolCallId?: string }).toolCallId)
              .map((part) => String((part as { state?: string }).state)),
          ),
        );
        turn += 1;
        return chunkStream(turn === 1 ? ASK_TURN : TEXT_TURN);
      },
      reconnectToStream: async () => null,
    };

    const chat = new Chat<UIMessage>({
      id: "ask-canary-pin3",
      transport,
      onToolCall: async ({ toolCall }) => {
        await handleUiToolCall({
          toolName: (toolCall as { toolName: string }).toolName,
          toolCallId: (toolCall as { toolCallId: string }).toolCallId,
          input: (toolCall as { input: unknown }).input,
          addToolOutput: (output) => chat.addToolOutput(output),
          telemetryScope: "pin3",
        });
      },
      sendAutomaticallyWhen: shouldAutoResumeTurn,
    });

    void chat.sendMessage({ parts: [{ type: "text", text: "hi" }] });
    await settleMacrotasks();

    // Exactly what `submit()` does: dismiss, WAIT for the output, then send.
    const dismissed = dismissAskUserQuestions("new_message", { scope: "pin3" });
    expect(dismissed).toHaveLength(1);
    await waitForTerminalToolParts(() => chat.messages, dismissed);
    void chat.sendMessage({ parts: [{ type: "text", text: "new topic" }] });
    await settleMacrotasks(150);

    expect(requestToolStates).toHaveLength(2);
    // Every tool part in the follow-up request is terminal. Without the wait
    // this array contains "input-available" and the provider 400s.
    for (const state of requestToolStates[1]!) {
      expect(state).toMatch(/^output-/);
    }
  });

  it("an ANSWERED question still resumes the turn", async () => {
    // The counterweight to PIN #2 — the suppression must be specific to
    // dismissal, or answering a question would strand the turn instead.
    const { chat, requests, release } = setupParkedAsk({
      ok: true,
      data: { kind: "selected", value: "local", label: "Local" },
    });

    void chat.sendMessage({ parts: [{ type: "text", text: "hi" }] });
    await settleMacrotasks();
    release();
    await settleMacrotasks(150);

    expect(requests).toHaveLength(2);
  });
});
