# MCPJam CLI

MCPJam CLI for programmatic MCP testing, designed for CI/CD integration and local development workflows.

## Installation

```bash
npm install -g @mcpjam/cli
```

## Usage

### Run MCP Evaluations

```bash
mcpjam evals run --tests weather-tests.json --environment local-dev.json
```

Short flags:

```bash
mcpjam evals run -t weather-tests.json -e local-dev.json
```

### CLI Options

- `--tests, -t <file>`: Path to the tests configuration file (required)
- `--environment, -e <file>`: Path to the environment configuration file (required)
- `--help, -h`: Show help information
- `--version, -V`: Display version number

### Example Files

The CLI includes example configuration files in the `examples/` directory:

- `test-servers.json`: Sample tests configuration
- `mcp-environment.json`: Sample environment configuration

## File Formats

### Tests File (mcp-tests.json)

```json
{
  "tests": [
    {
      "title": "Test weather tool",
      "prompt": "What's the weather in San Francisco?",
      "expectedTools": ["get_weather"],
      "model": { "id": "claude-3-5-sonnet-20241022", "provider": "anthropic" },
      "selectedServers": ["weather-server"],
      "advancedConfig": {
        "instructions": "You are a helpful weather assistant",
        "temperature": 0.1,
        "maxSteps": 5,
        "toolChoice": "auto"
      }
    }
  ]
}
```

### Environment File (mcp-environment.json)

```json
{
  "servers": {
    "weather-server": {
      "command": "python",
      "args": ["weather_server.py"],
      "env": {
        "WEATHER_API_KEY": "${WEATHER_API_KEY}"
      }
    },
    "api-server": {
      "url": "https://api.example.com/mcp/sse",
      "requestInit": {
        "headers": {
          "Authorization": "Bearer ${API_TOKEN}"
        }
      }
    }
  }
}
```

## Environment Variables

The CLI resolves template variables like `${ANTHROPIC_API_KEY}` from your environment at runtime.

Required environment variables depend on your test configuration:

- `ANTHROPIC_API_KEY` - For Claude models
- `OPENAI_API_KEY` - For OpenAI models
- `DEEPSEEK_API_KEY` - For DeepSeek models
- Custom variables for your MCP servers (e.g., `WEATHER_API_KEY`)

## Output Format

```
MCPJAM Evals v1.0.0

Running 3 tests against weather-server...

✅ Weather tool functionality
   Called tools: get_weather
   Duration: 1.2s

❌ Error handling test
   Called tools: get_weather, validate_location
   Missing: []
   Unexpected: validate_location
   Duration: 0.8s

Results: 2 passed, 1 failed (2.0s total)
```

## Supported Providers

- **anthropic**: Claude models via Anthropic API
- **openai**: GPT models via OpenAI API
- **deepseek**: DeepSeek models via DeepSeek API
- **ollama**: Local models via Ollama (requires Ollama to be running)

## Supported MCP Server Types

- **STDIO**: Local processes with command + args
- **HTTP**: Remote servers with URL + headers authentication

### Programmatic (TypeScript) configuration example for HTTP/SSE

When using SSE endpoints that require custom headers (e.g., Authorization), you must provide `eventSourceInit` so the SSE connection includes those headers. If you use a JSON environment file with `requestInit.headers`, the CLI will automatically inject an `eventSourceInit.fetch` wrapper for you.

```ts
import { MCPClient } from "@mastra/mcp";

const client = new MCPClient({
  id: "example",
  servers: {
    exampleServer: {
      url: new URL("https://your-mcp-server.com/sse"),
      // Note: requestInit alone isn't enough for SSE
      requestInit: {
        headers: {
          Authorization: "Bearer your-token",
        },
      },
      // For programmatic usage, add eventSourceInit when using custom headers
      eventSourceInit: {
        fetch(input: Request | URL | string, init?: RequestInit) {
          const headers = new Headers(init?.headers || {});
          headers.set("Authorization", "Bearer your-token");
          return fetch(input as any, {
            ...init,
            headers,
          });
        },
      },
    },
  },
});
```
