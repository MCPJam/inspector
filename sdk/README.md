# MCPJam SDK

The MCPJam SDK `@mcpjam/sdk` provides utilities for MCP server unit testing, end to end (e2e) testing, and server evals.

## SDK use cases & intended user

The SDK is useful for:
- MCP server developers
- MCP client developers
- MCP-apps / ChatGPT apps marketplace maintainers
- SDK developers

Example use cases:
- Unit test and evaluate MCP servers for server developers.
- Implement a spec-compliant MCP client with an LLM - for client developers
- Maintainers of a apps marketplace can test performance and security of apps on their marketplace
- Write conformance tests on MCP server code in the MCP SDKs.

## MCPClientManager

The official [Typescript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/client/src/client) contains the `Client` class. This object handles the connection between the MCP client and the server, sending and receiving JSON-RPC messages. This `Client` object is limited to a single MCP connection.

`MCPClientManager` is a class in the MCPJam SDK that handles multiple `Client` objects. It manages a dictionary of `Client` objects. The `serverId` mapped to the Client.

```ts
const clientConnections = new Map()<string, Client>
```

Connecting to an MCP server via `MCPClientManager` uses the familiar `mcp.json` format:

```ts
  const manager = new MCPClientManager(
    {
      // STDIO server
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
      // SSE / Streamable HTTP server
      asana: {
        url: new URL("https://mcp.asana.com/sse"),
        requestInit: {
            headers: {
                Authorization: "Bearer YOUR_TOKEN",
            },
        },
      }
    },
    { name: 'mcpjam', version: '1.0.0' },
    { capabilities: {} }
  );
```


### `MCPClientManager` capabilities
The capabilities of the client manager should match all capabilities of the native `Client`. For every operation in `Client`, we can do the same exact operation except having to specify the `serverId`.

```ts
  import { MCPClientManager } from "@mcpjam/sdk"
  const manager = new MCPClientManager(
    {
      // STDIO server
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
      // SSE / Streamable HTTP server
      asana: {
        url: new URL("https://mcp.asana.com/sse"),
        requestInit: {
            headers: {
                Authorization: "Bearer YOUR_TOKEN",
            },
        },
      }
    },
    { name: 'mcpjam', version: '1.0.0' },
    { capabilities: {} }
  );

  // List tools
  const tools = await manager.listTools("everything");
  console.log(tools);

  // Execute tool
  const addToolResult = await manager.executeTool("everything", "add", {
    a: 1,
    b: 2,
  });
  console.log(addToolResult);

  // List resources
  const resources = await manager.listResources("everything");

  // Read resource
  const resource = await manager.readResource("everything", {
    uri: "test://static/resource/1",
  });

  // Subscribe to resource
  const subscription = await manager.subscribeResource("everything", {
    uri: "test://static/resource/1",
  });

  // Unsubscribe from resource
  await manager.unsubscribeResource("everything", {
    uri: "test://static/resource/1",
  });

  // List prompts
  const prompts = await manager.listPrompts("everything");

  // Get prompt
  const prompt = await manager.getPrompt("everything", {
    name: "simple_prompt",
  });

  // Ping server
  await manager.pingServer("everything");

  // Disconnect server
  await manager.disconnectServer("everything");
```

### Integration with an agent SDK (like Vercel AI-SDK)
Has the capability to expose tools and other MCP properties to agent SDKs such as Vercel AI SDK. Extensible to other agent SDK's like Mastra and Langchain.

This is valuable if you're building an AI assistant connect to MCP - any real world MCP client. Will also be used for MCP server evals / e2e testing where LLM's are involved.

```ts
// Integrate with Vercel AI SDK
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const manager = new MCPClientManager(
    {
        ...
    },
    { name: 'mcpjam', version: '1.0.0' },
    { capabilities: {} }
);

const response = await generateText({
  model: openai("gpt-4o-mini"),
  tools: await manager.getToolsForAiSdk(),
  messages: [{ role: "user", content: "List files in /tmp" }],
});

console.log(response) // The files in /tmp are ...
```

## Unit Testing

MCP primitives like tools, resources, prompts, etc. are at its foundation functions with deterministic return values. MCP unit testing tests your MCP server's primitives.

