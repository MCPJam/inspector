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
import { randomUUID } from "node:crypto";
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
  parseAnchor,
  parsePaneCommand,
} from "../../services/browserd/daemon/pane-command.js";
import { supportsPane } from "../../services/browserd/pane-client.js";
import {
  ensureLocalBrowserSession,
  findLocalBrowserSession,
  findLocalBrowserSessionByKey,
  findLocalBrowserSessionForProject,
  type LiveLocalBrowser,
  localBrowserKeyFor,
  closeLocalBrowserSession,
  listLocalBrowserSessions,
  LocalBrowserUnavailableError,
  resolveLocalBrowserRuntime,
  resolveLocalBrowserSurface,
  touchLocalBrowserSession,
} from "../../services/browserd/local/local-browser-session.js";
import { exportBrowserProfileArchive } from "../../services/browserd/profile-archive.js";
import { BrowserSessionService } from "../../services/browserd/session-service.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  pageToolsFromCommandResponse,
  webmcpToolsObserveCommand,
} from "../../services/browserd/page-tools.js";
import type { ViewportInputEvent } from "../../services/browserd/daemon/viewport.js";
import {
  BROWSER_INPUT_BATCH_LIMIT,
  isBrowserPaneInputEvent,
} from "../../../shared/browser-pane-input.js";
import {
  parseSessionPolicy,
  resolveAgentActor,
  runAgentCommand,
} from "../../services/browserd/local/agent-door.js";
import {
  appendNote,
  findOpenSession,
  leaveAgentSession,
  disposeBrowserIfUnshared,
  listAgentSessions,
  mirrorLedger,
  openAgentSession,
  artifactMediaType,
  readArtifact,
  readLedger,
  readSession,
  validateSessionId,
  type AgentSessionRecord,
} from "../../services/browserd/local/agent-session-store.js";
import type { BrowserAgentCommand } from "../../../shared/browser-agent-contract.js";
import { logger } from "../../utils/logger.js";
import { browserProfileArchiveResponse } from "../../../shared/browser-session-header.js";

const computers = new Hono();

/**
 * Cap on one input batch.
 *
 * Pointer movement is the flooding vector, and the client already coalesces
 * moves; this is the server's own bound so a hostile or broken caller cannot
 * hand the browser an unbounded array to replay.
 */
const INPUT_BATCH_LIMIT = BROWSER_INPUT_BATCH_LIMIT;

/**
 * The only media types the agent artifact store writes.
 *
 * Anything else is served as `application/octet-stream`: the type rides on a
 * row alongside page-derived content, and a browser that will render whatever
 * a `content-type` claims is one redirect away from executing it.
 */
