/** Discord's two-proof account-link bridge. */
import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import {
  randomToken,
  hashOauthState,
  oauthStateMatches,
  signSlackLinkState,
  verifySlackLinkState,
} from "../slack-link/state.js";
import { isValidDiscordServiceToken } from "../../middleware/slack-service-auth.js";
import {
  consumeSurfaceLinkSession,
  createSurfaceLinkSession,
  getSurfaceLinkSession,
  resolveOrganizationByWorkosId,
  setSurfaceLinkStatus,
} from "../../services/slack-backend.js";
import { resolveUserByExternalId } from "../../services/identity.js";
import {
  resolveAuthkitIssuer,
  resolveWorkosClientId,
} from "../../services/authkit-jwt.js";
import { logger } from "../../utils/logger.js";

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_API_URL = "https://discord.com/api/v10";
const COOKIE_NAME = "mcpjam_discord_link";
const TTL_MS = 10 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10_000;

interface DiscordLinkConfig {
  secret: string;
  publicOrigin: string;
  discordClientId: string;
  discordClientSecret: string;
  discordBotToken: string;
  workosIssuer: string;
  workosClientId: string;
  workosClientSecret: string;
}

function resolveConfig(
  env: NodeJS.ProcessEnv = process.env
): DiscordLinkConfig | null {
  const secret = env.DISCORD_LINK_STATE_SECRET;
  const rawOrigin =
    env.DISCORD_LINK_PUBLIC_ORIGIN ?? env.CLI_AUTH_PUBLIC_ORIGIN;
  const discordClientId = env.DISCORD_CLIENT_ID;
  const discordClientSecret = env.DISCORD_CLIENT_SECRET;
  const discordBotToken = env.DISCORD_BOT_TOKEN ?? "";
  const workosClientId = env.SLACK_LINK_WORKOS_CLIENT_ID;
  const workosClientSecret = env.SLACK_LINK_WORKOS_CLIENT_SECRET;
  if (
    !secret ||
    !rawOrigin ||
    !discordClientId ||
    !discordClientSecret ||
    !workosClientId ||
    !workosClientSecret
  )
    return null;
  let publicOrigin: string;
  try {
    publicOrigin = new URL(rawOrigin).origin;
  } catch {
    return null;
  }
  const environmentClientId = resolveWorkosClientId(env);
  if (!environmentClientId) return null;
  const workosIssuer = resolveAuthkitIssuer(environmentClientId, env);
  if (!workosIssuer) return null;
  return {
    secret,
    publicOrigin,
    discordClientId,
    discordClientSecret,
    discordBotToken,
    workosIssuer,
    workosClientId,
    workosClientSecret,
  };
}

function callbackUrl(config: DiscordLinkConfig, path: string): string {
  return `${config.publicOrigin}/api/surface-link/${path}`;
}

function tokenFromRequest(c: Context): string {
  const value = c.req.header("authorization") ?? "";
  return /^Bearer\s+(\S+)\s*$/i.exec(value)?.[1] ?? "";
}

function page(
  c: Context,
  title: string,
  body: string,
  status: 200 | 400 | 503 = 200
): Response {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(
      title
    )} · MCPJam</title><main style="font:16px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:1rem"><h1>${escape(
      title
    )}</h1><p>${escape(body)}</p></main>`,
    status
  );
}

function unavailable(c: Context): Response {
  return page(
    c,
    "MCPJam is having a moment",
    "Your identity checked out, but we couldn’t finish just now. Open the Connect link from Discord again in a minute — the connection is not linked yet.",
    503
  );
}

function failed(c: Context): Response {
  return page(
    c,
    "That link didn’t work",
    "This connection link is invalid, has expired, or was opened by a different Discord account. Ask MCPJam in Discord for a fresh one.",
    400
  );
}

function setCookie(c: Context, value: string): void {
  c.header(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; Path=/api/surface-link; Max-Age=${Math.floor(
      TTL_MS / 1000
    )}; HttpOnly; Secure; SameSite=Lax`,
    { append: true }
  );
}

function clearCookie(c: Context): void {
  c.header(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/api/surface-link; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    { append: true }
  );
}

function readCookie(c: Context): string | null {
  const header = c.req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

interface CookiePayload {
  sessionId: string;
  surfaceState: string;
  workosState: string;
  exp: number;
}

function encodeCookie(payload: CookiePayload, secret: string): string {
  return signSlackLinkState(
    { linkSessionId: JSON.stringify(payload), exp: payload.exp },
    secret
  );
}

function decodeCookie(
  value: string | null,
  secret: string
): CookiePayload | null {
  if (!value) return null;
  const verified = verifySlackLinkState(value, secret);
  if (!verified) return null;
  try {
    const payload = JSON.parse(verified.linkSessionId) as CookiePayload;
    return typeof payload?.sessionId === "string" &&
      typeof payload.surfaceState === "string" &&
      typeof payload.workosState === "string" &&
      typeof payload.exp === "number"
      ? payload
      : null;
  } catch {
    return null;
  }
}

async function fetchJson<T>(
  input: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return {
      ok: response.ok,
      status: response.status,
      body: (await response.json()) as T,
    };
  } finally {
    clearTimeout(timer);
  }
}

