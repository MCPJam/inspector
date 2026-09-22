import { Hono } from "hono";
import type { Context } from "hono";
import "../../types/hono";
import { DEFAULT_VIEWPORT } from "../../utils/mcp-app-browser-harness";
import type { BrowserActionSpec } from "../../utils/mcp-app-browser-harness";
import { parseWidgetRenderRequestBody } from "../../utils/widget-render-request";
import {
  renderWidgetForRequest,
  buildWidgetRenderResponseBody,
} from "../../utils/widget-render-core";
import {
  widgetRenderSessions,
  wireWidgetSessionShutdown,
  WidgetSessionBusyError,
  WidgetSessionCapacityError,
  WidgetSessionNotFoundError,
  WidgetSessionUnavailableError,
} from "../../services/widget-render-session";
import { logger } from "../../utils/logger";
import { scriptedStepSchema } from "@/shared/scripted-steps";

/**
 * widget-session.ts — interactive headless widget sessions:
 *   POST   /api/mcp/widget-session            start (render keepMounted)
 *   POST   /api/mcp/widget-session/:id/action drive a Computer-Use action
 *   GET    /api/mcp/widget-session/:id/snapshot  read the widget as TEXT
 *   POST   /api/mcp/widget-session/:id/scripted-step  act by role/name/testId
 *   DELETE /api/mcp/widget-session/:id         close + dispose
 *
 * TWO WAYS TO DRIVE, and the second is not a convenience. `/action` is
 * COORDINATE-based, which silently assumes the caller can see pixels — a
 * text-only model handed a screenshot has nothing to click. `/snapshot` +
 * `/scripted-step` close that: the snapshot hands back interactive elements in
 * the same role/name/testId vocabulary the step accepts, so an agent reads a
 * control and posts it straight back as a target.
 *
 * Same local-only, gate-first render core as the one-shot widget-render route;
 * the difference is the harness is kept mounted and handed to the session
 * registry (services/widget-render-session) which owns its lifecycle (idle TTL,
 * max-session cap, orphan cleanup). The CLI (`mcpjam apps session …`) exposes
 * these; no LLM is embedded — the external agent drives the steps.
 */

// Dispose live sessions on process shutdown (idempotent).
wireWidgetSessionShutdown();

const widgetSession = new Hono();

const BROWSER_ACTIONS = new Set<BrowserActionSpec["action"]>([
  "screenshot",
  "left_click",
  "double_click",
  "right_click",
  "mouse_move",
  "type",
  "key",
  "scroll",
  "wait",
]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBrowserAction(
  raw: unknown,
): { ok: true; action: BrowserActionSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "action must be an object" };
  }
  const a = raw as Record<string, unknown>;
  if (
    typeof a.action !== "string" ||
    !BROWSER_ACTIONS.has(a.action as BrowserActionSpec["action"])
  ) {
    return {
      ok: false,
      error: `action.action must be one of: ${[...BROWSER_ACTIONS].join(", ")}`,
    };
  }
  const spec: BrowserActionSpec = {
    action: a.action as BrowserActionSpec["action"],
  };

  if (a.coordinate !== undefined && a.coordinate !== null) {
    if (
      !Array.isArray(a.coordinate) ||
      a.coordinate.length !== 2 ||
      !isFiniteNumber(a.coordinate[0]) ||
      !isFiniteNumber(a.coordinate[1])
    ) {
      return { ok: false, error: "coordinate must be an [x, y] number pair" };
    }
    spec.coordinate = [a.coordinate[0], a.coordinate[1]];
  }
  if (a.text !== undefined && a.text !== null) {
    if (typeof a.text !== "string") {
      return { ok: false, error: "text must be a string" };
    }
    spec.text = a.text;
  }
  if (a.scrollDirection !== undefined && a.scrollDirection !== null) {
    if (
      typeof a.scrollDirection !== "string" ||
      !SCROLL_DIRECTIONS.has(a.scrollDirection)
    ) {
      return {
        ok: false,
        error: "scrollDirection must be one of: up, down, left, right",
      };
    }
    spec.scrollDirection =
      a.scrollDirection as BrowserActionSpec["scrollDirection"];
  }
  if (a.scrollAmount !== undefined && a.scrollAmount !== null) {
    if (!isFiniteNumber(a.scrollAmount) || a.scrollAmount <= 0) {
      return {
        ok: false,
        error: "scrollAmount must be a number greater than 0",
      };
    }
    spec.scrollAmount = a.scrollAmount;
  }
  if (a.duration !== undefined && a.duration !== null) {
    if (!isFiniteNumber(a.duration) || a.duration < 0) {
      return {
        ok: false,
        error: "duration must be a number greater than or equal to 0",
      };
    }
    spec.duration = a.duration;
  }
  return { ok: true, action: spec };
}

