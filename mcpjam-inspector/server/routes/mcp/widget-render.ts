import { Hono } from "hono";
import "../../types/hono";
import { parseWidgetRenderRequestBody } from "../../utils/widget-render-request";
import {
  renderWidgetForRequest,
  buildWidgetRenderResponseBody,
} from "../../utils/widget-render-core";
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
 * The gate-first render flow (listTools -> renderability gate -> executeTool ->
 * harness render) lives in utils/widget-render-core.ts, shared with the
 * interactive widget-session route. This route is the one-shot wrapper: render
 * once with `keepMounted:false` and always dispose. The CLI
 * (`mcpjam apps render`) is the primary caller; it stays thin (no Playwright)
 * because the harness runs server-side where local Chromium lives.
 */

const widgetRender = new Hono();

// One-shot headless widget render. Body:
//   { serverId, toolName, parameters?, injectOpenAiCompat?, viewport? }
// Returns the WidgetRenderObservation shape (status + screenshotBase64 + the
// console/network diagnostics), with a `hint` attached on `browser_unavailable`.
widgetRender.post("/", async (c) => {
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

  let result;
  try {
    result = await renderWidgetForRequest({
      mcpClientManager: c.mcpClientManager,
      serverId,
      toolName,
      parameters,
      injectOpenAiCompat,
      viewport,
      keepMounted: false,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Widget render failed",
      },
      500,
    );
  }

  try {
    return c.json(buildWidgetRenderResponseBody(result.observation), 200);
  } finally {
    // One-shot: always tear the browser down (best-effort; the response is
    // already committed). Log a disposal failure so a leaked context is
    // observable rather than silent.
    await result.harness?.dispose().catch((error) => {
      logger.warn(
        `[widget-render] harness disposal failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
});

export default widgetRender;
