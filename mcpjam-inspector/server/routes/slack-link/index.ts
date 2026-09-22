/**
 * Slack account-link bridge (`/api/slack/link/*`).
 *
 * Connects a Slack identity to an MCPJam account, with TWO identity proofs.
 *
 * WHY TWO. The link URL is posted into a Slack conversation, where everyone
 * present can read and click it. If the flow proved only the MCPJam side, a
 * bystander could open someone else's link while signed into MCPJam as
 * themselves and bind THAT person's Slack identity to their own account —
 * every eval the victim later authored from Slack would land in the
 * attacker's organization, silently. So possession of the URL authorizes
 * nothing on its own:
 *
 *   1. Sign in with Slack (OIDC) must show the clicker IS the Slack user the
 *      session was minted for — `team_id` AND `user_id` compared exactly.
 *   2. Only then does AuthKit identify the MCPJam account.
 *
 * The ORDER is enforced by the session's status in Convex, not by trusting
 * that the redirects happened in sequence: the WorkOS leg refuses any session
 * that is not `slack_verified`.
 *
 * STATE HANDLING. Three distinct values, deliberately not interchangeable:
 *   - the HMAC-signed envelope in the bot's URL (integrity only — it is
 *     public by construction, which is the whole reason for the proofs);
 *   - the Slack-leg OAuth `state`, and the WorkOS-leg OAuth `state`, which
 *     ARE secrets. Only their SHA-256 hashes are persisted, so a database
 *     read cannot forge a callback, and they differ per leg so a state
 *     observed on the first cannot be replayed into the second.
 *   - the OIDC `nonce`, bound into Slack's id_token. Slack distinguishes it
 *     from `state` and so do we.
 *
 * The WorkOS-leg state travels between legs in an HttpOnly, SameSite=Lax
 * cookie rather than a URL. That keeps it out of Slack entirely and, as a
 * bonus, binds the second leg to the same browser that started the first.
 *
 * Sign in with Slack is a COMPLETELY SEPARATE OAuth flow from the bot's
 * install. Slack rejects an authorize request that mixes SIWS user scopes
 * with bot scopes, so this module builds its own authorize URL and never
 * touches Bolt's.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  resolveAuthkitIssuer,
  resolveWorkosClientId,
} from "../../services/authkit-jwt.js";
import { isValidSlackServiceToken } from "../../middleware/slack-service-auth.js";
import { resolveUserByExternalId } from "../../services/identity.js";
import { getConvexBearerForDelegation } from "../../utils/v1-convex-token.js";
import {
  consumeSlackLinkSession,
  createSlackLinkSession,
  failSlackLinkSession,
  getSlackLinkSession,
  markSlackLegVerified,
  markWorkosLegVerified,
  resolveOrganizationByWorkosId,
  setSlackDefaultProject,
  SlackBackendUnavailable,
} from "../../services/slack-backend.js";
import { logger } from "../../utils/logger.js";
import {
  hashOauthState,
  oauthStateMatches,
  randomToken,
  signSlackLinkState,
  SLACK_LINK_STATE_TTL_MS,
  verifySlackLinkState,
} from "./state.js";

/** Slack's OIDC endpoints. Fixed — these are not per-workspace. */
const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";
const SLACK_JWKS_URL = "https://slack.com/openid/connect/keys";
/**
 * `openid` alone yields a token with no `team_id`. The whole first proof is
 * "this is the same Slack user in the same workspace", so `profile` is
 * MANDATORY here, not cosmetic.
 */
const SLACK_OIDC_SCOPE = "openid profile";

const WORKOS_SCOPE = "openid profile email";

/** Carries the WorkOS-leg state between legs. */
const LINK_COOKIE_NAME = "mcpjam_slack_link";
const COOKIE_TTL_SECONDS = Math.floor(SLACK_LINK_STATE_TTL_MS / 1000);

const slackJwks = createRemoteJWKSet(new URL(SLACK_JWKS_URL));

interface SlackLinkConfig {
  secret: string;
  publicOrigin: string;
  slackClientId: string;
  slackClientSecret: string;
  workosIssuer: string;
  workosClientId: string;
  workosClientSecret: string;
}

