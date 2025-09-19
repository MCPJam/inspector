# MCPJam Evals Testing CLI

We built a CLI that performs MCP evals and End to End (E2E) testing. The CLI creates a simulated end user’s environment and tests popular user flows.

Evals helps you:

- Discover workflows that are breaking your server and get actionable ways on resolving them.
- Benchmark your server’s performance and catch regressions in future changes.
- Programatically test queries on a MCP server with a command. No more doing QA one by one.

### Install

```bash
npm install -g @mcpjam/cli
```

### Set up tests

To set up, create a new folder directory for your test. In that directory, create three files:

- `environment.json` to set up your MCP server connections
- `tests.json` to configure your tests
- `llms.json` to store your LLM API keys

### Server connection file (environment.json)

This file is configured very similar to a `mcp.json` file. For servers with OAuth, you must provide your own `Bearer` API tokens. MCPJam CLI does not handle OAuth flows / DCR. For bearer tokens, make sure to wrap your header with `requestInit`.

```json
{
  "servers": {
    "asana": {
      "url": "https://mcp.asana.com/sse",
      "requestInit": {
        "headers": {
          "Authorization": "Bearer <ASANA_API_KEY>"
        }
      }
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      "env": {
        "ENV_1": "<ENV_1>"
      }
    }
  }
}
```

### Tests file (tests.json)

The test file is an array of tests.

```json
[
  {
    "title": "Workspace test",
    "query": "What is my asana workspace?",
    "runs": 1, // Number of times to run this test
    "model": "anthropic/claude-3.7-sonnet",
    "provider": "openrouter", // Provider name: "anthropic" | "openai" | "openrouter"
    "expectedToolCalls": ["asana_list_workspaces"]
  },
  {
    "title": "Workspace users test",
    "query": "Can you figure out who is in the workspace?",
    "runs": 1,
    "model": "anthropic/claude-3.7-sonnet",
    "provider": "openrouter",
    "expectedToolCalls": ["asana_list_workspaces", "asana_get_workspace_users"]
  }
]
```

### LLM API key file (llms.json)

```json
{
  "anthropic": "<ANTHROPIC_API_KEY>",
  "openai": "<OPENAI_API_KEY>",
  "openrouter": "<OPENROUTER_API_KEY>"
}
```

### Run MCP Eval

```bash
mcpjam evals run --tests tests.json --environment environment.json --llms llms.json
```

#### Short flags

```bash
mcpjam evals run -t tests.json -e environment.json -l llms.json
```

#### CLI Options

- `--tests, -t <file>`: Path to the tests configuration file (required)
- `--environment, -e <file>`: Path to the environment configuration file (required)
- `--llms, -l <file>`: Path to the LLM API key configuration file
- `--help, -h`: Show help information
- `--version, -V`: Display version number
