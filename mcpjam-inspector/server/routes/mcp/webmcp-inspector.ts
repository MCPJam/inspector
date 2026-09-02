import { Hono } from "hono";
import type { Context } from "hono";
import type { BrowserSessionHandle } from "../../services/browserd/browser-session.js";
import { z } from "zod";
import "../../types/hono";
import {
  HOSTED_MODE,
  WEBMCP_INSPECTOR_ENABLED,
  hostedBrowserEnabled,
  webmcpInspectorHostedEnabled,
} from "../../config";
import {
  hostedSessionId,
  startWebMcpSession,
  webMcpSessions,
  wireWebMcpShutdown,
  WebMcpSessionCapacityError,
  WebMcpSessionNotFoundError,
  WebMcpSessionUnavailableError,
} from "../../services/webmcp-inspector/session-registry";
import {
  WebMcpChromiumNotInstalledError,
  WebMcpInvocationCancelledError,
  WebMcpLeaseBlockedError,
  WebMcpNoDisplayError,
  WebMcpOutcomeUnknownError,
  WebMcpToolGoneError,
  WebMcpUnsupportedError,
} from "../../services/webmcp-inspector/provider";
import { WebMcpQueueFullError } from "../../services/webmcp-inspector/session-runtime";
import { createBrowserdWebMcpProvider } from "../../services/webmcp-inspector/browserd-provider";
import {
  createElectronWebviewProvider,
  WebMcpWebviewAttachError,
} from "../../services/webmcp-inspector/electron-webview-provider";
import { ensureLiveBrowserSession } from "../../services/browserd/live-session-deps.js";
import { classifyHostedReserveError } from "../../services/browserd/hosted-reserve-refusal.js";
import {
  HostedDesktopAsleepError,
  resolveHostedSession,
} from "../../services/webmcp-inspector/hosted-session-resolver.js";
import type { WebMcpSessionRuntime } from "../../services/webmcp-inspector/session-runtime";
import { touchBrowserSession } from "../../services/browserd/browser-sessions-client.js";
import { touchComputerActivity } from "../../utils/computers/control-plane-client.js";
import { shouldTouchActivity } from "../../utils/computers/activity-touch.js";
import { isHostedDesktopProvisionable } from "../../utils/computers/runtime-config.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import {
  WEBMCP_INPUT_BATCH_LIMIT,
  WEBMCP_INPUT_TEXT_MAX_CHARS,
  type WebMcpInvocationState,
} from "@/shared/webmcp-inspector-protocol";

/**
 * webmcp-inspector.ts — a managed browser pointed at a page, so its WebMCP
 * tools can be listed, invoked, and watched:
 *
 *   POST   /api/mcp/webmcp/sessions              open a browser at a URL
 *   GET    /api/mcp/webmcp/sessions/:id          session + current tool set
 *   GET    /api/mcp/webmcp/sessions/:id/events   SSE: session/tools/activity
 *   POST   /api/mcp/webmcp/sessions/:id/command  navigate / invoke / cancel /
 *                                                 stream the viewport
 *   DELETE /api/mcp/webmcp/sessions/:id          close + dispose
 *
 * TWO MOUNTS, one router. Locally it hangs off `/api/mcp/webmcp`, where
 * `/api/mcp/*` is itself local-only. On a hosted replica the same router is
 * mounted at `/api/web/webmcp` (see `routes/web/index.ts`), behind bearer auth
 * and a VERIFIED identity — the difference matters, see `hostedIdentity`.
 *
 * Hosted mode forces `transport: "hosted"` and refuses every local shape
 * explicitly rather than by being unreachable: a hosted replica has no display
 * to open a window on and no `<webview>` to attach to, and saying so with a
 * code the UI can explain beats a 404 on a route the client can plainly see.
 * `WEBMCP_INSPECTOR_ENABLED` is the kill switch in both modes;
 * `webmcpInspectorHostedEnabled()` is the separate hosted-reachability gate;
 * the client-side gate is the `webmcp-inspector-enabled` flag.
 *
 * The browser opens as a real window on the machine running the inspector: the
 * developer drives their own page directly, and this API is the instrument
 * panel beside it, not a remote control for it.
 *
 * One session shape inverts that. Inside the desktop app the client can mount
 * a real Chromium surface itself and pass its `webContentsId` here; the server
 * then ATTACHES to a browser it did not start, and disposing detaches without
 * destroying anything. The field is optional on purpose — an older server
 * strips it and starts an ordinary in-app session, so a newer client degrades
 * rather than fails.
 */

