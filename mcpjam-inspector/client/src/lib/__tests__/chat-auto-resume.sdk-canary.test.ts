/**
 * SDK canary for the bounded auto-resume — the REAL `ai` / `@ai-sdk/react`
 * `Chat` against a scripted transport (no HTTP).
 *
 * It replays the runaway: a turn reaches its step ceiling on a step whose tool
 * call the server ran and settled, so the SDK reads the step as complete. The
 * server, able to take no further step, answers every resume with an empty
 * `length` finish that adds nothing to the message — so the SDK's
 * post-request check sees the same "complete" step and sends again.
 *
 * Pinned against the real SDK because the whole failure lives in two of its
 * undocumented behaviours: it re-asks `sendAutomaticallyWhen` after EVERY
 * finished request, and it hands the finish reason only to `onFinish`, which
 * it calls before that re-ask.
 */
import { describe, expect, it } from "vitest";

import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import { shouldAutoResumeTurn } from "@/lib/chat-auto-resume";

function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** The last step the ceiling allowed: a docs search the server ran. */
const LAST_ALLOWED_STEP: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: "tc-docs",
    toolName: "search_mcpjam",
    input: { query: "evals" },
  },
  {
    type: "tool-output-available",
    toolCallId: "tc-docs",
    output: { content: [] },
  },
  { type: "finish-step" },
  { type: "finish", finishReason: "length" },
] as UIMessageChunk[];

/** What the server answered every resume with once the budget was spent. */
const EMPTY_LENGTH_FINISH: UIMessageChunk[] = [
  { type: "finish", finishReason: "length" },
] as UIMessageChunk[];

/** Stops the runaway variant from spinning forever inside the test. */
const REQUEST_CEILING = 6;

const settleMacrotasks = (ms = 80) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function scriptedTransport(requests: { count: number }) {
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async () => {
      requests.count += 1;
      if (requests.count > REQUEST_CEILING) {
        throw new Error("request ceiling reached");
      }
      return chunkStream(
        requests.count === 1 ? LAST_ALLOWED_STEP : EMPTY_LENGTH_FINISH,
      );
    },
    reconnectToStream: async () => null,
  };
  return transport;
}

describe("bounded auto-resume — SDK canary (real ai package)", () => {
  it("PIN: an unbounded predicate re-posts a no-progress turn until something breaks", async () => {
    const requests = { count: 0 };
    const chat = new Chat<UIMessage>({
      id: "resume-canary-unbounded",
      transport: scriptedTransport(requests),
      // The shape every surface had before the bound: messages only.
      sendAutomaticallyWhen: ({ messages }) =>
        shouldAutoResumeTurn({ messages }),
    });

    await chat.sendMessage({ parts: [{ type: "text", text: "go" }] });
    await settleMacrotasks();

    // It only stopped because the scripted transport refused to go on.
    expect(requests.count).toBe(REQUEST_CEILING + 1);
  });

  it("stops after the cut-off response once onFinish feeds the finish reason in", async () => {
    const requests = { count: 0 };
    let lastFinishReason: string | undefined;
    const chat = new Chat<UIMessage>({
      id: "resume-canary-bounded",
      transport: scriptedTransport(requests),
      onFinish: ({ finishReason }) => {
        lastFinishReason = finishReason;
      },
      sendAutomaticallyWhen: ({ messages }) =>
        shouldAutoResumeTurn({ messages, finishReason: lastFinishReason }),
    });

    await chat.sendMessage({ parts: [{ type: "text", text: "go" }] });
    await settleMacrotasks();

    expect(lastFinishReason).toBe("length");
    expect(requests.count).toBe(1);
    expect(chat.status).toBe("ready");
  });

  it("stops at the step ceiling even when no finish reason arrives", async () => {
    const requests = { count: 0 };
    const chat = new Chat<UIMessage>({
      id: "resume-canary-ceiling",
      transport: scriptedTransport(requests),
      // Ceiling of one: the first response already spent it.
      sendAutomaticallyWhen: ({ messages }) =>
        shouldAutoResumeTurn({ messages, maxSteps: 1 }),
    });

    await chat.sendMessage({ parts: [{ type: "text", text: "go" }] });
    await settleMacrotasks();

    expect(requests.count).toBe(1);
  });
});
