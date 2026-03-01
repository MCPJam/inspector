import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export interface HostedServerValidateResponse {
  success: boolean;
  status?: string;
}

export interface HostedInitInfoResponse {
  success: boolean;
  initInfo: Record<string, unknown> | null;
}

export async function getHostedInitializationInfo(
  serverNameOrId: string,
): Promise<HostedInitInfoResponse> {
  const request = buildHostedServerRequest(serverNameOrId);
  return webPost<typeof request, HostedInitInfoResponse>(
    "/api/web/servers/init-info",
    request,
  );
}

export async function validateHostedServer(
  serverNameOrId: string,
  oauthAccessToken?: string,
): Promise<HostedServerValidateResponse> {
  const request = buildHostedServerRequest(serverNameOrId);
  // Prefer an explicit OAuth token (e.g. freshly obtained from the OAuth flow)
  // over the one stored in the hosted API context, which may be stale.
  if (oauthAccessToken) {
    request.oauthAccessToken = oauthAccessToken;
  }
  return webPost<typeof request, HostedServerValidateResponse>(
    "/api/web/servers/validate",
    request,
  );
}