// Tear down live browsers on process shutdown (idempotent).
wireWebMcpShutdown();

const webmcpInspector = new Hono();

const httpUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Enter an http:// or https:// URL." },
  );

/**
 * WHERE the browser runs, chosen per session rather than per deployment.
 *
 * `local` (the default, and what every existing caller gets by omitting the
 * field) opens Chromium on the machine running this inspector — the V1
 * behaviour, unchanged.
 *
 * `hosted` runs it on the member's MCPJam computer through browserd and
 * reports `remote-interactive-url`, so the viewport lives in the Browser
 * panel. It is opt-IN and never inferred: a hosted session reserves a desktop
 * computer and bills for its awake time, and silently spending someone's
 * credits because they clicked "Open browser" is not a default anyone would
 * choose. It also cannot reach `localhost` — the browser is in a datacenter,
 * so the page has to be somewhere that datacenter can fetch.
 */
const startSchema = z.object({
  url: httpUrlSchema,
  transport: z.enum(["local", "hosted"]).optional(),
  /** Required for `hosted`: the project whose desktop computer is reserved. */
  projectId: z.string().min(1).optional(),
  /**
   * WHERE the person looks at and drives the page.
   *
   * OMITTED MEANS `window`, which is the V1 behaviour: a real Chrome window on
   * this machine. That default is on the WIRE, so an older client and any
   * programmatic caller keep exactly what they have. The inspector's own UI
   * sends `in-app` explicitly, because in-app is what a person opening the
   * screen now expects — but that is a choice the UI makes, not one this schema
   * makes for everybody.
   */
  display: z.enum(["window", "in-app"]).optional(),
  /**
   * A `<webview>` the desktop app's renderer has already mounted, to attach to
   * instead of launching a browser.
   *
   * OPTIONAL, and the whole compatibility story lives in that: an older server
   * strips the field and starts an ordinary in-app (frame-stream) session, so a
   * newer client degrades to the previous experience rather than failing. It is
   * also never inferred — the id is a fact only the client can know, and the
   * checks below refuse it anywhere it could not be true.
   */
  webContentsId: z.number().int().positive().optional(),
});

/**
 * One input event, bounded at the HTTP boundary.
 *
 * `finite()` rather than a bare `number()` on every coordinate: JSON carries no
 * NaN, but a client computing a scale factor from a zero-height pane produces
 * one, and `JSON.stringify` turns it into `null` — which a permissive schema
 * would coerce rather than refuse. Negative coordinates are refused for the
 * same reason they are clamped downstream: they are never a thing a person did
 * to the pane.
 */
const coordinate = z.number().finite().nonnegative();
const modifiersSchema = z
  .object({
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  })
  .optional();
const mouseButtonSchema = z.enum(["left", "middle", "right"]);
/** Bounded so one event cannot ask the browser to hold a key name of any size. */
const keyNameSchema = z.string().min(1).max(64);

const inputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse_move"),
    x: coordinate,
    y: coordinate,
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("mouse_down"),
    x: coordinate,
    y: coordinate,
    button: mouseButtonSchema,
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("mouse_up"),
    x: coordinate,
    y: coordinate,
    button: mouseButtonSchema,
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("wheel"),
    x: coordinate,
    y: coordinate,
    // Deltas are signed — scrolling up is a negative number, not an error.
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("key_down"),
    key: keyNameSchema,
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("key_up"),
    key: keyNameSchema,
    modifiers: modifiersSchema,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().max(WEBMCP_INPUT_TEXT_MAX_CHARS),
  }),
]);

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: httpUrlSchema }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("go_back") }),
  z.object({
    type: z.literal("invoke_tool"),
    toolKey: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    source: z.enum(["manual", "chat"]).default("manual"),
    /**
     * The client's own id for this invocation, making the call idempotent.
     *
     * Optional, so every existing caller is unchanged: omitted, the server
     * issues one exactly as before. A hosted client sends it because its
     * request can be dropped mid-flight or retried onto another replica, and
     * "did that go through?" must not be answerable only by running the tool
     * again.
     */
    invokeId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("cancel_invocation"),
    invokeId: z.string().min(1),
  }),
  z.object({ type: z.literal("capture_screenshot") }),
  z.object({ type: z.literal("set_screencast"), enabled: z.boolean() }),
  z.object({
    type: z.literal("input"),
    events: z.array(inputEventSchema).min(1).max(WEBMCP_INPUT_BATCH_LIMIT),
  }),
]);

