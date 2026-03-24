import { WHAT_IS_MCP_STEP_ORDER, type WhatIsMcpStep } from "./what-is-mcp-data";

export interface WhatIsMcpStepGuide {
  title: string;
  summary: string;
  category: "overview" | "architecture" | "capabilities" | "ecosystem";
  teachableMoments: string[];
  tips: string[];
  analogy?: string;
  examples?: string[];
}

export const WHAT_IS_MCP_GUIDE_METADATA: Record<
  WhatIsMcpStep,
  WhatIsMcpStepGuide
> = {
  intro: {
    title: "What is MCP?",
    summary:
      "The Model Context Protocol (MCP) is an open-source standard for connecting AI applications to external data sources, tools, and workflows. Think of it as a USB-C port for AI — one universal protocol that lets any AI application plug into any data source or tool, without custom integrations for each one.",
    category: "overview",
    analogy:
      "Just as USB-C provides a standardized way to connect your phone to chargers, displays, and storage — MCP provides a standardized way to connect AI applications to external systems.",
    teachableMoments: [
      "Before MCP, every AI integration required its own custom connector — an N×M problem where N applications each needed M integrations.",
      "MCP turns this into an N+M problem: each application implements one MCP client, and each tool implements one MCP server.",
      "MCP is an open standard maintained by Anthropic and supported across the industry.",
    ],
    tips: [
      "MCP is not just for Claude — it works with ChatGPT, VS Code Copilot, Cursor, and many other AI applications.",
      "You can explore the full specification at modelcontextprotocol.io.",
    ],
  },

  host_app: {
    title: "The Host Application",
    summary:
      "The host application is where the AI lives — Claude Desktop, an IDE like Cursor or VS Code, or any AI-powered application. It contains the AI/LLM engine that processes your requests and generates responses. The host is responsible for managing one or more MCP client connections.",
    category: "architecture",
    teachableMoments: [
      "A single host application can connect to multiple MCP servers simultaneously — for example, Claude Desktop might connect to a filesystem server, a database server, and a web search server all at once.",
      "The host manages the lifecycle of MCP connections: starting them, maintaining them, and shutting them down.",
      "Examples of hosts: Claude Desktop, Claude Code, Cursor, VS Code, Zed, Windsurf, and custom AI applications.",
    ],
    tips: [
      "When building your own AI application, you can make it an MCP host to instantly gain access to the entire MCP server ecosystem.",
    ],
  },

  mcp_client: {
    title: "The MCP Client",
    summary:
      "The MCP Client is the protocol bridge inside the host application. It handles the MCP protocol details — establishing connections, sending requests, receiving responses — so the AI engine can focus on reasoning and generation. Each client maintains a 1:1 connection with an MCP server.",
    category: "architecture",
    teachableMoments: [
      "The MCP client and server communicate using JSON-RPC 2.0 over a supported transport (HTTP with SSE, or stdio for local processes).",
      "Each client-server pair goes through an initialization handshake where they negotiate protocol versions and exchange capabilities.",
      "The client acts as a translator: the AI engine says 'I need weather data' and the client turns that into proper MCP protocol messages.",
    ],
    tips: [
      "SDKs are available in TypeScript, Python, Java, Kotlin, C#, Swift, and Go — you don't need to implement the protocol from scratch.",
      "A host can have multiple MCP clients, each connected to a different server.",
    ],
  },

  mcp_servers: {
    title: "MCP Servers",
    summary:
      "MCP Servers are lightweight programs that expose specific capabilities to AI applications. Each server wraps an external system — a database, an API, a filesystem — and makes it accessible through the standard MCP protocol. Servers are focused: one server per integration.",
    category: "architecture",
    teachableMoments: [
      "Servers are intentionally small and focused. A GitHub server provides GitHub access, a Postgres server provides database access — they don't try to do everything.",
      "Because MCP is a standard protocol, a server you build works with every MCP-compatible host — build once, use everywhere.",
      "Servers declare their capabilities during initialization, so the client knows exactly what they can do.",
    ],
    tips: [
      "Thousands of MCP servers already exist for popular services: GitHub, Slack, Google Drive, databases, and more.",
      "You can run servers locally (via stdio) or remotely (via HTTP). Remote servers can serve multiple clients.",
    ],
  },

  tools: {
    title: "Tools — Actions the AI Can Perform",
    summary:
      "Tools are executable functions that MCP servers expose to AI applications. When the AI needs to take an action — search the web, create a file, run a query, send a message — it invokes a tool. Tools are model-controlled: the AI decides when and how to use them based on the conversation context.",
    category: "capabilities",
    teachableMoments: [
      "Tools are the most powerful MCP primitive. They let AI go beyond just generating text to actually doing things in the world.",
      "Each tool has a name, description, and input schema (JSON Schema). The AI uses the description to decide when to invoke it.",
      "Tools follow a request-response pattern: the client sends a tools/call request, and the server executes the function and returns the result.",
    ],
    tips: [
      "Design tools with clear names and descriptions — the AI relies on these to decide which tool to use.",
      "Tools can return text, images, or structured data. They can also indicate errors.",
    ],
    examples: [
      "get_weather — fetch current weather for a location",
      "search_files — search for files matching a pattern",
      "run_query — execute a SQL query against a database",
      "send_slack_message — post a message to a Slack channel",
    ],
  },

  resources: {
    title: "Resources — Data the AI Can Access",
    summary:
      "Resources represent data that MCP servers can provide to AI applications. They're like read-only endpoints: files, database records, API responses, or any structured data. Resources are application-controlled — the host decides which resources to include in the AI's context.",
    category: "capabilities",
    teachableMoments: [
      "Resources use URIs for identification (e.g., file:///path/to/file, postgres://db/table). This makes them addressable and cacheable.",
      "Unlike tools, resources are typically read-only and don't perform side effects.",
      "Servers can notify clients when resources change, allowing the AI to stay up to date without polling.",
    ],
    tips: [
      "Resources are great for providing context: project files, documentation, configuration, or reference data.",
      "Resource templates use URI templates (RFC 6570) so clients can request parameterized resources.",
    ],
    examples: [
      "file:///project/README.md — a project file",
      "postgres://localhost/users — database table contents",
      "api://weather/current?city=SF — API response data",
    ],
  },

  prompts: {
    title: "Prompts — Reusable Templates",
    summary:
      'Prompts are pre-built templates that MCP servers can offer to standardize common AI interactions. They provide structured workflows — like a "summarize this document" template or a "review this PR" workflow — that combine instructions with dynamic arguments.',
    category: "capabilities",
    teachableMoments: [
      "Prompts are user-controlled: the user (or host application) selects which prompt to use, rather than the AI choosing automatically.",
      "Each prompt has a name, description, and optional arguments that get filled in at runtime.",
      "Prompts can return multi-turn message sequences, including both user and assistant messages, to set up complex interactions.",
    ],
    tips: [
      'Think of prompts as reusable "recipes" for AI interactions — they encode best practices for common tasks.',
      "Prompts can embed resources, making it easy to provide relevant context alongside instructions.",
    ],
    examples: [
      "review-code — review a pull request with specific criteria",
      "summarize-doc — summarize a document in a particular style",
      "debug-error — walk through debugging steps for an error message",
    ],
  },

  ecosystem: {
    title: "The MCP Ecosystem",
    summary:
      "MCP is supported by a rapidly growing ecosystem of hosts, servers, and development tools. Because it's an open standard, building one MCP server makes it instantly available to every compatible host application. This network effect is what makes MCP powerful — the more servers exist, the more capable every host becomes.",
    category: "ecosystem",
    teachableMoments: [
      "Major AI platforms support MCP: Claude (Desktop, Code, and API), ChatGPT, GitHub Copilot (VS Code), Cursor, Zed, Windsurf, and more.",
      "The ecosystem includes official SDKs in TypeScript, Python, Java, Kotlin, C#, Swift, and Go.",
      "MCP is designed to evolve: capability negotiation means older clients and newer servers can still work together.",
    ],
    tips: [
      "Check the MCP server registry to find existing servers before building your own.",
      "You can test and debug MCP servers using the MCP Inspector — the tool you're using right now!",
    ],
  },
};

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export function nextWhatIsMcpStepId(
  current: string | undefined,
): WhatIsMcpStep {
  if (!current) return WHAT_IS_MCP_STEP_ORDER[0];
  const idx = WHAT_IS_MCP_STEP_ORDER.indexOf(current as WhatIsMcpStep);
  if (idx < 0 || idx >= WHAT_IS_MCP_STEP_ORDER.length - 1) {
    return WHAT_IS_MCP_STEP_ORDER[0];
  }
  return WHAT_IS_MCP_STEP_ORDER[idx + 1];
}

export function isLastWhatIsMcpStep(current: string | undefined): boolean {
  if (!current) return false;
  const idx = WHAT_IS_MCP_STEP_ORDER.indexOf(current as WhatIsMcpStep);
  return idx === WHAT_IS_MCP_STEP_ORDER.length - 1;
}
