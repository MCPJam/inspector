# @mcpjam/sdk

Use the MCPJam SDK to write unit tests and evals for your MCP server.

## Installation

```bash
npm install @mcpjam/sdk
```

Compatible with your favorite testing framework like [Jest](https://jestjs.io/) and [Vitest](https://vitest.dev/)

## Quick Start

### Unit Test

Test the individual parts, request response flow of your MCP server. MCP unit tests are deterministic.

```ts
import { MCPClientManager } from "@mcpjam/sdk";

describe("Everything MCP example", () => {
  let manager: MCPClientManager;

  beforeAll(async () => {
    manager = new MCPClientManager();
    await manager.connectToServer("everything", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    });
  });

  afterAll(async () => {
    await manager.disconnectServer("everything");
  });

  test("server has expected tools", async () => {
    const tools = await manager.listTools("everything");
    expect(tools.tools.map((t) => t.name)).toContain("get-sum");
  });

  test("get-sum tool returns correct result", async () => {
    const result = await manager.executeTool("everything", "get-sum", {
      a: 2,
      b: 3,
    });
    expect(result.content[0].text).toBe("5");
  });
});
```

### MCP evals

Test that an LLM correctly understands how to use your MCP server. Evals are non-deterministic and multiple runs are needed.

> **Heads up: renames in 1.11.** `TestAgent` → `HostRunner`, `EvalAgent` → `HostExecutor`, `.prompt()` → `.run()`, `Host.addServer()` → `Host.requireServer()`. No deprecation aliases. See the [changelog](./CHANGELOG.md) for the codemod.

```ts
import { MCPClientManager, HostRunner, EvalTest } from "@mcpjam/sdk";

describe("Asana MCP Evals", () => {
  let manager: MCPClientManager;
  let runner: HostRunner;

  beforeAll(async () => {
    manager = new MCPClientManager();
    await manager.connectToServer("asana", {
      url: "https://mcp.asana.com/sse",
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.ASANA_TOKEN}` },
      },
    });

    runner = new HostRunner({
      tools: await manager.getToolsForAiSdk(["asana"]),
      model: "openai/gpt-4o",
      apiKey: process.env.OPENAI_API_KEY!,
    });
  });

  afterAll(async () => {
    await manager.disconnectServer("asana");
  });

  // Single-turn eval
  test("list workspaces > 80% accuracy", async () => {
    const evalTest = new EvalTest({
      name: "list-workspaces",
      test: async (runner) => {
        const result = await runner.run("Show me all my Asana workspaces");
        return result.hasToolCall("asana_list_workspaces");
      },
    });

    await evalTest.run(runner, {
      iterations: 10,
      onFailure: (report) => console.error(report), // Print the report when a test iteration fails.
    });

    expect(evalTest.accuracy()).toBeGreaterThan(0.8); // Pass threshold
  });

  // Multi-turn eval
  test("get user then list projects > 80% accuracy", async () => {
    const evalTest = new EvalTest({
      name: "user-then-projects",
      test: async (runner) => {
        const r1 = await runner.run("Who am I in Asana?");
        if (!r1.hasToolCall("asana_get_user")) return false;

        const r2 = await runner.run("Now list my projects", {
          context: [r1],
        }); // Continue the conversation from the previous prompt
        return r2.hasToolCall("asana_get_projects");
      },
    });

    await evalTest.run(runner, {
      iterations: 5,
      onFailure: (report) => console.error(report),
    });

    expect(evalTest.accuracy()).toBeGreaterThan(0.8);
  });

  // Validating tool arguments
  test("search tasks passes correct workspace_gid", async () => {
    const evalTest = new EvalTest({
      name: "search-args",
      test: async (runner) => {
        const result = await runner.run(
          "Search for tasks containing 'bug' in my workspace"
        );
        const args = result.getToolArguments("asana_search_tasks");
        return (
          result.hasToolCall("asana_search_tasks") &&
          typeof args?.workspace_gid === "string"
        );
      },
    });

    await evalTest.run(runner, {
      iterations: 5,
      onFailure: (report) => console.error(report),
    });

    expect(evalTest.accuracy()).toBeGreaterThan(0.8);
  });
});
```

### Host + HostRuntime: bring your own runtime

`Host` is the portable host-configuration spec — the same object the MCPJam Inspector uses to drive its Playground and eval suites. You can build one in your own code and run evals against it, so the inspector and your CI exercise the same host behavior (style, model, MCP profile, sandbox/permission policy, OpenAI-Apps compat, tool-visibility policy, etc.).

```ts
import { MCPClientManager, Host, EvalTest } from "@mcpjam/sdk";

