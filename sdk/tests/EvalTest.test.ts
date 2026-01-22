import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import type { TestAgent } from "../src/TestAgent";

// Mock PromptResult factory
function createMockPromptResult(options: {
  text?: string;
  toolsCalled?: string[];
  tokens?: number;
  latency?: { e2eMs: number; llmMs: number; mcpMs: number };
  error?: string;
}): PromptResult {
  return PromptResult.from({
    text: options.text ?? "Test response",
    toolCalls: (options.toolsCalled ?? []).map((name) => ({
      toolName: name,
      arguments: {},
    })),
    usage: {
      inputTokens: Math.floor((options.tokens ?? 100) / 2),
      outputTokens: Math.floor((options.tokens ?? 100) / 2),
      totalTokens: options.tokens ?? 100,
    },
    latency: options.latency ?? { e2eMs: 100, llmMs: 80, mcpMs: 20 },
    error: options.error,
  });
}

// Create a mock TestAgent with prompt history tracking
function createMockAgent(
  promptFn: (message: string) => Promise<PromptResult>
): TestAgent {
  let promptHistory: PromptResult[] = [];
  return {
    prompt: async (message: string) => {
      const result = await promptFn(message);
      promptHistory.push(result);
      return result;
    },
    resetPromptHistory: () => {
      promptHistory = [];
    },
    getPromptHistory: () => [...promptHistory],
  } as TestAgent;
}

