import { setManagerResourceHostConfig, setManagerResourceSnapshots } from "../../../mcp-connections";
import { expect, it } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import { forwardingAdmission } from "../enhanced-admission";
const caps = {
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
};
function candidate(
  config: Record<string, unknown> = {},
  capabilities: object = caps,
  serverCapabilities: object = { tools: {} },
) {
  return {
    hostCapabilities: { capabilities: {}, gaps: [] },
    manager: {
      getServerConfig: () => ({
        url: "https://fixture.test/mcp",
        timeout: 60_000,
        capabilities,
        ...config,
      }),
      getInitializationInfo: () => ({
        protocolVersion: "2026-07-28",
        transport: "streamable-http",
        clientCapabilities: capabilities,
        serverCapabilities,
      }),
    } as unknown as MCPClientManager,
    serverIds: ["server"],
  };
}
it("selects the qualified modern bridge before starting the CLI", () => {
  expect(forwardingAdmission(candidate()).delivery).toBe("bridge");
});

it.each([
  { logging: {} },
  { tools: { listChanged: true } },
  { resources: { subscribe: true } },
  { prompts: { listChanged: true } },
  { extensions: { "example.org/future": {} } },
  { tools: { futureOption: false } },
])("retains a server whose enhanced behavior is unqualified: %j", serverCapabilities => {
  const result = forwardingAdmission(candidate({}, caps, serverCapabilities));
  expect(result.delivery).toBeUndefined();
  expect(result.gaps.some(gap => gap.startsWith("server-capability:"))).toBe(true);
});

it.each([{}, {futureSetting: true}])("requires the owned Task handler for a declared server Task extension", settings => {
  const input = candidate({}, caps, {
    tools: {}, extensions: { "io.modelcontextprotocol/tasks": settings },
  });
  Object.assign(input.manager, {getTasksSupport: () => ({wire:"extension"})});
  expect(forwardingAdmission(input).delivery).toBeUndefined();
  expect(forwardingAdmission({...input, ownedTasksAvailable: true}).delivery).toBe("bridge");
});

it("leaves raw forwarding of server capabilities to the real client", () => {
  const input = candidate({timeout: 300_000}, {}, {logging:{}});
  Object.assign(input.manager, {getInitializationInfo: () => ({
    protocolVersion: "2025-11-25", transport: "streamable-http",
    clientCapabilities: {}, serverCapabilities: {logging:{}},
  })});
  expect(forwardingAdmission({...input, respectToolVisibility:false}).delivery).toBe("native");
});
it("keeps a profile with an unsupported App declaration on its configured path", () => {
  expect(forwardingAdmission({ ...candidate(), hostCapabilities: {
    capabilities: { futureCapability: {} }, gaps: ["host-capability:futureCapability"],
  } }).delivery).toBeUndefined();
});
it("requires an authoritative effective host declaration", () => {
  expect(forwardingAdmission({ ...candidate(), hostCapabilities: undefined }).delivery).toBeUndefined();
});
it("requires owned input delivery separately from the legacy callback", () => {
  const input = candidate({}, { ...caps, elicitation: { form: {}, url: {} } });
  expect(
    forwardingAdmission({ ...input, elicitationRuntimeVersion: "2.1.245" })
      .delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission({ ...input, modernInputAvailable: true }).delivery,
  ).toBe("bridge");
});
it("retains the existing path for connection behavior the bridge cannot reproduce", () => {
  expect(
    forwardingAdmission(
      candidate({ requestInit: { headers: { authorization: "private" } } }),
    ).delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission(candidate({ sessionId: "legacy" })).delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission({ ...candidate(), hasTasks: true }).delivery,
  ).toBeUndefined();
  expect(
    forwardingAdmission({
      ...candidate(),
      modelVisibleMcpToolResults: { directContent: { text: false } },
    }).delivery,
  ).toBeUndefined();
});
it("admits Task delivery only with the owned browser handshake", () => {
  const tasks = candidate({}, {extensions: {"io.modelcontextprotocol/tasks": {}}});
  expect(forwardingAdmission({...tasks,hasTasks:true}).delivery).toBeUndefined();
  expect(forwardingAdmission({...tasks,hasTasks:true,ownedTasksAvailable:true}).delivery).toBe("bridge");
});

it("rebuilds stored headers only for a backend-authorized connection snapshot", () => {
  const input = candidate({requestInit: {headers: {authorization: "private", "x-stored": "same-account"}}});
  expect(forwardingAdmission(input).delivery).toBeUndefined();
  setManagerResourceHostConfig(input.manager, "host-config", "host");
  setManagerResourceSnapshots(input.manager, new Map([["server", {serverUpdatedAt: 1, credentialAuthorizedAt: 2, headersReconstructible: true}]]));
  expect(forwardingAdmission(input).delivery).toBe("bridge");
});
it("does not admit unsupported fetch options even on an authorized connection", () => {
  const input = candidate({requestInit: {headers: {authorization: "private"}, credentials: "include"}});
  setManagerResourceHostConfig(input.manager, "host-config", "host");
  setManagerResourceSnapshots(input.manager, new Map([["server", {serverUpdatedAt: 1, credentialAuthorizedAt: 2, headersReconstructible: true}]]));
  expect(forwardingAdmission(input).delivery).toBeUndefined();
});

it("retains caller-token headers even when the connection has an authorization snapshot", () => {
  const input = candidate({requestInit: {headers: {authorization: "caller-only"}}});
  setManagerResourceHostConfig(input.manager, "host-config", "host");
  setManagerResourceSnapshots(input.manager, new Map([["server", {serverUpdatedAt: 1, credentialAuthorizedAt: null, headersReconstructible: false}]]));
  expect(forwardingAdmission(input).delivery).toBeUndefined();
});
