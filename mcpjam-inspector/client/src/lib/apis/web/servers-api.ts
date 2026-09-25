import { HOSTED_MODE } from "@/lib/config";
import { serverCheckQueue } from "@/lib/server-check-queue";
import { tryGetHostedServerDisplayName } from "./context";
import { webPost } from "./base";
import { buildServerRequest } from "./context";

export type HostedServerValidateContext = {
  /** Internal browser slot already held by a non-interactive connection operation. Never sent on the wire. */
  queueSignal?: AbortSignal;
  projectId: string;
  serverId: string;
  serverName?: string;
  accessScope?: "project_member" | "chat_v2";
  scenarioId?: string;
  accessVersion?: number;
  /**
   * Per-connection MCP `initialize.params.clientInfo` override resolved
   * client-side from `hostConfig.mcpProfile.initialize.clientInfo`. The
   * hosted backend serializes this verbatim into the MCP `initialize`
   * call so hosted scenario / inspector sessions honor the same identity
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
  mcpProtocolVersion?: import("@mcpjam/sdk/browser").McpProtocolVersion;
  /**
   * SEP-2243 `Mcp-Param-*` mirroring, resolved client-side from
   * `hostConfig.mcpProfile.toolParamHeaderMirroring`. Only ever `false` — the
   * SDK mirrors when the field is absent, so `"mirror"` sends nothing. The
   * hosted route forwards it onto `BaseServerConfig.mirrorToolParamHeaders`
   * so a hosted session simulates the same non-conforming client a local one
   * does.
   */
  mirrorToolParamHeaders?: boolean;
  /**
   * Sibling conformance knobs from `mcpProfile.paginationTraversal` /
   * `mcpProfile.mrtrSupport`. Only the non-default value is ever set.
   */
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  toolCallCancellation?: { legacy?: boolean; modern?: boolean };
};

export interface HostedServerValidateResponse {
  success: boolean;
  status?: string;
  initInfo?: Record<string, unknown> | null;
}

export interface HostedServerOAuthRequirementResponse {
  /**
   * Derived compat mirror of the canonical `authMethod`: true for an `auto`
   * (discover) row too, which is why it must NOT be read as "authorize this
   * before using it". Read `requiresAuthorization` for that.
   */
  useOAuth: boolean;
  /**
   * Whether the server's stored auth configuration demands interactive
   * authorization before it can be used at all (effective auth method
   * `oauth`). Optional because an older inspector server does not send it.
   */
  requiresAuthorization?: boolean;
  effectiveAuthMethod?: "oauth" | "xaa" | "bearer" | "none" | "discover";
  serverUrl: string | null;
}

export async function checkHostedServerOAuthRequirement(
  serverNameOrId: string,
): Promise<HostedServerOAuthRequirementResponse> {
  const request = buildServerRequest(serverNameOrId);
  return webPost<typeof request, HostedServerOAuthRequirementResponse>(
    "/api/web/servers/check-oauth",
    request,
  );
}

export async function validateHostedServer(
  serverNameOrId: string,
  oauthAccessToken?: string,
  clientCapabilities?: Record<string, unknown>,
  hostedContext?: HostedServerValidateContext,
  /**
   * Cancels the connect for a caller running its own deadline. The route keeps
   * an MCP connection open for as long as its connect timeout allows, so a
   * caller that gave up and retried would otherwise hold two open at once.
   */
  signal?: AbortSignal,
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
        ...(hostedContext.scenarioId
          ? { scenarioId: hostedContext.scenarioId }
          : {}),
        ...(hostedContext.scenarioId &&
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
        // SEP-2243 mirroring knob. Declared on the context and accepted by the
        // route's schema, but it only reaches the wire if it is spread HERE —
        // the same drop-on-the-floor step the pins above were plumbed to fix.
        ...(hostedContext.mirrorToolParamHeaders === false
          ? { mirrorToolParamHeaders: false }
          : {}),
        ...(hostedContext.firstPageOnly === true
          ? { firstPageOnly: true }
          : {}),
        ...(hostedContext.supportsMrtr === false
          ? { supportsMrtr: false }
          : {}),
        ...(hostedContext.suppressListenChannel === true
          ? { suppressListenChannel: true }
          : {}),
        ...(hostedContext.dropToolListChanged === true
          ? { dropToolListChanged: true }
          : {}),
        ...(hostedContext.toolCallCancellation
          ? { toolCallCancellation: hostedContext.toolCallCancellation }
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
  if (!HOSTED_MODE)
    return webPost<typeof request, HostedServerValidateResponse>(
      "/api/web/servers/validate",
      request,
      { signal },
    );
  const execute = async (checkSignal: AbortSignal) => {
    // Browser waiting has no timeout. Once dispatched, allow the backend's
    // 30-second queue window plus the existing 20-second connection budget.
    const deadline = new AbortController();
    const timeout = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            "Connection attempt timed out. Click Connect to retry.",
            "TimeoutError",
          ),
        ),
      50_000,
    );
    try {
      return await webPost<typeof request, HostedServerValidateResponse>(
        "/api/web/servers/validate",
        request,
        { signal: AbortSignal.any([checkSignal, deadline.signal]) },
      );
    } finally {
      clearTimeout(timeout);
    }
  };
  if (hostedContext?.queueSignal) return execute(hostedContext.queueSignal);
  return serverCheckQueue.run(
    {
      projectId: String(request.projectId),
      serverName: String(
        request.serverName ??
          tryGetHostedServerDisplayName(String(request.serverId)) ??
          serverNameOrId,
      ),
      identity: JSON.stringify([
        request.clientInfo,
        request.supportedProtocolVersions,
        request.mcpProtocolVersion,
      ]),
      signal,
    },
    execute,
  );
}
