import type { Context } from "hono";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { makeFunctionReference } from "convex/server";
import { createAuthorizedManager } from "./auth.js";
import { createConvexClient } from "../v1/convex-client.js";
import { unsealHarnessProxyToken } from "../../utils/harness/harness-proxy-policy-seal.js";
import {
  createExecutionControl,
  forwardingOwnerSchema,
} from "../../utils/harness/forwarding/execution-control.js";
import { executeForwardedOperation } from "../../utils/harness/forwarding/execution-gate.js";
import {
  forwardingApproval,
  readExecutionInput,
} from "../../utils/harness/forwarding/approval.js";
import { forwardNativeMcp } from "../../utils/harness/forwarding/native-transport.js";
import { createNativeRpcLogger } from "../../utils/harness/forwarding/native-rpc-logs.js";
import { nativeApprovalResponse } from "../../utils/harness/forwarding/native-approval-response.js";
import {
  parseNativeMessage,
  readNativeBody,
  NativeWireError,
} from "../../utils/harness/forwarding/native-wire.js";
import { readForwardingApprovalId } from "@/shared/forwarding-approval";
import {
  toolApprovalClaimKey,
  verifyToolApprovalId,
} from "../../utils/tool-approval-token.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

const contextSchema = z
  .object({ owner: forwardingOwnerSchema, turnId: z.string().min(1).max(512) })
  .strict();
const userSchema = z.object({ _id: z.string() });
const userQuery = makeFunctionReference<"query">("users:getCurrentUser");

export async function handleNativeForwarding(c: Context): Promise<Response> {
  try {
    if (process.env.HARNESS_NATIVE_FORWARDING !== "true")
      return c.json({ error: "Native forwarding is unavailable." }, 404);
    const serverId = c.req.param("serverId");
    if (!serverId) return c.json({ error: "Server required." }, 400);
    const sealed = unsealHarnessProxyToken(
      c.req.header("x-mcpjam-forwarding-context"),
      serverId,
    );
    if (!sealed) return c.json({ error: "Unauthorized" }, 401);
    const context = contextSchema.parse(JSON.parse(sealed.token));
    if (context.owner.serverId !== serverId)
      return c.json({ error: "Unauthorized" }, 401);
    const accountId = context.owner.connectionId ?? `server:${serverId}`;
    const header = `x-mcpjam-forwarding-${createHash("sha256")
      .update(JSON.stringify([serverId, accountId]))
      .digest("hex")
      .slice(0, 40)}`;
    const token = c.req.header(header);
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const control = createExecutionControl({ owner: context.owner, token });
    const caller = await control.authorize();
    const allowed = (process.env.HARNESS_FORWARDING_ORGANIZATION_IDS ?? "")
      .split(",")
      .map((id) => id.trim());
    if (!allowed.includes(caller.organizationId))
      return c.json({ error: "Native forwarding is unavailable." }, 403);
    const raw =
      c.req.method === "POST" ? await readNativeBody(c.req.raw) : undefined;
    const message =
      raw === undefined
        ? undefined
        : parseNativeMessage(raw, c.req.raw.headers);
    const authorized = await createAuthorizedManager(
      {
        authMethod: "workos_api_key",
        workosUserId: caller.externalId,
        mcpjamOrganizationId: caller.organizationId,
      },
      "",
      caller.projectId,
      [serverId],
      300_000,
      undefined,
      undefined,
      {
        lazyConnect: true,
        ...(context.owner.connectionId
          ? { connectionIds: { [serverId]: context.owner.connectionId } }
          : {}),
      },
    );
    return await nativeApprovalResponse({
      rpcId: message?.id,
      signal: c.req.raw.signal,
      onError: reportNativeFailure,
      run: async (waiting, signal) => {
        try {
          const config = authorized.authorizedServerConfigs?.[serverId];
          if (
            !config ||
            !("url" in config) ||
            config.preferSSE ||
            !config.baseFetch ||
            authorized.authenticatedUserId !== caller.userId
          )
            throw new Error("Native endpoint is unavailable.");
          const send = (
            settle?: Parameters<typeof forwardNativeMcp>[0]["settle"],
          ) =>
            forwardNativeMcp({
              url: String(config.url),
              serverId,
              request: c.req.raw,
              signal,
              body: raw,
              message,
              trustedHeaders: config.requestInit?.headers,
              fetch: config.baseFetch!,
              onUnauthorized: config.onUnauthorized,
              settle,
              rpcLogger: createNativeRpcLogger({
                owner: context.owner,
                turnId: context.turnId,
                projectId: caller.projectId,
                organizationId: caller.organizationId,
              }),
            });
          if (
            !message?.method ||
            (typeof message.id !== "string" && typeof message.id !== "number")
          )
            return await send();
          const approval = forwardingApproval(
            control,
            context.owner,
            caller.projectId,
          );
          return await executeForwardedOperation({
            control,
            operation: {
              invocationKey: randomUUID(),
              turnId: context.turnId,
              rpcId: message.id,
              method: message.method,
              params: message.params,
              paramsPresent: Object.hasOwn(message, "params"),
              expiresAt: caller.expiresAt,
              policy: sealed.policy,
            },
            approval: {
              ...approval,
              ask: (request) => {
                waiting();
                return approval.ask(request);
              },
            },
            signal,
            dispatch: (settle) => send(settle),
          });
        } finally {
          await authorized.manager.disconnectAllServers();
        }
      },
    });
  } catch (error) {
    reportNativeFailure(error);
    return c.json(
      { error: "The forwarded MCP request could not complete." },
      error instanceof NativeWireError ? 400 : 409,
    );
  }
}

