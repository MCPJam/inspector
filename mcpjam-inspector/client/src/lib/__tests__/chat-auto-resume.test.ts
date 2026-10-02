/**
 * Auto-resume predicate shared by every client-driven agent surface — tested
 * against the REAL `ai` package (no mocks), so a version bump that changes the
 * SDK completion predicates surfaces here.
 *
 * The regression pinned is BUG-4: `lastAssistantMessageIsCompleteWithToolCalls`
 * skips `providerExecuted` parts, so a step that pairs an auto-fulfilled WebMCP
 * `ui_*` tool with a still-`approval-requested` provider-executed bash call
 * reads as "complete" and would auto-resume the turn — answering the approval
 * for the user. `shouldAutoResumeTurn` must veto that while the pill is pending.
 */
import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithToolCalls,
  readUIMessageStream,
  type UIMessageChunk,
} from "ai";
import {
  autoResumeStopReason,
  autoResumeStoppedNotice,
  lastStepHasPendingApproval,
  shouldAutoResumeTurn,
} from "../chat-auto-resume";
import { AGENT_MAX_STEPS } from "@/shared/mcpjam-agent-model";
import { DEFAULT_TURN_MAX_STEPS } from "@/shared/turn-step-budget";

/** Minimal assistant message; only role/parts are read by the predicates. */
function assistant(parts: unknown[]): { messages: UIMessage[] } {
  return {
    messages: [{ id: "m1", role: "assistant", parts }] as unknown as UIMessage[],
  };
}

const fulfilledUiTool = {
  type: "tool-ui_snapshot_app",
  toolCallId: "tc-ui",
  state: "output-available",
  output: { ok: true },
};
const pendingBash = {
  type: "tool-bash",
  toolCallId: "tc-bash",
  state: "approval-requested",
  providerExecuted: true,
  input: { command: "uname -a" },
  approval: { id: "appr-bash" },
};

describe("shouldAutoResumeTurn (real ai package)", () => {
  it("does NOT resume while a provider-executed bash approval is pending (BUG-4)", () => {
    const options = assistant([
      { type: "step-start" },
      fulfilledUiTool,
      pendingBash,
    ]);

    // The exact trap: the SDK's own tool-calls predicate reports the step
    // complete because it filters out the provider-executed bash — so without
    // the guard the turn would resume and vanish the Approve/Deny buttons.
    expect(lastAssistantMessageIsCompleteWithToolCalls(options)).toBe(true);
    expect(lastStepHasPendingApproval(options)).toBe(true);
    expect(shouldAutoResumeTurn(options)).toBe(false);
  });

  it("resumes once the bash approval is answered", () => {
    const options = assistant([
      { type: "step-start" },
      fulfilledUiTool,
      {
        ...pendingBash,
        state: "approval-responded",
        approval: { id: "appr-bash", approved: true },
      },
    ]);

    expect(lastStepHasPendingApproval(options)).toBe(false);
    expect(shouldAutoResumeTurn(options)).toBe(true);
  });

  it("does NOT resume for a lone pending bash approval", () => {
    const options = assistant([{ type: "step-start" }, pendingBash]);
    expect(lastStepHasPendingApproval(options)).toBe(true);
    expect(shouldAutoResumeTurn(options)).toBe(false);
  });

  it("resumes when a step's tool calls are all settled and none await approval", () => {
    const options = assistant([{ type: "step-start" }, fulfilledUiTool]);
    expect(lastStepHasPendingApproval(options)).toBe(false);
    expect(shouldAutoResumeTurn(options)).toBe(true);
  });

  it("does not resume a plain text turn with no tool calls", () => {
    const options = assistant([
      { type: "step-start" },
      { type: "text", text: "Done." },
    ]);
    expect(shouldAutoResumeTurn(options)).toBe(false);
  });

  it("only weighs the current step: a pending approval before the last step-start is ignored", () => {
    // An approval-requested part stranded in an earlier step must not park the
    // turn forever — the guard mirrors the SDK's last-step scoping.
    const options = assistant([
      { type: "step-start" },
      pendingBash,
      { type: "step-start" },
      fulfilledUiTool,
    ]);
    expect(lastStepHasPendingApproval(options)).toBe(false);
    expect(shouldAutoResumeTurn(options)).toBe(true);
  });

  it("is inert when the last message is not an assistant turn", () => {
    const empty = { messages: [] as UIMessage[] };
  describe("a turn that ran out of steps", () => {
    // The last allowed step's tools ran, so its tool calls are all settled —
    // exactly what resumes a turn. The server's reply to that resume is what
    // decides whether the browser resends again.
    const outOfSteps: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "step-start" }, fulfilledUiTool],
    } as unknown as UIMessage;

    async function applyReply(chunks: UIMessageChunk[]): Promise<UIMessage> {
      let message = outOfSteps;
      for await (const next of readUIMessageStream({
        message: structuredClone(outOfSteps),
        stream: new ReadableStream<UIMessageChunk>({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
          },
        }),
      })) {
        message = next;
      }
      return message;
    }

    it("keeps resuming after an empty reply (the old endless loop)", async () => {
      const message = await applyReply([
        { type: "finish", finishReason: "length" },
      ]);
      expect(shouldAutoResumeTurn({ messages: [message] })).toBe(true);
    });

    it("stops resuming once the server's step-limit note arrives", async () => {
      const id = "step-limit-turn";
      const message = await applyReply([
        { type: "start-step" },
        { type: "text-start", id },
        { type: "text-delta", id, delta: "I reached my step limit." },
        { type: "text-end", id },
        { type: "finish-step" },
        { type: "finish", finishReason: "length" },
      ]);
      expect(shouldAutoResumeTurn({ messages: [message] })).toBe(false);
    });
  });

    const user = {
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as unknown as UIMessage[],
    };
    expect(lastStepHasPendingApproval(empty)).toBe(false);
    expect(shouldAutoResumeTurn(empty)).toBe(false);
    expect(lastStepHasPendingApproval(user)).toBe(false);
    expect(shouldAutoResumeTurn(user)).toBe(false);
  });
});

