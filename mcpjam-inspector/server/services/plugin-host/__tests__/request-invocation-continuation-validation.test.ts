import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  PluginInvocationError,
  PluginInvocationSuspension,
  type PluginContinuationSubmission,
} from "../invocation";
import { RequestOwnedToolInvoker } from "../request-invoker";
import { invokePluginRequest } from "../request-invocation";
import { resolvePluginCatalogTool } from "../request-runtime";
import { pluginToolCallValidation } from "../tool-call-validation";

vi.mock("../../../utils/analytics.js", () => ({ captureServerEvent: vi.fn() }));
vi.mock("../receipt-store.js", async (original) => ({
  ...(await original<typeof import("../receipt-store.js")>()),
  createPluginInvocationReceiptPort: () => undefined,
}));

const owner = {
  actorId: "actor", projectId: "project", workspaceId: "workspace",
  instanceId: "child-app", generation: 1, serverId: "server",
  bindingId: "binding", placement: "interactive" as const,
};
const tool = {
  name: "inspect", inputSchema: { type: "object" as const },
  outputSchema: {
    type: "object" as const,
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
  },
};
const catalog = {
  runtime: "chatgpt", hostRevision: "host", bindingId: "binding",
  serverIdentity: { kind: "standalone" as const, serverId: "server" },
  transport: "mrtr" as const, protocolVersion: "2026-07-28",
  requiresApproval: false, tools: [tool],
};
const suspension = (round = 1) => new PluginInvocationSuspension({
  status: "input_required", continuationId: "continuation", round,
});
const valid = { content: [], structuredContent: { enabled: false } };
const invokers: RequestOwnedToolInvoker[] = [];
afterEach(() => {
  for (const invoker of invokers.splice(0)) invoker.close();
});

function fixture(output: unknown) {
  const manager = new MCPClientManager({}, { lazyConnect: true });
  const invoker = new RequestOwnedToolInvoker(owner, () => {});
  invokers.push(invoker);
  const execute = vi.fn(async () => suspension());
  const resume = vi.fn(async () => output);
  const validate = vi.fn(pluginToolCallValidation(
    tool, {}, () => new PluginInvocationError("INSTANCE_DENIED"), "app",
  ));
  let submission: PluginContinuationSubmission | undefined;
  const app = new Hono().post("/call", async (c) => {
    try {
      return await invokePluginRequest(c, {
        actor: { ...owner, subject: "subject" }, owner,
        admission: {
          actorId: "actor", projectId: "project", workspaceId: "workspace",
          revalidate: async () => {},
        },
        runtime: {
          manager: () => manager, release: async () => {},
          executeOwned: execute, resumeMrtr: resume,
        },
        origin: "app", invocationId: "operation",
        params: { name: "inspect", arguments: {} },
        resume: submission,
        resolve: async (name) => resolvePluginCatalogTool(catalog, name),
        assertLive: () => {}, assertOrigin: () => {},
        validate: () => validate,
        invoke: (ports, params) => invoker.invoke(
          ports, "app", "operation", params, c.req.raw.signal,
        ),
      });
    } catch (error) {
      if (!(error instanceof PluginInvocationError)) throw error;
      return c.json({ code: error.code, outcomeUnknown: error.outcomeUnknown }, 403);
    }
  });
  return {
    execute, resume, validate,
    call: (round?: number) => {
      submission = round ? {
        continuationId: "continuation", round, responsesBlobId: `answer-${round}`,
      } : undefined;
      return app.request("/call", { method: "POST" });
    },
  };
}

it.each(["valid", "invalid"])(
  "validates a terminal %s App continuation once without repeating its effect",
  async (kind) => {
    const output = kind === "valid"
      ? valid
      : { content: [], structuredContent: { enabled: "false" } };
    const f = fixture(output);
    expect(await (await f.call()).json()).toMatchObject({ status: "input_required" });
    expect(f.validate).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.call(1);
      expect(response.status).toBe(kind === "valid" ? 200 : 403);
      expect(await response.json()).toEqual(kind === "valid"
        ? { status: "completed", result: output }
        : { code: "INSTANCE_DENIED", outcomeUnknown: true });
    }
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
  },
);

it("keeps another input-required round unvalidated until its terminal result", async () => {
  const f = fixture(suspension(2));
  await f.call();
  for (let attempt = 0; attempt < 2; attempt++)
    expect(await (await f.call(1)).json()).toMatchObject({ status: "input_required", round: 2 });
  expect(f.validate).not.toHaveBeenCalled();
  expect(f.resume).toHaveBeenCalledOnce();
  f.resume.mockResolvedValue(valid);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(await (await f.call(2)).json()).toEqual({ status: "completed", result: valid });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.resume).toHaveBeenCalledTimes(2);
  expect(f.validate).toHaveBeenCalledOnce();
});
