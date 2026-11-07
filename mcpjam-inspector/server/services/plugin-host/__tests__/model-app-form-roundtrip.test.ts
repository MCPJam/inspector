import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { requestFormInput } from "@openai/mcp-extensions/server";
import { MCPClientManager, type MrtrOperationState } from "@mcpjam/sdk";
import type { MrtrElicitationResponse } from "../../../../shared/mrtr-continuation.js";

const f = vi.hoisted(() => ({
  url: "", state: undefined as MrtrOperationState | undefined,
  responses: {} as Record<string, MrtrElicitationResponse>,
  managers: [] as MCPClientManager[],
  creates: 0,
}));
const host = {
  hostId: "host", modelId: "model", systemPrompt: "", temperature: 0,
  requireToolApproval: false, hostStyle: "chatgpt", harness: "codex",
  executionScope: { kind: "project", projectId: "project" }, mcpProfile: {},
};
const identity = () => ({
  serverId: "server", credentialId: "credential", credentialAuthorizedAt: 100,
  config: { transportType: "http", url: f.url, credentialConfigurationId: "a".repeat(64) },
});
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: async (_ref: unknown, args: { hostId?: string; serverIds?: string[] }) => ({
    actorId: "actor", projectId: "project",
    ...(args.hostId ? { hostConfig: host } : {}),
    serverBindings: args.serverIds?.map(serverId => ({ kind: "standalone", serverId })),
  }) }),
}));
vi.mock("../../../routes/web/auth.js", () => ({
  projectServerSchema: z.object({ projectId: z.string(), serverId: z.string() }),
  createManualHostedConnection: async (_c: unknown, _body: unknown, _schema: unknown, options: {
    hostConfig: { clientCapabilities: Record<string, unknown> };
    extensionRequestHandlers?: NonNullable<ConstructorParameters<typeof MCPClientManager>[1]>["extensionRequestHandlers"];
  }) => {
    const manager = new MCPClientManager({}, { lazyConnect: true, extensionRequestHandlers: options.extensionRequestHandlers });
    f.managers.push(manager);
    return { manager,
      authorizedServerConfigs: { server: { url: f.url, clientCapabilities: options.hostConfig.clientCapabilities, timeout: 10_000 } },
      authorizedServerIdentities: { server: identity() },
    };
  },
}));
vi.mock("../receipt-store.js", () => ({ createPluginInvocationReceiptPort: () => undefined }));
// Only the durable backend boundary is in memory. The route, owner, runtime,
// collector, form validation and resumed MCP request are production code.
vi.mock("../../../utils/mrtr-continuation-state.js", async original => {
  const actual = await original<typeof import("../../../utils/mrtr-continuation-state.js")>();
  return { ...actual, createContinuation: async (_bearer: string, body: import("../../../utils/mrtr-continuation-state.js").CreateContinuationBody) => {
    f.creates++;
    f.state = actual.decodeResumeState(body.resumeState, 512 * 1024);
    return { ok: true, continuationId: body.continuationId, status: "awaiting_input", round: 1, stateVersion: 1, expiresAt: Date.now() + 60_000, createdAt: Date.now(), idempotent: false };
  } };
});
vi.mock("../../../utils/mrtr-hosted-collector.js", async original => {
  const actual = await original<typeof import("../../../utils/mrtr-hosted-collector.js")>();
  return { ...actual, resumeMrtrContinuationLeg: async (options: Parameters<typeof actual.resumeMrtrContinuationLeg>[0]) => {
    if (!f.state) throw new Error("Missing private continuation state");
    const prepared = await options.prepareLeg!(f.state, f.responses);
    await prepared.commit();
    const leg = await options.driveLeg(f.state, prepared.responses);
    if (leg.status !== "complete") throw new Error("Unexpected second form");
    return { outcome: "completed", result: leg.result };
  } };
});
import { admitPluginWorkspace } from "../admission.js";
import { createPluginRequestRuntime } from "../request-runtime.js";
import { pluginConnectionPool } from "../connection-pool.js";
import { pluginModelAppRoutes } from "../../../routes/web/plugin-model-apps.js";
import { modelApps } from "../model-apps.js";
import { pluginInstances } from "../instances.js";
import { pluginFormSources } from "../form-sources.js";
import { PLUGIN_MODEL_APP_META, pluginModelAppSchema } from "../../../../shared/plugin-model-app.js";

