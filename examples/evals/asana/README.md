
# Asana MCP Server Unit Testing & Evals Demo

This example demonstrates how to use the `@mcpjam/sdk` to write unit tests and MCP server evals with the Asana MCP.

## Tests

### Unit Tests (`asana-unit-test-demo.test.ts`)

Test the basic functionality of the MCP server via unit tests:

- **Connection testing** - Validates OAuth token handling (valid tokens connect, invalid tokens fail)
- **Tool discovery** - Verifies the server exposes all expected tools
- **Tool execution** - Tests individual tools return correctly structured responses

Ensures that the server's request / response is working, and conforms to the MCP spec. 

### MCP Server Evals (`asana-evals.test.ts`)

MCP evals measures how well the LLM's can understand how use the MCP server (tool ergonomics). 

- **Tool choice accuracy** - For a prompt like "Show me all my Asana workspaces", does the LLM call the correct tool?
- **Argument accuracy** - Does the LLM extract and pass the right arguments to tools?
- **Multi-turn conversations** - Can the LLM maintain context across multiple prompts and chain tool calls appropriately?
- **Token efficiency** - Track token usage to optimize cost and performance

## Prerequisites

- Node.js 18+
- An Asana Authorization key (Retrievable by connecting to Asana MCP via MCPJam inspector)
- An OpenAI API key required for evals. 

## Setup

To test it yourselves, you can use my demo 

### 1. Clone the repository

```bash
git clone git@github.com:MCPJam/inspector.git
```

### 2. Build the SDK
`cd` into the sdk directory, then build. 

```bash
cd sdk
npm install
npm run build
```

### 3. Install example dependencies
`cd` into the `examples/evals/asana` directory, then install dependencies

```bash
cd examples/evals/asana
npm install
```

### 4. Configure environment variables

Create a `.env` file in the `examples/evals/asana` directory:

```bash
# Required for all tests
ASANA_TOKEN=your_asana_personal_access_token

# Required for evals only
OPENAI_API_KEY=your_openai_api_key
```

You can get an Asana token for the MCP server by using MCPJam. Connect to Asana MCP server with OAuth using MCP. View "server info", then the API token is there. 

## Running Tests

### Run all tests

```bash
npm test
```

### Run only unit tests

```bash
npm test -- asana-unit-test-demo
```

### Run only evals

```bash
npm test -- asana-evals
```

**Tests timing out**: Increase the timeout in `jest.config.js` or individual test configurations.

**Connection failures**: Verify your `ASANA_TOKEN` is valid and has the necessary permissions. Check that the Asana token is not expired. 

**Low eval accuracy**: This can indicate unclear tool descriptions in the MCP server, ambiguous prompts, or model limitations. Try adjusting the prompt or using a more capable model.