/**
 * One place that maps a thrown error to a status.
 *
 * Handlers that each re-derive "capacity is 429, missing is 404" are handlers
 * that drift apart invisibly, because each one's own tests keep passing.
 */
function webMcpErrorResponse(c: Context, error: unknown, fallback: string) {
  if (error instanceof HostedIdentityError) {
    return error.response;
  }
  if (error instanceof HostedDesktopAsleepError) {
    // 409, and deliberately NOT a wake. Re-hydration is reached from reads —
    // a page refresh, a reconnecting event stream — and provisioning from
    // those would resurrect a computer its owner let sleep, and bill for it.
    return c.json({ error: error.message, code: "hosted-desktop-asleep" }, 409);
  }
  if (error instanceof WebMcpSessionNotFoundError) {
    return c.json({ error: error.message, code: "session-not-found" }, 404);
  }
  if (error instanceof WebMcpSessionCapacityError) {
    return c.json({ error: error.message, code: "capacity" }, 429);
  }
  if (error instanceof WebMcpQueueFullError) {
    return c.json({ error: error.message, code: "queue-full" }, 429);
  }
  if (error instanceof WebMcpSessionUnavailableError) {
    return c.json({ error: error.message, code: "shutting-down" }, 503);
  }
  if (error instanceof WebMcpChromiumNotInstalledError) {
    return c.json(
      { error: error.message, code: "chromium-not-installed" },
      503,
    );
  }
  if (error instanceof WebMcpNoDisplayError) {
    return c.json({ error: error.message, code: "no-display" }, 503);
  }
  if (error instanceof WebMcpUnsupportedError) {
    // 501, not 500: the request was fine and the server is healthy — this
    // browser build simply cannot do WebMCP, and the UI says exactly that.
    return c.json({ error: error.message, code: "webmcp-unsupported" }, 501);
  }
  if (error instanceof WebMcpToolGoneError) {
    return c.json({ error: error.message, code: "tool-gone" }, 409);
  }
  if (error instanceof WebMcpLeaseBlockedError) {
    // 423 Locked, and NOT a 500 with a Sentry event, which is what a person
    // pressing the panel's take-control button used to produce. The remedy is
    // theirs and obvious: hand the browser back.
    return c.json({ error: error.message, code: "lease-blocked" }, 423);
  }
  // A control-plane refusal that reached here rather than the start route's
  // own handling — a re-hydration whose computer is gone, say.
  const hostedRefusal = classifyHostedReserveError(error);
  if (hostedRefusal) {
    return c.json(
      { error: hostedRefusal.error, code: hostedRefusal.code },
      hostedRefusal.status,
    );
  }
  if (error instanceof WebMcpWebviewAttachError) {
    // 400, not 500: the id the client sent no longer names a surface we can
    // attach to (its pane unmounted, or devtools took the debugger slot). The
    // request was malformed by the time it arrived, and the fix is the client's.
    return c.json({ error: error.message, code: "webview-attach-failed" }, 400);
  }
  reportRouteFailure("[webmcp] unhandled route error", error, {
    source: "mcp.webmcp-inspector",
    hop: "mcpjam_internal",
  });
  return c.json(
    { error: error instanceof Error ? error.message : fallback },
    500,
  );
}

/**
 * Is this router reachable at all?
 *
 * Two independent switches, both of which answer 404 rather than 403: a
 * capability that is off should not be discoverable, and a 403 tells a prober
 * that the route exists and is merely closed to them.
 */
function webmcpInspectorReachable(): boolean {
  if (!WEBMCP_INSPECTOR_ENABLED) return false;
  return !HOSTED_MODE || webmcpInspectorHostedEnabled();
}

webmcpInspector.use("*", async (c, next) => {
  if (!webmcpInspectorReachable()) {
    return c.json(
      { error: "Not found", code: "webmcp-inspector-disabled" },
      404,
    );
  }
  await next();
});

