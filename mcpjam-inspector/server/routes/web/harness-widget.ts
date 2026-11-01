import { retainedResourceProofSchema, readRetainedResourceSource } from "@/shared/retained-app-resources";
import { retainedProfileFingerprint, retainedResourceLegGate, readRetainedResourceScope } from "../../utils/harness/forwarding/retained-resources";
import { historyProvenanceContextFor, verifyToolResult, verifyAppResourceSource } from "../../utils/history-provenance";
import { appResourcesEnabled, appToolsEnabled } from "@/shared/app-resource-capability";
import { buildMcpAppsWidgetContent, mcpAppsWidgetContentSchema } from "./apps";
import { Hono, type Context } from "hono";
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
import {
  executeForwardedOperation,
  type GateApproval,
} from "../../utils/harness/forwarding/execution-gate.js";
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
import { isEnhancedMcpProfile } from "../../utils/harness/harness-connection-profile.js";
import { forwardingInputHost } from "../../utils/harness/forwarding/owned-input.js";
import { createForwardingMrtrGate } from "../../utils/harness/forwarding/mrtr-gate.js";
import { harnessElicitationModes } from "../../utils/harness/input-host.js";
import { HOSTED_HARNESS_INPUT_VERSION } from "@/shared/hosted-elicitation";
import {
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
} from "../../utils/effective-auth.js";

const nativeWidgetContextSchema = z.strictObject({owner: forwardingOwnerSchema, parentExecutionId: z.string().min(1)});
const requestSchema = z.strictObject({context: z.union([nativeWidgetContextSchema, retainedResourceProofSchema]), toolName: z.string().min(1).max(512), arguments: z.record(z.string(), z.unknown())});
const userQuery = makeFunctionReference<"query">("users:getCurrentUser");
const userSchema = z.object({ _id: z.string() });
async function authorizeWidgetConnection(c: Context, context: z.infer<typeof requestSchema>["context"], toolAction = false) {
    const proof = "claim" in context ? context : undefined;
    const source = proof ? readRetainedResourceSource(proof.claim.output) : undefined;
    if (proof && (!source || source.toolCallId !== proof.claim.toolCallId)) throw new Error("App source unavailable");
    if (proof && source) {
      const provenance = historyProvenanceContextFor(source.projectId, source.chatSessionId);
      const {attestation, ...unsigned} = source;
      if (!provenance || !verifyAppResourceSource(provenance, unsigned, attestation) || !verifyToolResult(provenance, proof.claim, proof.signature)) throw new Error("App source unavailable");
    }
    const owner = "owner" in context ? context.owner : source?.owner;
    if (!owner) throw new Error("App source unavailable");
    const parentExecutionId = "parentExecutionId" in context ? context.parentExecutionId : undefined;
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
      ...(source?.turnId ? {retainedParent: {toolCallId: source.toolCallId, turnId: source.turnId, scopeDigest: source.digest}} : {}),
    });
    const revalidateScope = source ? async () => {
      const current = await readRetainedResourceScope(source.owner, source.digest);
      if (current.binding.owner.userId !== user._id || current.binding.projectId !== source.projectId || current.binding.chatSessionId !== source.chatSessionId) throw new Error("App source changed");
    } : async () => { await control.widgetScope(); };
    const retained = source ? await readRetainedResourceScope(source.owner, source.digest) : undefined;
    if (retained && (retained.binding.projectId !== source?.projectId || retained.binding.chatSessionId !== source?.chatSessionId)) throw new Error("App source changed");
    const scope = retained ? {...retained.binding, organizationId: retained.organizationId, hostConfig: retained.hostConfig, expiresAt: retained.expiresAt, turnId: source?.turnId ?? source?.toolCallId ?? ""} : await control.widgetScope();
    if (toolAction && (!appToolsEnabled(scope.hostConfig) || (source && !source.turnId))) throw new Error("App tools unavailable");
    const allowed = (process.env.HARNESS_FORWARDING_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim());
    if (!allowed.includes(scope.organizationId))
      return c.json({ error: "App forwarding is unavailable." }, 403);
    const pins = buildHostConnectionPins(scope.hostConfig, 300_000);
    const capabilities = hostClientCapabilities(scope.hostConfig);
    if (
      harnessElicitationModes(capabilities).length &&
      c.req.header("x-mcpjam-harness-input-version") !==
        String(HOSTED_HARNESS_INPUT_VERSION)
    )
      return c.json(
        { error: "Reload this chat before answering App input." },
        409,
      );
    const input = await forwardingInputHost({
      credential: { bearer },
      projectId: scope.projectId,
      chatSessionId: scope.chatSessionId,
      serverId: owner.serverId,
      capabilities,
      signal: c.req.raw.signal,
    });
    const initializePins = {
      ...pins.initializePins,
      ...conformanceKnobsFromMcpProfile(scope.hostConfig.mcpProfile),
      mirrorToolParamHeaders: mirrorToolParamHeadersFromMcpProfile(
        scope.hostConfig.mcpProfile,
      ),
    };
    try {
    const authorized = await createAuthorizedManager(
      callerContextFromHono(c),
      bearer,
      scope.projectId,
      [owner.serverId],
      pins.timeoutMs,
      undefined,
      capabilities,
      {
        lazyConnect: true,
        ...(input ? { elicitationCallback: input.host.callback } : {}),
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
          ? { connectionIds: { [owner.serverId]: owner.connectionId }, onlySelectedConnections: true }
          : {}),
      },
    );
    const serverKey = authorized.connectionsByServerId?.[owner.serverId]?.find(connection => connection.connectionId === owner.connectionId)?.key ?? owner.serverId;
    return { owner, control, scope, input, authorized, revalidateScope, resourceOnly: !!source, retainedSource: source, serverKey };
    } catch (error) { await input?.dispose(); throw error; }
}

