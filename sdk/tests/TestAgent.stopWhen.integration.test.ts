import { dynamicTool, hasToolCall, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { TestAgent } from "../src/TestAgent";

let currentModel: MockLanguageModelV3;
const mockCreateModelFromString = jest.fn(() => currentModel);

jest.mock("../src/model-factory", () => {
  const actual = jest.requireActual("../src/model-factory");
  return {
    ...actual,
    createModelFromString: (...args: any[]) => mockCreateModelFromString(...args),
  };
});

describe("TestAgent stopWhen integration", () => {
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
            finishReason: "tool-calls",
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            warnings: [],
          };
        }

        return {
          content: [{ type: "text" as const, text: "The result is 5" }],
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          warnings: [],
        };
      },
    });

    const agent = new TestAgent({
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

    const result = await agent.prompt("Add 2 and 3", {
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
