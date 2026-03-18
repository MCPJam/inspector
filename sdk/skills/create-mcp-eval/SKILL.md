---
name: create-mcp-eval
description: Generate comprehensive eval tests for any MCP server using @mcpjam/sdk. Supports Jest and Vitest with deterministic and LLM-driven test patterns.
---

# create-mcp-eval

Generate eval tests for MCP servers using **@mcpjam/sdk**.

This skill guides you through creating eval test files that measure tool-selection accuracy, argument correctness, and multi-turn reasoning for any MCP server. It works with both Jest and Vitest and supports deterministic (mock) and LLM-driven test patterns.

---

## 1. Context Gathering

Before generating any code, collect the following from the user:

| Question | Options | Default |
|----------|---------|---------|
| **Connection type** | `stdio` (local binary) or `http` (SSE/Streamable HTTP URL) | `http` |
| **Test framework** | `jest`, `vitest`, or `none` (SDK-only) | _(detect from repo; fall back to `vitest`)_ |
| **LLM provider** | See Supported Providers table below. Format: `provider/model` | _(must ask user)_ |
| **Save results to MCPJam** | `none`, `auto` (saves when MCPJAM_API_KEY is set), or `reporter` (shared EvalRunReporter). To get your API key, go to **Settings > Workspace API Key** in the MCPJam Inspector. | _(must ask user)_ |
| **Tool list** | Ask user to paste their tool names or an **Agent Brief** (see Section 8) | — |

If the user provides an **Agent Brief** (markdown with `## Tools` table), parse it to auto-populate tool names, descriptions, parameters, and suggested eval scenarios. See Section 8.

### Provider Selection (REQUIRED)

You MUST ask the developer which LLM provider they want before generating any code. Do not default to any provider.

**Supported Providers:**

