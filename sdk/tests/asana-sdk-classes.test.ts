import {
  MCPClientManager,
  TestAgent,
  EvalTest,
  EvalSuite,
  PromptResult,
  createEvalRunReporter,
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchToolCallCount,
  matchNoToolCalls,
  matchToolCallWithArgs,
  matchToolCallWithPartialArgs,
  matchToolArgument,
  matchToolArgumentWith,
} from "../src";
import type {
  ToolCall,
  EvalRunReporter,
  IterationResult,
  EvalExpectedToolCall,
} from "../src";

// ─── Self-contained config ──────────────────────────────────────────────────
const MCPJAM_API_KEY =
  process.env.MCPJAM_API_KEY ??
  "mcpjam_971F6E_6b1ea49ae8dee67a9c56febac4e2ab65eeca7d6e32b7ea31";
const MCPJAM_BASE_URL =
  process.env.MCPJAM_BASE_URL ??
  "https://exuberant-albatross-496.convex.site";
const RUN_INGESTION_TESTS = Boolean(MCPJAM_API_KEY);
const SUITE_NAME = "Asana SDK Ingestion Shared";
const EXPECTED_ITERATIONS = 23;

// ─── LLM + Asana live config ────────────────────────────────────────────────
const ASANA_MCP_URL = process.env.ASANA_MCP_URL ?? "https://mcp.asana.com/sse";
const ASANA_REFRESH_TOKEN =
  process.env.ASANA_REFRESH_TOKEN ??
  "1211188104086718:2g4SKFWr6shyeA6q:02HFFBIeWIaXGqoI2D6XNDflo4KUlu4U";
const ASANA_CLIENT_ID = process.env.ASANA_CLIENT_ID ?? "j0ZRxPiUHOqFXDXw";
const ASANA_CLIENT_SECRET = process.env.ASANA_CLIENT_SECRET;
const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY ??
  "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";
const GPT5_MINI_MODEL = process.env.ASANA_EVAL_MODEL ?? "openrouter/openai/gpt-5-mini";
const NANO_MODEL = process.env.NANO_EVAL_MODEL ?? "openrouter/openai/gpt-5-nano";
const ASANA_SERVER_ID = "asana";

// ─── Shared prompts ─────────────────────────────────────────────────────────
const PROMPTS = {
  GET_USER: "Get my Asana user profile",
  LIST_WORKSPACES: "List my Asana workspaces",
  MULTI_TURN_FOLLOW_UP:
    "Based on the user profile you just retrieved, what is the name of the first workspace I have access to?",
} as const;

function parseModel(model: string) {
  const parts = model.split("/");
  return {
    provider: parts.length > 1 ? parts[0] : undefined,
    modelName: parts.length > 1 ? parts.slice(1).join("/") : model,
  };
}

const gpt5Mini = parseModel(GPT5_MINI_MODEL);
const nano = parseModel(NANO_MODEL);

const RUN_LLM_INGESTION =
  RUN_INGESTION_TESTS &&
  process.env.ASANA_ENABLE_LLM_TESTS !== "false" &&
  Boolean(ASANA_REFRESH_TOKEN) &&
  Boolean(ASANA_CLIENT_ID) &&
  Boolean(OPENROUTER_API_KEY);

// ─── Shared reporter (single consolidated run) ─────────────────────────────

let reporter: EvalRunReporter;
let addedResultCount = 0;

if (RUN_LLM_INGESTION) {
  reporter = createEvalRunReporter({
    suiteName: SUITE_NAME,
    apiKey: MCPJAM_API_KEY,
    baseUrl: MCPJAM_BASE_URL,
    strict: true,
    suiteDescription:
      "Class-based Asana ingestion run using EvalTest/EvalSuite with consolidated reporting",
    serverNames: ["asana", "asana-staging"],
    notes: "CI eval run covering class APIs + LLM scenarios",
    passCriteria: { minimumPassRate: 70 },
    ci: { branch: "main", commitSha: "a".repeat(40) },
    expectedIterations: EXPECTED_ITERATIONS,
  });
}

function addResult(result: Parameters<EvalRunReporter["add"]>[0]) {
  if (!reporter) return;
  reporter.add(result);
  addedResultCount += 1;
}

