# MCPJam SDK Proposal

The MCPJam SDK `@mcpjam/sdk` provides utilities for MCP server unit testing, end to end (e2e) testing, and server evals. 

Below is the proposal for the SDK. If you have any suggestions for improvements, please leave a comment below. 

## MCPClientManager
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