/**
 * The VERIFIED identity behind a hosted request, or a refusal.
 *
 * `bearerAuthMiddleware` does not verify WorkOS session JWTs. It validates
 * `sk_` API keys and guest tokens and then lets any other bearer through
 * labelled `unverified_passthrough`, on the explicit understanding — stated in
 * that middleware — that a route which does not forward the bearer to Convex
 * must verify it itself. This router is exactly such a route: once a hosted
 * session is registered, its subsequent commands are served out of an
 * in-process map, and nothing downstream ever re-checks who is asking. Without
 * this, `Authorization: Bearer anything` plus a session id would drive someone
 * else's desktop browser.
 *
 * Guests are refused before anything else. A guest has no computer to bill and
 * no organization to check, and `getComputerStatus` admits them — so a guest
 * bearer must never reach it.
 */
function hostedIdentity(
  c: Context,
): { ok: true; userId: string } | { ok: false; response: Response } {
  if (c.get("guestId")) {
    return {
      ok: false,
      response: c.json(
        {
          error:
            "Running a browser needs a signed-in MCPJam account — it runs on your own computer, which a guest session does not have.",
          code: "hosted-guest-unsupported",
        },
        403,
      ),
    };
  }
  // `requireVerifiedAuth` (mounted with this router) sets `workosUserId` for a
  // raw bearer it verified, and `bearerAuthMiddleware` sets it for an API-key
  // caller. Neither sets it for `unverified_passthrough`, which is the case
  // this exists to catch.
  const userId = c.get("workosUserId") ?? c.get("mcpjamUserId");
  if (typeof userId !== "string" || userId.length === 0) {
    return {
      ok: false,
      response: c.json(
        {
          error: "Sign in to run the browser on your MCPJam computer.",
          code: "hosted-auth-required",
        },
        401,
      ),
    };
  }
  return { ok: true, userId };
}

/**
 * Report an open, watched hosted session to the control plane.
 *
 * The panel's keepalive does this for a person WATCHING through the Browser
 * panel; this is the same signal for a person watching through the inspector's
 * own event stream. Sent as `kind: "panel"` rather than `"command"` because
 * that is what it is — presence, not work — and the backend applies its own
 * ceiling to presence so a tab left open over a weekend cannot hold a machine
 * awake indefinitely. Throttled per computer, like every other touch.
 */
function hostedPresence(runtime: WebMcpSessionRuntime): void {
  const target = runtime.hostedTarget();
  if (!target) return;
  void touchBrowserSession({ sessionId: target.sessionId, kind: "panel" })
    .then(({ counted }) => {
      if (counted && shouldTouchActivity(target.computerId)) {
        void touchComputerActivity({ computerId: target.computerId }).catch(
          () => {},
        );
      }
    })
    .catch(() => {});
}

/**
 * A refusal from `hostedIdentity` raised from somewhere that can only throw.
 * Carries the finished Response so the error mapper can return it verbatim.
 */
class HostedIdentityError extends Error {
  constructor(readonly response: Response) {
    super("hosted identity refused");
    this.name = "HostedIdentityError";
  }
}

/**
 * Keep the machine awake while somebody is using its browser.
 *
 * Two clocks, and they answer to different owners. The session row's decides
 * whether the daemon is swept; the computer's decides whether the box
 * hibernates. Both are the control plane's, and a browser being driven through
 * this route is invisible to both — the traffic is HTTP to a daemon, not bash
 * commands or PTY bytes, which are the only things that used to count.
 *
 * Fire-and-forget on purpose: losing a touch risks an earlier hibernate, while
 * awaiting one would put a control-plane round trip in front of every command
 * a person is waiting on.
 */
function hostedKeepAwake(info: {
  computerId: string;
  sessionId: string;
}): void {
  void touchBrowserSession({ sessionId: info.sessionId, kind: "command" })
    .then(({ counted }) => {
      // The backend decides whether this still counts (a session with no real
      // commands for hours stops counting, so a tab left open over a weekend
      // cannot hold a machine awake forever). Only a counted touch is worth
      // spending a computer write on.
      if (counted && shouldTouchActivity(info.computerId)) {
        void touchComputerActivity({ computerId: info.computerId }).catch(
          () => {},
        );
      }
    })
    .catch(() => {});
}