function resolveConfig(
  env: NodeJS.ProcessEnv = process.env
): SlackLinkConfig | null {
  const secret = env.SLACK_LINK_STATE_SECRET;
  const rawOrigin = env.SLACK_LINK_PUBLIC_ORIGIN ?? env.CLI_AUTH_PUBLIC_ORIGIN;
  const slackClientId = env.SLACK_CLIENT_ID;
  const slackClientSecret = env.SLACK_CLIENT_SECRET;
  // The `/oauth2/*` surface on the AuthKit domain serves WorkOS OAUTH
  // APPLICATIONS — a separate registry from the environment's user-management
  // client, whose id it rejects with `application_not_found`. So the bridge
  // authenticates as a dedicated confidential OAuth application (its own
  // id + secret, registered with this module's callback as redirect URI).
  // The environment client id keeps ONE job below: deriving the AuthKit
  // ISSUER, which is a property of the environment, not of any one app.
  const workosClientId = env.SLACK_LINK_WORKOS_CLIENT_ID;
  const workosClientSecret = env.SLACK_LINK_WORKOS_CLIENT_SECRET;
  if (
    !secret ||
    !rawOrigin ||
    !slackClientId ||
    !slackClientSecret ||
    !workosClientId ||
    !workosClientSecret
  ) {
    return null;
  }

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
    slackClientId,
    slackClientSecret,
    workosIssuer,
    workosClientId,
    workosClientSecret,
  };
}

function slackRedirectUri(config: SlackLinkConfig): string {
  return `${config.publicOrigin}/api/slack/link/slack/callback`;
}

function workosRedirectUri(config: SlackLinkConfig): string {
  return `${config.publicOrigin}/api/slack/link/workos/callback`;
}

function notEnabled(c: Context): Response {
  return c.json(
    {
      code: "FEATURE_NOT_SUPPORTED",
      message:
        "Slack account linking is not enabled on this deployment (SLACK_LINK_STATE_SECRET, SLACK_LINK_PUBLIC_ORIGIN and the Slack/WorkOS client credentials must be configured).",
    },
    501
  );
}

/**
 * User-facing terminal page.
 *
 * Failure copy is deliberately generic and identical across causes. Telling a
 * clicker WHICH check failed ("that link belongs to someone else" vs "expired")
 * confirms whether a captured URL is live and whose it is — the details go to
 * the log, not the page.
 */
function page(
  c: Context,
  opts: {
    title: string;
    body: string;
    status?: 200 | 400 | 503;
    extraHtml?: string;
  }
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)} · MCPJam</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         padding: 2rem; background: Canvas; color: CanvasText; }
  main { max-width: 32rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; }
  .muted { opacity: .7; font-size: .9rem; }
  button, select { font: inherit; padding: .5rem .75rem; border-radius: .5rem;
                   border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
  button { cursor: pointer; }
</style></head>
<body><main>
<h1>${escapeHtml(opts.title)}</h1>
<p>${escapeHtml(opts.body)}</p>
${opts.extraHtml ?? ""}
</main></body></html>`;
  return c.html(html, opts.status ?? 200);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Retryable failure. Distinct from `linkFailed` on purpose: a verification
 * failure is final and the URL is burned, whereas this leaves the session
 * intact and the SAME link works on a retry.
 */
function unavailable(c: Context): Response {
  return page(c, {
    title: "MCPJam is having a moment",
    // Says which link, because the obvious move — reloading this page — retries
    // an OAuth code the provider has already spent, and lands the user on the
    // generic failure page for a reason that has nothing to do with them.
    body: "Your identity checked out, but we couldn’t finish just now. Open the Connect link from Slack again in a minute — the connection is not linked yet.",
    status: 503,
  });
}

/** One generic failure page for every verification failure. */
function linkFailed(c: Context): Response {
  return page(c, {
    title: "That link didn’t work",
    body: "This connection link is invalid, has expired, or was opened by a different account. Ask MCPJam in Slack for a fresh one.",
    status: 400,
  });
}

// ── Cookie helpers ─────────────────────────────────────────────────────

function setLinkCookie(c: Context, value: string): void {
  // HttpOnly: nothing client-side needs to read it, and the WorkOS-leg state
  // inside is a secret. SameSite=Lax so it survives the top-level redirect
  // back from Slack/AuthKit (Strict would drop it and break the flow).
  c.header(
    "Set-Cookie",
    `${LINK_COOKIE_NAME}=${value}; Path=/api/slack/link; Max-Age=${COOKIE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    { append: true }
  );
}