const surfaceLink = new Hono();

surfaceLink.post("/session", async (c) => {
  const config = resolveConfig();
  if (!config)
    return c.json(
      {
        code: "FEATURE_NOT_SUPPORTED",
        message: "Discord account linking is not configured.",
      },
      501
    );
  const token = tokenFromRequest(c);
  if (!isValidDiscordServiceToken(token))
    return c.json(
      { code: "UNAUTHORIZED", message: "Invalid surface service token" },
      401
    );
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body?.surfaceKind !== "discord")
    return c.json(
      { code: "VALIDATION_ERROR", message: "Only Discord linking is enabled." },
      400
    );
  const tenant =
    typeof body.surfaceTenantId === "string" ? body.surfaceTenantId : "";
  const actor =
    typeof body.surfaceUserId === "string" ? body.surfaceUserId : "";
  if (!tenant || !actor)
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "surfaceTenantId and surfaceUserId are required.",
      },
      400
    );
  const sessionId = randomUUID();
  try {
    await createSurfaceLinkSession(
      {
        sessionId,
        surfaceKind: "discord",
        surfaceTenantId: tenant,
        surfaceUserId: actor,
        expiresAt: Date.now() + TTL_MS,
      },
      token
    );
  } catch (error) {
    logger.error("[surface-link] could not create Discord link session", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        code: "SERVER_UNREACHABLE",
        message: "Could not create a link session.",
      },
      503
    );
  }
  const signed = signSlackLinkState(
    { linkSessionId: sessionId, exp: Date.now() + TTL_MS },
    config.secret
  );
  const url = new URL("/api/surface-link/start", config.publicOrigin);
  url.searchParams.set("s", signed);
  return c.json({ ok: true, url: url.toString(), expiresInMs: TTL_MS });
});

surfaceLink.get("/start", async (c) => {
  const config = resolveConfig();
  if (!config) return failed(c);
  const token = process.env.DISCORD_SERVICE_TOKEN ?? "";
  if (!isValidDiscordServiceToken(token)) return failed(c);
  const signed = verifySlackLinkState(c.req.query("s") ?? "", config.secret);
  if (!signed) return failed(c);
  const session = await getSurfaceLinkSession(
    signed.linkSessionId,
    token
  ).catch(() => null);
  const existingProof = session?.surfaceProof as
    | { stateHash?: unknown }
    | undefined;
  if (
    !session ||
    session.surfaceKind !== "discord" ||
    session.status !== "pending_surface" ||
    session.expiresAt <= Date.now() ||
    typeof existingProof?.stateHash === "string"
  )
    return failed(c);
  const surfaceState = randomToken();
  const workosState = randomToken();
  const transition = await setSurfaceLinkStatus(
    {
      sessionId: session.sessionId,
      status: "pending_surface",
      surfaceProof: { stateHash: hashOauthState(surfaceState) },
      workosStateHash: hashOauthState(workosState),
    },
    token
  ).catch(() => ({ ok: false }));
  if (!transition.ok) return unavailable(c);
  setCookie(
    c,
    encodeCookie(
      {
        sessionId: session.sessionId,
        surfaceState,
        workosState,
        exp: Date.now() + TTL_MS,
      },
      config.secret
    )
  );
  const authorize = new URL(DISCORD_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", config.discordClientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set(
    "redirect_uri",
    callbackUrl(config, "discord/callback")
  );
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", surfaceState);
  return c.redirect(authorize.toString(), 302);
});

surfaceLink.get("/discord/callback", async (c) => {
  const config = resolveConfig();
  if (!config) return failed(c);
  const token = process.env.DISCORD_SERVICE_TOKEN ?? "";
  const cookie = decodeCookie(readCookie(c), config.secret);
  if (!cookie || !isValidDiscordServiceToken(token)) return failed(c);
  const session = await getSurfaceLinkSession(cookie.sessionId, token).catch(
    () => null
  );
  const proof = session?.surfaceProof as { stateHash?: unknown } | undefined;
  if (
    !session ||
    session.status !== "pending_surface" ||
    typeof proof?.stateHash !== "string" ||
    !oauthStateMatches(c.req.query("state") ?? "", proof.stateHash)
  ) {
    await setSurfaceLinkStatus(
      { sessionId: cookie.sessionId, status: "failed" },
      token
    ).catch(() => {});
    return failed(c);
  }
  const code = c.req.query("code");
  if (!code) return failed(c);
  let accessToken = "";
  try {
    const result = await fetchJson<{ access_token?: string }>(
      DISCORD_TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl(config, "discord/callback"),
        }),
      }
    );
    if (!result.ok || typeof result.body?.access_token !== "string")
      throw new Error(`Discord token exchange failed (${result.status})`);
    accessToken = result.body.access_token;
    const user = await fetchJson<{ id?: string }>(
      `${DISCORD_API_URL}/users/@me`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!user.ok || user.body?.id !== session.surfaceUserId)
      throw new Error("Discord identity mismatch");
    const member = await fetch(
      `${DISCORD_API_URL}/guilds/${encodeURIComponent(
        session.surfaceTenantId
      )}/members/${encodeURIComponent(session.surfaceUserId)}`,
      { headers: { Authorization: `Bot ${config.discordBotToken}` } }
    );
    if (!member.ok) throw new Error("Discord guild membership mismatch");
  } catch (error) {
    logger.warn("[surface-link] Discord identity proof failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await setSurfaceLinkStatus(
      { sessionId: cookie.sessionId, status: "failed" },
      token
    ).catch(() => {});
    return failed(c);
  }
  const transition = await setSurfaceLinkStatus(
    {
      sessionId: cookie.sessionId,
      status: "surface_verified",
      surfaceProof: {
        discordUserId: session.surfaceUserId,
        guildId: session.surfaceTenantId,
      },
    },
    token
  ).catch(() => ({ ok: false }));
  if (!transition.ok) return unavailable(c);
  const authorize = new URL(`${config.workosIssuer}/oauth2/authorize`);
  authorize.searchParams.set("client_id", config.workosClientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set(
    "redirect_uri",
    callbackUrl(config, "workos/callback")
  );
  authorize.searchParams.set("state", cookie.workosState);
  authorize.searchParams.set("scope", "openid profile email");
  return c.redirect(authorize.toString(), 302);
});

