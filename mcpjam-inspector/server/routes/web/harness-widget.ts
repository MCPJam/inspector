import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "../v1/convex-client.js";
import { createAuthorizedManager, callerContextFromHono } from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  createExecutionControl,
  forwardingOwnerSchema,
  ExecutionControlError,
} from "../../utils/harness/forwarding/execution-control.js";
import { executeForwardedOperation } from "../../utils/harness/forwarding/execution-gate.js";
import { forwardingApproval } from "../../utils/harness/forwarding/approval.js";
import { forwardingApprovalId } from "@/shared/forwarding-approval";
import { readNativeBody } from "../../utils/harness/forwarding/native-wire.js";
import {
  buildHostConnectionPins,
  hostClientCapabilities,
} from "../../services/host-connection-pins.js";
import { isVisibleToModelOnly } from "@mcpjam/sdk/widget-runtime";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { createNativeRpcLogger } from "../../utils/harness/forwarding/native-rpc-logs.js";
import { isModernAppsProfile } from "../../utils/harness/harness-connection-profile.js";
import {
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
} from "../../utils/effective-auth.js";

const requestSchema = z
  .object({
    context: z
      .object({
        owner: forwardingOwnerSchema,
        parentExecutionId: z.string().min(1),
      })
      .strict(),
    toolName: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
const userQuery = makeFunctionReference<"query">("users:getCurrentUser");
const userSchema = z.object({ _id: z.string() });
export const harnessWidgets = new Hono();

/** Widgets authenticate as the user; a stopped model lease supplies no authority here. */
harnessWidgets.post("/widget", async (c) => {
  try {
    if (process.env.HARNESS_NATIVE_FORWARDING !== "true")
      return c.json({ error: "App forwarding is unavailable." }, 404);
    const body = requestSchema.parse(
      JSON.parse(await readNativeBody(c.req.raw)),
    );
    const { owner, parentExecutionId } = body.context;
    const bearer = await getConvexBearerForRequest(c);
    const user = userSchema.parse(
      await createConvexClient(bearer).query(userQuery, {}),
    );
    if (owner.kind !== "chat" || owner.userId !== user._id)
      return c.json(
        { error: "This App action does not belong to your chat." },
        403,
      );
    const control = createExecutionControl({
      owner,
      widgetParentId: parentExecutionId,
    });
    const scope = await control.widgetScope();
    const allowed = (process.env.HARNESS_FORWARDING_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim());
    if (!allowed.includes(scope.organizationId))
      return c.json({ error: "App forwarding is unavailable." }, 403);
    const pins = buildHostConnectionPins(scope.hostConfig, 300_000);
    const initializePins = {
      ...pins.initializePins,
      ...conformanceKnobsFromMcpProfile(scope.hostConfig.mcpProfile),
      mirrorToolParamHeaders: mirrorToolParamHeadersFromMcpProfile(
        scope.hostConfig.mcpProfile,
      ),
    };
    const authorized = await createAuthorizedManager(
      callerContextFromHono(c),
      bearer,
      scope.projectId,
      [owner.serverId],
      pins.timeoutMs,
      undefined,
      hostClientCapabilities(scope.hostConfig),
      {
        lazyConnect: true,
        initializePins,
        mcpProtocolVersionsByServerId: pins.mcpProtocolVersionsByServerId,
        requestTimeoutByServerId: pins.requestTimeoutByServerId,
        rpcLogger: createNativeRpcLogger({
          owner,
          turnId: scope.turnId,
          projectId: scope.projectId,
          organizationId: scope.organizationId,
        }),
        ...(owner.connectionId
          ? { connectionIds: { [owner.serverId]: owner.connectionId } }
          : {}),
      },
    );
    const abort = new AbortController();
    const onAbort = () => abort.abort(c.req.raw.signal.reason);
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
    if (c.req.raw.signal.aborted) onAbort();
    const encoder = new TextEncoder();
    let closed = false;
    const run = async (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ) => {
      const send = (value: object) => {
        if (!closed)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          );
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": waiting\n\n"));
      }, 10_000);
      try {
        const config = authorized.authorizedServerConfigs?.[owner.serverId];
        if (!config || !("url" in config))
          throw new Error("App connection unavailable");
        await authorized.manager.connectToServer(owner.serverId, config, {
          signal: abort.signal,
        });
        const catalog = await authorized.manager.listTools(
          owner.serverId,
          undefined,
          { signal: abort.signal },
        );
        if (!isModernAppsProfile(authorized.manager, owner.serverId))
          throw new Error(
            "App connection no longer matches its qualified profile",
          );
        const tool = catalog.tools.find(
          (entry) => entry.name === body.toolName,
        );
        if (!tool || isVisibleToModelOnly(tool._meta))
          throw new Error("App tool unavailable");
        const approval = forwardingApproval(control, owner, scope.projectId);
        const result = await executeForwardedOperation({
          control,
          signal: abort.signal,
          operation: {
            invocationKey: randomUUID(),
            turnId: scope.turnId,
            rpcId: randomUUID(),
            method: "tools/call",
            params: { name: body.toolName, arguments: body.arguments },
            paramsPresent: true,
            expiresAt: Math.min(scope.expiresAt, Date.now() + 300_000),
          },
          approval: {
            ...approval,
            ask: async (request) => {
              send({
                type: "approval",
                id: forwardingApprovalId(
                  request.executionId,
                  owner,
                  request.approvalId,
                ),
              });
              return approval.ask(request);
            },
          },
          dispatch: async (settle, snapshot) => {
            const params = z
              .object({
                name: z.string(),
                arguments: z.record(z.string(), z.unknown()),
              })
              .parse(snapshot.params);
            const result = await authorized.manager.executeTool(
              owner.serverId,
              params.name,
              params.arguments,
              { signal: abort.signal },
            );
            await settle({
              outcome: result.isError ? "tool_error" : "success",
              resultJson: JSON.stringify({
                jsonrpc: "2.0",
                id: snapshot.rpcId,
                result,
              }),
            });
            return result;
          },
        });
        send({ type: "result", result });
      } catch (error) {
        if (!abort.signal.aborted) {
          if (!(error instanceof ExecutionControlError))
            reportRouteFailure(
              "App action failed",
              new Error(
                error instanceof Error ? error.name : "AppActionFailure",
              ),
              { source: "web.harness-widget", hop: "user_server_hop" },
            );
          send({
            type: "error",
            error:
              "The App action could not complete. Check its status before trying again.",
          });
        }
      } finally {
        clearInterval(heartbeat);
        c.req.raw.signal.removeEventListener("abort", onAbort);
        await authorized.manager.disconnectAllServers();
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void run(controller).catch((error) => {
          reportRouteFailure(
            "App connection cleanup failed",
            new Error(
              error instanceof Error ? error.name : "AppCleanupFailure",
            ),
            { source: "web.harness-widget", hop: "mcpjam_internal" },
          );
          if (!closed)
            controller.error(new Error("The App action could not finish."));
          closed = true;
        });
      },
      cancel(reason) {
        closed = true;
        abort.abort(reason);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (
      !(error instanceof ExecutionControlError) &&
      !(error instanceof z.ZodError)
    )
      reportRouteFailure(
        "App action refused",
        new Error(error instanceof Error ? error.name : "AppActionFailure"),
        { source: "web.harness-widget", hop: "mcpjam_internal" },
      );
    return c.json(
      { error: "This App action is no longer available in the current chat." },
      409,
    );
  }
});
