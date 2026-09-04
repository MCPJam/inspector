/**
 * Browser Panel data plane (`/api/web/computers/browser/*`).
 *
 * Three endpoints behind one auth check, backing the panel that lets a person
 * WATCH the browser an agent is driving and, when they need to, TAKE it:
 *
 *   GET  /session?ensure=1   → where to watch, and who holds the browser
 *   POST /lease              → take control / keep it / hand it back
 *   POST /keepalive          → "this panel is still open"
 *   POST /open-desktop       → take the lease before the desktop opens
 *   GET  /desktop?t=<token>  → redirect into the full desktop, password added
 *                              server-side
 *
 * Auth mirrors `computer-upload.ts`: the browser mints a ~60s Convex browser
 * token (`projectComputers.mintBrowserToken`) and sends it as
 * `Authorization: Bearer <jwt>`; we verify its RS256 signature against the
 * backend-published JWKS and re-check the row's CURRENT owner and project
 * against the token's claims before touching anything. That recheck is not
 * redundant with the mint: the token is valid for a minute, and ownership can
 * change inside it.
 *
 * VIEW BY DEFAULT (L10). `GET /session` returns the stream URL whether or not
 * anyone holds the lease. Watching is the safe, common case — the whole point
 * of the panel is that a person can see what the agent is doing — and gating
 * the view behind "take control" would push people into taking control just to
 * look, which is the disruptive action.
 *
 * THE STREAM PASSWORD NEVER REACHES THE CLIENT. It used to ride in
 * `GET /session`, and the panel pasted it into an iframe URL — so the secret
 * that authenticates the whole desktop (keyboard, clipboard, every open
 * window) sat in a JSON body, in React state, and in a URL, for everyone who
 * merely wanted to WATCH. It is now handed to the stream by the redirect at
 * `GET /desktop`, which gives it out only to whoever the daemon currently says
 * holds the lease — and `POST /open-desktop` is what takes that lease: the
 * full desktop drives the page OUTSIDE the daemon, so a person on it is
 * invisible to the lease unless taking it is what opens the door.
 *
 * The redirect authenticates from `?t=`, the SAME ~60s Convex browser token
 * every other route here takes as a bearer, because a top-level navigation
 * cannot carry a header. It was briefly a bespoke single-use ticket held in a
 * module-level Map, which was wrong on a horizontally scaled deployment: the
 * POST mints on one replica and the navigation lands on another, whose map is
 * empty. Verifying a signature (RS256 against the published JWKS) needs no
 * shared state at all, so every replica answers identically. True single use
 * would need shared durable state — a Convex row — which is a backend change,
 * and what it buys over "expires in a minute AND you must still hold the
 * lease" is small.
 *
 * Residual, stated rather than claimed away: noVNC authenticates from its
 * query string, so the password does land in the new tab's address bar, and
 * the token above lands in this server's access log for one request. What this
 * removes is every copy of the PASSWORD that a watcher never needed — the API
 * body, the client's memory, and any log or bug report that captured either —
 * and the two credentials are not comparable: the token is scoped to one
 * user, one computer and one minute, while the password authenticates the
 * whole desktop for as long as the stream lives.
 *
 * The panel PERSISTS NOTHING. It is a live view: no frames, no DOM, no
 * recording. In particular it does not write `browserInteractionSteps` — that
 * table is the eval-replay envelope anchored to chat sessions, and a human
 * poking at a browser is not a replayable agent step. If durable panel history
 * is ever wanted it needs its own table, not a borrowed one.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { verifyComputerBrowserToken } from "../../utils/computers/browser-token.js";
import {
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
  touchComputerActivity,
} from "../../utils/computers/control-plane-client.js";
import {
  lookupBrowserSession,
  touchBrowserSession,
  type BrowserSessionRecord,
} from "../../services/browserd/browser-sessions-client.js";
import {
  BrowserdClient,
  BrowserdClientError,
  type BrowserdLeaseState,
} from "../../services/browserd/browserd-client.js";
import {
  browserdBundleHash,
  liveBrowserSessionDeps,
} from "../../services/browserd/live-session-deps.js";
import { attachBrowserSession } from "../../services/browserd/browser-session.js";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

/** How long a panel's lease lives without a heartbeat. The panel beats every
 *  ~30s while visible; this is generous enough to survive a slow tab wake but
 *  short enough that a closed laptop parks the lease rather than holding the
 *  browser hostage. */
const LEASE_TTL_MS = 2 * 60_000;
/** Don't touch computer activity more than once a minute per panel. */
const ACTIVITY_TOUCH_THROTTLE_MS = 60_000;


