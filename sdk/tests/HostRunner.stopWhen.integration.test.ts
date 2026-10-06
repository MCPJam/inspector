import { dynamicTool, hasToolCall, jsonSchema } from "ai";
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

describe("HostRunner stopWhen integration", () => {
  beforeEach(() => {
    mockCreateModelFromString.mockClear();
  });

  it("executes the tool and stops before the next generation step", async () => {
    const toolExecutions: Array<Record<string, unknown>> = [];
    let stepNumber = 0;

    currentModel = new MockLanguageModelV3({
      doGenerate: async () => {
        stepNumber += 1;

        if (stepNumber === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "add",
                input: JSON.stringify({ a: 2, b: 3 }),
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

        return {
          content: [{ type: "text" as const, text: "The result is 5" }],
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
        add: dynamicTool({
          description: "Add two numbers",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          }),
          execute: async (input) => {
            const args = input as { a: number; b: number };
            toolExecutions.push(args);
            return args.a + args.b;
          },
        }),
      },
      model: "openai/gpt-4o",
      apiKey: "test-key",
    });

    const result = await agent.run("Add 2 and 3", {
      stopWhen: hasToolCall("add"),
    });

    expect(toolExecutions).toEqual([{ a: 2, b: 3 }]);
    expect(result.hasToolCall("add")).toBe(true);
    expect(result.getToolArguments("add")).toEqual({ a: 2, b: 3 });
    expect(result.text).toBe("");
    expect(currentModel.doGenerateCalls).toHaveLength(1);
    expect(mockCreateModelFromString).toHaveBeenCalledWith(
      "openai/gpt-4o",
      expect.objectContaining({ apiKey: "test-key" })
    );
  });
});
