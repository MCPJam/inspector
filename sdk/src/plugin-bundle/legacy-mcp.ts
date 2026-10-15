/**
 * Legacy MCP configuration (`.mcp.json`, or a manifest's inline
 * `mcpServers`) rewritten into a strict Agent Plugins `mcp.json` document,
 * which the ordinary normalizer then validates entry by entry.
 *
 * Only legacy packages come through here; a root `mcp.json` is never
 * inferred or rewritten. The rewrite is the part of each legacy dialect the
 * strict schema cannot express, and nothing more:
 *
 * - the transport is read leniently (`http`, `streamable_http`, an absent
 *   type with `command` or `url`) and written as the exact strict constant;
 * - `cwd: "."` and other bare relative directories become `./` paths;
 * - Claude's `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` become the
 *   portable placeholders, and a root-prefixed command becomes a `./` command
 *   so the strict rules check its containment;
 * - a disabled entry, or one mixing stdio and HTTP fields, is skipped alone;
 * - keys the strict schema does not know are dropped with a warning.
 */

import {
  detectPluginMcpTransport,
  PLUGIN_MCP_SCHEMAS,
  selectPluginMcpServerMap,
  type PluginSkippedComponent,
} from "./mcp-config.js";
import type { PluginIssueCode, PluginIssueCollector } from "./validation.js";