export const harnessWidgets = new Hono();

/** Widgets authenticate as the user; a stopped model lease supplies no authority here. */
harnessWidgets.post("/widget", async (c) => {
  try {
    if (process.env.HARNESS_NATIVE_FORWARDING !== "true")
      return c.json({ error: "App forwarding is unavailable." }, 404);
    const body = requestSchema.parse(
      JSON.parse(await readNativeBody(c.req.raw)),
    );
    const connection = await authorizeWidgetConnection(c, body.context, true);
    if (connection instanceof Response) return connection;
    const { owner, control, scope, input, authorized, serverKey, resourceOnly, retainedSource, revalidateScope } = connection;
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
        abort.signal.throwIfAborted();
        const baseApproval = forwardingApproval(
          control,
          owner,
          scope.projectId,
        );
        const approval: GateApproval = {
          ...baseApproval,
          ask: async (request) => {
            send({
              type: "approval",
              id: forwardingApprovalId(
                request.executionId,
                owner,
                request.approvalId,
              ),
            });
            return baseApproval.ask(request);
          },
        };
        const config = authorized.authorizedServerConfigs?.[serverKey];
        if (!config || !("url" in config))
          throw new Error("App connection unavailable");
        if (input)
          authorized.manager.setMrtrInputCollector(
            serverKey,
            input.host.collectMrtrForServer(owner.serverId),
            {
              aroundLeg: createForwardingMrtrGate({
                control,
                approval,
                turnId: scope.turnId,
                expiresAt: Math.min(scope.expiresAt, Date.now() + 300_000),
                signal: abort.signal,
              }),
            },
          );
        await authorized.manager.connectToServer(serverKey, config, {
          signal: abort.signal,
        });
        const catalog = await authorized.manager.listTools(
          serverKey,
          undefined,
          { signal: abort.signal },
        );
        if (resourceOnly ? retainedProfileFingerprint(authorized.manager, serverKey) !== retainedSource?.profile : !isEnhancedMcpProfile(authorized.manager, serverKey, !!input))
          throw new Error(
            "App connection no longer matches its qualified profile",
          );
        const tool = catalog.tools.find(
          (entry) => entry.name === body.toolName,
        );
        if (!tool || isVisibleToModelOnly(tool._meta))
          throw new Error("App tool unavailable");
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
          approval,
          dispatch: async (settle, snapshot) => {
            const params = z
              .object({
                name: z.string(),
                arguments: z.record(z.string(), z.unknown()),
              })
              .parse(snapshot.params);
            await revalidateScope();
            const currentTools = await authorized.manager.listTools(serverKey, undefined, {signal: abort.signal, cacheMode: "bypass"});
            const currentTool = currentTools.tools.find(entry => entry.name === params.name);
            if (!currentTool || isVisibleToModelOnly(currentTool._meta)) throw new Error("App tool unavailable");
            await revalidateScope();
            abort.signal.throwIfAborted();
            const result = await authorized.manager.executeTool(
              serverKey,
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
        await input?.dispose();
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


harnessWidgets.post("/widget-resources", async c => {
  let connection: Awaited<ReturnType<typeof authorizeWidgetConnection>> | undefined;
  try {
    if (process.env.HARNESS_NATIVE_FORWARDING !== "true") return c.json({ error: "App forwarding is unavailable." }, 404);
    const body = z.strictObject({
      context: requestSchema.shape.context,
      operation: z.discriminatedUnion("method", [
        z.strictObject({ method: z.literal("resources/read"), uri: z.string().min(1), _meta: z.record(z.string(), z.unknown()).optional() }),
        z.strictObject({ method: z.enum(["resources/list", "resources/templates/list"]), cursor: z.string().optional() }),
        z.strictObject({ method: z.literal("widget/content"), request: mcpAppsWidgetContentSchema.omit({ projectId: true }) }),
      ]),
    }).parse(JSON.parse(await readNativeBody(c.req.raw)));
    connection = await authorizeWidgetConnection(c, body.context);
    if (connection instanceof Response) return connection;
    const { owner, control, authorized, input, scope, revalidateScope, resourceOnly, serverKey } = connection;
    if (body.operation.method !== "widget/content" && !appResourcesEnabled(scope.hostConfig)) throw new Error("App resources unavailable");
    const signal = c.req.raw.signal;
    const config = authorized.authorizedServerConfigs?.[serverKey];
    if (!config || !("url" in config)) throw new Error("App connection unavailable");
    if (input) authorized.manager.setMrtrInputCollector(serverKey, input.host.collectMrtrForServer(owner.serverId), {
      aroundLeg: resourceOnly ? retainedResourceLegGate(revalidateScope, signal) : createForwardingMrtrGate({ control, approval: forwardingApproval(control, owner, scope.projectId), turnId: scope.turnId, expiresAt: Math.min(scope.expiresAt, Date.now() + 300_000), signal }),
    });
    await authorized.manager.connectToServer(serverKey, config, { signal });
    if (resourceOnly ? !("claim" in body.context) || retainedProfileFingerprint(authorized.manager, serverKey) !== readRetainedResourceSource(body.context.claim.output)?.profile : !isEnhancedMcpProfile(authorized.manager, serverKey, !!input)) throw new Error("App connection no longer matches its producing profile");
    await revalidateScope();
    signal.throwIfAborted();
    const operation = body.operation;
    if (operation.method === "widget/content" && operation.request.serverId !== owner.serverId) throw new Error("App resource changed");
    const result = operation.method === "widget/content"
      ? await buildMcpAppsWidgetContent(authorized.manager, { ...operation.request, projectId: scope.projectId, serverId: serverKey }, signal)
      : operation.method === "resources/read"
        ? await authorized.manager.readResource(serverKey, { uri: operation.uri, ...(operation._meta ? { _meta: operation._meta } : {}) }, { signal })
        : operation.method === "resources/list"
          ? await authorized.manager.listResources(serverKey, operation.cursor !== undefined ? { cursor: operation.cursor } : undefined, { signal, cacheMode: "bypass" })
          : await authorized.manager.listResourceTemplates(serverKey, operation.cursor !== undefined ? { cursor: operation.cursor } : undefined, { signal, cacheMode: "bypass" });
    await revalidateScope();
    signal.throwIfAborted();
    return c.json(result);

  } catch (error) {
    if (!(error instanceof ExecutionControlError) && !(error instanceof z.ZodError)) reportRouteFailure("App resource refused", new Error(error instanceof Error ? error.name : "AppResourceFailure"), { source: "web.harness-widget.resource", hop: "user_server_hop" });
    return c.json({ error: "This App resource is no longer available in the current chat." }, 409);
  } finally {
    if (connection && !(connection instanceof Response)) {
      try { await connection.input?.dispose(); } finally { await connection.authorized.manager.disconnectAllServers(); }
    }
  }
});
