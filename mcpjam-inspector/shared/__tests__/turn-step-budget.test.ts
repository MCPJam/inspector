/**
 * The step count both ends of the loop guard share. Checked against the REAL
 * `convertToModelMessages` (no mocks): the engine counts assistant model
 * messages after the last user message, and the browser/route count must
 * land on the same number, or the guard refuses a step the engine would have
 * taken — or lets through a request the engine can do nothing with.
 */
import { describe, expect, it } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  countAssistantStepsSincePrompt,
  isRejectedToolInputPart,
  isTurnContinuation,
  repeatedToolInputFailure,
} from "../turn-step-budget.js";

const user = (text = "go", id = "u") => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const settledUiTool = (id: string) => ({
  type: "tool-ui_snapshot_app",
  toolCallId: id,
  state: "output-available",
  input: {},
  output: { ok: true },
});

/** One assistant message holding `steps` tool steps, as an auto-resumed turn
 *  accumulates them. */
const assistantWithSteps = (steps: number, id = "a") => ({
  id,
  role: "assistant",
  parts: Array.from({ length: steps }).flatMap((_, index) => [
    { type: "step-start" },
    settledUiTool(`${id}-call-${index}`),
  ]),
});

/** A call the SDK refused for its input, as `tool-input-error` leaves it. */
const rejectedCall = (toolName: string, id: string) => ({
  type: `tool-${toolName}`,
  toolCallId: id,
  state: "output-error",
  rawInput: '{"cases":[{"title":"Sign in',
  errorText: `Invalid input for tool ${toolName}: JSON parsing failed`,
});

/** What the engine counts: assistant model messages after the last user one. */
async function engineCount(messages: unknown[]): Promise<number> {
  const model = await convertToModelMessages(messages as UIMessage[]);
  let lastUser = -1;
  model.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  if (lastUser < 0) return 0;
  return model.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
}

describe("countAssistantStepsSincePrompt", () => {
  it.each([
    ["a fresh prompt", [user()]],
    ["one tool step", [user(), assistantWithSteps(1)]],
    ["sixteen resumed steps", [user(), assistantWithSteps(16)]],
    [
      "steps spread over two assistant messages",
      [user(), assistantWithSteps(3, "a1"), assistantWithSteps(2, "a2")],
    ],
    [
      "text, reasoning and a tool in one step",
      [
        user(),
        {
          id: "a",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "Let me look." },
            settledUiTool("c1"),
            { type: "step-start" },
            { type: "text", text: "Done." },
          ],
        },
      ],
    ],
    [
      "an empty trailing step-start",
      [
        user(),
        {
          id: "a",
          role: "assistant",
          parts: [
            { type: "step-start" },
            settledUiTool("c1"),
            { type: "step-start" },
          ],
        },
      ],
    ],
    [
      "earlier prompts' steps",
      [user("first", "u1"), assistantWithSteps(20, "a1"), user("second", "u2")],
    ],
  ])("matches the engine's count for %s", async (_label, messages) => {
    expect(countAssistantStepsSincePrompt(messages)).toBe(
      await engineCount(messages),
    );
  });

  it("counts only the steps since the LAST user message", () => {
    const messages = [
      user("first", "u1"),
      assistantWithSteps(20, "a1"),
      user("second", "u2"),
      assistantWithSteps(2, "a2"),
    ];
    expect(countAssistantStepsSincePrompt(messages)).toBe(2);
  });

  it("is zero when there is no user message at all, like the engine", () => {
    expect(countAssistantStepsSincePrompt([assistantWithSteps(40)])).toBe(0);
  });

  it("tolerates malformed history", () => {
    expect(
      countAssistantStepsSincePrompt([
        null,
        "x",
        { role: "user" },
        { role: "assistant", parts: "nope" },
        { role: "assistant", parts: [null, 1, { type: "step-start" }] },
      ]),
    ).toBe(0);
  });
});

describe("isTurnContinuation", () => {
  it("is true only when the last message is the assistant's", () => {
    expect(isTurnContinuation([user(), assistantWithSteps(1)])).toBe(true);
    expect(isTurnContinuation([assistantWithSteps(1), user()])).toBe(false);
    expect(isTurnContinuation([])).toBe(false);
  });
});

describe("isRejectedToolInputPart", () => {
  it("recognises a static part minted from tool-input-error", () => {
    expect(isRejectedToolInputPart(rejectedCall("ui_create_case", "c1"))).toBe(
      true,
    );
    // Even when a provider rewrote the error text, the shape still says so.
    expect(
      isRejectedToolInputPart({
        type: "tool-ui_create_case",
        toolCallId: "c1",
        state: "output-error",
        rawInput: "{",
        errorText: "bad json",
      }),
    ).toBe(true);
  });

  it("recognises a dynamic part by the SDK's error text", () => {
    expect(
      isRejectedToolInputPart({
        type: "dynamic-tool",
        toolName: "ui_create_case",
        toolCallId: "c1",
        state: "output-error",
        input: "{",
        errorText:
          '{"code":"x","message":"Invalid input for tool ui_create_case: JSON parsing failed"}',
      }),
    ).toBe(true);
  });

  it("does not treat a tool that RAN and failed as a rejected input", () => {
    expect(
      isRejectedToolInputPart({
        type: "tool-search_docs",
        toolCallId: "c1",
        state: "output-error",
        input: { q: "auth" },
        errorText: "Upstream returned 500",
      }),
    ).toBe(false);
    expect(isRejectedToolInputPart(settledUiTool("c1"))).toBe(false);
  });
});

describe("repeatedToolInputFailure", () => {
  const stepWith = (...parts: unknown[]) => [{ type: "step-start" }, ...parts];

  it("names the tool rejected in each of the last two steps", () => {
    const messages = [
      user(),
      {
        id: "a",
        role: "assistant",
        parts: [
          ...stepWith(settledUiTool("ok")),
          ...stepWith(rejectedCall("ui_create_case", "c1")),
          ...stepWith(
            { type: "text", text: "Retrying." },
            rejectedCall("ui_create_case", "c2"),
          ),
        ],
      },
    ];
    expect(repeatedToolInputFailure(messages)).toEqual({
      toolName: "ui_create_case",
      steps: 2,
    });
  });

  it("stays quiet after a single rejection — the model may correct it", () => {
    const messages = [
      user(),
      {
        id: "a",
        role: "assistant",
        parts: [
          ...stepWith(settledUiTool("ok")),
          ...stepWith(rejectedCall("ui_create_case", "c1")),
        ],
      },
    ];
    expect(repeatedToolInputFailure(messages)).toBeNull();
  });

  it("does not join rejections of DIFFERENT tools into a run", () => {
    const messages = [
      user(),
      {
        id: "a",
        role: "assistant",
        parts: [
          ...stepWith(rejectedCall("ui_create_case", "c1")),
          ...stepWith(rejectedCall("ui_navigate", "c2")),
        ],
      },
    ];
    expect(repeatedToolInputFailure(messages)).toBeNull();
  });

  it("does not reach across a new user message", () => {
    const messages = [
      user("first", "u1"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          ...stepWith(rejectedCall("ui_create_case", "c1")),
          ...stepWith(rejectedCall("ui_create_case", "c2")),
        ],
      },
      user("try again", "u2"),
      {
        id: "a2",
        role: "assistant",
        parts: [...stepWith(rejectedCall("ui_create_case", "c3"))],
      },
    ];
    expect(repeatedToolInputFailure(messages)).toBeNull();
  });
});
