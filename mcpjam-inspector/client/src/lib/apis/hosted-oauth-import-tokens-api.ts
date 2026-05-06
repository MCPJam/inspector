import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface ImportHostedOAuthTokensTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

export interface ImportHostedOAuthTokensRequest {
  projectId: string;
  serverId: string;
  serverUrl: string;
  oauthResourceUrl?: string;
  kind: "generic" | "registry";
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
  clientInformation: {
    clientId: string;
    clientSecret?: string;
  };
  tokens: ImportHostedOAuthTokensTokens;
}

export interface ImportHostedOAuthTokensResult {
  expiresAt: number | null;
  kind: "generic" | "registry";
}

export async function importHostedOAuthTokens(
  request: ImportHostedOAuthTokensRequest,
): Promise<ImportHostedOAuthTokensResult> {
  const body = await webPost<ImportHostedOAuthTokensRequest, unknown>(
    "/api/web/oauth/import-tokens",
    request,
  );
  const result =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!result?.success) {
    throw new WebApiError(
      0,
      "INVALID_RESPONSE",
      "Hosted OAuth import-tokens response was invalid",
    );
  }

  const kind = result.kind === "registry" ? "registry" : "generic";
  return {
    expiresAt: typeof result.expiresAt === "number" ? result.expiresAt : null,
    kind,
  };
}
