import { extractHostExecutionPolicy } from "./host-policy.js";

/**
 * The MCP connection facts a host advertises — what to send in the `initialize`
 * handshake (`clientInfo`, `clientCapabilities`, protocol version) and whether
 * the host filters app-only tools from its model's view.
 *
 * Lets a non-browser surface (CLI, MCP server, API) connect to an MCP server
 * "as a host" using the same facts the playground does. The wire fields map
 * directly onto `MCPServerConfig` (`clientInfo` / `clientCapabilities` /
 * `supportedProtocolVersions` / `mcpProtocolVersion`); `respectToolVisibility`
 * drives `applyVisibilityPolicyAndCountSignals` on a tool list.
 */
export interface HostConnectionProfile {
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersion?: string;
  /** undefined = spec default (filter app-only tools); false = host opts out. */
  respectToolVisibility: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive a {@link HostConnectionProfile} from a seeded host config — exactly
 * what `seedHostTemplate(id)` returns, or a `Host.toJSON()` shape. Pure read,
 * no I/O. The handshake pins live under `mcpProfile.initialize`; the advertised
 * capabilities and visibility policy live at the top level.
 */
export function hostConnectionProfile(
  hostConfig: Record<string, unknown>,
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
    initialize?.supportedProtocolVersions,
  )
    ? (initialize.supportedProtocolVersions as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : undefined;

  const mcpProtocolVersion =
    typeof initialize?.mcpProtocolVersion === "string"
      ? initialize.mcpProtocolVersion
      : undefined;

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
    respectToolVisibility,
  };
}
