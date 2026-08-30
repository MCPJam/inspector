## 6. Complete Template

Copy-pasteable test file skeleton. Replace `{placeholders}` with your server-specific values.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"; // For Jest: remove this line
import {
  MCPClientManager,
  HostRunner,
  PromptResult,
  EvalTest,
  EvalSuite,
  createEvalRunReporter,
  matchToolCalls,
  matchAnyToolCall,
  matchNoToolCalls,
  matchToolCallWithPartialArgs,
} from "@mcpjam/sdk";
import type { ToolCall, EvalRunReporter } from "@mcpjam/sdk";

// ─── Config ─────────────────────────────────────────────────────────────────
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "{server_url}";
const LLM_API_KEY = process.env.{LLM_ENV_VAR}!;
const MODEL = process.env.EVAL_MODEL ?? "{LLM_MODEL}";
const SERVER_ID = "{server_id}";

const MCPJAM_API_KEY = process.env.MCPJAM_API_KEY;

const RUN_LLM_TESTS = Boolean(LLM_API_KEY) && Boolean(MCP_SERVER_URL);

// ─── Prompts ────────────────────────────────────────────────────────────────
const PROMPTS = {
  // {TOOL_1}: "{natural language request for tool_1}",
  // {TOOL_2}: "{natural language request for tool_2}",
  // NEGATIVE: "What is the capital of France?",
} as const;

// ─── Save Results to MCPJam ──────────────────────────────────────────────────
let reporter: EvalRunReporter;

if (MCPJAM_API_KEY) {
  reporter = createEvalRunReporter({
    suiteName: "{Suite Name}",
    apiKey: MCPJAM_API_KEY,
    strict: true,
    suiteDescription: "Eval suite for {server_name}",
    serverNames: [SERVER_ID],
    expectedIterations: 10, // must exactly match the number of reported results
  });
}

afterAll(async () => {
  if (!reporter || reporter.getAddedCount() === 0) return;
  const output = await reporter.finalize();
  expect(output.runId).toBeTruthy();
  console.log(`\n[mcpjam] Results saved — ${output.summary.passed}/${output.summary.total} passed`);
  console.log(`[mcpjam] Open the Evals tab in the MCPJam Inspector to see your full results.\n`);
}, 90_000);

