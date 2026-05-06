import { webPost, WebApiError } from "@/lib/apis/web/base";

export interface ImportHostedOAuthTokensTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

/**
 * Normalize an arbitrary tokens object into the import-tokens wire shape.
 * Returns `null` when `access_token` is missing or non-string. Optional
 * fields are included only when their type matches (string for refresh/
 * token_type/scope/id_token; number for expires_in).
 *
 * Centralized here so MCPOAuthProvider.saveTokens (live OAuth completion)
 * and the localStorage→Convex migration shim emit byte-identical payloads
 * for the same input — the parity is asserted in unit tests.
 */
export function normalizeImportHostedOAuthTokens(
  input: unknown,
): ImportHostedOAuthTokensTokens | null {
  if (!input || typeof input !== "object") return null;
  const tokens = input as Record<string, unknown>;
  if (typeof tokens.access_token !== "string") return null;
  const out: ImportHostedOAuthTokensTokens = {
    access_token: tokens.access_token,
  };
  if (typeof tokens.refresh_token === "string") {
    out.refresh_token = tokens.refresh_token;
  }
  if (typeof tokens.expires_in === "number") {
    out.expires_in = tokens.expires_in;
  }
  if (typeof tokens.token_type === "string") {
    out.token_type = tokens.token_type;
  }
  if (typeof tokens.scope === "string") {
    out.scope = tokens.scope;
  }
  if (typeof tokens.id_token === "string") {
    out.id_token = tokens.id_token;
  }
  return out;
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