webmcpInspector.post("/sessions", async (c) => {
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      400,
    );
  }
  const { url, projectId, display, webContentsId } = parsed.data;
  // Hosted mode FORCES the hosted transport rather than defaulting to it. A
  // hosted replica has no display to open a window on and no `<webview>` to
  // attach to, so `local` is not a thing it could honour on request; leaving
  // the field respected would mean the omitted-means-local default silently
  // tried to launch Chromium on a container.
  const transport = HOSTED_MODE ? ("hosted" as const) : parsed.data.transport;

  if (HOSTED_MODE) {
    if (parsed.data.transport === "local" || display || webContentsId) {
      return c.json(
        {
          error:
            "This inspector runs the browser on your MCPJam computer. A browser on this machine needs the local inspector (npx @mcpjam/inspector).",
          code: "hosted-local-unsupported",
        },
        400,
      );
    }
    // The backend's own answer to "would a desktop actually boot?" — template
    // and rate, ignoring the tool catalog, which an inspector-only rollout
    // deliberately leaves off. Refused rather than attempted: without a rate
    // the machine boots and meters at the terminal price, which nobody
    // notices until the bill.
    if (isHostedDesktopProvisionable() === false) {
      return c.json(
        {
          error:
            "Hosted browsers are not configured on this deployment yet. Ask an operator to finish setting up the desktop runtime.",
          code: "hosted-desktop-unconfigured",
        },
        503,
      );
    }
  }

  if (display === "in-app" && transport === "hosted") {
    // Refused rather than silently downgraded. A hosted browser already has a
    // viewport — the Browser panel's stream, with its own take-control lease —
    // and honouring `in-app` would mean driving one desktop from two places
    // with nothing arbitrating between them.
    return c.json(
      {
        error:
          "A hosted browser is watched and driven from the Browser panel, not in this pane. Open it on this machine to use the in-app view.",
        code: "in-app-hosted-unsupported",
      },
      400,
    );
  }

  let provider;
  /** Set on the hosted path: the reserved daemon, and who it belongs to. */
  let handle: BrowserSessionHandle | undefined;
  let ownerId: string | undefined;
  if (webContentsId !== undefined) {
    // Both refusals are 400s that name what the caller got wrong, because both
    // describe a request that could never be honoured rather than a server that
    // failed to honour it.
    if (process.env.ELECTRON_APP !== "true") {
      return c.json(
        {
          error:
            "The embedded browser surface only exists inside the MCPJam desktop app.",
          code: "electron-only",
        },
        400,
      );
    }
    if (display !== "in-app") {
      // A surface the client mounted IS the in-app view. Honouring a window
      // request with it would report a transport whose pane the client is not
      // rendering, and the person would watch an empty box beside a browser
      // that never opened.
      return c.json(
        {
          error:
            'An embedded browser surface is the in-app view; ask for `display: "in-app"` or omit the surface.',
          code: "webview-display-mismatch",
        },
        400,
      );
    }
    provider = createElectronWebviewProvider({ webContentsId });
  } else if (transport === "hosted") {
    // Every refusal below is a 4xx with a code the UI can explain, never a
    // 500: each one is a thing the person can actually fix (turn the feature
    // on, pick a project, sign in).
    if (!hostedBrowserEnabled() && !webmcpInspectorHostedEnabled()) {
      return c.json(
        {
          error:
            "The hosted browser is not enabled on this server. Start it locally, or ask an operator to enable the hosted runtime.",
          code: "hosted-browser-disabled",
        },
        503,
      );
    }
    if (!projectId) {
      return c.json(
        {
          error:
            "Pick a project first — a hosted browser runs on that project's computer.",
          code: "hosted-project-required",
        },
        400,
      );
    }

    let bearer: string;
    if (HOSTED_MODE) {
      const identity = hostedIdentity(c);
      if (!identity.ok) return identity.response;
      ownerId = identity.userId;
      // The bearer Convex will accept for THIS caller: their own JWT verbatim,
      // or a freshly minted delegated one for an API-key caller.
      bearer = await getConvexBearerForRequest(c);
    } else {
      // The USER's control-plane bearer, exactly as the chat routes take it.
      // The hosted browser is billed to whoever owns the computer, so it needs
      // a real identity — unlike the local browser, which needs none because
      // it runs on the machine the caller is already sitting at.
      const header = c.req.header("authorization");
      if (!header) {
        return c.json(
          {
            error: "Sign in to run the browser on your MCPJam computer.",
            code: "hosted-auth-required",
          },
          401,
        );
      }
      bearer = header;
    }

    // Reserved HERE, before the session runtime exists, rather than lazily
    // inside `provider.createSession`. Two things were wrong with lazy:
    // `startWebMcpSession` had already taken a capacity slot and held it for
    // the whole E2B reserve-and-boot, and the provider called the thunk
    // without the request's abort signal, so a caller who gave up could not
    // stop a machine being provisioned for them. It also puts the refusal
    // where it can be mapped to a status — see the catch below.
    try {
      handle = await ensureLiveBrowserSession({
        bearer,
        projectId,
        // The inspector is a person driving their own page, so it gets the
        // persistent profile — the same rule the built-in browser tools
        // follow, and the reason evals get an ephemeral one instead.
        contextMode: "persistent",
        signal: c.req.raw.signal,
      });
    } catch (error) {
      const refusal = classifyHostedReserveError(error);
      if (refusal) {
        return c.json(
          { error: refusal.error, code: refusal.code },
          refusal.status,
        );
      }
      return webMcpErrorResponse(c, error, "Could not start your computer.");
    }
    provider = createBrowserdWebMcpProvider({ handle });
  }

  try {
    const session = await startWebMcpSession({
      url,
      ...(provider ? { provider } : {}),
      // Omitted means `window`, so a caller that never heard of this field gets
      // the behaviour it has always had.
      ...(display === "in-app" ? { viewportMode: "embedded" as const } : {}),
      // A hosted session gets a DERIVED id and an owner. The id is what lets
      // any replica find this session again; the owner is what stops anyone
      // else from doing so, since a derived id is guessable and a random one
      // was not.
      ...(handle && ownerId && projectId
        ? {
            sessionId: hostedSessionId(projectId, handle.computerId),
            ownerId,
          }
        : {}),
    });
    return c.json(session, 201);
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not open a browser session.");
  }
});

