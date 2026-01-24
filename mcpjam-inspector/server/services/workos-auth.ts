/**
 * WorkOS Authentication Service
 *
 * Server-side authentication using @workos/authkit-session for JWT session
 * management with HTTP-only cookies. This replaces the client-side
 * @workos-inc/authkit-react approach that doesn't persist properly in
 * production Docker deployments.
 */

import {
  createAuthService,
  CookieSessionStorage,
  configure,
  parseCookieHeader,
  type AuthKitConfig,
} from "@workos/authkit-session";
import {
  WORKOS_API_KEY,
  WORKOS_CLIENT_ID,
  WORKOS_REDIRECT_URI,
  WORKOS_COOKIE_PASSWORD,
} from "../config";

/**
 * Hono-compatible cookie session storage adapter
 */
class HonoCookieStorage extends CookieSessionStorage<Request, Response> {
  async getSession(request: Request): Promise<string | null> {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) return null;
    const cookies = parseCookieHeader(cookieHeader);
    return cookies[this.cookieName] ?? null;
  }

  protected async applyHeaders(
    response: Response | undefined,
    headers: Record<string, string>,
  ): Promise<{ response: Response }> {
    const newResponse = response
      ? new Response(response.body, {
          status: response.status,
          headers: new Headers(response.headers),
        })
      : new Response();

    Object.entries(headers).forEach(([key, value]) => {
      newResponse.headers.append(key, value);
    });

    return { response: newResponse };
  }
}

// Configure WorkOS AuthKit
configure({
  clientId: WORKOS_CLIENT_ID,
  apiKey: WORKOS_API_KEY,
  redirectUri: WORKOS_REDIRECT_URI,
  cookiePassword: WORKOS_COOKIE_PASSWORD,
  cookieName: "workos-session",
  cookieMaxAge: 60 * 60 * 24 * 7, // 7 days
  cookieSameSite: "lax",
});

// Create the auth service with our Hono storage adapter
export const authService = createAuthService({
  sessionStorageFactory: (config: AuthKitConfig) =>
    new HonoCookieStorage(config),
});

/**
 * User type returned from WorkOS authentication
 */
export interface WorkOSUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  profilePictureUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Authentication result from withAuth
 */
export interface AuthResult {
  user: WorkOSUser | null;
  sessionId: string | null;
  organizationId: string | null;
  role: string | null;
  permissions: string[];
  accessToken: string | null;
}

/**
 * Result from withAuth including refresh data
 */
export interface WithAuthResult {
  auth: AuthResult;
  refreshedSessionData: unknown | null;
}

/**
 * Get the current authenticated user from the session cookie.
 *
 * @param request - The incoming request
 * @returns Authentication result with user info or null if not authenticated
 */
export async function getAuth(request: Request): Promise<WithAuthResult> {
  try {
    const result = await authService.withAuth(request);
    return {
      auth: {
        user: result.auth.user as WorkOSUser | null,
        sessionId: result.auth.sessionId ?? null,
        organizationId: result.auth.organizationId ?? null,
        role: result.auth.role ?? null,
        permissions: result.auth.permissions ?? [],
        accessToken: result.auth.accessToken ?? null,
      },
      refreshedSessionData: result.refreshedSessionData,
    };
  } catch (error) {
    console.error("[WorkOS Auth] Error getting auth:", error);
    return {
      auth: {
        user: null,
        sessionId: null,
        organizationId: null,
        role: null,
        permissions: [],
        accessToken: null,
      },
      refreshedSessionData: null,
    };
  }
}

/**
 * Generate the authorization URL for login.
 *
 * @param options - Options for the authorization URL
 * @returns The WorkOS authorization URL
 */
export async function getAuthorizationUrl(options?: {
  returnPathname?: string;
  screenHint?: "sign-in" | "sign-up";
}): Promise<string> {
  return authService.getAuthorizationUrl({
    returnPathname: options?.returnPathname ?? "/",
    screenHint: options?.screenHint,
  });
}

/**
 * Handle the OAuth callback from WorkOS.
 *
 * @param request - The incoming request with code and state
 * @param response - The response to modify with session cookie
 * @returns The response with session cookie and redirect path
 */
export async function handleCallback(
  request: Request,
  response: Response,
): Promise<{
  response: Response;
  returnPathname: string;
  user: WorkOSUser;
}> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    throw new Error("Missing authorization code");
  }

  const result = await authService.handleCallback(request, response, {
    code,
    state: state || undefined,
  });

  return {
    response: result.response!,
    returnPathname: result.returnPathname ?? "/",
    user: result.authResponse.user as WorkOSUser,
  };
}

/**
 * Sign out the user and clear the session.
 *
 * @param sessionId - The session ID to terminate
 * @param options - Sign out options
 * @returns The logout URL and headers to clear the session
 */
export async function signOut(
  sessionId: string,
  options?: { returnTo?: string },
): Promise<{
  logoutUrl: string;
  headers: Record<string, string>;
}> {
  return authService.signOut(sessionId, options);
}

/**
 * Save refreshed session data to the response.
 *
 * @param response - The response to modify
 * @param sessionData - The refreshed session data
 * @returns The modified response with updated session cookie
 */
export async function saveRefreshedSession(
  response: Response | undefined,
  sessionData: unknown,
): Promise<Response | undefined> {
  if (!sessionData) return response;

  const { response: newResponse, headers } = await authService.saveSession(
    response,
    sessionData,
  );

  if (headers?.["Set-Cookie"] && newResponse) {
    newResponse.headers.set("Set-Cookie", headers["Set-Cookie"]);
  }

  return newResponse ?? response;
}
