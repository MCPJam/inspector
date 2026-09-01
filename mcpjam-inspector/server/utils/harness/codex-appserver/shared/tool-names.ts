/**
 * The tool-name contract shared by the host adapter and the in-sandbox bridge.
 *
 * Pure and dependency-free on purpose: the bridge is bundled separately and
 * runs inside the sandbox, so anything both sides must agree on has to be
 * importable from both without dragging in server-only modules.
 *
 * Two naming problems live here.
 *
 * 1. NATIVE ACTIONS. `codex app-server` reports what the agent did as typed
 *    ITEMS (`commandExecution`, `fileChange`, `webSearch`), not as tool calls
 *    with names. MCPJam's trace, evals and UI all key on tool names, so the
 *    bridge synthesizes a `tool-call`/`tool-result` pair per item and this map
 *    decides the name it carries. The names match `@ai-sdk/harness-codex`'s
 *    catalog wherever the concept is the same, so an assertion written against
 *    a `codex exec` run still matches an app-server run.
 *
 * 2. HOST TOOLS. MCPJam's host-executed tools reach the model as an MCP server
 *    (see `host-tools-mcp.ts`). Codex re-qualifies every MCP tool with its
 *    server name, so a tool MCPJam calls `mcp__weather__get_forecast` would
 *    come back as `mcp__mcpjam__mcp__weather__get_forecast`. The alias
 *    functions below strip and restore MCPJam's own prefix so the name that
 *    reaches the stream is byte-identical to the one the host declared, and
 *    `parseHarnessToolName` attributes it with no special cases.
 */

/**
 * The MCP server name MCPJam's host tools are published under inside the
 * sandbox. Short because Codex qualifies tool names with it and model-facing
 * names have a length budget.
 *
 * Deliberately NOT `harness-tools` (Claude Code's in-process server) or
 * `ai-sdk-harness-tools` (the ACP bridge's): those are the harness framework's
 * own reserved names, and colliding with one would make a host tool
 * indistinguishable from a framework tool at the wire.
 */
export const RELAY_MCP_SERVER_NAME = "mcpjam";

/** The prefix MCPJam uses for tools projected from a user's MCP server. */
const MCPJAM_MCP_TOOL_PREFIX = "mcp__";

/**
 * Name a host tool is published to Codex under.
 *
 * Strips MCPJam's own `mcp__` prefix, because Codex adds its own qualification
 * and the doubled prefix is both ugly and long. Everything else passes through
 * unchanged (a host built-in like `web_search` has no prefix to strip).
 *
 * Not injective on its own — two host tools could differ only by the prefix —
 * so callers build a REVERSE MAP from the actual tool set rather than
 * round-tripping through {@link unaliasHostToolName}. The reverse function
 * exists for the common case and for tests.
 */
export function aliasHostToolName(hostToolName: string): string {
  return hostToolName.startsWith(MCPJAM_MCP_TOOL_PREFIX)
    ? hostToolName.slice(MCPJAM_MCP_TOOL_PREFIX.length)
    : hostToolName;
}

/**
 * Best-effort inverse of {@link aliasHostToolName}, for a name that is not in
 * the reverse map. Returns the alias unchanged: inventing an `mcp__` prefix for
 * a name we cannot account for would fabricate a server attribution, and an
 * unattributed tool name is the honest answer.
 */
export function unaliasHostToolName(
  alias: string,
  reverse: ReadonlyMap<string, string>,
): string {
  return reverse.get(alias) ?? alias;
}

/**
 * Build the alias → canonical map for a turn's host tools, refusing collisions.
 *
 * A collision means two distinct host tools would be published under one name,
 * and the model's call could not be attributed back to either. Rather than pick
 * one, the colliding entries keep their UNSTRIPPED names, which are unique by
 * construction (they differ by the prefix that caused the collision).
 */
export function buildHostToolAliases(hostToolNames: readonly string[]): {
  aliasToCanonical: Map<string, string>;
  canonicalToAlias: Map<string, string>;
} {
  const counts = new Map<string, number>();
  for (const name of hostToolNames) {
    const alias = aliasHostToolName(name);
    counts.set(alias, (counts.get(alias) ?? 0) + 1);
  }
  const aliasToCanonical = new Map<string, string>();
  const canonicalToAlias = new Map<string, string>();
  for (const name of hostToolNames) {
    const stripped = aliasHostToolName(name);
    const alias = (counts.get(stripped) ?? 0) > 1 ? name : stripped;
    aliasToCanonical.set(alias, name);
    canonicalToAlias.set(name, alias);
  }
  return { aliasToCanonical, canonicalToAlias };
}

/**
 * The names the bridge emits for Codex's own (provider-executed) actions.
 *
 * `bash` and `webSearch` are the cross-harness common names, so a Codex action
 * lines up with the equivalent Claude Code or Cursor one. `fileChange` matches
 * the name the exec transport already surfaces file mutations under
 * (`fileChangeToolName` in the registry), so existing traces stay comparable.
 */
export const CODEX_APPSERVER_TOOL_NAMES = {
  commandExecution: "bash",
  fileChange: "fileChange",
  webSearch: "webSearch",
} as const;

/**
 * The name Codex itself uses for each action, carried as `nativeName` so a
 * reader can tell which real tool ran.
 *
 * MEASURED against the pinned CLI, not copied from the exec transport: codex
 * 0.149.1's app-server declares `exec_command` (a PTY-backed unified exec
 * taking `{cmd: string}`), NOT the `shell` tool `codex exec` reports. See
 * `.spike-codex-appserver/RESULTS.md`. `apply_patch` has no function-tool
 * declaration at all — file mutation runs through the shell and is REPORTED as
 * a `fileChange` item — but it remains the honest native name for the action.
 */
export const CODEX_APPSERVER_NATIVE_TOOL_NAMES = {
  commandExecution: "exec_command",
  fileChange: "apply_patch",
  webSearch: "web_search",
} as const;