const manager = new MCPClientManager();
await manager.connectToServer("everything", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
});

// Build the spec — Host is just an editable wrapper around the canonical JSON.
const host = new Host({
  style: "mcpjam",
  model: "openai/gpt-4o",
  systemPrompt: "You are a helpful assistant.",
}).requireServer("everything");

// Bind the spec to a live MCP manager. `apiKey` lives on the runtime, not per-call.
const runtime = host.withManager(manager, { apiKey: process.env.OPENAI_API_KEY! });

const evalTest = new EvalTest({
  name: "add",
  test: async (runner) => (await runner.run("Add 2 and 3")).hasToolCall("add"),
});
await evalTest.run(runtime, { iterations: 10 });
```

**`HostRuntime.run()` is stateless across turns.** Prior `PromptResult`s accumulate in `runtime.getPromptHistory()` for inspection but are NOT auto-replayed. Multi-turn continuity stays explicit via `PromptOptions.context`:

```ts
const r1 = await runtime.run("Who am I?");
const r2 = await runtime.run("List my projects", { context: [r1] });
```

**Static specs use `HostRunner` directly.** When you've already resolved the tool set and don't need live-binding to a manager, skip the runtime and pass `host` straight into `HostRunner`:

```ts
import { HostRunner } from "@mcpjam/sdk";

const runner = new HostRunner({
  host: host.toJSON(),
  tools: await manager.getToolsForAiSdk(["everything"]),
  apiKey: process.env.OPENAI_API_KEY!,
});
```

`HostRunner` snapshots the host once at construction; post-construction mutations to the original `Host` do NOT affect the runner. `HostRuntime` snapshots on every `.run()` so live mutations to the bound `Host` take effect on the next iteration.

**One-shot sugar:**

```ts
await host.run("write me a haiku", {
  apiKey: process.env.OPENAI_API_KEY!,
  mcpClientManager: manager,
});
```

#### Eval reporting (Stage 5)

When the inspector backend advertises the `evalsHostConfig` capability at `GET /sdk/v1/info`, the eval reporter additionally sends `{ hostConfig, hostConfigHash }` so the persisted run row in the MCPJam UI shows the exact host you ran with. Source order:

1. `iteration.hostSnapshot` (per-iteration capture from `HostRuntime`)
2. `executor.getHostSnapshot?.()` (fallback for executors that don't expose per-iteration snapshots)
3. `MCPJamReportingConfig.host` (explicit override, compatibility path)

Pass-1 only sends a run-level host config when all iteration snapshots canonicalize to the same hash. If you mutate the bound `Host` between iterations, the reporter omits the run-level field (per-iteration wire support is a later stage). Old backends without the capability are unaffected.

#### `@mcpjam/sdk/host-config/internal`

The `internal` subpath exposes the canonicalizer, hasher, normalizer, and policy resolvers (`canonicalizeHostConfigV2`, `computeHostConfigHashV2`, `normalizeSdkEvalHostConfigForWire`, `extractHostExecutionPolicy`, `resolveOpenAiCompatForHostConfig`, …) that the MCPJam backend and the inspector server both import. It is **first-party-only, not semver-stable** — external consumers should use the `Host` facade. The MCPJam backend `convex/lib/hostConfigV2.ts` imports the canonicalizer directly from this subpath so there is exactly one source of truth shared between the SDK and the persisted `hostConfigs` rows.

---

### OAuth Conformance

Test that your MCP server's OAuth implementation works across all registration methods and protocol versions.

```ts
import { OAuthConformanceTest, OAuthConformanceSuite } from "@mcpjam/sdk";