const ARTIFACT_MEDIA_TYPES = new Set(["image/jpeg", "text/plain"]);

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
  requireVerifiedAuth(),
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
    c.req.header(LOCAL_CONSENT_HEADER),
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
      consentFingerprint,
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
computers.use("/local-browser/*", bearerAuthMiddleware, requireVerifiedAuth());
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
  const runtime = resolveLocalBrowserRuntime();
  // The desktop app IS a Chromium. Probing for a downloaded one would report
  // `installed: false` on a machine that has a browser open, and the consent
  // screen would offer a hundreds-of-megabyte download for nothing.
  const electron = runtime === "electron";
  const install = electron
    ? ({ status: "ready" } as const)
    : getChromiumInstallState();
  const sessions = listLocalBrowserSessions();
  return c.json({
    runtime,
    // Whether the pane gets the page itself or a picture of it. The pane
    // BRANCHES on this — a native surface has no frame socket to open — so it
    // is answered by the same function the session layer builds the context
    // with, rather than re-derived from `runtime` here.
    surface: resolveLocalBrowserSurface(process.env, runtime),
    installed: electron ? true : await isChromiumInstalled(),
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
  // Electron BRINGS its Chromium, and the packaged app has no `node_modules`
  // for the Playwright CLI to live in — so starting an install here does not
  // merely waste a download, it fails. The status route already answers
  // `ready` for this runtime; say the same thing rather than contradicting it.
  if (resolveLocalBrowserRuntime() === "electron") {
    return c.json({ install: { status: "ready" as const } });
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
async function requireConsent(c: {
  req: { header(name: string): string | undefined };
}): Promise<string | null> {
  return verifyAndFingerprintLocalConsent(c.req.header(LOCAL_CONSENT_HEADER));
}

/**
 * "Somebody is looking at this browser."
 *
 * The idle reap closes a browser nobody has used for ten minutes, and until
 * now WATCHING was reported by the frame socket's own heartbeat: a pane with a
 * stream open was, by definition, a pane somebody had open. The NATIVE Electron
 * surface has no such socket — the page is a real view in the app's window,
 * with no frames to carry a heartbeat — so without this a person who is
 * watching the agent work, and not holding the lease, has their browser closed
 * underneath them while they are looking at it.
 *
 * Deliberately not a lease action: watching is not holding, and a route that
 * conflated the two would let a viewer block the agent by doing nothing.
 */
computers.post("/local-browser/watch", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
  } | null;
  const bootId = typeof body?.bootId === "string" ? body.bootId : "";
  const session = findLocalBrowserSession(bootId);
  // A browser that has already gone is not an error worth showing anybody: the
  // pane's next measure will discover it for itself.
  if (!session) return c.json({ watching: false }, 404);
  touchLocalBrowserSession(session.handle);
  // AND who has it. A pane that has been refused its input needs to know when
  // the other holder gives the browser back, and nothing on the frame socket
  // says so — the frames were flowing the whole time. Answering here rather
  // than making the pane call `ensure` is the difference between asking and
  // STARTING: `ensure` launches a Chromium when the watched browser has gone,
  // which is a browser nobody asked for on a machine whose own just crashed.
  // This route is keyed by `bootId`, so it can only ever describe the browser
  // the caller is actually looking at.
  const lease = await session.client.lease?.();
  return c.json({ watching: true, lease: lease ?? { state: "free" } });
});

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
    sessionId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  // The conversation's durable identity, when the rail has one. Without it
  // this route keys on the project alone and hands the pane the legacy
  // project-wide browser while the agent drives `<project>:session:<id>` —
  // a rail watching a browser nobody is using, and a profile export saving
  // the wrong one.
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  try {
    const handle = await ensureLocalBrowserSession({
      projectId,
      ...(sessionId ? { sessionId } : {}),
    });
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

/** Export one local persistent session, then leave it closed for a clean copy. */
computers.post("/local-browser/profile/export", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
    projectId?: unknown;
    sessionId?: unknown;
  } | null;
  const bootId = typeof body?.bootId === "string" ? body.bootId : "";
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const conversationId =
    typeof body?.sessionId === "string" ? body.sessionId : "";
  const session = findLocalBrowserSession(bootId);
  if (!session) return c.json({ error: "No such local browser" }, 404);
  const profileDir = session.handle.profileDir;
  if (!profileDir) {
    return c.json(
      { error: "Profile export is unavailable for this local browser" },
      409,
    );
  }
  try {
    let archive!: Uint8Array;
    const closed = await closeLocalBrowserSession(bootId, async () => {
      archive = await exportBrowserProfileArchive(profileDir);
    });
    if (!closed.closed) {
      return c.json(
        {
          error:
            closed.reason === "busy"
              ? "Wait for the browser action to finish before saving"
              : "Hand back control before saving this browser profile",
        },
        closed.reason === "not_found"
          ? 404
          : closed.reason === "busy"
          ? 409
          : 423,
      );
    }
    let savedFrom: string | undefined;
    if (projectId && conversationId) {
      // ISOLATED from the export. The browser is already closed and the
      // archive is already in hand by this point; a control-plane blip here
      // would otherwise fall into the catch below and 500, losing a save the
      // user did ask for over a header they did not.
      try {
        const bearer = await getConvexBearerForRequest(c);
        const logical = await new BrowserSessionService().resolveSession({
          owner: { kind: "conversation", id: conversationId },
          projectId,
          bearer,
          engine: "local",
          profile: "blank",
        });
        savedFrom = logical?.sessionId;
      } catch (error) {
        logger.warn(
          "[computers] profile export could not resolve its logical session",
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    return browserProfileArchiveResponse(archive, savedFrom);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to export the browser profile",
      },
      500,
    );
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
    anchor?: unknown;
  } | null;
  const bootId = typeof body?.bootId === "string" ? body.bootId : "";
  const holder = typeof body?.holder === "string" ? body.holder : "";
  const events = Array.isArray(body?.events)
    ? (body.events as ViewportInputEvent[]).slice(0, INPUT_BATCH_LIMIT)
    : [];
  if (!holder || events.length === 0) {
    return c.json(
      { error: "A holder and at least one event are required" },
      400,
    );
  }
  // Refused WHOLE rather than filtered, and by the same allowlist the frame
  // socket and the hosted panel use: dropping the bad ones would deliver a
  // drag missing its release, leaving the page holding a button down. The
  // daemon ignores a type it does not know, which is a 200 that did nothing —
  // and on a metered box a 200 defers the idle sweep.
  if (!events.every(isBrowserPaneInputEvent)) {
    return c.json({ error: "invalid_input" }, 400);
  }
  const session = findLocalBrowserSession(bootId);
  if (!session) return c.json({ error: "No such local browser" }, 404);
  const result = await session.handler.dispatchInput({
    holder,
    ...(body?.anchor !== undefined ? { anchor: body.anchor } : {}),
    ...(typeof body?.tabId === "string" ? { tabId: body.tabId } : {}),
    events,
  });
  if (!result.ok) {
    // 423, matching the daemon's own refusal for the same reason: somebody
    // else has the browser, or nobody has taken it yet.
    return c.json(
      { error: result.error },
      result.error === "page_changed"
        ? 409
        : result.error === "unknown_tab"
        ? 404
        : 423,
    );
  }
  touchLocalBrowserSession(session.handle);
  return c.json({ ok: true });
});

/**
 * What the browser IS — every tab, the history, who is driving, the size.
 *
 * POST like every other local-browser route: the project id travels in the
 * body alongside the consent capability, and the shared `post` helper on the
 * client is what attaches that header.
 *
 * READS, NEVER STARTS, for the same reason `/page-tools` does not: a tab strip
 * appearing in a side panel must not be what opens a Chromium window on
 * somebody's desk.
 */
computers.post("/local-browser/state", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
    holder?: unknown;
  } | null;
  const bootId = typeof body?.bootId === "string" ? body.bootId : "";
  const session = findLocalBrowserSession(bootId);
  if (!session) return c.json({ error: "no_browser_session" }, 404);
  const client = session.client;
  if (!supportsPane(client)) {
    return c.json({ error: "state_unsupported" }, 501);
  }
  const state = await client.paneState({
    ...(typeof body?.holder === "string" ? { holder: body.holder } : {}),
  });
  if (!state) return c.json({ error: "state_unavailable" }, 409);
  return c.json({ state });
});