// ── start ────────────────────────────────────────────────────────────────
// Body: { serverId, toolName, parameters?, injectOpenAiCompat?, viewport? }
// Renders keepMounted; on `rendered` registers a session and returns
// { sessionId, status, screenshotBase64, mountedWidgetId, viewport, expiresAt,
//   idleTimeoutMs, … }. A non-rendered verdict returns the observation with no
// sessionId (nothing to step through).
widgetSession.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = parseWidgetRenderRequestBody(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const { serverId, toolName, parameters, injectOpenAiCompat, viewport } =
    parsed.value;

  // Reserve a capacity slot BEFORE the expensive render. Held synchronously, it
  // counts against the cap for the whole render window, so a burst of
  // concurrent starts can't each pass a point-in-time check and launch more
  // browsers than the cap allows.
  let reservation;
  try {
    reservation = widgetRenderSessions.reserve();
  } catch (error) {
    if (error instanceof WidgetSessionCapacityError) {
      return c.json({ error: error.message }, 429);
    }
    if (error instanceof WidgetSessionUnavailableError) {
      return c.json({ error: error.message }, 503);
    }
    throw error;
  }

  let result;
  try {
    result = await renderWidgetForRequest({
      mcpClientManager: c.mcpClientManager,
      serverId,
      toolName,
      parameters,
      injectOpenAiCompat,
      viewport,
      keepMounted: true,
    });
  } catch (error) {
    widgetRenderSessions.release(reservation);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Widget render failed",
      },
      500,
    );
  }

  // Only a fully-rendered widget yields a steppable session; anything else
  // (no_ui_resource, blank, bridge_timeout, browser_unavailable, …) tears down
  // and returns the observation with no sessionId. A non-rendered start may
  // still have launched a browser, so dispose it BEFORE releasing the
  // reservation: freeing the slot while dispose() is pending would let a
  // concurrent start exceed the cap (the registry counts disposing browsers,
  // and this failed-start path must hold the slot the same way).
  if (result.observation.status !== "rendered") {
    await result.harness?.dispose().catch((error) => {
      logger.warn(
        `[widget-session] harness disposal failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    widgetRenderSessions.release(reservation);
    return c.json(buildWidgetRenderResponseBody(result.observation), 200);
  }

  const resolvedViewport = viewport ?? { ...DEFAULT_VIEWPORT };
  try {
    // Consume the reserved slot — won't reject, since the slot was held.
    const session = widgetRenderSessions.register(
      {
        harness: result.harness!,
        serverId,
        // The render's toolCallId IS the mounted widget id (the harness mounted
        // it under that id).
        mountedWidgetId: result.observation.toolCallId,
        viewport: resolvedViewport,
      },
      reservation,
    );
    return c.json(
      {
        sessionId: session.sessionId,
        mountedWidgetId: session.mountedWidgetId,
        viewport: session.viewport,
        expiresAt: session.expiresAt,
        idleTimeoutMs: widgetRenderSessions.getIdleTimeoutMs(),
        ...buildWidgetRenderResponseBody(result.observation),
      },
      200,
    );
  } catch (error) {
    // Never leak the browser or the reserved slot. Registration can legitimately
    // fail if shutdown began mid-render (the in-flight start is refused). Dispose
    // BEFORE releasing so the slot stays counted against the cap until the
    // browser is actually gone.
    await result.harness?.dispose().catch(() => {});
    widgetRenderSessions.release(reservation);
    if (error instanceof WidgetSessionUnavailableError) {
      return c.json({ error: error.message }, 503);
    }
    throw error;
  }
});

// ── snapshot ─────────────────────────────────────────────────────────────
// Returns { snapshot: { mode, tree, elements, truncated?, note? }, expiresAt }.
// A READ: it refreshes the idle TTL but does not consume the widget's step
// budget, because a caller forced to spend interaction steps on looking would
// interact blind to save them.
widgetSession.get("/:id/snapshot", async (c) => {
  const sessionId = c.req.param("id");
  try {
    const { snapshot, expiresAt } = await widgetRenderSessions.captureSnapshot(
      sessionId,
    );
    return c.json({ snapshot, expiresAt }, 200);
  } catch (error) {
    return widgetSessionErrorResponse(c, error, "Snapshot failed");
  }
});

// ── scripted-step ────────────────────────────────────────────────────────
// Body: { step: ScriptedStep, priorWidgetToolCalls?: WidgetToolCall[] }.
// The semantic sibling of /action: targets by role/name/testId — the same
// vocabulary /snapshot returns — instead of by pixel coordinate.
widgetSession.post("/:id/scripted-step", async (c) => {
  const sessionId = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = scriptedStepSchema.safeParse(
    (body as { step?: unknown })?.step,
  );
  if (!parsed.success) {
    return c.json(
      {
        error: `step is invalid: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
      },
      400,
    );
  }
  const priorInput = (body as { priorWidgetToolCalls?: unknown })
    ?.priorWidgetToolCalls;
  // VALIDATED, not forwarded. A `widgetToolCalled` assertion reads `.name` off
  // each entry, so `[null]` reached the harness as a TypeError and came back
  // as a 200 with a failed step and an internal error message — a malformed
  // request reported as a widget problem. The caller can only fix what we
  // name, so this is a 400.
  let prior: Array<{ name: string }> | undefined;
  if (priorInput !== undefined) {
    if (
      !Array.isArray(priorInput) ||
      !priorInput.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as { name?: unknown }).name === "string",
      )
    ) {
      return c.json(
        {
          error:
            "priorWidgetToolCalls must be an array of objects with a string `name` — pass the widgetToolCalls from earlier steps.",
        },
        400,
      );
    }
    prior = priorInput as Array<{ name: string }>;
  }

  try {
    const { result, expiresAt } = await widgetRenderSessions.runScriptedStep(
      sessionId,
      parsed.data,
      // An `assert` step can check "the widget called tool X", which is only
      // answerable against the calls the CALLER has accumulated across steps —
      // the harness drains its buffer each step and cannot see the history.
      prior as never[] | undefined,
    );
    return c.json(
      {
        step: result.step,
        ok: result.ok,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.screenshotBase64
          ? { screenshotBase64: result.screenshotBase64 }
          : {}),
        widgetToolCalls: result.widgetToolCalls,
        followUps: result.followUps,
        ...(result.note ? { note: result.note } : {}),
        elapsedMs: result.elapsedMs,
        expiresAt,
      },
      200,
    );
  } catch (error) {
    return widgetSessionErrorResponse(c, error, "Step failed");
  }
});