// Single flow
const test = new OAuthConformanceTest({
  serverUrl: "https://your-server.com/mcp",
  protocolVersion: "2025-11-25",
  registrationStrategy: "dcr",
  auth: { mode: "headless" },
  verification: { listTools: true },
});

const result = await test.run();
console.log(result.passed); // true
console.log(result.summary); // "OAuth conformance passed for ..."

// Suite: test multiple flows at once
const suite = new OAuthConformanceSuite({
  serverUrl: "https://your-server.com/mcp",
  defaults: { verification: { listTools: true } },
  flows: [
    {
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
      auth: { mode: "interactive" },
    },
    {
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      auth: { mode: "interactive" },
    },
    {
      protocolVersion: "2025-11-25",
      registrationStrategy: "preregistered",
      auth: {
        mode: "client_credentials",
        clientId: "id",
        clientSecret: "secret",
      },
      client: { preregistered: { clientId: "id", clientSecret: "secret" } },
    },
  ],
});

const suiteResult = await suite.run();
console.log(suiteResult.summary); // "All 3 flows passed for ..."
```

Or use the CLI:

```bash
# Single flow (M2M, no browser needed)
npx @mcpjam/cli oauth conformance \
  --url https://your-server.com/mcp \
  --protocol-version 2025-11-25 \
  --registration preregistered \
  --auth-mode client_credentials \
  --redirect-url https://app.example.com/oauth/callback \
  --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" \
  --verify-tools

# Suite from config file
npx @mcpjam/cli oauth conformance-suite --config ./oauth-tests.json

# Force human-readable output
npx @mcpjam/cli oauth conformance --url https://your-server.com/mcp --protocol-version 2025-11-25 --registration dcr --format human

# JUnit XML for CI
npx @mcpjam/cli oauth conformance-suite --config ./oauth-tests.json --format junit-xml > report.xml
```

### MCP Apps Conformance

Validate the server-side MCP Apps surface your server exposes through tools and `ui://` resources.

```ts
import { MCPAppsConformanceTest } from "@mcpjam/sdk";

const test = new MCPAppsConformanceTest({
  url: "https://your-server.com/mcp",
  timeout: 30_000,
});

const result = await test.run();
console.log(result.passed);
console.log(result.summary);
```

Or use the CLI:

```bash
# Full MCP Apps surface check
npx @mcpjam/cli apps conformance \
  --url https://your-server.com/mcp \
  --format human

# Focus on resource checks only
npx @mcpjam/cli apps conformance \
  --url https://your-server.com/mcp \
  --category resources
```

The current runner validates tool metadata, `ui://` resource discovery, `resources/read`, HTML payload shape, and `_meta.ui` metadata such as `csp`, `permissions`, `domain`, and `prefersBorder`.

It does **not** yet validate full host-side SEP-1865 behavior such as `ui/initialize`, sandbox proxy behavior, or host notification ordering.

---

## API Reference

<details>
<summary><strong>MCPClientManager</strong></summary>

Manages connections to one or more MCP servers.

```ts
const manager = new MCPClientManager();

// Connect to STDIO server
await manager.connectToServer("everything", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
});

// Connect to HTTP/SSE server
await manager.connectToServer("asana", {
  url: "https://mcp.asana.com/sse",
  requestInit: {
    headers: { Authorization: "Bearer TOKEN" },
  },
});

// Get tools for HostRunner
const tools = await manager.getToolsForAiSdk(["everything", "asana"]);

// Direct MCP operations
await manager.listTools("everything");
await manager.executeTool("everything", "add", { a: 1, b: 2 });
await manager.listResources("everything");
await manager.readResource("everything", { uri: "file:///tmp/test.txt" });
await manager.listPrompts("everything");
await manager.getPrompt("everything", { name: "greeting" });
await manager.pingServer("everything");

// Disconnect
await manager.disconnectServer("everything");
```