/**
 * A person's navigation, which TAKES the browser.
 *
 * `pane-command`, not `command`: `/local-browser/command` already exists and
 * carries an outside coding AGENT's commands, which are refused while a lease
 * is held. This one acquires the lease as its first act. Two authorities on
 * one path, told apart by which fields happened to be present, is what the
 * ledger's `source` column exists to prevent.
 *
 * The `holder` is the pane's, supplied by the client — honest on a
 * single-user device, exactly as `/local-browser/lease` explains: consent plus
 * the session token already prove this is the machine's owner, and the holder
 * id only has to tell one PANE from another so two tabs cannot each believe
 * they have control.
 */
computers.post("/local-browser/pane-command", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
    holder?: unknown;
    command?: unknown;
    commandId?: unknown;
    anchor?: unknown;
  } | null;
  const holder = typeof body?.holder === "string" ? body.holder : "";
  if (!holder) return c.json({ error: "holder_required" }, 400);
  const command = parsePaneCommand(body?.command);
  if (!command) return c.json({ error: "invalid_command" }, 400);
  const session = findLocalBrowserSession(
    typeof body?.bootId === "string" ? body.bootId : "",
  );
  if (!session) return c.json({ error: "no_browser_session" }, 404);
  const client = session.client;
  if (!supportsPane(client)) {
    return c.json({ error: "pane_command_unsupported" }, 501);
  }
  const anchor = parseAnchor(body?.anchor);
  const outcome = await client.paneCommand({
    holder,
    command,
    ...(typeof body?.commandId === "string"
      ? { commandId: body.commandId }
      : {}),
    ...(anchor ? { anchor } : {}),
  });
  // Driving IS using the browser — otherwise the idle reap would close the
  // window on somebody who is mid-login and has simply not clicked for a
  // while. Touched even on a refusal, matching `/lease`: a person who lost a
  // race for the browser is still a person at the pane.
  touchLocalBrowserSession(session.handle);
  if (!outcome.ok) {
    const status =
      outcome.reason === "lease_held"
        ? 423
        : outcome.reason === "page_changed"
          ? 409
          : outcome.reason === "unsupported"
            ? 501
            : 502;
    return c.json(
      {
        error: outcome.reason,
        ...(outcome.reason === "lease_held" && outcome.holder
          ? { holder: outcome.holder }
          : {}),
      },
      status,
    );
  }
  return c.json({
    ok: true,
    ...(outcome.viewport ? { viewport: outcome.viewport } : {}),
  });
});

/**
 * The panel measured a size.
 *
 * No activity touch, matching the hosted twin: a resize happens TO a pane
 * rather than being something a person did with the browser, and a window
 * moved between monitors sends one.
 */
computers.post("/local-browser/viewport", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    bootId?: unknown;
    width?: unknown;
    policy?: unknown;
    height?: unknown;
  } | null;
  if (typeof body?.width !== "number" || typeof body?.height !== "number") {
    return c.json({ error: "invalid_viewport" }, 400);
  }
  const session = findLocalBrowserSession(
    typeof body?.bootId === "string" ? body.bootId : "",
  );
  if (!session) return c.json({ error: "no_browser_session" }, 404);
  const client = session.client;
  if (!supportsPane(client)) {
    return c.json({ error: "viewport_unsupported" }, 501);
  }
  const viewport = await client.paneViewport({
    ...(body.policy === "fixed" || body.policy === "followPane"
      ? { policy: body.policy }
      : {}),
    width: body.width,
    height: body.height,
  });
  if (!viewport) return c.json({ error: "viewport_unsupported" }, 501);
  return c.json({ viewport });
});

/**
 * The WebMCP tools of the page THIS MACHINE'S browser is on — the local half of
 * the hosted panel's `GET /page-tools`, feeding the same Tools pane.
 *
 * READS, NEVER STARTS. `ensureLocalBrowserSession` would launch a Chromium, and
 * a tool list appearing in a side panel must not be what opens a browser window
 * on somebody's desk — so a project with nothing running answers
 * `no_browser_session` and the pane says so.
 *
 * POST rather than GET because every local-browser route is: the project id
 * travels in the body alongside the consent capability, and the shared `post`
 * helper on the client is what attaches that header.
 */
