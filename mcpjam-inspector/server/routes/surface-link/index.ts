import {
  createHmac,
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Hono } from "hono";
import { isValidDiscordServiceToken } from "../../middleware/slack-service-auth.js";
import {
  consumeSurfaceLinkSession,
  createSurfaceLinkSession,
  getSurfaceLinkSession,
  markSurfaceLinkLeg,
  resolveOrganizationByWorkosId,
} from "../../services/slack-backend.js";
import {
  resolveAuthkitIssuer,
  resolveWorkosClientId,
} from "../../services/authkit-jwt.js";
import { resolveUserByExternalId } from "../../services/identity.js";

const WORKOS_SCOPE = "openid profile email";
const LINK_TTL_MS = 10 * 60_000;

function config() {
  const secret =
    process.env.SURFACE_LINK_STATE_SECRET ??
    process.env.SLACK_LINK_STATE_SECRET;
  const origin =
    process.env.SURFACE_LINK_PUBLIC_ORIGIN ??
    process.env.SLACK_LINK_PUBLIC_ORIGIN ??
    process.env.MCPJAM_APP_URL;
  const workosClientId = process.env.SLACK_LINK_WORKOS_CLIENT_ID;
  const workosClientSecret = process.env.SLACK_LINK_WORKOS_CLIENT_SECRET;
  const discordClientId =
    process.env.DISCORD_CLIENT_ID ?? process.env.DISCORD_APPLICATION_ID;
  const discordClientSecret = process.env.DISCORD_CLIENT_SECRET;
  const environmentClientId = resolveWorkosClientId(process.env);
  if (
    !secret ||
    !origin ||
    !workosClientId ||
    !workosClientSecret ||
    !environmentClientId ||
    !discordClientId ||
    !discordClientSecret
  )
    return null;
  let publicOrigin: string;
  try {
    publicOrigin = new URL(origin).origin;
  } catch {
    return null;
  }
  return {
    secret,
    publicOrigin,
    workosClientId,
    workosClientSecret,
    discordClientId,
    discordClientSecret,
    workosIssuer: resolveAuthkitIssuer(environmentClientId, process.env),
  };
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(value: string, secret: string): string {
  const encoded = b64(value);
  const mac = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

function verify(value: string, secret: string): string | null {
  const [encoded, mac] = value.split(".");
  if (!encoded || !mac) return null;
  const expected = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
    if (!payload || typeof payload !== "object" || payload.exp <= Date.now())
      return null;
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function stateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function page(title: string, body: string, status = 200): Response {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(
      title
    )} · MCPJam</title></head><body><main><h1>${escape(title)}</h1><p>${escape(
      body
    )}</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const surfaceLink = new Hono();

surfaceLink.post("/session", async (c) => {
  const current = config();
  if (!current?.workosIssuer || !current.discordClientId)
    return c.json(
      {
        code: "FEATURE_NOT_SUPPORTED",
        message: "Surface account linking is not configured.",
      },
      501
    );
  const bearer =
    /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  if (!isValidDiscordServiceToken(bearer))
    return c.json(
      { code: "UNAUTHORIZED", message: "Discord service token required" },
      401
    );
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const tenant =
    typeof body.surfaceTenantId === "string" ? body.surfaceTenantId : "";
  const user = typeof body.surfaceUserId === "string" ? body.surfaceUserId : "";
  if (!tenant || !user)
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "surfaceTenantId and surfaceUserId are required",
      },
      400
    );
  const sessionId = randomUUID();
  const expiresAt = Date.now() + LINK_TTL_MS;
  const payload = JSON.stringify({
    sessionId,
    surfaceTenantId: tenant,
    surfaceUserId: user,
    exp: expiresAt,
  });
  const signed = sign(payload, current.secret);
  const workosState = sign(
    JSON.stringify({ sessionId, purpose: "workos", exp: expiresAt }),
    current.secret,
  );
  try {
    await createSurfaceLinkSession({
      sessionId,
      surfaceKind: "discord",
      surfaceTenantId: tenant,
      surfaceUserId: user,
      surfaceProof: { kind: "discord_service_token", issuedAt: Date.now() },
      workosStateHash: stateHash(workosState),
      expiresAt,
    });
  } catch {
    return c.json(
      {
        code: "SERVER_UNREACHABLE",
        message: "Could not create a connect session.",
      },
      503
    );
  }
  return c.json({
    ok: true,
    url: `${current.publicOrigin}/api/surface-link/start?s=${encodeURIComponent(
      signed
    )}`,
    expiresInMs: LINK_TTL_MS,
  });
});

surfaceLink.get("/start", async (c) => {
  const current = config();
  if (!current?.workosIssuer || !current.discordClientId)
    return page(
      "MCPJam linking is unavailable",
      "This deployment has not configured account linking.",
      501
    );
  const signed = c.req.query("s") ?? "";
  const raw = verify(signed, current.secret);
  if (!raw)
    return page(
      "That link has expired",
      "Ask MCPJam in Discord for a fresh connect link.",
      400
    );
  const payload = JSON.parse(raw) as { sessionId: string };
  const session = await getSurfaceLinkSession(payload.sessionId).catch(
    () => null
  );
  if (!session || session.expired || session.status !== "pending_surface")
    return page(
      "That link has expired",
      "Ask MCPJam in Discord for a fresh connect link.",
      400
    );
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", current.discordClientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set(
    "redirect_uri",
    `${current.publicOrigin}/api/surface-link/discord/callback`
  );
  authorize.searchParams.set("state", signed);
  authorize.searchParams.set("scope", "identify guilds");
  return c.redirect(authorize.toString(), 302);
});

