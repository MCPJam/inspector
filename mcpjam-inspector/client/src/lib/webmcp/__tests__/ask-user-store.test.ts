/**
 * `ui_ask_user`: the parked-promise lifecycle and the tool's argument
 * contract.
 *
 * The invariant under test throughout: EVERY path settles. An unresolved
 * question means an `execute` that never returns, which means a paused
 * server stream that never resumes — the worst failure this feature can
 * have, and the one that is invisible until a user is staring at a spinner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

// The core group imports the inspector command bus for its other tools.
vi.mock("@/lib/inspector-command-handlers", () => ({
  executeInspectorCommand: vi.fn(),
  hasInspectorCommandHandler: vi.fn().mockReturnValue(true),
}));

import {
  ASK_USER_TOOL_NAME,
  answerAskUserQuestion,
  dismissAskUserQuestions,
  registerAskUserQuestion,
  useAskUserStore,
  __resetAskUserStoreForTests,
} from "../ask-user-store";
import { buildCoreUiTools } from "../groups/core";
import type { UiToolResult } from "../ui-tools-registry";

function askUserTool() {
  const tool = buildCoreUiTools().find((t) => t.name === ASK_USER_TOOL_NAME);
  if (!tool) throw new Error("core group is missing ui_ask_user");
  return tool;
}

/** The `{ok, data}` payload the tool packs into its text content block. */
function readPayload(result: UiToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** Let the microtask that resolves a parked promise run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const OPTIONS = [
  { label: "Connect to a local MCP server", value: "local" },
  { label: "Connect to a remote MCP server", value: "remote" },
];

describe("ask-user store", () => {
  beforeEach(() => {
    __resetAskUserStoreForTests();
    trackMock.mockClear();
  });

  it("parks a question and resolves it with the chosen option", async () => {
    const pending = registerAskUserQuestion({
      toolCallId: "call-1",
      question: "What are you trying to do?",
      options: OPTIONS,
    });
    expect(useAskUserStore.getState().pending.get("call-1")?.question).toBe(
      "What are you trying to do?",
    );

    answerAskUserQuestion("call-1", {
      kind: "selected",
      value: "remote",
      label: "Connect to a remote MCP server",
    });

    await expect(pending).resolves.toEqual({
      kind: "selected",
      value: "remote",
      label: "Connect to a remote MCP server",
    });
    // Cleared on settle, so a re-render can't paint a stale interactive card.
    expect(useAskUserStore.getState().pending.has("call-1")).toBe(false);
  });

  it("resolves exactly once — a second answer is a no-op", async () => {
    const pending = registerAskUserQuestion({
      toolCallId: "call-1",
      question: "Which one?",
      options: OPTIONS,
    });
    expect(
      answerAskUserQuestion("call-1", {
        kind: "selected",
        value: "local",
        label: "Local",
      }),
    ).toBe(true);
    // A double-click, or a dismissal racing the click.
    expect(
      answerAskUserQuestion("call-1", {
        kind: "freeText",
        text: "actually something else",
      }),
    ).toBe(false);
    expect(dismissAskUserQuestions("stopped")).toBe(0);

    await expect(pending).resolves.toMatchObject({ value: "local" });
  });

  it("dismisses only the scoped session's questions", async () => {
    const mine = registerAskUserQuestion({
      toolCallId: "call-mine",
      question: "Mine?",
      options: OPTIONS,
      scope: "session-a",
    });
    registerAskUserQuestion({
      toolCallId: "call-theirs",
      question: "Theirs?",
      options: OPTIONS,
      scope: "session-b",
    });

    expect(dismissAskUserQuestions("new_message", { scope: "session-a" })).toBe(
      1,
    );
    await expect(mine).resolves.toEqual({
      kind: "dismissed",
      reason: "new_message",
    });
    // A background turn in another session keeps its question.
    expect(useAskUserStore.getState().pending.has("call-theirs")).toBe(true);
  });

  it("emits outcome telemetry without the question, options, or answer text", async () => {
    const pending = registerAskUserQuestion({
      toolCallId: "call-1",
      question: "Which server did you mean?",
      options: OPTIONS,
    });
    answerAskUserQuestion("call-1", {
      kind: "freeText",
      text: "the one I set up yesterday at acme.internal",
    });
    await pending;

    expect(trackMock).toHaveBeenCalledTimes(1);
    const [event, props] = trackMock.mock.calls[0]!;
    expect(event).toBe("agent_ask_user_resolved");
    expect(props).toMatchObject({ outcome: "freeText", option_count: 2 });
    expect(typeof props.time_to_answer_ms).toBe("number");
    // HARD RULE: names, counts, durations — never the user's or the model's
    // words. The answer above is the kind of thing that would leak.
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain("acme.internal");
    expect(serialized).not.toContain("Which server");
    expect(serialized).not.toContain("Connect to a");
  });

  it("a throwing analytics client still settles the question", async () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error("analytics is down");
    });
    const pending = registerAskUserQuestion({
      toolCallId: "call-1",
      question: "Which one?",
      options: OPTIONS,
    });
    answerAskUserQuestion("call-1", {
      kind: "selected",
      value: "local",
      label: "Local",
    });
    await expect(pending).resolves.toMatchObject({ kind: "selected" });
  });
});

