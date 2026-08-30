/**
 * Browser Panel data plane (`/api/web/computers/browser/*`).
 *
 * Three endpoints behind one auth check, backing the panel that lets a person
 * WATCH the browser an agent is driving and, when they need to, TAKE it:
 *
 *   GET  /session?ensure=1   → where to watch, and who holds the browser
 *   POST /lease              → take control / keep it / hand it back
 *   POST /keepalive          → "this panel is still open"
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
  /** Establish a session on an already-owned computer (`ensure=1`). */
  attachSession?: (args: {
    computerId: string;
    signal?: AbortSignal;
  }) => Promise<{
    bootId: string;
    streamUrl: string;
    streamPassword: string;
    publicOrigin: string;
    browserdToken: string;
  }>;
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
      const handle = await attachBrowserSession(liveBrowserSessionDeps(), {
        computerId: args.computerId,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      // The handle's client is already built against the live daemon; the
      // caller re-looks-up to get the recorded origin + bearer, so only the
      // display fields are needed here.
      return {
        bootId: handle.bootId,
        streamUrl: handle.streamUrl,
        streamPassword: handle.streamPassword,
        publicOrigin: "",
        browserdToken: "",
      };
    });
  const createClient =
    deps.createClient ??
    ((session: { publicOrigin: string; browserdToken: string }) =>
      new BrowserdClient({
        baseUrl: session.publicOrigin,
        bearer: session.browserdToken,
      }));

  /** Verify the token and re-check live ownership of the named computer. */
  async function authorize(c: Context): Promise<AuthResult> {
    if (!configured()) {
      return {
        ok: false,
        status: 503,
        error: "Computers are not configured on this server.",
      };
    }
    const claims = await verifyToken(bearerFrom(c));
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
      expectedContextMode: "persistent",
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
        ok: true,
        computerId,
        bootId: session.bootId,
        streamUrl: session.streamUrl,
        streamPassword: session.streamPassword,
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