async function flushReporter() {
  if (!reporter) return;
  await reporter.flush();
}

afterAll(async () => {
  if (!reporter || addedResultCount === 0) return;
  console.log(
    `[asana-sdk-classes] pre-finalize buffered=${reporter.getBufferedCount()} added=${addedResultCount}`
  );
  const output = await reporter.finalize();
  expect(output.runId).toBeTruthy();
  expect(output.summary.total).toBe(EXPECTED_ITERATIONS);
  console.log(
    `[asana-sdk-classes] finalized runId=${output.runId} total=${output.summary.total} passed=${output.summary.passed} failed=${output.summary.failed}`
  );
}, 120_000);

// ─── Deterministic tests (non-ingesting class assertions) ───────────────────

function createMockPromptResult(options: {
  prompt?: string;
  text?: string;
  toolsCalled?: string[];
  tokens?: number;
  latency?: { e2eMs: number; llmMs: number; mcpMs: number };
  error?: string;
}): PromptResult {
  const prompt = options.prompt ?? "Test prompt";
  const text = options.text ?? "Test response";
  const totalTokens = options.tokens ?? 100;
  const inputTokens = Math.floor(totalTokens / 2);
  const outputTokens = totalTokens - inputTokens;

  return PromptResult.from({
    prompt,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: text },
    ],
    text,
    toolCalls: (options.toolsCalled ?? []).map((toolName) => ({
      toolName,
      arguments: {},
    })),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
    latency: options.latency ?? { e2eMs: 100, llmMs: 80, mcpMs: 20 },
    error: options.error,
  });
}

function createMockAgent(
  promptFn: (message: string) => Promise<PromptResult>
): TestAgent {
  const createAgent = (): TestAgent => {
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
      withOptions: () => createAgent(),
    } as unknown as TestAgent;
  };

  return createAgent();
}

describe("Asana SDK class APIs (Jest) – deterministic", () => {
  it("EvalTest creates iteration objects automatically", async () => {
    const agent = createMockAgent(async (message) =>
      createMockPromptResult({
        prompt: message,
        toolsCalled: ["asana_get_user"],
        tokens: 120,
      })
    );

    const test = new EvalTest({
      name: "det-evaltest-single-turn",
      test: async (a) => {
        const r = await a.prompt(PROMPTS.GET_USER);
        return r.hasToolCall("asana_get_user");
      },
    });

    const result = await test.run(agent, {
      iterations: 3,
      concurrency: 1,
      retries: 0,
      timeoutMs: 10_000,
      mcpjam: { enabled: false },
    });

    expect(result.iterationDetails).toHaveLength(3);
    result.iterationDetails.forEach((iteration) => {
      expect(iteration.prompts?.length).toBe(1);
      expect(iteration.tokens.total).toBeGreaterThan(0);
      expect(iteration.latencies.length).toBe(1);
      expect(typeof iteration.retryCount).toBe("number");
    });
  });

  it("EvalTest multi-turn aggregates prompts/tokens per iteration", async () => {
    const agent = createMockAgent(async (message) =>
      createMockPromptResult({
        prompt: message,
        toolsCalled: message.includes("workspace")
          ? ["asana_list_workspaces"]
          : ["asana_get_user"],
        tokens: 50,
      })
    );

    const test = new EvalTest({
      name: "det-evaltest-multi-turn",
      test: async (a) => {
        const r1 = await a.prompt(PROMPTS.GET_USER);
        const r2 = await a.prompt(PROMPTS.MULTI_TURN_FOLLOW_UP, { context: r1 });
        return r1.toolsCalled().length > 0 && r2.toolsCalled().length > 0;
      },
    });

    const result = await test.run(agent, {
      iterations: 2,
      concurrency: 1,
      retries: 0,
      timeoutMs: 10_000,
      mcpjam: { enabled: false },
    });

    expect(result.iterationDetails).toHaveLength(2);
    result.iterationDetails.forEach((iteration) => {
      expect(iteration.prompts?.length).toBe(2);
      expect(iteration.tokens.total).toBe(100);
      expect(iteration.latencies.length).toBe(2);
    });
  });

  it("EvalSuite auto-populates iteration details for contained tests", async () => {
    const agent = createMockAgent(async (message) =>
      createMockPromptResult({
        prompt: message,
        toolsCalled: message.includes("workspace")
          ? ["asana_list_workspaces"]
          : ["asana_get_user"],
        tokens: 80,
      })
    );

    const suite = new EvalSuite({ name: "det-suite" });
    suite.add(
      new EvalTest({
        name: "suite-get-user",
        test: async (a) => {
          const r = await a.prompt(PROMPTS.GET_USER);
          return r.hasToolCall("asana_get_user");
        },
      })
    );
    suite.add(
      new EvalTest({
        name: "suite-list-workspaces",
        test: async (a) => {
          const r = await a.prompt(PROMPTS.LIST_WORKSPACES);
          return r.hasToolCall("asana_list_workspaces");
        },
      })
    );

    const result = await suite.run(agent, {
      iterations: 2,
      concurrency: 1,
      retries: 0,
      timeoutMs: 10_000,
      mcpjam: { enabled: false },
    });

    expect(result.tests.size).toBe(2);
    expect(result.aggregate.iterations).toBe(4);
    for (const testRun of result.tests.values()) {
      expect(testRun.iterationDetails).toHaveLength(2);
    }
  });
});