describe("shouldAutoResumeTurn — bounded resumes (real ai package)", () => {
  const user = (id: string, text = "go") => ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  });
  /** A server-run docs search the SDK reads as settled — the step shape the
   *  runaway ended on. */
  const settledDocsSearch = (id: string) => ({
    type: "tool-search_mcpjam",
    toolCallId: id,
    state: "output-available",
    input: { query: "evals" },
    output: { content: [] },
  });
  const assistantWithSteps = (steps: number, id = "a") => ({
    id,
    role: "assistant",
    parts: Array.from({ length: steps }).flatMap((_, index) => [
      { type: "step-start" },
      settledDocsSearch(`${id}-${index}`),
    ]),
  });
  const conversation = (...messages: unknown[]) =>
    messages as unknown as UIMessage[];

  it("resumes a settled tool step when the reply ended normally", () => {
    const messages = conversation(user("u1"), assistantWithSteps(2));
    expect(shouldAutoResumeTurn({ messages, finishReason: "tool-calls" })).toBe(
      true,
    );
    expect(
      autoResumeStoppedNotice({ messages, finishReason: "tool-calls" }),
    ).toBeNull();
  });

  it("does NOT resume a reply the output-token limit cut off", () => {
    const messages = conversation(user("u1"), assistantWithSteps(2));
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages })).toBe(
      true,
    );
    expect(shouldAutoResumeTurn({ messages, finishReason: "length" })).toBe(
      false,
    );
    expect(autoResumeStopReason({ messages, finishReason: "length" })).toBe(
      "cut_off",
    );
    expect(autoResumeStoppedNotice({ messages, finishReason: "length" })).toBe(
      "The reply was cut off. Send a message to continue.",
    );
  });

  it("stops at the surface's step ceiling, and not one step before", () => {
    const under = conversation(
      user("u1"),
      assistantWithSteps(AGENT_MAX_STEPS - 1),
    );
    const spent = conversation(user("u1"), assistantWithSteps(AGENT_MAX_STEPS));
    const options = { finishReason: "tool-calls", maxSteps: AGENT_MAX_STEPS };

    expect(shouldAutoResumeTurn({ messages: under, ...options })).toBe(true);
    expect(shouldAutoResumeTurn({ messages: spent, ...options })).toBe(false);
    expect(autoResumeStoppedNotice({ messages: spent, ...options })).toBe(
      "This reply reached its step limit. Send a message to continue.",
    );
  });

  it("defaults the ceiling to the engine's own", () => {
    const spent = conversation(
      user("u1"),
      assistantWithSteps(DEFAULT_TURN_MAX_STEPS),
    );
    expect(autoResumeStopReason({ messages: spent })).toBe("step_limit");
  });

  it("gives a new user message a fresh budget", () => {
    const messages = conversation(
      user("u1"),
      assistantWithSteps(AGENT_MAX_STEPS, "a1"),
      user("u2", "keep going"),
      assistantWithSteps(1, "a2"),
    );
    expect(
      shouldAutoResumeTurn({
        messages,
        finishReason: "tool-calls",
        maxSteps: AGENT_MAX_STEPS,
      }),
    ).toBe(true);
  });

  it("still sends an answered approval — each of those is a user's click", () => {
    const messages = conversation(user("u1"), {
      id: "a",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          ...pendingBash,
          state: "approval-responded",
          approval: { id: "appr-bash", approved: true },
        },
      ],
    });
    expect(shouldAutoResumeTurn({ messages, finishReason: "length" })).toBe(
      true,
    );
    expect(
      autoResumeStoppedNotice({ messages, finishReason: "length" }),
    ).toBeNull();
  });

  it("shows no notice for a turn that simply finished", () => {
    const messages = conversation(user("u1"), {
      id: "a",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "Done." }],
    });
    expect(
      autoResumeStoppedNotice({ messages, finishReason: "length" }),
    ).toBeNull();
  });

  it("replays the runaway: the same spent prompt, re-posted, is never resumed", () => {
    // Ten prompts in, the last one spent Ask MCPJam's step budget on docs
    // searches and the server answered each re-post with an empty `length`
    // finish. The old predicate said yes every time.
    const earlier = Array.from({ length: 9 }).flatMap((_, index) => [
      user(`u${index}`, `question ${index}`),
      {
        id: `a${index}`,
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: `answer ${index}` },
        ],
      },
    ]);
    const messages = conversation(
      ...earlier,
      user("u9", "walk me through an eval"),
      assistantWithSteps(AGENT_MAX_STEPS, "a9"),
    );

    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages })).toBe(
      true,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        shouldAutoResumeTurn({
          messages,
          finishReason: "length",
          maxSteps: AGENT_MAX_STEPS,
        }),
      ).toBe(false);
    }
    // Named for what actually happened: the server reports a spent budget
    // as `length` too, but this is not a truncated reply.
    expect(
      autoResumeStopReason({
        messages,
        finishReason: "length",
        maxSteps: AGENT_MAX_STEPS,
      }),
    ).toBe("step_limit");
    // Even a response with no finish reason at all cannot restart it: the
    // budget alone is enough.
    expect(shouldAutoResumeTurn({ messages, maxSteps: AGENT_MAX_STEPS })).toBe(
      false,
    );
  });
});