surfaceLink.get("/workos/callback", async (c) => {
  const config = resolveConfig();
  if (!config) return failed(c);
  const token = process.env.DISCORD_SERVICE_TOKEN ?? "";
  const cookie = decodeCookie(readCookie(c), config.secret);
  if (!cookie || !isValidDiscordServiceToken(token)) return failed(c);
  const session = await getSurfaceLinkSession(cookie.sessionId, token).catch(
    () => null
  );
  if (
    !session ||
    session.status !== "surface_verified" ||
    session.expiresAt <= Date.now() ||
    !oauthStateMatches(
      c.req.query("state") ?? "",
      session.workosStateHash ?? ""
    )
  )
    return failed(c);
  const code = c.req.query("code");
  if (!code) return failed(c);
  let workosUserId = "";
  let workosOrgId: string | undefined;
  try {
    const result = await fetchJson<{ access_token?: string }>(
      `${config.workosIssuer}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.workosClientId,
          client_secret: config.workosClientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl(config, "workos/callback"),
        }),
      }
    );
    if (!result.ok || typeof result.body?.access_token !== "string")
      throw new Error(`WorkOS token exchange failed (${result.status})`);
    const claims = decodeJwtClaims(result.body.access_token);
    workosUserId = typeof claims?.sub === "string" ? claims.sub : "";
    workosOrgId =
      typeof claims?.org_id === "string" ? claims.org_id : undefined;
    if (!workosUserId) throw new Error("WorkOS token carried no subject");
  } catch (error) {
    logger.warn("[surface-link] WorkOS token exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await setSurfaceLinkStatus(
      { sessionId: cookie.sessionId, status: "failed" },
      token
    ).catch(() => {});
    return failed(c);
  }
  const advanced = await setSurfaceLinkStatus(
    { sessionId: cookie.sessionId, status: "workos_verified" },
    token
  ).catch(() => ({ ok: false }));
  if (!advanced.ok) return unavailable(c);
  let user;
  try {
    user = await resolveUserByExternalId(workosUserId);
  } catch (error) {
    logger.error("[surface-link] identity lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailable(c);
  }
  if (!user) {
    await setSurfaceLinkStatus(
      { sessionId: cookie.sessionId, status: "failed" },
      token
    ).catch(() => {});
    return page(
      c,
      "No MCPJam account yet",
      "Sign in to MCPJam once at app.mcpjam.com, then use the connect link again.",
      400
    );
  }
  if (!workosOrgId) {
    await setSurfaceLinkStatus(
      { sessionId: cookie.sessionId, status: "failed" },
      token
    ).catch(() => {});
    return page(
      c,
      "Couldn’t tell which organization to use",
      "Open MCPJam, choose the organization you want Discord to use, then use the connect link again.",
      400
    );
  }
  let organization;
  try {
    organization = await resolveOrganizationByWorkosId(workosOrgId);
  } catch (error) {
    logger.error("[surface-link] organization lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailable(c);
  }
  if (!organization) {
    await setSurfaceLinkStatus(
      { sessionId: cookie.sessionId, status: "failed" },
      token
    ).catch(() => {});
    return page(
      c,
      "Couldn’t tell which organization to use",
      "Open MCPJam, choose the organization you want Discord to use, then use the connect link again.",
      400
    );
  }
  const consumed = await consumeSurfaceLinkSession(
    {
      sessionId: cookie.sessionId,
      userId: user._id,
      workosUserId,
      organizationId: organization.organizationId,
    },
    token
  ).catch(() => ({ ok: false }));
  if (!consumed.ok) return unavailable(c);
  clearCookie(c);
  return page(
    c,
    "Discord is connected",
    "MCPJam will now act as you when you mention it in this Discord server. You can manage the organization connection from MCPJam settings."
  );
});

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default surfaceLink;
