import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { HOSTED_MODE } from "../../config.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { resolvePluginCleanupActor, PluginWorkspaceAdmissionError } from "../../services/plugin-host/admission.js";
import { readJsonObjectBody } from "./adapter.js";
import { parseBrowserAction } from "../mcp/widget-session.js";
import { scriptedStepSchema } from "../../../shared/scripted-steps.js";
import { parseWidgetRenderRequestBody } from "../../utils/widget-render-request.js";
import { DEFAULT_VIEWPORT } from "../../utils/mcp-app-browser-harness.js";
import {
  renderWidgetForRequest,
  buildWidgetRenderResponseBody,
} from "../../utils/widget-render-core.js";
import { ScopedWidgetManager } from "../../services/scoped-widget-manager.js";
import {
  widgetRenderSessions,
  WidgetSessionNotFoundError,
  WidgetSessionBusyError,
  WidgetSessionCapacityError,
  WidgetSessionUnavailableError,
} from "../../services/widget-render-session.js";

const routes = new Hono();
const ports = new Map<string, ScopedWidgetManager>();
const prefix = "/projects/:projectId/servers/:serverId/widget-sessions";
routes.use(`${prefix}/*`, requireVerifiedAuth());
const priorSchema = z
  .array(
    z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      ok: z.boolean(),
      elapsedMs: z.number(),
      error: z.string().optional(),
    }),
  )
  .max(1000)
  .optional();

async function scope(c: Context) {
  if (HOSTED_MODE)
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Retained widget sessions require a local Inspector.",
    );
  let subject = c.get("workosUserId");
  if (!subject) {
    try {
      subject = await resolvePluginCleanupActor({
        bearer: await getConvexBearerForRequest(c), signal: c.req.raw.signal,
      });
    } catch (error) {
      if (!(error instanceof PluginWorkspaceAdmissionError)) throw error;
      if (error.failure === "unreachable" || error.failure === "cancelled")
        throw new WebRouteError(503, ErrorCode.SERVER_UNREACHABLE, "Could not verify your sign-in. Try again.");
      throw new WebRouteError(401, ErrorCode.UNAUTHORIZED, "Sign in to open a widget session.");
    }
  }
  if (typeof subject !== "string" || !subject)
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Sign in to open a widget session.",
    );
  const projectId = z.string().parse(c.req.param("projectId")),
    serverId = z.string().parse(c.req.param("serverId"));
  const ownerKey = createHash("sha256")
    .update(JSON.stringify([subject, projectId, serverId]))
    .digest("hex");
  return { projectId, serverId, ownerKey };
}

async function control(
  c: Context,
  work: (
    port: ScopedWidgetManager,
    id: string,
    ownerKey: string,
  ) => Promise<Record<string, unknown>>,
) {
  const owner = await scope(c),
    id = z.string().parse(c.req.param("id"));
  if (!widgetRenderSessions.get(id, owner.ownerKey) || !ports.has(id))
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Widget session not found or expired.",
    );
  const port = ports.get(id);
  if (!port)
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Widget session not found or expired.",
    );
  try {
    return c.json(
      await port.run(c, owner, () => work(port, id, owner.ownerKey)),
    );
  } catch (error) {
    if (error instanceof WidgetSessionNotFoundError)
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Widget session not found or expired.",
      );
    if (error instanceof WidgetSessionBusyError)
      throw new WebRouteError(409, ErrorCode.CONFLICT, error.message);
    throw error;
  }
}

routes.post(prefix, async (c) => {
  const owner = await scope(c);
  const body = await readJsonObjectBody(c);
  const capabilities = parseWithSchema(
    z.record(z.string(), z.unknown()).optional(), body.clientCapabilities,
  );
  const parsed = parseWidgetRenderRequestBody({
    ...body,
    serverId: owner.serverId,
  });
  if (!parsed.ok)
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, parsed.error);
  let reservation;
  try {
    reservation = widgetRenderSessions.reserve();
  } catch (error) {
    if (error instanceof WidgetSessionCapacityError)
      throw new WebRouteError(429, ErrorCode.RATE_LIMITED, error.message);
    if (error instanceof WidgetSessionUnavailableError)
      throw new WebRouteError(
        503,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        error.message,
      );
    throw error;
  }
  const port = new ScopedWidgetManager(capabilities);
  let result: Awaited<ReturnType<typeof renderWidgetForRequest>> | undefined;
  let registered = false;
  try {
    result = await port.run(c, owner, () =>
      renderWidgetForRequest({
        mcpClientManager: port.manager,
        ...parsed.value,
        keepMounted: true,
      }),
    );
    c.req.raw.signal.throwIfAborted();
    if (result.observation.status !== "rendered" || !result.harness)
      return c.json(buildWidgetRenderResponseBody(result.observation));
    const harness = result.harness;
    let sessionId: string | undefined;
    const session = widgetRenderSessions.register(
      {
        serverId: owner.serverId,
        ownerKey: owner.ownerKey,
        mountedWidgetId: result.observation.toolCallId,
        viewport: parsed.value.viewport ?? { ...DEFAULT_VIEWPORT },
        harness: {
          executeAction: harness.executeAction.bind(harness),
          captureSnapshot: harness.captureSnapshot.bind(harness),
          runScriptedStep: harness.runScriptedStep.bind(harness),
          dispose: async () => {
            port.close();
            if (sessionId) ports.delete(sessionId);
            await harness.dispose();
          },
        },
      },
      reservation,
    );
    sessionId = session.sessionId;
    ports.set(sessionId, port);
    registered = true;
    return c.json({
      ...buildWidgetRenderResponseBody(result.observation),
      ...session,
      idleTimeoutMs: widgetRenderSessions.getIdleTimeoutMs(),
    });
  } finally {
    if (!registered) {
      port.close();
      try {
        await result?.harness?.dispose();
      } finally {
        widgetRenderSessions.release(reservation);
      }
    }
  }
});

routes.get(`${prefix}/:id/snapshot`, (c) =>
  control(c, (_port, id, key) => widgetRenderSessions.captureSnapshot(id, key)),
);
routes.post(`${prefix}/:id/action`, async (c) => {
  const parsed = parseBrowserAction((await readJsonObjectBody(c)).action);
  if (!parsed.ok)
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, parsed.error);
  return control(c, async (_port, id, key) => {
    const { result, expiresAt } = await widgetRenderSessions.executeAction(
      id,
      parsed.action,
      key,
    );
    return { ...result, expiresAt };
  });
});
routes.post(`${prefix}/:id/scripted-step`, async (c) => {
  const body = await readJsonObjectBody(c);
  const step = parseWithSchema(scriptedStepSchema, body.step);
  const prior = parseWithSchema(priorSchema, body.priorWidgetToolCalls);
  return control(c, async (_port, id, key) => {
    const { result, expiresAt } = await widgetRenderSessions.runScriptedStep(
      id,
      step,
      prior,
      key,
    );
    return { ...result, expiresAt };
  });
});
routes.delete(`${prefix}/:id`, async (c) => {
  const owner = await scope(c);
  // Closing needs the original verified owner, but not continuing project access.
  // Revoking a server must not prevent its owner from disposing the browser.
  const id = c.req.param("id");
  const closed = widgetRenderSessions.get(id, owner.ownerKey)
    ? await widgetRenderSessions.close(id, owner.ownerKey)
    : false;
  return c.json({ closed });
});

export default routes;
