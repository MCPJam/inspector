# Bright Data MCP Server Unit Testing & Evals Demo

This example demonstrates how to use the `@mcpjam/sdk` to write unit tests and MCP server evals with the Bright Data MCP.

## Tests

### Unit Tests (`brightdata-unit-test.test.ts`)

Test the basic functionality of the MCP server via unit tests:

- **Connection testing** - Validates token handling and connects to the Bright Data ecommerce MCP server
- **Server capabilities** - Verifies `getServerCapabilities()` returns proper tool definitions
- **Server summaries** - Tests `getServerSummaries()` for server introspection (id, status, config)
- **Ping server** - Tests `pingServer()` for connectivity checks
- **Tool discovery** - Verifies the server exposes all expected ecommerce tools (Amazon, Walmart, eBay, etc.)
- **Tool execution** - Tests `executeTool()` with `web_data_amazon_product_search`

Ensures that the server's request / response is working, and conforms to the MCP spec.

### MCP Server Evals (`brightdata-evals.test.ts`)

MCP evals measures how well the LLM's can understand how use the MCP server (tool ergonomics).

- **Tool choice accuracy** - For a prompt like "Search for wireless headphones on Amazon", does the LLM call the correct tool?
- **Argument accuracy** - Does the LLM extract and pass the right arguments to tools?
- **Multi-turn conversations** - Can the LLM maintain context across multiple prompts and chain tool calls appropriately?
- **Token efficiency** - Track token usage to optimize cost and performance

## Prerequisites

- Node.js 18+
- A Bright Data API token (get one from [Bright Data](https://brightdata.com/))
- An Anthropic API key (required for evals)

## Setup

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

`cd` into the `examples/evals/brightdata` directory, then install dependencies.

```bash
cd examples/evals/brightdata
npm install
```

### 4. Configure environment variables

Create a `.env` file in the `examples/evals/brightdata` directory:

```bash
# Required for all tests
BRIGHTDATA_API_TOKEN=your_brightdata_api_token

# Required for evals only
ANTHROPIC_API_KEY=your_anthropic_api_key
```

## Running Tests

### Run all tests

```bash
npm test
```

### Run only unit tests

```bash
npm test -- brightdata-unit-test
```

### Run only evals

```bash
npm test -- brightdata-evals
```

**Tests timing out**: Increase the timeout in `vitest.config.ts` or individual test configurations.

**Connection failures**: Verify your `BRIGHTDATA_API_TOKEN` is valid. Check that the token hasn't expired.

**Low eval accuracy**: This can indicate unclear tool descriptions in the MCP server, ambiguous prompts, or model limitations. Try adjusting the prompt or using a more capable model.
