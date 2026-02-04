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
    const result = await manager.executeTool("everything", "get-sum", { a: 2, b: 3 });
    expect(result.content[0].text).toBe("5");
  });
});
```

### MCP evals 

Test that an LLM correctly understands how to use your MCP server. Evals are non-deterministic and multiple runs are needed. 

```ts
import { MCPClientManager, TestAgent, EvalTest } from "@mcpjam/sdk";

describe("Asana MCP Evals", () => {
  let manager: MCPClientManager;
  let agent: TestAgent;

  beforeAll(async () => {
    manager = new MCPClientManager();
    await manager.connectToServer("asana", {
      url: "https://mcp.asana.com/sse",
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.ASANA_TOKEN}` },
      },
    });

    agent = new TestAgent({
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
      test: async (agent) => {
        const result = await agent.prompt("Show me all my Asana workspaces");
        return result.hasToolCall("asana_list_workspaces");
      },
    });

    await evalTest.run(agent, {
      iterations: 10,
      onFailure: (report) => console.error(report), // Print the report when a test iteration fails. 
    });

    expect(evalTest.accuracy()).toBeGreaterThan(0.8); // Pass threshold 
  });

  // Multi-turn eval
  test("get user then list projects > 80% accuracy", async () => {
    const evalTest = new EvalTest({
      name: "user-then-projects",
      test: async (agent) => {
        const r1 = await agent.prompt("Who am I in Asana?");
        if (!r1.hasToolCall("asana_get_user")) return false;

        const r2 = await agent.prompt("Now list my projects", { context: [r1] }); // Continue the conversation from the previous prompt
        return r2.hasToolCall("asana_get_projects");
      },
    });

    await evalTest.run(agent, {
      iterations: 5,
      onFailure: (report) => console.error(report),
    });

    expect(evalTest.accuracy()).toBeGreaterThan(0.8);
  });

  // Validating tool arguments
  test("search tasks passes correct workspace_gid", async () => {
    const evalTest = new EvalTest({
      name: "search-args",
      test: async (agent) => {
        const result = await agent.prompt("Search for tasks containing 'bug' in my workspace");
        const args = result.getToolArguments("asana_search_tasks");
        return result.hasToolCall("asana_search_tasks") && typeof args?.workspace_gid === "string";
      },
    });

    await evalTest.run(agent, {
      iterations: 5,
      onFailure: (report) => console.error(report),
    });

    expect(evalTest.accuracy()).toBeGreaterThan(0.8);
  });
});
```

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

// Get tools for AI SDK integration
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

</details>

<details>
<summary><strong>TestAgent</strong></summary>

Runs LLM prompts with MCP tool access.

```ts
const agent = new TestAgent({
  tools: await manager.getToolsForAiSdk(),
  model: "openai/gpt-4o",        // provider/model format
  apiKey: process.env.OPENAI_API_KEY!,
  systemPrompt: "You are a helpful assistant.",  // optional
  temperature: 0.7,              // optional, omit for reasoning models
  maxSteps: 10,                  // optional, max tool call loops
});

// Run a prompt
const result = await agent.prompt("Add 2 and 3");

// Multi-turn with context
const r1 = await agent.prompt("Who am I?");
const r2 = await agent.prompt("List my projects", { context: [r1] });
```

**Supported providers:** `openai`, `anthropic`, `azure`, `google`, `mistral`, `deepseek`, `ollama`, `openrouter`, `xai`

</details>

<details>
<summary><strong>PromptResult</strong></summary>

Returned by `agent.prompt()`. Contains the LLM response and tool calls.

```ts
const result = await agent.prompt("Add 2 and 3");

// Tool calls
result.hasToolCall("add");           // boolean
result.toolsCalled();                // ["add"]
result.getToolCalls();               // [{ toolName: "add", arguments: { a: 2, b: 3 } }]
result.getToolArguments("add");      // { a: 2, b: 3 }

// Response
result.text;                         // "The result is 5"

// Messages (full conversation)
result.getMessages();                // CoreMessage[]
result.getUserMessages();            // user messages only
result.getAssistantMessages();       // assistant messages only
result.getToolMessages();            // tool result messages only

// Latency
result.e2eLatencyMs();               // total wall-clock time
result.llmLatencyMs();               // LLM API time
result.mcpLatencyMs();               // MCP tool execution time

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
  test: async (agent) => {
    const result = await agent.prompt("Add 2 and 3");
    return result.hasToolCall("add");
  },
});

await test.run(agent, {
  iterations: 30,
  concurrency: 5,                    // parallel iterations (default: 5)
  retries: 2,                        // retry failed iterations (default: 0)
  timeoutMs: 30000,                  // timeout per iteration (default: 30000)
  onProgress: (completed, total) => console.log(`${completed}/${total}`),
  onFailure: (report) => console.error(report),  // called if any iteration fails
});

// Metrics
test.accuracy();                     // success rate (0-1)
test.averageTokenUse();              // avg tokens per iteration

// Iteration details
test.getAllIterations();             // all iteration results
test.getFailedIterations();          // failed iterations only
test.getSuccessfulIterations();      // successful iterations only
test.getFailureReport();             // formatted string of failed traces
```

</details>

<details>
<summary><strong>EvalSuite</strong></summary>

Groups multiple `EvalTest` instances for aggregate metrics.

```ts
const suite = new EvalSuite({ name: "Math Operations" });

suite.add(new EvalTest({
  name: "addition",
  test: async (agent) => {
    const r = await agent.prompt("Add 2+3");
    return r.hasToolCall("add");
  },
}));

suite.add(new EvalTest({
  name: "multiply",
  test: async (agent) => {
    const r = await agent.prompt("Multiply 4*5");
    return r.hasToolCall("multiply");
  },
}));

await suite.run(agent, { iterations: 30 });

// Aggregate metrics
suite.accuracy();                    // overall accuracy
suite.averageTokenUse();

// Individual test access
suite.get("addition")?.accuracy();
suite.get("multiply")?.accuracy();
suite.getAll();                      // all EvalTest instances
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

const tools = result.toolsCalled();      // ["add", "multiply"]
const calls = result.getToolCalls();     // ToolCall[]

// Exact match (order matters)
matchToolCalls(["add", "multiply"], tools);           // true
matchToolCalls(["multiply", "add"], tools);           // false

// Subset match (order doesn't matter)
matchToolCallsSubset(["add"], tools);                 // true

// Any match (at least one)
matchAnyToolCall(["add", "subtract"], tools);         // true

// Count match
matchToolCallCount("add", tools, 1);                  // true

// No tools called
matchNoToolCalls([]);                                 // true

// Argument matching
matchToolCallWithArgs("add", { a: 2, b: 3 }, calls);         // exact match
matchToolCallWithPartialArgs("add", { a: 2 }, calls);        // partial match
matchToolArgument("add", "a", 2, calls);                     // single arg
matchToolArgumentWith("add", "a", (v) => v > 0, calls);      // predicate
```

</details>