/**
 * The runtime for a request, whichever replica it landed on.
 *
 * Locally this is a map lookup. On a hosted replica a `hosted:` id may name a
 * session this process has never seen — the normal case behind a load balancer
 * with no affinity — and is re-derived instead of 404'd. Everything about that
 * lives in `hosted-session-resolver.ts`, including why it must never reserve.
 */
async function resolveRuntime(
  c: Context,
  sessionId: string,
): Promise<WebMcpSessionRuntime> {
  if (!HOSTED_MODE || !sessionId.startsWith("hosted:")) {
    return webMcpSessions.get(sessionId);
  }
  const identity = hostedIdentity(c);
  if (!identity.ok) throw new HostedIdentityError(identity.response);
  return resolveHostedSession({
    sessionId,
    bearer: await getConvexBearerForRequest(c),
    ownerId: identity.userId,
    registry: webMcpSessions,
    deps: {
      onCommand: hostedKeepAwake,
      hasWatchers: (id) => webMcpSessions.hasSubscribers(id),
    },
  });
}

webmcpInspector.get("/sessions/:id", async (c) => {
  try {
    const runtime = await resolveRuntime(c, c.req.param("id"));
    webMcpSessions.touch(runtime);
    return c.json({
      session: runtime.toPublic(),
      tools: runtime.currentTools(),
    });
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not read that session.");
  }
});

