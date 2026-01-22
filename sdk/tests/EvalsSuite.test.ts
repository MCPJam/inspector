import { EvalsSuite } from "../src/EvalsSuite";
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

describe("EvalsSuite", () => {
  describe("constructor", () => {
    it("should create an instance with default name", () => {
      const suite = new EvalsSuite();
      expect(suite.getName()).toBe("EvalsSuite");
    });

    it("should accept custom name", () => {
      const suite = new EvalsSuite({ name: "CustomSuite" });
      expect(suite.getName()).toBe("CustomSuite");
    });
  });

  describe("single-turn mode", () => {
    it("should run iterations with query and track results", async () => {
      const suite = new EvalsSuite();
      let callCount = 0;

      const agent = createMockAgent(async () => {
        callCount++;
        return createMockQueryResult({ toolsCalled: ["add"] });
      });

      const result = await suite.run({
        agent,
        query: "Add 2 and 3",
        iterations: 5,
        expectTools: ["add"],
      });

      expect(callCount).toBe(5);
      expect(result.iterations).toBe(5);
      expect(result.successes).toBe(5);
      expect(result.failures).toBe(0);
      expect(result.results).toEqual([true, true, true, true, true]);
    });

    it("should use expectTools with matchToolCallsSubset", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["add", "multiply"] });
      });

      const result = await suite.run({
        agent,
        query: "Add and multiply",
        iterations: 3,
        expectTools: ["add"], // Should pass even with extra tools
      });

      expect(result.successes).toBe(3);
    });

    it("should use expectExactTools with matchToolCalls", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["add", "multiply"] });
      });

      // Exact match - wrong order
      const result1 = await suite.run({
        agent,
        query: "Test",
        iterations: 2,
        expectExactTools: ["multiply", "add"],
      });
      expect(result1.failures).toBe(2);

      // Exact match - correct order
      const result2 = await suite.run({
        agent,
        query: "Test",
        iterations: 2,
        expectExactTools: ["add", "multiply"],
      });
      expect(result2.successes).toBe(2);
    });

    it("should use expectAnyTool with matchAnyToolCall", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["add"] });
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 2,
        expectAnyTool: ["subtract", "add", "multiply"],
      });

      expect(result.successes).toBe(2);
    });

    it("should use expectNoTools with matchNoToolCalls", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: [] });
      });

      const result = await suite.run({
        agent,
        query: "Just respond",
        iterations: 2,
        expectNoTools: true,
      });

      expect(result.successes).toBe(2);
    });

    it("should use custom validator when provided", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({
          text: "The answer is 42",
          toolsCalled: ["add"],
        });
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 3,
        validator: (result) => result.text.includes("42"),
      });

      expect(result.successes).toBe(3);
    });

    it("should support async validators", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ text: "response" });
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 2,
        validator: async (result) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return result.text.length > 0;
        },
      });

      expect(result.successes).toBe(2);
    });

    it("should default to pass if no error when no expectations set", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 2,
      });

      expect(result.successes).toBe(2);
    });

    it("should fail when there is an error and no expectations", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ error: "Something went wrong" });
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 2,
      });

      expect(result.failures).toBe(2);
    });
  });

  describe("multi-turn conversation mode", () => {
    it("should run conversation function and aggregate results", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: ["search"] });
      });

      const result = await suite.run({
        agent,
        iterations: 3,
        conversation: async (agent) => {
          const r1 = await agent.query("Search for X");
          const r2 = await agent.query("Summarize results");
          return {
            pass: r1.toolsCalled().includes("search"),
            results: [r1, r2],
          };
        },
      });

      expect(result.successes).toBe(3);
      // Should have 2 latencies per iteration (2 queries in conversation)
      expect(result.latency.perIteration.length).toBe(6);
    });

    it("should handle conversation failures", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: [] });
      });

      const result = await suite.run({
        agent,
        iterations: 2,
        conversation: async (agent) => {
          const r1 = await agent.query("Search");
          return {
            pass: r1.toolsCalled().includes("search"), // Will fail
            results: [r1],
          };
        },
      });

      expect(result.failures).toBe(2);
    });
  });

  describe("multi-case mode", () => {
    it("should run all test cases with iterations", async () => {
      const suite = new EvalsSuite();
      const queries: string[] = [];

      const agent = createMockAgent(async (prompt) => {
        queries.push(prompt);
        if (prompt.includes("Add")) {
          return createMockQueryResult({ toolsCalled: ["add"] });
        } else {
          return createMockQueryResult({ toolsCalled: ["multiply"] });
        }
      });

      const result = await suite.run({
        agent,
        iterations: 2,
        cases: [
          { name: "addition", query: "Add 2+3", expectTools: ["add"] },
          {
            name: "multiply",
            query: "Multiply 4*5",
            expectTools: ["multiply"],
          },
        ],
      });

      expect(queries).toHaveLength(4); // 2 cases * 2 iterations
      expect(result.iterations).toBe(4);
      expect(result.successes).toBe(4);
      expect(result.caseResults).toHaveLength(2);
      expect(result.caseResults![0].name).toBe("addition");
      expect(result.caseResults![0].accuracy).toBe(1);
      expect(result.caseResults![1].name).toBe("multiply");
      expect(result.caseResults![1].accuracy).toBe(1);
    });

    it("should track per-case statistics", async () => {
      const suite = new EvalsSuite();
      let addCount = 0;

      const agent = createMockAgent(async (prompt) => {
        if (prompt.includes("Add")) {
          addCount++;
          // Fail every other add
          if (addCount % 2 === 0) {
            return createMockQueryResult({ toolsCalled: [] });
          }
          return createMockQueryResult({ toolsCalled: ["add"] });
        }
        return createMockQueryResult({ toolsCalled: ["multiply"] });
      });

      const result = await suite.run({
        agent,
        iterations: 4,
        cases: [
          { name: "addition", query: "Add 2+3", expectTools: ["add"] },
          { name: "multiply", query: "Multiply", expectTools: ["multiply"] },
        ],
      });

      const addCase = result.caseResults!.find((c) => c.name === "addition");
      expect(addCase!.successes).toBe(2);
      expect(addCase!.failures).toBe(2);
      expect(addCase!.accuracy).toBe(0.5);

      const multiplyCase = result.caseResults!.find(
        (c) => c.name === "multiply"
      );
      expect(multiplyCase!.accuracy).toBe(1);
    });
  });

  describe("concurrency control", () => {
    it("should limit parallel executions to concurrency value", async () => {
      const suite = new EvalsSuite();
      let concurrent = 0;
      let maxConcurrent = 0;

      const agent = createMockAgent(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return createMockQueryResult({});
      });

      await suite.run({
        agent,
        query: "Test",
        iterations: 10,
        concurrency: 3,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it("should default to concurrency of 5", async () => {
      const suite = new EvalsSuite();
      let maxConcurrent = 0;
      let concurrent = 0;

      const agent = createMockAgent(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
        return createMockQueryResult({});
      });

      await suite.run({
        agent,
        query: "Test",
        iterations: 15,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(5);
    });
  });

  describe("retry behavior", () => {
    it("should retry on failure up to retries count", async () => {
      const suite = new EvalsSuite();
      let attempts = 0;

      const agent = createMockAgent(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Temporary failure");
        }
        return createMockQueryResult({});
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 1,
        retries: 3,
        concurrency: 1,
      });

      expect(attempts).toBe(3);
      expect(result.successes).toBe(1);
    });

    it("should fail after exhausting retries", async () => {
      const suite = new EvalsSuite();
      let attempts = 0;

      const agent = createMockAgent(async () => {
        attempts++;
        throw new Error("Persistent failure");
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 1,
        retries: 2,
        concurrency: 1,
      });

      expect(attempts).toBe(3); // 1 initial + 2 retries
      expect(result.failures).toBe(1);
      expect(result.iterationDetails[0].error).toBe("Persistent failure");
    });

    it("should track retry count in iteration details", async () => {
      const suite = new EvalsSuite();
      let attemptCount = 0;

      const agent = createMockAgent(async () => {
        attemptCount++;
        if (attemptCount === 2) {
          return createMockQueryResult({});
        }
        throw new Error("Fail first time");
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 1,
        retries: 2,
        concurrency: 1,
      });

      expect(result.iterationDetails[0].retryCount).toBe(1);
    });
  });

  describe("timeout handling", () => {
    it("should timeout after timeoutMs", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return createMockQueryResult({});
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 1,
        timeoutMs: 50,
        concurrency: 1,
      });

      expect(result.failures).toBe(1);
      expect(result.iterationDetails[0].error).toContain("timed out");
    });

    it("should use default timeout of 30000ms", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        // This should complete before 30s timeout
        return createMockQueryResult({});
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 1,
      });

      expect(result.successes).toBe(1);
    });
  });

  describe("progress callback", () => {
    it("should call onProgress after each iteration", async () => {
      const suite = new EvalsSuite();
      const progressCalls: [number, number][] = [];

      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      await suite.run({
        agent,
        query: "Test",
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

    it("should report correct total for multi-case", async () => {
      const suite = new EvalsSuite();
      const progressCalls: [number, number][] = [];

      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      await suite.run({
        agent,
        iterations: 2,
        cases: [{ query: "A" }, { query: "B" }],
        concurrency: 1,
        onProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      });

      // 2 cases * 2 iterations = 4 total
      expect(progressCalls[progressCalls.length - 1]).toEqual([4, 4]);
    });
  });

  describe("latency statistics", () => {
    it("should calculate latency stats correctly", async () => {
      const suite = new EvalsSuite();
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

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 5,
        concurrency: 1,
      });

      expect(result.latency.e2e.min).toBe(100);
      expect(result.latency.e2e.max).toBe(500);
      expect(result.latency.e2e.mean).toBe(300);
      expect(result.latency.e2e.count).toBe(5);
    });

    it("should flatten multi-turn latencies for stats", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({
          latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        });
      });

      const result = await suite.run({
        agent,
        iterations: 2,
        conversation: async (agent) => {
          const r1 = await agent.query("First");
          const r2 = await agent.query("Second");
          return { pass: true, results: [r1, r2] };
        },
        concurrency: 1,
      });

      // 2 iterations * 2 queries = 4 latency entries
      expect(result.latency.perIteration).toHaveLength(4);
      expect(result.latency.e2e.count).toBe(4);
    });
  });

  describe("token usage", () => {
    it("should aggregate token usage across iterations", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 100 });
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 5,
      });

      expect(result.tokenUsage.total).toBe(500);
      expect(result.tokenUsage.perIteration).toEqual([100, 100, 100, 100, 100]);
    });

    it("should aggregate tokens from multi-turn conversations", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 50 });
      });

      const result = await suite.run({
        agent,
        iterations: 2,
        conversation: async (agent) => {
          const r1 = await agent.query("First");
          const r2 = await agent.query("Second");
          return { pass: true, results: [r1, r2] };
        },
      });

      // Each iteration has 2 queries of 50 tokens = 100 per iteration
      expect(result.tokenUsage.perIteration).toEqual([100, 100]);
      expect(result.tokenUsage.total).toBe(200);
    });
  });

  describe("error handling", () => {
    it("should preserve error messages in iteration details", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ error: "Tool execution failed" });
      });

      const result = await suite.run({
        agent,
        query: "Test",
        iterations: 1,
      });

      expect(result.iterationDetails[0].error).toBe("Tool execution failed");
    });

    it("should throw if invalid config provided", async () => {
      const suite = new EvalsSuite();
      const agent = createMockAgent(async () => createMockQueryResult({}));

      await expect(
        suite.run({
          agent,
          iterations: 1,
          // No query, conversation, or cases
        })
      ).rejects.toThrow("Invalid config");
    });
  });

  describe("metrics", () => {
    it("should calculate accuracy correctly", async () => {
      const suite = new EvalsSuite();
      let counter = 0;

      const agent = createMockAgent(async () => {
        counter++;
        return createMockQueryResult({
          toolsCalled: counter <= 8 ? ["add"] : [],
        });
      });

      await suite.run({
        agent,
        query: "Test",
        iterations: 10,
        expectTools: ["add"],
        concurrency: 1,
      });

      expect(suite.accuracy()).toBe(0.8);
    });

    it("should throw if metrics called before run", () => {
      const suite = new EvalsSuite();

      expect(() => suite.accuracy()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.recall()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.precision()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.falsePositiveRate()).toThrow(
        "No run results available. Call run() first."
      );
      expect(() => suite.averageTokenUse()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should calculate falsePositiveRate correctly", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: [] });
      });

      await suite.run({
        agent,
        query: "Test",
        iterations: 10,
        expectTools: ["add"], // Will all fail
      });

      expect(suite.falsePositiveRate()).toBe(1.0);
    });

    it("should calculate averageTokenUse correctly", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 150 });
      });

      await suite.run({
        agent,
        query: "Test",
        iterations: 4,
      });

      expect(suite.averageTokenUse()).toBe(150);
    });
  });

  describe("getResults", () => {
    it("should return null before run", () => {
      const suite = new EvalsSuite();
      expect(suite.getResults()).toBeNull();
    });

    it("should return results after run", async () => {
      const suite = new EvalsSuite();

      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      await suite.run({
        agent,
        query: "Test",
        iterations: 3,
      });

      const results = suite.getResults();
      expect(results).not.toBeNull();
      expect(results?.iterations).toBe(3);
      expect(results?.iterationDetails).toHaveLength(3);
    });
  });
});
