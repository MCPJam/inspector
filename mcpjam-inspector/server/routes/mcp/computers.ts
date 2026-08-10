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
 * revoke → clears the persisted capability.
 */
import { Hono } from "hono";
import { LOCAL_COMPUTER_ENABLED } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import {
  grantLocalComputerConsent,
  revokeLocalComputerConsent,
  verifyLocalComputerConsent,
} from "../../utils/computers/local-consent.js";

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
  await revokeLocalComputerConsent();
  return c.json({ ok: true });
});

export default computers;