function addIterationResultsToReporter(params: {
  iterationDetails: IterationResult[];
  casePrefix: string;
  provider: string | undefined;
  modelName: string;
  expectedToolCalls: EvalExpectedToolCall[];
  promptSelector?: "first" | "last";
}) {
  const selector = params.promptSelector ?? "first";
  for (let i = 0; i < params.iterationDetails.length; i++) {
    const iteration = params.iterationDetails[i];
    const prompts = iteration.prompts ?? [];
    const prompt =
      selector === "last"
        ? prompts[prompts.length - 1]
        : prompts[0];

    if (prompt) {
      addResult(
        prompt.toEvalResult({
          caseTitle: `${params.casePrefix}-iter-${i + 1}`,
          passed: iteration.passed,
          provider: params.provider,
          model: params.modelName,
          expectedToolCalls: params.expectedToolCalls,
        })
      );
      continue;
    }

    addResult({
      caseTitle: `${params.casePrefix}-iter-${i + 1}`,
      passed: iteration.passed,
      provider: params.provider,
      model: params.modelName,
      expectedToolCalls: params.expectedToolCalls,
      tokens: {
        total: iteration.tokens.total,
        input: iteration.tokens.input,
        output: iteration.tokens.output,
      },
      error: iteration.error,
      metadata: {
        iterationNumber: i + 1,
        retryCount: iteration.retryCount ?? 0,
      },
    });
  }
}

// ─── Live class ingestion tests (single consolidated run) ───────────────────

