import type { OAuthRegistrationMode } from "@mcpjam/sdk/browser";
import { captureCurrentReturnPath } from "@/lib/app-navigation";
import {
  clearHostedOAuthPendingState,
  writeHostedOAuthPendingMarker,
} from "@/lib/hosted-oauth-callback";
import {
  OAUTH_PENDING_STORAGE_KEY,
  initiateOAuth,
  type OAuthResult,
} from "@/lib/oauth/mcp-oauth";
import { buildOAuthRequest } from "@/lib/oauth/oauth-request";

/**
 * Signing a member in to one plugin server, through the same hosted OAuth
 * flow, callback and backend session as a project server.
 *
 * A plugin's server is not a project server: no server list shows it, and the
 * callback must not add it to one. The pending marker therefore carries
 * `pluginSignIn`, which makes the callback store the credential and stop
 * (`onlyStoresCredential`). The backend still keys the session by the server
 * id and checks the member's project access, as for any server.
 */

/** What `pluginSignIn:resolvePluginServerSignIn` answers. */
export interface PluginServerSignInTarget {
  pluginId: string;
  pluginVersionId: string;
  componentKey: string;
  serverId: string;
  serverName: string;
  serverUrl: string;
  scopes: string[];
  registrationMode?: OAuthRegistrationMode;
}

/**
 * The name this sign-in's OAuth state is stored under in the browser. Not the
 * server's own name: a project server can share it, and the flow's stored
 * client, discovery state and trace are all keyed by name.
 */
export function pluginSignInFlowName(serverName: string): string {
  return `${serverName} (plugin)`;
}

/**
 * Pin where the member started (project, organization, page, plugin
 * version and component), then leave for the authorization server.
 * Resolves as soon as the redirect starts, with `success` and no
 * `serverConfig`. It also resolves on an error, or with a `serverConfig`
 * when the flow finished without leaving the page.
 */
export async function startPluginServerSignIn(args: {
  target: PluginServerSignInTarget;
  projectId: string;
  organizationId: string | null;
  initiatingUserId: string | null;
  /** Where the member lands after the callback. Default: where they are. */
  returnPath?: string;
}): Promise<OAuthResult> {
  const { target } = args;
  const serverName = pluginSignInFlowName(target.serverName);
  const returnPath = args.returnPath ?? captureCurrentReturnPath();
  clearHostedOAuthPendingState();
  writeHostedOAuthPendingMarker({
    surface: "project",
    initiatingUserId: args.initiatingUserId,
    organizationId: args.organizationId,
    projectId: args.projectId,
    serverId: target.serverId,
    serverName,
    serverUrl: target.serverUrl,
    accessScope: "project_member",
    returnPath,
    pluginSignIn: {
      pluginVersionId: target.pluginVersionId,
      componentKey: target.componentKey,
    },
  });
  if (returnPath) localStorage.setItem("mcp-oauth-return-hash", returnPath);
  const request = buildOAuthRequest(
    {
      serverName,
      serverUrl: target.serverUrl,
      scopes: target.scopes,
      registrationMode: target.registrationMode,
    },
    { intent: "hosted-connect" },
  );
  const result = await initiateOAuth(request);
  if (!result.success) {
    // Nothing is in flight, so nothing may be left for a later callback to
    // pair with: the cleanup every hosted flow does when it fails to start.
    clearHostedOAuthPendingState();
    localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY);
    localStorage.removeItem("mcp-oauth-return-hash");
  }
  return result;
}
