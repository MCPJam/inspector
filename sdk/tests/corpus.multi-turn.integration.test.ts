/**
 * A materialized multi-prompt case is ONE conversation per iteration.
 *
 * Driven through a real `HostRunner` and `EvalTest` against a scripted model,
 * so what is asserted is what the model was actually sent: the second turn's
 * request carries the first turn exactly once, and a second iteration starts
 * over instead of continuing the first one's conversation.
 */
import { MockLanguageModelV3 } from "ai/test";
import { evalTestFromPlatformCase } from "../src/corpus.js";
import { HostRunner } from "../src/HostRunner.js";
import type { PlatformEvalCase } from "../src/platform/types.js";

let currentModel: MockLanguageModelV3;

vi.mock("../src/model-factory", async () => {
  const actual = await vi.importActual("../src/model-factory");
  return {
    ...actual,
    createModelFromString: () => currentModel,
  };
});

type SentMessage = { role: string; text: string };

/** The request as the model saw it, flattened to role + text. */
function sentMessages(callIndex: number): SentMessage[] {
  const prompt = currentModel.doGenerateCalls[callIndex]!.prompt as Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
  return prompt.map((message) => ({
    role: message.role,
    text:
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join(""),
  }));
}

function twoPromptCase(): PlatformEvalCase {
  return {
    id: "case_multi_turn",
    title: "Order then cancel",
    steps: [
      { id: "s1", kind: "prompt", prompt: "Order a coffee" },
      { id: "s2", kind: "prompt", prompt: "Now cancel it" },
    ],
    iterations: 2,
    isNegative: false,
    models: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("materialized multi-prompt cases against a real runner", () => {
  beforeEach(() => {
    let reply = 0;
    currentModel = new MockLanguageModelV3({
      doGenerate: async () => {
        reply += 1;
        return {
          content: [{ type: "text" as const, text: `reply ${reply}` }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 3,
              noCache: 3,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 2, text: 2, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  });

  it("sends the second turn with the first turn's messages, exactly once", async () => {
    const runner = new HostRunner({
      tools: {},
      model: "openai/gpt-4o",
      apiKey: "test-key",
      systemPrompt: "You are a barista.",
    });
    const test = evalTestFromPlatformCase(twoPromptCase());

    const result = await test.run(runner, {
      iterations: 2,
      concurrency: 1,
      mcpjam: { enabled: false },
    });

    expect(
      result.iterationDetails.map((iteration) => iteration.status)
    ).toEqual(["completed", "completed"]);
    expect(currentModel.doGenerateCalls).toHaveLength(4);

    // Iteration 1, turn 1: the conversation starts.
    expect(sentMessages(0)).toEqual([
      { role: "system", text: "You are a barista." },
      { role: "user", text: "Order a coffee" },
    ]);
    // Iteration 1, turn 2: the first exchange, once, then the new prompt.
    expect(sentMessages(1)).toEqual([
      { role: "system", text: "You are a barista." },
      { role: "user", text: "Order a coffee" },
      { role: "assistant", text: "reply 1" },
      { role: "user", text: "Now cancel it" },
    ]);
    // Iteration 2 starts over: nothing from iteration 1 leaks into it.
    expect(sentMessages(2)).toEqual([
      { role: "system", text: "You are a barista." },
      { role: "user", text: "Order a coffee" },
    ]);
    expect(sentMessages(3)).toEqual([
      { role: "system", text: "You are a barista." },
      { role: "user", text: "Order a coffee" },
      { role: "assistant", text: "reply 3" },
      { role: "user", text: "Now cancel it" },
    ]);

    // The iteration's recorded prompts are the two turns, each once.
    for (const iteration of result.iterationDetails) {
      expect(iteration.prompts?.map((prompt) => prompt.getPrompt())).toEqual([
        "Order a coffee",
        "Now cancel it",
      ]);
    }
  });

  it("does not send the second turn when the first one errored", async () => {
    currentModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("upstream 503");
      },
    });
    const runner = new HostRunner({
      tools: {},
      model: "openai/gpt-4o",
      apiKey: "test-key",
    });
    const test = evalTestFromPlatformCase(twoPromptCase());

    const result = await test.run(runner, {
      iterations: 1,
      mcpjam: { enabled: false },
    });

    // AI SDK retries a thrown doGenerate itself; none of those attempts is
    // the second prompt.
    for (const call of currentModel.doGenerateCalls) {
      expect(
        (call.prompt as Array<{ role: string }>).filter(
          (message) => message.role === "user"
        )
      ).toHaveLength(1);
    }
    const [iteration] = result.iterationDetails;
    expect(iteration!.status).toBe("failed");
    expect(iteration!.error).toMatch(/^prompt 1 of 2 errored: .*upstream 503/);
    expect(iteration!.error).toMatch(/the remaining prompts were not sent$/);
  });
});
