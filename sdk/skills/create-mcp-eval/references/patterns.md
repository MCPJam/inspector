## 4. Canonical Patterns

### Pattern 1: Config Block

Always start your test file with a self-contained config block. Use environment variables with sensible fallbacks:

```typescript
// ─── Config ─────────────────────────────────────────────────────────────────
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "https://mcp.example.com/sse";
const LLM_API_KEY = process.env.{LLM_ENV_VAR}!;
const MODEL = process.env.EVAL_MODEL ?? "{LLM_MODEL}";
const SERVER_ID = "my-server";

const MCPJAM_API_KEY = process.env.MCPJAM_API_KEY;
const RUN_LLM_TESTS = Boolean(LLM_API_KEY);
```

### Pattern 2: Toggle Suites (Conditional Execution)

Use a conditional wrapper so tests skip gracefully when credentials are missing:

```typescript
(RUN_LLM_TESTS ? describe : describe.skip)("LLM Tests", () => {
  // tests here only run when {LLM_ENV_VAR} is set
});
```

### Pattern 3: Shared Reporter (Save Results to MCPJam)

Create a module-level reporter to save results to MCPJam, and finalize in `afterAll`:

```typescript
let reporter: EvalRunReporter;

if (MCPJAM_API_KEY) {
  reporter = createEvalRunReporter({
    suiteName: "My Server Evals",
    apiKey: MCPJAM_API_KEY,
    strict: true,
    expectedIterations: 10,
  });
}

afterAll(async () => {
  if (!reporter || reporter.getAddedCount() === 0) return;
  const output = await reporter.finalize();
  expect(output.runId).toBeTruthy();
}, 90_000);
```

The reporter buffers results before saving. A run may not appear in the MCPJam UI until
`reporter.flush()` or `reporter.finalize()` completes.

For long-running files, call `await reporter.flush()` periodically if you want
the run to become visible before the entire file finishes.

`expectedIterations` must equal the exact number of reported results. Count
every `recordFromPrompt()` call, every iteration emitted by `recordFromRun()`,
and every iteration emitted by `recordFromSuiteRun()`.

### Pattern 4: Agent Parameterization

Test the same scenarios across multiple models:

```typescript
const agentConfigs = [
  { name: "gpt-4o-mini", suffix: "gpt4omini", getAgent: () => primaryAgent },
  { name: "nano", suffix: "nano", getAgent: () => nanoAgent },
];

for (const { name, suffix, getAgent } of agentConfigs) {
  it(`selects correct tool (${name})`, async () => {
    const result = await getAgent().run("Get my profile");
    expect(result.hasToolCall("get_user")).toBe(true);
  }, 90_000);
}
```

### Pattern 5: Four Ways to Save Results

```typescript
// Style 1: Manual toEvalResult + record
const result = await runner.run("Get user");
await reporter.record(result.toEvalResult({
  caseTitle: "get-user",
  passed: result.hasToolCall("get_user"),
  expectedToolCalls: [{ toolName: "get_user" }],
}));

// Style 2: recordFromPrompt (shorthand)
await reporter.recordFromPrompt(result, {
  caseTitle: "get-user",
  passed: result.hasToolCall("get_user"),
  expectedToolCalls: [{ toolName: "get_user" }],
});

// Style 3: recordFromRun (EvalTest results)
const run = await evalTest.run(runner, { iterations: 5 });
await reporter.recordFromRun(run, {
  casePrefix: "eval-get-user",
  expectedToolCalls: [{ toolName: "get_user" }],
});

// Style 4: recordFromSuiteRun (EvalSuite results)
await reporter.recordFromSuiteRun(suiteResult.tests, {
  casePrefix: "suite",
  expectedToolCallsByTest: {
    "get-user": [{ toolName: "get_user" }],
  },
});
```

### Pattern 6: Deterministic + LLM Tests

Split your test file into deterministic (no LLM/server needed) and LLM sections:

```typescript
// ─── Deterministic (always runs) ─────────────────────────────────
describe("Deterministic", () => {
  it("mock runner returns expected structure", async () => {
    const mock = HostRunner.mock(async (msg) =>
      PromptResult.from({
        prompt: msg,
        messages: [{ role: "user", content: msg }, { role: "assistant", content: "ok" }],
        text: "ok",
        toolCalls: [{ toolName: "get_user", arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
        latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
      })
    );
    const test = new EvalTest({
      id: "c_mock_test",
      name: "mock-test",
      test: async (a) => (await a.run("test")).hasToolCall("get_user"),
    });
    const run = await test.run(mock, { iterations: 3, mcpjam: { enabled: false } });
    expect(run.successes).toBe(3);
  });
});

// ─── LLM (requires credentials) ─────────────────────────────────
(RUN_LLM_TESTS ? describe : describe.skip)("LLM", () => {
  // real runner tests here
});
```

### Pattern 7: Multi-Turn Conversations

Test workflows that require conversation context:

```typescript
it("multi-turn: get user then list workspaces", async () => {
  const r1 = await runner.run("Get my user profile");
  const r2 = await runner.run(
    "Based on the profile, list my workspaces",
    { context: r1 }  // passes r1's conversation history
  );

  expect(r1.hasToolCall("get_user")).toBe(true);
  expect(r2.toolsCalled().length).toBeGreaterThan(0);
}, 120_000);
```

### Pattern 8: Validator Coverage

Use validators for precise tool-call assertions:

```typescript
it("validates tool calls comprehensively", async () => {
  const result = await runner.run("Get user profile");
  const toolNames = result.toolsCalled();
  const toolCalls = result.getToolCalls();

  // At least one expected tool was called
  expect(matchAnyToolCall(["get_user", "get_profile"], toolNames)).toBe(true);

  // Argument validation
  if (toolCalls.length > 0) {
    expect(
      matchToolCallWithPartialArgs("get_user", {}, toolCalls)
    ).toBe(true);
  }

  // Negative: unexpected tools not called
  expect(matchAnyToolCall(["delete_user"], toolNames)).toBe(false);
});
```

---
