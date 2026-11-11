import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import {
  configuredSandboxOrigin,
  prepareHostedSandboxView,
  releaseHostedSandboxView,
} from "../../../services/sandbox-view-hosted.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { HOSTED_MODE } from "../../../config.js";
import { canColocatePluginStdio } from "../../../services/plugins/computer-stdio.js";
import { sandboxViews } from "../../../services/sandbox-view-registry.js";
import {
  prepareSandboxViewSchema,
  sandboxViewSourceSchema,
  type SandboxViewInput,
} from "../../../services/sandbox-view-policy.js";
import {
  isSandboxWebRequest,
  sandboxViewOwner,
  validateSandboxHostOrigin,
} from "../../../services/sandbox-view-owner.js";
import {
  assertBearerToken,
  authorizeBatch,
  authorizeServer,
  callerContextFromHono,
  projectServerSchema,
} from "../../web/auth.js";
import {
  ErrorCode,
  WebRouteError,
  webErrorFromRoute,
} from "../../web/errors.js";
import { MCPJAM_PLATFORM_SERVER_ID } from "../../../../shared/mcpjam-agent-widgets.js";
import { SANDBOX_VIEW_REQUEST_MAX_BYTES } from "../../../../shared/sandbox-view-limits.js";

const admissionProjectSchema = projectServerSchema.extend({
  connectionId: z.string().min(1).optional(),
});

/**
 * Whether App documents come from this process's own loopback listeners
 * (`http://<id>.localhost:<port>`, see sandbox-view-registry.ts) rather than
 * hosted leases under the sandbox domain.
 *
 * Always in local mode. In hosted mode only for `npm run dev:hosted` on a
 * developer machine, which has no sandbox domain to mint App addresses under:
 * the same two guards as `localDevServiceTokenAllowed` in
 * routes/web/guest-token.ts. `ENVIRONMENT=dev` is set only by the
 * `dev:server` script, and every deployed image runs with
 * NODE_ENV=production. A configured sandbox origin keeps the hosted path even
 * in dev. Read per call so both the admission and its release agree.
 */
function servesLocalSandboxViews(): boolean {
  if (!HOSTED_MODE) return true;
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ENVIRONMENT === "dev" &&
    !configuredSandboxOrigin()
  );
}

/** Hosted dev serves loopback App documents only to a page on this machine. */
function assertLoopbackHostOrigin(hostOrigin: string): void {
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(hostOrigin).hostname)
  )
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "This page cannot prepare an App document.",
    );
}

async function authorizePreparation(
  c: Context,
  input: SandboxViewInput,
  body: Record<string, unknown>,
): Promise<string> {
  const source = input.source;
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
      const options = {
        ...(parsed.scenarioId ? { scenarioId: parsed.scenarioId } : {}),
        ...(parsed.accessVersion !== undefined
          ? { accessVersion: parsed.accessVersion }
          : {}),
        ...(parsed.connectionId ? { connectionId: parsed.connectionId } : {}),
      };
      if (HOSTED_MODE) {
        try {
          await authorizeServer(
            c, bearer, parsed.projectId, source.serverId, options,
          );
        } catch (error) {
          if (
            !canColocatePluginStdio() ||
            !(error instanceof WebRouteError) ||
            error.code !== ErrorCode.FEATURE_NOT_SUPPORTED ||
            error.details?.refusalReason !== "hosted_stdio_unsupported"
          ) {
            throw error;
          }
          // Rendering already-read bytes grants no process execution or Computer.
          // The signed receipt still binds the admitted owner, source and HTML;
          // prepareHostedSandboxView validates it before creating the lease.
          if (!input.sourceReceipt) {
            throw new WebRouteError(
              403, ErrorCode.FORBIDDEN,
              "Reopen this App to read its current document.",
            );
          }
          const batch = await authorizeBatch(
            callerContextFromHono(c), bearer, parsed.projectId, [source.serverId],
            { ...options, pluginComputerRuntime: true },
          );
          const result = batch.results[source.serverId];
          if (!result?.ok) {
            throw new WebRouteError(
              result?.status ?? 403,
              Object.values(ErrorCode).find((code) => code === result?.code) ??
                ErrorCode.FORBIDDEN,
              result?.message ?? "The App server is no longer available.",
            );
          }
          if (
            result.serverConfig.transportType !== "stdio" ||
            result.serverConfig.pluginComponent !== true
          ) {
            throw new WebRouteError(
              403, ErrorCode.FORBIDDEN, "The App server is no longer available.",
            );
          }
        }
      } else {
        // The local batch authorizer preserves caller scope and accepts saved
        // STDIO servers without connecting or executing their commands.
        const batch = await authorizeBatch(
          callerContextFromHono(c), bearer, parsed.projectId, [source.serverId], options,
        );
        const result = batch.results[source.serverId];
        if (!result?.ok) {
          throw new WebRouteError(
            result?.status ?? 403,
            Object.values(ErrorCode).find((code) => code === result?.code) ?? ErrorCode.FORBIDDEN,
            result?.message ?? "The App server is no longer available.",
          );
        }
      }
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
  const boundedBody = bodyLimit({ maxSize: SANDBOX_VIEW_REQUEST_MAX_BYTES });
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
      const local = servesLocalSandboxViews();
      if (HOSTED_MODE && local) assertLoopbackHostOrigin(input.hostOrigin);
      const owner = await authorizePreparation(c, input, raw);
      return c.json(
        local
          ? await sandboxViews.prepare(input, owner, c.req.raw.signal)
          : await prepareHostedSandboxView(input, owner),
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
      if (servesLocalSandboxViews())
        sandboxViews.dispose(c.req.param("admissionId"), owner);
      else await releaseHostedSandboxView(c.req.param("admissionId"), owner);
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
