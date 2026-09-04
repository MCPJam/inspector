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
/**
 * The harness TURN a proxied call belongs to.
 *
 * Non-secret, and its trust is bounded inside the token's VERIFIED iteration
 * claim: it decides which turn of an already-authorized iteration a row is
 * filed under, and nothing else. A turn retry or resume mints a fresh one, so
 * a stale attempt's evidence stays addressable but out of the current turn.
 *
 * A header rather than a query parameter for the reason the correlation id
 * above is both: proxy URLs end up in relay and access logs, and this one has
 * no reason to be there.
 */
export const HARNESS_EVIDENCE_TURN_HEADER = "X-MCPJam-Harness-Turn";

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
  /**
   * The turn id evidence rows are filed under, sent as
   * `X-MCPJam-Harness-Turn`. Present only when the run froze capture on and
   * the mint returned an authorized eval scope; absent everywhere else, which
   * is what makes a fully-off run byte-identical to a pre-evidence one.
   */
  evidenceTurnId?: string;
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
      server.scopeStepUpCorrelationId ||
      server.evidenceTurnId
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
              // Header only, deliberately unlike the correlation above: the
              // turn id is not needed by any transport leg that drops headers,
              // and a proxy URL carrying it would put it in access logs for no
              // benefit. Absent when capture is off, so an off run's
              // `.mcp.json` is byte-identical to a pre-evidence one.
              ...(server.evidenceTurnId
                ? { [HARNESS_EVIDENCE_TURN_HEADER]: server.evidenceTurnId }
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

/* ── ACP (Cursor CLI) shape ────────────────────────────────────────────────
 *
 * The Cursor harness takes its MCP servers as a CONSTRUCTOR setting
 * (`createCursor({ mcpServers })`) which the adapter forwards into the ACP
 * `session/new` request, rather than as a file MCPJam writes into the box. Same
 * DELIVERY MODE as Claude Code (the runtime's own MCP client dials MCPJam's
 * signed proxy, so every `tools/call` is observable there); different
 * mechanism, and a different wire shape for the headers.
 */

/** One ACP MCP HTTP header. ACP spells headers as an ARRAY of name/value pairs,
 *  not the object `.mcp.json` uses. */
export interface AcpMcpHeader {
  name: string;
  value: string;
}

/** One ACP `session/new` MCP server entry (http transport). */
export interface AcpMcpHttpServer {
  type: "http";
  url: string;
  /**
   * REQUIRED, and an empty array when there is nothing to send.
   *
   * Not optional-with-a-default: omitting the key entirely makes cursor-agent
   * fail `session/new` with an opaque JSON-RPC `-32603` internal error that
   * names neither the field nor the server. Verified against cursor-agent
   * 2026.08.31 during the harness spike — always emit the key.
   */
  headers: AcpMcpHeader[];
}

/**
 * The MCP server name ACP reserves for `HarnessAgent`'s own host-executed tool
 * channel. `createACPV1` throws outright if a supplied server uses it.
 */
const ACP_RESERVED_MCP_SERVER_NAME = "ai-sdk-harness-tools";

/**
 * Convert the shared `.mcp.json` object into ACP's `mcpServers` map.
 *
 * The KEYS are preserved exactly, which is what keeps tool attribution working:
 * `harnessServerKeyToName` is built from the same `assignServerKeys` pass, so a
 * rename here would silently orphan every tool call from that server. That is
 * also why a collision with ACP's reserved name throws instead of being
 * re-keyed — losing attribution is worse than failing the turn, and the turn
 * would fail in the adapter anyway, just with a message that names neither
 * MCPJam nor the server.
 */
export function toAcpMcpServers(
  json: HarnessMcpJson,
): Record<string, AcpMcpHttpServer> {
  const out: Record<string, AcpMcpHttpServer> = {};
  for (const [key, entry] of Object.entries(json.mcpServers)) {
    if (key === ACP_RESERVED_MCP_SERVER_NAME) {
      throw new Error(
        `MCP server key "${key}" is reserved by the ACP harness runtime for its own tool channel; ` +
          "rename the server so it does not sanitize to that key.",
      );
    }
    out[key] = {
      type: "http",
      url: entry.url,
      // Always an array — see AcpMcpHttpServer.headers.
      headers: Object.entries(entry.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    };
  }
  return out;
}

/**
 * Attribute a Cursor/ACP tool call to MCPJam tool identity.
 *
 * Cursor does NOT namespace MCP tools the way Claude Code does. Every MCP call
 * arrives under an opaque, per-session `acp_tool_<id>` stream name, and the
 * real identity rides in the call's INPUT:
 *
 *   { providerIdentifier: "<mcp server key>", toolName: "<tool>", args: {…} }
 *
 * So the raw name is useless here and the input is the only source. When the
 * input carries no provider identity the call is one of Cursor's own built-ins
 * (bash, read, edit, …) and passes through under the raw name — the same
 * "don't fabricate an attribution" rule `parseHarnessToolName` follows.
 *
 * When the input DOES name a tool but its provider key is unresolvable, the
 * tool name still comes back (it is firsthand from the input) with no
 * `serverId`. That is the same rule, not an exception to it: the unknown part
 * is the server mapping, and only that part is withheld. Returning the opaque
 * `acp_tool_…` id instead would discard a fact we actually have.
 *
 * THE `user-` PREFIX. Cursor prefixes user-configured MCP providers with
 * `user-` in `providerIdentifier` (`user-<key>`), but not universally — it
 * depends on how the server was registered. So the exact key is tried FIRST and
 * the stripped form only as a fallback; stripping unconditionally would
 * mis-attribute a server whose own key legitimately begins with `user-`.
 */
export function attributeCursorToolCall(args: {
  rawToolName: string;
  input: unknown;
  keyToServerId: Record<string, string>;
}): { serverId?: string; toolName: string } {
  const { rawToolName, input, keyToServerId } = args;
  const record =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const provider = record.providerIdentifier;
  const inner = record.toolName;
  if (typeof provider !== "string" || typeof inner !== "string" || !inner) {
    return { toolName: rawToolName };
  }
  // Exact key first, THEN the `user-`-stripped form. Never the other way round.
  const serverId =
    keyToServerId[provider] ??
    (provider.startsWith("user-")
      ? keyToServerId[provider.slice("user-".length)]
      : undefined);
  return serverId ? { serverId, toolName: inner } : { toolName: inner };
}
