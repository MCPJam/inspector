/**
 * The per-session `CODEX_HOME` this bridge runs Codex under.
 *
 * WHY A PREPARED HOME AND NOT THE DEFAULT. `CODEX_HOME` carries auth, config
 * AND the session rollout files that `thread/resume` reads. Pointing Codex at
 * the box's default `~/.codex` would inherit whatever is there; pointing it at
 * an empty directory would lose resume. So the bridge renders one per session:
 * ours, complete, and disposable with the box.
 *
 * WHY THE BRIDGE RENDERS IT RATHER THAN THE BOOTSTRAP. The two values that
 * matter — the model proxy's base URL and the relay's bound port — are not
 * known when the bootstrap is built. The proxy URL arrives per turn as a
 * credential env var, and the port is assigned when the relay binds. Putting
 * either in a bootstrap file would also break the framework's guarantee that a
 * bootstrap is byte-identical across credentials, which the registry asserts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";

/** TOML string literal. JSON's string grammar is a subset of TOML's basic
 *  string, escapes included, so this is exact rather than approximate. */
const tomlString = (value: string): string => JSON.stringify(value);

export type CodexHomeInput = {
  /** Where to write. Created if absent. */
  codexHome: string;
  /** The OpenAI-protocol base URL (MCPJam's metered model proxy). */
  baseUrl: string;
  /** Env var Codex reads the (placeholder) credential from. */
  apiKeyEnvVar: string;
  /** Absolute path to the bundled host-tool MCP entrypoint. */
  hostToolsEntrypoint?: string;
  /** Loopback URL the host-tool MCP server calls back into. */
  relayUrl?: string;
  /** Shared secret for that callback. */
  relayCredential?: string;
  /** File the relay writes the turn's host-tool catalog to. */
  hostToolCatalogPath?: string;
  /** Whether Codex may use its own web search. */
  webSearch?: boolean;
  /** Node binary to launch the MCP server with. */
  nodeExecutable?: string;
};

/**
 * Render `config.toml`. Pure and total, so it can be snapshot-tested — a config
 * mistake here is otherwise only visible as a puzzling failure inside a box.
 */
export function renderCodexConfigToml(input: CodexHomeInput): string {
  const lines: string[] = [
    "# Generated per session by MCPJam's codex app-server bridge. Do not edit:",
    "# it is rewritten on every session start.",
    "",
    // The custom provider is the whole broker story: Codex talks to MCPJam's
    // metered proxy, the placeholder credential satisfies its auth check, and
    // the real lease is injected outside the VM by E2B.
    `model_provider = ${tomlString("mcpjam")}`,
    // `detailed` is what makes reasoning summaries stream at all; without it
    // the reasoning parts are empty and the trace looks like the model thought
    // about nothing.
    'model_reasoning_summary = "detailed"',
    `web_search = ${input.webSearch ? '"live"' : '"disabled"'}`,
    "",
    "[model_providers.mcpjam]",
    'name = "MCPJam model proxy"',
    `base_url = ${tomlString(input.baseUrl)}`,
    `env_key = ${tomlString(input.apiKeyEnvVar)}`,
    // The proxy allowlists exactly `POST /v1/responses` and `GET /v1/models`;
    // the responses wire API is what stays inside it.
    'wire_api = "responses"',
  ];

  if (input.hostToolsEntrypoint && input.relayUrl && input.relayCredential) {
    lines.push(
      "",
      `[mcp_servers.${RELAY_MCP_SERVER_NAME}]`,
      `command = ${tomlString(input.nodeExecutable ?? process.execPath)}`,
      `args = [${tomlString(input.hostToolsEntrypoint)}]`,
      // Generous: the server is a local node process, but a cold `node` start
      // on a loaded box is not instant.
      "startup_timeout_sec = 30",
      // ZERO IS DELIBERATE. A host tool can be gated behind a human approval,
      // so the call legitimately takes as long as a person takes to answer. Any
      // finite timeout here would cancel exactly the approvals this transport
      // exists to support.
      "tool_timeout_sec = 0",
      "",
      `[mcp_servers.${RELAY_MCP_SERVER_NAME}.env]`,
      `MCPJAM_HOST_TOOL_RELAY_URL = ${tomlString(input.relayUrl)}`,
      `MCPJAM_HOST_TOOL_RELAY_CREDENTIAL = ${tomlString(
        input.relayCredential,
      )}`,
      ...(input.hostToolCatalogPath
        ? [
            `MCPJAM_HOST_TOOL_CATALOG = ${tomlString(
              input.hostToolCatalogPath,
            )}`,
          ]
        : []),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Render and write it. Returns the home directory. */
export function prepareCodexHome(input: CodexHomeInput): string {
  mkdirSync(input.codexHome, { recursive: true });
  writeFileSync(
    join(input.codexHome, "config.toml"),
    renderCodexConfigToml(input),
    "utf8",
  );
  return input.codexHome;
}