const STDIO_FIELDS = new Set(["command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["url", "headers"]);
/** MCPJam's own auth hints, accepted on HTTP entries by the strict schema too. */
const HTTP_HINT_FIELDS = new Set(["oauth", "authentication"]);
const IGNORED_FIELDS = new Set(["type", "transport", "enabled", "disabled"]);

const CLAUDE_PLACEHOLDERS: ReadonlyArray<[string, string]> = [
  ["${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}"],
  ["${CLAUDE_PLUGIN_DATA}", "${PLUGIN_DATA}"],
];

export type LegacyMcpAdaptation =
  | {
      ok: true;
      /** A strict `mcp.json` document holding every entry worth validating. */
      document: { $schema: string; mcpServers: Record<string, unknown> };
      /** Entries refused before strict validation. */
      skipped: PluginSkippedComponent[];
    }
  /** The document's shape is unusable, which disables MCP servers. */
  | { ok: false; code: PluginIssueCode; reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function portablePlaceholders(value: string): string {
  return CLAUDE_PLACEHOLDERS.reduce(
    (text, [legacy, portable]) => text.split(legacy).join(portable),
    value
  );
}

/** Every string a stdio or HTTP entry can carry, for placeholder screening. */
function entryStrings(entry: Record<string, unknown>): string[] {
  const strings: string[] = [];
  // One at a time: spreading a long `args` array into push() throws a
  // RangeError well inside the file size limit. Strings only: coercing a deep
  // array or an object with its own `toString` throws, and the strict rules
  // refuse those values anyway.
  const add = (values: unknown[]) => {
    for (const value of values) {
      if (typeof value === "string") strings.push(value);
    }
  };
  for (const value of Object.values(entry)) {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) add(value);
    else if (isPlainRecord(value)) add(Object.values(value));
  }
  return strings;
}

function portableStdioFields(entry: Record<string, unknown>): void {
  if (typeof entry.command === "string") {
    const command = portablePlaceholders(entry.command);
    entry.command = command.startsWith("${PLUGIN_ROOT}/")
      ? `./${command.slice("${PLUGIN_ROOT}/".length)}`
      : command;
  }
  if (Array.isArray(entry.args)) {
    entry.args = entry.args.map((arg) =>
      typeof arg === "string" ? portablePlaceholders(arg) : arg
    );
  }
  if (isPlainRecord(entry.env)) {
    entry.env = Object.fromEntries(
      Object.entries(entry.env).map(([name, value]) => [
        name,
        typeof value === "string" ? portablePlaceholders(value) : value,
      ])
    );
  }
  if (typeof entry.cwd === "string") {
    const cwd = portablePlaceholders(entry.cwd);
    const bareRelative = !/^(?:\.\/|\/|\$\{|~)/.test(cwd);
    entry.cwd = cwd === "." ? "./" : bareRelative ? `./${cwd}` : cwd;
  }
}

/**
 * One legacy entry as a strict entry, or the reason it is skipped. A raw value
 * that is not an object passes through so the strict rules report it.
 */
function adaptEntry(
  key: string,
  config: unknown,
  issues: PluginIssueCollector
): { entry: unknown } | { reason: string } {
  if (!isPlainRecord(config)) return { entry: config };
  if (config.disabled === true || config.enabled === false) {
    return { reason: "it is disabled in its configuration" };
  }
  const detected = detectPluginMcpTransport(config, key);
  if (!detected.ok) return { reason: detected.message };
  const declared = String(config.type ?? config.transport ?? "");
  const type =
    detected.transport === "stdio"
      ? "stdio"
      : declared.toLowerCase() === "sse"
        ? "sse"
        : "streamable-http";
  const own = type === "stdio" ? STDIO_FIELDS : HTTP_FIELDS;
  const other = type === "stdio" ? HTTP_FIELDS : STDIO_FIELDS;
  const entry: Record<string, unknown> = { type };
  for (const [field, value] of Object.entries(config)) {
    if (IGNORED_FIELDS.has(field)) continue;
    if (other.has(field)) {
      return {
        reason: `it declares "${field}", which a ${type} server does not take`,
      };
    }
    if (own.has(field) || (type !== "stdio" && HTTP_HINT_FIELDS.has(field))) {
      entry[field] = value;
      continue;
    }
    issues.warn(
      "MCP_UNKNOWN_FIELD",
      `server "${key}": field "${field}" is not supported; ignored`,
      { componentKey: `server:${key}` }
    );
  }
  if (entryStrings(entry).some((text) => text.includes("${user_config."))) {
    return {
      reason:
        "it uses ${user_config.*} placeholders, which MCPJam does not fill in",
    };
  }
  if (type === "stdio") portableStdioFields(entry);
  return { entry };
}

/**
 * Rewrite a legacy MCP document for the strict normalizer. The declared-entry
 * cap is checked first and is bundle-fatal, as it is for `mcp.json`.
 */
export function adaptLegacyMcpConfig(
  raw: unknown,
  context: {
    sourcePath: string;
    issues: PluginIssueCollector;
    maxServers: number;
  }
): LegacyMcpAdaptation {
  const { sourcePath, issues, maxServers } = context;
  const selection = selectPluginMcpServerMap(raw);
  if (!selection.ok) {
    return { ok: false, code: selection.code, reason: selection.message };
  }
  const documentOf = (entries: [string, unknown][]) => ({
    $schema: PLUGIN_MCP_SCHEMAS["1.0.0"],
    // Own properties, even for a server keyed "__proto__": assigning that key
    // on a plain object would set its prototype and lose the server unsaid.
    mcpServers: Object.fromEntries(entries),
  });
  if (selection.servers.length > maxServers) {
    issues.error(
      "MCP_TOO_MANY_SERVERS",
      `${sourcePath} declares ${selection.servers.length} MCP servers; the limit is ${maxServers}`,
      { path: sourcePath }
    );
    return { ok: true, document: documentOf([]), skipped: [] };
  }
  const entries: [string, unknown][] = [];
  const skipped: PluginSkippedComponent[] = [];
  for (const { key, config } of selection.servers) {
    const adapted = adaptEntry(key, config, issues);
    if ("entry" in adapted) {
      entries.push([key, adapted.entry]);
      continue;
    }
    const reason = `server "${key}" was skipped: ${adapted.reason}`;
    issues.warn("COMPONENT_SKIPPED", reason, {
      path: sourcePath,
      componentKey: `server:${key}`,
    });
    skipped.push({ kind: "server", key, reason: adapted.reason });
  }
  return { ok: true, document: documentOf(entries), skipped };
}
