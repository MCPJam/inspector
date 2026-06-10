import { webPost } from "./base";
import { buildServerRequest } from "./context";

export type HostedServerValidateContext = {
  projectId: string;
  serverId: string;
  serverName?: string;
  accessScope?: "project_member" | "chat_v2";
  chatboxId?: string;
  accessVersion?: number;
  /**
   * Per-connection MCP `initialize.params.clientInfo` override resolved
   * client-side from `hostConfig.mcpProfile.initialize.clientInfo`. The
   * hosted backend serializes this verbatim into the MCP `initialize`
   * call so hosted chatbox / inspector sessions honor the same identity
   * pin as resolver-path local connects. Undefined → SDK defaults.
   *
   * Without this field the hosted path silently dropped `mcpProfile.
   * initialize.*` pins (codex P2): `connectionDefaults` was built but
   * never reached the validate context, so hosted connects always
   * initialized with the SDK's hardcoded clientInfo.
   */
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  /**
   * Per-connection MCP `initialize.params.supportedProtocolVersions`
   * accept-list, resolved verbatim from
   * `hostConfig.mcpProfile.initialize.supportedProtocolVersions`. First
   * entry is what the SDK proposes; the full array is the accept-set
   * (a server negotiating any listed version is accepted). Order is
   * semantic.
   */
  supportedProtocolVersions?: string[];
  /**
   * Pinned MCP protocol version resolved client-side from
   * `hostConfig.mcpProfile.mcpProtocolVersion` + per-server override.
   * Sent verbatim to the hosted route, which forwards it onto
   * `HttpServerConfig.mcpProtocolVersion` so the SDK factory routes
   * stateless versions through `StatelessMcpHttpPreviewClient`. Without
   * this, hosted connects always ran the legacy `initialize` handshake
   * regardless of the client toggle.
   */
  mcpProtocolVersion?: import("@mcpjam/sdk/browser").McpProtocolVersionPin;
};

export interface HostedServerValidateResponse {
  success: boolean;
  status?: string;
  initInfo?: Record<string, unknown> | null;
}

export interface HostedServerOAuthRequirementResponse {
  useOAuth: boolean;
  serverUrl: string | null;
}

export async function checkHostedServerOAuthRequirement(
  serverNameOrId: string
): Promise<HostedServerOAuthRequirementResponse> {
  const request = buildServerRequest(serverNameOrId);
  return webPost<typeof request, HostedServerOAuthRequirementResponse>(
    "/api/web/servers/check-oauth",
    request
  );
}

export async function validateHostedServer(
  serverNameOrId: string,
  oauthAccessToken?: string,
  clientCapabilities?: Record<string, unknown>,
  hostedContext?: HostedServerValidateContext
): Promise<HostedServerValidateResponse> {
  const request: Record<string, unknown> = hostedContext
    ? {
        projectId: hostedContext.projectId,
        serverId: hostedContext.serverId,
        ...(hostedContext.serverName
          ? { serverName: hostedContext.serverName }
          : {}),
        ...(hostedContext.accessScope
          ? { accessScope: hostedContext.accessScope }
          : {}),
        ...(hostedContext.chatboxId
          ? { chatboxId: hostedContext.chatboxId }
          : {}),
        ...(hostedContext.chatboxId &&
        Number.isFinite(hostedContext.accessVersion)
          ? { accessVersion: hostedContext.accessVersion }
          : {}),
        // mcpProfile.initialize pins. Sent verbatim; the backend reads
        // them when present and falls back to SDK defaults otherwise.
        // Always optional so legacy callers keep working.
        ...(hostedContext.clientInfo
          ? { clientInfo: hostedContext.clientInfo }
          : {}),
        ...(hostedContext.supportedProtocolVersions &&
        hostedContext.supportedProtocolVersions.length > 0
          ? {
              supportedProtocolVersions:
                hostedContext.supportedProtocolVersions,
            }
          : {}),
        ...(hostedContext.mcpProtocolVersion
          ? { mcpProtocolVersion: hostedContext.mcpProtocolVersion }
          : {}),
      }
    : buildServerRequest(serverNameOrId);
  // Prefer an explicit OAuth token (e.g. freshly obtained from the OAuth flow)
  // over the one stored in the hosted API context, which may be stale.
  if (oauthAccessToken) {
    request.oauthAccessToken = oauthAccessToken;
  }
  if (clientCapabilities) {
    request.clientCapabilities = clientCapabilities;
  }
  return webPost<typeof request, HostedServerValidateResponse>(
    "/api/web/servers/validate",
    request
  );
}