computers.post("/local-browser/page-tools", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    tabId?: unknown;
    holder?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const tabId = typeof body?.tabId === "string" ? body.tabId : undefined;
  const holder = typeof body?.holder === "string" ? body.holder : undefined;
  let session: ReturnType<typeof findLocalBrowserSessionForProject>;
  try {
    session = findLocalBrowserSessionForProject(projectId);
  } catch {
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
  if (!session) {
    return c.json({ ok: false, error: "no_browser_session" }, 409);
  }
  const observe = (source: "inspector" | "manual", actingAs?: string) =>
    session!.client.sendCommand(
      webmcpToolsObserveCommand({
        source,
        ...(actingAs ? { holder: actingAs } : {}),
        ...(tabId ? { tabId } : {}),
      }),
      session!.handle.bootId,
    );
  try {
    let response = await observe("inspector");
    // The pane holding the lease is still allowed to look. Re-sent as this
    // holder's own `manual` command, which the daemon checks against the live
    // lease — an unauthenticated `manual` is refused there, so a body that
    // merely claims a holder buys nothing.
    if (response.status === "lease_blocked" && holder) {
      response = await observe("manual", holder);
    }
    const mapped = pageToolsFromCommandResponse(response);
    return c.json(mapped.body, mapped.status);
  } catch {
    return c.json({ ok: false, error: "unreachable" }, 502);
  }
});

/* -------------------------------------------------------------------------
 * The agent surface — an outside coding agent driving this machine's browser.
 *
 * Beside `ensure`/`lease`/`input` rather than under `/v1`, deliberately: these
 * are the LOCAL loop and they inherit the gates this file already applies —
 * the inspector session token, a verified sign-in, the kill switch, and device
 * consent. `/v1` is the hosted shape (M2) and brings its own ratchets with it.
 *
 * The one thing these routes must never do is take `source` or `actor` from a
 * body. `manual` is the single source the handoff lease does not block, so a
 * caller able to choose its own source could drive and observe a browser
 * somebody is signing into. `runAgentCommand` stamps `source: "agent"` itself
 * and the actor is composed from the authenticated context here.
 * ---------------------------------------------------------------------- */

/**
 * A correlation object, or nothing.
 *
 * Echoed onto the ledger row and never interpreted, so the only question is
 * whether it is a flat string map — a nested object here would be an
 * unbounded blob riding into every row.
 */
function isCorrelation(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length <= 10 &&
    entries.every(([, v]) => typeof v === "string" && v.length <= 200)
  );
}

/** The authenticated identity behind an agent command, or `anonymous`. */
function agentUserId(c: { get(key: string): unknown }): string | undefined {
  const candidates = ["mcpjamUserId", "workosUserId", "guestId"];
  for (const key of candidates) {
    const value = c.get(key);
    if (typeof value === "string" && value) return value;
  }
  // A self-hosted inspector with no AuthKit passes verified-auth by design, so
  // there is genuinely nobody to name. The ledger says `anonymous` and the
  // trace SHOWS it rather than inventing a plausible id.
  return undefined;
}

/** Everything an agent route needs about the live browser, or a typed refusal. */
async function resolveAgentSession(
  projectId: string,
  sessionId: string,
): Promise<
  | {
      ok: true;
      session: AgentSessionRecord;
      live: NonNullable<ReturnType<typeof findLocalBrowserSessionForProject>>;
    }
  | { ok: false; status: 404 | 409; error: string }
> {
  let stored: AgentSessionRecord | undefined;
  try {
    stored = await readSession(projectId, validateSessionId(sessionId));
  } catch {
    return { ok: false, status: 404, error: "invalid_session" };
  }
  if (!stored) return { ok: false, status: 404, error: "no_such_session" };
  if (stored.closedAt)
    return { ok: false, status: 409, error: "session_closed" };
  const live = liveBrowserFor(stored);
  if (!live) return { ok: false, status: 409, error: "no_browser_session" };
  return { ok: true, session: stored, live };
}

/**
 * THE SESSION'S OWN BROWSER, not the project's.
 *
 * An ephemeral context is keyed by the run that owns it, so looking one up by
 * project found the persistent browser instead — the person's real logged-in
 * Chromium, read and written under an ephemeral session's name. A record from
 * before `browserKey` existed has only its profile to go on: a persistent one
 * is the project's browser by definition, and an ephemeral one resolves to
 * nothing rather than to a browser that is not it.
 *
 * ONE RULE, USED EVERYWHERE. Three routes ask this question — command, trace
 * and close — and the first version of this answered it in the command path
 * alone, which left `trace` mirroring one browser's ring into another
 * session's history and `close --terminate` shutting the wrong window. A rule
 * with three copies is a rule with two that are wrong.
 *
 * READS, NEVER STARTS. Launching a Chromium because a request named a session
 * whose browser has gone would put a window on someone's desk for a session
 * they may have finished with; the caller re-opens explicitly.
 */
