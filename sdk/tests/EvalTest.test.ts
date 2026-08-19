import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import type { HostRunner } from "../src/HostRunner";

// Mock PromptResult factory
function createMockPromptResult(options: {
  text?: string;
  toolsCalled?: string[];
  tokens?: number;
  latency?: { e2eMs: number; llmMs: number; mcpMs: number };
  error?: string;
  prompt?: string;
  /** Tool spans whose execution failed — what `noToolErrors` must detect. */
  failedToolSpans?: string[];
}): PromptResult {
  const prompt = options.prompt ?? "Test prompt";
  const text = options.text ?? "Test response";
  return PromptResult.from({
    prompt,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: text },
    ],
    text,
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
    spans: (options.failedToolSpans ?? []).map((name, index) => ({
      category: "tool" as const,
      status: "error" as const,
      name,
      startMs: index,
      endMs: index + 1,
    })),
  } as any);
}

// Create a mock HostRunner with prompt history tracking
function createMockAgent(
  promptFn: (message: string, options?: any) => Promise<PromptResult>
): HostRunner {
  const createAgent = (): HostRunner => {
    let promptHistory: PromptResult[] = [];
    return {
      run: async (message: string, options?: any) => {
        const result = await promptFn(message, options);
        promptHistory.push(result);
        return result;
      },
      resetPromptHistory: () => {
        promptHistory = [];
      },
      getPromptHistory: () => [...promptHistory],
      withOptions: () => createAgent(),
    } as unknown as HostRunner;
  };
  return createAgent();
}

