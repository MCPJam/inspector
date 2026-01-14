# MCPJam SDK Spec Proposal

The MCPJam SDK `@mcpjam/sdk` provides utilities for MCP server unit testing, end to end (e2e) testing, and server evals. 

Below is the proposal for the SDK. If you have any suggestions for improvements, please leave a comment below. 

## SDK use cases & intended user 

The SDK is useful for: 
- MCP server developers 
- MCP client developers 
- MCP-apps / ChatGPT apps marketplace maintainers 
- SDK developers

Example use cases: 
- Unit test and evaluate MCP servers for server developers. ⭐
- Implement a spec-compliant MCP client with an LLM - for client developers 
- Maintainers of a apps marketplace can test performance and security of apps on their marketplace
- Write conformance tests on MCP server code in the MCP SDKs. 

## MCPClientManager (complete)
The official [Typescript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/client/src/client) contains the `Client` class. This object handles the connection between the MCP client and the server, sending and receiving JSON-RPC messages. This `Client` object is limited to a single MCP connection. 

`MCPClientManager` is a proposed class in the MCPJam SDK that handles multiple `Client` objects. It manages a dictionary of `Client` objects. The `serverId` mapped to the Client. 
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
  tools: manager.getToolsForAiSdk(),
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
    tools: manager.getTools(), 
    llm: "openai/gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
    systemPrompt: "You are an ...",
    temperature: 0.8,
}); 
```

### `EvalsSuite`

`EvalsSuite` is used to run evals tests in many iterations. `EvalsSuite.run()` takes in a function (single test run). This function must return a boolean (test pass / fails). It also takes in the # of iterations. 

`EvalsSuite`'s run result can be used to extract the following information: 
- Accuracy
- Recall
- True Positive Rate
- False Positive Rate 
- Precision

You can also analyze the runs' token usage / costs. 

The techniques we use to measure the success of evals comes from [this article](https://www.mcpjam.com/blog/mcp-evals) from the MCPJam blog. 

We use Jest for running evals. 

### Full example
```ts
import { MCPClientManager, TestAgent, EvalsSuite } from "@mcpjam/sdk";

beforeEach(() => {
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
});

test('create new project calls the right tool', () => {
    const iteration = () => {
        const testAgent = new TestAgent({
            tools: manager.getTools(), 
            llm: "openai/gpt-4o",
            apiKey: process.env.OPENAI_API_KEY,
            systemPrompt: "You are an ...",
            temperature: 0.8,
        }); 
        const result = testAgent.query("Can you create a new Asana project called 'Onboard Joe'")
        return result.toolsCalled().contains("asana_create_project"); 
    }

    const evalsSuite = new EvalsSuite();

    const runs = evalsSuite.run({
        func: iteration, 
        iterations: 30
    })

    expect(runs.accuracy()).toBeGreaterThan(0.9); 
    expect(runs.recall()).toBeGreaterThan(0.6);
    expect(runs.falsePositiveRate()).toBeLessThan(0.1); 
    expect(runs.precision()).toBeGreaterThan(0.9); 

    expect(runs.averageTokenUse()).toBeLessThan(10000); 
});

```