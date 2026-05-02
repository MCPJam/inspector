import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface FetchHostedOAuthClientSecretRequest {
  workspaceId: string;
  serverId: string;
}

export interface HostedOAuthClientSecretResult {
  clientSecret: string;
}

export async function fetchHostedOAuthClientSecret(
  request: FetchHostedOAuthClientSecretRequest,
): Promise<HostedOAuthClientSecretResult> {
  const body = await webPost<FetchHostedOAuthClientSecretRequest, unknown>(
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