describe("EvalTest", () => {
  describe("constructor", () => {
    it("should create an instance with name", () => {
      const test = new EvalTest({
        id: "c_case_1",
        name: "test-name",
        test: async (agent) => {
          await agent.run("Test prompt");
          return true;
        },
      });
      expect(test.getName()).toBe("test-name");
    });

    describe("declared identity", () => {
      it("exposes the declared id", () => {
        const test = new EvalTest({
          id: "c_declared",
          name: "test-name",
          test: async () => true,
        });
        expect(test.getId()).toBe("c_declared");
      });

      it("throws without an id, and the message carries a mintable one", () => {
        // Fail-fast with the fix in the message. Deriving an id from `name`
        // would recreate the exact bug the field retires — rename the test,
        // fork its hosted history — while looking like it worked.
        expect(
          () =>
            new EvalTest({
              name: "no-id",
              test: async () => true,
            } as unknown as ConstructorParameters<typeof EvalTest>[0])
        ).toThrow(/has no `id`/);

        let message = "";
        try {
          new EvalTest({
            name: "no-id",
            test: async () => true,
          } as unknown as ConstructorParameters<typeof EvalTest>[0]);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("identity is declared, not derived");
        expect(message).toMatch(/id: "c_[A-Za-z0-9_-]{21}"/);
      });

      it("throws on an id that cannot travel in a URL or a path", () => {
        expect(
          () =>
            new EvalTest({
              id: "refund flow/1",
              name: "bad-id",
              test: async () => true,
            })
        ).toThrow(/invalid `id`/);
      });

      it("gives a non-conforming externalCaseId the WHOLE migration at once", () => {
        // A pre-6 config with an `externalCaseId` that cannot be an id and no
        // `id` at all. Suggesting a bare mint here would prescribe a change
        // that fails on the very next construction — the minted id beside the
        // unchanged external id is exactly the pair `assertSingleCaseIdentity`
        // rejects — so this error has to state both halves.
        let message = "";
        try {
          new EvalTest({
            externalCaseId: "refund flow/1",
            name: "pre-6 config",
            test: async () => true,
          } as unknown as ConstructorParameters<typeof EvalTest>[0]);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("has no `id`");
        expect(message).toContain("cannot itself be an id");
        expect(message).toContain("BOTH fields");

        // And the fix it prescribes must actually construct.
        const suggested = message.match(/id: "([^"]+)"/)?.[1];
        expect(suggested).toMatch(/^c_[A-Za-z0-9_-]+$/);
        expect(
          () =>
            new EvalTest({
              id: suggested!,
              externalCaseId: suggested!,
              name: "pre-6 config",
              test: async () => true,
            })
        ).not.toThrow();
      });

      it("refuses two disagreeing identity claims, naming the migration", () => {
        // `id` and `externalCaseId` both ride the wire now, so a differing
        // pair is a hard error rather than a silent precedence — the same
        // rule the backend applies at ingest, applied a run earlier.
        let message = "";
        try {
          new EvalTest({
            id: "c_minted",
            externalCaseId: "legacy_case_7",
            name: "two-identities",
            test: async () => true,
          });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("declares two different identities");
        expect(message).toContain('id "c_minted"');
        expect(message).toContain('externalCaseId "legacy_case_7"');
        // The migration rule, stated as the fix: id := externalCaseId.
        expect(message).toContain("external:legacy_case_7");
        expect(message).toContain('id: "legacy_case_7"');
        // And why shipping it anyway is not an option.
        expect(message).toContain("rejected at ingest");
      });

      it("accepts the migrated pair, and an empty externalCaseId", () => {
        expect(
          () =>
            new EvalTest({
              id: "legacy_case_7",
              externalCaseId: "legacy_case_7",
              name: "migrated",
              test: async () => true,
            })
        ).not.toThrow();
        // `""` is absent, not a second claim — `getCaseKey` and the backend's
        // equality rule both read it as "no external id".
        expect(
          () =>
            new EvalTest({
              id: "c_minted",
              externalCaseId: "",
              name: "empty-external",
              test: async () => true,
            })
        ).not.toThrow();
      });

      it("tells a non-conforming externalCaseId to rename, not to migrate", () => {
        // The one behavior break in this step. W0.1a suggested a freshly
        // MINTED id for these configs (`suggestedCaseId` only reuses an
        // `externalCaseId` that can BE an id), so the pair it produced now
        // throws — and no `id` can equal a value outside the charset, so the
        // fix cannot be `id := externalCaseId`.
        let message = "";
        try {
          new EvalTest({
            id: "c_minted",
            externalCaseId: "refund flow/1",
            name: "unmintable-external",
            test: async () => true,
          });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("declares two different identities");
        expect(message).toContain("cannot itself be an id");
        expect(message).toContain("Rename the external id");
        // Never the migration that the very next construction would reject.
        expect(message).not.toContain('id: "refund flow/1"');
      });

      it("accepts ids the platform already issues", () => {
        for (const id of [
          "jd7fk3m2q9x5p1v8s4t6w0y2z",
          "ui_V1StGXR8Z5jdHi",
          "a",
        ]) {
          expect(
            () => new EvalTest({ id, name: id, test: async () => true })
          ).not.toThrow();
        }
      });
    });

    it("should store config", () => {
      const testFn = async (agent: HostRunner) => {
        const r = await agent.run("Test prompt");
        return r.hasToolCall("add");
      };
      const config = {
        id: "c_case_stored",
        name: "test",
        test: testFn,
      };
      const test = new EvalTest(config);
      expect(test.getConfig()).toEqual(config);
    });

    it("should store expectedToolCalls in config", () => {
      const expected = [
        { toolName: "add", arguments: { a: 1, b: 2 } },
        { toolName: "format" },
      ];
      const test = new EvalTest({
        id: "c_case_2",
        name: "with-expected",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
        expectedToolCalls: expected,
      });
      expect(test.getConfig().expectedToolCalls).toEqual(expected);
    });

    it("should have undefined expectedToolCalls when not provided", () => {
      const test = new EvalTest({
        id: "c_case_3",
        name: "without-expected",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });
      expect(test.getConfig().expectedToolCalls).toBeUndefined();
    });

    it("validates matcher options at construction", () => {
      expect(
        () =>
          new EvalTest({
            id: "c_case_4",
            name: "invalid-match-options",
            matchOptions: { maxExtraToolCalls: -1 },
            test: async () => true,
          })
      ).toThrow(/maxExtraToolCalls/);
    });

    it("should throw if no test function provided", () => {
      expect(() => {
        new EvalTest({
          id: "c_case_5",
          name: "invalid-config",
        } as any);
      }).toThrow("Invalid config: must provide 'test' function");
    });

    it.each([
      "widgetRendered",
      "widgetRenderLatencyUnder",
      "widgetNoConsoleErrors",
    ])("rejects %s at construction — it can never pass code-first", (type) => {
      // These read `renderObservations`, which only the hosted headless
      // browser captures, and they fail CLOSED. Accepting one would mean
      // every iteration fails with a confusing reason; the author must hear
      // about it once, up front.
      expect(
        () =>
          new EvalTest({
            id: "c_case_6",
            name: `widget-${type}`,
            predicates: [{ type, toolName: "render" } as any],
            test: async () => true,
          })
      ).toThrow(/only a hosted run captures/);
    });

    it("accepts transcript-evaluable predicates", () => {
      expect(
        () =>
          new EvalTest({
            id: "c_case_7",
            name: "ok-predicates",
            predicates: [
              { type: "toolCalledAtLeastOnce", toolName: "finish" },
              { type: "noToolErrors" },
            ],
            test: async () => true,
          })
      ).not.toThrow();
    });
  });

  describe("basic test execution", () => {
    it("enforces expected tool calls locally and records the match", async () => {
      const agent = createMockAgent(async () =>
        createMockPromptResult({ toolsCalled: ["actual"] })
      );
      const test = new EvalTest({
        id: "c_case_8",
        name: "expected-tools",
        expectedToolCalls: [{ toolName: "expected" }],
        test: async (executor) => {
          await executor.run("Test");
          return true;
        },
      });
      const result = await test.run(agent, { iterations: 1 });
      expect(result.successes).toBe(0);
      expect(result.iterationDetails[0]?.toolMatch?.missing).toHaveLength(1);
      expect(() => test.precision()).not.toThrow();
      expect(test.recall()).toBe(0);
    });

    it("should run iterations and track results", async () => {
      let callCount = 0;

      const agent = createMockAgent(async () => {
        callCount++;
        return createMockPromptResult({ toolsCalled: ["add"] });
      });

      const test = new EvalTest({
        id: "c_case_9",
        name: "addition",
        test: async (agent) => {
          const r = await agent.run("Add 2 and 3");
          return r.hasToolCall("add");
        },
      });

      const result = await test.run(agent, { iterations: 5 });

      expect(callCount).toBe(5);
      expect(result.iterations).toBe(5);
      expect(result.successes).toBe(5);
      expect(result.failures).toBe(0);
      expect(result.results).toEqual([true, true, true, true, true]);
    });

    it("gates the iteration on deterministic predicates and records verdicts", async () => {
      const agent = createMockAgent(async () =>
        createMockPromptResult({ text: "done", toolsCalled: ["finish"] })
      );
      const test = new EvalTest({
        id: "c_case_10",
        name: "predicate-gate",
        predicates: [
          { type: "toolCalledAtLeastOnce", toolName: "finish" },
          { type: "responseContains", needle: "done" },
        ],
        test: async (executor) => {
          await executor.run("Complete the task");
          return true;
        },
      });
      const result = await test.run(agent, { iterations: 1 });
      expect(result.successes).toBe(1);
      expect(result.iterationDetails[0]?.predicateResults).toHaveLength(2);
      expect(
        result.iterationDetails[0]?.predicateResults?.every((r) => r.passed)
      ).toBe(true);
    });

    it("noToolErrors sees span-level tool failures", async () => {
      // The transcript must be built from the FULL trace, spans included:
      // tool errors are derived from spans, so a message-only trace leaves this
      // predicate with nothing to inspect and it passes vacuously.
      const agent = createMockAgent(async () =>
        createMockPromptResult({
          text: "tried",
          toolsCalled: ["search"],
          failedToolSpans: ["search"],
        })
      );
      const test = new EvalTest({
        id: "c_case_11",
        name: "no-tool-errors",
        predicates: [{ type: "noToolErrors" }],
        test: async (executor) => {
          await executor.run("Search for it");
          return true; // the assertion passes; the predicate must still fail
        },
      });
      const result = await test.run(agent, { iterations: 1 });
      expect(result.successes).toBe(0);
      expect(result.iterationDetails[0]?.predicateResults?.[0]?.passed).toBe(
        false
      );
    });

    it("evaluates predicates against real history on the retry-exhausted path", async () => {
      // A failing iteration may still have called tools. Verdicts must reflect
      // what actually happened, not a fabricated empty transcript.
      const agent = createMockAgent(async () => {
        const result = createMockPromptResult({
          text: "partial",
          toolsCalled: ["finish"],
        });
        return result;
      });
      const test = new EvalTest({
        id: "c_case_12",
        name: "failure-path-predicates",
        predicates: [{ type: "toolCalledAtLeastOnce", toolName: "finish" }],
        test: async (executor) => {
          await executor.run("Do it");
          throw new Error("boom");
        },
      });
      const result = await test.run(agent, { iterations: 1, retries: 0 });
      expect(result.successes).toBe(0);
      const verdicts = result.iterationDetails[0]?.predicateResults;
      expect(verdicts).toHaveLength(1);
      // `finish` WAS called, so the predicate passed even though the iteration
      // failed on the thrown error.
      expect(verdicts?.[0]?.passed).toBe(true);
    });

    it("should check for tool subset matches", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["add", "multiply"] });
      });

      const test = new EvalTest({
        id: "c_case_13",
        name: "test",
        test: async (agent) => {
          const r = await agent.run("Add and multiply");
          // Check if add was called (should pass even with extra tools)
          return r.hasToolCall("add");
        },
      });

      const result = await test.run(agent, { iterations: 3 });
      expect(result.successes).toBe(3);
    });

    it("should check for exact tool matches", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["add", "multiply"] });
      });

      // Wrong order - fails
      const test1 = new EvalTest({
        id: "c_case_14",
        name: "wrong-order",
        test: async (agent) => {
          const r = await agent.run("Test");
          const tools = r.toolsCalled();
          return tools[0] === "multiply" && tools[1] === "add";
        },
      });
      const result1 = await test1.run(agent, { iterations: 2 });
      expect(result1.failures).toBe(2);

      // Correct order - passes
      const test2 = new EvalTest({
        id: "c_case_15",
        name: "correct-order",
        test: async (agent) => {
          const r = await agent.run("Test");
          const tools = r.toolsCalled();
          return tools[0] === "add" && tools[1] === "multiply";
        },
      });
      const result2 = await test2.run(agent, { iterations: 2 });
      expect(result2.successes).toBe(2);
    });

    it("should check for any tool match", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: ["add"] });
      });

      const test = new EvalTest({
        id: "c_case_16",
        name: "any-tool",
        test: async (agent) => {
          const r = await agent.run("Test");
          const tools = r.toolsCalled();
          return ["subtract", "add", "multiply"].some((t) => tools.includes(t));
        },
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should check for no tools called", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        id: "c_case_17",
        name: "no-tools",
        test: async (agent) => {
          const r = await agent.run("Just respond");
          return r.toolsCalled().length === 0;
        },
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should support custom test logic", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({
          text: "The answer is 42",
          toolsCalled: ["add"],
        });
      });

      const test = new EvalTest({
        id: "c_case_18",
        name: "custom-test",
        test: async (agent) => {
          const r = await agent.run("Test");
          return r.text.includes("42");
        },
      });

      const result = await test.run(agent, { iterations: 3 });
      expect(result.successes).toBe(3);
    });

    it("should support async test functions", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ text: "response" });
      });

      const test = new EvalTest({
        id: "c_case_19",
        name: "async-test",
        test: async (agent) => {
          const r = await agent.run("Test");
          await new Promise((resolve) => setTimeout(resolve, 1));
          return r.text.length > 0;
        },
      });

      const result = await test.run(agent, { iterations: 2 });
      expect(result.successes).toBe(2);
    });

    it("should handle error checking", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ error: "Something went wrong" });
      });

      const test = new EvalTest({
        id: "c_case_20",
        name: "with-error",
        test: async (agent) => {
          const r = await agent.run("Test");
          return !r.hasError();
        },
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
        id: "c_case_21",
        name: "conversation",
        test: async (agent) => {
          const r1 = await agent.run("Search for X");
          return r1.toolsCalled().includes("search");
        },
      });

      // Multi-turn tests should use concurrency: 1 to avoid shared state issues
      const result = await test.run(agent, { iterations: 3, concurrency: 1 });

      expect(result.successes).toBe(3);
      // Should have 2 latencies per iteration (2 prompts in conversation)
      expect(result.latency.perIteration.length).toBe(3);
    });

    it("should handle test function failures", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ toolsCalled: [] });
      });

      const test = new EvalTest({
        id: "c_case_22",
        name: "failing-test",
        test: async (agent) => {
          const r1 = await agent.run("Search");
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
        id: "c_case_23",
        name: "concurrency-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_24",
        name: "default-concurrency",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_25",
        name: "retry-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_26",
        name: "exhausted-retries",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_27",
        name: "retry-count-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        id: "c_case_28",
        name: "timeout-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_29",
        name: "default-timeout",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });

      const result = await test.run(agent, { iterations: 1 });
      expect(result.successes).toBe(1);
    });

    it("should pass if a timed-out prompt captured the expected tool call", async () => {
      const agent = createMockAgent(async (message, options) => {
        await new Promise<void>((resolve) => {
          options?.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });

        return createMockPromptResult({
          prompt: message,
          toolsCalled: ["add"],
          tokens: 0,
          error: "Operation timed out after 50ms",
        });
      });

      const test = new EvalTest({
        id: "c_case_30",
        name: "timeout-partial-pass",
        test: async (agent) => {
          const result = await agent.run("Add 2 and 3");
          return result.hasToolCall("add");
        },
      });

      const result = await test.run(agent, {
        iterations: 1,
        timeoutMs: 50,
        concurrency: 1,
      });

      expect(result.successes).toBe(1);
      expect(result.failures).toBe(0);
      expect(result.iterationDetails[0].passed).toBe(true);
      expect(result.iterationDetails[0].error).toBeUndefined();
      expect(result.iterationDetails[0].prompts).toHaveLength(1);
      expect(result.iterationDetails[0].prompts?.[0].hasToolCall("add")).toBe(
        true
      );
      expect(result.iterationDetails[0].prompts?.[0].hasError()).toBe(true);
    });

    it("should preserve earlier prompts and metrics when a later prompt times out", async () => {
      let promptCount = 0;
      const agent = createMockAgent(async (message, options) => {
        promptCount++;

        if (promptCount === 1) {
          return createMockPromptResult({
            prompt: message,
            toolsCalled: ["lookup"],
            tokens: 50,
            latency: { e2eMs: 20, llmMs: 15, mcpMs: 5 },
          });
        }

        await new Promise<void>((resolve) => {
          options?.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });

        return createMockPromptResult({
          prompt: message,
          toolsCalled: ["add"],
          tokens: 0,
          latency: { e2eMs: 50, llmMs: 10, mcpMs: 40 },
          error: "Operation timed out after 50ms",
        });
      });

      const test = new EvalTest({
        id: "c_case_31",
        name: "multi-turn-timeout",
        test: async (agent) => {
          const first = await agent.run("First");
          const second = await agent.run("Second");
          return first.hasToolCall("lookup") && second.hasToolCall("add");
        },
      });

      const result = await test.run(agent, {
        iterations: 1,
        timeoutMs: 50,
        concurrency: 1,
      });

      expect(result.successes).toBe(1);
      expect(result.iterationDetails[0].prompts).toHaveLength(2);
      expect(
        result.iterationDetails[0].prompts?.map((prompt) => prompt.getPrompt())
      ).toEqual(["First", "Second"]);
      expect(result.iterationDetails[0].tokens).toEqual({
        total: 50,
        input: 25,
        output: 25,
      });
      expect(result.iterationDetails[0].latencies).toEqual([
        { e2eMs: 20, llmMs: 15, mcpMs: 5 },
        { e2eMs: 50, llmMs: 10, mcpMs: 40 },
      ]);
    });

    it("should fail after the hard-timeout grace if a prompt ignores abort but preserve captured history", async () => {
      const createHungAgent = (): HostRunner => {
        let promptHistory: PromptResult[] = [];

        return {
          run: async (message: string) => {
            promptHistory.push(
              createMockPromptResult({
                prompt: message,
                toolsCalled: ["add"],
                tokens: 0,
              })
            );

            return await new Promise<PromptResult>(() => {});
          },
          resetPromptHistory: () => {
            promptHistory = [];
          },
          getPromptHistory: () => [...promptHistory],
          withOptions: () => createHungAgent(),
        } as unknown as HostRunner;
      };

      const test = new EvalTest({
        id: "c_case_32",
        name: "hung-timeout",
        test: async (agent) => {
          const result = await agent.run("Add 2 and 3");
          return result.hasToolCall("add");
        },
      });

      const result = await test.run(createHungAgent(), {
        iterations: 1,
        timeoutMs: 25,
        concurrency: 1,
      });

      expect(result.failures).toBe(1);
      expect(result.iterationDetails[0].error).toContain("timed out");
      expect(result.iterationDetails[0].prompts).toHaveLength(1);
      expect(result.iterationDetails[0].prompts?.[0].hasToolCall("add")).toBe(
        true
      );
    }, 5000);
  });

  describe("progress callback", () => {
    it("should call onProgress after each iteration", async () => {
      const progressCalls: [number, number][] = [];

      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        id: "c_case_33",
        name: "progress-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_34",
        name: "latency-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_35",
        name: "multi-turn-latency",
        test: async (agent) => {
          await agent.run("First");
          await agent.run("Second");
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
        id: "c_case_36",
        name: "token-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });

      const result = await test.run(agent, { iterations: 5 });

      expect(result.tokenUsage.total).toBe(500);
      expect(result.tokenUsage.input).toBe(250);
      expect(result.tokenUsage.output).toBe(250);
      expect(result.tokenUsage.perIteration).toEqual([
        { total: 100, input: 50, output: 50 },
        { total: 100, input: 50, output: 50 },
        { total: 100, input: 50, output: 50 },
        { total: 100, input: 50, output: 50 },
        { total: 100, input: 50, output: 50 },
      ]);
    });

    it("should aggregate tokens from multi-turn conversations", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ tokens: 50 });
      });

      const test = new EvalTest({
        id: "c_case_37",
        name: "multi-turn-tokens",
        test: async (agent) => {
          await agent.run("First");
          await agent.run("Second");
          return true;
        },
      });

      // Multi-turn tests should use concurrency: 1 to avoid shared state issues
      const result = await test.run(agent, { iterations: 2, concurrency: 1 });

      // Each iteration has 2 prompts of 50 tokens = 100 per iteration
      expect(result.tokenUsage.perIteration).toEqual([
        { total: 100, input: 50, output: 50 },
        { total: 100, input: 50, output: 50 },
      ]);
      expect(result.tokenUsage.total).toBe(200);
      expect(result.tokenUsage.input).toBe(100);
      expect(result.tokenUsage.output).toBe(100);
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
        id: "c_case_38",
        name: "accuracy-test",
        test: async (agent) => {
          const r = await agent.run("Test");
          return r.hasToolCall("add");
        },
      });

      await test.run(agent, {
        iterations: 10,
        concurrency: 1,
      });

      expect(test.accuracy()).toBe(0.8);
    });

    it("should throw if metrics called before run", () => {
      const test = new EvalTest({
        id: "c_case_39",
        name: "no-run",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_40",
        name: "fpr-test",
        test: async (agent) => {
          const r = await agent.run("Test");
          return r.hasToolCall("add"); // Will all fail
        },
      });

      await test.run(agent, { iterations: 10 });

      expect(test.falsePositiveRate()).toBe(1.0);
    });

    it("should calculate averageTokenUse correctly", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({ tokens: 150 });
      });

      const test = new EvalTest({
        id: "c_case_41",
        name: "avg-tokens",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });

      await test.run(agent, { iterations: 4 });

      expect(test.averageTokenUse()).toBe(150);
    });
  });

  describe("getResults", () => {
    it("should return null before run", () => {
      const test = new EvalTest({
        id: "c_case_42",
        name: "no-results",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });
      expect(test.getResults()).toBeNull();
    });

    it("should return results after run", async () => {
      const agent = createMockAgent(async () => {
        return createMockPromptResult({});
      });

      const test = new EvalTest({
        id: "c_case_43",
        name: "with-results",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_44",
        name: "no-run",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });
      expect(() => test.getAllIterations()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should throw if getFailedIterations called before run", () => {
      const test = new EvalTest({
        id: "c_case_45",
        name: "no-run",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });
      expect(() => test.getFailedIterations()).toThrow(
        "No run results available. Call run() first."
      );
    });

    it("should throw if getSuccessfulIterations called before run", () => {
      const test = new EvalTest({
        id: "c_case_46",
        name: "no-run",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_47",
        name: "all-iterations",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
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
        id: "c_case_48",
        name: "failed-iterations",
        test: async (agent) => {
          const r = await agent.run("Test");
          return r.hasToolCall("add");
        },
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
        id: "c_case_49",
        name: "successful-iterations",
        test: async (agent) => {
          const r = await agent.run("Test");
          return r.hasToolCall("add");
        },
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
        id: "c_case_50",
        name: "copy-test",
        test: async (agent) => {
          await agent.run("Test");
          return true;
        },
      });

      await test.run(agent, { iterations: 3 });

      const all1 = test.getAllIterations();
      const all2 = test.getAllIterations();
      expect(all1).not.toBe(all2);
      expect(all1).toEqual(all2);
    });
  });
});