webmcpInspector.get("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  /**
   * Resolved BEFORE the stream is constructed, so a hosted session this
   * replica has never seen is re-hydrated rather than reported as gone.
   *
   * A refusal that names a CONDITION — an asleep computer, an unverified
   * caller — is answered as an ordinary HTTP error, because a 409 the client
   * can act on beats a 200 whose first frame says something went wrong.
   *
   * "No such session" is deliberately NOT one of those. It stays an in-stream
   * `session_gone`, which is the contract every existing client is written
   * against: an `EventSource` cannot read a status code, and turning this into
   * a 404 would leave those clients retrying a dead session forever instead of
   * showing the message this event carries.
   */
  let resolved: WebMcpSessionRuntime | undefined;
  let resolveError: unknown;
  try {
    resolved = await resolveRuntime(c, sessionId);
  } catch (error) {
    if (!(error instanceof WebMcpSessionNotFoundError)) {
      return webMcpErrorResponse(c, error, "Could not open that event stream.");
    }
    resolveError = error;
  }
  const replayParam = Number(c.req.query("replay") ?? "200");
  const replay = Number.isFinite(replayParam)
    ? Math.max(0, Math.min(500, replayParam))
    : 200;
  /**
   * `frames=off`: send everything BUT the viewport frames.
   *
   * For a client carrying frames on the binary WebSocket instead (see
   * `routes/web/webmcp-frames.ts`). Filtered HERE rather than in the hub,
   * which stays a clean fan-out: subscribers with different appetites are a
   * property of the transport, not of the session.
   *
   * Absent or any other value means frames flow, so a client that has never
   * heard of this parameter — every client older than the WebSocket — gets
   * exactly the stream it gets today.
   */
  const framesSuppressed = c.req.query("frames") === "off";

  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  /** Set by `start`, called by `pull`. See `pendingFrame`. */
  let flushPending: (() => void) | undefined;
  const encoder = new TextEncoder();

  // Shared by the abort listener and `cancel()`. A consumer that cancels the
  // stream without an abort event would otherwise leave the interval running
  // for the life of the process, enqueueing into a closed controller every 15
  // seconds with the throw swallowed.
  const teardown = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    // A held frame for a consumer that is gone is just retained bytes.
    pendingFrame = undefined;
    flushPending = undefined;
  };

  /**
   * The one frame this subscriber is behind on, if any.
   *
   * The hub's coalesced slot bounds what is REPLAYED; it does nothing for a
   * consumer that has stopped reading. Frames are the only event large enough
   * and frequent enough to matter there — 10fps at a 256 KiB cap is 2.5 MiB/s
   * into a `ReadableStream` queue that grows without limit while a client or
   * its network stalls. So a frame offered to a full queue is HELD here instead
   * of enqueued, exactly one of them, replaced by each newer one; `pull` sends
   * whatever survived once the consumer drains. Bounded memory, and no
   * permanently stale pane the way a plain drop would leave.
   *
   * Everything else is enqueued unconditionally: the timeline is small, bounded
   * by its own ring, and losing an entry to backpressure would silently corrupt
   * the record the session exists to produce.
   */
  let pendingFrame: Uint8Array | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          /* client went away mid-write */
        }
      };
      const send = (payload: unknown) => {
        const isFrame =
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: unknown }).type === "frame";
        // Dropped before it is even serialized, and dropped for REPLAYED
        // frames as well as live ones: `subscribe` delivers the retained frame
        // through this same closure, and a client on the binary socket would
        // otherwise still pay the base64-in-JSON tax once per connect.
        if (isFrame && framesSuppressed) return;
        const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
        if (isFrame) {
          const room = controller.desiredSize;
          if (room !== null && room <= 0) {
            pendingFrame = chunk;
            return;
          }
          pendingFrame = undefined;
        }
        write(chunk);
      };
      flushPending = () => {
        if (!pendingFrame) return;
        const chunk = pendingFrame;
        pendingFrame = undefined;
        write(chunk);
      };

      try {
        if (!resolved) throw resolveError ?? new Error("Session not found.");
        unsubscribe = webMcpSessions.subscribeTo(resolved, send, replay);
      } catch (error) {
        send({
          type: "session_gone",
          error: error instanceof Error ? error.message : "Session not found.",
        });
        controller.close();
        return;
      }

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          /* ignore */
        }
        // Watching IS using. Without this the idle clock only ever hears about
        // commands, so a session someone has open and is reading — the normal
        // way to watch an agent drive a page — is reaped mid-view.
        webMcpSessions.touchWatchedSessions();
        if (resolved) hostedPresence(resolved);
      }, 15_000);

      c.req.raw.signal.addEventListener("abort", () => {
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    /**
     * Called when the consumer has room again. Sending the held frame here is
     * what keeps a slow client's pane converging on the current paint instead
     * of freezing at whatever it last managed to read.
     */
    pull() {
      flushPending?.();
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Proxies that buffer would defeat the point of a live timeline.
      "X-Accel-Buffering": "no",
    },
  });
});

/**
 * What to tell a hosted caller about an invocation it just asked for.
 *
 * Every terminal state is a RESULT here, including the failures: the tool ran
 * (or was refused, or timed out), the timeline recorded it, and the client
 * needs to display that rather than receive an HTTP error for a page tool that
 * behaved exactly as the page decided.
 *
 * The abort case is the interesting one. If the request goes away, this stops
 * waiting — but the daemon's `webmcp_invoke` is synchronous and does not
 * report an invocation id until it has finished, so there is nothing to cancel
 * with and the tool keeps running. Reporting `cancelled` would be a lie about
 * a tool that may still be filling in a form. `unknown` is the true answer,
 * and the client can ask again with the same `invokeId` to find out how it
 * ended.
 */
