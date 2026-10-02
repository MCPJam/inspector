/**
 * Keep every MCP server but MCPJam's relay away from Codex.
 *
 * Measured on 0.149.1 (`PROBES.md` (b)): the per-session `CODEX_HOME` keeps a
 * user's `~/.codex` out, and an untrusted project's `.codex/config.toml` is
 * disabled (no project is ever trusted — trust is recorded in a `CODEX_HOME`
 * MCPJam renders). But codex ALSO applies the system and managed layers,
 * `/etc/codex/config.toml` and `/etc/codex/managed_config.toml`, and any MCP
 * server declared there is spawned and offered to the model next to the
 * relay. A `thread/start.config.mcp_servers` entry MERGES with those layers
 * rather than replacing them, so naming only the relay does nothing; what
 * works is disabling each foreign server by name: `{ <name>: { enabled:
 * false } }`, which overrides even the managed layer.
 *
 * So the bridge reads those two files, collects the server names they
 * declare, and disables every one but the relay on each thread it starts.
 * The tool policy MCPJam enforces is only meaningful if MCPJam's relay is the
 * only MCP surface the model has.
 *
 * Not covered, and said so in the docs rather than guessed at: macOS MDM
 * managed preferences and whatever system location Windows uses, which the
 * probes did not reach.
 */
import { readFileSync } from "node:fs";

/** System and managed config layers codex 0.149.1 reads (POSIX). */
export const CODEX_SYSTEM_CONFIG_PATHS: readonly string[] = [
  "/etc/codex/config.toml",
  "/etc/codex/managed_config.toml",
];

/**
 * Server names an `mcp_servers` declaration in TOML text introduces.
 *
 * NOT a TOML parser — the names are all that is needed, and every way TOML can
 * spell a key under `mcp_servers` is one of three shapes: a table header
 * (`[mcp_servers.name]`, `[mcp_servers."name"]`, `[mcp_servers.name.env]`), a
 * dotted key (`mcp_servers.name.command = …`), or an inline table under a
 * `[mcp_servers]` header (`name = { … }`). Over-collecting is safe (disabling
 * a name that does not exist is a no-op); under-collecting is the failure, so
 * every shape is matched.
 */
export function mcpServerNamesInToml(text: string): string[] {
  const names = new Set<string>();
  const key = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))`;
  const take = (match: RegExpMatchArray) => {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name.replace(/\\(.)/g, "$1"));
  };
  const header = new RegExp(String.raw`^\s*\[\[?\s*mcp_servers\s*\.\s*${key}`, "gm");
  for (const match of text.matchAll(header)) take(match);
  const dotted = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${key}\s*[.=]`, "gm");
  for (const match of text.matchAll(dotted)) take(match);
  // Bare keys directly under a `[mcp_servers]` table, until the next header.
  const sections = text.split(/^\s*\[/m);
  for (const section of sections) {
    if (!/^\s*mcp_servers\s*\]/.test(section)) continue;
    const bodyKey = new RegExp(String.raw`^\s*${key}\s*(?:=|\.)`, "gm");
    for (const match of section.replace(/^[^\n]*\n/, "").matchAll(bodyKey)) {
      take(match);
    }
  }
  return [...names].sort();
}

/**
 * The `thread/start.config.mcp_servers` overrides that disable every server a
 * system or managed layer declares, except `keep` (the relay).
 */
export function foreignMcpServerOverrides(options: {
  keep: string;
  readFile?: (path: string) => string | null;
  paths?: readonly string[];
  platform?: NodeJS.Platform;
}): Record<string, { enabled: false }> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return {};
  const read =
    options.readFile ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const overrides: Record<string, { enabled: false }> = {};
  for (const path of options.paths ?? CODEX_SYSTEM_CONFIG_PATHS) {
    const text = read(path);
    if (text === null) continue;
    for (const name of mcpServerNamesInToml(text)) {
      if (name !== options.keep) overrides[name] = { enabled: false };
    }
  }
  return overrides;
}
