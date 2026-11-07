import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import {
  prepareHostedSandboxView,
  releaseHostedSandboxView,
} from "../../../services/sandbox-view-hosted.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { HOSTED_MODE } from "../../../config.js";
import { sandboxViews } from "../../../services/sandbox-view-registry.js";
import {
  prepareSandboxViewSchema,
  sandboxViewSourceSchema,
} from "../../../services/sandbox-view-policy.js";
import {
  isSandboxWebRequest,
  sandboxViewOwner,
  validateSandboxHostOrigin,
} from "../../../services/sandbox-view-owner.js";
import {
  assertBearerToken,
  authorizeServer,
  projectServerSchema,
} from "../../web/auth.js";
import {
  ErrorCode,
  WebRouteError,
  webErrorFromRoute,
} from "../../web/errors.js";
import { MCPJAM_PLATFORM_SERVER_ID } from "../../../../shared/mcpjam-agent-widgets.js";

const admissionProjectSchema = projectServerSchema.extend({
  connectionId: z.string().min(1).optional(),
});

async function authorizePreparation(
  c: Context,
  source: { serverId: string },
  body: Record<string, unknown>,
): Promise<string> {
  if (isSandboxWebRequest(c)) {
    const bearer = assertBearerToken(c);
    if (source.serverId !== MCPJAM_PLATFORM_SERVER_ID) {
      const parsed = admissionProjectSchema.parse(body);
      if (parsed.serverId !== source.serverId)
        throw new WebRouteError(
          403,
          ErrorCode.FORBIDDEN,
          "The App source does not match this server.",
        );
      await authorizeServer(c, bearer, parsed.projectId, source.serverId, {
        ...(parsed.scenarioId ? { scenarioId: parsed.scenarioId } : {}),
        ...(parsed.accessVersion !== undefined
          ? { accessVersion: parsed.accessVersion }
          : {}),
        ...(parsed.connectionId ? { connectionId: parsed.connectionId } : {}),
      });
      return sandboxViewOwner(c, parsed.projectId);
    }
    return sandboxViewOwner(c);
  }
  const owner = await sandboxViewOwner(c);
  if (!c.mcpClientManager.getServerConfig(source.serverId))
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "The App server is no longer connected.",
    );
  return owner;
}

/** Local and hosted handlers share admission validation; document listeners are runtime-owned. */
export function sandboxViewAdmissionRoutes(): Hono {
  const routes = new Hono();
  const localAuthority = async (c: Context, next: () => Promise<void>) => {
    if (!isSandboxWebRequest(c)) {
      try {
        await sandboxViewOwner(c);
      } catch (error) {
        if (error instanceof WebRouteError) return webErrorFromRoute(c, error);
        throw error;
      }
    }
    await next();
  };
  routes.use("/view-admissions", localAuthority);
  routes.use("/view-admissions/*", localAuthority);
  const boundedBody = bodyLimit({ maxSize: 16 * 1024 * 1024 });
  routes.use("/view-admissions", boundedBody);
  routes.use("/view-admissions/*", boundedBody);
  routes.use("/view-admissions*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  routes.post("/view-admissions", async (c) => {
    try {
      const raw = await c.req.json<Record<string, unknown>>();
      const input = prepareSandboxViewSchema.parse(raw);
      validateSandboxHostOrigin(c, input.hostOrigin);
      const owner = await authorizePreparation(c, input.source, raw);
      return c.json(
        HOSTED_MODE
          ? await prepareHostedSandboxView(input, owner)
          : await sandboxViews.prepare(input, owner, c.req.raw.signal),
      );
    } catch (error) {
      if (error instanceof WebRouteError) return webErrorFromRoute(c, error);
      return webErrorFromRoute(
        c,
        new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          error instanceof Error
            ? error.message
            : "The App document could not be prepared.",
        ),
      );
    }
  });
  routes.delete("/view-admissions/:admissionId", async (c) => {
    try {
      const raw = await c.req.json<Record<string, unknown>>();
      sandboxViewSourceSchema.parse(raw.source);
      const owner = await sandboxViewOwner(
        c,
        isSandboxWebRequest(c)
          ? String(raw.projectId ?? "") || undefined
          : undefined,
      );
      if (HOSTED_MODE)
        await releaseHostedSandboxView(c.req.param("admissionId"), owner);
      else sandboxViews.dispose(c.req.param("admissionId"), owner);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof WebRouteError) return webErrorFromRoute(c, error);
      return webErrorFromRoute(
        c,
        new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "The App document could not be released.",
        ),
      );
    }
  });
  return routes;
}
