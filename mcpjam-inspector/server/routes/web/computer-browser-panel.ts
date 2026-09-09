/**
 * Browser Panel data plane (`/api/web/computers/browser/*`).
 *
 * Three endpoints behind one auth check, backing the panel that lets a person
 * WATCH the browser an agent is driving and, when they need to, TAKE it:
 *
 *   GET  /session?ensure=1   → where to watch, and who holds the browser
 *   POST /lease              → take control / keep it / hand it back
 *   POST /input              → the held browser gets this person's pointer/keys
 *   POST /keepalive          → "this panel is still open"
 *   GET  /page-tools         → the WebMCP tools the current page declares, read
 *                              with the same observation the model's
 *                              the chat turn's page-tool peek sends (Tools pane)
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
import type { ComputerBrowserClaims } from "../../utils/computers/browser-token.js";
import {
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
  touchComputerActivity,
  wakePlaygroundSandbox,
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
  shouldTouchActivity,
  shouldTouchSessionCommand,
} from "../../utils/computers/activity-touch.js";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { browserProfileArchiveResponse } from "../../../shared/browser-session-header.js";

/** How long a panel's lease lives without a heartbeat. The panel beats every
 *  ~30s while visible; this is generous enough to survive a slow tab wake but
 *  short enough that a closed laptop parks the lease rather than holding the
 *  browser hostage. */
const LEASE_TTL_MS = 2 * 60_000;

/**
 * The most events one input request may carry, and what counts as one.
 *
 * Both now live in `shared/browser-pane-input.ts`, because the frame socket
 * validates the same shape (V-2) and the local route validates it too. Three
 * copies drifted silently: an event type added in one place was dropped by the
 * others with a 200 and no page change.
 */
const INPUT_BATCH_LIMIT = BROWSER_INPUT_BATCH_LIMIT;
const isInputEvent = isBrowserPaneInputEvent as (
  value: unknown,
) => value is ViewportInputEvent;

type Claims = ComputerBrowserClaims;

type AuthFailure = { status: 401 | 503; error: string };
type AuthResult = { ok: true; claims: Claims } | ({ ok: false } & AuthFailure);

/** Deps seam so the route is testable without E2B or a live Convex. */
export interface BrowserPanelDeps {
  verifyToken?: typeof verifyComputerBrowserToken;
  sandboxInfo?: typeof getComputerSandboxInfo;
  lookupSession?: typeof lookupBrowserSession;
  touchSession?: typeof touchBrowserSession;
  touchActivity?: typeof touchComputerActivity;
  wakeSandbox?: typeof wakePlaygroundSandbox;
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
  }) => Pick<
    BrowserdClient,
    "lease" | "leaseAction" | "sendInput" | "sendCommand"
  > & { exportProfile?: () => Promise<Uint8Array> };
  configured?: () => boolean;
}

function bearerFrom(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  return /^bearer\s+/i.test(header)
    ? header.replace(/^bearer\s+/i, "").trim()
    : "";
}

function browserTarget(
  claims: Claims,
): { computerId: string } | { sandboxRowId: string } {
  return claims.computerId
    ? { computerId: claims.computerId }
    : { sandboxRowId: claims.sandboxRowId };
}

function targetId(claims: Claims): string {
  return claims.computerId ?? claims.sandboxRowId;
}

