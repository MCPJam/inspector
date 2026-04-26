import { WebApiError } from "@/lib/apis/web/base";
import { getConvexSiteUrl } from "@/lib/convex-site-url";
import { authFetch } from "@/lib/session-token";

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

function getHostedOAuthTokensBaseUrl(): string {
  const site = getConvexSiteUrl();
  if (!site) {
    throw new WebApiError(
      0,
      "NO_CONVEX_SITE",
      "Convex site URL is not configured (VITE_CONVEX_URL or VITE_CONVEX_SITE_URL)",
    );
  }
  return site.replace(/\/$/, "");
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function throwFromFailedResponse(response: Response, body: unknown): never {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const code =
    typeof record?.code === "string"
      ? record.code
      : typeof record?.error === "string"
        ? record.error
        : null;
  const message =
    typeof record?.message === "string"
      ? record.message
      : typeof record?.error === "string"
        ? record.error
        : `Request failed (${response.status})`;
  throw new WebApiError(response.status, code, message);
}

export async function fetchHostedOAuthTokens(
  request: FetchHostedOAuthTokensRequest,
): Promise<HostedOAuthTokensResult> {
  const base = getHostedOAuthTokensBaseUrl();
  const response = await authFetch(`${base}/web/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throwFromFailedResponse(response, body);
  }

  const result =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!result?.success || !result.tokens || typeof result.tokens !== "object") {
    throw new WebApiError(
      response.status,
      null,
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