describe("EvalTest", () => {
  describe("constructor", () => {
    it("should create an instance with name", () => {
      const test = new EvalTest({ name: "test-name", prompt: "Test prompt" });
      expect(test.getName()).toBe("test-name");
    });

    it("should store config", () => {
      const config = {
        name: "test",
        prompt: "Test prompt",
        expectTools: ["add"],
      };
      const test = new EvalTest(config);
      expect(test.getConfig()).toEqual(config);
    });
  });

  describe("single-turn mode", () => {
    it("should run iterations with prompt and track results", async () => {
      let callCount = 0;

      const agent = createMockAgent(async () => {
        callCount++;
        return createMockPromptResult({ toolsCalled: ["add"] });
      });

      const test = new EvalTest({
        name: "addition",
        prompt: "Add 2 and 3",
        expectTools: ["add"],
      });

      const result = await test.run(agent, { iterations: 5 });

      expect(callCount).toBe(5);
      expect(result.iterations).toBe(5);
      expect(result.successes).toBe(5);
      expect(result.failures).toBe(0);
      expect(result.results).toEqual([true, true, true, true, true]);
    });

    it("should use expectTools with matchToolCallsSubset", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["add", "multiply"] });
      });

      const test = new EvalTest({
        name: "test",
        prompt: "Add and multiply",
        expectTools: ["add"], // Should pass even with extra tools
      });

      const result = await test.run(agent, { iterations: 3 });
      expect(result.successes).toBe(3);
    });

    it("should use expectExactTools with matchToolCalls", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["add", "multiply"] });
      });

      // Exact match - wrong order
      const test1 = new EvalTest({
        name: "wrong-order",
        prompt: "Test",
        expectExactTools: ["multiply", "add"],
      });
      const result1 = await test1.run(agent, { iterations: 2 });
      expect(result1.failures).toBe(2);

      // Exact match - correct order
      const test2 = new EvalTest({
        name: "correct-order",
        prompt: "Test",
        expectExactTools: ["add", "multiply"],
      });
      const result2 = await test2.run(agent, { iterations: 2 });
      expect(result2.successes).toBe(2);
    });

    it("should use expectAnyTool with matchAnyToolCall", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["add"] });
      });

      const test = new EvalTest({
        name: "any-tool",
        prompt: "Test",
        expectAnyTool: ["subtract", "add", "multiply"],
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should use expectNoTools with matchNoToolCalls", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        name: "no-tools",
        prompt: "Just respond",
        expectNoTools: true,
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should use custom test function when provided", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({
          text: "The answer is 42",
          toolsCalled: ["add"],
        });
      });

      const test = new EvalTest({
        name: "custom-test",
        prompt: "Test",
        test: (result) => result.text.includes("42"),
      });

      const result = await test.run(agent, { iterations: 3 });
      expect(result.successes).toBe(3);
    });

    it("should support async test functions", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ text: "response" });
      });

      const test = new EvalTest({
        name: "async-test",
        prompt: "Test",
        test: async (result) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return result.text.length > 0;
        },
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should default to pass if no error when no expectations set", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "no-expectations",
        prompt: "Test",
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should fail when there is an error and no expectations", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ error: "Something went wrong" });
      });

      const test = new EvalTest({
        name: "with-error",
        prompt: "Test",
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.failures).toBe(2);
    });
  });

  describe("multi-turn conversation mode", () => {
    it("should run test function and aggregate results", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["search"] });
      });

      const test = new EvalTest({
        name: "conversation",
        test: async (agent) => {
          const r1 = await agent.prompt("Search for X");
          const r2 = await agent.prompt("Summarize results");
          return r1.toolsCalled().includes("search");
        },
      });

      // Multi-turn tests should use concurrency: 1 to avoid shared state issues
      const result = await test.run(agent, { iterations: 3, concurrency: 1 });

      expect(result.successes).toBe(3);
      // Should have 2 latencies per iteration (2 prompts in conversation)
      expect(result.latency.perIteration.length).toBe(6);
    });

    it("should handle test function failures", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        name: "failing-test",
        test: async (agent) => {
          const r1 = await agent.prompt("Search");
          return r1.toolsCalled().includes("search"); // Will fail
        },
      });

      const result = await test.run(agent, { iterations: 2, concurrency: 1 });
      expect(result.failures).toBe(2);
    });
  });

  describe("concurrency control", () => {
    it("should limit parallel executions to concurrency value", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const agent = createMockAgent(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "concurrency-test",
        prompt: "Test",
      });

      await test.run(agent, {
        iterations: 10,
        concurrency: 3,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it("should default to concurrency of 5", async () => {
      let maxConcurrent = 0;
      let concurrent = 0;

      const agent = createMockAgent(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "default-concurrency",
        prompt: "Test",
      });

      await test.run(agent, { iterations: 15 });

      expect(maxConcurrent).toBeLessThanOrEqual(5);
    });
  });

  describe("retry behavior", () => {
    it("should retry on failure up to retries count", async () => {
      let attempts = 0;

      const agent = createMockAgent(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Temporary failure");
        }
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "retry-test",
        prompt: "Test",
      });

      const result = await test.run(agent, {
        iterations: 1,
        retries: 3,
        concurrency: 1,
      });

      expect(attempts).toBe(3);
      expect(result.successes).toBe(1);
    });

    it("should fail after exhausting retries", async () => {
      let attempts = 0;

      const agent = createMockAgent(async () => {
        attempts++;
        throw new Error("Persistent failure");
      });

      const test = new EvalTest({
        name: "exhausted-retries",
        prompt: "Test",
      });

      const result = await test.run(agent, {
        iterations: 1,
        retries: 2,
        concurrency: 1,
      });

      expect(attempts).toBe(3); // 1 initial + 2 retries
      expect(result.failures).toBe(1);
      expect(result.iterationDetails[0].error).toBe("Persistent failure");
    });

    it("should track retry count in iteration details", async () => {
      let attemptCount = 0;

      const agent = createMockAgent(async () => {
        attemptCount++;
        if (attemptCount === 2) {
          return createMockPromptResult({});
        }
        throw new Error("Fail first time");
      });

      const test = new EvalTest({
        name: "retry-count-test",
        prompt: "Test",
      });

      const result = await test.run(agent, {
        iterations: 1,
        retries: 2,
        concurrency: 1,
      });

      expect(result.iterationDetails[0].retryCount).toBe(1);
    });
  });

  describe("timeout handling", () => {
    it("should timeout after timeoutMs", async () => {
      const agent = createMockAgent(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "timeout-test",
        prompt: "Test",
      });

      const result = await test.run(agent, {
        iterations: 1,
        timeoutMs: 50,
        concurrency: 1,
      });

      expect(result.failures).toBe(1);
      expect(result.iterationDetails[0].error).toContain("timed out");
    });

    it("should use default timeout of 30000ms", async () => {
      const agent = createMockAgent(async () => {
        // This should complete before 30s timeout
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "default-timeout",
        prompt: "Test",
      });

      const result = await test.run(agent, { iterations: 1 });
      expect(result.successes).toBe(1);
    });
  });

  describe("progress callback", () => {
    it("should call onProgress after each iteration", async () => {
      const progressCalls: [number, number][] = [];

      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "progress-test",
        prompt: "Test",
      });

      await test.run(agent, {
        iterations: 3,
        concurrency: 1,
        onProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      });

      expect(progressCalls).toContainEqual([1, 3]);
      expect(progressCalls).toContainEqual([2, 3]);
      expect(progressCalls).toContainEqual([3, 3]);
    });
  });

  describe("latency statistics", () => {
    it("should calculate latency stats correctly", async () => {
      let callCount = 0;

      const agent = createMockAgent(async () => {
        callCount++;
        return createMockPromptResult({
          latency: {
            e2eMs: callCount * 100,
            llmMs: callCount * 80,
            mcpMs: callCount * 20,
          },
        });
      });

      const test = new EvalTest({
        name: "latency-test",
        prompt: "Test",
      });

      const result = await test.run(agent, {
        iterations: 5,
        concurrency: 1,
      });

      expect(result.latency.e2e.min).toBe(100);
      expect(result.latency.e2e.max).toBe(500);
      expect(result.latency.e2e.mean).toBe(300);
      expect(result.latency.e2e.count).toBe(5);
    });

    it("should flatten multi-turn latencies for stats", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({
          latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        });
      });

      const test = new EvalTest({
        name: "multi-turn-latency",
        test: async (agent) => {
          await agent.prompt("First");
          await agent.prompt("Second");
          return true;
        },
      });

      // Multi-turn tests should use concurrency: 1 to avoid shared state issues
      const result = await test.run(agent, {
        iterations: 2,
        concurrency: 1,
      });

      // 2 iterations * 2 prompts = 4 latency entries
      expect(result.latency.perIteration).toHaveLength(4);
      expect(result.latency.e2e.count).toBe(4);
    });
  });

  describe("token usage", () => {
    it("should aggregate token usage across iterations", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ tokens: 100 });
      });

      const test = new EvalTest({
        name: "token-test",
        prompt: "Test",
      });

      const result = await test.run(agent, { iterations: 5 });

      expect(result.tokenUsage.total).toBe(500);
      expect(result.tokenUsage.perIteration).toEqual([100, 100, 100, 100, 100]);
    });

    it("should aggregate tokens from multi-turn conversations", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ tokens: 50 });
      });

      const test = new EvalTest({
        name: "multi-turn-tokens",
        test: async (agent) => {
          await agent.prompt("First");
          await agent.prompt("Second");
          return true;
        },
      });

      // Multi-turn tests should use concurrency: 1 to avoid shared state issues
      const result = await test.run(agent, { iterations: 2, concurrency: 1 });

      // Each iteration has 2 prompts of 50 tokens = 100 per iteration
      expect(result.tokenUsage.perIteration).toEqual([100, 100]);
      expect(result.tokenUsage.total).toBe(200);
    });
  });

  describe("error handling", () => {
    it("should preserve error messages in iteration details", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ error: "Tool execution failed" });
      });

      const test = new EvalTest({
        name: "error-test",
        prompt: "Test",
      });

      const result = await test.run(agent, { iterations: 1 });
      expect(result.iterationDetails[0].error).toBe("Tool execution failed");
    });

    it("should throw if invalid config provided", async () => {
      const agent = createMockAgent(async () => createMockPromptResult({}));

      const test = new EvalTest({
        name: "invalid-config",
        // No prompt or test
      });

      await expect(test.run(agent, { iterations: 1 })).rejects.toThrow(
        "Invalid config"
      );
    });
  });

  describe("metrics", () => {
    it("should calculate accuracy correctly", async () => {
      let counter = 0;

      const agent = createMockAgent(async () => {
        counter++;
        return createMockPromptResult({
          toolsCalled: counter <= 8 ? ["add"] : [],
        });
      });

      const test = new EvalTest({
        name: "accuracy-test",
        prompt: "Test",
        expectTools: ["add"],
      });

      await test.run(agent, {
        iterations: 10,
        concurrency: 1,
      });

      expect(test.accuracy()).toBe(0.8);
    });

    it("should throw if metrics called before run", () => {
      const test = new EvalTest({
        name: "no-run",
        prompt: "Test",
      });

      expect(() => test.accuracy()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => test.recall()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => test.precision()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => test.falsePositiveRate()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => test.averageTokenUse()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should calculate falsePositiveRate correctly", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        name: "fpr-test",
        prompt: "Test",
        expectTools: ["add"], // Will all fail
      });

      await test.run(agent, { iterations: 10 });

      expect(test.falsePositiveRate()).toBe(1.0);
    });

    it("should calculate averageTokenUse correctly", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ tokens: 150 });
      });

      const test = new EvalTest({
        name: "avg-tokens",
        prompt: "Test",
      });

      await test.run(agent, { iterations: 4 });

      expect(test.averageTokenUse()).toBe(150);
    });
  });

  describe("getResults", () => {
    it("should return null before run", () => {
      const test = new EvalTest({
        name: "no-results",
        prompt: "Test",
      });
      expect(test.getResults()).toBeNull();
    });

    it("should return results after run", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "with-results",
        prompt: "Test",
      });

      await test.run(agent, { iterations: 3 });

      const results = test.getResults();
      expect(results).not.toBeNull();
      expect(results?.iterations).toBe(3);
      expect(results?.iterationDetails).toHaveLength(3);
    });
  });

  describe("iteration getters", () => {
    it("should throw if getAllIterations called before run", () => {
      const test = new EvalTest({
        name: "no-run",
        prompt: "Test",
      });
      expect(() => test.getAllIterations()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should throw if getFailedIterations called before run", () => {
      const test = new EvalTest({
        name: "no-run",
        prompt: "Test",
      });
      expect(() => test.getFailedIterations()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should throw if getSuccessfulIterations called before run", () => {
      const test = new EvalTest({
        name: "no-run",
        prompt: "Test",
      });
      expect(() => test.getSuccessfulIterations()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should return all iterations", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "all-iterations",
        prompt: "Test",
      });

      await test.run(agent, { iterations: 5 });

      const all = test.getAllIterations();
      expect(all).toHaveLength(5);
    });

    it("should return only failed iterations", async () => {
      let count = 0;
      const agent = createMockAgent(async () => {
        count++;
        return createMockPromptResult({
          toolsCalled: count <= 3 ? ["add"] : [],
        });
      });

      const test = new EvalTest({
        name: "failed-iterations",
        prompt: "Test",
        expectTools: ["add"],
      });

      await test.run(agent, { iterations: 5, concurrency: 1 });

      const failed = test.getFailedIterations();
      expect(failed).toHaveLength(2);
      failed.forEach((iter) => expect(iter.passed).toBe(false));
    });

    it("should return only successful iterations", async () => {
      let count = 0;
      const agent = createMockAgent(async () => {
        count++;
        return createMockPromptResult({
          toolsCalled: count <= 3 ? ["add"] : [],
        });
      });

      const test = new EvalTest({
        name: "successful-iterations",
        prompt: "Test",
        expectTools: ["add"],
      });

      await test.run(agent, { iterations: 5, concurrency: 1 });

      const successful = test.getSuccessfulIterations();
      expect(successful).toHaveLength(3);
      successful.forEach((iter) => expect(iter.passed).toBe(true));
    });

    it("should return a copy of iterations array", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        name: "copy-test",
        prompt: "Test",
      });

      await test.run(agent, { iterations: 3 });

      const all1 = test.getAllIterations();
      const all2 = test.getAllIterations();
      expect(all1).not.toBe(all2);
      expect(all1).toEqual(all2);
    });
  });
});
