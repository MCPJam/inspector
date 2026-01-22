import { EvalTest } from "../src/EvalTest";
import { QueryResult } from "../src/QueryResult";
import type { TestAgent } from "../src/TestAgent";

// Mock QueryResult factory
function createMockQueryResult(options: {
  text?: string;
  toolsCalled?: string[];
  tokens?: number;
  latency?: { e2eMs: number; llmMs: number; mcpMs: number };
  error?: string;
}): QueryResult {
  return QueryResult.from({
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

// Create a mock TestAgent
function createMockAgent(
  queryFn: (prompt: string) => Promise<QueryResult>
): TestAgent {
  return {
    query: queryFn,
  } as TestAgent;
}

describe("EvalTest", () => {
  describe("constructor", () => {
    it("should create an instance with name", () => {
      const test = new EvalTest({ name: "test-name", query: "Test query" });
      expect(test.getName()).toBe("test-name");
    });

    it("should store config", () => {
      const config = {
        name: "test",
        query: "Test query",
        expectTools: ["add"],
      };
      const test = new EvalTest(config);
      expect(test.getConfig()).toEqual(config);
    });
  });

  describe("single-turn mode", () => {
    it("should run iterations with query and track results", async () => {
      let callCount = 0;

      const agent = createMockAgent(async () => {
        callCount++;
        return createMockQueryResult({ toolsCalled: ["add"] });
      });

      const test = new EvalTest({
        name: "addition",
        query: "Add 2 and 3",
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
        return createMockQueryResult({ toolsCalled: ["add", "multiply"] });
      });

      const test = new EvalTest({
        name: "test",
        query: "Add and multiply",
        expectTools: ["add"], // Should pass even with extra tools
      });

      const result = await test.run(agent, { iterations: 3 });
      expect(result.successes).toBe(3);
    });

    it("should use expectExactTools with matchToolCalls", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["add", "multiply"] });
      });

      // Exact match - wrong order
      const test1 = new EvalTest({
        name: "wrong-order",
        query: "Test",
        expectExactTools: ["multiply", "add"],
      });
      const result1 = await test1.run(agent, { iterations: 2 });
      expect(result1.failures).toBe(2);

      // Exact match - correct order
      const test2 = new EvalTest({
        name: "correct-order",
        query: "Test",
        expectExactTools: ["add", "multiply"],
      });
      const result2 = await test2.run(agent, { iterations: 2 });
      expect(result2.successes).toBe(2);
    });

    it("should use expectAnyTool with matchAnyToolCall", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["add"] });
      });

      const test = new EvalTest({
        name: "any-tool",
        query: "Test",
        expectAnyTool: ["subtract", "add", "multiply"],
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should use expectNoTools with matchNoToolCalls", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        name: "no-tools",
        query: "Just respond",
        expectNoTools: true,
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should use custom validator when provided", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({
          text: "The answer is 42",
          toolsCalled: ["add"],
        });
      });

      const test = new EvalTest({
        name: "validator",
        query: "Test",
        validator: (result) => result.text.includes("42"),
      });

      const result = await test.run(agent, { iterations: 3 });
      expect(result.successes).toBe(3);
    });

    it("should support async validators", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ text: "response" });
      });

      const test = new EvalTest({
        name: "async-validator",
        query: "Test",
        validator: async (result) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return result.text.length > 0;
        },
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should default to pass if no error when no expectations set", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "no-expectations",
        query: "Test",
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should fail when there is an error and no expectations", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ error: "Something went wrong" });
      });

      const test = new EvalTest({
        name: "with-error",
        query: "Test",
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.failures).toBe(2);
    });
  });

  describe("multi-turn conversation mode", () => {
    it("should run conversation function and aggregate results", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["search"] });
      });

      const test = new EvalTest({
        name: "conversation",
        conversation: async (agent) => {
          const r1 = await agent.query("Search for X");
          const r2 = await agent.query("Summarize results");
          return {
            pass: r1.toolsCalled().includes("search"),
            results: [r1, r2],
          };
        },
      });

      const result = await test.run(agent, { iterations: 3 });

      expect(result.successes).toBe(3);
      // Should have 2 latencies per iteration (2 queries in conversation)
      expect(result.latency.perIteration.length).toBe(6);
    });

    it("should handle conversation failures", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        name: "failing-conversation",
        conversation: async (agent) => {
          const r1 = await agent.query("Search");
          return {
            pass: r1.toolsCalled().includes("search"), // Will fail
            results: [r1],
          };
        },
      });

      const result = await test.run(agent, { iterations: 2 });
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
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "concurrency-test",
        query: "Test",
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
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "default-concurrency",
        query: "Test",
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
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "retry-test",
        query: "Test",
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
        query: "Test",
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
          return createMockQueryResult({});
        }
        throw new Error("Fail first time");
      });

      const test = new EvalTest({
        name: "retry-count-test",
        query: "Test",
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
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "timeout-test",
        query: "Test",
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
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "default-timeout",
        query: "Test",
      });

      const result = await test.run(agent, { iterations: 1 });
      expect(result.successes).toBe(1);
    });
  });

  describe("progress callback", () => {
    it("should call onProgress after each iteration", async () => {
      const progressCalls: [number, number][] = [];

      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "progress-test",
        query: "Test",
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
        return createMockQueryResult({
          latency: {
            e2eMs: callCount * 100,
            llmMs: callCount * 80,
            mcpMs: callCount * 20,
          },
        });
      });

      const test = new EvalTest({
        name: "latency-test",
        query: "Test",
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
        return createMockQueryResult({
          latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        });
      });

      const test = new EvalTest({
        name: "multi-turn-latency",
        conversation: async (agent) => {
          const r1 = await agent.query("First");
          const r2 = await agent.query("Second");
          return { pass: true, results: [r1, r2] };
        },
      });

      const result = await test.run(agent, {
        iterations: 2,
        concurrency: 1,
      });

      // 2 iterations * 2 queries = 4 latency entries
      expect(result.latency.perIteration).toHaveLength(4);
      expect(result.latency.e2e.count).toBe(4);
    });
  });

  describe("token usage", () => {
    it("should aggregate token usage across iterations", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 100 });
      });

      const test = new EvalTest({
        name: "token-test",
        query: "Test",
      });

      const result = await test.run(agent, { iterations: 5 });

      expect(result.tokenUsage.total).toBe(500);
      expect(result.tokenUsage.perIteration).toEqual([100, 100, 100, 100, 100]);
    });

    it("should aggregate tokens from multi-turn conversations", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 50 });
      });

      const test = new EvalTest({
        name: "multi-turn-tokens",
        conversation: async (agent) => {
          const r1 = await agent.query("First");
          const r2 = await agent.query("Second");
          return { pass: true, results: [r1, r2] };
        },
      });

      const result = await test.run(agent, { iterations: 2 });

      // Each iteration has 2 queries of 50 tokens = 100 per iteration
      expect(result.tokenUsage.perIteration).toEqual([100, 100]);
      expect(result.tokenUsage.total).toBe(200);
    });
  });

  describe("error handling", () => {
    it("should preserve error messages in iteration details", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ error: "Tool execution failed" });
      });

      const test = new EvalTest({
        name: "error-test",
        query: "Test",
      });

      const result = await test.run(agent, { iterations: 1 });
      expect(result.iterationDetails[0].error).toBe("Tool execution failed");
    });

    it("should throw if invalid config provided", async () => {
      const agent = createMockAgent(async () => createMockQueryResult({}));

      const test = new EvalTest({
        name: "invalid-config",
        // No query or conversation
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
        return createMockQueryResult({
          toolsCalled: counter <= 8 ? ["add"] : [],
        });
      });

      const test = new EvalTest({
        name: "accuracy-test",
        query: "Test",
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
        query: "Test",
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
        return createMockQueryResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        name: "fpr-test",
        query: "Test",
        expectTools: ["add"], // Will all fail
      });

      await test.run(agent, { iterations: 10 });

      expect(test.falsePositiveRate()).toBe(1.0);
    });

    it("should calculate averageTokenUse correctly", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 150 });
      });

      const test = new EvalTest({
        name: "avg-tokens",
        query: "Test",
      });

      await test.run(agent, { iterations: 4 });

      expect(test.averageTokenUse()).toBe(150);
    });
  });

  describe("getResults", () => {
    it("should return null before run", () => {
      const test = new EvalTest({
        name: "no-results",
        query: "Test",
      });
      expect(test.getResults()).toBeNull();
    });

    it("should return results after run", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const test = new EvalTest({
        name: "with-results",
        query: "Test",
      });

      await test.run(agent, { iterations: 3 });

      const results = test.getResults();
      expect(results).not.toBeNull();
      expect(results?.iterations).toBe(3);
      expect(results?.iterationDetails).toHaveLength(3);
    });
  });
});