Retry policy is SDK-owned and disabled by default. To enable transient retries for connection and read-style manager operations, pass a manager-level policy:

```ts
const manager = new MCPClientManager(
  {},
  {
    retryPolicy: {
      retries: 2,
      retryDelayMs: 3000,
    },
  }
);
```

The manager applies that policy to `connectToServer()` when called directly and to read/diagnostic methods such as `listTools`, `listResources`, `readResource`, `listPrompts`, `getPrompt`, `pingServer`, and task reads. Read retries wrap the full connect plus RPC operation, so a single retry budget covers reconnect and the follow-on request together.

Tool execution stays single-shot unless you opt in explicitly at the call site:

```ts
await manager.executeTool(
  "everything",
  "add",
  { a: 1, b: 2 },
  {
    retry: {
      retries: 1,
      retryDelayMs: 1000,
    },
  }
);
```

`withEphemeralClient()`, `probeMcpServer()`, and `runServerDoctor()` also accept the same `retryPolicy` shape. Retry classifiers are intentionally conservative in v1: transient network/connect/reset/DNS/timeout failures and HTTP `408`, `425`, `429`, and `5xx` are retryable; auth, validation, and method-unavailable errors are not.

</details>

<details>
<summary><strong>HostRunner</strong></summary>

Runs LLM prompts with MCP tool access.

```ts
import { hasToolCall } from "@mcpjam/sdk";

const runner = new HostRunner({
  tools: await manager.getToolsForAiSdk(),
  model: "openai/gpt-4o", // provider/model format
  apiKey: process.env.OPENAI_API_KEY!,
  systemPrompt: "You are a helpful assistant.", // optional
  temperature: 0.7, // optional, omit for reasoning models
  maxSteps: 10, // optional, max tool call loops
});

// Run a prompt
const result = await runner.run("Add 2 and 3");

// Multi-turn with context
const r1 = await runner.run("Who am I?");
const r2 = await runner.run("List my projects", { context: [r1] });

// Stop the loop after the step where a tool is called
const r3 = await runner.run("Search tasks", {
  stopWhen: hasToolCall("search_tasks"),
});
r3.hasToolCall("search_tasks"); // true

// Bound prompt runtime
const r4 = await runner.run("Run a long workflow", {
  timeout: { totalMs: 10_000, stepMs: 2_500 },
});
r4.hasError(); // true if the prompt timed out

// Exit early after selecting a tool without waiting for the MCP round-trip
const r5 = await runner.run("Search tasks", {
  stopAfterToolCall: "search_tasks",
  timeoutMs: 5_000,
});
r5.getToolArguments("search_tasks"); // captured even if the prompt stops early
```

`stopWhen` does not skip tool execution. It controls whether the prompt loop continues after the current step completes, and `HostRunner` also applies `stepCountIs(maxSteps)` as a safety guard.

`timeout` bounds prompt runtime. `number` and `totalMs` cap the full prompt, `stepMs` caps each step, and `chunkMs` is accepted for parity but mainly matters in streaming flows. The runtime creates an internal abort signal, so tools can stop early if their implementation respects the provided `abortSignal`.

`stopAfterToolCall` is intended for evals that only care about tool selection and arguments. The targeted tool is short-circuited with a stub result, and the `PromptResult` still includes the tool name and args. If multiple tools are emitted in the same step, non-target siblings may still execute before the loop stops.

**Supported providers:** `openai`, `anthropic`, `azure`, `google`, `mistral`, `deepseek`, `ollama`, `openrouter`, `xai`

</details>

<details>
<summary><strong>PromptResult</strong></summary>

Returned by `runner.run()`. Contains the LLM response and tool calls.

