import { extractHostExecutionPolicy } from "./host-policy.js";
import { cancellationLeafForVersion } from "./types.js";

/**
 * The MCP connection facts a host advertises — what to send in the `initialize`
 * handshake (`clientInfo`, `clientCapabilities`, protocol version) and whether
 * the host filters app-only tools from its model's view.
 *
 * Lets a non-browser surface (CLI, MCP server, API) connect to an MCP server
 * "as a host" using the same facts the playground does. The wire fields map
 * directly onto `MCPServerConfig` (`clientInfo` / `clientCapabilities` /
 * `supportedProtocolVersions` / `mcpProtocolVersion` /
 * `mirrorToolParamHeaders`); `respectToolVisibility`
 * drives `applyVisibilityPolicyAndCountSignals` on a tool list.
 */
export interface HostConnectionProfile {
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersion?: string;
  /**
   * SEP-2243 `Mcp-Param-*` mirroring, already reduced to the wire-layer
   * boolean `MCPServerConfig.mirrorToolParamHeaders` takes: `undefined` =
   * mirror (the spec-conforming default), `false` = the host asked to
   * simulate a client that never sends them. Only ever `false` or absent —
   * `"mirror"` collapses to absent so the wire config stays untouched.
   */
  mirrorToolParamHeaders?: boolean;
  /**
   * Client-conformance knobs, reduced to their wire shape: only the
   * NON-default value survives (the full-behavior literal and an absent
   * field are the same instruction, and an unknown future literal fails
   * closed into the full behavior).
   *
   * `true` = treat page one of paginated lists as the complete result. Maps
   * onto `MCPServerConfig.firstPageOnly`, which the client manager enforces
   * with a transport wrapper.
   */
  firstPageOnly?: true;
  /**
   * `false` = the client does not drive MRTR `input_required` rounds.
   * Enforcement lands in a follow-up PR; carrying the reduction here keeps
   * the profile → wire mapping in one place.
   */
  supportsMrtr?: false;
  /**
   * `true` = cancelling an in-flight request never reaches the server. The
   * client abandons the call locally; the server runs the tool to completion.
   *
   * ONE flag, even though the host config measures two eras: this connection
   * speaks exactly one, so the leaf is picked here — where the version is
   * already resolved — and the client just obeys. Maps onto
   * `MCPServerConfig.suppressRequestCancellation`.
   */
  suppressRequestCancellation?: true;
  /**
   * `true` = the client never opens the server→client notification channel
   * (legacy: the standalone GET SSE stream; 2026-07-28:
   * `subscriptions/listen`). ChatGPT measures this way — prober saw it never
   * open one — so a host emulating ChatGPT must not either.
   */
  suppressListenChannel?: true;
  /**
   * `true` = the client ignores `notifications/tools/list_changed` instead of
   * acting on it. Only meaningful when the channel is open, since nothing can
   * arrive otherwise.
   */
  dropToolListChanged?: true;
  /** undefined = spec default (filter app-only tools); false = host opts out. */
  respectToolVisibility: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive a {@link HostConnectionProfile} from a **seeded host config** — the
 * internal `mcpProfile` shape that `seedHostTemplate(id)` returns. Pure read, no
 * I/O. `clientInfo` + `supportedProtocolVersions` live under
 * `mcpProfile.initialize`; the protocol-version pin lives at
 * `mcpProfile.mcpProtocolVersion` (sibling of `initialize`); the advertised
 * capabilities and visibility policy live at the top level.
 *
 * (Not the public `Host.toJSON()` shape, which uses `mcp.protocolVersion` etc.)
 */
export function hostConnectionProfile(
  hostConfig: Record<string, unknown>
): HostConnectionProfile {
  const mcpProfile = isRecord(hostConfig.mcpProfile)
    ? hostConfig.mcpProfile
    : undefined;
  const initialize =
    mcpProfile && isRecord(mcpProfile.initialize)
      ? mcpProfile.initialize
      : undefined;

  const clientInfo = isRecord(initialize?.clientInfo)
    ? (initialize.clientInfo as {
        name?: string;
        version?: string;
      } & Record<string, unknown>)
    : undefined;

  const supportedProtocolVersions = Array.isArray(
    initialize?.supportedProtocolVersions
  )
    ? (initialize.supportedProtocolVersions as unknown[]).filter(
        (v): v is string => typeof v === "string"
      )
    : undefined;

  const mcpProtocolVersion =
    typeof mcpProfile?.mcpProtocolVersion === "string" &&
    mcpProfile.mcpProtocolVersion !== "auto"
      ? mcpProfile.mcpProtocolVersion
      : undefined;

  // Only `"omit"` says anything at the wire layer. An explicit `"mirror"`
  // and an absent field are the same instruction (mirror), so both leave
  // `mirrorToolParamHeaders` unset rather than pinning `true` — an unknown
  // future literal fails closed the same way, into the conforming default.
  const mirrorToolParamHeaders =
    mcpProfile?.toolParamHeaderMirroring === "omit" ? false : undefined;

  // Same reduction discipline for the sibling conformance knobs: only a
  // recognized NON-default literal produces a wire field.
  const firstPageOnly =
    mcpProfile?.paginationTraversal === "firstPageOnly"
      ? (true as const)
      : undefined;
  const supportsMrtr =
    mcpProfile?.mrtrSupport === "none" ? (false as const) : undefined;
  // Nested record, but the same discipline as the enum knobs: only an explicit
  // `false` leaf degrades, and an absent or malformed leaf stays conforming.
  // The version pin resolves WHICH leaf governs this connection, so only one
  // reaches the wire.
  const toolCallCancellation =
    mcpProfile && isRecord(mcpProfile.toolCallCancellation)
      ? mcpProfile.toolCallCancellation
      : undefined;
  const suppressRequestCancellation =
    toolCallCancellation?.[cancellationLeafForVersion(mcpProtocolVersion)] ===
    false
      ? (true as const)
      : undefined;
  // A nested record rather than an enum, but the same discipline: only an
  // explicit `false` leaf degrades, and absent stays absent. Narrowed like
  // `initialize` above — `mcpProfile` is an untyped record here.
  const toolListChanged =
    mcpProfile && isRecord(mcpProfile.toolListChanged)
      ? mcpProfile.toolListChanged
      : undefined;
  const suppressListenChannel =
    toolListChanged?.listens === false ? (true as const) : undefined;
  const dropToolListChanged =
    toolListChanged?.refetches === false ? (true as const) : undefined;

  const clientCapabilities = isRecord(hostConfig.clientCapabilities)
    ? hostConfig.clientCapabilities
    : undefined;

  const { respectToolVisibility } = extractHostExecutionPolicy(hostConfig);

  return {
    ...(clientInfo ? { clientInfo } : {}),
    ...(clientCapabilities ? { clientCapabilities } : {}),
    ...(supportedProtocolVersions && supportedProtocolVersions.length > 0
      ? { supportedProtocolVersions }
      : {}),
    ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
    ...(mirrorToolParamHeaders === false
      ? { mirrorToolParamHeaders: false }
      : {}),
    ...(firstPageOnly ? { firstPageOnly } : {}),
    ...(supportsMrtr === false ? { supportsMrtr: false } : {}),
    ...(suppressRequestCancellation ? { suppressRequestCancellation } : {}),
    ...(suppressListenChannel ? { suppressListenChannel } : {}),
    ...(dropToolListChanged ? { dropToolListChanged } : {}),
    respectToolVisibility,
  };
}
