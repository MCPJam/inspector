# E2E testing framework for MCP servers

## Objective

Companies like Asana, Paypal, Sentry, are hosting MCP servers in production. These companies need to know that their servers are up and running in production, and that the server is working for their customers' workflows.

The purpose of End to End (E2E) testing for MCP servers is to simulate customers' workflows and ensure they're returning the right results. The high level logic of an E2E test is as follows:

1. Developer defines an E2E test

```
{
    servers: [
        "asana": {
            "command": "npx",
            "args": ["mcp-remote", "https://mcp.asana.com/sse"]
        },
    ],
    test_cases: [
        {
            query: "What Asana workspace am I in?"
            expected: "The workspace 'MCPJam' is returned"
        },
        {
            query: "Create a task called 'Build E2E test'",
            expected: "<important>Task must be in the MCPJam workspace</important>. The task 'Build E2E test' is created"
        }
    ]
}
```

2. Test are ran through an Agent. The agent connects to the MCP servers, runs through the test cases (in parallel preferrably) and the tracing is outputted.
3. The trace is passed into an LLM as a judge. The judge agent will look at the trace to determine the performance and score of the E2E test.

### Prompt discovery test

The purpose of the prompt discovery test is to find out what prompts are breaking. We have an agent that looks at the tools of the MCP server and generates new queries. E2E tests will be ran on these new queries. If they're breaking, then we know that workflow is broken.

Prompt discovery tests are useful for discovering new workflows to test and make sure they're working. This test essentially is an edge case finder.

### Benchmark test

We want MCPJam customers to create a benchmark E2E test. Our customer would create a test definition (like example in step 1) with the most popular user queries. We would periodically run these tests to catch for any regressions in the server.

For example, the benchmark might be 70% of the tests pass. If that drops to 30%, then we know there's been a regression.

## Product spec requirements

### Benchmark test is in MCPJam

- New tab in MCPJam inspector called "Benchmark E2E tests"
- User defines an E2E test in the UI. User can create an E2E for any connected server in MCPJam.
- User can run the E2E test. Results and score is shown.
- Display thinking and agent tracing in the UI.
- We'll have the base open source version, where you can run a benchmark on any server. We'll have paid cloud features where you can save your runs and see them over time.

### Prompt discovery test

- Requirement is that it can generate new prompts and run the E2E tests on each new prompt.
- Prompt discovery test will not be in MCPJam open source
- We'll build this privately, offer prompt discovery E2E as a service for enterprise.
- We'll manually test their MCP servers this way ourselves.
