import { dynamicTool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { HostRunner } from "../src/HostRunner";

let currentModel: MockLanguageModelV3;
const mockCreateModelFromString = vi.fn(() => currentModel);

vi.mock("../src/model-factory", async () => {
  const actual = await vi.importActual("../src/model-factory");
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

describe("HostRunner timeout integration", () => {
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
            finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
            usage: {
              inputTokens: {
                total: 5,
                noCache: 5,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 3, text: 3, reasoning: 0 },
            },
            warnings: [],
          };
        }

        if (abortSignal?.aborted) {
          throw toError(abortSignal.reason);
        }

        return {
          content: [{ type: "text" as const, text: "unexpected follow-up" }],
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage: {
            inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });

    const agent = new HostRunner({
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
    const result = await agent.run("Run the long tool", { timeout: 25 });
    const elapsedMs = Date.now() - startedAt;

    expect(sawAbortSignal).toBe(true);
    expect(abortObserved).toBe(true);
    expect(result.hasError()).toBe(true);
    expect(result.getError()).toEqual(expect.any(String));
    expect(elapsedMs).toBeLessThan(1000);
    // AI SDK 7 stops at the timeout: no model call after the aborted tool.
    // (AI SDK 6 made one more, answered by the "unexpected follow-up" below.)
    expect(currentModel.doGenerateCalls).toHaveLength(1);
    expect(mockCreateModelFromString).toHaveBeenCalledWith(
      "openai/gpt-4o",
      expect.objectContaining({ apiKey: "test-key" })
    );
  });
});
