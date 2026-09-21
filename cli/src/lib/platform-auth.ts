/**
 * MCPJam platform credentials for the CLI.
 *
 * Resolution precedence for platform commands:
 *   1. `--api-key` flag      (explicit `mcpjam_...` legacy keys hard-error)
 *   2. `MCPJAM_API_KEY` env  (`mcpjam_...` warns and falls through — that
 *                             env var is shared with SDK eval reporting,
 *                             which still uses legacy keys)
 *   3. stored OAuth login    (`mcpjam cloud login`, refreshed when near expiry)
 *
 * Login is Authorization Code + PKCE through the hosted bridge
 * (`/api/cli/auth/*`): the loopback listener and PKCE primitives come from
 * `@mcpjam/sdk`; the code is exchanged directly with AuthKit so the bridge
 * never sees tokens.
 */
import {
  createInteractiveAuthorizationSession,
  generateCodeChallenge,
  generateRandomString,
  openUrlInBrowser,
} from "@mcpjam/sdk";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import {
  clearStoredAuth,
  getAuthFilePath,
  readStoredAuth,
  writeStoredAuth,
  type StoredPlatformAuth,
} from "./auth-store.js";
import { operationalError, usageError } from "./output.js";

export const DEFAULT_PLATFORM_ORIGIN = "https://app.mcpjam.com";
const LEGACY_API_KEY_PREFIX = "mcpjam_";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

export const LEGACY_KEY_REMEDY =
  "Legacy mcpjam_ API keys are not supported by platform commands. Create an sk_ key at https://app.mcpjam.com/settings/api-keys or run `mcpjam cloud login`.";

export type ExplicitApiKeyInspection =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Classify an explicit `--api-key` without throwing. A `mcpjam_…` value is
 * invalid for Cloud commands. `cloud status` reports this in-band; other
 * commands still reject via {@link resolvePlatformCredential}.
 */
export function inspectExplicitApiKey(value: string): ExplicitApiKeyInspection {
  if (value.startsWith(LEGACY_API_KEY_PREFIX)) {
    return { ok: false, error: LEGACY_KEY_REMEDY };
  }
  return { ok: true };
}

export const MISSING_CLOUD_CREDENTIAL_MESSAGE =
  "Not logged in. Run `mcpjam cloud login`, or pass an sk_ API key via --api-key / MCPJAM_API_KEY.";

export interface PlatformCredential {
  kind: "api-key" | "oauth";
  getAuth: () => Promise<string>;
}

export interface ResolveCredentialDependencies {
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
}

export function resolvePlatformCredential(
  options: { apiKey?: string },
  deps: ResolveCredentialDependencies = {}
): PlatformCredential {
  const env = deps.env ?? process.env;
  const warn =
    deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));

  const flagKey = options.apiKey?.trim();
  if (flagKey) {
    const inspected = inspectExplicitApiKey(flagKey);
    if (!inspected.ok) {
      throw usageError(inspected.error);
    }
    return { kind: "api-key", getAuth: async () => flagKey };
  }

  const envKey = env.MCPJAM_API_KEY?.trim();
  if (envKey) {
    if (!envKey.startsWith(LEGACY_API_KEY_PREFIX)) {
      return { kind: "api-key", getAuth: async () => envKey };
    }
    // A legacy key in the shared env var is a valid eval-reporting setup, so
    // it must not break platform commands for a logged-in user: warn, ignore it.
    warn(
      `Ignoring legacy mcpjam_ key in MCPJAM_API_KEY for this command. ${LEGACY_KEY_REMEDY}`
    );
  }

  const authFilePath = deps.authFilePath ?? getAuthFilePath({ env });
  return {
    kind: "oauth",
    getAuth: () =>
      getOAuthAccessToken({
        authFilePath,
        fetchFn: deps.fetchFn,
        now: deps.now,
      }),
  };
}