function reportNativeFailure(error: unknown) {
  if (!(error instanceof NativeWireError) && !(error instanceof z.ZodError))
    reportRouteFailure(
      "Native MCP forwarding failed",
      new Error(
        error instanceof Error ? error.name : "Unknown forwarding failure",
      ),
      { source: "web.harness-forwarding", hop: "user_server_hop" },
    );
}

export const harnessForwardingApprovals = new Hono();
harnessForwardingApprovals.post("/approval", async (c) => {
  try {
    const body = z
      .object({ id: z.string().max(8192), approved: z.boolean() })
      .strict()
      .parse(JSON.parse(await readNativeBody(c.req.raw, 10_000)));
    const tag = readForwardingApprovalId(body.id);
    if (!tag) return c.json({ error: "Invalid approval." }, 400);
    const owner = forwardingOwnerSchema.parse(tag.owner);
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!bearer) return c.json({ error: "Unauthorized" }, 401);
    const user = userSchema.parse(
      await createConvexClient(bearer).query(userQuery, {}),
    );
    if (user._id !== owner.userId)
      return c.json({ error: "Unauthorized" }, 403);
    const control = createExecutionControl({ owner });
    const row = await control.approvalContext(tag.executionId);
    const input = await readExecutionInput(row);
    const params =
      input.value && typeof input.value === "object" ? input.value : {};
    const toolName =
      "name" in params && typeof params.name === "string" ? params.name : "";
    const nonceHash = toolApprovalClaimKey(tag.approvalId);
    if (
      row.approval?.approvalId !== tag.approvalId ||
      !nonceHash ||
      nonceHash !== row.approval.nonceHash ||
      !verifyToolApprovalId({
        approvalId: tag.approvalId,
        call: { toolCallId: tag.executionId, toolName, input },
        binding: {
          subject: `forwarding:${owner.userId}`,
          projectId: row.authority.projectId,
          chatSessionId:
            owner.kind === "chat" ? owner.harnessSessionId : owner.sandboxRowId,
        },
      }).ok
    )
      return c.json({ error: "Invalid approval." }, 403);
    const result = await control.answerApproval(
      tag.executionId,
      nonceHash,
      body.approved ? "approved" : "denied",
    );
    if (result.state !== (body.approved ? "approved" : "denied"))
      return c.json({ error: "This approval is no longer available." }, 409);
    return c.json({ ok: true });
  } catch (error) {
    if (!(error instanceof NativeWireError) && !(error instanceof z.ZodError))
      reportRouteFailure(
        "Forwarding approval failed",
        new Error(
          error instanceof Error ? error.name : "Unknown approval failure",
        ),
        { source: "web.harness-forwarding.approval", hop: "mcpjam_internal" },
      );
    return c.json({ error: "This approval is no longer available." }, 409);
  }
});
