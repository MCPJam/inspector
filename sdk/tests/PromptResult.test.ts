import { PromptResult } from "../src/PromptResult";
import type { PromptResultData, LatencyBreakdown } from "../src/types";

describe("PromptResult", () => {
  const createMockData = (
    overrides: Partial<PromptResultData> = {}
  ): PromptResultData => ({
    text: "Test response",
    toolCalls: [
      { toolName: "add", arguments: { a: 1, b: 2 } },
      { toolName: "multiply", arguments: { x: 3, y: 4 } },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
    latency: { e2eMs: 1234, llmMs: 800, mcpMs: 400 },
    ...overrides,
  });

  describe("constructor", () => {
    it("should create instance with all properties", () => {
      const data = createMockData();
      const result = new PromptResult(data);

      expect(result.text).toBe("Test response");
      expect(result.e2eLatencyMs()).toBe(1234);
    });

    it("should handle missing error", () => {
      const data = createMockData();
      const result = new PromptResult(data);

      expect(result.hasError()).toBe(false);
      expect(result.getError()).toBeUndefined();
    });

    it("should handle error state", () => {
      const data = createMockData({ error: "Something went wrong" });
      const result = new PromptResult(data);

      expect(result.hasError()).toBe(true);
      expect(result.getError()).toBe("Something went wrong");
    });
  });

  describe("toolsCalled", () => {
    it("should return array of tool names", () => {
      const result = new PromptResult(createMockData());

      expect(result.toolsCalled()).toEqual(["add", "multiply"]);
    });

    it("should return empty array when no tools called", () => {
      const result = new PromptResult(createMockData({ toolCalls: [] }));

      expect(result.toolsCalled()).toEqual([]);
    });

    it("should work with includes() for assertions", () => {
      const result = new PromptResult(createMockData());

      expect(result.toolsCalled().includes("add")).toBe(true);
      expect(result.toolsCalled().includes("subtract")).toBe(false);
    });
  });

  describe("hasToolCall", () => {
    it("should return true for called tools", () => {
      const result = new PromptResult(createMockData());

      expect(result.hasToolCall("add")).toBe(true);
      expect(result.hasToolCall("multiply")).toBe(true);
    });

    it("should return false for uncalled tools", () => {
      const result = new PromptResult(createMockData());

      expect(result.hasToolCall("subtract")).toBe(false);
      expect(result.hasToolCall("divide")).toBe(false);
    });

    it("should be case-sensitive", () => {
      const result = new PromptResult(createMockData());

      expect(result.hasToolCall("Add")).toBe(false);
      expect(result.hasToolCall("ADD")).toBe(false);
    });
  });

  describe("getToolCalls", () => {
    it("should return copy of tool calls", () => {
      const result = new PromptResult(createMockData());
      const calls = result.getToolCalls();

      expect(calls).toHaveLength(2);
      expect(calls[0].toolName).toBe("add");
      expect(calls[0].arguments).toEqual({ a: 1, b: 2 });
    });

    it("should not expose internal array", () => {
      const result = new PromptResult(createMockData());
      const calls1 = result.getToolCalls();
      const calls2 = result.getToolCalls();

      expect(calls1).not.toBe(calls2);
    });
  });

  describe("getToolArguments", () => {
    it("should return arguments for called tool", () => {
      const result = new PromptResult(createMockData());

      expect(result.getToolArguments("add")).toEqual({ a: 1, b: 2 });
      expect(result.getToolArguments("multiply")).toEqual({ x: 3, y: 4 });
    });

    it("should return undefined for uncalled tool", () => {
      const result = new PromptResult(createMockData());

      expect(result.getToolArguments("subtract")).toBeUndefined();
    });

    it("should return first call arguments when tool called multiple times", () => {
      const data = createMockData({
        toolCalls: [
          { toolName: "add", arguments: { a: 1, b: 2 } },
          { toolName: "add", arguments: { a: 10, b: 20 } },
        ],
      });
      const result = new PromptResult(data);

      expect(result.getToolArguments("add")).toEqual({ a: 1, b: 2 });
    });
  });

  describe("token usage", () => {
    it("should return correct token counts", () => {
      const result = new PromptResult(createMockData());

      expect(result.inputTokens()).toBe(100);
      expect(result.outputTokens()).toBe(50);
      expect(result.totalTokens()).toBe(150);
    });

    it("should return usage object copy", () => {
      const result = new PromptResult(createMockData());
      const usage1 = result.getUsage();
      const usage2 = result.getUsage();

      expect(usage1).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
      expect(usage1).not.toBe(usage2);
    });
  });

  describe("error handling", () => {
    it("should correctly identify error state", () => {
      const noError = new PromptResult(createMockData());
      const withError = new PromptResult(createMockData({ error: "Failed" }));

      expect(noError.hasError()).toBe(false);
      expect(withError.hasError()).toBe(true);
    });

    it("should return error message", () => {
      const result = new PromptResult(
        createMockData({ error: "Connection timeout" })
      );

      expect(result.getError()).toBe("Connection timeout");
    });
  });

  describe("static factories", () => {
    describe("PromptResult.from", () => {
      it("should create instance from data", () => {
        const data = createMockData();
        const result = PromptResult.from(data);

        expect(result).toBeInstanceOf(PromptResult);
        expect(result.text).toBe("Test response");
      });
    });

    describe("PromptResult.error", () => {
      it("should create error result with default latency", () => {
        const result = PromptResult.error("Network error");

        expect(result.hasError()).toBe(true);
        expect(result.getError()).toBe("Network error");
        expect(result.text).toBe("");
        expect(result.e2eLatencyMs()).toBe(0);
        expect(result.llmLatencyMs()).toBe(0);
        expect(result.mcpLatencyMs()).toBe(0);
        expect(result.toolsCalled()).toEqual([]);
        expect(result.totalTokens()).toBe(0);
      });

      it("should create error result with custom e2e latency", () => {
        const result = PromptResult.error("Timeout", 5000);

        expect(result.hasError()).toBe(true);
        expect(result.e2eLatencyMs()).toBe(5000);
        expect(result.llmLatencyMs()).toBe(0);
        expect(result.mcpLatencyMs()).toBe(0);
      });

      it("should create error result with full latency breakdown", () => {
        const latency: LatencyBreakdown = {
          e2eMs: 5000,
          llmMs: 3000,
          mcpMs: 1500,
        };
        const result = PromptResult.error("Timeout", latency);

        expect(result.hasError()).toBe(true);
        expect(result.e2eLatencyMs()).toBe(5000);
        expect(result.llmLatencyMs()).toBe(3000);
        expect(result.mcpLatencyMs()).toBe(1500);
      });
    });
  });

  describe("latency methods", () => {
    it("should return correct latency values", () => {
      const result = new PromptResult(createMockData());

      expect(result.e2eLatencyMs()).toBe(1234);
      expect(result.llmLatencyMs()).toBe(800);
      expect(result.mcpLatencyMs()).toBe(400);
    });

    it("should return copy of latency breakdown", () => {
      const result = new PromptResult(createMockData());
      const latency1 = result.getLatency();
      const latency2 = result.getLatency();

      expect(latency1).toEqual({
        e2eMs: 1234,
        llmMs: 800,
        mcpMs: 400,
      });
      expect(latency1).not.toBe(latency2);
    });

    it("should handle zero latencies", () => {
      const result = new PromptResult(
        createMockData({
          latency: { e2eMs: 0, llmMs: 0, mcpMs: 0 },
        })
      );

      expect(result.e2eLatencyMs()).toBe(0);
      expect(result.llmLatencyMs()).toBe(0);
      expect(result.mcpLatencyMs()).toBe(0);
    });
  });
});
