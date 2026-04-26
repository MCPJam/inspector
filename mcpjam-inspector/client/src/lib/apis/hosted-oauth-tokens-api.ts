import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface HostedOAuthTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface HostedOAuthTokensResult {
  tokens: HostedOAuthTokens;
  expiresAt: number | null;
  kind: "generic" | "registry";
}

export interface FetchHostedOAuthTokensRequest {
  workspaceId: string;
  serverId: string;
}

export async function fetchHostedOAuthTokens(
  request: FetchHostedOAuthTokensRequest,
): Promise<HostedOAuthTokensResult> {
  const body = await webPost<FetchHostedOAuthTokensRequest, unknown>(
    "/api/web/oauth/tokens",
    request,
  );
  const result =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!result?.success || !result.tokens || typeof result.tokens !== "object") {
    throw new WebApiError(
      0,
      "INVALID_RESPONSE",
      "Hosted OAuth token response was invalid",
    );
  }

  const kind = result.kind === "registry" ? "registry" : "generic";
  return {
    tokens: result.tokens as HostedOAuthTokens,
    expiresAt: typeof result.expiresAt === "number" ? result.expiresAt : null,
    kind,
  };
}
