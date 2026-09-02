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
import { LOCAL_BROWSER_ENABLED, LOCAL_COMPUTER_ENABLED } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import {
  LOCAL_CONSENT_HEADER,
  grantLocalComputerConsent,
  revokeLocalComputerConsent,
  verifyAndFingerprintLocalConsent,
  verifyLocalComputerConsent,
} from "../../utils/computers/local-consent.js";
import { getLocalTerminalAvailability } from "../../utils/computers/local-pty.js";
import { issueLocalTerminalNonce } from "../../utils/computers/local-terminal-auth.js";
import {
  getChromiumInstallState,
  isChromiumInstalled,
  startChromiumInstall,
} from "../../utils/browser-rendering-setup.js";
import { listLocalBrowserSessions } from "../../services/browserd/local/local-browser-session.js";

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
  const availability = await getLocalTerminalAvailability();
  if (!availability.available) {
    return c.json({ error: availability.reason }, 503);
  }
  // Verify the capability AND capture its fingerprint in ONE read — see
  // `verifyAndFingerprintLocalConsent`. Two separate reads would let a
  // concurrent re-grant verify the old token and then bind the nonce to the
  // NEW capability, surviving the rotation it should have died to.
  //
  // Binding at all is what stops the 60s TTL outliving a revoke: a nonce minted
  // a second before the user clicked "Forget & re-authorize" would otherwise
  // still open a shell. The WS handler re-checks the fingerprint against the
  // live capability, so revoke AND rotation both invalidate outstanding nonces.
  const consentFingerprint = await verifyAndFingerprintLocalConsent(
    c.req.header(LOCAL_CONSENT_HEADER)
  );
  if (!consentFingerprint) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  try {
    // `issueLocalTerminalNonce` re-validates the project key (one bounded path
    // segment) — an invalid key never reaches the WS handler.
    const { nonce, expiresAtMs } = issueLocalTerminalNonce(
      projectId,
      consentFingerprint
    );
    return c.json({ nonce, expiresAtMs });
  } catch {
    return c.json({ error: "Invalid project for the local terminal" }, 400);
  }
});

/**
 * The agent browser's own gates, identical in shape to the terminal mint's and
 * separate in substance: `MCPJAM_LOCAL_BROWSER_ENABLED` is its own switch, so
 * an operator can allow a browser without a shell or the reverse.
 */
computers.use(
  "/local-browser/*",
  bearerAuthMiddleware,
  requireVerifiedAuth(),
);
computers.use("/local-browser/*", async (c, next) => {
  if (!LOCAL_BROWSER_ENABLED) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.get("guestId")) {
    return c.json({ error: "Guests cannot use the local browser" }, 403);
  }
  return next();
});

/**
 * Is there a Chromium on this machine for the agent to drive, and is one
 * running?
 *
 * Consent is NOT required to read this: the consent screen itself needs to
 * know whether it should offer an install, and a screen that cannot describe
 * the machine until you have already authorized it is a screen that cannot
 * explain what it is asking for. Nothing here is machine-identifying — no
 * paths, no profile directories, no process ids.
 */
computers.get("/local-browser/status", async (c) => {
  const install = getChromiumInstallState();
  const sessions = listLocalBrowserSessions();
  return c.json({
    installed: await isChromiumInstalled(),
    install,
    running: sessions.length > 0,
    // Whether a person currently holds any local browser. The rail shows this
    // so a second tab cannot silently believe it has control.
    leaseHeld: sessions.some((session) => session.leaseHeld),
  });
});

/**
 * Download Chromium, with progress, from the consent screen.
 *
 * This is the ONE place the install may start, and the reason it exists as a
 * route at all: the download is hundreds of megabytes, and doing it lazily
 * inside a chat turn means a model sitting in a tool call for minutes with no
 * way to say why. Requires consent — it is a large, unprompted download onto
 * someone's machine, which is exactly the class of thing consent is for.
 *
 * Idempotent: two clicks join one install rather than racing two `playwright
 * install` runs over the same browser cache.
 */
computers.post("/local-browser/install", async (c) => {
  const consent = await verifyLocalComputerConsent(
    c.req.header(LOCAL_CONSENT_HEADER),
  );
  if (!consent) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  return c.json({ install: await startChromiumInstall() });
});

export default computers;