let server: http.Server;
const calls: Record<string, unknown>[] = [];
let effects = 0;
const meta = { ui: { resourceUri: "ui://library", visibility: ["model", "app"] } };
const schema = { type: "object" as const, properties: {
  enabled: { type: "boolean" as const }, count: { type: "number" as const },
}, required: ["enabled", "count"] };
beforeEach(async () => {
  f.creates = 0; f.state = undefined; f.managers = []; calls.length = 0; effects = 0;
  const node = toNodeHandler(createMcpHandler(() => {
    const mcp = new McpServer({ name: "model-form", version: "1" }, { capabilities: { tools: {} } });
    mcp.registerTool("library", { description: "Library", inputSchema: z.object({}), _meta: meta }, async () => ({ content: [] }));
    mcp.registerTool("pick", { description: "Form", inputSchema: z.object({}), _meta: { ui: { visibility: ["app"] } } }, async (_input, ctx) => {
      const answer = requestFormInput(ctx, { mode: "form", key: "form", message: "Choose", requestedSchema: schema, requestState: "private-state" });
      if ("resultType" in answer) return answer;
      effects++;
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    });
    return mcp;
  }));
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (body?.method === "tools/call") calls.push(body.params);
    await node(req, res, body);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterEach(async () => {
  await pluginConnectionPool.clear();
  await Promise.allSettled(f.managers.map(manager => manager.disconnectAllServers()));
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

it.each(["accept", "cancel"] as const)("runs a model App's real MRTR %s round with its own form owner", async action => {
  const actor = { actorId: "actor", projectId: "project", workspaceId: crypto.randomUUID(), subject: "user:actor" };
  const admission = await admitPluginWorkspace({ projectId: actor.projectId, bearer: "fixture", descriptor: { version: 1, workspaceId: actor.workspaceId } });
  const context = new Hono();
  let token = "";
  context.post("/seed", async c => {
    const runtime = createPluginRequestRuntime(c, admission, "fixture", { hostId: "host", serverId: "server" }, undefined, { ownedForms: false });
    try {
      const source = await runtime.resolve("library", c.req.raw.signal);
      const published = modelApps.publish({ content: [] }, { owner: {
        ...actor, instanceId: crypto.randomUUID(), generation: 1, serverId: "server", bindingId: source.bindingId, placement: "interactive",
      }, subject: actor.subject, hostId: "host", hostRevision: source.hostRevision, serverIdentity: source.serverIdentity }, "library", source.revision, source.tool._meta);
      const envelope = z.object({ _meta: z.object({ [PLUGIN_MODEL_APP_META]: pluginModelAppSchema }) }).parse(published);
      token = envelope._meta[PLUGIN_MODEL_APP_META].instanceToken;
      return c.json({ ok: true });
    } finally { await runtime.release(); }
  });
  context.route("/model", pluginModelAppRoutes({
    route: async (_c, run) => run(),
    admitted: async () => ({ actor, bearer: "fixture", admission }),
    cleanup: async () => actor,
  }));
  await context.request("/seed", { method: "POST" });
  const body = { projectId: "project", pluginWorkspace: { version: 1, workspaceId: actor.workspaceId }, instanceToken: token, invocationId: crypto.randomUUID(), params: { name: "pick", arguments: {} } };
  const call = (extra = {}) => context.request("/model/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...extra }) });
  try {
    const pending = await (await call()).json();
    expect(pending.status).toBe("input_required");
    expect(pending.inputRequests[0].requestedSchema).toEqual(schema);
    const owner = modelApps.get(token, actor).owner.owner;
    expect(pluginInstances.getFormOwner(owner, actor).owner).toEqual(owner);
    expect(pluginFormSources.get(pending.inputRequests[0].pluginFormSourceToken, actor, { kind: "mrtr", id: pending.continuationId, round: 1, inputRequestKey: "form" }).source.owner).toEqual(owner);
    expect(effects).toBe(0);
    f.responses = { form: { action, ...(action === "accept" ? { content: { enabled: false, count: 0 } } : {}) } };
    const completed = await (await call({ resume: { continuationId: pending.continuationId, round: 1, responsesBlobId: "private-answer" } })).json();
    expect(completed.status).toBe("completed");
    expect(JSON.parse(completed.result.content[0].text)).toEqual(f.responses.form);
    expect(f.creates).toBe(1);
    expect(effects).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].requestState).toBe("private-state");
  } finally {
    const owner = modelApps.get(token, actor).owner.owner;
    modelApps.close(token, actor);
    expect(() => pluginInstances.getFormOwner(owner, actor)).toThrow();
  }
});