describe("ui_ask_user tool", () => {
  beforeEach(() => {
    __resetAskUserStoreForTests();
    trackMock.mockClear();
  });

  it("parks on the tool-call id and returns the answer to the model", async () => {
    const result = askUserTool().execute(
      { question: "What are you trying to do?", options: OPTIONS },
      { toolCallId: "call-1", scope: "session-a" },
    );
    await flush();

    const parked = useAskUserStore.getState().pending.get("call-1");
    expect(parked?.scope).toBe("session-a");
    expect(parked?.options).toEqual(OPTIONS);

    answerAskUserQuestion("call-1", {
      kind: "selected",
      value: "remote",
      label: "Connect to a remote MCP server",
    });

    const payload = readPayload(await result);
    expect(payload).toEqual({
      ok: true,
      data: {
        kind: "selected",
        value: "remote",
        label: "Connect to a remote MCP server",
      },
    });
  });

  it("reports a dismissal as a normal result, not an error", async () => {
    const result = askUserTool().execute(
      { question: "Which one?", options: OPTIONS },
      { toolCallId: "call-1", scope: "session-a" },
    );
    await flush();
    dismissAskUserQuestions("new_message", { scope: "session-a" });

    const settled = await result;
    // isError would invite the model to retry the question — the single
    // response that is certainly wrong when the user has moved on.
    expect(settled.isError).toBeUndefined();
    const payload = readPayload(settled) as { data: { kind: string } };
    expect(payload.data.kind).toBe("dismissed");
    expect(settled.content[0]!.text).toContain("Do not ask this again");
  });

  it("fails fast when no tool-call id is available", async () => {
    // Nothing could ever resolve this call, so it must error instead of
    // parking a promise that hangs the stream forever.
    const result = await askUserTool().execute({
      question: "Which one?",
      options: OPTIONS,
    });
    expect(result.isError).toBe(true);
    expect(useAskUserStore.getState().pending.size).toBe(0);
  });

  it.each([
    ["a missing question", { options: OPTIONS }],
    ["a blank question", { question: "   ", options: OPTIONS }],
    ["an over-long question", { question: "x".repeat(301), options: OPTIONS }],
    ["no options", { question: "Which one?" }],
    ["one option", { question: "Which one?", options: [OPTIONS[0]] }],
    [
      "options that collapse to one after dedupe",
      {
        question: "Which one?",
        options: [
          { label: "Local", value: "same" },
          { label: "Remote", value: "same" },
        ],
      },
    ],
    [
      "more than four options",
      {
        question: "Which one?",
        options: ["a", "b", "c", "d", "e"].map((v) => ({ label: v, value: v })),
      },
    ],
  ])("rejects %s without parking", async (_name, args) => {
    const result = await askUserTool().execute(
      args as Record<string, unknown>,
      {
        toolCallId: "call-1",
      },
    );
    expect(result.isError).toBe(true);
    expect(useAskUserStore.getState().pending.size).toBe(0);
  });

  it("accepts bare strings as options and defaults value to the label", async () => {
    void askUserTool().execute(
      { question: "Which one?", options: ["Local", { label: "Remote" }] },
      { toolCallId: "call-1" },
    );
    await flush();
    expect(useAskUserStore.getState().pending.get("call-1")?.options).toEqual([
      { label: "Local", value: "Local" },
      { label: "Remote", value: "Remote" },
    ]);
  });

  it("collapses options that render as the same button", async () => {
    // Distinct values, identical labels: two buttons the user cannot tell
    // apart is not a choice, exactly as two identical values aren't.
    const result = await askUserTool().execute(
      {
        question: "Which one?",
        options: [
          { label: "Local", value: "a" },
          { label: "Local", value: "b" },
        ],
      },
      { toolCallId: "call-1" },
    );
    expect(result.isError).toBe(true);
    expect(useAskUserStore.getState().pending.size).toBe(0);
  });

  it("compares labels AFTER truncation, since that is what is painted", async () => {
    const shared = "L".repeat(100);
    const result = await askUserTool().execute(
      {
        question: "Which one?",
        options: [
          { label: `${shared}-one`, value: "a" },
          { label: `${shared}-two`, value: "b" },
        ],
      },
      { toolCallId: "call-1" },
    );
    // Both truncate to the same 80 chars — one button, so not a question.
    expect(result.isError).toBe(true);
  });

  it("bounds the answer token the model gets back", async () => {
    void askUserTool().execute(
      {
        question: "Which one?",
        options: [
          { label: "Local", value: "v".repeat(500) },
          { label: "Remote", value: "remote" },
        ],
      },
      { toolCallId: "call-1" },
    );
    await flush();
    const [first] = useAskUserStore.getState().pending.get("call-1")!.options;
    // The schema calls it a short token; labels were already capped, and an
    // uncapped value would ride the whole way back into the transcript.
    expect(first!.value).toHaveLength(120);
  });

  it("truncates an over-long label but keeps the full value", async () => {
    const longLabel = "L".repeat(120);
    void askUserTool().execute(
      {
        question: "Which one?",
        options: [{ label: longLabel, value: "local" }, { label: "Remote" }],
      },
      { toolCallId: "call-1" },
    );
    await flush();
    const [first] = useAskUserStore.getState().pending.get("call-1")!.options;
    expect(first!.label).toHaveLength(80);
    expect(first!.label.endsWith("…")).toBe(true);
    // The value is what comes back to the model — it must not be mangled.
    expect(first!.value).toBe("local");
  });
});
