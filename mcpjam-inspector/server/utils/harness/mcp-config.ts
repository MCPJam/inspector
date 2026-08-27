/**
 * Build a Claude Code `.mcp.json` from a host's selected MCP servers — the
 * "Keep MCPJam being MCPJam" Phase 1 shape.
 *
 * Every entry points the harness at MCPJam's OWN per-server tunnel
 * (`…/api/mcp/adapter-http/{serverId}?k=…`), NOT at the upstream server. MCPJam
 * forwards to the real server via the live `MCPClientManager`, so:
 *   - the harness's MCP traffic flows through MCPJam (observation, the shared
 *     authorized connection, host-knob enforcement — the whole playground);
 *   - **no upstream credentials land in the sandbox** — the only secrets in
 *     `.mcp.json` are the tunnel's per-server `?k=` bearer and a per-turn,
 *     server-scoped `X-MCPJam-Proxy-Token` (validated-when-present by
 *     `adapter-http`; see `harness-proxy-token.ts`).
 *   - the non-secret scope step-up correlation travels in both the proxy URL
 *     and a header so every supported harness transport preserves it.
 *
 * This is the pure generator. Resolving each server's tunnel URL + minting its
 * token is the caller's job — see `run-harness-turn`.
 */
export const HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER =
  "X-MCPJam-Scope-Step-Up-Correlation";
export const HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY =
  "mcpjam-scope-step-up-correlation";

/** One server, resolved to its MCPJam proxy endpoint + per-turn token. */
export interface HarnessProxyServerInput {
  /** The MCPJam serverId (used as the key→name source for tool mapping). */
  name: string;
  /** Per-server tunnel URL that lands at `adapter-http/{serverId}` (carries `?k=`). */
  proxyUrl: string;
  /**
   * Convex-minted, server-scoped identity token sent as `X-MCPJam-Proxy-Token`.
   * Present on the HOSTED (web-authorized) plane, where the route uses it for
   * acting-as. OMITTED on the local-mcp plane: local servers have no Convex row
   * to authorize, the persistent manager already holds the connection, and the
   * tunnel's `?k=` secret is the auth (`adapter-http` is validate-when-present).
   */
  proxyToken?: string;
  /**
   * Policy-sealed replacement for `proxyToken` (`mcpjps1.…`, see
   * `harness-proxy-policy-seal.ts`): the Convex token ENCLOSED by the run's
   * resolved tool policy. Sent under the same header, so the sandbox cannot
   * drop the policy without dropping the credential. When present it REPLACES
   * `proxyToken` — the bare token must never also reach the sandbox, or
   * stripping the seal would restore unpoliced access.
   */
  sealedProxyToken?: string;
  /** Opaque live-turn id used only to route proxy-observed scope challenges. */
  scopeStepUpCorrelationId?: string;
}

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

/** Assign each server its sanitized, de-duplicated `.mcp.json` key, preserving
 *  input order. Shared by the json builder and the key→name map so the keys —
 *  and thus Claude Code's `mcp__<key>__<tool>` names — can't drift. */
function assignServerKeys<T extends { name: string }>(
  servers: T[],
): Array<{ key: string; server: T }> {
  const used = new Set<string>();
  const out: Array<{ key: string; server: T }> = [];
  for (const server of servers) {
    let key = sanitizeServerName(server.name);
    if (used.has(key)) {
      let i = 2;
      while (used.has(`${key}_${i}`)) i++;
      key = `${key}_${i}`;
    }
    used.add(key);
    out.push({ key, server });
  }
  return out;
}

/**
 * Build the `.mcp.json` object — every entry is an `http` entry pointing at the
 * server's MCPJam proxy URL, carrying ONLY the per-turn proxy token (no upstream
 * auth). Names are sanitized + de-duplicated so distinct servers never collide.
 */
export function buildHarnessProxyMcpJson(
  servers: HarnessProxyServerInput[],
): HarnessMcpJson {
  const mcpServers: Record<string, HarnessMcpHttpEntry> = {};
  for (const { key, server } of assignServerKeys(servers)) {
    mcpServers[key] = {
      type: "http",
      // Carry the non-secret correlation in the URL as well as the custom
      // header. Some harness MCP clients/proxy hops omit configured headers
      // when resuming or posting through the legacy SSE endpoint; the URL is
      // the one value every transport leg preserves.
      url: server.scopeStepUpCorrelationId
        ? appendQueryParam(
            server.proxyUrl,
            HARNESS_SCOPE_STEP_UP_CORRELATION_QUERY,
            server.scopeStepUpCorrelationId,
          )
        : server.proxyUrl,
      ...(server.sealedProxyToken ||
      server.proxyToken ||
      server.scopeStepUpCorrelationId
        ? {
            headers: {
              ...(server.sealedProxyToken
                ? { "X-MCPJam-Proxy-Token": server.sealedProxyToken }
                : server.proxyToken
                  ? { "X-MCPJam-Proxy-Token": server.proxyToken }
                  : {}),
              ...(server.scopeStepUpCorrelationId
                ? {
                    [HARNESS_SCOPE_STEP_UP_CORRELATION_HEADER]:
                      server.scopeStepUpCorrelationId,
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  return { mcpServers };
}

function appendQueryParam(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
}

/** Map each sanitized `.mcp.json` key → the input's original name (the MCPJam
 *  serverId), using the SAME sanitize+dedup as `buildHarnessProxyMcpJson`. Lets
 *  the turn runner map Claude Code's `mcp__<key>__<tool>` tool names back to the
 *  originating serverId (eval tool matching, trace spans, MCP App rendering). */
export function harnessServerKeyToName(
  servers: Array<{ name: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, server } of assignServerKeys(servers)) {
    out[key] = server.name;
  }
  return out;
}

/** Parse a Claude Code tool name into `{ serverId?, toolName }`. MCP tools are
 *  namespaced `mcp__<server>__<tool>`; native harness tools (Bash, Read, Edit,
 *  …) have no prefix. Returns the un-namespaced tool name (what the emulated
 *  engine + eval matching expect) plus the originating serverId when resolvable.
 *  A namespaced name whose key isn't in `keyToServerId` is returned verbatim —
 *  don't fabricate an attribution we can't make. */
export function parseHarnessToolName(
  rawToolName: string,
  keyToServerId: Record<string, string>,
): { serverId?: string; toolName: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(rawToolName);
  if (!match) return { toolName: rawToolName };
  const key = match[1]!;
  const tool = match[2]!;
  const serverId = keyToServerId[key];
  return serverId ? { serverId, toolName: tool } : { toolName: rawToolName };
}

/** Serialize to the JSON the harness writes into the sandbox workdir. */
export function serializeHarnessMcpJson(json: HarnessMcpJson): string {
  return JSON.stringify(json, null, 2);
}