```ts
const result = await runner.run("Add 2 and 3");

// Tool calls
result.hasToolCall("add"); // boolean
result.toolsCalled(); // ["add"]
result.getToolCalls(); // [{ toolName: "add", arguments: { a: 2, b: 3 } }]
result.getToolArguments("add"); // { a: 2, b: 3 }

// Response
result.text; // "The result is 5"

// Messages (full conversation)
result.getMessages(); // CoreMessage[]
result.getUserMessages(); // user messages only
result.getAssistantMessages(); // assistant messages only
result.getToolMessages(); // tool result messages only

// Latency
result.e2eLatencyMs(); // total wall-clock time
result.llmLatencyMs(); // LLM API time
result.mcpLatencyMs(); // MCP tool execution time

// Tokens
result.totalTokens();
result.inputTokens();
result.outputTokens();

// Errors
result.hasError();
result.getError();

// Debug trace (JSON dump of messages)
result.formatTrace();
```

</details>

<details>
<summary><strong>EvalTest</strong></summary>

Runs a single test scenario with multiple iterations.

```ts
const test = new EvalTest({
  name: "addition",
  test: async (runner) => {
    const result = await runner.run("Add 2 and 3");
    return result.hasToolCall("add");
  },
});

await test.run(runner, {
  iterations: 30,
  concurrency: 5, // parallel iterations (default: 5)
  retries: 2, // retry failed iterations (default: 0)
  timeoutMs: 30000, // aborts the active prompt at 30s, then waits up to 1s for it to settle
  onProgress: (completed, total) => console.log(`${completed}/${total}`),
  onFailure: (report) => console.error(report), // called if any iteration fails
});

// Metrics
test.accuracy(); // success rate (0-1)
test.averageTokenUse(); // avg tokens per iteration

// Iteration details
test.getAllIterations(); // all iteration results
test.getFailedIterations(); // failed iterations only
test.getSuccessfulIterations(); // successful iterations only
test.getFailureReport(); // formatted string of failed traces
```

</details>

<details>
<summary><strong>EvalSuite</strong></summary>

Groups multiple `EvalTest` instances for aggregate metrics.

```ts
const suite = new EvalSuite({ name: "Math Operations" });

suite.add(
  new EvalTest({
    name: "addition",
    test: async (runner) => {
      const r = await runner.run("Add 2+3");
      return r.hasToolCall("add");
    },
  })
);

suite.add(
  new EvalTest({
    name: "multiply",
    test: async (runner) => {
      const r = await runner.run("Multiply 4*5");
      return r.hasToolCall("multiply");
    },
  })
);

await suite.run(runner, { iterations: 30 });

// Aggregate metrics
suite.accuracy(); // overall accuracy
suite.averageTokenUse();

// Individual test access
suite.get("addition")?.accuracy();
suite.get("multiply")?.accuracy();
suite.getAll(); // all EvalTest instances
```

</details>

<details>
<summary><strong>Validators</strong></summary>

Helper functions for matching tool calls.

```ts
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

const tools = result.toolsCalled(); // ["add", "multiply"]
const calls = result.getToolCalls(); // ToolCall[]

// Exact match (order matters)
matchToolCalls(["add", "multiply"], tools); // true
matchToolCalls(["multiply", "add"], tools); // false

// Subset match (order doesn't matter)
matchToolCallsSubset(["add"], tools); // true

// Any match (at least one)
matchAnyToolCall(["add", "subtract"], tools); // true

// Count match
matchToolCallCount("add", tools, 1); // true

// No tools called
matchNoToolCalls([]); // true

// Argument matching
matchToolCallWithArgs("add", { a: 2, b: 3 }, calls); // exact match
matchToolCallWithPartialArgs("add", { a: 2 }, calls); // partial match
matchToolArgument("add", "a", 2, calls); // single arg
matchToolArgumentWith("add", "a", (v) => v > 0, calls); // predicate
```

</details>

---

## Telemetry

The SDK collects anonymous usage metrics (e.g., eval test run counts) to help improve the product. No personal data is collected.

To disable telemetry, set either of these environment variables:

```bash
export DO_NOT_TRACK=1
# or
export MCPJAM_TELEMETRY_DISABLED=1
```
