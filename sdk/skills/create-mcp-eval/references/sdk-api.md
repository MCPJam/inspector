## 3. SDK API Reference

All imports come from `@mcpjam/sdk`. This is the complete API surface needed for eval tests.

### MCPClientManager — Server Connection

```typescript
import { MCPClientManager } from "@mcpjam/sdk";

const manager = new MCPClientManager();

// HTTP/SSE connection
await manager.connectToServer("server-id", {
  url: "https://mcp.example.com/sse",
  // Optional OAuth fields:
  refreshToken: "...",
  clientId: "...",
  clientSecret: "...",
});

// Stdio connection
await manager.connectToServer("server-id", {
  command: "node",
  args: ["path/to/server.js"],
  env: { API_KEY: "..." },
});

// Get tools for HostRunner
const tools = await manager.getToolsForAiSdk(["server-id"]);

// Cleanup
await manager.disconnectAllServers();
```

> **Tool names:** `getToolsForAiSdk()` uses the exact tool names from the MCP server — no server-id prefix is added. Use these names directly in `hasToolCall()` and validators. For example, if the server exposes `read_me`, use `result.hasToolCall("read_me")`, not `result.hasToolCall("myserver__read_me")`.

### HostRunner — LLM-Powered Agent

```typescript
import { HostRunner } from "@mcpjam/sdk";
import { hasToolCall } from "@mcpjam/sdk";

const runner = new HostRunner({
  tools,                              // from manager.getToolsForAiSdk()
  model: "{LLM_MODEL}",                     // LLM model string
  apiKey: process.env.{LLM_ENV_VAR}!,       // API key for the provider
  maxSteps: 8,                        // max tool-call loops per prompt
});

// Single prompt
const result = await runner.run("List all projects");

// Multi-turn with context
const r1 = await runner.run("Get my user profile");
const r2 = await runner.run("List workspaces for that user", { context: r1 });

// Stop the loop after the step where a tool is called
const r3 = await runner.run("Search tasks", {
  stopWhen: hasToolCall("search_tasks"),
});
r3.hasToolCall("search_tasks");          // true

// Bound prompt runtime
const r4 = await runner.run("Run a long workflow", {
  timeout: { totalMs: 10_000, stepMs: 2_500 },
});
r4.hasError();                           // true if the prompt timed out

// Mock runner for deterministic tests (no LLM needed)
const mockAgent = HostRunner.mock(async (message) =>
  PromptResult.from({
    prompt: message,
    messages: [
      { role: "user", content: message },
      { role: "assistant", content: "Mock response" },
    ],
    text: "Mock response",
    toolCalls: [{ toolName: "expected_tool", arguments: {} }],
    usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
    latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
  })
);
```

`stopWhen` does not skip tool execution. It controls whether the prompt loop continues after the current step completes, and `HostRunner` also applies `stepCountIs(maxSteps)` as a safety guard.

`timeout` bounds prompt runtime. `number` and `totalMs` cap the full prompt, `stepMs` caps each step, and `chunkMs` is accepted for parity but mainly matters in streaming flows. The runtime creates an internal abort signal, so tools can stop early if their implementation respects the provided `abortSignal`.

### PromptResult — Inspect Agent Responses

```typescript
import { PromptResult } from "@mcpjam/sdk";

// Returned by runner.run()
const result: PromptResult = await runner.run("...");

// Tool inspection
result.toolsCalled();                    // string[] — names of all tools called
result.hasToolCall("tool_name");         // boolean — was this tool called?
result.getToolCalls();                   // ToolCall[] — full call objects with args
result.getToolArguments("tool_name");    // Record<string, unknown> | undefined

// Metrics
result.e2eLatencyMs();                   // number — end-to-end latency
result.llmLatencyMs();                   // number — LLM API time
result.mcpLatencyMs();                   // number — MCP tool execution time
result.totalTokens();                    // number — total tokens used
result.inputTokens();                    // number
result.outputTokens();                   // number

// Error handling
result.hasError();                       // boolean
result.getError();                       // string | undefined

// Messages
result.getMessages();                    // CoreMessage[]
result.formatTrace();                    // string — JSON trace for debugging

// Convert to eval result for reporting
result.toEvalResult({
  caseTitle: "test-name",
  passed: result.hasToolCall("expected_tool"),
  expectedToolCalls: [{ toolName: "expected_tool" }],
});
```

### EvalTest — Single Eval with Iterations

`id` is REQUIRED and is the case's identity; `name` is display text. Write a
stable, descriptive literal (`c_<slug>` reads well) and never change it
afterwards — hosted history joins on `id`, so editing it orphans the case's past
runs, while renaming `name` is free. Do not generate it from the name at runtime,
and do not call `mintCaseId()` inline: an id that changes per run is not an
identity.

