import { afterEach, expect, it, vi } from "vitest";
import { Context } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
const capture = vi.hoisted(() => ({ names: [] as (string | undefined)[] }));
vi.mock("../../../utils/mrtr-hosted-collector.js", async (original) => ({
  ...(await original<typeof import("../../../utils/mrtr-hosted-collector.js")>()),
  createHostedMrtrCollector: (options: { serverName?: string }) => {
    capture.names.push(options.serverName);
    return async () => ({});
  },
}));
import { createOwnedPluginMrtr } from "../owned-mrtr";
import type { ResolvedInvocationContext } from "../invocation";
afterEach(() => { vi.restoreAllMocks(); capture.names.length = 0; });

it("passes the freshly admitted server name to each modern form collector", async () => {
  const manager = new MCPClientManager({}, { lazyConnect: true });
  vi.spyOn(manager, "getInitializationInfo").mockReturnValue({
    protocolVersion: "2026-07-28", transport: "streamable-http",
    serverCapabilities: {}, serverVersion: undefined, instructions: undefined,
    clientCapabilities: {},
  });
  vi.spyOn(manager, "getServerConfig").mockReturnValue({ url: "https://fixture.test/mcp" });
  let name = "stale name";
  const service = createOwnedPluginMrtr({
    c: new Context(new Request("http://localhost/test")),
    bearer: "fixture", projectId: "project", serverId: "opaque-server-id",
    serverName: () => name,
    sourceBinding: { hostId: "host", hostRevision: "revision" },
    assertCurrent: async () => { name = "Bits & Bolts"; },
    manager: () => manager,
  });
  const auth: ResolvedInvocationContext = {
    owner: { actorId: "actor", projectId: "project", workspaceId: "workspace", instanceId: "instance",
      generation: 1, serverId: "opaque-server-id", bindingId: "binding", placement: "interactive" },
    origin: "app", revision: "revision", tool: { name: "pick" }, enabled: true,
    requiresApproval: false, allowedOrigins: ["app"],
  };
  const inputs = { choice: { method: "elicitation/create" as const, params: {
    mode: "form" as const, message: "Choose", requestedSchema: { type: "object", properties: {} },
  } } };
  await service.execute(auth, "operation", { name: "pick" }, new AbortController().signal,
    () => service.collector({ state: {
      opId: "operation", round: 1, maxRounds: 4, pendingInputRequests: inputs,
      method: "tools/call", originalParams: { name: "pick" },
    }, inputRequests: inputs }));
  expect(capture.names).toEqual(["Bits & Bolts"]);
  await manager.disconnectAllServers();
});
