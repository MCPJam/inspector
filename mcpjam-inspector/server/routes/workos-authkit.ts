import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { getOrCreateLocalSecret } from "../utils/local-secret-store.js";

const WORKOS_AUTHENTICATE_URL =
  "https://api.workos.com/user_management/authenticate";
const WORKOS_BASE_URL = "https://api.workos.com";
const WORKOS_SESSION_COOKIE = "__Host-mcpjam_workos_session";
const LOCAL_WORKOS_SESSION_COOKIE = "mcpjam_workos_sessions";
const LEGACY_LOCAL_WORKOS_SESSION_COOKIE = "mcpjam_workos_session";
const WORKOS_HAS_SESSION_COOKIE = "workos-has-session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
const MAX_LOCAL_SESSIONS = 8;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

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

type StoredWorkosSessionJar = {
  version: 1;
  sessions: Record<string, StoredWorkosSession>;
};

const workosAuthkitRoutes = new Hono();

function isLocalHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

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
      Buffer.from(part, "base64url")
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

function parseStoredSessionJar(value: unknown): StoredWorkosSessionJar {
  if (!value || typeof value !== "object") {
    return { version: 1, sessions: {} };
  }
  const maybeJar = value as Partial<StoredWorkosSessionJar>;
  if (maybeJar.version !== 1 || !maybeJar.sessions) {
    return { version: 1, sessions: {} };
  }

  const sessions: Record<string, StoredWorkosSession> = {};
  for (const [key, session] of Object.entries(maybeJar.sessions)) {
    const parsed = parseStoredSession(session);
    if (parsed) {
      sessions[key] = parsed;
    }
  }
  return { version: 1, sessions };
}

function getLocalOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!LOCAL_HOSTNAMES.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getClientOrigin(c: Context): string {
  return (
    getLocalOrigin(c.req.header("Origin")) ??
    getLocalOrigin(c.req.header("Referer")) ??
    new URL(c.req.url).origin
  );
}

function getClientOriginKey(c: Context): string {
  return createHash("sha256").update(getClientOrigin(c)).digest("hex").slice(0, 16);
}

function getLocalSessionJar(c: Context): StoredWorkosSessionJar {
  return parseStoredSessionJar(unsealValue(getCookie(c, LOCAL_WORKOS_SESSION_COOKIE)));
}

function pruneLocalSessions(
  sessions: Record<string, StoredWorkosSession>
): Record<string, StoredWorkosSession> {
  return Object.fromEntries(
    Object.entries(sessions)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_LOCAL_SESSIONS)
  );
}

function setSessionCookies(c: Context, session: StoredWorkosSession) {
  if (isLocalHttpUrl(c.req.url)) {
    const key = getClientOriginKey(c);
    const jar = getLocalSessionJar(c);
    const sessions = pruneLocalSessions({
      ...jar.sessions,
      [key]: session,
    });
    setCookie(c, LOCAL_WORKOS_SESSION_COOKIE, sealValue({ version: 1, sessions }), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
    setCookie(c, LEGACY_LOCAL_WORKOS_SESSION_COOKIE, "", {
      path: "/",
      maxAge: 0,
    });
  } else {
    setCookie(c, WORKOS_SESSION_COOKIE, sealValue(session), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  }

  setCookie(c, WORKOS_HAS_SESSION_COOKIE, "true", {
    secure: !isLocalHttpUrl(c.req.url),
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

function clearSessionCookies(c: Context) {
  if (isLocalHttpUrl(c.req.url)) {
    const key = getClientOriginKey(c);
    const jar = getLocalSessionJar(c);
    delete jar.sessions[key];
    const remainingSessions = pruneLocalSessions(jar.sessions);

    if (Object.keys(remainingSessions).length > 0) {
      setCookie(
        c,
        LOCAL_WORKOS_SESSION_COOKIE,
        sealValue({ version: 1, sessions: remainingSessions }),
        {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: COOKIE_MAX_AGE,
        }
      );
    } else {
      setCookie(c, LOCAL_WORKOS_SESSION_COOKIE, "", {
        path: "/",
        maxAge: 0,
      });
      setCookie(c, WORKOS_HAS_SESSION_COOKIE, "", {
        path: "/",
        maxAge: 0,
      });
    }

    setCookie(c, LEGACY_LOCAL_WORKOS_SESSION_COOKIE, "", {
      path: "/",
      maxAge: 0,
    });
    clearSecureSessionCookie(c);
    return;
  }

  clearSecureSessionCookie(c);
  setCookie(c, WORKOS_HAS_SESSION_COOKIE, "", {
    secure: !isLocalHttpUrl(c.req.url),
    path: "/",
    maxAge: 0,
  });
}

function getStoredSession(c: Context) {
  if (isLocalHttpUrl(c.req.url)) {
    return getLocalSessionJar(c).sessions[getClientOriginKey(c)] ?? null;
  }
  return parseStoredSession(unsealValue(getCookie(c, WORKOS_SESSION_COOKIE)));
}

async function postToWorkos(body: Record<string, unknown>) {
  return fetch(WORKOS_AUTHENTICATE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function redirectToWorkos(c: Context, path: string) {
  const source = new URL(c.req.url);
  const target = new URL(path, WORKOS_BASE_URL);
  target.search = source.search;
  return c.redirect(target.toString(), 302);
}

workosAuthkitRoutes.get("/authorize", (c) =>
  redirectToWorkos(c, "/user_management/authorize")
);

workosAuthkitRoutes.get("/sessions/logout", (c) => {
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
  } else if (!response.ok && body.grant_type === "refresh_token") {
    clearSessionCookies(c);
  }

  return c.json(responseJson, response.status as Parameters<typeof c.json>[1]);
});

export default workosAuthkitRoutes;