type Claims = { userId: string; computerId: string; projectId: string };

type AuthFailure = { status: 401 | 503; error: string };
type AuthResult = { ok: true; claims: Claims } | { ok: false } & AuthFailure;

/** Deps seam so the route is testable without E2B or a live Convex. */
export interface BrowserPanelDeps {
  verifyToken?: typeof verifyComputerBrowserToken;
  sandboxInfo?: typeof getComputerSandboxInfo;
  lookupSession?: typeof lookupBrowserSession;
  touchSession?: typeof touchBrowserSession;
  touchActivity?: typeof touchComputerActivity;
  bundleHash?: () => string;
  /**
   * Establish a session on an already-owned computer (`ensure=1`).
   *
   * Returns nothing on purpose. The recorded ROW is the source of truth for
   * what the panel then reports — an attach may have adopted another
   * replica's session rather than booting its own — so the route re-reads it
   * either way. A richer return type here would just be data nobody reads,
   * and an empty-string placeholder in it is exactly the kind of thing a
   * later caller trusts by mistake.
   */
  attachSession?: (args: {
    computerId: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  /** Build a daemon client for a recorded session. */
  createClient?: (session: {
    publicOrigin: string;
    browserdToken: string;
  }) => Pick<BrowserdClient, "lease" | "leaseAction">;
  configured?: () => boolean;
}

function bearerFrom(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  return /^bearer\s+/i.test(header)
    ? header.replace(/^bearer\s+/i, "").trim()
    : "";
}

/**
 * The desktop redirect's credential, which cannot be a header.
 *
 * A top-level navigation sends no `Authorization`, so the one route a person
 * NAVIGATES to takes the same token in `?t=`. Same token, same verification,
 * same claims — only the envelope differs.
 */
function queryTokenFrom(c: Context): string {
  return (c.req.query("t") ?? "").trim();
}

export function createComputerBrowserPanelRoutes(
  deps: BrowserPanelDeps = {},
): Hono {
  const verifyToken = deps.verifyToken ?? verifyComputerBrowserToken;
  const sandboxInfo = deps.sandboxInfo ?? getComputerSandboxInfo;
  const lookupSession = deps.lookupSession ?? lookupBrowserSession;
  const touchSession = deps.touchSession ?? touchBrowserSession;
  const touchActivity = deps.touchActivity ?? touchComputerActivity;
  const bundleHash = deps.bundleHash ?? browserdBundleHash;
  const configured = deps.configured ?? isComputersDataPlaneConfigured;
  const attachSession =
    deps.attachSession ??
    (async (args: { computerId: string; signal?: AbortSignal }) => {
      await attachBrowserSession(liveBrowserSessionDeps(), {
        computerId: args.computerId,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    });
  const createClient =
    deps.createClient ??
    ((session: { publicOrigin: string; browserdToken: string }) =>
      new BrowserdClient({
        baseUrl: session.publicOrigin,
        bearer: session.browserdToken,
      }));

  /** Verify the token and re-check live ownership of the named computer. */
  async function authorize(
    c: Context,
    tokenFrom: (c: Context) => string = bearerFrom,
  ): Promise<AuthResult> {
    if (!configured()) {
      return {
        ok: false,
        status: 503,
        error: "Computers are not configured on this server.",
      };
    }
    const claims = await verifyToken(tokenFrom(c));
    // One message for every rejection below: a caller learning WHICH check
    // failed learns whether a computer id exists and who owns it.
    const unauthorized = {
      ok: false as const,
      status: 401 as const,
      error: "Invalid or expired browser token.",
    };
    if (!claims) return unauthorized;
    const info = await sandboxInfo({ computerId: claims.computerId });
    if (!info.ok) {
      return {
        ok: false,
        status: 503,
        error: `Computer unavailable: ${info.error}`,
      };
    }
    if (
      info.value.ownerUserId !== claims.userId ||
      info.value.projectId !== claims.projectId
    ) {
      return unauthorized;
    }
    return { ok: true, claims };
  }

  /** The live session row for this computer, or null. */
  async function currentSession(
    computerId: string,
  ): Promise<BrowserSessionRecord | null> {
    const lookup = await lookupSession({
      computerId,
      expectedBundleHash: bundleHash(),
      // `"any"`: the panel is about THIS COMPUTER'S browser, whatever profile
      // it happens to be running. Pinning `persistent` here reported "no
      // browser" for a box that plainly had one, and — worse — paired with an
      // attach that then relaunched it into the other mode.
      expectedContextMode: "any",
    });
    return lookup.session;
  }

  /** Read the daemon's lease, degrading to `unknown` rather than failing the
   *  whole request: a panel that cannot say who holds the browser is still
   *  useful for watching it. */
  async function readLease(
    session: BrowserSessionRecord,
  ): Promise<BrowserdLeaseState | { state: "unknown" }> {
    try {
      return await createClient(session).lease();
    } catch (error) {
      logger.warn("[computers] browser panel could not read the lease", {
        computerId: session.computerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { state: "unknown" };
    }
  }

  const app = new Hono();

  app.get("/session", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { computerId } = auth.claims;

    try {
      const ensure = c.req.query("ensure") === "1";
      let session = await currentSession(computerId);
      if (!session && ensure) {
        // Attach, never reserve: see `attachBrowserSession`. A panel must not
        // be able to provision a machine.
        await attachSession({ computerId });
        session = await currentSession(computerId);
      }
      if (!session) {
        return c.json(
          {
            ok: false,
            error: "no_browser_session",
            detail:
              "No browser is running on this computer yet. Start one from a " +
              "chat turn, or reopen this panel with ensure=1.",
          },
          409,
        );
      }
      return c.json({
        // No `streamPassword`, deliberately: see the module docstring. The URL
        // stays, because it is how the panel knows a desktop exists to offer —
        // and on its own it authenticates nobody.
        ok: true,
        computerId,
        bootId: session.bootId,
        streamUrl: session.streamUrl,
        contextMode: session.contextMode,
        lease: await readLease(session),
      });
    } catch (error) {
      reportRouteFailure("browser panel session lookup failed", error, {
        source: "computer-browser-panel.session",
        hop: "mcpjam_internal",
        context: { computerId },
      });
      return c.json(
        { ok: false, error: "Failed to resolve the browser session." },
        502,
      );
    }
  });

  app.post("/lease", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { computerId, userId } = auth.claims;

    let body: { action?: unknown; ttlMs?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Expected a JSON body." }, 400);
    }
    const action = body?.action;
    if (action !== "acquire" && action !== "heartbeat" && action !== "resume") {
      return c.json(
        { ok: false, error: "action must be acquire, heartbeat or resume." },
        400,
      );
    }

    try {
      const session = await currentSession(computerId);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      const ttlMs =
        typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)
          ? body.ttlMs
          : LEASE_TTL_MS;
      // The holder is the authenticated USER, not a client-chosen string: a
      // panel that could name its own holder could hand back a lease it never
      // took, resuming the agent while someone else is still typing.
      const outcome = await createClient(session).leaseAction({
        action,
        holder: userId,
        ttlMs,
      });
      logger.info("[computers] browser panel lease", {
        computerId,
        action,
        took: outcome.took,
      });
      return c.json(
        { ok: outcome.took, lease: outcome.lease, bootId: session.bootId },
        outcome.took ? 200 : 409,
      );
    } catch (error) {
      if (error instanceof BrowserdClientError) {
        return c.json(
          { ok: false, error: "The browser did not accept the lease change." },
          502,
        );
      }
      reportRouteFailure("browser panel lease change failed", error, {
        source: "computer-browser-panel.lease",
        hop: "mcpjam_internal",
        context: { computerId, action },
      });
      return c.json(
        { ok: false, error: "Failed to change the browser lease." },
        502,
      );
    }
  });

  /**
   * "Open full desktop": take the lease. The navigation follows separately.
   *
   * THE LEASE IS TAKEN HERE, not offered as a courtesy. The desktop view drives
   * the page through the stream, entirely outside the daemon — no command, no
   * queue, nothing the lease would otherwise see. So a person who opened it
   * while the browser read as `free` would be typing into a page the agent was
   * simultaneously screenshotting, which is the exact situation the lease
   * exists to make impossible. Taking it is what makes their presence visible.
   *
   * Two calls rather than one because a redirect cannot take the lease for
   * somebody: a GET that mutates is the wrong shape, and browsers prefetch and
   * re-issue GETs freely. The redirect below therefore only ever READS a lease
   * this call already took.
   */
  app.post("/open-desktop", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { computerId, userId } = auth.claims;

    try {
      const session = await currentSession(computerId);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      const outcome = await createClient(session).leaseAction({
        action: "acquire",
        holder: userId,
        ttlMs: LEASE_TTL_MS,
      });
      if (!outcome.took) {
        // Somebody else is mid-flow. Handing over the desktop would put two
        // people on one page.
        return c.json(
          { ok: false, error: "lease_held", lease: outcome.lease },
          409,
        );
      }
      logger.info("[computers] browser panel opened the full desktop", {
        computerId,
      });
      return c.json({ ok: true, lease: outcome.lease });
    } catch (error) {
      if (error instanceof BrowserdClientError) {
        return c.json(
          { ok: false, error: "The browser did not accept the lease change." },
          502,
        );
      }
      reportRouteFailure("browser panel open-desktop failed", error, {
        source: "computer-browser-panel.open-desktop",
        hop: "mcpjam_internal",
        context: { computerId },
      });
      return c.json({ ok: false, error: "Failed to open the desktop." }, 502);
    }
  });

  /**
   * Redirect into the stream with the password attached server-side.
   *
   * The credential is `?t=`, not a header, because this is the one route a
   * person NAVIGATES to and a navigation carries no `Authorization`. It is
   * verified exactly like every bearer here — RS256 against the published
   * JWKS, then the row's current owner and project re-checked — so any replica
   * can answer it, which a module-local ticket map could not.
   *
   * HOLDING THE LEASE IS THE SECOND GATE, and it is the one that matters: the
   * password is handed out only to the person the daemon currently says has
   * the browser. A token that sat in a tab while somebody else took control is
   * worth nothing, and neither is one whose hold was handed back. Re-read, not
   * remembered — including the session row, because a relaunch in between
   * rotates the password and the stale one would fail at the stream with a
   * message nobody can act on.
   */
  app.get("/desktop", async (c) => {
    const auth = await authorize(c, queryTokenFrom);
    if (!auth.ok) {
      // Plain text, not JSON: a person is looking at this in a tab.
      return c.text(
        auth.status === 503
          ? "Computers are not configured on this server."
          : "This desktop link has expired. Open the desktop again.",
        auth.status,
      );
    }
    const { computerId, userId } = auth.claims;

    try {
      const session = await currentSession(computerId);
      if (!session) {
        return c.text(
          "No browser is running on this computer any more.",
          409,
        );
      }
      const lease = await readLease(session);
      if (
        (lease.state !== "held" && lease.state !== "parked") ||
        lease.holder !== userId
      ) {
        // Either nobody holds it (handed back, or never taken) or somebody
        // else does. `unknown` lands here too: a lease we could not read is
        // not one we may act on.
        return c.text(
          "Somebody else is using this browser now. Open the desktop again to take control.",
          409,
        );
      }
      const target = new URL(session.streamUrl);
      target.searchParams.set("autoconnect", "true");
      target.searchParams.set("resize", "scale");
      target.searchParams.set("password", session.streamPassword);
      c.header("Cache-Control", "no-store");
      // So the stream's origin never receives this server's URL — and the
      // token in it — as a Referer.
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(target.toString(), 302);
    } catch (error) {
      reportRouteFailure("browser panel desktop redirect failed", error, {
        source: "computer-browser-panel.desktop",
        hop: "mcpjam_internal",
        context: { computerId },
      });
      return c.text("Failed to open the desktop.", 502);
    }
  });

  app.post("/keepalive", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { computerId } = auth.claims;

    try {
      const session = await currentSession(computerId);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      // The backend decides whether an open panel still counts — it stops
      // counting once the browser has been idle of real commands for a while,
      // so a tab left open over a weekend cannot hold a machine awake forever.
      const { counted } = await touchSession({
        sessionId: session.sessionId,
        kind: "panel",
      });
      if (counted && shouldTouchActivity(computerId)) {
        // Fire-and-forget: a failed touch only risks an earlier hibernate.
        void touchActivity({ computerId });
      }
      return c.json({ ok: true, counted });
    } catch (error) {
      reportRouteFailure("browser panel keepalive failed", error, {
        source: "computer-browser-panel.keepalive",
        hop: "mcpjam_internal",
        context: { computerId },
      });
      return c.json(
        { ok: false, error: "Failed to record panel activity." },
        502,
      );
    }
  });

  return app;
}

/** Per-computer throttle for the activity touch. */
const lastActivityTouchAt = new Map<string, number>();

function shouldTouchActivity(computerId: string): boolean {
  const now = Date.now();
  const previous = lastActivityTouchAt.get(computerId) ?? 0;
  if (now - previous < ACTIVITY_TOUCH_THROTTLE_MS) return false;
  lastActivityTouchAt.set(computerId, now);
  return true;
}

export function resetPanelActivityThrottleForTests(): void {
  lastActivityTouchAt.clear();
}

export default createComputerBrowserPanelRoutes();
