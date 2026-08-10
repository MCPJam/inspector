/**
 * Local-computer consent capability routes — /api/mcp/computers/local-consent.
 *
 * Deliberately under /api/mcp, NOT /api/web: the global session middleware
 * protects /api/mcp with the inspector session token, so a random webpage
 * can't drive these cross-origin. On top of that each request must carry a
 * VERIFIED sign-in: `bearerAuthMiddleware` labels an unrecognized bearer
 * `unverified_passthrough`, and `requireVerifiedAuth` rejects exactly that —
 * these routes never forward the bearer to Convex, so without it a bare
 * `Authorization: Bearer whatever` would mint a shell-consent capability.
 * Guests are rejected explicitly; the kill switch 404s everything (and the
 * route is additionally never meaningful hosted, where the flag is forced
 * off).
 *
 * grant  → mints + persists (hash-only) a device capability, returns the
 *          plaintext ONCE. Called only from the explicit Allow action.
 * verify → lets a returning client validate its stored capability.
 * revoke → clears the persisted capability; scoped to the presented token
 *          when one is supplied (a delayed revoke must not sever a newer
 *          grant's rotated capability), unconditional otherwise.
 */
import { Hono } from "hono";
import { LOCAL_COMPUTER_ENABLED } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import {
  LOCAL_CONSENT_HEADER,
  grantLocalComputerConsent,
  revokeLocalComputerConsent,
  verifyLocalComputerConsent,
} from "../../utils/computers/local-consent.js";
import { getLocalTerminalAvailability } from "../../utils/computers/local-pty.js";
import { issueLocalTerminalNonce } from "../../utils/computers/local-terminal-auth.js";

const computers = new Hono();

computers.use("/local-consent/*", bearerAuthMiddleware, requireVerifiedAuth());
computers.use("/local-consent/*", async (c, next) => {
  if (!LOCAL_COMPUTER_ENABLED) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.get("guestId")) {
    return c.json({ error: "Guests cannot enable the local computer" }, 403);
  }
  return next();
});

// The gates above are scoped to `/local-consent/*` ONLY, so the terminal mint
// needs its own identical stack — without this it would inherit nothing but the
// app-level session middleware. Registered on the EXACT path rather than
// `/local-terminal-token/*`: the mint is a single bare path with no sub-routes,
// and an exact registration can't be wrong about whether a wildcard covers its
// own prefix. (`bearerAuthMiddleware` resolves the bearer, so a double match
// would also do that work twice.)
computers.use(
  "/local-terminal-token",
  bearerAuthMiddleware,
  requireVerifiedAuth()
);
computers.use("/local-terminal-token", async (c, next) => {
  if (!LOCAL_COMPUTER_ENABLED) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.get("guestId")) {
    return c.json({ error: "Guests cannot open a local terminal" }, 403);
  }
  return next();
});

computers.post("/local-consent/grant", async (c) => {
  const granted = await grantLocalComputerConsent();
  return c.json(granted);
});

computers.post("/local-consent/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    token?: unknown;
  } | null;
  const token = typeof body?.token === "string" ? body.token : null;
  return c.json({ valid: await verifyLocalComputerConsent(token) });
});

computers.post("/local-consent/revoke", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    token?: unknown;
  } | null;
  const token = typeof body?.token === "string" ? body.token : null;
  await revokeLocalComputerConsent(token);
  return c.json({ ok: true });
});

/**
 * Mint a single-use nonce for the local terminal WebSocket.
 *
 * On top of the middleware stack above (session + verified sign-in + non-guest
 * + kill switch) this requires SERVER-VERIFIED consent: the same capability the
 * chat `bash` path checks. No consent, no nonce — an interactive shell is
 * strictly more than the per-command-approved bash tool, so it can never be the
 * first thing that runs on a machine the user never authorized.
 *
 * The response carries the nonce and its deadline and NOTHING else — no
 * workspace path, no shell, no username.
 */
computers.post("/local-terminal-token", async (c) => {
  const consentToken = c.req.header(LOCAL_CONSENT_HEADER);
  if (!(await verifyLocalComputerConsent(consentToken))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const availability = await getLocalTerminalAvailability();
  if (!availability.available) {
    return c.json({ error: availability.reason }, 503);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  try {
    // `issueLocalTerminalNonce` re-validates the project key (one bounded path
    // segment) — an invalid key never reaches the WS handler.
    const { nonce, expiresAtMs } = issueLocalTerminalNonce(projectId);
    return c.json({ nonce, expiresAtMs });
  } catch {
    return c.json({ error: "Invalid project for the local terminal" }, 400);
  }
});

export default computers;
