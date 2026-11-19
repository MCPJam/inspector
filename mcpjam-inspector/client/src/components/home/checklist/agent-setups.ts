/** Per-agent setup for the hosted MCPJam server, as in docs/hosted. */
export const HOSTED_MCP_URL = "https://mcp.mcpjam.com/mcp";

export interface AgentSetup {
  id: string;
  label: string;
  /** What to do with `snippet`, and how to finish signing in. */
  intro: string;
  snippet: string;
  snippetKind: "command" | "config";
  after: string;
  guideUrl: string;
}

export const AGENT_SETUPS: readonly AgentSetup[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    intro: "Run this in your terminal:",
    snippet: `claude mcp add --transport http mcpjam ${HOSTED_MCP_URL}`,
    snippetKind: "command",
    after: "Then run /mcp, choose mcpjam and sign in with your MCPJam account.",
    guideUrl: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "codex",
    label: "Codex",
    intro: "Run this in your terminal:",
    snippet: `codex mcp add mcpjam --url ${HOSTED_MCP_URL}`,
    snippetKind: "command",
    after:
      "Sign in with your MCPJam account in the browser. If it doesn't open, run codex mcp login mcpjam.",
    guideUrl: "https://developers.openai.com/codex/mcp",
  },
  {
    id: "cursor",
    label: "Cursor",
    intro: "Add this to .cursor/mcp.json, or ~/.cursor/mcp.json for all projects:",
    snippet: JSON.stringify(
      { mcpServers: { mcpjam: { url: HOSTED_MCP_URL } } },
      null,
      2,
    ),
    snippetKind: "config",
    after: "Then open Cursor's MCP settings and sign in to mcpjam.",
    guideUrl: "https://cursor.com/docs/context/mcp",
  },
  {
    id: "vscode",
    label: "VS Code",
    intro: "Run MCP: Add Server from the Command Palette, choose HTTP and enter:",
    snippet: HOSTED_MCP_URL,
    snippetKind: "config",
    after: "Name it mcpjam, trust it and sign in with your MCPJam account.",
    guideUrl:
      "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
  },
  {
    id: "other",
    label: "Other",
    intro: "Add a remote MCP server named MCPJam (Streamable HTTP) with this URL:",
    snippet: HOSTED_MCP_URL,
    snippetKind: "config",
    after: "Then sign in with your MCPJam account in the browser.",
    guideUrl: "https://docs.mcpjam.com/hosted/claude-connector",
  },
];
