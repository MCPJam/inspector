import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import "../../types/hono";
import { WEBMCP_INSPECTOR_ENABLED, hostedBrowserEnabled } from "../../config";
import {
  startWebMcpSession,
  webMcpSessions,
  wireWebMcpShutdown,
  WebMcpSessionCapacityError,
  WebMcpSessionNotFoundError,
  WebMcpSessionUnavailableError,
} from "../../services/webmcp-inspector/session-registry";
import {
  WebMcpChromiumNotInstalledError,
  WebMcpNoDisplayError,
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
import { reportRouteFailure } from "../../utils/route-error-report.js";
import {
  WEBMCP_INPUT_BATCH_LIMIT,
  WEBMCP_INPUT_TEXT_MAX_CHARS,
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
 * LOCAL ONLY, by construction rather than by check: `/api/mcp/*` is mounted
 * only when `!HOSTED_MODE`, so a hosted replica never exposes these routes at
 * all. `WEBMCP_INSPECTOR_ENABLED` is the second, independent gate — the
 * emergency switch for a managed local install — and the client-side gate is
 * the `webmcp-inspector-enabled` flag.
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

// The capability is not discoverable when it is off: 404, not 403.
webmcpInspector.use("*", async (c, next) => {
  if (!WEBMCP_INSPECTOR_ENABLED) {
    return c.json(
      { error: "Not found", code: "webmcp-inspector-disabled" },
      404,
    );
  }
  await next();
});

webmcpInspector.post("/sessions", async (c) => {
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      400,
    );
  }
  const { url, transport, projectId, display, webContentsId } = parsed.data;

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
    if (!hostedBrowserEnabled()) {
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
          error: "Pick a project first — a hosted browser runs on that project's computer.",
          code: "hosted-project-required",
        },
        400,
      );
    }
    // The USER's control-plane bearer, exactly as the chat routes take it. The
    // hosted browser is billed to whoever owns the computer, so it needs a
    // real identity — unlike the local browser, which needs none because it
    // runs on the machine the caller is already sitting at.
    const bearer = c.req.header("authorization");
    if (!bearer) {
      return c.json(
        {
          error: "Sign in to run the browser on your MCPJam computer.",
          code: "hosted-auth-required",
        },
        401,
      );
    }
    provider = createBrowserdWebMcpProvider({
      ensureSession: ({ signal }) =>
        ensureLiveBrowserSession({
          bearer,
          projectId,
          // The inspector is a person driving their own page, so it gets the
          // persistent profile — the same rule the built-in browser tools
          // follow, and the reason evals get an ephemeral one instead.
          contextMode: "persistent",
          ...(signal ? { signal } : {}),
        }),
    });
  }

  try {
    const session = await startWebMcpSession({
      url,
      ...(provider ? { provider } : {}),
      // Omitted means `window`, so a caller that never heard of this field gets
      // the behaviour it has always had.
      ...(display === "in-app" ? { viewportMode: "embedded" as const } : {}),
    });
    return c.json(session, 201);
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not open a browser session.");
  }
});

webmcpInspector.get("/sessions/:id", (c) => {
  try {
    return c.json(webMcpSessions.describe(c.req.param("id")));
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not read that session.");
  }
});

webmcpInspector.get("/sessions/:id/events", (c) => {
  const sessionId = c.req.param("id");
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
        unsubscribe = webMcpSessions.subscribe(sessionId, send, replay);
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
    const runtime = webMcpSessions.get(c.req.param("id"));
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
        );
        // The caller follows the outcome on the activity stream; swallow the
        // rejection here so a failed tool is not an unhandled rejection.
        settled.catch(() => {});
        return c.json({ ok: true, invokeId }, 202);
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
    const closed = await webMcpSessions.close(c.req.param("id"));
    return c.json({ closed });
  } catch (error) {
    return webMcpErrorResponse(c, error, "Could not close that session.");
  }
});

export default webmcpInspector;
