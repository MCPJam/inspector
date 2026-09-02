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
import {
  issueLocalNonce,
  issueLocalTerminalNonce,
} from "../../utils/computers/local-terminal-auth.js";
import {
  getChromiumInstallState,
  isChromiumInstalled,
  startChromiumInstall,
} from "../../utils/browser-rendering-setup.js";
import {
  ensureLocalBrowserSession,
  findLocalBrowserSession,
  listLocalBrowserSessions,
  LocalBrowserUnavailableError,
  touchLocalBrowserSession,
} from "../../services/browserd/local/local-browser-session.js";
import type { ViewportInputEvent } from "../../services/browserd/daemon/viewport.js";

const computers = new Hono();

/**
 * Cap on one input batch.
 *
 * Pointer movement is the flooding vector, and the client already coalesces
 * moves; this is the server's own bound so a hostile or broken caller cannot
 * hand the browser an unbounded array to replay.
 */
const INPUT_BATCH_LIMIT = 64;

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

/**
 * Consent, once, for every route below that touches the browser itself.
 *
 * `status` and `install` do their own checks (one needs none, the other needs
 * consent); everything from here on drives or watches a real browser, so the
 * check is uniform. It returns the fingerprint as well as the verdict because
 * the frames nonce is bound to it — a nonce must not outlive the consent that
 * authorized it.
 */
async function requireConsent(
  c: { req: { header(name: string): string | undefined } },
): Promise<string | null> {
  return verifyAndFingerprintLocalConsent(c.req.header(LOCAL_CONSENT_HEADER));
}

/**
 * Start (or find) this project's browser and report how to reach it.
 *
 * The rail calls this when its tab opens. It is separate from the chat turn's
 * own ensure so a person can watch a browser before the agent has asked for
 * one — and so the FIRST thing that happens on a slow machine is a spinner in
 * the pane rather than a stalled tool call.
 */
computers.post("/local-browser/ensure", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  try {
    const handle = await ensureLocalBrowserSession({ projectId });
    const lease = await handle.client.lease?.();
    return c.json({
      bootId: handle.bootId,
      contextMode: handle.contextMode,
      lease: lease ?? { state: "free" },
    });
  } catch (error) {
    if (error instanceof LocalBrowserUnavailableError) {
      // A typed refusal the pane can act on: "install Chromium", "another
      // process has this profile" — never a stack trace.
      return c.json({ error: error.message, code: error.code }, 409);
    }
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
});

/**
 * Mint the single-use nonce that opens the frames socket.
 *
 * Same shape as the terminal's, for the same reason: a WebSocket cannot carry
 * an Authorization header from a browser, so the credential rides the
 * subprotocol — and a credential in a URL or a long-lived one in a header is
 * exactly what this avoids. Bound to the consent capability, so revoking
 * consent invalidates nonces already handed out.
 */
computers.post("/local-browser/token", async (c) => {
  const consentFingerprint = await requireConsent(c);
  if (!consentFingerprint) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  try {
    return c.json(
      issueLocalNonce({
        kind: "browser-frames",
        projectId,
        consentFingerprint,
      }),
    );
  } catch {
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
});

/**
 * Take the browser, keep it, or hand it back.
 *
 * The `holder` is supplied by the client, and on a single-user device that is
 * honest: consent plus the session token already prove this is the machine's
 * owner, and the holder id only has to distinguish one PANE from another so
 * two tabs cannot each believe they have control. It is not an identity claim,
 * and nothing downstream treats it as one.
 */
computers.post("/local-browser/lease", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
    action?: unknown;
    holder?: unknown;
    ttlMs?: unknown;
    kind?: unknown;
  } | null;
  const bootId = typeof body?.bootId === "string" ? body.bootId : "";
  const holder = typeof body?.holder === "string" ? body.holder : "";
  const action = body?.action;
  if (
    !holder ||
    (action !== "acquire" && action !== "heartbeat" && action !== "resume")
  ) {
    return c.json({ error: "A holder and a valid action are required" }, 400);
  }
  const session = findLocalBrowserSession(bootId);
  if (!session?.client.leaseAction) {
    return c.json({ error: "No such local browser" }, 404);
  }
  const result = await session.client.leaseAction({
    action,
    holder,
    ...(typeof body?.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
    ...(body?.kind === "script" ? { kind: "script" as const } : {}),
  });
  // Holding the browser IS using it — otherwise the idle reap would close the
  // window on someone who is mid-login and has simply not clicked for a while.
  touchLocalBrowserSession(session.handle);
  // An acquire that did not take is a 409, not a silent no-op: a pane that
  // thinks it has control would show a person a live view while the agent kept
  // driving underneath them.
  return c.json({ lease: result.lease }, result.took ? 200 : 409);
});

/**
 * Forward the person's pointer and keys.
 *
 * Deliberately NOT a browser command: input arrives as batches at up to twenty
 * a second while someone drags a scrollbar, and every command spends an
 * idempotency slot from a ledger that refuses new ids once exhausted. The
 * daemon's handler still gates it on the lease — this is the one path that
 * puts keystrokes into a page without a per-action approval, so "who is
 * typing" has to have an answer.
 */
computers.post("/local-browser/input", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
    holder?: unknown;
    tabId?: unknown;
    events?: unknown;
  } | null;
  const bootId = typeof body?.bootId === "string" ? body.bootId : "";
  const holder = typeof body?.holder === "string" ? body.holder : "";
  const events = Array.isArray(body?.events)
    ? (body.events as ViewportInputEvent[]).slice(0, INPUT_BATCH_LIMIT)
    : [];
  if (!holder || events.length === 0) {
    return c.json({ error: "A holder and at least one event are required" }, 400);
  }
  const session = findLocalBrowserSession(bootId);
  if (!session) return c.json({ error: "No such local browser" }, 404);
  const result = await session.handler.dispatchInput({
    holder,
    ...(typeof body?.tabId === "string" ? { tabId: body.tabId } : {}),
    events,
  });
  if (!result.ok) {
    // 423, matching the daemon's own refusal for the same reason: somebody
    // else has the browser, or nobody has taken it yet.
    return c.json({ error: result.error }, result.error === "unknown_tab" ? 404 : 423);
  }
  touchLocalBrowserSession(session.handle);
  return c.json({ ok: true });
});

export default computers;