| Provider | Model format | Env var | Example model |
|----------|-------------|---------|---------------|
| `openai` | `openai/<model>` | `OPENAI_API_KEY` | `openai/gpt-4o-mini` |
| `anthropic` | `anthropic/<model>` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-20250514` |
| `google` | `google/<model>` | `GOOGLE_API_KEY` | `google/gemini-2.0-flash` |
| `mistral` | `mistral/<model>` | `MISTRAL_API_KEY` | `mistral/mistral-small-latest` |
| `deepseek` | `deepseek/<model>` | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| `xai` | `xai/<model>` | `XAI_API_KEY` | `xai/grok-2` |
| `openrouter` | `openrouter/<model>` | `OPENROUTER_API_KEY` | `openrouter/openai/gpt-4o-mini` |
| `azure` | `azure/<deployment>` | `AZURE_API_KEY` | `azure/gpt-4o` |
| `ollama` | `ollama/<model>` | _(none, local)_ | `ollama/llama3` |
| Custom | `<name>/<model>` | _(configurable)_ | `litellm/gpt-4` |

Once the user selects a provider, use the corresponding env var name and model format in all generated code:
- `{LLM_ENV_VAR}` — e.g., `OPENAI_API_KEY`
- `{LLM_MODEL}` — e.g., `openai/gpt-4o-mini`
- `{LLM_KEY_EXAMPLE}` — e.g., `sk-...`

### Test Runner Selection

Before generating tests, check what the codebase already uses:

- `package.json` scripts and devDependencies for `jest` or `vitest`
- Config files: `jest.config.*`, `vitest.config.*`, `vite.config.*`

Then:
- If Jest is present, use Jest (and `ts-jest` if TypeScript).
- If Vitest is present, use Vitest.
- If neither is present, default to Vitest.
- If the developer prefers **no test framework**, the `@mcpjam/sdk` classes (`EvalTest`, `EvalSuite`) can run standalone — call `.run()` directly and check results in a plain script without Jest/Vitest.

In all cases, use `@mcpjam/sdk` for the eval harness (`TestAgent`, `EvalTest`, `EvalSuite`, validators).

---

## 2. Project Setup

Generate the following scaffold when creating a new eval project. Use the test runner detected above — the examples below show both Vitest and Jest variants.

### package.json (essentials)
```json
{
  "name": "my-server-evals",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@mcpjam/sdk": "latest",
    "vitest": "^3.0.0",
    "typescript": "^5.0.0"
  }
}
```

For Jest, replace the scripts and devDependencies:
```json
{
  "scripts": {
    "test": "jest --runInBand"
  },
  "devDependencies": {
    "@mcpjam/sdk": "latest",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "typescript": "^5.0.0"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["tests/**/*.ts"]
}
```

### .env.example
```bash
# LLM provider key (required for LLM tests)
{LLM_ENV_VAR}={LLM_KEY_EXAMPLE}
EVAL_MODEL={LLM_MODEL}

# MCP server connection
MCP_SERVER_URL=https://your-server.example.com/sse
# For OAuth-protected servers:
# MCP_REFRESH_TOKEN=...
# MCP_CLIENT_ID=...
# MCP_CLIENT_SECRET=...

# Save eval results to MCPJam (optional)
# MCPJAM_API_KEY=mcpjam_...
```

### .gitignore additions
```
node_modules/
dist/
.env
```

---

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

// Get tools for TestAgent
const tools = await manager.getToolsForAiSdk(["server-id"]);

// Cleanup
await manager.disconnectAllServers();
```

> **Tool names:** `getToolsForAiSdk()` uses the exact tool names from the MCP server — no server-id prefix is added. Use these names directly in `hasToolCall()` and validators. For example, if the server exposes `read_me`, use `result.hasToolCall("read_me")`, not `result.hasToolCall("myserver__read_me")`.

### TestAgent — LLM-Powered Agent

```typescript
import { TestAgent } from "@mcpjam/sdk";
import { hasToolCall } from "@mcpjam/sdk";

const agent = new TestAgent({
  tools,                              // from manager.getToolsForAiSdk()
  model: "{LLM_MODEL}",                     // LLM model string
  apiKey: process.env.{LLM_ENV_VAR}!,       // API key for the provider
  maxSteps: 8,                        // max tool-call loops per prompt
});

// Single prompt
const result = await agent.prompt("List all projects");

// Multi-turn with context
const r1 = await agent.prompt("Get my user profile");
const r2 = await agent.prompt("List workspaces for that user", { context: r1 });

// Stop the loop after the step where a tool is called
const r3 = await agent.prompt("Search tasks", {
  stopWhen: hasToolCall("search_tasks"),
});
r3.hasToolCall("search_tasks");          // true

// Bound prompt runtime
const r4 = await agent.prompt("Run a long workflow", {
  timeout: { totalMs: 10_000, stepMs: 2_500 },
});
r4.hasError();                           // true if the prompt timed out

// Mock agent for deterministic tests (no LLM needed)
const mockAgent = TestAgent.mock(async (message) =>
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

`stopWhen` does not skip tool execution. It controls whether the prompt loop continues after the current step completes, and `TestAgent` also applies `stepCountIs(maxSteps)` as a safety guard.

`timeout` bounds prompt runtime. `number` and `totalMs` cap the full prompt, `stepMs` caps each step, and `chunkMs` is accepted for parity but mainly matters in streaming flows. The runtime creates an internal abort signal, so tools can stop early if their implementation respects the provided `abortSignal`.

### PromptResult — Inspect Agent Responses

```typescript
import { PromptResult } from "@mcpjam/sdk";

// Returned by agent.prompt()
const result: PromptResult = await agent.prompt("...");

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

```typescript
import { EvalTest } from "@mcpjam/sdk";

const test = new EvalTest({
  name: "get-user-tool-selection",
  test: async (agent) => {
    const r = await agent.prompt("Get my user profile");
    return r.hasToolCall("get_user");  // return boolean
  },
});

const run = await test.run(agent, {
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
  name: "get-user",
  test: async (a) => {
    const r = await a.prompt("Get my user profile");
    return r.hasToolCall("get_user");
  },
}));

suite.add(new EvalTest({
  name: "list-projects",
  test: async (a) => {
    const r = await a.prompt("List all projects");
    return r.hasToolCall("list_projects");
  },
}));

const result = await suite.run(agent, {
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
    const result = await getAgent().prompt("Get my profile");
    expect(result.hasToolCall("get_user")).toBe(true);
  }, 90_000);
}
```

### Pattern 5: Four Ways to Save Results

```typescript
// Style 1: Manual toEvalResult + record
const result = await agent.prompt("Get user");
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
const run = await evalTest.run(agent, { iterations: 5 });
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
  it("mock agent returns expected structure", async () => {
    const mock = TestAgent.mock(async (msg) =>
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
      name: "mock-test",
      test: async (a) => (await a.prompt("test")).hasToolCall("get_user"),
    });
    const run = await test.run(mock, { iterations: 3, mcpjam: { enabled: false } });
    expect(run.successes).toBe(3);
  });
});

// ─── LLM (requires credentials) ─────────────────────────────────
(RUN_LLM_TESTS ? describe : describe.skip)("LLM", () => {
  // real agent tests here
});
```

### Pattern 7: Multi-Turn Conversations

Test workflows that require conversation context:

```typescript
it("multi-turn: get user then list workspaces", async () => {
  const r1 = await agent.prompt("Get my user profile");
  const r2 = await agent.prompt(
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
  const result = await agent.prompt("Get user profile");
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

## 5. Generation Guidelines

Follow these rules when generating eval test files:

1. **Deterministic suite first** — always include a deterministic test section using `TestAgent.mock()` that validates the test structure itself without requiring LLM calls or server connections.

2. **One EvalTest per tool** — create a separate `EvalTest` for each tool you want to evaluate. Each test should prompt the agent with a natural-language request and assert the correct tool was selected.

3. **Single-shot LLM tests are non-deterministic** — a single `agent.prompt()` may not select the expected tool every time. For single-shot tests, prefer saving results to MCPJam without hard-asserting (`expect(...).toBe(true)`). Use `EvalTest` with `iterations >= 3` and assert on `accuracy()` for reliable pass/fail gates. Reserve hard asserts for high-confidence cases (negative tests, multi-turn with clear context).

4. **Write unambiguous prompts for similar tools** — when a server has tools with overlapping descriptions (e.g., `create_view` vs `export_to_excalidraw`), prompts must reference the tool's *unique* action. Mention specific verbs, targets, or outcomes. Bad: "Share my diagram". Good: "Export and upload my diagram to excalidraw.com so I can open it in a browser".

5. **Multi-turn for related tools** — when tools logically chain together (e.g., `get_user` then `list_workspaces`), create a multi-turn test using `{ context: previousResult }`.

6. **Negative test** — always include at least one test that verifies the agent does NOT call tools when given an irrelevant prompt (e.g., "What is the capital of France?"). Use `matchNoToolCalls()`.

7. **Reasonable defaults**:
   - `iterations: 5` for EvalTest runs
   - `timeoutMs: 60_000` for LLM tests
   - `maxSteps: 8` for TestAgent
   - `retries: 1` for flaky network tolerance
   - `concurrency: 5` (default, no need to set explicitly)

8. **Timeout on test cases** — set explicit timeouts on `it()` blocks: `90_000` for single-turn, `120_000` for multi-turn and suite tests.

9. **Always `await`** — every `agent.prompt()`, `test.run()`, `suite.run()`, `reporter.record*()`, and `reporter.finalize()` is async. Never forget `await`.

10. **One reporter per file** — create the reporter at module level to save results to MCPJam, and finalize in `afterAll`. Never create multiple reporters in the same file.

11. **Use `describe.skip` for missing credentials** — wrap LLM tests in conditional describe blocks so CI runs cleanly without secrets.

12. **Match the repo's test runner** — check `package.json` and config files for an existing test framework before generating. Only default to Vitest if the repo has no test runner. If the user prefers no framework at all, use `@mcpjam/sdk` classes (`EvalTest.run()`, `EvalSuite.run()`) standalone in a plain script.

13. **Log key metrics** — add `console.log` statements for accuracy, tool calls, and latency so CI output is informative.

---

## 6. Complete Template

Copy-pasteable test file skeleton. Replace `{placeholders}` with your server-specific values.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"; // For Jest: remove this line
import {
  MCPClientManager,
  TestAgent,
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
  it("mock agent produces valid EvalTest results", async () => {
    const mock = TestAgent.mock(async (msg) =>
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
      name: "det-mock-tool-selection",
      test: async (a) => {
        const r = await a.prompt("test prompt");
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
  let agent: TestAgent;

  beforeAll(async () => {
    manager = new MCPClientManager();
    await manager.connectToServer(SERVER_ID, {
      url: MCP_SERVER_URL,
      // Add OAuth fields if needed:
      // refreshToken: process.env.MCP_REFRESH_TOKEN!,
      // clientId: process.env.MCP_CLIENT_ID!,
    });

    const tools = await manager.getToolsForAiSdk([SERVER_ID]);
    agent = new TestAgent({
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
  //   const result = await agent.prompt(PROMPTS.{TOOL_KEY});
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
  //   const r1 = await agent.prompt(PROMPTS.{TOOL_A});
  //   const r2 = await agent.prompt(PROMPTS.{TOOL_B_FOLLOWUP}, { context: r1 });
  //   expect(r1.hasToolCall("{tool_a}")).toBe(true);
  //   expect(r2.toolsCalled().length).toBeGreaterThan(0);
  // }, 120_000);

  // ── Negative test ──

  it("does not call tools for irrelevant prompt", async () => {
    const result = await agent.prompt("What is the capital of France?");
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
  //     name: "{tool_name}-accuracy",
  //     test: async (a) => {
  //       const r = await a.prompt(PROMPTS.{TOOL_KEY});
  //       return r.hasToolCall("{tool_name}");
  //     },
  //   });
  //   const run = await test.run(agent, {
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
  //   suite.add(new EvalTest({ name: "{tool_1}", test: async (a) => { ... } }));
  //   suite.add(new EvalTest({ name: "{tool_2}", test: async (a) => { ... } }));
  //   const result = await suite.run(agent, { iterations: 5, timeoutMs: 60_000 });
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

## 7. Common Mistakes

### Forgetting `reporter.finalize()`
The reporter buffers results and uploads them in batch. If you don't call `finalize()` in `afterAll`, no results are sent. Always include:
```typescript
afterAll(async () => {
  if (!reporter || reporter.getAddedCount() === 0) return;
  await reporter.finalize();
}, 90_000);
```

### Expecting immediate UI visibility
`recordFromPrompt()` and the other `record*()` helpers buffer results, but
they do not guarantee an immediate save to MCPJam. A long-running file may not appear in
the UI until `flush()` or `finalize()` runs.

If you need the run to show up before the file completes, flush periodically:
```typescript
await reporter.recordFromPrompt(result, { caseTitle: "step-1", passed: true });
await reporter.flush();
```

### Not awaiting async methods
Every SDK method that talks to an LLM, MCP server, or reporting API is async. Missing `await` causes silent failures:
```typescript
// WRONG:
reporter.recordFromPrompt(result, { ... });

// CORRECT:
await reporter.recordFromPrompt(result, { ... });
```

### Low `maxSteps` on TestAgent
If the agent needs multiple tool calls to answer a prompt, a low `maxSteps` causes incomplete responses. Default to `8` for most servers, increase to `12-15` for complex workflows.

### Mixing save modes
Don't use both `reportEvalResults()` and a shared `EvalRunReporter` in the same file. Pick one approach:
- Use `createEvalRunReporter` for multi-test files (recommended)
- Use `reportEvalResults` for single one-off saves

### Missing test timeouts
LLM calls can take 10-30 seconds. Always set explicit timeouts on `it()` blocks:
```typescript
it("test name", async () => { ... }, 90_000);  // 90 seconds
```

### Creating multiple reporters
One reporter per test file. Creating multiple reporters results in multiple incomplete runs instead of one consolidated run saved to MCPJam.

### Incorrect `expectedIterations`
`expectedIterations` is not a rough estimate. It should exactly equal the total
number of eval results reported for the file.

Count:
- One result per `recordFromPrompt()`
- One result per iteration inside `recordFromRun()`
- One result per iteration inside `recordFromSuiteRun()`

If the count is wrong, the UI can show misleading progress for a run.

### Using `strict: false` without checking results
With `strict: false`, save failures are silently swallowed — a `console.warn` is emitted and `finalize()` returns a local fallback with an empty `runId`. Always check `output.runId` after finalize to confirm results were saved:
```typescript
const output = await reporter.finalize();
if (!output.runId) {
  console.error("Results were NOT saved to MCPJam — check baseUrl and apiKey");
}
```

---

## 8. Adapting to Agent Brief

When a user pastes an **Agent Brief** (generated by the MCPJam Inspector's "Copy agent brief" action), use it to auto-generate targeted eval tests.

### Agent Brief Format

The brief is a markdown document with this structure:

```markdown
# MCP Server Brief: {server-name}

## Capability Summary
{N} tools, {M} resources, {P} prompts

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| tool_name | Does something useful | param1 (string, required), param2 (number) |
| other_tool | Does something else | id (string, required) |

## Suggested Eval Scenarios

### Single-Tool Selection
- `tool_name` — "Does something useful"
- `other_tool` — "Does something else"

### Multi-Tool Workflow
- `list_items` → `get_item`: List then fetch detail

### Argument Accuracy
- `tool_name` requires: param1 (string), param2 (number)

### Negative Test
- Irrelevant prompt should trigger no tool calls

## Next Steps
...
```

### How to Parse It

1. **Extract tools** from the `## Tools` table — each row gives you a tool name, description, and parameters.

2. **Generate PROMPTS object** — for each tool, write a natural-language prompt that would cause an agent to select that tool. Use the description as guidance.

3. **Create EvalTests** — one per tool from "Single-Tool Selection", using the tool name for `hasToolCall()`.

4. **Create multi-turn tests** — from "Multi-Tool Workflow" entries, chain the tools using `{ context: r1 }`.

5. **Create argument tests** — from "Argument Accuracy" entries, use `matchToolCallWithPartialArgs()` or `matchToolArgument()` to verify the agent passes correct argument types.

6. **Always include the negative test** — use `matchNoToolCalls()`.

### Example: Brief → Test

Given a brief with tool `search_tasks` described as "Search for tasks by keyword":

```typescript
const PROMPTS = {
  SEARCH_TASKS: "Search for tasks containing 'launch'",
} as const;

it("selects search_tasks", async () => {
  const result = await agent.prompt(PROMPTS.SEARCH_TASKS);
  expect(result.hasToolCall("search_tasks")).toBe(true);
}, 90_000);
```
