/**
 * Hosted OAuth bridge for `mcpjam login` (`/api/cli/auth/*`).
 *
 * AuthKit redirect URIs are registered statically, but the CLI listens on an
 * ephemeral loopback port — so the CLI sends users here instead:
 *
 *   1. `GET /config`   — public OAuth metadata (issuer, clientId, endpoints).
 *   2. `GET /start`    — validates the CLI's loopback redirect + PKCE
 *                        challenge, signs them into a short-lived state, and
 *                        redirects to AuthKit's authorize endpoint.
 *   3. `GET /callback` — verifies the signed state and forwards the
 *                        authorization `code` to the CLI's loopback with the
 *                        CLI's original state. Tokens are NEVER minted or
 *                        returned here: the CLI exchanges the code directly
 *                        with AuthKit using its PKCE verifier, so a leaked
 *                        code is useless without the verifier.
 *
 * Requires BOTH `CLI_AUTH_STATE_SECRET` (state HMAC key) and
 * `CLI_AUTH_PUBLIC_ORIGIN` (this deployment's public origin — explicit env
 * rather than forwarded-header reconstruction, which is spoofable). Without
 * either, every route answers 501 so self-hosted Inspectors degrade cleanly.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  resolveAuthkitIssuer,
  resolveWorkosClientId,
} from "../../services/authkit-jwt.js";
import {
  CLI_AUTH_STATE_TTL_MS,
  isAllowedLoopbackRedirect,
  signCliAuthState,
  verifyCliAuthState,
} from "./state.js";

// Scopes for the CLI session. `offline_access` is required for AuthKit to
// issue a refresh token (confirmed against the tenant discovery metadata).
const CLI_AUTH_SCOPE = "openid profile email offline_access";

// RFC 7636 §4.1/4.2: verifier and S256 challenge are 43–128 unreserved chars.
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const MAX_CLI_STATE_LENGTH = 512;

interface CliAuthConfig {
  secret: string;
  publicOrigin: string;
  issuer: string;
  clientId: string;
}

function resolveCliAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): CliAuthConfig | null {
  const secret = env.CLI_AUTH_STATE_SECRET;
  const rawOrigin = env.CLI_AUTH_PUBLIC_ORIGIN;
  if (!secret || !rawOrigin) {
    return null;
  }

  let publicOrigin: string;
  try {
    publicOrigin = new URL(rawOrigin).origin;
  } catch {
    return null;
  }

  const clientId = resolveWorkosClientId(env);
  if (!clientId) {
    return null;
  }
  const issuer = resolveAuthkitIssuer(clientId, env);
  if (!issuer) {
    return null;
  }

  return { secret, publicOrigin, issuer, clientId };
}

function notEnabled(c: Context): Response {
  return c.json(
    {
      code: "FEATURE_NOT_SUPPORTED",
      message:
        "CLI login is not enabled on this deployment (CLI_AUTH_STATE_SECRET and CLI_AUTH_PUBLIC_ORIGIN must be configured).",
    },
    501
  );
}

function badRequest(c: Context, message: string): Response {
  return c.json({ code: "VALIDATION_ERROR", message }, 400);
}

const cliAuth = new Hono();

cliAuth.get("/config", (c) => {
  const config = resolveCliAuthConfig();
  if (!config) {
    return notEnabled(c);
  }

  return c.json({
    issuer: config.issuer,
    clientId: config.clientId,
    authStartUrl: `${config.publicOrigin}/api/cli/auth/start`,
    tokenEndpoint: `${config.issuer}/oauth2/token`,
    redirectUri: `${config.publicOrigin}/api/cli/auth/callback`,
    scope: CLI_AUTH_SCOPE,
  });
});

cliAuth.get("/start", (c) => {
  const config = resolveCliAuthConfig();
  if (!config) {
    return notEnabled(c);
  }

  const redirectUri = c.req.query("redirect_uri") ?? "";
  if (!isAllowedLoopbackRedirect(redirectUri)) {
    return badRequest(
      c,
      "redirect_uri must be a plain-http loopback URL (127.0.0.1 or localhost)."
    );
  }

  const cliState = c.req.query("state") ?? "";
  if (cliState.length === 0 || cliState.length > MAX_CLI_STATE_LENGTH) {
    return badRequest(c, "state is required.");
  }

  const codeChallenge = c.req.query("code_challenge") ?? "";
  if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    return badRequest(c, "code_challenge must be a valid S256 challenge.");
  }
  if ((c.req.query("code_challenge_method") ?? "S256") !== "S256") {
    return badRequest(c, "code_challenge_method must be S256.");
  }

  const signedState = signCliAuthState(
    {
      cliRedirectUri: redirectUri,
      cliState,
      exp: Date.now() + CLI_AUTH_STATE_TTL_MS,
    },
    config.secret
  );

  const authorizeUrl = new URL(`${config.issuer}/oauth2/authorize`);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    `${config.publicOrigin}/api/cli/auth/callback`
  );
  authorizeUrl.searchParams.set("state", signedState);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", CLI_AUTH_SCOPE);

  return c.redirect(authorizeUrl.toString(), 302);
});

cliAuth.get("/callback", (c) => {
  const config = resolveCliAuthConfig();
  if (!config) {
    return notEnabled(c);
  }

  // Verify the signed state BEFORE touching any other parameter. A missing,
  // tampered, or expired state means we cannot trust the redirect target, so
  // we answer 400 directly and never redirect anywhere.
  const payload = verifyCliAuthState(c.req.query("state") ?? "", config.secret);
  if (!payload) {
    return badRequest(
      c,
      "Invalid or expired login state. Run `mcpjam login` again."
    );
  }

  const target = new URL(payload.cliRedirectUri);
  target.searchParams.set("state", payload.cliState);

  const oauthError = c.req.query("error");
  if (oauthError) {
    target.searchParams.set("error", oauthError);
    const description = c.req.query("error_description");
    if (description) {
      target.searchParams.set("error_description", description);
    }
    return c.redirect(target.toString(), 302);
  }

  const code = c.req.query("code");
  if (!code) {
    return badRequest(c, "Authorization response is missing a code.");
  }
  target.searchParams.set("code", code);

  return c.redirect(target.toString(), 302);
});

export default cliAuth;
