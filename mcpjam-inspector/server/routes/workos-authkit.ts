import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { getOrCreateLocalSecret } from "../utils/local-secret-store.js";
import { resolveWorkosApiBaseUrl } from "../services/workos-api-base.js";
import { resolveWorkosClientId } from "../services/authkit-jwt.js";
import { revokeAuthKitSession } from "../services/auth-session-revocation.js";
import { logger } from "../utils/logger.js";
import {
  applyScopedCookieWrites,
  currentNamespace,
  readOwnScopedCookie,
  usesScopedSessionCookies,
} from "../utils/scoped-cookie-context.js";
import {
  WORKOS_SCOPED_COOKIE_MAX_AGE_S,
  buildDeletionCookie,
  parseCookieHeader,
  sealScopedCookie,
  unsealScopedCookie,
} from "../utils/scoped-cookies.js";

// Resolved per call, not captured at module load: a test stubs
// `WORKOS_API_BASE_URL` long after this module is imported. Unset, both are
// exactly the api.workos.com URLs they were before.
const workosBaseUrl = () => resolveWorkosApiBaseUrl(process.env).baseUrl;
const workosAuthenticateUrl = () =>
  `${workosBaseUrl()}/user_management/authenticate`;
const WORKOS_SESSION_COOKIE = "__Host-mcpjam_workos_session";
const WORKOS_HAS_SESSION_COOKIE = "workos-has-session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/**
 * Local session cookies from before per-namespace isolation. They are
 * DELETED, never migrated: a local WorkOS session restored from a shared jar
 * could be one another instance signed out of, so the upgrade costs exactly
 * one sign-in per instance instead.
 */
const LEGACY_LOCAL_WORKOS_COOKIES = [
  "mcpjam_workos_sessions",
  "mcpjam_workos_session",
  WORKOS_SESSION_COOKIE,
];

type AuthenticateBody = {
  client_id?: unknown;
  grant_type?: unknown;
  code?: unknown;
  code_verifier?: unknown;
  refresh_token?: unknown;
  organization_id?: unknown;
};

type WorkosAuthResponse = {
  refresh_token?: unknown;
  [key: string]: unknown;
};

type StoredWorkosSession = {
  refreshToken: string;
  updatedAt: number;
};

const workosAuthkitRoutes = new Hono();

function getCookieSecret(): string {
  return getOrCreateLocalSecret({
    fileName: "workos-session-secret",
    envVar: "MCPJAM_WORKOS_SESSION_SECRET",
    productionErrorMessage:
      "MCPJAM_WORKOS_SESSION_SECRET is required for WorkOS session cookies outside local runtimes.",
    label: "WorkOS session cookie secret",
    allowLocalFileOutsideDevelopment: true,
  });
}

function getEncryptionKey(): Buffer {
  return createHash("sha256").update(getCookieSecret()).digest();
}

/** Hosted (`__Host-`) cookie sealing; unchanged. */
function sealValue(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function unsealValue(value: string | undefined): unknown {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, ciphertext] = parts.map((part) =>
      Buffer.from(part, "base64url"),
    );
    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function parseStoredSession(value: unknown): StoredWorkosSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<StoredWorkosSession>;
  if (typeof session.refreshToken !== "string") return null;
  return {
    refreshToken: session.refreshToken,
    updatedAt:
      typeof session.updatedAt === "number" ? session.updatedAt : Date.now(),
  };
}

/** Delete whichever legacy local WorkOS cookies this browser still sends. */
function deleteLegacyLocalCookies(c: Context): void {
  const present = parseCookieHeader(c.req.header("cookie"));
  for (const name of LEGACY_LOCAL_WORKOS_COOKIES) {
    if (!present.has(name)) continue;
    c.header(
      "Set-Cookie",
      buildDeletionCookie(name, name.startsWith("__Host-")),
      { append: true },
    );
  }
}

/**
 * The `workos-has-session` hint, local flavour: an EXPIRING hint, renewed on
 * every successful sign-in or refresh and never cleared by an instance.
 *
 * It is host-wide — every Inspector on `localhost` reads the same one — while
 * sessions are per namespace. Clearing it on one instance's logout, missing
 * session, or rejected refresh would make every OTHER signed-in instance skip
 * its on-load refresh and come up signed out. Leaving it set costs a signed-out
 * instance one refresh call that answers "no session".
 *
 * authkit-js (>= 0.20) only trusts "1" or a value naming the client id; any
 * other value makes it skip the on-load refresh, so every reload lands signed
 * out.
 */