// ── action ───────────────────────────────────────────────────────────────
// Body: { action: BrowserActionSpec }. Drives the mounted widget and returns
// { screenshotBase64?, widgetToolCalls, note?, action, elapsedMs, expiresAt }.
widgetSession.post("/:id/action", async (c) => {
  const sessionId = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const actionInput = (body as { action?: unknown })?.action;
  const parsedAction = parseBrowserAction(actionInput);
  if (!parsedAction.ok) {
    return c.json({ error: parsedAction.error }, 400);
  }

  try {
    const { result, expiresAt } = await widgetRenderSessions.executeAction(
      sessionId,
      parsedAction.action,
    );
    return c.json(
      {
        action: result.action,
        ...(result.screenshotBase64
          ? { screenshotBase64: result.screenshotBase64 }
          : {}),
        widgetToolCalls: result.widgetToolCalls,
        ...(result.note ? { note: result.note } : {}),
        elapsedMs: result.elapsedMs,
        expiresAt,
      },
      200,
    );
  } catch (error) {
    if (error instanceof WidgetSessionNotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof WidgetSessionBusyError) {
      return c.json({ error: error.message }, 409);
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Action failed",
      },
      500,
    );
  }
});

// ── close ────────────────────────────────────────────────────────────────
widgetSession.delete("/:id", async (c) => {
  const sessionId = c.req.param("id");
  const closed = await widgetRenderSessions.close(sessionId);
  return c.json({ closed }, 200);
});

export default widgetSession;

/**
 * ONE status mapping for every session entry point.
 *
 * Three handlers that each re-derive "not found is 404, busy is 409" is three
 * places for one of them to drift — and the drift would be invisible, because
 * each handler's own tests would still pass.
 */
function widgetSessionErrorResponse(
  c: Context,
  error: unknown,
  fallbackMessage: string,
) {
  if (error instanceof WidgetSessionNotFoundError) {
    return c.json({ error: error.message }, 404);
  }
  if (error instanceof WidgetSessionBusyError) {
    return c.json({ error: error.message }, 409);
  }
  return c.json(
    { error: error instanceof Error ? error.message : fallbackMessage },
    500,
  );
}
