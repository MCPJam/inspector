/** Separate-process driver of the production interaction and ingress adapters. */
import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  mintToolApprovalId,
  claimToolApproval,
} from "../../../../utils/tool-approval-token.js";
import {
  createContinuation,
  claimContinuation,
} from "../../../../utils/mrtr-continuation-state.js";
import {
  createHostedScopeStepUpContinuation,
  buildHostedScopeStepUpResume,
} from "../../../../utils/hosted-scope-step-up-continuation.js";
import { HostedElicitationBridge } from "../../../../routes/web/hosted-elicitation.js";
import localChat from "../../../../routes/mcp/chat-v2.js";

const backend = process.env.CONVEX_HTTP_URL!;
const rawFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== backend)
    throw new Error(`External network blocked: ${url.hostname}`);
  return rawFetch(input, init);
};
const bridges = new Map<string, HostedElicitationBridge>();
const manager = Object.assign(new MCPClientManager(), {
  getInitializationInfo: () => ({
    protocolVersion: "2026-07-28",
    serverCapabilities: { tools: {} },
    serverVersion: { name: "fixture", version: "1" },
  }),
  getServerConfig: () => ({ url: new URL(`${backend}/mcp`) }),
});
type Command = {
  id: number;
  action: string;
  actor?: string;
  token?: string;
  continuationId?: string;
  binding?: string;
  leaseId?: string;
  rendezvousId?: string;
  timeoutMs?: number;
};
async function run(command: Command): Promise<unknown> {
  const actor = command.actor ?? "actor-a";
  const bearer = `Bearer ${actor}`;
  if (command.action === "mint")
    return mintToolApprovalId({
      call: { toolCallId: "call", toolName: "write", input: {} },
      binding: { subject: actor, projectId: actor, chatSessionId: "chat" },
    });
  if (command.action === "claim")
    return claimToolApproval(command.token!, {
      timeoutMs: command.timeoutMs ?? 1000,
    });
  if (command.action === "create")
    return createContinuation(bearer, {
      continuationId: command.continuationId!,
      projectId: actor,
      serverId: "server",
      operationId: "call",
      operationMethod: "tools/call",
      negotiatedEra: "2026-07-28",
      bindingFingerprint: command.binding ?? "binding",
      resumeState: "opaque-private-state",
      ttlMs: command.timeoutMs ?? 60000,
    });
  if (command.action === "resume")
    return claimContinuation(bearer, {
      continuationId: command.continuationId!,
      bindingFingerprint: command.binding ?? "binding",
      leaseId: command.leaseId ?? "lease",
      leaseTtlMs: 5000,
    });
  if (command.action === "scope-create")
    return createHostedScopeStepUpContinuation({
      bearer,
      authPrincipal: actor,
      projectId: actor,
      chatSessionId: "chat",
      manager,
      info: { serverId: "server", toolCallId: "call", requiredScope: "write" },
      toolName: "write",
      toolInput: { value: 1 },
    });
  if (command.action === "scope-resume") {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "write",
            input: { value: 1 },
          },
        ],
      },
    ];
    const write = Object.assign(
      tool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => {
          const response = await fetch(`${backend}/side-effect`, {
            method: "POST",
            headers: { authorization: bearer },
          });
          return response.json();
        },
      }),
      { _serverId: "server" },
    );
    return buildHostedScopeStepUpResume({
      request: {
        continuationId: command.continuationId!,
        toolCallId: "call",
      },
      bearer,
      authPrincipal: actor,
      projectId: actor,
      chatSessionId: "chat",
      manager,
      messages,
      tools: { write },
    }).resolve(() => undefined);
  }
  if (command.action === "elicit") {
    const bridge = new HostedElicitationBridge({
      convexBearer: bearer,
      projectId: actor,
      chatSessionId: "chat",
      serverNamesById: { server: "Same name" },
    });
    bridges.set(actor, bridge);
    bridge.attachStreamWriter({
      write: (chunk) => process.send?.({ event: "chunk", actor, chunk }),
    });
    return bridge.callback({
      requestId: "request-1",
      serverId: "server",
      mode: "form",
      message: "Confirm",
      schema: { type: "object", properties: { name: { type: "string" } } },
    });
  }
  if (command.action === "answer") {
    const client = new ConvexHttpClient(backend);
    client.setAuth(actor);
    return client.mutation(
      makeFunctionReference<"mutation">("elicitations:respondToElicitation"),
      {
        rendezvousId: command.rendezvousId!,
        action: "accept",
        content: { name: actor },
      },
    );
  }
  if (command.action === "cancel") {
    await bridges.get(actor)?.dispose();
    return true;
  }
  if (command.action === "local-route") {
    const app = new Hono();
    app.route("/", localChat);
    return (
      await app.request("/", {
        method: "POST",
        body: JSON.stringify({
          browserEngine: "local",
          computerEngine: "local",
        }),
      })
    ).status;
  }
  throw new Error(`Unknown fixture action ${command.action}`);
}
process.on("message", (command: Command) => {
  void run(command).then(
    (result) => process.send?.({ id: command.id, result }),
    (error) =>
      process.send?.({
        id: command.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
process.send?.({ ready: true, pid: process.pid });