function clearLinkCookie(c: Context): void {
  c.header(
    "Set-Cookie",
    `${LINK_COOKIE_NAME}=; Path=/api/slack/link; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    { append: true }
  );
}

function readLinkCookie(c: Context): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LINK_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

interface LinkCookiePayload {
  linkSessionId: string;
  workosState: string;
  exp: number;
}

function encodeCookiePayload(
  payload: LinkCookiePayload,
  secret: string
): string {
  return signSlackLinkState(
    { linkSessionId: JSON.stringify(payload), exp: payload.exp },
    secret
  );
}

function decodeCookiePayload(
  cookie: string,
  secret: string
): LinkCookiePayload | null {
  const verified = verifySlackLinkState(cookie, secret);
  if (!verified) return null;
  try {
    const parsed = JSON.parse(verified.linkSessionId) as LinkCookiePayload;
    if (
      typeof parsed?.linkSessionId !== "string" ||
      typeof parsed?.workosState !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Deadline for a provider token exchange. */
const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * POST to a provider and read its JSON under one deadline.
 *
 * Slack and WorkOS are third parties on a path a user is actively waiting on,
 * and `fetch` settles when the HEADERS arrive — a provider that answers and
 * then stalls its body would hold `/slack/callback` open indefinitely. The
 * timer therefore spans the body read too, matching `slack-backend.ts`'s
 * `post` helper.
 *
 * A timeout, a transport error, and a non-JSON body all THROW, which is what
 * both callers want: each is wrapped in a try/catch that fails the link
 * session and shows the user a retry, rather than proceeding on a half-read
 * response.
 *
 * @param input request URL
 * @param init fetch options; a `signal` here is ignored in favour of the deadline
 */
async function fetchJsonWithDeadline<T>(
  input: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = (await response.json()) as T;
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ── Routes ─────────────────────────────────────────────────────────────

const slackLink = new Hono();

/**
 * The bot asks for a connect URL. Authenticated with the bot's OWN `slk_`
 * credential (hash-verified, same as the /api/v1 surface) — NOT the
 * inspector's environment-root service token. Minting a connect URL is
 * squarely Slack-bot business, and keeping the root token out of the bot's
 * environment is the blast-radius boundary: that token also opens arbitrary
 * user delegation, which a compromised bot must never reach. The response is
 * a URL that starts an identity flow for a NAMED Slack user, so it must not
 * be mintable by a browser.
 */
slackLink.post("/session", async (c) => {
  const config = resolveConfig();
  if (!config) return notEnabled(c);

  const authorization = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(authorization)?.[1] ?? "";
  if (!isValidSlackServiceToken(bearer)) {
    return c.json(
      { code: "UNAUTHORIZED", message: "Service token required" },
      401
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    teamId?: unknown;
    slackUserId?: unknown;
  };
  const teamId = typeof body.teamId === "string" ? body.teamId : "";
  const slackUserId =
    typeof body.slackUserId === "string" ? body.slackUserId : "";
  if (!teamId || !slackUserId) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "teamId and slackUserId are required",
      },
      400
    );
  }

  // The URL only carries the SIGNED envelope. The session itself is created
  // at /start, when the user actually clicks — so a link that is posted and
  // never opened leaves no state to sweep, and the 10-minute clock starts
  // from the click rather than from the post.
  const signed = signSlackLinkState(
    {
      linkSessionId: JSON.stringify({ teamId, slackUserId }),
      exp: Date.now() + SLACK_LINK_STATE_TTL_MS,
    },
    config.secret
  );
  return c.json({
    ok: true,
    url: `${config.publicOrigin}/api/slack/link/start?s=${encodeURIComponent(
      signed
    )}`,
    expiresInMs: SLACK_LINK_STATE_TTL_MS,
  });
});

/** Leg 1 begins: mint the session and redirect to Sign in with Slack. */
slackLink.get("/start", async (c) => {
  const config = resolveConfig();
  if (!config) return notEnabled(c);

  const verified = verifySlackLinkState(c.req.query("s") ?? "", config.secret);
  if (!verified) return linkFailed(c);

  let target: { teamId: string; slackUserId: string };
  try {
    target = JSON.parse(verified.linkSessionId);
    if (!target?.teamId || !target?.slackUserId) return linkFailed(c);
  } catch {
    return linkFailed(c);
  }

  const linkSessionId = randomToken();
  const oidcNonce = randomToken();
  const slackState = randomToken();
  const workosState = randomToken();

  try {
    // Through the shared client: it resolves config properly (an unset
    // CONVEX_HTTP_URL would otherwise POST to `undefined/...`) and enforces a
    // timeout. `/start` is reachable by anyone who can read the link URL, so
    // an un-deadlined call here is a request anyone can hold open.
    await createSlackLinkSession({
      linkSessionId,
      teamId: target.teamId,
      slackUserId: target.slackUserId,
      oidcNonce,
      slackStateHash: hashOauthState(slackState),
      workosStateHash: hashOauthState(workosState),
    });
  } catch (error) {
    logger.error("[slack-link] could not create a link session", {
      error: error instanceof Error ? error.message : String(error),
    });
    // 503, not 400. Nothing about the request was wrong — our backend was
    // unreachable — and monitoring that keys off status codes should see an
    // outage rather than a stream of bad client requests.
    return unavailable(c);
  }

  // The WorkOS-leg state rides in the cookie, never in a URL that touches
  // Slack — and it binds leg 2 to the browser that ran leg 1.
  setLinkCookie(
    c,
    encodeCookiePayload(
      { linkSessionId, workosState, exp: Date.now() + SLACK_LINK_STATE_TTL_MS },
      config.secret
    )
  );

  const authorize = new URL(SLACK_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", config.slackClientId);
  authorize.searchParams.set("scope", SLACK_OIDC_SCOPE);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", slackRedirectUri(config));
  authorize.searchParams.set("state", slackState);
  authorize.searchParams.set("nonce", oidcNonce);
  // Pin the workspace so the user is not silently signed in from a different
  // Slack team — the identity check would reject that anyway, but failing
  // AFTER an unnecessary sign-in is a bad experience.
  authorize.searchParams.set("team", target.teamId);

  return c.redirect(authorize.toString(), 302);
});

/** Leg 1 completes: verify the Slack identity, then start leg 2. */
slackLink.get("/slack/callback", async (c) => {
  const config = resolveConfig();
  if (!config) return notEnabled(c);

  const cookie = readLinkCookie(c);
  const payload = cookie ? decodeCookiePayload(cookie, config.secret) : null;
  if (!payload) return linkFailed(c);

  const session = await getSlackLinkSession(payload.linkSessionId).catch(
    () => null
  );
  if (!session || session.expired || session.status !== "pending_slack") {
    return linkFailed(c);
  }

  const presentedState = c.req.query("state") ?? "";
  if (!oauthStateMatches(presentedState, session.slackStateHash)) {
    await failSlackLinkSession(
      payload.linkSessionId,
      "slack_state_mismatch"
    ).catch(() => {});
    return linkFailed(c);
  }

  const code = c.req.query("code");
  if (!code) {
    await failSlackLinkSession(payload.linkSessionId, "slack_no_code").catch(
      () => {}
    );
    return linkFailed(c);
  }

  // Confidential-client exchange: the code alone is useless without our
  // client secret, so a leaked code cannot complete anyone's link.
  let idToken: string;
  try {
    const { body: tokenBody } = await fetchJsonWithDeadline<{
      ok?: boolean;
      id_token?: string;
    }>(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.slackClientId,
        client_secret: config.slackClientSecret,
        code,
        redirect_uri: slackRedirectUri(config),
        grant_type: "authorization_code",
      }),
    });
    // Slack signals failure in the BODY (`ok: false`) with a 200, so the
    // HTTP status is not the check that matters here.
    if (!tokenBody?.ok || typeof tokenBody.id_token !== "string") {
      throw new Error("Slack token exchange returned no id_token");
    }
    idToken = tokenBody.id_token;
  } catch (error) {
    logger.warn("[slack-link] Slack token exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await failSlackLinkSession(
      payload.linkSessionId,
      "slack_token_exchange"
    ).catch(() => {});
    return linkFailed(c);
  }

  // Signature, issuer, audience AND nonce. `audience` pins the token to OUR
  // Slack app — without it, an id_token minted for a different app would
  // verify. `nonce` is what makes a captured id_token unreplayable into a
  // second session.
  let claims: Record<string, unknown>;
  try {
    const { payload: verified } = await jwtVerify(idToken, slackJwks, {
      issuer: "https://slack.com",
      audience: config.slackClientId,
    });
    claims = verified as Record<string, unknown>;
    if (claims.nonce !== session.oidcNonce) {
      throw new Error("nonce mismatch");
    }
  } catch (error) {
    logger.warn("[slack-link] Slack id_token verification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await failSlackLinkSession(
      payload.linkSessionId,
      "slack_idtoken_invalid"
    ).catch(() => {});
    return linkFailed(c);
  }

  // THE identity check. `team_id` matters as much as `user_id`: Slack user
  // ids are unique only within a workspace, so a matching id from another
  // team is a different person.
  const verifiedTeamId =
    typeof claims["https://slack.com/team_id"] === "string"
      ? (claims["https://slack.com/team_id"] as string)
      : "";
  const verifiedUserId =
    typeof claims["https://slack.com/user_id"] === "string"
      ? (claims["https://slack.com/user_id"] as string)
      : typeof claims.sub === "string"
      ? claims.sub
      : "";

  const transition = await markSlackLegVerified({
    linkSessionId: payload.linkSessionId,
    verifiedTeamId,
    verifiedSlackUserId: verifiedUserId,
  }).catch(() => ({ ok: false, reason: "backend_unavailable" }));

  if (!transition.ok) {
    logger.warn("[slack-link] Slack identity proof refused", {
      reason: transition.reason,
      // Never log the ids themselves: a refused link is a security event, and
      // the log should not become the place where the two identities meet.
    });
    // `linkFailed` BURNS the session — correct for a refused identity proof,
    // wrong for a backend blip. The user's proof was fine; we could not record
    // it. Burning here would make them ask Slack for a whole new link over a
    // transient outage.
    return transition.reason === "backend_unavailable"
      ? unavailable(c)
      : linkFailed(c);
  }

  const authorize = new URL(`${config.workosIssuer}/oauth2/authorize`);
  authorize.searchParams.set("client_id", config.workosClientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", workosRedirectUri(config));
  authorize.searchParams.set("state", payload.workosState);
  authorize.searchParams.set("scope", WORKOS_SCOPE);
  return c.redirect(authorize.toString(), 302);
});

/** Leg 2 completes: identify the MCPJam account and finish the link. */
slackLink.get("/workos/callback", async (c) => {
  const config = resolveConfig();
  if (!config) return notEnabled(c);

  const cookie = readLinkCookie(c);
  const payload = cookie ? decodeCookiePayload(cookie, config.secret) : null;
  if (!payload) return linkFailed(c);

  const session = await getSlackLinkSession(payload.linkSessionId).catch(
    () => null
  );
  // The ordering proof. A WorkOS callback that arrives without a completed
  // Slack leg — hand-crafted, replayed, or simply out of order — stops here.
  if (!session || session.expired || session.status !== "slack_verified") {
    return linkFailed(c);
  }

  if (!oauthStateMatches(c.req.query("state") ?? "", session.workosStateHash)) {
    await failSlackLinkSession(
      payload.linkSessionId,
      "workos_state_mismatch"
    ).catch(() => {});
    return linkFailed(c);
  }

  const code = c.req.query("code");
  if (!code) {
    await failSlackLinkSession(payload.linkSessionId, "workos_no_code").catch(
      () => {}
    );
    return linkFailed(c);
  }

  const advanced = await markWorkosLegVerified(payload.linkSessionId).catch(
    () => ({ ok: false, reason: "backend_unavailable" })
  );
  // Same distinction as the Slack leg: a transient outage must not burn a
  // session whose proofs were sound.
  if (!advanced.ok) {
    return advanced.reason === "backend_unavailable"
      ? unavailable(c)
      : linkFailed(c);
  }

  let workosUserId: string;
  let workosOrgId: string | undefined;
  try {
    const {
      ok,
      status,
      body: tokenBody,
    } = await fetchJsonWithDeadline<{
      access_token?: string;
      user?: { id?: string };
      organization_id?: string;
    }>(`${config.workosIssuer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.workosClientId,
        client_secret: config.workosClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: workosRedirectUri(config),
      }),
    });
    if (!ok || !tokenBody?.access_token) {
      throw new Error(`WorkOS token exchange failed (${status})`);
    }
    // The access token is an AuthKit JWT; `sub` is the WorkOS user id and
    // `org_id` names the organization the user authenticated into.
    const claims = decodeJwtClaims(tokenBody.access_token);
    workosUserId =
      (typeof claims?.sub === "string" ? claims.sub : undefined) ??
      tokenBody.user?.id ??
      "";
    workosOrgId =
      (typeof claims?.org_id === "string" ? claims.org_id : undefined) ??
      tokenBody.organization_id;
    if (!workosUserId) throw new Error("WorkOS token carried no subject");
  } catch (error) {
    logger.warn("[slack-link] WorkOS token exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await failSlackLinkSession(
      payload.linkSessionId,
      "workos_token_exchange"
    ).catch(() => {});
    return linkFailed(c);
  }

  // A LOOKUP FAILURE is not "no account". Failing the session on a blip would
  // make a valid user redo the entire two-leg OAuth flow, so the outage path
  // leaves the session intact and asks them to retry the same link.
  let mcpjamUser;
  try {
    mcpjamUser = await resolveUserByExternalId(workosUserId);
  } catch (error) {
    logger.error("[slack-link] identity lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailable(c);
  }
  if (!mcpjamUser) {
    await failSlackLinkSession(
      payload.linkSessionId,
      "unknown_mcpjam_user"
    ).catch(() => {});
    return page(c, {
      title: "No MCPJam account yet",
      body: "Sign in to MCPJam once at app.mcpjam.com, then use the connect link again.",
      status: 400,
    });
  }

  // The org comes from WorkOS's `org_id` claim: WorkOS prompts multi-org
  // users itself, so we never need our own org picker. A claim that maps to
  // nothing is NOT fatal — orgs marked `workosOrgSyncStatus: 'skipped'` have
  // no WorkOS counterpart at all — but we cannot guess one either, so the
  // user is told to pick an org in the app and retry.
  let organizationId: string | null = null;
  if (workosOrgId) {
    let mapped;
    try {
      mapped = await resolveOrganizationByWorkosId(workosOrgId);
    } catch (error) {
      // Same rule: could-not-ask is not the same as maps-to-nothing.
      logger.error("[slack-link] org lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return unavailable(c);
    }
    organizationId = mapped?.organizationId ?? null;
  }
  if (!organizationId) {
    await failSlackLinkSession(payload.linkSessionId, "org_unresolved").catch(
      () => {}
    );
    return page(c, {
      title: "Couldn’t tell which organization to use",
      body: "Open MCPJam, make sure you’re in the organization you want Slack to work in, then use the connect link again.",
      status: 400,
    });
  }

  let result;
  try {
    result = await consumeSlackLinkSession({
      linkSessionId: payload.linkSessionId,
      userId: mcpjamUser._id,
      workosUserId,
      organizationId,
    });
  } catch (error) {
    // The session is intact (consume+upsert is one transaction, so a failure
    // rolled both back). The user can retry with a fresh link.
    logger.error("[slack-link] link consumption failed", {
      error: error instanceof Error ? error.message : String(error),
      is_backend_unavailable: error instanceof SlackBackendUnavailable,
    });
    // The session is intact — consume+upsert is one transaction, so a failure
    // rolled both back. 503, not 400: this is ours to fix, and the user's
    // link is still usable.
    return unavailable(c);
  }
  if (!result.ok) return linkFailed(c);

  // The person is fully identified at this point, so the page can offer
  // their ACTUAL projects instead of asking them to go find an id. Fetched
  // with a delegated token for exactly the org the link landed in;
  // best-effort — an empty list degrades to the paste field, never to a
  // failed page (the LINK already succeeded, and this is decoration on it).
  let projects: Array<{ id: string; name: string }> = [];
  try {
    const convexHttpUrl = (process.env.CONVEX_HTTP_URL ?? "").replace(
      /\/+$/,
      ""
    );
    if (convexHttpUrl) {
      const jwt = await getConvexBearerForDelegation(
        workosUserId,
        organizationId
      );
      const { ok, body } = await fetchJsonWithDeadline<{
        items?: Array<{ id?: unknown; name?: unknown }>;
        data?: Array<{ id?: unknown; name?: unknown }>;
      }>(`${convexHttpUrl}/v1/projects`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const rows = ok ? (body.items ?? body.data ?? []) : [];
      projects = rows
        .filter((row) => typeof row?.id === "string")
        .map((row) => ({
          id: String(row.id),
          name: typeof row.name === "string" && row.name ? row.name : String(row.id),
        }));
    }
  } catch (error) {
    logger.warn("[slack-link] could not list projects for the picker", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Keep the cookie: the default-project picker below needs the session id,
  // and the session is now `consumed`, so it can no longer authorize a link.
  return page(c, {
    title: "Slack is connected",
    body: "MCPJam will now act as you when you talk to it in Slack. Pick the project your Slack work should land in — you can change this any time from the app’s Home tab.",
    extraHtml: renderProjectPicker(projects),
  });
});

/**
 * Set the default project from the success page.
 *
 * Authorized by the link cookie, not by a session bearer: the person here has
 * just completed both identity proofs in this browser, and the backend
 * re-verifies that the project belongs to the link's organization anyway.
 */
slackLink.post("/default-project", async (c) => {
  const config = resolveConfig();
  if (!config) return notEnabled(c);

  const cookie = readLinkCookie(c);
  const payload = cookie ? decodeCookiePayload(cookie, config.secret) : null;
  if (!payload) {
    return c.json({ ok: false, message: "This page has expired." }, 400);
  }

  const session = await getSlackLinkSession(payload.linkSessionId).catch(
    () => null
  );
  // Only a session that actually COMPLETED may set a default — otherwise a
  // half-finished flow could write to whatever link already existed.
  if (!session || session.status !== "consumed") {
    return c.json({ ok: false, message: "This page has expired." }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    projectId?: unknown;
  };
  const projectId =
    typeof body.projectId === "string" && body.projectId.length > 0
      ? body.projectId
      : undefined;

  const result = await setSlackDefaultProject({
    teamId: session.teamId,
    slackUserId: session.slackUserId,
    ...(projectId ? { projectId } : {}),
  }).catch(() => ({ ok: false, reason: "backend_unavailable" }));

  if (!result.ok) {
    return c.json(
      { ok: false, message: "That project isn’t available on your account." },
      400
    );
  }
  clearLinkCookie(c);
  return c.json({ ok: true });
});

/**
 * Base64url-decode a JWT's claims WITHOUT verifying it.
 *
 * Safe here and ONLY here: the token was just received over TLS directly from
 * the WorkOS token endpoint, in exchange for our client secret. It was not
 * supplied by the user, so there is no attacker in a position to have forged
 * it. Never use this on a token that arrived from a client.
 */
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

function renderProjectPicker(
  projects: Array<{ id: string; name: string }>
): string {
  // Inline, dependency-free: this page is served once, to one person, right
  // after an auth flow — pulling in the SPA would be strictly worse.
  //
  // With a project list, each project is ONE BUTTON and a click saves it —
  // nobody should have to know what a project id looks like. The paste field
  // survives only as the fallback for the (rare) case the list could not be
  // fetched.
  const buttons = projects
    .slice(0, 50)
    .map(
      (project) =>
        `<button type="button" class="proj" data-id="${escapeHtml(project.id)}" style="display:block;width:100%;text-align:left;font:inherit;padding:.6rem .9rem;margin:.35rem 0;border-radius:.6rem;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);background:color-mix(in srgb, CanvasText 6%, transparent);cursor:pointer">${escapeHtml(project.name)}</button>`
    )
    .join("");

  const listHtml =
    projects.length > 0
      ? `<div id="projects" style="max-width:24rem">${buttons}</div>
<p id="msg" class="muted"></p>
<script>
document.querySelectorAll('.proj').forEach((button) => {
  button.addEventListener('click', async () => {
    const msg = document.getElementById('msg');
    msg.textContent = 'Saving…';
    document.querySelectorAll('.proj').forEach((b) => { b.disabled = true; });
    const response = await fetch('/api/slack/link/default-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: button.dataset.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (body.ok) {
      msg.textContent = 'Saved — head back to Slack and say hi.';
      button.style.borderColor = 'currentColor';
    } else {
      msg.textContent = body.message || 'Could not save that project.';
      document.querySelectorAll('.proj').forEach((b) => { b.disabled = false; });
    }
  });
});
</script>`
      : `<form id="pick" class="muted">
  <label for="projectId">Default project id</label><br>
  <input id="projectId" name="projectId" placeholder="Paste a project id" style="font:inherit;padding:.5rem .75rem;border-radius:.5rem;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);min-width:18rem">
  <button type="submit">Save</button>
  <p id="msg" class="muted"></p>
</form>
<script>
document.getElementById('pick').addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = document.getElementById('msg');
  msg.textContent = 'Saving…';
  const response = await fetch('/api/slack/link/default-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: document.getElementById('projectId').value.trim() }),
  });
  const body = await response.json().catch(() => ({}));
  msg.textContent = body.ok ? 'Saved. You can close this tab.' : (body.message || 'Could not save that project.');
});
</script>`;

  return `\n${listHtml}`;
}

export default slackLink;
