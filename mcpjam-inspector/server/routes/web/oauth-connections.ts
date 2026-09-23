import { revokeLocalConnection } from "../../utils/mcp-connections.js";
import { HOSTED_MODE } from "../../config.js";
import {
  authorizeBatchLocal,
  toMCPServerConfig,
} from "../../utils/local-server-resolver.js";
import { Hono } from "hono";
import {
  captureOpenAIProfile,
  withEphemeralClient,
  type OpenAIProfileCapture,
} from "@mcpjam/sdk";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import {
  callerContextFromHono,
  createAuthorizedManager,
  withManager,
} from "./auth.js";
import { webErrorFromRoute, mapRuntimeError } from "./errors.js";
const connections = new Hono();
connections.use("*", bearerAuthMiddleware);
connections.use("*", guestRateLimitMiddleware);
for (const op of ["", "/label", "/default", "/delete", "/profile"]) {
  connections.post(op || "/", async (c) => {
    try {
      const body = await c.req.json();
      const authorization = c.req.header("authorization") ?? "";
      const bearer = authorization.replace(/^Bearer\s+/i, "");
      const convexUrl = process.env.CONVEX_HTTP_URL;
      if (!convexUrl)
        throw new Error("Server missing CONVEX_HTTP_URL configuration");
      let payload = body;
      if (op === "/profile") {
        if (
          typeof body.connectionId !== "string" ||
          typeof body.expectedVaultObjectId !== "string" ||
          typeof body.projectId !== "string" ||
          typeof body.serverId !== "string"
        )
          return c.json(
            { error: "Connection capture context is required" },
            400,
          );
        const deadline = Date.now() + 8_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const probe = (
          manager: Parameters<typeof captureOpenAIProfile>[0],
          key: string,
        ): Promise<OpenAIProfileCapture> =>
          Date.now() >= deadline
            ? Promise.resolve({
                profile: undefined,
                reason: "Profile capture timed out",
              })
            : captureOpenAIProfile(manager, key, {
                timeoutMs: deadline - Date.now(),
              });
        const operation = HOSTED_MODE
          ? withManager(
              createAuthorizedManager(
                callerContextFromHono(c),
                bearer,
                body.projectId,
                [body.serverId],
                8_000,
                undefined,
                undefined,
                { connectionIds: { [body.serverId]: body.connectionId } },
              ),
              (manager) => probe(manager, body.serverId),
            )
          : (async () => {
              const batch = await authorizeBatchLocal(
                c,
                bearer,
                body.projectId,
                [body.serverId],
                undefined,
                { connectionIds: { [body.serverId]: body.connectionId } },
              );
              const auth = batch.results[body.serverId];
              if (!auth?.ok || !auth.oauthAccessToken || Date.now() >= deadline)
                return {
                  profile: undefined,
                  reason: "Connection unavailable",
                } as OpenAIProfileCapture;
              return withEphemeralClient(
                toMCPServerConfig(auth, {
                  oauthAccessToken: auth.oauthAccessToken,
                  timeoutMs: deadline - Date.now(),
                }),
                probe,
              );
            })();
        let capture: OpenAIProfileCapture;
        try {
          capture = await Promise.race([
            operation,
            new Promise<OpenAIProfileCapture>((resolve) => {
              timer = setTimeout(
                () =>
                  resolve({
                    profile: undefined,
                    reason: "Profile capture timed out",
                  }),
                8_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!capture.profile)
          return c.json({
            connectionId: body.connectionId,
            outcome: "unavailable",
            reason: capture.reason,
          });
        payload = {
          projectId: body.projectId,
          serverId: body.serverId,
          connectionId: body.connectionId,
          expectedVaultObjectId: body.expectedVaultObjectId,
          profile: capture.profile,
        };
      }
      const response = await fetch(`${convexUrl}/web/oauth/connections${op}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (
        op === "/delete" &&
        response.ok &&
        !HOSTED_MODE &&
        c.mcpClientManager &&
        (await response.clone().json()).outcome === "deleted"
      )
        await revokeLocalConnection(
          c.mcpClientManager,
          body.projectId,
          body.serverId,
          body.connectionId,
        );
      return new Response(await response.text(), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (op === "/profile")
        return c.json({
          outcome: "unavailable",
          reason: "Profile capture failed",
        });
      return webErrorFromRoute(c, mapRuntimeError(error));
    }
  });
}
export default connections;
