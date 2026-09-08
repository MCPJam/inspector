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
  findLocalBrowserSessionForProject,
  closeLocalBrowserSession,
  listLocalBrowserSessions,
  LocalBrowserUnavailableError,
  resolveLocalBrowserRuntime,
  resolveLocalBrowserSurface,
  touchLocalBrowserSession,
} from "../../services/browserd/local/local-browser-session.js";
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
  leaveAgentSession,
  mirrorLedger,
  openAgentSession,
  readArtifact,
  readLedger,
  readSession,
  validateSessionId,
  type AgentSessionRecord,
} from "../../services/browserd/local/agent-session-store.js";
import type { BrowserAgentCommand } from "../../../shared/browser-agent-contract.js";

const computers = new Hono();

/**
 * Cap on one input batch.
 *
 * Pointer movement is the flooding vector, and the client already coalesces
 * moves; this is the server's own bound so a hostile or broken caller cannot
 * hand the browser an unbounded array to replay.
 */
const INPUT_BATCH_LIMIT = BROWSER_INPUT_BATCH_LIMIT;

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
    ...(typeof body?.tabId === "string" ? { tabId: body.tabId } : {}),
    events,
  });
  if (!result.ok) {
    // 423, matching the daemon's own refusal for the same reason: somebody
    // else has the browser, or nobody has taken it yet.
    return c.json(
      { error: result.error },
      result.error === "unknown_tab" ? 404 : 423,
    );
  }
  touchLocalBrowserSession(session.handle);
  return c.json({ ok: true });
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
function agentUserId(c: {
  get(key: string): unknown;
}): string | undefined {
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
  if (stored.closedAt) return { ok: false, status: 409, error: "session_closed" };
  // READS, NEVER STARTS. Launching a Chromium because an agent sent a command
  // to a session whose browser has gone would put a window on someone's desk
  // for a session they may have finished with; the caller re-opens explicitly.
  const live = findLocalBrowserSessionForProject(projectId);
  if (!live) return { ok: false, status: 409, error: "no_browser_session" };
  return { ok: true, session: stored, live };
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
  let handle;
  try {
    handle = await ensureLocalBrowserSession({
      projectId,
      contextMode: profile,
      ...(captureTypedText ? { captureTypedText: true } : {}),
    });
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
    attach,
    ...(captureTypedText ? { captureTypedText: true } : {}),
    ...(body?.captureScreenshots === false ? { captureScreenshots: false } : {}),
  });
  if (!opened.ok) {
    return c.json(
      {
        error: "nothing_to_attach",
        detail:
          "attach: 'require' was asked for and this project has no open " +
          "persistent browser session",
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
  if (!command || typeof command !== "object" || typeof command.op !== "string") {
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
    ...(typeof body?.commandId === "string" ? { commandId: body.commandId } : {}),
    ...(typeof body?.tabId === "string" ? { tabId: body.tabId } : {}),
    ...(isCorrelation(body?.correlation) ? { correlation: body.correlation } : {}),
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
  const live = findLocalBrowserSessionForProject(projectId);
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
    ...(typeof body?.commandId === "string" ? { commandId: body.commandId } : {}),
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
  const artifactId = typeof body?.artifactId === "string" ? body.artifactId : "";
  const mediaType =
    typeof body?.mediaType === "string" ? body.mediaType : "image/jpeg";
  if (!artifactId) return c.json({ error: "An artifactId is required" }, 400);
  let bytes: Buffer | undefined;
  try {
    bytes = await readArtifact({
      projectId,
      sessionId: validateSessionId(sessionId),
      artifactId,
      mediaType,
    });
  } catch {
    return c.json({ error: "invalid_session" }, 404);
  }
  if (!bytes) {
    // 410 rather than 404: this id was real and its payload has aged out, which
    // points the caller at the row's `evicted` marker rather than at a typo.
    return c.json({ error: "artifact_evicted", id: artifactId }, 410);
  }
  // `Uint8Array`, not `Buffer`: a `Buffer` is one, but the response body type
  // is the web `BodyInit` and naming the web type keeps this honest about what
  // is actually being written.
  return c.body(new Uint8Array(bytes), 200, {
    "content-type": mediaType,
    "content-length": String(bytes.byteLength),
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
  const live = findLocalBrowserSessionForProject(projectId);
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
  if (terminate && live) {
    // THIS browser, not every browser on the machine: another project's has
    // nothing to do with this session ending. The ordinary case needs none of
    // this — the idle reaper handles it, and a recent ledger row is activity.
    await closeLocalBrowserSession(live.handle.bootId).catch(() => {});
  }
  return c.json({ session, terminated: terminate });
});


export default computers;
