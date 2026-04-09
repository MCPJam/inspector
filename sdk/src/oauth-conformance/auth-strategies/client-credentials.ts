import type {
  ClientCredentialsResult,
  TrackedRequestFn,
} from "../types.js";

export interface ClientCredentialsInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod?: string;
  scope?: string;
  resource?: string;
  request: TrackedRequestFn;
}

export async function performClientCredentialsGrant({
  tokenEndpoint,
  clientId,
  clientSecret,
  tokenEndpointAuthMethod,
  scope,
  resource,
  request,
}: ClientCredentialsInput): Promise<ClientCredentialsResult> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (scope) {
    body.set("scope", scope);
  }

  if (resource) {
    body.set("resource", resource);
  }

  if (tokenEndpointAuthMethod === "client_secret_basic") {
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );
    headers.Authorization = `Basic ${encoded}`;
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }

  const tokenResponse = await request({
    method: "POST",
    url: tokenEndpoint,
    headers,
    body: body.toString(),
  });

  if (!tokenResponse.ok) {
    throw new Error(
      `Token request failed: ${tokenResponse.body?.error || tokenResponse.statusText} - ${tokenResponse.body?.error_description || "Unknown error"}`,
    );
  }

  if (!tokenResponse.body?.access_token) {
    throw new Error("Token response did not include an access_token");
  }

  return {
    tokenResponse,
    accessToken: tokenResponse.body.access_token,
    refreshToken: tokenResponse.body.refresh_token,
    tokenType: tokenResponse.body.token_type || "Bearer",
    expiresIn: tokenResponse.body.expires_in,
  };
}