function renewLocalSessionHint(c: Context): void {
  setCookie(c, WORKOS_HAS_SESSION_COOKIE, "1", {
    sameSite: "Lax",
    path: "/",
    maxAge: WORKOS_SCOPED_COOKIE_MAX_AGE_S,
  });
}

function setSessionCookies(c: Context, session: StoredWorkosSession) {
  if (usesScopedSessionCookies(c)) {
    const ns = currentNamespace();
    const now = Date.now();
    applyScopedCookieWrites(c, [
      {
        kind: "workos",
        value: sealScopedCookie({
          kind: "workos",
          nsId: ns.id,
          payload: { refreshToken: session.refreshToken },
          issuedAtMs: now,
          expiresAtMs: now + WORKOS_SCOPED_COOKIE_MAX_AGE_S * 1000,
        }),
        maxAgeSeconds: WORKOS_SCOPED_COOKIE_MAX_AGE_S,
      },
    ]);
    deleteLegacyLocalCookies(c);
    renewLocalSessionHint(c);
    return;
  }

  setCookie(c, WORKOS_SESSION_COOKIE, sealValue(session), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  // authkit-js (>= 0.20) only trusts "1" or a value naming the client id;
  // any other value makes it skip the on-load refresh, so every reload
  // lands signed out.
  setCookie(c, WORKOS_HAS_SESSION_COOKIE, "1", {
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

function clearSecureSessionCookie(c: Context) {
  setCookie(c, WORKOS_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

/**
 * End THIS instance's session. Locally that is this namespace's cookie (and
 * any legacy cookie still around) — never another namespace's, and never the
 * host-wide hint (see `renewLocalSessionHint`).
 */
function clearSessionCookies(c: Context) {
  if (usesScopedSessionCookies(c)) {
    applyScopedCookieWrites(c, [{ kind: "workos", value: null }]);
    deleteLegacyLocalCookies(c);
    return;
  }

  clearSecureSessionCookie(c);
  setCookie(c, WORKOS_HAS_SESSION_COOKIE, "", {
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

function getStoredSession(c: Context): StoredWorkosSession | null {
  if (usesScopedSessionCookies(c)) {
    const opened = unsealScopedCookie({
      kind: "workos",
      nsId: currentNamespace().id,
      value: readOwnScopedCookie(c, "workos"),
    });
    return parseStoredSession(opened);
  }
  return parseStoredSession(unsealValue(getCookie(c, WORKOS_SESSION_COOKIE)));
}

/**
 * Login, refresh and logout all run under ONE WorkOS configuration: the client
 * id this server resolved. A request naming another client is refused rather
 * than forwarded — forwarding it would mint (and then store in this instance's
 * cookie) a session for a client this instance does not verify, which is how a
 * session from one environment ends up replayed against another.
 */
function clientIdRefusal(c: Context, requested: unknown): Response | null {
  const configured = resolveWorkosClientId();
  if (!configured) {
    logger.warn("WorkOS sign-in requested on a server with no client id", {
      event: "auth.workos_client_unconfigured",
    });
    return c.json(
      { error_description: "Sign-in is not configured on this server" },
      503,
    );
  }
  if (requested !== configured) {
    logger.info("Refused a WorkOS request for a different client id", {
      event: "auth.workos_client_id_mismatch",
      path: c.req.path,
    });
    return c.json(
      { error_description: "client_id does not match this server" },
      400,
    );
  }
  return null;
}

async function postToWorkos(
  body: Record<string, unknown>,
  init: { signal?: AbortSignal } = {},
) {
  return fetch(workosAuthenticateUrl(), {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: init.signal,
  });
}

/** Bound on the logout-time refresh below; the redirect waits on it. */
const LOGOUT_REVOCATION_REFRESH_TIMEOUT_MS = 3_000;

/**
 * Revoke, in Convex, the session this browser is signing out of (MJ-011).
 *
 * A logout also revokes the session in Convex, so the access tokens it issued
 * stop working there too. The backend revokes a session only for the token
 * that asks, and this request carries no access token — a logout is a
 * top-level navigation. What it does carry is the sealed
 * refresh-token cookie, so the session is proven the only way this route can:
 * refresh it once, and revoke with the token that comes back. The
 * `session_id` in the query string is NOT used for this; it is caller-supplied
 * and would let anyone name a session to sign out.
 *
 * The Inspector client already revokes before calling `signOut()`; this covers
 * a logout that reaches the proxy any other way. Best effort and bounded: the
 * logout below always proceeds.
 */
async function revokeStoredSessionBeforeLogout(c: Context): Promise<void> {
  const stored = getStoredSession(c);
  const clientId = resolveWorkosClientId();
  if (!stored || !clientId) return;
  try {
    const response = await postToWorkos(
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: stored.refreshToken,
      },
      { signal: AbortSignal.timeout(LOGOUT_REVOCATION_REFRESH_TIMEOUT_MS) },
    );
    if (!response.ok) return;
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string") return;
    const result = await revokeAuthKitSession(body.access_token);
    if (!result.revoked) {
      logger.info("Logout did not revoke the session in Convex", {
        event: "auth.logout_session_revoke_skipped",
        reason: result.reason,
      });
    }
  } catch (error) {
    logger.info("Logout could not refresh the session to revoke it", {
      event: "auth.logout_session_revoke_skipped",
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Whether a non-OK WorkOS refresh response leaves the stored token dead.
 *
 * Clearing is destructive in a way nothing above can undo: this cookie holds
 * the ONLY copy of the refresh token, so wiping it on a 502 converts one bad
 * second at WorkOS into a forced sign-in. That is the failure class the
 * client's retry ladder (`fetchTokenWithRetry` in `unified-convex-auth.ts`)
 * exists to absorb — but no retry can help once the credential itself is gone:
 * the next attempt finds an empty jar, gets "No local WorkOS session", and
 * AuthKit treats that as terminal and fires `onRefreshFailure`.
 *
 * A rejected grant is the opposite case and must still clear. WorkOS answers
 * 400 for a refresh token that is expired, revoked, or already rotated, and
 * keeping one would make every subsequent load re-enter the same refusal. On a
 * local instance that clears THIS namespace's cookie only; the host-wide
 * `workos-has-session` hint stays, because another instance may be signed in.
 *
 * A `fetch` rejection (offline, DNS, connection reset) never reaches here: it
 * throws before any cookie is touched, which lands on the same side of this
 * line by construction.
 */
function isTransientWorkosFailure(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function redirectToWorkos(c: Context, path: string) {
  const source = new URL(c.req.url);
  const target = new URL(path, workosBaseUrl());
  target.search = source.search;
  return c.redirect(target.toString(), 302);
}

workosAuthkitRoutes.get("/authorize", (c) => {
  const refusal = clientIdRefusal(c, c.req.query("client_id"));
  if (refusal) return refusal;
  return redirectToWorkos(c, "/user_management/authorize");
});

workosAuthkitRoutes.get("/sessions/logout", async (c) => {
  await revokeStoredSessionBeforeLogout(c);
  clearSessionCookies(c);
  return redirectToWorkos(c, "/user_management/sessions/logout");
});

workosAuthkitRoutes.post("/authenticate", async (c) => {
  let body: AuthenticateBody;
  try {
    body = (await c.req.json()) as AuthenticateBody;
  } catch {
    return c.json({ error_description: "Invalid JSON body" }, 400);
  }

  if (
    body.grant_type !== "authorization_code" &&
    body.grant_type !== "refresh_token"
  ) {
    return c.json({ error_description: "Unsupported grant_type" }, 400);
  }
  if (typeof body.client_id !== "string") {
    return c.json({ error_description: "Missing client_id" }, 400);
  }
  const refusal = clientIdRefusal(c, body.client_id);
  if (refusal) return refusal;

  const upstreamBody: Record<string, unknown> = { ...body };
  if (
    body.grant_type === "refresh_token" &&
    typeof body.refresh_token !== "string"
  ) {
    const stored = getStoredSession(c);
    if (!stored) {
      clearSessionCookies(c);
      return c.json({ error_description: "No local WorkOS session" }, 400);
    }
    upstreamBody.refresh_token = stored.refreshToken;
  }

  const response = await postToWorkos(upstreamBody);
  const responseText = await response.text();
  let responseJson: WorkosAuthResponse;
  try {
    responseJson = JSON.parse(responseText) as WorkosAuthResponse;
  } catch {
    responseJson = { error_description: responseText };
  }

  const refreshToken = responseJson.refresh_token;
  if (response.ok && typeof refreshToken === "string") {
    setSessionCookies(c, { refreshToken, updatedAt: Date.now() });
  } else if (
    !response.ok &&
    body.grant_type === "refresh_token" &&
    !isTransientWorkosFailure(response.status)
  ) {
    clearSessionCookies(c);
  }

  return c.json(responseJson, response.status as Parameters<typeof c.json>[1]);
});

export default workosAuthkitRoutes;
