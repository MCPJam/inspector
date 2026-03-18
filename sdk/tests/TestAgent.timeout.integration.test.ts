import { dynamicTool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { TestAgent } from "../src/TestAgent";

let currentModel: MockLanguageModelV3;
const mockCreateModelFromString = jest.fn(() => currentModel);

jest.mock("../src/model-factory", () => {
  const actual = jest.requireActual("../src/model-factory");
  return {
    ...actual,
    createModelFromString: (...args: any[]) =>
      mockCreateModelFromString(...args),
  };
});

function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(String(reason ?? "aborted"));
}

describe("TestAgent timeout integration", () => {
  beforeEach(() => {
    mockCreateModelFromString.mockClear();
  });

  it("returns an error result when AI SDK timeout aborts a tool cooperatively", async () => {
    let sawAbortSignal = false;
    let abortObserved = false;
    let stepNumber = 0;

    currentModel = new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) => {
        stepNumber += 1;

        if (stepNumber === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "wait",
                input: JSON.stringify({}),
              },
            ],
            finishReason: "tool-calls",
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            warnings: [],
          };
        }

        if (abortSignal?.aborted) {
          throw toError(abortSignal.reason);
        }

        return {
          content: [{ type: "text" as const, text: "unexpected follow-up" }],
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          warnings: [],
        };
      },
    });

    const agent = new TestAgent({
      tools: {
        wait: dynamicTool({
          description: "Wait until the abort signal fires",
          inputSchema: jsonSchema({
            type: "object",
            properties: {},
          }),
          execute: async (_input, { abortSignal }) => {
            sawAbortSignal = abortSignal != null;

            if (abortSignal == null) {
              throw new Error("missing abort signal");
            }

            if (abortSignal.aborted) {
              abortObserved = true;
              throw toError(abortSignal.reason);
            }

            await new Promise<never>((_, reject) => {
              abortSignal.addEventListener(
                "abort",
                () => {
                  abortObserved = true;
                  reject(toError(abortSignal.reason));
                },
                { once: true }
              );
            });

            throw new Error("unreachable");
          },
        }),
      },
      model: "openai/gpt-4o",
      apiKey: "test-key",
    });

    const startedAt = Date.now();
    const result = await agent.prompt("Run the long tool", { timeout: 25 });
    const elapsedMs = Date.now() - startedAt;

    expect(sawAbortSignal).toBe(true);
    expect(abortObserved).toBe(true);
    expect(result.hasError()).toBe(true);
    expect(result.getError()).toEqual(expect.any(String));
    expect(elapsedMs).toBeLessThan(1000);
    expect(currentModel.doGenerateCalls).toHaveLength(2);
    expect(mockCreateModelFromString).toHaveBeenCalledWith(
      "openai/gpt-4o",
      expect.objectContaining({ apiKey: "test-key" })
    );
  });
});