export function createComputerBrowserPanelRoutes(
  deps: BrowserPanelDeps = {},
): Hono {
  const verifyToken = deps.verifyToken ?? verifyComputerBrowserToken;
  const sandboxInfo = deps.sandboxInfo ?? getComputerSandboxInfo;
  const lookupSession = deps.lookupSession ?? lookupBrowserSession;
  const touchSession = deps.touchSession ?? touchBrowserSession;
  const touchActivity = deps.touchActivity ?? touchComputerActivity;
  const wakeSandbox = deps.wakeSandbox ?? wakePlaygroundSandbox;
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

  /** Verify the token and re-check live ownership of the named browser box. */
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
    const info = await sandboxInfo(browserTarget(claims));
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
    target: { computerId: string } | { sandboxRowId: string },
    sessionId?: string,
  ): Promise<BrowserSessionRecord | null> {
    const lookup = await lookupSession({
      ...target,
      ...("sandboxRowId" in target ? { watched: true } : {}),
      expectedBundleHash: bundleHash(),
      // `"any"`: the panel is about THIS COMPUTER'S browser, whatever profile
      // it happens to be running. Pinning `persistent` here reported "no
      // browser" for a box that plainly had one, and — worse — paired with an
      // attach that then relaunched it into the other mode.
      expectedContextMode: "any",
    });
    if (!lookup.session) return null;
    if (sessionId && lookup.session.logicalSessionId !== sessionId) return null;
    return lookup.session;
  }

  /** Read the daemon's lease, degrading to `unknown` rather than failing the
   *  whole request: a panel that cannot say who holds the browser is still
   *  useful for watching it. */
  async function readLease(
    // COMPUTER-typed: this route only ever looks a session up by computer, and
    // narrowing here is what keeps the log line below honest about which box
    // could not answer.
    session: BrowserSessionRecord,
  ): Promise<BrowserdLeaseState | { state: "unknown" }> {
    try {
      return await createClient(session).lease();
    } catch (error) {
      logger.warn("[computers] browser panel could not read the lease", {
        target:
          session.target === "computer"
            ? session.computerId
            : session.sandboxRowId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { state: "unknown" };
    }
  }

  /**
   * Is this lease THIS caller's?
   *
   * Answered here because the pane cannot answer it. The holder is the
   * authenticated user id, which the client never sees and must not have to
   * guess: a pane that tracked "I acquired it" in its own state would forget
   * across a reload and then tell somebody who still holds the browser that
   * a stranger has it — with no way to hand it back, since only the holder
   * may. One boolean the server already knows removes that whole class.
   */
  function heldByCaller(
    lease: BrowserdLeaseState | { state: "unknown" },
    userId: string,
  ): boolean {
    return (
      (lease.state === "held" || lease.state === "parked") &&
      "holder" in lease &&
      lease.holder === userId
    );
  }

  const app = new Hono();

  app.get("/session", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { userId } = auth.claims;
    const target = browserTarget(auth.claims);
    const id = targetId(auth.claims);

    try {
      const ensure = c.req.query("ensure") === "1";
      let session = await currentSession(target, auth.claims.sessionId);
      if (!session && ensure) {
        if ("computerId" in target) {
          // Attach, never reserve: see `attachBrowserSession`. A panel must
          // not be able to provision a machine.
          await attachSession({ computerId: target.computerId });
        } else {
          // Returning to a watched Playground session is the one case where
          // ensure may wake a box: the row and provider id already exist, so
          // this attaches to durable state rather than provisioning a new
          // desktop behind the user's back.
          const woke = await wakeSandbox({
            bearer: bearerFrom(c),
            sandboxRowId: target.sandboxRowId,
          });
          if (!woke.ok) {
            return c.json(
              { ok: false, error: woke.error },
              woke.status === 503 ? 503 : 409,
            );
          }
        }
        session = await currentSession(target, auth.claims.sessionId);
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
      // NEITHER `streamUrl` NOR `streamPassword`. They used to be here, and
      // the panel put them straight into an iframe `src` — which made a
      // full desktop-control credential readable from the DOM, from
      // `document.referrer`, and from anything that logs iframe sources. The
      // browser now watches through `/computers/browser/stream`, which
      // authenticates upstream on the server with a password that never
      // leaves it.
      const lease = await readLease(session);
      return c.json({
        ok: true,
        ...(auth.claims.computerId
          ? { computerId: auth.claims.computerId }
          : {}),
        ...(auth.claims.sandboxRowId
          ? { sandboxRowId: auth.claims.sandboxRowId }
          : {}),
        sessionId: session.sessionId,
        bootId: session.bootId,
        contextMode: session.contextMode,
        lease,
        yours: heldByCaller(lease, userId),
      });
    } catch (error) {
      reportRouteFailure("browser panel session lookup failed", error, {
        source: "computer-browser-panel.session",
        hop: "mcpjam_internal",
        context: { browserTarget: id },
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
    const { userId } = auth.claims;
    const target = browserTarget(auth.claims);
    const id = targetId(auth.claims);

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
      const session = await currentSession(target, auth.claims.sessionId);
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
        browserTarget: id,
        action,
        took: outcome.took,
      });
      return c.json(
        {
          ok: outcome.took,
          lease: outcome.lease,
          bootId: session.bootId,
          yours: heldByCaller(outcome.lease, userId),
        },
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
        context: { browserTarget: id, action },
      });
      return c.json(
        { ok: false, error: "Failed to change the browser lease." },
        502,
      );
    }
  });

  /**
   * Forward a person's pointer and keys to the browser they hold.
   *
   * The hosted twin of `/api/mcp/computers/local-browser/input`, and the other
   * half of the frame socket: frames stream out, input comes back as ordinary
   * requests. The daemon gates every event on the lease being THIS holder's,
   * which is why the holder below cannot come from the caller.
   *
   * NOT a browser command. Input arrives at up to twenty batches a second
   * while somebody drags, and every command spends a slot from an idempotency
   * ledger that stops issuing ids once exhausted.
   */
  app.post("/input", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { userId } = auth.claims;
    const target = browserTarget(auth.claims);
    const id = targetId(auth.claims);

    // `null` is VALID JSON, so `c.req.json()` resolves rather than throwing —
    // and `body.events` on it then threw a TypeError that escaped every try
    // below and surfaced as a 500 for what is plainly a bad request.
    const parsed: unknown = await c.req.json().catch(() => undefined);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return c.json({ ok: false, error: "Expected a JSON object." }, 400);
    }
    const body = parsed as { events?: unknown; tabId?: unknown };
    // Sliced rather than refused, matching the local route: the daemon caps at
    // the same number and is the enforcement point, since it is reachable on
    // its own public host and a cap that lives only here is one an attacker
    // skips.
    const batch = Array.isArray(body.events)
      ? body.events.slice(0, INPUT_BATCH_LIMIT)
      : [];
    if (batch.length === 0) {
      return c.json(
        { ok: false, error: "At least one event is required." },
        400,
      );
    }
    // Refused whole rather than filtered: dropping the bad ones would deliver
    // a batch that is missing, say, the `mouse_up` of a drag, and the page
    // would be left holding a button down with nothing to say why.
    if (!batch.every(isInputEvent)) {
      return c.json({ ok: false, error: "invalid_input" }, 400);
    }
    const events = batch as ViewportInputEvent[];

    try {
      const session = await currentSession(target, auth.claims.sessionId);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      const outcome = await createClient(session).sendInput({
        // The authenticated USER, exactly as `/lease` derives it. The daemon
        // admits input when `holder === lease.holder`, so a holder read off the
        // request body would let anyone who echoed the right id type into
        // somebody else's held session — which is a password field, mid-login.
        holder: userId,
        events,
        ...(typeof body.tabId === "string" ? { tabId: body.tabId } : {}),
      });
      if (!outcome.ok) {
        // The daemon's own codes, unchanged. A 423 is the ORDINARY answer
        // while the agent is driving, not a failure: a pane that showed it as
        // an error would be reporting a browser working exactly as designed.
        //
        // Passed through by name rather than collapsed into 423, because 423
        // means "somebody else has this browser" and answering it to a batch
        // that was merely malformed or oversized would send a pane looking for
        // a lease holder who does not exist.
        //
        // And ONLY the daemon's own 423 becomes a 423. Everything else it can
        // answer — a 401 because the stored bearer no longer matches the boot,
        // a 500, an origin refusal — is an upstream failure, and dressing one
        // up as a lease refusal tells the pane to wait for a hand-back from a
        // holder who does not exist, forever.
        const status =
          outcome.status === 400 ||
          outcome.status === 404 ||
          outcome.status === 413 ||
          outcome.status === 423
            ? outcome.status
            : 502;
        return c.json({ ok: false, error: outcome.error }, status);
      }
      // A person typing is REAL USE, and `kind: "command"` says so. The panel
      // keepalive stops counting once the last real command is old enough —
      // which is exactly the case here, because somebody who took control to
      // solve a CAPTCHA issues no agent commands at all. Left as a panel
      // touch, their box would hibernate while they were typing into it.
      //
      // BOTH touches are throttled, each on its OWN key, and only on a
      // dispatch that actually landed — refused input reached no page and must
      // not hold a machine awake. Input arrives twenty times a second and every
      // touch is a control-plane write, so an ungated one is tens of writes a
      // second per viewer.
      //
      // Separate keys because they are separate clocks: the session touch
      // patches the browser session row (and, for a sandbox box, that box's
      // `lastUsedAt` in the same transaction) and a watched Playground box has
      // no computer id at all, so keying it by computer would leave the
      // sandbox branch ungated — which is exactly what it used to be. Both are
      // leading-edge, so the first input after a pause still writes at once.
      if (shouldTouchSessionCommand(session.sessionId)) {
        void touchSession({
          sessionId: session.sessionId,
          kind: "command",
        }).catch(() => {});
      }
      if (
        auth.claims.computerId &&
        shouldTouchActivity(auth.claims.computerId)
      ) {
        void touchActivity({ computerId: auth.claims.computerId }).catch(
          () => {},
        );
      }
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof BrowserdClientError) {
        return c.json(
          { ok: false, error: "The browser did not accept the input." },
          502,
        );
      }
      reportRouteFailure("browser panel input failed", error, {
        source: "computer-browser-panel.input",
        hop: "mcpjam_internal",
        context: { browserTarget: id },
      });
      return c.json(
        { ok: false, error: "Failed to send input to the browser." },
        502,
      );
    }
  });

  app.post("/keepalive", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const target = browserTarget(auth.claims);
    const id = targetId(auth.claims);

    try {
      const session = await currentSession(target, auth.claims.sessionId);
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
      if (
        counted &&
        auth.claims.computerId &&
        shouldTouchActivity(auth.claims.computerId)
      ) {
        // Fire-and-forget: a failed touch only risks an earlier hibernate.
        void touchActivity({ computerId: auth.claims.computerId });
      }
      return c.json({ ok: true, counted });
    } catch (error) {
      reportRouteFailure("browser panel keepalive failed", error, {
        source: "computer-browser-panel.keepalive",
        hop: "mcpjam_internal",
        context: { browserTarget: id },
      });
      return c.json(
        { ok: false, error: "Failed to record panel activity." },
        502,
      );
    }
  });

  app.post("/profile/export", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const target = browserTarget(auth.claims);
    try {
      const session = await currentSession(target, auth.claims.sessionId);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      const exportProfile = createClient(session).exportProfile;
      if (!exportProfile) {
        return c.json({ ok: false, error: "profile_export_unavailable" }, 409);
      }
      const archive = await exportProfile();
      return browserProfileArchiveResponse(archive, session.sessionId);
    } catch (error) {
      reportRouteFailure("browser profile export failed", error, {
        source: "computer-browser-panel.profile-export",
        hop: "mcpjam_internal",
        context: { browserTarget: target },
      });
      return c.json(
        { ok: false, error: "Failed to export the browser profile." },
        502,
      );
    }
  });

  /**
   * The WebMCP tools of the page the browser is on — what the Tools pane lists
   * beside the MCP servers' tools.
   *
   * READ-ONLY, and sent as the same `observe {mode:"webmcp_tools"}` the model's
   * chat turn's own page-tool peek sends, so the pane shows exactly the list the
   * model would be told. Goes through the daemon's ordinary command queue (an
   * observation is admitted between the agent's own commands) and is refused
   * under a held lease like any other observation — UNLESS the lease is this
   * caller's, in which case the read is re-sent as their own `manual` command,
   * because a person signing in should still be able to see what the page
   * offers. Never touches activity: a pane polling a tool list is not use, and
   * must not hold a metered box awake.
   */
  app.get("/page-tools", async (c) => {
    const auth = await authorize(c);
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
    const { userId } = auth.claims;
    const target = browserTarget(auth.claims);
    const id = targetId(auth.claims);
    const tabId = c.req.query("tabId");

    try {
      const session = await currentSession(target, auth.claims.sessionId);
      if (!session) {
        return c.json({ ok: false, error: "no_browser_session" }, 409);
      }
      const client = createClient(session);
      const observe = (source: "inspector" | "manual", holder?: string) =>
        client.sendCommand(
          webmcpToolsObserveCommand({
            source,
            ...(holder ? { holder } : {}),
            ...(tabId ? { tabId } : {}),
          }),
          session.bootId,
        );
      let response = await observe("inspector");
      if (response.status === "lease_blocked") {
        const lease = await readLease(session);
        if (heldByCaller(lease, userId)) {
          response = await observe("manual", userId);
        }
      }
      const mapped = pageToolsFromCommandResponse(response);
      return c.json(mapped.body, mapped.status);
    } catch (error) {
      if (error instanceof BrowserdClientError) {
        return c.json({ ok: false, error: "unreachable" }, 502);
      }
      reportRouteFailure("browser panel page-tools read failed", error, {
        source: "computer-browser-panel.page-tools",
        hop: "mcpjam_internal",
        context: { browserTarget: id },
      });
      return c.json({ ok: false, error: "unreachable" }, 502);
    }
  });

  return app;
}

export { resetActivityThrottleForTests as resetPanelActivityThrottleForTests } from "../../utils/computers/activity-touch.js";

export default createComputerBrowserPanelRoutes();