How MCP unit testing works:
1. `MCPClientManager` connects to your MCP server.
2. `MCPClientManager` invokes functions such as `listTools`, `callTool`, `readResource`, etc. This sends JSON-RPC messages to your MCP server.
3. We test that your MCP server responds properly to these requests.

You can use any testing framework such as Jest for unit testing. We envision unit tests to live inside the MCP server code base. See the [Bright Data MCP server](https://github.com/brightdata/brightdata-mcp) for example, they have MCPJam evals CLI test cases inside the codebase. Unit tests can be run manually by developers, or integrated in a CI/CD pipeline.

Example of unit testing an MCP server with Jest and `@mcpjam/sdk`:

```ts
import { MCPClientManager } from "@mcpjam/sdk";

beforeEach(() => {
    const clientManager = new MCPClientManager(
        {
            asana: {
                url: new URL("https://staging.asana.com/mcp"),
                requestInit: {
                    headers: {
                        Authorization: "Bearer abCD2EfG",
                    },
                },
            }
        },
        { name: 'mcpjam', version: '1.0.0' },
        { capabilities: {} }
    );
});

test('Server connection works', () => {
    await expect(clientManager.ping("asana")).resolves.not.toThrowError();
});

test('Server has the right capabilities', () => {
    const capabilities = clientManager.listServerCapabilities("asana");
    expect(capabilities.tools).toBeDefined();
    expect(capabilities.tasks).toBeUndefined();
    ...
});

test('Server has the right tools', () => {
    const tools = clientManager.listTools("asana");
    expect(tools.length).toBe(26);
    expect(tools[0].name).toBe("asana_list_projects");
    ...
})

test('Call asana_list_projects fetches projects properly', () => {
    ...
})

// Deterministically test any capability of the MCP server.
```

## Testing ChatGPT apps / MCP apps (ext-apps)

Test compliance with ChatGPT apps SDK and MCP apps. Used for app developers to maintain the server's compliance to ext-apps. Can also be used by app marketplace maintainers to test that apps are valid.

Examples of testing for MCP apps (ext-apps).

```ts
import { MCPClientManager } from "@mcpjam/sdk";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";

beforeEach(() => {
  const manager = new MCPClientManager(
      {
          sip-cocktails: {
              url: new URL("https://localhost:3000/mcp"),
          }
      },
      { name: 'mcpjam', version: '1.0.0' },
      { capabilities: {} }
  );
});

test('tools with UI contain a correct resource Uri', () => {
  const allTools = manager.listTools("sip-cocktails");
  expect(getToolUiResourceUri(allTools[0])).toBeDefined();
  expect(getToolUiResourceUri(allTools[0])).toBe("ui://cocktail/cocktail-recipe-widget.html");
});

test('cocktail widget has the proper CSP configurations', () => {
  const cocktailWidgetResource = manager.readResource("sip-cocktails", {
    uri: "ui://cocktail/cocktail-recipe-widget.html",
  })
  expect(cocktailWidgetResource.contents[0]._meta._ui.csp.connectedDomains.length).toBe(3);
  ...
});

```

## Evaluations

MCP evals helps measure a MCP server's "tool ergonomics", designing MCP tools so that an LLM understands how to use them.

Here's how MCP evals works:

1. A mock agent is launched and connected to your MCP server, simulating how clients like Claude Code, Cursor, or ChatGPT would interact with it.
2. The agent is exposed to your server's entire toolset.
3. We give the agent a prompt, simulating a user asking the LLM a real-world question.
4. The agent runs the query, makes decisions on whether or not to call a tool. Executes tools and spits an output.
5. We examine the agent's output, evaluate whether or not the right tool was called.

### `TestAgent`

`TestAgent` is the simulated agent that has access to all tools from the client manager. Set up the LLM with API key, system prompt, and temperature.

```ts
const testAgent = new TestAgent({
    tools: await manager.getToolsForAiSdk(),
    llm: "openai/gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
    systemPrompt: "You are an ...",
    temperature: 0.8,
    maxSteps: 10, // Maximum agentic loop steps (default: 10)
});
```

#### Supported LLM Providers

The SDK supports 9 built-in providers:
- `anthropic` - Anthropic (Claude models)
- `openai` - OpenAI
- `azure` - Azure OpenAI
- `deepseek` - DeepSeek
- `google` - Google AI (Gemini models)
- `ollama` - Ollama (local models)
- `mistral` - Mistral AI
- `openrouter` - OpenRouter
- `xai` - xAI (Grok models)

Custom providers (OpenAI-compatible or Anthropic-compatible endpoints) are also supported via the `customProviders` option.

### `QueryResult`

When you call `testAgent.query()`, you get back a `QueryResult` object with rich information:

```ts
const result = await testAgent.query("Add 2 and 3");

// Tool calls
result.toolsCalled();                    // string[] - e.g., ["add"]
result.hasToolCall("add");               // boolean
result.getToolCalls();                   // ToolCall[] with arguments
result.getToolArguments("add");          // { a: 2, b: 3 }

// Latency breakdown
result.e2eLatencyMs();                   // Total wall-clock time
result.llmLatencyMs();                   // LLM API call time
result.mcpLatencyMs();                   // MCP tool execution time
result.getLatency();                     // { e2eMs, llmMs, mcpMs }

// Token usage
result.totalTokens();
result.inputTokens();
result.outputTokens();

// Error handling
result.hasError();                       // boolean
result.getError();                       // string | undefined

// Response text
result.text;                             // LLM response text
```

### `EvalTest` - Single Test Scenario

`EvalTest` runs a single test scenario with multiple iterations. It can be run standalone or as part of an `EvalSuite`.

```ts
import { EvalTest } from "@mcpjam/sdk";

const test = new EvalTest({
  name: "addition",
  query: "Add 2+3",
  expectTools: ["add"],
});

await test.run(agent, { iterations: 30 });
console.log(test.accuracy()); // 0.97
```

#### Expectation Options

- `expectTools` - All expected tools must be called (any order)
- `expectExactTools` - Exact tools in exact order
- `expectAnyTool` - At least one of the expected tools called
- `expectNoTools` - No tools should be called
- `validator` - Custom validation function

#### Custom Validator

```ts
const test = new EvalTest({
  name: "addition-args",
  query: "What is 2 + 3?",
  validator: (result) => {
    const calls = result.getToolCalls();
    const addCall = calls.find(c => c.toolName === "add");
    return addCall?.arguments?.a === 2 && addCall?.arguments?.b === 3;
  },
});

await test.run(agent, { iterations: 30 });
```

#### Multi-turn Conversations

```ts
const test = new EvalTest({
  name: "search-and-summarize",
  conversation: async (agent) => {
    const r1 = await agent.query("Search for X");
    if (!r1.toolsCalled().includes("search")) {
      return { pass: false, results: [r1] };
    }
    const r2 = await agent.query(`Summarize: ${r1.text}`);
    return {
      pass: r2.toolsCalled().includes("summarize"),
      results: [r1, r2]
    };
  },
});

await test.run(agent, { iterations: 5 });
```

#### Run Options

```ts
await test.run(agent, {
  iterations: 30,
  concurrency: 5,              // Parallel iterations (default: 5)
  retries: 2,                  // Retry failed iterations (default: 0)
  timeoutMs: 30000,            // Timeout per iteration (default: 30000)
  onProgress: (completed, total) => {
    console.log(`Progress: ${completed}/${total}`);
  },
});
```

### `EvalSuite` - Group Multiple Tests

`EvalSuite` groups multiple `EvalTest` instances and provides aggregate metrics across all tests.

```ts
import { EvalSuite, EvalTest } from "@mcpjam/sdk";

const suite = new EvalSuite({ name: "Math Operations" });
suite.add(new EvalTest({ name: "addition", query: "Add 2+3", expectTools: ["add"] }));
suite.add(new EvalTest({ name: "multiply", query: "Multiply 4*5", expectTools: ["multiply"] }));

await suite.run(agent, { iterations: 30 });

console.log(suite.accuracy());                 // Aggregate: 0.95
console.log(suite.get("addition").accuracy()); // Individual: 0.97
console.log(suite.get("multiply").accuracy()); // Individual: 0.93
```

### Metrics and Results

Both `EvalTest` and `EvalSuite` provide these metrics after running:

```ts
test.accuracy();              // Success rate
test.recall();                // True positive rate
test.precision();             // Precision
test.truePositiveRate();      // Same as recall
test.falsePositiveRate();     // False positive rate
test.averageTokenUse();       // Average tokens per iteration
```

The `EvalRunResult` contains detailed data:

```ts
interface EvalRunResult {
  iterations: number;
  successes: number;
  failures: number;
  results: boolean[];
  iterationDetails: IterationResult[];
  tokenUsage: {
    total: number;
    perIteration: number[];
  };
  latency: {
    e2e: LatencyStats;               // { min, max, mean, p50, p95 }
    llm: LatencyStats;
    mcp: LatencyStats;
    perIteration: LatencyBreakdown[];
  };
}
```

### Validators

The SDK provides 9 validator functions for tool call matching:

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

// Exact match - all expected tools in exact order
matchToolCalls(["add", "multiply"], result.toolsCalled());

// Subset match - all expected present, any order
matchToolCallsSubset(["add"], result.toolsCalled());

// Any match - at least one matches
matchAnyToolCall(["add", "subtract"], result.toolsCalled());

// Count match - tool called exactly N times
matchToolCallCount("add", result.toolsCalled(), 2);

// No tools called
matchNoToolCalls(result.toolsCalled());

// Argument matching
matchToolCallWithArgs("add", { a: 2, b: 3 }, result.getToolCalls());
matchToolCallWithPartialArgs("add", { a: 2 }, result.getToolCalls());
matchToolArgument("add", "a", 2, result.getToolCalls());
matchToolArgumentWith("echo", "message", (v) => typeof v === "string", result.getToolCalls());
```

### Full Example

```ts
import { MCPClientManager, TestAgent, EvalTest, EvalSuite } from "@mcpjam/sdk";

const manager = new MCPClientManager(
  {
    asana: {
      url: new URL("https://mcp.asana.com/sse"),
      requestInit: {
        headers: {
          Authorization: "Bearer abCD2EfG",
        },
      },
    }
  },
  { name: 'mcpjam', version: '1.0.0' },
  { capabilities: {} }
);

await manager.connectToServer("asana");

const testAgent = new TestAgent({
  tools: await manager.getToolsForAiSdk(["asana"]),
  llm: "openai/gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  systemPrompt: "You are an assistant with access to Asana.",
  temperature: 0.8,
});

// Single test standalone
const createProjectTest = new EvalTest({
  name: "create-project",
  query: "Create a new Asana project called 'Onboard Joe'",
  expectTools: ["asana_create_project"],
});

await createProjectTest.run(testAgent, { iterations: 30, concurrency: 5 });

console.log("Accuracy:", createProjectTest.accuracy());
console.log("E2E P50:", createProjectTest.getResults()?.latency.e2e.p50, "ms");
console.log("Total tokens:", createProjectTest.getResults()?.tokenUsage.total);
```

## Using with Jest

```ts
import { MCPClientManager, TestAgent, EvalTest, EvalSuite } from "@mcpjam/sdk";

describe("Asana MCP Server Evals", () => {
  let manager: MCPClientManager;
  let testAgent: TestAgent;
  let suite: EvalSuite;

  beforeAll(async () => {
    manager = new MCPClientManager(
      {
        asana: {
          url: new URL("https://mcp.asana.com/sse"),
          requestInit: {
            headers: { Authorization: "Bearer abCD2EfG" },
          },
        }
      },
      { name: 'mcpjam', version: '1.0.0' },
      { capabilities: {} }
    );
    await manager.connectToServer("asana");

    testAgent = new TestAgent({
      tools: await manager.getToolsForAiSdk(["asana"]),
      llm: "openai/gpt-4o",
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Set up the test suite
    suite = new EvalSuite({ name: "Asana Operations" });
    suite.add(new EvalTest({
      name: "create-project",
      query: "Create a new Asana project called 'Onboard Joe'",
      expectTools: ["asana_create_project"],
    }));
    suite.add(new EvalTest({
      name: "list-tasks",
      query: "List all tasks in the Marketing project",
      expectTools: ["asana_list_tasks"],
    }));

    // Run all tests once
    await suite.run(testAgent, { iterations: 30 });
  });

  afterAll(async () => {
    await manager.disconnectServer("asana");
  });

  test("create project accuracy > 90%", () => {
    expect(suite.get("create-project")!.accuracy()).toBeGreaterThan(0.9);
  });

  test("list tasks accuracy > 90%", () => {
    expect(suite.get("list-tasks")!.accuracy()).toBeGreaterThan(0.9);
  });

  test("overall suite accuracy > 90%", () => {
    expect(suite.accuracy()).toBeGreaterThan(0.9);
  });
});
```
