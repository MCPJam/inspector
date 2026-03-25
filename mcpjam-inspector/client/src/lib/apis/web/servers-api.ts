import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

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
  serverNameOrId: string,
): Promise<HostedServerOAuthRequirementResponse> {
  const request = buildHostedServerRequest(serverNameOrId);
  return webPost<typeof request, HostedServerOAuthRequirementResponse>(
    "/api/web/servers/check-oauth",
    request,
  );
}

export async function validateHostedServer(
  serverNameOrId: string,
  oauthAccessToken?: string,
  clientCapabilities?: Record<string, unknown>,
): Promise<HostedServerValidateResponse> {
  const request = buildHostedServerRequest(serverNameOrId);
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
    request,
  );
}
