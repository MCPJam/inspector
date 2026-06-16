import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import "../../types/hono";
import {
  McpAppBrowserHarness,
  ChromiumNotInstalledError,
} from "../../utils/mcp-app-browser-harness";
import {
  renderMcpAppToolResult,
  isRenderableMcpAppTool,
} from "../../utils/mcp-app-render-observation";
import { logger } from "../../utils/logger";

/**
 * widget-render.ts — `POST /api/mcp/widget-render`: a one-shot, headless render
 * of an MCP App tool result. Calls the tool, mounts the widget's UI resource in
 * the eval browser harness (real headless Chromium running the production host
 * bridge), and returns a screenshot + render verdict.
 *
 * Local-Inspector capability only: this lives under `/api/mcp/*`, which
 * `server/app.ts` mounts solely when `!HOSTED_MODE`, so the harness's Chromium
 * always comes from the local Inspector install (Playwright postinstall /
 * on-demand `ensureLocalChromiumInstalled`), never the hosted image.
 *
 * Flow: listTools (populate the metadata cache) -> renderability gate -> (only
 * if renderable) executeTool -> harness render -> dispose. Gating BEFORE
 * execution means a non-widget, side-effectful tool isn't run just to discover
 * it has no UI. The CLI (`mcpjam apps render`) is the primary caller; it stays
 * thin (no Playwright) because the harness runs server-side where local
 * Chromium lives.
 */

const widgetRender = new Hono();

/** Actionable hint surfaced when the harness reports `browser_unavailable`. */
const CHROMIUM_INSTALL_HINT = "npx playwright install chromium";

/** Upper bound for a requested viewport edge (px). Guards against absurd
 *  allocations while comfortably covering desktop/retina capture sizes. */
const MAX_VIEWPORT_EDGE = 8192;

interface WidgetRenderBody {
  serverId?: unknown;
  toolName?: unknown;
  parameters?: unknown;
  injectOpenAiCompat?: unknown;
  viewport?: unknown;
}

function isPositivePixelDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_VIEWPORT_EDGE
  );
}

function parseViewport(
  raw: unknown,
): { ok: true; viewport?: { width: number; height: number } } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const { width, height } = raw as { width?: unknown; height?: unknown };
  if (!isPositivePixelDimension(width) || !isPositivePixelDimension(height)) {
    return { ok: false };
  }
  return { ok: true, viewport: { width, height } };
}

// One-shot headless widget render. Body:
//   { serverId, toolName, parameters?, injectOpenAiCompat?, viewport? }
// Returns the WidgetRenderObservation shape (status + screenshotBase64 + the
// console/network diagnostics), with a `hint` attached on `browser_unavailable`.
widgetRender.post("/", async (c) => {
  let body: WidgetRenderBody;
  try {
    body = (await c.req.json()) as WidgetRenderBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const serverId = typeof body.serverId === "string" ? body.serverId : "";
  const toolName = typeof body.toolName === "string" ? body.toolName : "";
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  if (!toolName) return c.json({ error: "toolName is required" }, 400);

  // Tool arguments must be a plain JSON object. Missing/null defaults to {};
  // anything else provided (array, string, number) is a client error — mirror
  // the viewport strictness below rather than silently forwarding e.g. an
  // array to executeTool.
  let parameters: Record<string, unknown> = {};
  if (body.parameters !== undefined && body.parameters !== null) {
    if (typeof body.parameters !== "object" || Array.isArray(body.parameters)) {
      return c.json({ error: "parameters must be a JSON object" }, 400);
    }
    parameters = body.parameters as Record<string, unknown>;
  }

  const viewportResult = parseViewport(body.viewport);
  if (!viewportResult.ok) {
    return c.json(
      {
        error:
          "viewport must be an object with positive integer width and height (px)",
      },
      400,
    );
  }
  const injectOpenAiCompat = body.injectOpenAiCompat === true;

  const startedAt = Date.now();

  // ── renderability gate (BEFORE executing the tool) ─────────────────────
  // Populate the tool-metadata cache first: connecting a server does NOT list
  // its tools, and executeTool doesn't cache metadata, so without this the gate
  // would always see empty metadata (=> always no_ui_resource). Then gate on
  // the declared UI resource — a non-MCP-App / resource-less tool has no widget
  // to mount, so report `no_ui_resource` WITHOUT running a possibly
  // side-effectful tool.
  let toolMetadata: Record<string, unknown>;
  try {
    await c.mcpClientManager.listTools(serverId);
    toolMetadata =
      c.mcpClientManager.getAllToolsMetadata(serverId)?.[toolName] ?? {};
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list server tools",
      },
      500,
    );
  }
  if (!isRenderableMcpAppTool(toolMetadata)) {
    return c.json(
      { status: "no_ui_resource", elapsedMs: Date.now() - startedAt },
      200,
    );
  }

  // ── pinned tool call ───────────────────────────────────────────────────
  // The widget renders THIS result. A protocol-level failure (invalid params,
  // server disconnected) means there's nothing to render, so surface it as a
  // 500 like the rest of the MCP route surface. A tool that merely returns
  // `isError: true` is still a result — the widget may render its error state —
  // so it flows through to the harness unchanged.
  let rawResult: unknown;
  try {
    rawResult = await c.mcpClientManager.executeTool(
      serverId,
      toolName,
      parameters,
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Tool execution failed",
      },
      500,
    );
  }

  // ── headless render ────────────────────────────────────────────────────
  const harness = new McpAppBrowserHarness({
    callTool: (s, n, a) => c.mcpClientManager.executeTool(s, n, a),
    ...(viewportResult.viewport ? { viewport: viewportResult.viewport } : {}),
  });
  try {
    const observation = await renderMcpAppToolResult({
      toolCallId: `widget-render-${randomUUID()}`,
      toolName,
      serverId,
      toolMetadata,
      output: rawResult,
      toolInput: parameters,
      mcpClientManager: c.mcpClientManager,
      injectOpenAiCompat,
      harness,
      keepMounted: false,
    });

    // The harness already maps a missing-Chromium launch to a
    // `browser_unavailable` observation (it does NOT throw); attach the
    // actionable install hint so an agent/CI can self-remediate. The defensive
    // catch below covers the throw path in case the contract ever changes.
    return c.json(
      {
        status: observation.status,
        ...(observation.resourceUri
          ? { resourceUri: observation.resourceUri }
          : {}),
        ...(observation.bridgeInitialized !== undefined
          ? { bridgeInitialized: observation.bridgeInitialized }
          : {}),
        ...(observation.screenshotBase64
          ? { screenshotBase64: observation.screenshotBase64 }
          : {}),
        ...(observation.consoleErrors
          ? { consoleErrors: observation.consoleErrors }
          : {}),
        ...(observation.blockedRequests
          ? { blockedRequests: observation.blockedRequests }
          : {}),
        elapsedMs: observation.elapsedMs,
        ...(observation.status === "browser_unavailable"
          ? { hint: CHROMIUM_INSTALL_HINT }
          : {}),
      },
      200,
    );
  } catch (error) {
    if (error instanceof ChromiumNotInstalledError) {
      return c.json(
        {
          status: "browser_unavailable",
          hint: CHROMIUM_INSTALL_HINT,
          elapsedMs: Date.now() - startedAt,
        },
        200,
      );
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Widget render failed",
      },
      500,
    );
  } finally {
    // Best-effort cleanup (the response is already committed), but log a
    // disposal failure so a leaked browser context is observable rather than
    // silent.
    await harness.dispose().catch((error) => {
      logger.warn(
        `[widget-render] harness disposal failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
});

export default widgetRender;