async function outcomeOf(
  settled: Promise<{ output: unknown; truncated: boolean }>,
  c: Context,
): Promise<{ state: WebMcpInvocationState; error?: string }> {
  const aborted = new Promise<"aborted">((resolve) => {
    if (c.req.raw.signal.aborted) return resolve("aborted");
    c.req.raw.signal.addEventListener("abort", () => resolve("aborted"), {
      once: true,
    });
  });
  try {
    const result = await Promise.race([settled, aborted]);
    if (result === "aborted") return { state: "unknown" };
    return { state: "succeeded" };
  } catch (error) {
    if (error instanceof WebMcpOutcomeUnknownError) {
      return { state: "unknown", error: error.message };
    }
    if (error instanceof WebMcpInvocationCancelledError) {
      return { state: error.reason, error: error.message };
    }
    return {
      state: "failed",
      error: error instanceof Error ? error.message : "The tool failed.",
    };
  }
}

webmcpInspector.post("/sessions/:id/command", async (c) => {
  const parsed = commandSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid command." },
      400,
    );
  }
  const command = parsed.data;

  try {
    const runtime = await resolveRuntime(c, c.req.param("id"));
    webMcpSessions.touch(runtime);

    switch (command.type) {
      case "navigate":
      case "reload":
      case "go_back": {
        // Navigating out from under a running tool would settle it as a
        // mystery failure, so these wait for the page to be free.
        if (runtime.inFlight > 0) {
          return c.json(
            {
              error: "A tool is still running on this page. Wait or cancel it.",
              code: "busy",
            },
            409,
          );
        }
        await runtime.navigateCommand(command);
        return c.json({ ok: true });
      }
      case "invoke_tool": {
        const { invokeId, settled } = runtime.invoke(
          command.toolKey,
          command.input as Record<string, unknown>,
          command.source,
          command.invokeId,
        );
        // The caller follows the outcome on the activity stream; swallow the
        // rejection here so a failed tool is not an unhandled rejection.
        settled.catch(() => {});
        if (!HOSTED_MODE) {
          return c.json({ ok: true, invokeId }, 202);
        }
        // HOSTED answers with the outcome INLINE rather than pointing at the
        // event stream, because the subscriber watching that stream may be
        // attached to a different replica than the one running the tool. A
        // rejection is encoded here, not raised: the invocation settled and
        // the timeline recorded it, so this is a result, not a failure.
        return c.json({
          ok: true,
          invokeId,
          outcome: await outcomeOf(settled, c),
        });
      }
      case "cancel_invocation":
        return c.json({
          ok: true,
          cancelled: runtime.cancel(command.invokeId),
        });
      case "capture_screenshot":
        return c.json({
          ok: true,
          screenshotBase64: await runtime.screenshotNow(),
        });
      case "set_screencast":
        // `streaming` is the load-bearing half of this answer. A browser that
        // refuses `Page.startScreencast`, or a provider with no screencast at
        // all, still answers 200 — the request was fine — and the client reads
        // this flag to start polling screenshots instead of waiting forever.
        return c.json({
          ok: true,
          streaming: await runtime.setScreencast(command.enabled),
        });
      case "input":
        await runtime.dispatchInput(command.events);
        return c.json({ ok: true });
    }
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not run that command.");
  }
});

webmcpInspector.delete("/sessions/:id", async (c) => {
  try {
    const sessionId = c.req.param("id");
    if (HOSTED_MODE && sessionId.startsWith("hosted:")) {
      // IDEMPOTENT, and deliberately not a re-hydration. Closing a hosted
      // session drops this replica's handle to a browser that keeps running on
      // the member's computer — so a `DELETE` that lands on a replica which
      // never had that handle has nothing to do and has succeeded. Resolving
      // first would attach to a daemon purely in order to let go of it, and on
      // an asleep computer it would refuse to close a session at all.
      const identity = hostedIdentity(c);
      if (!identity.ok) return identity.response;
      const runtime = webMcpSessions.peek(sessionId);
      if (runtime && !runtime.belongsTo(identity.userId)) {
        return c.json({ closed: false });
      }
    }
    const closed = await webMcpSessions.close(sessionId);
    return c.json({ closed });
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not close that session.");
  }
});

export default webmcpInspector;
