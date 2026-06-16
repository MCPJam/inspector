import { Hono } from "hono";
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
  WidgetSessionCapacityError,
  WidgetSessionNotFoundError,
} from "../../services/widget-render-session";
import { logger } from "../../utils/logger";

/**
 * widget-session.ts — interactive headless widget sessions:
 *   POST   /api/mcp/widget-session            start (render keepMounted)
 *   POST   /api/mcp/widget-session/:id/action drive a Computer-Use action
 *   DELETE /api/mcp/widget-session/:id         close + dispose
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
    if (!isFiniteNumber(a.scrollAmount)) {
      return { ok: false, error: "scrollAmount must be a number" };
    }
    spec.scrollAmount = a.scrollAmount;
  }
  if (a.duration !== undefined && a.duration !== null) {
    if (!isFiniteNumber(a.duration)) {
      return { ok: false, error: "duration must be a number" };
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

  // Cap check BEFORE the expensive render so a full registry doesn't launch a
  // browser only to reject it.
  try {
    widgetRenderSessions.assertCapacity();
  } catch (error) {
    if (error instanceof WidgetSessionCapacityError) {
      return c.json({ error: error.message }, 429);
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
    return c.json(
      {
        error: error instanceof Error ? error.message : "Widget render failed",
      },
      500,
    );
  }

  // Only a fully-rendered widget yields a steppable session; anything else
  // (no_ui_resource, blank, bridge_timeout, browser_unavailable, …) tears down
  // and returns the observation with no sessionId.
  if (result.observation.status !== "rendered") {
    await result.harness?.dispose().catch((error) => {
      logger.warn(
        `[widget-session] harness disposal failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return c.json(buildWidgetRenderResponseBody(result.observation), 200);
  }

  const resolvedViewport = viewport ?? { ...DEFAULT_VIEWPORT };
  try {
    const session = widgetRenderSessions.register({
      harness: result.harness!,
      serverId,
      // The render's toolCallId IS the mounted widget id (the harness mounted it
      // under that id).
      mountedWidgetId: result.observation.toolCallId,
      viewport: resolvedViewport,
    });
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
    // Lost a capacity race after rendering — dispose the orphan harness.
    await result.harness?.dispose().catch(() => {});
    if (error instanceof WidgetSessionCapacityError) {
      return c.json({ error: error.message }, 429);
    }
    throw error;
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
