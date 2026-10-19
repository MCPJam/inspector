import {
  readStoredAuth,
  writeStoredAuth,
  type StoredPlatformAuth,
} from "./platform-auth-store.js";
export {
  clearStoredAuth,
  getAuthFilePath,
  readStoredAuth,
  writeStoredAuth,
} from "./platform-auth-store.js";
export type {
  StoredPlatformAuth,
  AuthStorePathOptions,
} from "./platform-auth-store.js";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MISSING_CLOUD_CREDENTIAL_MESSAGE =
  "Not logged in. Run `mcpjam cloud login`, or pass an sk_ API key via --api-key / MCPJAM_API_KEY.";

export async function getOAuthAccessToken(deps: {
  authFilePath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<string> {
  const stored = readStoredAuth(deps.authFilePath);
  if (!stored) {
    throw new Error(MISSING_CLOUD_CREDENTIAL_MESSAGE);
  }

  const now = deps.now ?? Date.now;
  const expiresSoon =
    stored.expiresAt !== undefined &&
    stored.expiresAt - now() <= TOKEN_REFRESH_SKEW_MS;
  if (!expiresSoon) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    throw new Error("Login expired. Run `mcpjam cloud login` again.");
  }

  const refreshed = await refreshStoredAuth(stored, deps);
  return refreshed.accessToken;
}

async function refreshStoredAuth(
  stored: StoredPlatformAuth,
  deps: { authFilePath: string; fetchFn?: typeof fetch; now?: () => number }
): Promise<StoredPlatformAuth> {
  const tokens = await exchangePlatformToken(
    stored.tokenEndpoint,
    {
      grant_type: "refresh_token",
      client_id: stored.clientId,
      refresh_token: stored.refreshToken!,
    },
    deps.fetchFn ?? fetch,
    "Token refresh failed. Run `mcpjam cloud login` again.",
    deps.now
  );

  const refreshed: StoredPlatformAuth = {
    ...stored,
    accessToken: tokens.accessToken,
    // AuthKit rotates refresh tokens; keep the old one only if none returned.
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
  };
  await writeStoredAuth(refreshed, deps.authFilePath);
  return refreshed;
}

export async function exchangePlatformToken(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchFn: typeof fetch,
  failureMessage: string,
  now: () => number = Date.now
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  let response: Response;
  try {
    response = await fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (error) {
    throw new Error(
      `${failureMessage} Could not reach ${tokenEndpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || typeof body?.access_token !== "string") {
    const detail =
      typeof body?.error_description === "string"
        ? body.error_description
        : typeof body?.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(`${failureMessage} (${detail})`);
  }

  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string"
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? { expiresAt: now() + body.expires_in * 1000 }
      : {}),
  };
}