function liveBrowserFor(
  stored: AgentSessionRecord,
): LiveLocalBrowser | undefined {
  const live = stored.browserKey
    ? findLocalBrowserSessionByKey(stored.browserKey)
    : stored.profile === "persistent"
      ? findLocalBrowserSessionForProject(stored.projectId)
      : undefined;
  // The key is stored, not parsed, so this is the one place that can still
  // catch a record pointing at another project's browser. `stored.projectId` is
  // the validated key the session was opened under.
  if (!live || live.projectKey !== stored.projectId) return undefined;
  return live;
}

/**
 * Open a browser session, attaching to this project's live one by default.
 *
 * ATTACHING IS THE DEFAULT because the ask is a browser an agent and a person
 * SHARE. An agent that always created its own would give the user a second
 * browser to watch and a second history to read.
 */
computers.post("/local-browser/session", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    attach?: unknown;
    policy?: unknown;
    profile?: unknown;
    client?: unknown;
    clientId?: unknown;
    captureTypedText?: unknown;
    captureScreenshots?: unknown;
    observe?: unknown;
    runKey?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const policy = parseSessionPolicy(body?.policy);
  if (!policy) {
    // A refusal, not a default. The one thing worse than a session that cannot
    // use the browser is a session using it under a policy nobody wrote.
    return c.json(
      {
        error: "invalid_policy",
        detail:
          "declare a policy: mode allow_all | read_only | allowlist, with a " +
          "non-empty originAllowlist or toolAllowlist for allowlist",
      },
      400,
    );
  }
  // REFUSED, not defaulted. Reading anything-but-`ephemeral` as `persistent`
  // meant `--profile ephermal` opened the project's real logged-in Chromium —
  // the precise mix-up this surface exists to prevent, reachable by a typo.
  // An omitted profile still means `persistent`; a misspelled one is an error.
  if (
    body?.profile !== undefined &&
    body?.profile !== "ephemeral" &&
    body?.profile !== "persistent"
  ) {
    return c.json(
      {
        error: "invalid_profile",
        detail: "profile must be 'persistent' or 'ephemeral'",
      },
      400,
    );
  }
  const profile = body?.profile === "ephemeral" ? "ephemeral" : "persistent";
  const captureTypedText = body?.captureTypedText === true;
  if (captureTypedText && profile === "persistent") {
    // A persistent profile is somebody's real, logged-in browser. Recording
    // what they type into it is the wrong default in the one place it matters
    // most, and there is no opt-in that makes it right.
    return c.json(
      {
        error: "capture_typed_text_requires_ephemeral",
        detail:
          "captureTypedText records passwords as well as search terms; it is " +
          "available on ephemeral profiles only",
      },
      400,
    );
  }
  const attach =
    body?.attach === "never" || body?.attach === "require"
      ? body.attach
      : "prefer";
  // ASKED BEFORE ANYTHING IS LAUNCHED. `require` means "join or fail", so
  // starting a Chromium and then answering `nothing_to_attach` leaves a browser
  // on somebody's desk that no session owns and nothing will close until the
  // idle reaper notices.
  //
  // An EPHEMERAL profile has nothing to attach to by construction — a throwaway
  // context belongs to one run — so `require` is unsatisfiable there whatever
  // else is open. Checking only for a live persistent session let that pair
  // through whenever the project happened to have one, and the store's refusal
  // then arrived one launched browser too late.
  if (attach === "require") {
    const live =
      profile === "persistent"
        ? await findOpenSession(projectId).catch(() => undefined)
        : undefined;
    if (!live) {
      return c.json(
        {
          error: "nothing_to_attach",
          detail:
            profile === "ephemeral"
              ? "attach: 'require' cannot be satisfied by an ephemeral " +
                "profile, which is never shared; ask for a persistent " +
                "profile or pass attach: 'never'"
              : "attach: 'require' was asked for and this project has no open " +
                "persistent browser session",
        },
        409,
      );
    }
  }
  // An EPHEMERAL browser needs an owner key or `ensureLocalBrowserSession`
  // refuses outright: two unattended runs on one project must not share a
  // profile, and without a key they would collide on the project alone. The
  // caller may name its run; otherwise one is minted, which is the honest
  // default for a throwaway browser nobody else will attach to.
  // A runKey the caller SENT is either used or refused, never quietly swapped.
  // Replacing a malformed one with a fresh uuid meant two `open` calls naming
  // the same run got two different browsers, and neither could be reattached by
  // repeating the key the caller actually sent — a caller that named its run
  // deserves to be told the name was unusable.
  if (
    body?.runKey !== undefined &&
    !(
      typeof body.runKey === "string" &&
      /^[A-Za-z0-9_.:-]{1,64}$/.test(body.runKey)
    )
  ) {
    return c.json(
      {
        error: "invalid_run_key",
        detail: "runKey must be 1-64 characters of A-Z a-z 0-9 and _ . : -",
      },
      400,
    );
  }
  const runKey =
    typeof body?.runKey === "string" ? body.runKey : `agent-${randomUUID()}`;
  // ONE description of the browser, used to start it AND to name it on the
  // session record, so the two cannot drift into a session pointing at a
  // browser nobody opened.
  const browserArgs = {
    projectId,
    contextMode: profile,
    ...(profile === "ephemeral" ? { ownerKey: runKey } : {}),
    ...(captureTypedText ? { captureTypedText: true } : {}),
  } as const;
  let handle;
  let browserKey: string;
  try {
    browserKey = localBrowserKeyFor(browserArgs);
    handle = await ensureLocalBrowserSession(browserArgs);
  } catch (error) {
    if (error instanceof LocalBrowserUnavailableError) {
      return c.json({ error: error.code, detail: error.message }, 409);
    }
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
  const actor = resolveAgentActor({
    userId: agentUserId(c),
    clientKind: body?.client,
    clientId: body?.clientId,
  });
  const opened = await openAgentSession({
    projectId,
    engine: "local",
    profile,
    policy,
    createdBy: actor.label ?? "anonymous",
    actor: { actorId: actor.id, kind: actor.kind },
    bootId: handle.bootId,
    browserKey,
    attach,
    ...(captureTypedText ? { captureTypedText: true } : {}),
    ...(body?.captureScreenshots === false
      ? { captureScreenshots: false }
      : {}),
  });
  if (!opened.ok) {
    if (opened.reason === "policy_mismatch") {
      // Neither widening the running session nor pretending the caller's policy
      // was accepted is ours to choose: the caller either accepts the live
      // policy (by declaring it) or opens its own session with `attach: never`.
      return c.json(
        {
          error: "policy_mismatch",
          detail:
            "this project's open browser session runs under a different " +
            "policy; declare the same policy to attach, or pass " +
            "attach: 'never' to open a separate session",
          policy: opened.session.policy,
        },
        409,
      );
    }
    // THE RACE, not the ordinary refusal. `require` on an ephemeral profile is
    // turned down before anything launches, and a project with no open session
    // fails the pre-check — so reaching here means the session that pre-check
    // found was closed while this request was starting a browser. A browser
    // reaped for idleness while its logical session stayed open makes that a
    // real sequence, not a theoretical one.
    //
    // A browser THIS request started is therefore owned by nobody, and would
    // sit on somebody's desk until the idle reaper noticed. One we merely
    // reused belongs to whoever was already using it and is not ours to close.
    if (!handle.reused) {
      await closeLocalBrowserSession(handle.bootId).catch(() => undefined);
    }
    return c.json(
      {
        error: "nothing_to_attach",
        detail:
          "attach: 'require' was asked for and this project's open browser " +
          "session was closed while this one was starting; try again",
      },
      409,
    );
  }
  touchLocalBrowserSession(handle);

  // The INITIAL OBSERVATION, so a caller can act without a second round trip.
  const live = findLocalBrowserSession(handle.bootId);
  let page;
  let session = opened.session;
  if (live && body?.observe !== "none") {
    const ran = await runAgentCommand({
      session,
      client: live.client,
      ledger: live.ledger,
      bootId: handle.bootId,
      actor,
      command: {
        op: "observe",
        mode: body?.observe === "screenshot" ? "screenshot" : "a11y",
      },
    });
    session = ran.session;
    if (ran.result.status === "executed") page = ran.result.page;
  }
  return c.json({
    session,
    attached: opened.attached,
    bootId: handle.bootId,
    ...(page ? { page } : {}),
  });
});

