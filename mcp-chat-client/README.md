# MCP Chat Client

An interactive chat client that connects to Model Context Protocol (MCP) servers and leverages LLM capabilities through Claude.

## Features

- Connect to MCP servers using stdio or SSE transports
- Support for authentication with bearer tokens
- Interactive chat interface with LLM-powered responses
- Tool execution through MCP servers
- Simple command-line interface

## Prerequisites

- Node.js 18+
- An Anthropic API key for Claude access

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   cd mcp-chat-client
   npm install
   ```
3. Set up your environment variables by editing the `.env` file:
   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   ```

## Usage

Start the client:

```bash
npm start
```

### Available Commands

- `connect:stdio <command> <args...>` - Connect to an MCP server via stdio
  - Example: `connect:stdio node server.js`
  - Example: `connect:stdio python server.py`

- `connect:sse <url> [token]` - Connect to an MCP server via SSE
  - Example: `connect:sse http://localhost:3000/events`
  - Example: `connect:sse http://localhost:3000/events myAuthToken`

- `disconnect` - Disconnect from the current MCP server

- `tools` - List available tools from the connected server

- `exit` - Exit the application

- `help` - Show help message

Once connected to an MCP server, any other input will be processed as a query to the LLM.

## Examples

### Connecting to a stdio-based server

```
> connect:stdio node path/to/server.js
Connecting to MCP server: node path/to/server.js
Connected to server with tools: getWeather, searchWeb
Successfully connected to MCP server
```

### Connecting to an SSE-based server

```
> connect:sse http://localhost:3000/events
Connecting to MCP server via SSE: http://localhost:3000/events
Connected to server with tools: getWeather, searchWeb
Successfully connected to MCP server via SSE
```

### Asking a question

```
> What's the weather like in New York?
Processing query...

Response:
I'll check the current weather in New York for you.

[Used tool: getWeather]

Based on the weather data I retrieved, it's currently 72°F (22°C) in New York with partly cloudy conditions. The humidity is at 65% and there's a light breeze of 8 mph from the southwest. There's no precipitation expected in the next few hours.
```

## Development

To run in development mode with auto-restart on file changes:

```bash
npm run dev
```

## Architecture

The client is built with the following components:

- `index.js` - Main entry point with CLI interface
- `mcpClient.js` - Core client functionality for connecting to MCP servers and processing queries

## Credits

This client is based on the Model Context Protocol (MCP) and incorporates design patterns from the Grizzly project. 