```typescript
import { EvalTest } from "@mcpjam/sdk";

const test = new EvalTest({
  id: "c_get_user_tool_selection",
  name: "get-user-tool-selection",
  test: async (runner) => {
    const r = await runner.run("Get my user profile");
    return r.hasToolCall("get_user");  // return boolean
  },
});

const run = await test.run(runner, {
  iterations: 5,       // how many times to repeat
  concurrency: 5,      // parallel iterations (default: 5)
  retries: 1,          // retry failed iterations (default: 0)
  timeoutMs: 60_000,   // per-iteration timeout (default: 30_000)
  mcpjam: {            // auto-upload to MCPJam (optional)
    enabled: true,     // default: true if MCPJAM_API_KEY is set
  },
});

// After run:
test.accuracy();       // number 0-1 — success rate
test.getResults();     // EvalRunResult | null
```

### EvalSuite — Group Multiple Tests

```typescript
import { EvalSuite, EvalTest } from "@mcpjam/sdk";

const suite = new EvalSuite({ name: "my-server-evals" });

suite.add(new EvalTest({
  id: "c_get_user",
  name: "get-user",
  test: async (a) => {
    const r = await a.run("Get my user profile");
    return r.hasToolCall("get_user");
  },
}));

suite.add(new EvalTest({
  id: "c_list_projects",
  name: "list-projects",
  test: async (a) => {
    const r = await a.run("List all projects");
    return r.hasToolCall("list_projects");
  },
}));

const result = await suite.run(runner, {
  iterations: 5,
  retries: 1,
  timeoutMs: 60_000,
});

// Aggregate results
result.aggregate.accuracy;             // number 0-1
result.aggregate.iterations;           // total iterations across all tests
result.tests.size;                     // number of tests

// Per-test access
suite.accuracy();                      // overall accuracy
suite.get("get-user");                 // EvalTest | undefined
suite.getResults();                    // EvalSuiteResult | null
```

### Validators — Tool Call Matching Helpers

```typescript
import {
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchToolCallCount,
  matchNoToolCalls,
  matchToolCallWithArgs,
  matchToolCallWithPartialArgs,
  matchToolArgument,
  matchToolArgumentWith,
} from "@mcpjam/sdk";

const toolNames = result.toolsCalled();       // string[]
const toolCalls = result.getToolCalls();      // ToolCall[]

// Name-based validators (take string[])
matchToolCalls(["a", "b"], toolNames);        // exact match (order-independent)
matchToolCallsSubset(["a"], toolNames);       // subset check
matchAnyToolCall(["a", "b"], toolNames);      // at least one match
matchToolCallCount("a", toolNames, 2);        // exact count of tool
matchNoToolCalls(toolNames);                  // empty check

// Argument-based validators (take ToolCall[])
matchToolCallWithArgs("tool", { key: "val" }, toolCalls);       // exact args match
matchToolCallWithPartialArgs("tool", { key: "val" }, toolCalls); // partial args match
matchToolArgument("tool", "key", "val", toolCalls);             // single arg exact
matchToolArgumentWith("tool", "key", (v) => v > 0, toolCalls);  // custom predicate
```

### Save Results to MCPJam

```typescript
import {
  createEvalRunReporter,
  reportEvalResults,
  reportEvalResultsSafely,
} from "@mcpjam/sdk";
import type { EvalRunReporter } from "@mcpjam/sdk";

// ── Option A: One-shot reporting ──
await reportEvalResults({
  suiteName: "My Evals",
  apiKey: process.env.MCPJAM_API_KEY!,
  strict: true,           // true = throw on error; false = log warning + return null (results silently not uploaded)
  results: [
    { caseTitle: "test-1", passed: true },
    { caseTitle: "test-2", passed: false, error: "wrong tool" },
  ],
});

// reportEvalResultsSafely — same API, returns null on error instead of throwing
const output = await reportEvalResultsSafely({ ... });

// ── Option B: Streaming reporter (recommended for multi-test files) ──
const reporter = createEvalRunReporter({
  suiteName: "My Evals",
  apiKey: process.env.MCPJAM_API_KEY!,
  strict: true,
  suiteDescription: "Eval suite for my MCP server",
  serverNames: ["my-server"],
  notes: "CI run",
  passCriteria: { minimumPassRate: 70 },
  ci: { branch: "main", commitSha: "abc123..." },
  expectedIterations: 10,
});

// Record results as they come in:
await reporter.record(result.toEvalResult({ caseTitle: "...", passed: true }));
await reporter.recordFromPrompt(result, { caseTitle: "...", passed: true });
await reporter.recordFromRun(run, {
  casePrefix: "eval-test",
  expectedToolCalls: [{ toolName: "get_user" }],
});
await reporter.recordFromSuiteRun(suiteResult.tests, {
  casePrefix: "suite",
  expectedToolCallsByTest: {
    "get-user": [{ toolName: "get_user" }],
  },
});

// Finalize at end of test file (IMPORTANT — must be called!)
afterAll(async () => {
  const output = await reporter.finalize();
  console.log(`Run ID: ${output.runId}, Passed: ${output.summary.passed}`);
}, 90_000);
```

---
