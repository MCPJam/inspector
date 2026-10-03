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
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";

/** TOML string literal. JSON's string grammar is a subset of TOML's basic
 *  string, escapes included, so this is exact rather than approximate. */
const tomlString = (value: string): string => JSON.stringify(value);

/*
 * ON THE RELAY CREDENTIAL IN THIS FILE.
 *
 * It lands in a config file the agent's shell can read, and that is inherent:
 * Codex spawns the host-tool MCP server, so the credential has to reach that
 * process through Codex's own config. One uid runs everything in the sandbox,
 * so no path or file mode hides it from the model.
 *
 * That is accounted for rather than overlooked — see the threat-model note in
 * `host-tool-relay.ts`. The credential is defence in depth against everything
 * that is NOT the agent; what bounds the agent is the host-side approval gate,
 * which a relayed call passes through exactly like an MCP-initiated one.
 */

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
  /**
   * Directories recorded as UNTRUSTED projects — the session's working
   * directory and the git root above it (`untrustedProjectPathsFor`).
   */
  untrustedProjectPaths?: readonly string[];
};

/*
 * WHY EVERY SESSION RECORDS ITS FOLDER AS UNTRUSTED.
 *
 * A trusted project's own `.codex/config.toml` is a config layer: its MCP
 * servers are spawned next to MCPJam's relay (with no approval: an MCP server
 * start is not a command), and its hooks and exec policies apply. Measured on
 * 0.149.1 (`PROBES.md` (b7)): `thread/start` with `sandbox: "workspace-write"`
 * — what every attended and unattended session uses — makes Codex WRITE
 * `trust_level = "trusted"` for the cwd, or for the git root above it, into
 * this file the first time it sees that folder. The folder's planted server
 * then starts in the same session. Under `read-only` it writes nothing.
 *
 * An explicit `trust_level = "untrusted"` entry is respected and never
 * rewritten, and keeps the project layer off for that cwd even when the git
 * root above it carries the config. So the working directory, its resolved
 * real path and its git root are all recorded untrusted, every session. Skills
 * and AGENTS.md still load from an untrusted project (`PROBES.md` (b1), (b6)).
 */
export function untrustedProjectPathsFor(workdir: string): string[] {
  const paths = new Set<string>([workdir]);
  let real = workdir;
  try {
    real = realpathSync(workdir);
    paths.add(real);
  } catch {
    // A workdir that does not exist yet has no project layer to load.
  }
  for (const start of new Set([workdir, real])) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) {
        paths.add(dir);
        break;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return [...paths];
}

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
    // The credential is an API-key-shaped capability, never a ChatGPT login:
    // without this Codex can prefer an interactive auth flow it will never
    // complete. Parity with the published adapter's bridge.
    'preferred_auth_method = "apikey"',
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
    // Neither the hosted proxy nor the local gateway speaks the realtime
    // WebSocket transport; Codex must stay on plain HTTP streaming.
    "supports_websockets = false",
    "",
    "[features]",
    // Measured (PROBES.md (a2/a3)): by default codex contacts github.com,
    // api.github.com and chatgpt.com at startup and clones ~100 MB of plugins
    // into every fresh CODEX_HOME. None of it is MCPJam's, all of it is egress
    // and disk the session never asked for, and on a user's machine it is
    // traffic they did not agree to.
    "plugins = false",
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
      // An HOUR, not zero. A host tool can be gated behind a human approval,
      // so the call legitimately takes as long as a person takes to answer —
      // but Codex reads `0` as a zero-second budget, not "no limit": every
      // relayed call timed out immediately. There is no unlimited setting, so
      // the wait is bounded at an hour, longer than any approval the host
      // keeps a session parked for. Never restore 0.
      "tool_timeout_sec = 3600",
      // Codex gates MCP calls ITSELF (PROBES.md (d)): under `never` it refuses
      // every relayed call ("requires approval, but approval policy is
      // never"), and under `untrusted` it raises an `mcp_tool_call`
      // elicitation the bridge declines. Either way no host tool ran. MCPJam's
      // own gate — the framework's `toolApproval`, evaluated on the host
      // before `execute` — is the single authority for relayed tools, so
      // codex is told not to add a second one.
      'default_tools_approval_mode = "approve"',
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

  for (const path of new Set(input.untrustedProjectPaths ?? [])) {
    lines.push("", `[projects.${tomlString(path)}]`, 'trust_level = "untrusted"');
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
