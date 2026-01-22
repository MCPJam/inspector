import { EvalSuite } from "../src/EvalSuite";
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

describe("EvalSuite", () => {
  describe("constructor", () => {
    it("should create an instance with default name", () => {
      const suite = new EvalSuite();
      expect(suite.getName()).toBe("EvalSuite");
    });

    it("should accept custom name", () => {
      const suite = new EvalSuite({ name: "Math Operations" });
      expect(suite.getName()).toBe("Math Operations");
    });
  });

  describe("add and get tests", () => {
    it("should add tests and retrieve by name", () => {
      const suite = new EvalSuite();
      const test1 = new EvalTest({ name: "addition", query: "Add 2+3" });
      const test2 = new EvalTest({ name: "multiply", query: "Multiply 4*5" });

      suite.add(test1);
      suite.add(test2);

      expect(suite.get("addition")).toBe(test1);
      expect(suite.get("multiply")).toBe(test2);
      expect(suite.get("nonexistent")).toBeUndefined();
    });

    it("should throw when adding duplicate test name", () => {
      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test", query: "Query 1" }));

      expect(() => {
        suite.add(new EvalTest({ name: "test", query: "Query 2" }));
      }).toThrow('Test with name "test" already exists in suite');
    });

    it("should return all tests with getAll", () => {
      const suite = new EvalSuite();
      const test1 = new EvalTest({ name: "test1", query: "Query 1" });
      const test2 = new EvalTest({ name: "test2", query: "Query 2" });

      suite.add(test1);
      suite.add(test2);

      const all = suite.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(test1);
      expect(all).toContain(test2);
    });

    it("should track suite size", () => {
      const suite = new EvalSuite();
      expect(suite.size()).toBe(0);

      suite.add(new EvalTest({ name: "test1", query: "Query 1" }));
      expect(suite.size()).toBe(1);

      suite.add(new EvalTest({ name: "test2", query: "Query 2" }));
      expect(suite.size()).toBe(2);
    });
  });

  describe("run", () => {
    it("should run all tests and aggregate results", async () => {
      const agent = createMockAgent(async (prompt) => {
        if (prompt.includes("Add")) {
          return createMockQueryResult({ toolsCalled: ["add"] });
        }
        return createMockQueryResult({ toolsCalled: ["multiply"] });
      });

      const suite = new EvalSuite({ name: "Math" });
      suite.add(
        new EvalTest({
          name: "addition",
          query: "Add 2+3",
          expectTools: ["add"],
        })
      );
      suite.add(
        new EvalTest({
          name: "multiply",
          query: "Multiply 4*5",
          expectTools: ["multiply"],
        })
      );

      const result = await suite.run(agent, { iterations: 3 });

      // 2 tests * 3 iterations = 6 total
      expect(result.aggregate.iterations).toBe(6);
      expect(result.aggregate.successes).toBe(6);
      expect(result.aggregate.failures).toBe(0);
      expect(result.aggregate.accuracy).toBe(1);
    });

    it("should allow access to individual test results", async () => {
      const agent = createMockAgent(async (prompt) => {
        if (prompt.includes("Add")) {
          return createMockQueryResult({ toolsCalled: ["add"] });
        }
        return createMockQueryResult({ toolsCalled: [] }); // Multiply fails
      });

      const suite = new EvalSuite();
      suite.add(
        new EvalTest({
          name: "addition",
          query: "Add 2+3",
          expectTools: ["add"],
        })
      );
      suite.add(
        new EvalTest({
          name: "multiply",
          query: "Multiply 4*5",
          expectTools: ["multiply"],
        })
      );

      await suite.run(agent, { iterations: 2 });

      // Access individual test accuracy
      const additionTest = suite.get("addition");
      expect(additionTest!.accuracy()).toBe(1);

      const multiplyTest = suite.get("multiply");
      expect(multiplyTest!.accuracy()).toBe(0);

      // Overall suite accuracy
      expect(suite.accuracy()).toBe(0.5); // 2 success, 2 failures
    });

    it("should report progress across all tests", async () => {
      const progressCalls: [number, number][] = [];

      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test1", query: "Query 1" }));
      suite.add(new EvalTest({ name: "test2", query: "Query 2" }));

      await suite.run(agent, {
        iterations: 2,
        concurrency: 1,
        onProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      });

      // 2 tests * 2 iterations = 4 total
      expect(progressCalls).toContainEqual([4, 4]);
      // Should have incremental progress
      expect(progressCalls.length).toBe(4);
    });

    it("should aggregate token usage across tests", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 100 });
      });

      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test1", query: "Query 1" }));
      suite.add(new EvalTest({ name: "test2", query: "Query 2" }));

      const result = await suite.run(agent, { iterations: 3 });

      // 2 tests * 3 iterations * 100 tokens = 600
      expect(result.aggregate.tokenUsage.total).toBe(600);
      // Each test: 3 iterations * 100 = 300 tokens
      expect(result.aggregate.tokenUsage.perTest).toEqual([300, 300]);
    });

    it("should aggregate latency statistics across tests", async () => {
      let callCount = 0;

      const agent = createMockAgent(async () => {
        callCount++;
        return createMockQueryResult({
          latency: {
            e2eMs: callCount * 10,
            llmMs: callCount * 8,
            mcpMs: callCount * 2,
          },
        });
      });

      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test1", query: "Query 1" }));
      suite.add(new EvalTest({ name: "test2", query: "Query 2" }));

      const result = await suite.run(agent, {
        iterations: 2,
        concurrency: 1,
      });

      // 4 latency values: 10, 20, 30, 40
      expect(result.aggregate.latency.e2e.min).toBe(10);
      expect(result.aggregate.latency.e2e.max).toBe(40);
      expect(result.aggregate.latency.e2e.mean).toBe(25);
      expect(result.aggregate.latency.e2e.count).toBe(4);
    });
  });

  describe("metrics", () => {
    it("should throw if metrics called before run", () => {
      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test", query: "Query" }));

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

    it("should calculate aggregate accuracy", async () => {
      let counter = 0;

      const agent = createMockAgent(async () => {
        counter++;
        // First 3 pass, last 1 fails
        return createMockQueryResult({
          toolsCalled: counter <= 3 ? ["tool"] : [],
        });
      });

      const suite = new EvalSuite();
      suite.add(
        new EvalTest({
          name: "test",
          query: "Query",
          expectTools: ["tool"],
        })
      );

      await suite.run(agent, { iterations: 4, concurrency: 1 });

      expect(suite.accuracy()).toBe(0.75);
    });

    it("should calculate falsePositiveRate", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ toolsCalled: [] });
      });

      const suite = new EvalSuite();
      suite.add(
        new EvalTest({
          name: "test",
          query: "Query",
          expectTools: ["tool"], // Will all fail
        })
      );

      await suite.run(agent, { iterations: 10 });

      expect(suite.falsePositiveRate()).toBe(1.0);
    });

    it("should calculate averageTokenUse", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({ tokens: 200 });
      });

      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test1", query: "Query 1" }));
      suite.add(new EvalTest({ name: "test2", query: "Query 2" }));

      await suite.run(agent, { iterations: 5 });

      // 2 tests * 5 iterations = 10 iterations total
      // Each 200 tokens = 200 average
      expect(suite.averageTokenUse()).toBe(200);
    });
  });

  describe("getResults", () => {
    it("should return null before run", () => {
      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test", query: "Query" }));
      expect(suite.getResults()).toBeNull();
    });

    it("should return results after run", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const suite = new EvalSuite();
      suite.add(new EvalTest({ name: "test1", query: "Query 1" }));
      suite.add(new EvalTest({ name: "test2", query: "Query 2" }));

      await suite.run(agent, { iterations: 2 });

      const results = suite.getResults();
      expect(results).not.toBeNull();
      expect(results?.tests.size).toBe(2);
      expect(results?.tests.has("test1")).toBe(true);
      expect(results?.tests.has("test2")).toBe(true);
      expect(results?.aggregate.iterations).toBe(4);
    });
  });

  describe("Jest integration pattern", () => {
    it("should work with Jest test structure", async () => {
      const agent = createMockAgent(async (prompt) => {
        if (prompt.includes("Add")) {
          return createMockQueryResult({ toolsCalled: ["add"] });
        }
        return createMockQueryResult({ toolsCalled: ["multiply"] });
      });

      // Simulate Jest beforeAll
      const suite = new EvalSuite({ name: "Math" });
      suite.add(
        new EvalTest({
          name: "addition",
          query: "Add 2+3",
          expectTools: ["add"],
        })
      );
      suite.add(
        new EvalTest({
          name: "multiply",
          query: "Multiply 4*5",
          expectTools: ["multiply"],
        })
      );

      await suite.run(agent, { iterations: 10 });

      // Simulate individual Jest tests
      expect(suite.get("addition")!.accuracy()).toBeGreaterThan(0.9);
      expect(suite.get("multiply")!.accuracy()).toBeGreaterThan(0.9);
      expect(suite.accuracy()).toBeGreaterThan(0.9);
    });
  });

  describe("empty suite handling", () => {
    it("should handle running empty suite", async () => {
      const agent = createMockAgent(async () => {
        return createMockQueryResult({});
      });

      const suite = new EvalSuite();
      const result = await suite.run(agent, { iterations: 5 });

      expect(result.aggregate.iterations).toBe(0);
      expect(result.aggregate.accuracy).toBe(0);
      expect(result.tests.size).toBe(0);
    });
  });
});
