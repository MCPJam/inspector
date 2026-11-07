import { Context } from "hono";
import { Client } from "@modelcontextprotocol/client";
import { MCPClientManager } from "@mcpjam/sdk";
import { OfficialSdkClientAdapter } from "../../../../../sdk/src/mcp-client-manager/official-sdk-client-adapter.js";
import { afterEach, expect, it, vi } from "vitest";
import { PluginContinuationRefused, PluginContinuationTerminal, type ResolvedInvocationContext } from "../invocation";

const seams = vi.hoisted(() => ({
  resume: vi.fn<typeof import("../../../utils/mrtr-hosted-collector.js").resumeMrtrContinuationLeg>(),
}));
vi.mock("../../../utils/mrtr-hosted-collector.js", async (original) => ({
  ...(await original<typeof import("../../../utils/mrtr-hosted-collector.js")>()),
  resumeMrtrContinuationLeg: seams.resume,
}));
import { createOwnedPluginMrtr } from "../owned-mrtr";
import { pluginFormSources } from "../form-sources";
import { pluginFormFileGrants } from "../form-file-grants";

afterEach(() => {
  vi.restoreAllMocks();
  seams.resume.mockReset();
});

async function fixture(options: {
  origin?: "app" | "model";
  hasUploads?: boolean;
  disableAt?: "admission" | "commit";
}) {
  const origin = options.origin ?? "app";
  const owner = {
    actorId: "actor", projectId: "project", workspaceId: crypto.randomUUID(),
    instanceId: crypto.randomUUID(), generation: 1, serverId: "server",
    bindingId: "binding", placement: "interactive" as const,
  };
  const schema = {
    type: "object", properties: { file: {
      type: "string", format: "uri", "x-openai-input": {
        type: "resource", options: [{ uri: "fixture://selected", name: "Selected" }],
        userOptions: { kind: "file" },
      },
    } },
  };
  const parent = { kind: "mrtr" as const, id: crypto.randomUUID(), round: 1, inputRequestKey: "input" };
  const source = pluginFormSources.bind({
    owner, origin, parent, hostId: "host", hostRevision: "host-revision",
    invocationId: "operation", revision: "revision", toolName: "tool",
    requestedSchema: schema, expiresAt: Date.now() + 10000,
    fileResources: true, uploadTarget: "local-stdio",
  });
  const manager = new MCPClientManager({}, { lazyConnect: true });
  vi.spyOn(manager, "getInitializationInfo").mockReturnValue({
    protocolVersion: "2026-07-28", transport: "streamable-http",
    serverCapabilities: {}, serverVersion: undefined, instructions: undefined,
    clientCapabilities: {},
  });
  vi.spyOn(manager, "getServerConfig").mockReturnValue({ url: "https://fixture.test/mcp" });
  vi.spyOn(manager, "getManagedClient").mockReturnValue(
    new OfficialSdkClientAdapter(new Client({ name: "fixture", version: "1" })),
  );
  const closedSources = vi.spyOn(pluginFormSources, "closeOperation");
  const closedGrants = vi.spyOn(pluginFormFileGrants, "closeOperation");
  const committed = vi.fn();
  const wire = vi.fn();
  vi.spyOn(pluginFormFileGrants, "prepareDelivery").mockReturnValue({
    content: { file: "fixture://selected" }, hasUploads: options.hasUploads ?? true,
    assertReady: () => {}, commit: committed,
  });
  let fileResourcesEnabled = true;
  let reads = 0;
  const service = createOwnedPluginMrtr({
    c: new Context(new Request("http://localhost/test")), bearer: "fixture",
    projectId: "project", serverId: "server", manager: () => manager,
    sourceBinding: { hostId: "host", hostRevision: "host-revision" },
    fileResources: true, fileResourcesEnabled: () => fileResourcesEnabled,
    uploadTarget: () => "local-stdio",
    assertCurrent: async () => {
      if (++reads === (options.disableAt === "admission" ? 2 : 3) && options.disableAt) fileResourcesEnabled = false;
    },
  });
  seams.resume.mockImplementationOnce(async (deps) => {
    let preparedInput = false;
    try {
      const prepared = await deps.prepareLeg!({
        opId: "operation", round: 1, maxRounds: 4, method: "tools/call",
        originalParams: { name: "tool" }, pendingInputRequests: {
          input: { method: "elicitation/create", params: { mode: "form", message: "Choose", requestedSchema: schema } },
        },
      }, { input: { action: "accept", content: { file: "fixture://selected" } } });
      preparedInput = true;
      // The real continuation helper awaits its durable lease and wire fence here.
      await Promise.resolve();
      // Permission changes are visible only after refreshing the runtime snapshot.
      await prepared.commit();
      wire(prepared.responses);
      return { outcome: "completed", result: { content: [] } };
    } catch {
      return { outcome: "failed", reason: "Continuation input admission refused", ...(preparedInput ? { terminal: true as const } : {}) };
    }
  });
  const authorization: ResolvedInvocationContext = {
    owner, origin, revision: "revision", tool: { name: "tool" }, enabled: true,
    requiresApproval: false, allowedOrigins: [origin],
  };
  try {
    return {
      result: await service.resume(authorization, "operation", { name: "tool" }, {
        continuationId: parent.id, round: 1, responsesBlobId: "answer",
      }, new AbortController().signal).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      committed, wire, closedSources, closedGrants,
    };
  } finally {
    source.release();
    await manager.disconnectAllServers();
  }
}

it.each(["admission", "commit"] as const)(
  "refuses App uploads when File resources is revoked during %s",
  async (disableAt) => {
    const { result, committed, wire, closedSources, closedGrants } = await fixture({ disableAt });
    expect(result).toMatchObject({ ok: false, error: {
      code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED", diagnostics: [expect.objectContaining({
        code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED", serverId: "server",
      })],
    } });
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(disableAt === "commit" ? PluginContinuationTerminal : PluginContinuationRefused);
    }
    if (disableAt === "commit") {
      expect(closedSources).toHaveBeenCalledOnce();
      expect(closedGrants).toHaveBeenCalledOnce();
    } else {
      expect(closedSources).not.toHaveBeenCalled();
      expect(closedGrants).not.toHaveBeenCalled();
    }
    expect(committed).not.toHaveBeenCalled();
    expect(wire).not.toHaveBeenCalled();
  },
);

it.each([
  { origin: "app" as const },
  { origin: "model" as const, disableAt: "admission" as const },
  { origin: "app" as const, hasUploads: false, disableAt: "admission" as const },
])("preserves permitted upload and explicit-option delivery: %j", async (options) => {
  const { result, committed, wire } = await fixture(options);
  expect(result).toEqual({ ok: true, value: { content: [] } });
  expect(committed).toHaveBeenCalledOnce();
  expect(wire).toHaveBeenCalledOnce();
});