surfaceLink.get("/discord/callback", async (c) => {
  const current = config();
  if (!current?.discordClientId || !current.discordClientSecret)
    return page(
      "MCPJam linking is unavailable",
      "This deployment has not configured Discord OAuth.",
      501
    );
  const signed = c.req.query("state") ?? "";
  const raw = verify(signed, current.secret);
  if (!raw)
    return page(
      "That link did not work",
      "Ask MCPJam in Discord for a fresh connect link.",
      400
    );
  const payload = JSON.parse(raw) as {
    sessionId: string;
    surfaceTenantId: string;
    surfaceUserId: string;
    exp: number;
  };
  const session = await getSurfaceLinkSession(payload.sessionId).catch(
    () => null
  );
  if (!session || session.expired || session.status !== "pending_surface")
    return page(
      "That link did not work",
      "Ask MCPJam in Discord for a fresh connect link.",
      400
    );
  const code = c.req.query("code");
  if (!code)
    return page(
      "That link did not work",
      "Discord did not return an authorization code.",
      400
    );
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: current.discordClientId,
        client_secret: current.discordClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${current.publicOrigin}/api/surface-link/discord/callback`,
      }),
    });
    const tokenBody = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenResponse.ok || !tokenBody.access_token)
      throw new Error("Discord token exchange failed");
    const identityResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    const identity = (await identityResponse.json()) as { id?: string };
    const guildsResponse = await fetch(
      "https://discord.com/api/users/@me/guilds",
      {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      }
    );
    const guilds = (await guildsResponse.json()) as Array<{ id?: string }>;
    if (
      !identityResponse.ok ||
      identity.id !== payload.surfaceUserId ||
      !guilds.some((guild) => guild.id === payload.surfaceTenantId)
    )
      throw new Error("Discord identity did not match the connect session");
  } catch {
    return page(
      "That link did not work",
      "This Discord account does not match the person who requested the link.",
      400
    );
  }
  const advanced = await markSurfaceLinkLeg(payload.sessionId, "surface").catch(
    () => ({ ok: false })
  );
  if (!advanced.ok)
    return page(
      "Could not finish connecting",
      "Try the same Discord connect link again in a moment.",
      503
    );
  const authorize = new URL(`${current.workosIssuer}/oauth2/authorize`);
  authorize.searchParams.set("client_id", current.workosClientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set(
    "redirect_uri",
    `${current.publicOrigin}/api/surface-link/workos/callback`
  );
  const workosState = sign(
    JSON.stringify({
      sessionId: payload.sessionId,
      purpose: "workos",
      exp: payload.exp,
    }),
    current.secret,
  );
  authorize.searchParams.set("state", workosState);
  authorize.searchParams.set("scope", WORKOS_SCOPE);
  return c.redirect(authorize.toString(), 302);
});

surfaceLink.get("/workos/callback", async (c) => {
  const current = config();
  if (!current?.workosIssuer)
    return page(
      "MCPJam linking is unavailable",
      "This deployment has not configured account linking.",
      501
    );
  const signed = c.req.query("state") ?? "";
  const raw = verify(signed, current.secret);
  if (!raw)
    return page(
      "That link did not work",
      "Ask MCPJam in Discord for a fresh connect link.",
      400
    );
  const workosPayload = JSON.parse(raw) as {
    sessionId: string;
    purpose?: string;
  };
  if (workosPayload.purpose !== "workos")
    return page(
      "That link did not work",
      "Ask MCPJam in Discord for a fresh connect link.",
      400,
    );
  const { sessionId } = workosPayload;
  const session = await getSurfaceLinkSession(sessionId).catch(() => null);
  if (
    !session ||
    session.expired ||
    session.status !== "surface_verified" ||
    session.workosStateHash !== stateHash(signed)
  )
    return page(
      "That link did not work",
      "Ask MCPJam in Discord for a fresh connect link.",
      400
    );
  const code = c.req.query("code");
  if (!code)
    return page(
      "That link did not work",
      "The sign-in provider did not return an authorization code.",
      400
    );
  let workosUserId = "";
  let workosOrgId = "";
  try {
    const response = await fetch(`${current.workosIssuer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: current.workosClientId,
        client_secret: current.workosClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${current.publicOrigin}/api/surface-link/workos/callback`,
      }),
    });
    const body = (await response.json()) as { access_token?: string };
    const claims = body.access_token
      ? decodeJwtClaims(body.access_token)
      : null;
    workosUserId = typeof claims?.sub === "string" ? claims.sub : "";
    workosOrgId = typeof claims?.org_id === "string" ? claims.org_id : "";
    if (!response.ok || !workosUserId || !workosOrgId)
      throw new Error("invalid WorkOS response");
  } catch {
    return page(
      "Could not finish connecting",
      "Try the same Discord connect link again in a moment.",
      503
    );
  }
  const advanced = await markSurfaceLinkLeg(sessionId, "workos").catch(() => ({
    ok: false,
  }));
  if (!advanced.ok)
    return page(
      "Could not finish connecting",
      "Try the same Discord connect link again in a moment.",
      503
    );
  const user = await resolveUserByExternalId(workosUserId).catch(() => null);
  const organization = await resolveOrganizationByWorkosId(workosOrgId).catch(
    () => null
  );
  if (!user || !organization)
    return page(
      "No MCPJam organization found",
      "Open MCPJam once, choose an organization, and start a fresh connect flow.",
      400
    );
  const result = await consumeSurfaceLinkSession({
    sessionId,
    userId: user._id,
    workosUserId,
    organizationId: organization.organizationId,
  }).catch(() => ({ ok: false }));
  if (!result.ok)
    return page(
      "Could not finish connecting",
      "Try the same Discord connect link again in a moment.",
      503
    );
  return page(
    "Discord is connected",
    "MCPJam will now act as you when you mention it in this Discord guild."
  );
});

export default surfaceLink;
