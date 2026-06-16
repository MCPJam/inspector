/**
 * Build a Claude Code `.mcp.json` from a host's selected MCP servers.
 *
 * Claude Code runs INSIDE the E2B sandbox and connects to each server itself,
 * so EVERY entry is an `http` entry — the sandbox can neither spawn our stdio
 * subprocesses nor reach private addresses:
 *   - remote http/sse servers → their public url + headers directly (sandbox
 *     egress reaches the public internet);
 *   - local/stdio servers → the inspector's tunnel relay url, which bridges an
 *     external https request back to the local stdio process. Claude Code never
 *     spawns a stdio server itself.
 *
 * This is the pure generator. Resolving each server's effective config (and the
 * tunnel url for local ones) is the caller's job — see Phase 4's
 * `runHarnessTurn`, which has the live MCPClientManager + tunnelManager.
 */
import { isHttpServerConfig } from "@mcpjam/sdk";
import type { MCPServerConfig } from "@mcpjam/sdk";

/** Failure building the harness MCP config (e.g. a local server with no tunnel). */
export class HarnessMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessMcpConfigError";
  }
}

/**
 * A selected MCP server, normalized for the harness. Both variants resolve to
 * an http entry; the variant only records where the url came from.
 */
export type HarnessMcpServerInput =
  | {
      name: string;
      transport: "http";
      /** Public URL the sandbox reaches directly. */
      url: string;
      headers?: Record<string, string>;
    }
  | {
      name: string;
      transport: "stdio";
      /** Tunnel relay URL bridging the local stdio server over https. */
      tunnelUrl: string;
      headers?: Record<string, string>;
    };

/** A single Claude Code `.mcp.json` server entry (http transport). */
export interface HarnessMcpHttpEntry {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface HarnessMcpJson {
  mcpServers: Record<string, HarnessMcpHttpEntry>;
}

/** Claude Code namespaces MCP tools as `mcp__<server>__<tool>`, so the server
 *  key must be a safe identifier. Map anything else to `_`, collapse repeats,
 *  trim, and fall back to "server". */
function sanitizeServerName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return cleaned || "server";
}

/** Normalize a transport `headers` value (Headers | tuples | record) to a plain
 *  record; returns undefined when there's nothing to send. */
function coerceHeaders(h: unknown): Record<string, string> | undefined {
  if (!h) return undefined;
  let entries: Array<[string, string]> = [];
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    entries = [...h.entries()];
  } else if (Array.isArray(h)) {
    entries = h
      .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length >= 2)
      .map(([k, v]) => [String(k), String(v)]);
  } else if (typeof h === "object") {
    entries = Object.entries(h as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Normalize one resolved `MCPServerConfig` (the shape `createAuthorizedManager`
 * produces) into a harness input.
 *  - http/sse → its url + headers directly.
 *  - stdio    → requires `tunnelUrl` (the local process isn't reachable from
 *               the sandbox); throws `HarnessMcpConfigError` if it's missing.
 */
export function harnessServerInputFromConfig(
  name: string,
  config: MCPServerConfig,
  opts: { tunnelUrl?: string | null } = {},
): HarnessMcpServerInput {
  if (isHttpServerConfig(config)) {
    const headers = coerceHeaders(config.requestInit?.headers) ?? {};
    // createAuthorizedManager already overlays OAuth into headers, but honor a
    // bare accessToken too (any existing Authorization header wins, regardless
    // of casing — header names are case-insensitive).
    const hasAuthorizationHeader = Object.keys(headers).some(
      (key) => key.toLowerCase() === "authorization",
    );
    if (config.accessToken && !hasAuthorizationHeader) {
      headers.Authorization = `Bearer ${config.accessToken}`;
    }
    return {
      name,
      transport: "http",
      url: config.url,
      headers: Object.keys(headers).length ? headers : undefined,
    };
  }
  // stdio — not reachable from the sandbox without a tunnel.
  if (!opts.tunnelUrl) {
    throw new HarnessMcpConfigError(
      `local (stdio) server "${name}" needs a tunnel URL to be reachable from ` +
        `the sandbox — open a tunnel for it before starting the harness turn`,
    );
  }
  return { name, transport: "stdio", tunnelUrl: opts.tunnelUrl };
}

/** Build the `.mcp.json` object from normalized inputs. Names are sanitized and
 *  de-duplicated so distinct servers never collide on a key. */
export function buildHarnessMcpJson(
  servers: HarnessMcpServerInput[],
): HarnessMcpJson {
  const mcpServers: Record<string, HarnessMcpHttpEntry> = {};
  const used = new Set<string>();
  for (const s of servers) {
    let key = sanitizeServerName(s.name);
    if (used.has(key)) {
      let i = 2;
      while (used.has(`${key}_${i}`)) i++;
      key = `${key}_${i}`;
    }
    used.add(key);
    const url = s.transport === "http" ? s.url : s.tunnelUrl;
    const entry: HarnessMcpHttpEntry = { type: "http", url };
    if (s.headers && Object.keys(s.headers).length > 0) {
      entry.headers = { ...s.headers };
    }
    mcpServers[key] = entry;
  }
  return { mcpServers };
}

/** Serialize to the JSON the harness writes into the sandbox workdir. */
export function serializeHarnessMcpJson(json: HarnessMcpJson): string {
  return JSON.stringify(json, null, 2);
}