/**
 * This project's browser sessions, so a WATCHER can find the one to show.
 *
 * The rail knows the project, not the session: an agent opened it, possibly
 * from another process. Without this the Activity list would have nothing to
 * read, and asking a person to paste a session id into a side panel is not a
 * side panel anybody would use.
 *
 * A read, and it starts nothing.
 */
computers.post("/local-browser/sessions", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  try {
    const sessions = await listAgentSessions(projectId);
    return c.json({
      sessions: sessions.sort((a, b) => b.createdAt - a.createdAt),
    });
  } catch {
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
});

/**
 * One browser command from an agent.
 *
 * Everything interesting happens in `runAgentCommand`; this route's job is the
 * part that must not be delegated — establishing WHO is asking from the
 * authenticated context, rather than from anything in the body.
 */
computers.post("/local-browser/command", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    sessionId?: unknown;
    command?: unknown;
    commandId?: unknown;
    tabId?: unknown;
    client?: unknown;
    clientId?: unknown;
    correlation?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const command = body?.command as BrowserAgentCommand | undefined;
  if (
    !command ||
    typeof command !== "object" ||
    typeof command.op !== "string"
  ) {
    return c.json({ error: "A command with an `op` is required" }, 400);
  }
  let resolved;
  try {
    resolved = await resolveAgentSession(projectId, sessionId);
  } catch {
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
  if (!resolved.ok) {
    return c.json({ error: resolved.error }, resolved.status);
  }
  const ran = await runAgentCommand({
    session: resolved.session,
    client: resolved.live.client,
    ledger: resolved.live.ledger,
    bootId: resolved.live.handle.bootId,
    actor: resolveAgentActor({
      userId: agentUserId(c),
      clientKind: body?.client,
      clientId: body?.clientId,
    }),
    command,
    ...(typeof body?.commandId === "string"
      ? { commandId: body.commandId }
      : {}),
    ...(typeof body?.tabId === "string" ? { tabId: body.tabId } : {}),
    ...(isCorrelation(body?.correlation)
      ? { correlation: body.correlation }
      : {}),
  });
  // Driving the browser IS using it, refusals included: an idle reap between an
  // agent's refusal and its retry would be exactly as disruptive as one taken
  // mid-turn.
  touchLocalBrowserSession(resolved.live.handle);
  return c.json(ran.result, ran.status as 200);
});