(RUN_LLM_INGESTION ? describe : describe.skip)(
  "Asana SDK class ingestion (Jest) – LLM",
  () => {
    let manager: MCPClientManager;
    let gptAgent: TestAgent;
    let nanoAgent: TestAgent;

    beforeAll(async () => {
      manager = new MCPClientManager();
      await manager.connectToServer(ASANA_SERVER_ID, {
        url: ASANA_MCP_URL,
        refreshToken: ASANA_REFRESH_TOKEN!,
        clientId: ASANA_CLIENT_ID!,
        clientSecret: ASANA_CLIENT_SECRET,
      });

      const tools = await manager.getToolsForAiSdk([ASANA_SERVER_ID]);
      gptAgent = new TestAgent({
        tools,
        model: GPT5_MINI_MODEL,
        apiKey: OPENROUTER_API_KEY!,
        maxSteps: 8,
      });
      nanoAgent = new TestAgent({
        tools,
        model: NANO_MODEL,
        apiKey: OPENROUTER_API_KEY!,
        maxSteps: 8,
      });
    }, 90_000);

    afterAll(async () => {
      await manager.disconnectAllServers();
    });

    const agentConfigs = [
      {
        name: "gpt-5-mini",
        suffix: "gpt5mini",
        getAgent: () => gptAgent,
        parsed: gpt5Mini,
      },
      {
        name: "nano",
        suffix: "nano",
        getAgent: () => nanoAgent,
        parsed: nano,
      },
    ];

    for (const { name, suffix, getAgent, parsed } of agentConfigs) {
      it(`EvalTest get-user (${name})`, async () => {
        const test = new EvalTest({
          name: `class-get-user-${suffix}`,
          test: async (a) => {
            const r = await a.prompt(PROMPTS.GET_USER);
            return r.hasToolCall("asana_get_user");
          },
        });

        const run = await test.run(getAgent(), {
          iterations: 2,
          retries: 1,
          timeoutMs: 60_000,
          mcpjam: { enabled: false },
        });

        expect(run.iterationDetails).toHaveLength(2);
        addIterationResultsToReporter({
          iterationDetails: run.iterationDetails,
          casePrefix: `class-eval-test-get-user-${suffix}`,
          provider: parsed.provider,
          modelName: parsed.modelName,
          expectedToolCalls: [{ toolName: "asana_get_user" }],
        });
        await flushReporter();
      }, 120_000);

      it(`EvalTest list-workspaces (${name})`, async () => {
        const test = new EvalTest({
          name: `class-list-workspaces-${suffix}`,
          test: async (a) => {
            const r = await a.prompt(PROMPTS.LIST_WORKSPACES);
            return r.toolsCalled().length > 0;
          },
        });

        const run = await test.run(getAgent(), {
          iterations: 2,
          retries: 1,
          timeoutMs: 60_000,
          mcpjam: { enabled: false },
        });

        expect(run.iterationDetails).toHaveLength(2);
        addIterationResultsToReporter({
          iterationDetails: run.iterationDetails,
          casePrefix: `class-eval-test-list-workspaces-${suffix}`,
          provider: parsed.provider,
          modelName: parsed.modelName,
          expectedToolCalls: [{ toolName: "asana_list_workspaces" }],
        });
        await flushReporter();
      }, 120_000);

      it(`EvalTest multi-turn (${name})`, async () => {
        const test = new EvalTest({
          name: `class-multi-turn-${suffix}`,
          test: async (a) => {
            const r1 = await a.prompt(PROMPTS.GET_USER);
            const r2 = await a.prompt(PROMPTS.MULTI_TURN_FOLLOW_UP, { context: r1 });
            return r1.toolsCalled().length > 0 && r2.toolsCalled().length > 0;
          },
        });

        const run = await test.run(getAgent(), {
          iterations: 2,
          concurrency: 1,
          retries: 1,
          timeoutMs: 60_000,
          mcpjam: { enabled: false },
        });

        expect(run.iterationDetails).toHaveLength(2);
        run.iterationDetails.forEach((iteration) => {
          expect(iteration.prompts?.length).toBe(2);
        });

        addIterationResultsToReporter({
          iterationDetails: run.iterationDetails,
          casePrefix: `class-eval-test-multi-turn-${suffix}`,
          provider: parsed.provider,
          modelName: parsed.modelName,
          expectedToolCalls: [{ toolName: "asana_list_workspaces" }],
          promptSelector: "last",
        });
        await flushReporter();
      }, 120_000);

      it(`PromptResult metrics (${name})`, async () => {
        const result = await getAgent().prompt(PROMPTS.GET_USER);

        const e2e = result.e2eLatencyMs();
        const llm = result.llmLatencyMs();
        const mcp = result.mcpLatencyMs();
        expect(e2e).toBeGreaterThan(0);
        expect(llm).toBeGreaterThanOrEqual(0);
        expect(mcp).toBeGreaterThanOrEqual(0);

        const total = result.totalTokens();
        expect(total).toBeGreaterThan(0);
        expect(total).toBe(result.inputTokens() + result.outputTokens());

        addResult(
          result.toEvalResult({
            caseTitle: `class-prompt-result-metrics-${suffix}`,
            passed: true,
            provider: parsed.provider,
            model: parsed.modelName,
            expectedToolCalls: [{ toolName: "asana_get_user" }],
          })
        );
        await flushReporter();

        console.log(
          `[asana-sdk-classes] prompt-result (${suffix}) e2e=${e2e}ms mcp=${mcp}ms tokens=${total}`
        );
      }, 90_000);

      it(`EvalSuite (${name})`, async () => {
        const suite = new EvalSuite({ name: `class-suite-${suffix}` });

        suite.add(
          new EvalTest({
            name: "suite-get-user",
            test: async (a) => {
              const r = await a.prompt(PROMPTS.GET_USER);
              return r.hasToolCall("asana_get_user");
            },
          })
        );

        suite.add(
          new EvalTest({
            name: "suite-list-workspaces",
            test: async (a) => {
              const r = await a.prompt(PROMPTS.LIST_WORKSPACES);
              return r.toolsCalled().length > 0;
            },
          })
        );

        const run = await suite.run(getAgent(), {
          iterations: 2,
          retries: 1,
          timeoutMs: 60_000,
          mcpjam: { enabled: false },
        });

        expect(run.tests.size).toBe(2);
        expect(run.aggregate.iterations).toBe(4);

        const expectedToolsMap: Record<string, EvalExpectedToolCall[]> = {
          "suite-get-user": [{ toolName: "asana_get_user" }],
          "suite-list-workspaces": [{ toolName: "asana_list_workspaces" }],
        };

        for (const [testName, testRun] of run.tests) {
          addIterationResultsToReporter({
            iterationDetails: testRun.iterationDetails,
            casePrefix: `class-eval-suite-${testName}-${suffix}`,
            provider: parsed.provider,
            modelName: parsed.modelName,
            expectedToolCalls: expectedToolsMap[testName],
          });
        }
        await flushReporter();
      }, 120_000);
    }

    it("validators (nano)", async () => {
      const result = await nanoAgent.prompt(PROMPTS.GET_USER);
      const toolNames = result.toolsCalled();
      const toolCalls: ToolCall[] = result.getToolCalls();

      expect(matchToolCalls(toolNames, toolNames)).toBe(true);
      expect(matchToolCallsSubset(toolNames, toolNames)).toBe(true);
      expect(matchAnyToolCall(toolNames, toolNames)).toBe(true);
      expect(matchToolCallCount(toolNames[0], toolNames, 1)).toBe(true);

      expect(matchToolCalls(["nonexistent_tool_xyz"], toolNames)).toBe(false);
      expect(matchToolCallsSubset(["nonexistent_tool_xyz"], toolNames)).toBe(false);
      expect(matchAnyToolCall(["nonexistent_tool_xyz"], toolNames)).toBe(false);
      expect(matchNoToolCalls(toolNames)).toBe(false);
      expect(matchNoToolCalls([])).toBe(true);

      if (toolCalls.length > 0) {
        const firstCall = toolCalls[0];
        expect(matchToolCallWithArgs(firstCall.toolName, firstCall.arguments, toolCalls)).toBe(true);
        expect(matchToolCallWithPartialArgs(firstCall.toolName, {}, toolCalls)).toBe(true);
        expect(matchToolCallWithArgs("nonexistent_tool_xyz", {}, toolCalls)).toBe(false);

        const argKeys = Object.keys(firstCall.arguments);
        if (argKeys.length > 0) {
          const key = argKeys[0];
          expect(matchToolArgument(firstCall.toolName, key, firstCall.arguments[key], toolCalls)).toBe(true);
          expect(matchToolArgumentWith(firstCall.toolName, key, () => true, toolCalls)).toBe(true);
          expect(matchToolArgumentWith(firstCall.toolName, key, () => false, toolCalls)).toBe(false);
        }
      }

      addResult(
        result.toEvalResult({
          caseTitle: "class-validators-nano",
          passed: true,
          provider: nano.provider,
          model: nano.modelName,
          expectedToolCalls: [{ toolName: "asana_get_user" }],
        })
      );
      await flushReporter();
    }, 90_000);
  }
);

// ─── Skip messages ──────────────────────────────────────────────────────────

if (!RUN_LLM_INGESTION) {
  describe("Asana SDK class ingestion (Jest) – LLM", () => {
    it.skip(
      "Requires MCPJAM_API_KEY + ASANA_ENABLE_LLM_TESTS not false + ASANA_REFRESH_TOKEN + ASANA_CLIENT_ID + OPENROUTER_API_KEY",
      () => {}
    );
  });
}
