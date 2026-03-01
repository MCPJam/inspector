import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export interface HostedServerValidateResponse {
  success: boolean;
  status?: string;
  initInfo?: Record<string, unknown> | null;
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