/**
 * A marker in the trace, and nothing else.
 *
 * Costs nothing now and is what makes replay video useful the day it lands: a
 * ledger `seq` maps to a frame offset the way the widget harness's replay
 * already maps steps.
 */
computers.post("/local-browser/note", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    sessionId?: unknown;
    text?: unknown;
    client?: unknown;
    clientId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const text = typeof body?.text === "string" ? body.text.slice(0, 4000) : "";
  if (!text) return c.json({ error: "A note needs text" }, 400);
  let resolved;
  try {
    resolved = await resolveAgentSession(projectId, sessionId);
  } catch {
    return c.json({ error: "Invalid project for the local browser" }, 400);
  }
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  const session = await appendNote({
    session: resolved.session,
    text,
    actor: resolveAgentActor({
      userId: agentUserId(c),
      clientKind: body?.client,
      clientId: body?.clientId,
    }),
    bootId: resolved.live.handle.bootId,
  });
  return c.json({ seq: session.lastSeq });
});

/**
 * The session's durable trace, read forward from a cursor.
 *
 * MIRRORS FIRST. The daemon's ring is bounded and per-boot; copying it into the
 * durable sink on every read is what keeps the ring from ever being the thing
 * that loses history — and it is how a model-driven command, which never went
 * through the door, still reaches the rail and the CLI.
 */
computers.post("/local-browser/trace", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    sessionId?: unknown;
    afterSeq?: unknown;
    commandId?: unknown;
    limit?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  let stored: AgentSessionRecord | undefined;
  try {
    stored = await readSession(projectId, validateSessionId(sessionId));
  } catch {
    return c.json({ error: "invalid_session" }, 404);
  }
  if (!stored) return c.json({ error: "no_such_session" }, 404);

  let session = stored;
  let historyWarning: string | undefined;
  // A CLOSED session's history is FINISHED. Its trace still reads — that is
  // the point of a durable record — but mirroring into it would append rows
  // for commands issued after it ended, by whoever is using the browser now,
  // filing somebody else's browsing under a session that had already left.
  const live = stored.closedAt ? undefined : liveBrowserFor(stored);
  if (live) {
    try {
      const mirrored = await mirrorLedger({
        session,
        ledger: live.ledger,
        bootId: live.handle.bootId,
        ...(session.captureScreenshots === false
          ? { captureScreenshots: false }
          : {}),
      });
      session = mirrored.session;
    } catch (error) {
      // Never silent: a reader looking at a trace with a hole in it is told the
      // hole is ours rather than concluding nothing happened.
      historyWarning =
        "the newest rows could not be written to this session's history " +
        `(${error instanceof Error ? error.message : String(error)})`;
    }
  }
  const trace = await readLedger({
    projectId,
    sessionId: session.sessionId,
    ...(typeof body?.afterSeq === "number" ? { afterSeq: body.afterSeq } : {}),
    ...(typeof body?.commandId === "string"
      ? { commandId: body.commandId }
      : {}),
    ...(typeof body?.limit === "number" ? { limit: body.limit } : {}),
  });
  return c.json({
    entries: trace.entries,
    headSeq: trace.headSeq,
    session,
    ...(historyWarning ? { historyWarning } : {}),
  });
});

/** One artifact payload, by the id a row names. */
computers.post("/local-browser/artifact", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    sessionId?: unknown;
    artifactId?: unknown;
    mediaType?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const artifactId =
    typeof body?.artifactId === "string" ? body.artifactId : "";
  if (!artifactId) return c.json({ error: "An artifactId is required" }, 400);
  let bytes: Buffer | undefined;
  // The media type comes from the ROW that named this artifact, never from the
  // request. A caller's `mediaType` is what it hopes to get; echoing it into a
  // `content-type` is how page-derived text ends up served as `text/html`.
  let mediaType: string | undefined;
  try {
    const validSession = validateSessionId(sessionId);
    // THE DESCRIPTOR IS THE AUTHORIZATION, and it has to be acted on.
    //
    // The payload store is the PROJECT's — one copy of a screenshot two
    // sessions share — so the path no longer scopes a read the way it did when
    // every session had its own directory. Reading the descriptor and then
    // reading the bytes regardless left the only check as decoration: a valid
    // session id plus a guessed artifact id returned another session's
    // screenshot out of the shared store.
    mediaType = await artifactMediaType({
      projectId,
      sessionId: validSession,
      artifactId,
    });
    // Not in THIS session's ledger: as far as this caller is concerned the id
    // does not exist, and saying anything more precise would confirm that it
    // does somewhere else.
    if (mediaType === undefined) {
      return c.json({ error: "no_such_artifact", id: artifactId }, 404);
    }
    bytes = await readArtifact({
      projectId,
      sessionId: validSession,
      artifactId,
    });
  } catch {
    return c.json({ error: "invalid_session" }, 404);
  }
  if (!bytes) {
    // 410 rather than 404: the row names this id, so it was real and its
    // payload has aged out — which points the caller at the row's `evicted`
    // marker rather than at a typo.
    return c.json({ error: "artifact_evicted", id: artifactId }, 410);
  }
  // `Uint8Array`, not `Buffer`: a `Buffer` is one, but the response body type
  // is the web `BodyInit` and naming the web type keeps this honest about what
  // is actually being written.
  return c.body(new Uint8Array(bytes), 200, {
    // Narrowed to what the store actually writes, whatever the row says. A
    // media type is metadata that travelled with page content, and this
    // response is served from the Inspector's own origin.
    "content-type": ARTIFACT_MEDIA_TYPES.has(mediaType ?? "")
      ? (mediaType as string)
      : "application/octet-stream",
    "content-length": String(bytes.byteLength),
    // Belt and braces: even a narrowed type should not be re-interpreted.
    "x-content-type-options": "nosniff",
  });
});