// ─── Deterministic Tests ────────────────────────────────────────────────────
describe("{server_name} evals – deterministic", () => {
  it("mock runner produces valid EvalTest results", async () => {
    const mock = HostRunner.mock(async (msg) =>
      PromptResult.from({
        prompt: msg,
        messages: [
          { role: "user", content: msg },
          { role: "assistant", content: "Done" },
        ],
        text: "Done",
        toolCalls: [{ toolName: "{expected_tool}", arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
        latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
      })
    );

    const test = new EvalTest({
      id: "c_det_mock_tool_selection",
      name: "det-mock-tool-selection",
      test: async (a) => {
        const r = await a.run("test prompt");
        return r.hasToolCall("{expected_tool}");
      },
    });

    const run = await test.run(mock, {
      iterations: 3,
      concurrency: 1,
      retries: 0,
      timeoutMs: 10_000,
      mcpjam: { enabled: false },
    });

    expect(run.successes).toBe(3);
    expect(run.iterationDetails).toHaveLength(3);
  });
});

// ─── LLM Tests ──────────────────────────────────────────────────────────────
(RUN_LLM_TESTS ? describe : describe.skip)("{server_name} evals – LLM", () => {
  let manager: MCPClientManager;
  let runner: HostRunner;

  beforeAll(async () => {
    manager = new MCPClientManager();
    await manager.connectToServer(SERVER_ID, {
      url: MCP_SERVER_URL,
      // Add OAuth fields if needed:
      // refreshToken: process.env.MCP_REFRESH_TOKEN!,
      // clientId: process.env.MCP_CLIENT_ID!,
    });

    const tools = await manager.getToolsForAiSdk([SERVER_ID]);
    runner = new HostRunner({
      tools,
      model: MODEL,
      apiKey: LLM_API_KEY,
      maxSteps: 8,
    });
  }, 90_000);

  afterAll(async () => {
    await manager.disconnectAllServers();
  });

  // ── Single-tool selection tests ──

  // it("selects {tool_name}", async () => {
  //   const result = await runner.run(PROMPTS.{TOOL_KEY});
  //   expect(result.hasToolCall("{tool_name}")).toBe(true);
  //
  //   if (reporter) {
  //     await reporter.recordFromPrompt(result, {
  //       caseTitle: "llm-{tool_name}",
  //       passed: result.hasToolCall("{tool_name}"),
  //       expectedToolCalls: [{ toolName: "{tool_name}" }],
  //     });
  //   }
  // }, 90_000);

  // ── Multi-turn test ──

  // it("multi-turn: {tool_a} then {tool_b}", async () => {
  //   const r1 = await runner.run(PROMPTS.{TOOL_A});
  //   const r2 = await runner.run(PROMPTS.{TOOL_B_FOLLOWUP}, { context: r1 });
  //   expect(r1.hasToolCall("{tool_a}")).toBe(true);
  //   expect(r2.toolsCalled().length).toBeGreaterThan(0);
  // }, 120_000);

  // ── Negative test ──

  it("does not call tools for irrelevant prompt", async () => {
    const result = await runner.run("What is the capital of France?");
    expect(matchNoToolCalls(result.toolsCalled())).toBe(true);

    if (reporter) {
      await reporter.recordFromPrompt(result, {
        caseTitle: "llm-negative-no-tools",
        passed: matchNoToolCalls(result.toolsCalled()),
        isNegativeTest: true,
      });
    }
  }, 90_000);

  // ── EvalTest with iterations ──

  // it("EvalTest: {tool_name} accuracy", async () => {
  //   const test = new EvalTest({
  //     id: "c_tool_name_accuracy",
  //     name: "{tool_name}-accuracy",
  //     test: async (a) => {
  //       const r = await a.run(PROMPTS.{TOOL_KEY});
  //       return r.hasToolCall("{tool_name}");
  //     },
  //   });
  //   const run = await test.run(runner, {
  //     iterations: 5,
  //     retries: 1,
  //     timeoutMs: 60_000,
  //     mcpjam: { enabled: false },
  //   });
  //   expect(test.accuracy()).toBeGreaterThanOrEqual(0.8);
  //   if (reporter) {
  //     await reporter.recordFromRun(run, {
  //       casePrefix: "eval-{tool_name}",
  //       expectedToolCalls: [{ toolName: "{tool_name}" }],
  //     });
  //   }
  //   console.log(`{tool_name} accuracy: ${test.accuracy()}`);
  // }, 120_000);

  // ── EvalSuite ──

  // it("EvalSuite: all tools", async () => {
  //   const suite = new EvalSuite({ name: "{server_name}-suite" });
  //   suite.add(new EvalTest({ id: "c_{tool_1}", name: "{tool_1}", test: async (a) => { ... } }));
  //   suite.add(new EvalTest({ id: "c_{tool_2}", name: "{tool_2}", test: async (a) => { ... } }));
  //   const result = await suite.run(runner, { iterations: 5, timeoutMs: 60_000 });
  //   expect(suite.accuracy()).toBeGreaterThanOrEqual(0.7);
  // }, 120_000);
});

// ─── Skip messages ──────────────────────────────────────────────────────────
if (!RUN_LLM_TESTS) {
  describe("{server_name} evals – LLM", () => {
    it.skip("Requires {LLM_ENV_VAR} + MCP_SERVER_URL", () => {});
  });
}

if (!MCPJAM_API_KEY) {
  afterAll(() => {
    console.log(`\n[mcpjam] You won't be able to see them in the CI/CD tab. To set up:`);
    console.log(`[mcpjam] 1. Go to Settings > Workspace API Key in the MCPJam Inspector`);
    console.log(`[mcpjam] 2. Add MCPJAM_API_KEY to your .env`);
    console.log(`[mcpjam] 3. Re-run your evals — results are saved automatically\n`);
  });
}
```

---