export async function getOAuthAccessToken(deps: {
  authFilePath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<string> {
  const stored = readStoredAuth(deps.authFilePath);
  if (!stored) {
    throw operationalError(MISSING_CLOUD_CREDENTIAL_MESSAGE);
  }

  const now = deps.now ?? Date.now;
  const expiresSoon =
    stored.expiresAt !== undefined &&
    stored.expiresAt - now() <= TOKEN_REFRESH_SKEW_MS;
  if (!expiresSoon) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    throw operationalError("Login expired. Run `mcpjam cloud login` again.");
  }

  const refreshed = await refreshStoredAuth(stored, deps);
  return refreshed.accessToken;
}

async function refreshStoredAuth(
  stored: StoredPlatformAuth,
  deps: { authFilePath: string; fetchFn?: typeof fetch; now?: () => number }
): Promise<StoredPlatformAuth> {
  const tokens = await exchangeToken(
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

export interface PlatformLoginDependencies {
  fetchFn?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  createSession?: typeof createInteractiveAuthorizationSession;
  authFilePath?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Suppress best-effort account-enrichment warnings. */
  quiet?: boolean;
  warn?: (message: string) => void;
}

export interface PlatformLoginResult {
  authFilePath: string;
  issuer: string;
  apiUrl: string;
  expiresAt?: number;
  email?: string;
  plan?: string;
}

export interface PlatformLoginTarget {
  /** Origin hosting the CLI auth bridge, e.g. `https://app.mcpjam.com`. */
  origin: string;
  /**
   * Platform API base URL this login is for, persisted with the session so
   * later cloud commands talk to the same deployment by default.
   */
  apiUrl: string;
}

interface CliAuthConfig {
  issuer: string;
  clientId: string;
  authStartUrl: string;
  tokenEndpoint: string;
  redirectUri: string;
}

export async function runPlatformLogin(
  target: PlatformLoginTarget,
  deps: PlatformLoginDependencies = {}
): Promise<PlatformLoginResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const config = await fetchCliAuthConfig(target.origin, fetchFn);

  const codeVerifier = generateRandomString(64);
  const state = generateRandomString(32);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const session = await (
    deps.createSession ?? createInteractiveAuthorizationSession
  )();
  let code: string;
  try {
    const authorizationUrl = new URL(config.authStartUrl);
    authorizationUrl.searchParams.set("redirect_uri", session.redirectUrl);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    ({ code } = await session.authorize({
      authorizationUrl: authorizationUrl.toString(),
      expectedState: state,
      timeoutMs: deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      openUrl: deps.openUrl ?? openUrlInBrowser,
    }));
  } finally {
    await session.stop().catch(() => undefined);
  }

  // The hosted bridge registered `config.redirectUri` with AuthKit, so the
  // exchange must present that — not the loopback the bridge forwarded to.
  const tokens = await exchangeToken(
    config.tokenEndpoint,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    },
    fetchFn,
    "Login failed during the token exchange.",
    deps.now
  );

  if (!tokens.refreshToken) {
    throw operationalError(
      "AuthKit did not return a refresh token, so this login could not be saved. Ensure the CLI OAuth client allows the offline_access scope, or use an sk_ API key instead."
    );
  }

  const authFilePath = deps.authFilePath ?? getAuthFilePath();
  const stored: StoredPlatformAuth = {
    version: 1,
    issuer: config.issuer,
    clientId: config.clientId,
    tokenEndpoint: config.tokenEndpoint,
    apiUrl: target.apiUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
  };
  await writeStoredAuth(stored, authFilePath);

  const warn =
    deps.quiet === true
      ? () => undefined
      : deps.warn ??
        ((message: string) => process.stderr.write(`${message}\n`));
  const account = await enrichStoredAuthWithAccount(stored, {
    apiUrl: target.apiUrl,
    authFilePath,
    fetchFn,
    warn,
  });

  return {
    authFilePath,
    issuer: config.issuer,
    apiUrl: target.apiUrl,
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    ...account,
  };
}

export async function runPlatformLogout(
  authFilePath = getAuthFilePath()
): Promise<{ loggedOut: boolean; authFilePath: string }> {
  const loggedOut = await clearStoredAuth(authFilePath);
  return { loggedOut, authFilePath };
}

/**
 * Best-effort `getMe()` after a completed login write. Lookup failure and
 * enrichment-write failure must not turn a successful login into a failed one.
 */
async function enrichStoredAuthWithAccount(
  stored: StoredPlatformAuth,
  deps: {
    apiUrl: string;
    authFilePath: string;
    fetchFn: typeof fetch;
    warn: (message: string) => void;
  }
): Promise<{ email?: string; plan?: string }> {
  let email: string | undefined;
  let plan: string | undefined;
  try {
    const client = new PlatformApiClient({
      baseUrl: deps.apiUrl,
      getAuth: async () => stored.accessToken,
      fetch: deps.fetchFn,
    });
    const me = await client.getMe();
    if (typeof me.email === "string" && me.email.trim()) {
      email = me.email.trim();
    }
    if (typeof me.plan === "string" && me.plan.trim()) {
      plan = me.plan.trim();
    }
  } catch (error) {
    deps.warn(
      `Could not load account details after login: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {};
  }

  if (email === undefined && plan === undefined) return {};

  try {
    await writeStoredAuth(
      {
        ...stored,
        ...(email !== undefined ? { email } : {}),
        ...(plan !== undefined ? { plan } : {}),
      },
      deps.authFilePath
    );
  } catch (error) {
    deps.warn(
      `Logged in, but could not save account details to ${deps.authFilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    ...(email !== undefined ? { email } : {}),
    ...(plan !== undefined ? { plan } : {}),
  };
}

async function fetchCliAuthConfig(
  platformOrigin: string,
  fetchFn: typeof fetch
): Promise<CliAuthConfig> {
  const configUrl = `${platformOrigin.replace(/\/+$/, "")}/api/cli/auth/config`;
  let response: Response;
  try {
    response = await fetchFn(configUrl);
  } catch (error) {
    throw operationalError(
      `Could not reach ${configUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (response.status === 501) {
    throw operationalError(
      `CLI login is not enabled on ${platformOrigin}. Use an sk_ API key via --api-key / MCPJAM_API_KEY instead.`
    );
  }
  if (!response.ok) {
    throw operationalError(
      `Fetching the login configuration from ${configUrl} failed (${response.status}).`
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  for (const field of [
    "issuer",
    "clientId",
    "authStartUrl",
    "tokenEndpoint",
    "redirectUri",
  ] as const) {
    if (typeof body?.[field] !== "string" || !body[field]) {
      throw operationalError(
        `The login configuration from ${configUrl} is missing "${field}".`
      );
    }
  }

  return {
    issuer: body!.issuer as string,
    clientId: body!.clientId as string,
    authStartUrl: body!.authStartUrl as string,
    tokenEndpoint: body!.tokenEndpoint as string,
    redirectUri: body!.redirectUri as string,
  };
}

async function exchangeToken(
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
    throw operationalError(
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
    throw operationalError(`${failureMessage} (${detail})`);
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