/**
 * Leave the session. The browser lives on for everyone else.
 *
 * DETACHES BY DEFAULT because a session is shared: an agent finishing its work
 * must not close the window a person is still watching. `terminate` is the
 * explicit form, and it is refused while somebody holds the lease — closing the
 * browser out from under a person mid-login is the one thing this must never do.
 */
computers.post("/local-browser/close", async (c) => {
  if (!(await requireConsent(c))) {
    return c.json({ error: "Local computer consent is required" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    sessionId?: unknown;
    terminate?: unknown;
    client?: unknown;
    clientId?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const terminate = body?.terminate === true;
  let stored: AgentSessionRecord | undefined;
  try {
    stored = await readSession(projectId, validateSessionId(sessionId));
  } catch {
    return c.json({ error: "invalid_session" }, 404);
  }
  if (!stored) return c.json({ error: "no_such_session" }, 404);
  const live = liveBrowserFor(stored);
  if (terminate && live) {
    const lease = await live.client.lease?.();
    if (lease && lease.state !== "free") {
      return c.json(
        {
          error: "lease_held",
          detail:
            "somebody holds this browser; terminating it would close the " +
            "window they are using",
          holder: lease.holder,
        },
        423,
      );
    }
  }
  const actor = resolveAgentActor({
    userId: agentUserId(c),
    clientKind: body?.client,
    clientId: body?.clientId,
  });
  const session = await leaveAgentSession({
    projectId,
    sessionId,
    actorId: actor.id,
    ...(terminate ? { terminate: true } : {}),
  });
  let terminated = false;
  if (terminate && live) {
    // THIS browser, not every browser on the machine: another project's has
    // nothing to do with this session ending. The ordinary case needs none of
    // this — the idle reaper handles it, and a recent ledger row is activity.
    //
    // And only when no OTHER open logical session is still using it. Two
    // sessions can share one project browser, so closing on the first one's
    // terminate would take the browser out from under the second.
    //
    // THE SAME browser, though: a project's ephemeral runs each have their own
    // Chromium, so counting every open session in the project let an unrelated
    // throwaway run keep a persistent browser alive — and reported that as the
    // reason. Sessions written before `browserKey` existed are matched by
    // profile, which is what the key encoded for them.
    //
    // The count AND the disposal under one lock; see `disposeBrowserIfUnshared`.
    // A record we could not read leaves us unable to say WHICH browser this
    // session was on, so every other open session counts and the browser is
    // left running. Erring the other way closes somebody's window on a guess.
    const outcome = await disposeBrowserIfUnshared({
      projectId,
      sessionId,
      session,
      dispose: () =>
        closeLocalBrowserSession(live.handle.bootId).catch(
          () => ({ closed: false, reason: "not_found" } as const),
        ),
    });
    if (!outcome.disposed) {
      return c.json({
        session,
        terminated: false,
        detail:
          `${outcome.others} other open session(s) still use this browser; ` +
          "this one was detached and the browser left running",
      });
    }
    const closed = outcome.result;
    if (!closed.closed && closed.reason === "lease_held") {
      // Somebody took the browser between the read above and the claim inside
      // `closeLocalBrowserSession`. The BROWSER is safe either way — that claim
      // is atomic and is held through disposal, so a leased browser is never
      // torn down — but this session has already been closed by the
      // `leaveAgentSession` above, and saying only "left running" would let a
      // caller believe nothing had changed.
      //
      // So the answer carries the session, and says both halves. Re-opening the
      // session here to undo the close would be a third write racing the same
      // two writers; telling the truth about what happened is the smaller and
      // more honest fix.
      return c.json(
        {
          error: "lease_held",
          session,
          detail:
            "somebody took this browser while the session was closing; the " +
            "session is closed and the browser was left running",
        },
        423,
      );
    }
    terminated = closed.closed;
  }
  return c.json({ session, terminated });
});

export default computers;
