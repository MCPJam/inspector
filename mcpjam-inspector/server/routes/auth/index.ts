/**
 * Authentication Routes
 *
 * Server-side authentication endpoints using WorkOS AuthKit.
 * These routes handle OAuth login flow, session management, and user info.
 */

import { Hono } from "hono";
import {
  getAuth,
  getAuthorizationUrl,
  handleCallback,
  signOut,
  saveRefreshedSession,
} from "../../services/workos-auth";
import { logger } from "../../utils/logger";

const auth = new Hono();

/**
 * GET /api/auth/login
 *
 * Initiates the WorkOS OAuth flow by redirecting to the authorization URL.
 * Query params:
 * - returnTo: Path to redirect after successful login (default: "/")
 * - screenHint: "sign-in" or "sign-up" to show specific screen
 */
auth.get("/login", async (c) => {
  try {
    const returnTo = c.req.query("returnTo") ?? "/";
    const screenHint = c.req.query("screenHint") as
      | "sign-in"
      | "sign-up"
      | undefined;

    const authUrl = await getAuthorizationUrl({
      returnPathname: returnTo,
      screenHint,
    });

    logger.info("[Auth] Redirecting to WorkOS login", { returnTo, screenHint });
    return c.redirect(authUrl);
  } catch (error) {
    logger.error("[Auth] Error generating auth URL:", error);
    return c.json({ error: "Failed to initiate login" }, 500);
  }
});

/**
 * GET /api/auth/callback
 *
 * Handles the OAuth callback from WorkOS.
 * Exchanges the authorization code for tokens and sets the session cookie.
 */
auth.get("/callback", async (c) => {
  try {
    const result = await handleCallback(c.req.raw, new Response());

    logger.info("[Auth] User authenticated successfully", {
      userId: result.user.id,
      email: result.user.email,
    });

    // Clone response headers and add redirect
    const response = new Response(null, {
      status: 302,
      headers: result.response.headers,
    });
    response.headers.set("Location", result.returnPathname);

    return response;
  } catch (error) {
    logger.error("[Auth] Callback error:", error);

    // Check for specific error messages
    const errorMessage =
      error instanceof Error ? error.message : "Authentication failed";

    if (errorMessage === "Missing authorization code") {
      return c.json({ error: errorMessage }, 400);
    }

    return c.json({ error: "Authentication failed" }, 500);
  }
});

/**
 * POST /api/auth/logout
 *
 * Signs out the user by clearing the session cookie and returning
 * the WorkOS logout URL for complete session termination.
 */
auth.post("/logout", async (c) => {
  try {
    const { auth } = await getAuth(c.req.raw);

    if (!auth.user || !auth.sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    // Get returnTo from request body or default to origin
    let returnTo = "/";
    try {
      const body = await c.req.json();
      if (body.returnTo) {
        returnTo = body.returnTo;
      }
    } catch {
      // No body or invalid JSON is fine
    }

    const { logoutUrl, headers } = await signOut(auth.sessionId, { returnTo });

    logger.info("[Auth] User logged out", { userId: auth.user.id });

    // Return logout URL and set cookie-clearing headers
    const response = c.json({ logoutUrl });
    Object.entries(headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    logger.error("[Auth] Logout error:", error);
    return c.json({ error: "Logout failed" }, 500);
  }
});

/**
 * GET /api/auth/me
 *
 * Returns the current authenticated user from the session cookie.
 * Returns null if not authenticated.
 */
auth.get("/me", async (c) => {
  try {
    const { auth, refreshedSessionData } = await getAuth(c.req.raw);

    // Build the response
    const responseData = {
      user: auth.user,
      sessionId: auth.sessionId,
      organizationId: auth.organizationId,
      role: auth.role,
      permissions: auth.permissions,
    };

    let response = c.json(responseData);

    // If session was refreshed, update the cookie
    if (refreshedSessionData) {
      const refreshedResponse = await saveRefreshedSession(
        new Response(JSON.stringify(responseData), {
          headers: { "Content-Type": "application/json" },
        }),
        refreshedSessionData,
      );
      if (refreshedResponse) {
        return refreshedResponse;
      }
    }

    return response;
  } catch (error) {
    logger.error("[Auth] Error getting user:", error);
    return c.json({ error: "Failed to get user" }, 500);
  }
});

/**
 * GET /api/auth/token
 *
 * Returns the access token for the current session.
 * This is used by the Convex client to authenticate with Convex.
 */
auth.get("/token", async (c) => {
  try {
    const { auth, refreshedSessionData } = await getAuth(c.req.raw);

    if (!auth.user) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    // Build the response
    const responseData = { accessToken: auth.accessToken };

    // If session was refreshed, update the cookie
    if (refreshedSessionData) {
      const refreshedResponse = await saveRefreshedSession(
        new Response(JSON.stringify(responseData), {
          headers: { "Content-Type": "application/json" },
        }),
        refreshedSessionData,
      );
      if (refreshedResponse) {
        return refreshedResponse;
      }
    }

    return c.json(responseData);
  } catch (error) {
    logger.error("[Auth] Error getting token:", error);
    return c.json({ error: "Failed to get token" }, 500);
  }
});

export default auth;
