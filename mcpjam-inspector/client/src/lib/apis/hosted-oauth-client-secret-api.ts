import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface FetchOAuthClientSecretRequest {
  projectId: string;
  serverId: string;
}

export interface OAuthClientSecretResult {
  clientSecret: string;
}

export async function fetchOAuthClientSecret(
  request: FetchOAuthClientSecretRequest,
): Promise<OAuthClientSecretResult> {
  const body = await webPost<FetchOAuthClientSecretRequest, unknown>(
    "/api/web/oauth/client-secret",
    request,
  );
  const result =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (
    !result?.success ||
    typeof result.clientSecret !== "string" ||
    result.clientSecret.length === 0
  ) {
    throw new WebApiError(
      0,
      "INVALID_RESPONSE",
      "Hosted OAuth client secret response was invalid",
    );
  }

  return { clientSecret: result.clientSecret };
}

export const fetchHostedOAuthClientSecret = fetchOAuthClientSecret;
export type FetchHostedOAuthClientSecretRequest = FetchOAuthClientSecretRequest;
export type HostedOAuthClientSecretResult = OAuthClientSecretResult;
