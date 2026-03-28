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
      "MCP is a standard way for AI apps to connect to tools, data, and reusable workflows.",
    category: "overview",
    analogy:
      "Think of it like a USB-C port for AI: one shape that works with many things.",
    teachableMoments: [
      "Without MCP, every AI app needs a custom integration for every tool.",
      "With MCP, hosts speak one protocol and servers plug into that protocol.",
    ],
    tips: [
      "MCP is not tied to one app. Many hosts can use the same MCP server.",
    ],
  },

  host_app: {
    title: "The Host Application",
    summary:
      "The host is the app you are using, like Claude Desktop, Cursor, VS Code, or ChatGPT.",
    category: "architecture",
    teachableMoments: [
      "One host can connect to many MCP servers at the same time.",
      "The host starts the connections and passes tool results back to the model.",
    ],
    tips: [
      "If you build an MCP host, you can reuse existing MCP servers right away.",
    ],
  },

  mcp_client: {
    title: "The MCP Client",
    summary:
      "The MCP client is the bridge inside the host that talks to one MCP server.",
    category: "architecture",
    teachableMoments: [
      "It handles the protocol details so the model does not have to.",
      "Each client-server pair starts with a handshake to agree on version and features.",
    ],
    tips: ["You usually use an SDK instead of writing the protocol by hand."],
  },

  mcp_servers: {
    title: "MCP Servers",
    summary:
      "An MCP server is a small program that wraps one system, like GitHub, Slack, a database, or your files.",
    category: "architecture",
    teachableMoments: [
      "Good MCP servers usually do one job well instead of trying to do everything.",
      "A server built once can work in many MCP hosts.",
    ],
    tips: ["Servers can run locally on your machine or remotely over HTTP."],
  },

  tools: {
    title: "Tools — Actions the AI Can Perform",
    summary:
      "Tools are actions the AI can ask the server to run, like search, create, send, or query.",
    category: "capabilities",
    teachableMoments: [
      "Each tool has a name, a description, and input fields.",
      "The model picks a tool when it needs to do something, not just talk about it.",
    ],
    tips: [
      "Clear tool names and descriptions make better tool choices more likely.",
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
      "Resources are read-only data the host can give the AI, like files, docs, tables, or API output.",
    category: "capabilities",
    teachableMoments: [
      "Resources are usually for reading, not changing things.",
      "They use URIs so the host can ask for the exact data it wants.",
    ],
    tips: ["Use resources when the AI needs context before it answers."],
    examples: [
      "file:///project/README.md — a project file",
      "postgres://localhost/users — database table contents",
      "api://weather/current?city=SF — API response data",
    ],
  },

  prompts: {
    title: "Prompts — Reusable Templates",
    summary:
      "Prompts are reusable templates a user can pick for common tasks, like reviewing code or summarizing a doc.",
    category: "capabilities",
    teachableMoments: [
      "Prompts are user-controlled. The user chooses them.",
      "A prompt can take arguments, like a repo name or a programming language.",
    ],
    tips: ["Prompts are useful when you want the same good setup every time."],
    examples: [
      "review-code — review a pull request with specific criteria",
      "summarize-doc — summarize a document in a particular style",
      "debug-error — walk through debugging steps for an error message",
    ],
  },

  ecosystem: {
    title: "The MCP Ecosystem",
    summary:
      "MCP matters because the same server can work across many hosts, and the same host can use many servers.",
    category: "ecosystem",
    teachableMoments: [
      "That shared protocol means less duplicate integration work.",
      "As more servers exist, every host becomes more useful.",
    ],
    tips: ["Before you build a new server, check whether one already exists."],
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
