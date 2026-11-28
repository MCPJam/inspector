import claudeCodeLogo from "/claude_code_logo.png";
import codexLogo from "/codex-logo.svg";
import cursorLogo from "/cursor_logo.png";
import openaiLogo from "/openai_logo.png";
import vscodeLogo from "/vscode_logo.svg";

/** Per-agent setup for the hosted MCPJam server, as in docs/hosted. */
export const HOSTED_MCP_URL = "https://mcp.mcpjam.com/mcp";

/** The docs' "In your agent" prompt; the agent picks the setup for its client. */
export const AGENT_ONBOARD_PROMPT =
  "Onboard onto MCPJam, use it to test the MCP server in this repo on a branch, and tell me how it did: https://www.mcpjam.com/prompt.md";

/** The MCPJam plugin for ChatGPT and the Codex app, as in the docs. */
export const AGENT_PLUGIN_URL =
  "https://chatgpt.com/plugins/plugin_asdk_app_6ae3a54df10c8191b901cbadc1d0df56";

type Guide = { label: string; url: string };

export type AgentClient =
  | {
      kind: "command";
      id: string;
      label: string;
      icons: string[];
      command: string;
      after: string;
      guide: Guide;
    }
  | {
      kind: "install";
      id: string;
      label: string;
      icons: string[];
      /** Opens the client's install prompt; `manual` is the fallback. */
      install: string;
      manual: string;
      snippet: string;
      after: string;
      guide: Guide;
    }
  | { kind: "plugin"; id: string; label: string; icons: string[]; url: string }
  | { kind: "prompt"; id: string; label: string; icons: string[] };

/** Dropdown groups; a group without a label sits under a bare divider. */
export const AGENT_CLIENT_GROUPS: readonly {
  label: string | null;
  clients: readonly AgentClient[];
}[] = [
  {
    label: "Install a plugin",
    clients: [
      {
        kind: "plugin",
        id: "chatgpt-codex-plugin",
        label: "ChatGPT & Codex",
        icons: [openaiLogo, codexLogo],
        url: AGENT_PLUGIN_URL,
      },
    ],
  },
  {
    label: "Run a command",
    clients: [
      {
        kind: "command",
        id: "claude-code",
        label: "Claude Code",
        icons: [claudeCodeLogo],
        command: `claude mcp add --transport http mcpjam ${HOSTED_MCP_URL}`,
        after:
          "Then run /mcp, choose mcpjam and sign in with your MCPJam account.",
        guide: {
          label: "Claude Code guide",
          url: "https://code.claude.com/docs/en/mcp",
        },
      },
      {
        kind: "command",
        id: "codex",
        label: "Codex",
        icons: [codexLogo],
        command: `codex mcp add mcpjam --url ${HOSTED_MCP_URL}`,
        after:
          "Sign in with your MCPJam account in the browser. If it doesn't open, run codex mcp login mcpjam.",
        guide: {
          label: "Codex guide",
          url: "https://developers.openai.com/codex/mcp",
        },
      },
    ],
  },
  {
    label: "Add to your editor",
    clients: [
      {
        kind: "install",
        id: "cursor",
        label: "Cursor",
        icons: [cursorLogo],
        install: `cursor://anysphere.cursor-deeplink/mcp/install?name=mcpjam&config=${btoa(JSON.stringify({ url: HOSTED_MCP_URL }))}`,
        manual:
          "Add this to .cursor/mcp.json, or ~/.cursor/mcp.json for all projects. If the file already has mcpServers, add only the mcpjam entry to it.",
        snippet: JSON.stringify(
          { mcpServers: { mcpjam: { url: HOSTED_MCP_URL } } },
          null,
          2,
        ),
        after: "Then open Cursor's MCP settings and sign in to mcpjam.",
        guide: {
          label: "Cursor guide",
          url: "https://cursor.com/docs/context/mcp",
        },
      },
      {
        kind: "install",
        id: "vscode",
        label: "VS Code",
        icons: [vscodeLogo],
        install: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "mcpjam", type: "http", url: HOSTED_MCP_URL }))}`,
        manual:
          "Run MCP: Add Server from the Command Palette, choose HTTP and enter this URL.",
        snippet: HOSTED_MCP_URL,
        after: "Name it mcpjam, trust it and sign in with your MCPJam account.",
        guide: {
          label: "VS Code guide",
          url: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
        },
      },
    ],
  },
  {
    label: null,
    clients: [{ kind: "prompt", id: "other", label: "Other", icons: [] }],
  },
];

export const AGENT_CLIENTS = AGENT_CLIENT_GROUPS.flatMap(
  (group) => group.clients,
);
