import type { ModelToolExecutor } from "../../../model-tool-executor";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  readRetainedResourceScope,
  retainedResourceExecutor,
  retainedResourceLegGate,
  type RetainedResourcePresentation,
} from "../retained-resources";
import {
  setManagerConnections,
  setManagerResourceHostConfig,
  setManagerResourceSnapshots,
} from "../../../mcp-connections";
import { requestExecutionControl } from "../execution-control";
vi.mock("../execution-control", () => ({ requestExecutionControl: vi.fn() }));
beforeEach(() => {vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true"); vi.stubEnv("HISTORY_PROVENANCE_SECRET", "retained-resource-unit-test-secret");});
afterEach(() => {vi.clearAllMocks(); vi.unstubAllEnvs();});
function producer(transport = "streamable-http") {
  const manager = new MCPClientManager(
    { alternate: { url: "https://fixture.example/mcp" } },
    { lazyConnect: true },
  );
  vi.spyOn(manager, "getServerConfig").mockReturnValue({
    url: "https://fixture.example/mcp",
  });
  vi.spyOn(manager, "getInitializationInfo").mockReturnValue({
    transport,
    protocolVersion: "2025-03-26",
    serverCapabilities: {},
    serverVersion: undefined,
    instructions: undefined,
    clientCapabilities: {},
  });
  setManagerConnections(manager, {
    server: [
      {
        serverId: "server",
        connectionId: "account-b",
        key: "alternate",
        label: "B",
        isDefault: false,
      },
    ],
  });
  setManagerResourceHostConfig(manager, "original-host-config", "original-host");
  setManagerResourceSnapshots(
    manager,
    new Map([
      ["alternate", { serverUpdatedAt: 123, credentialAuthorizedAt: 456, headersReconstructible: true }],
    ]),
  );
  const args = {
    manager,
    enabled: true,
    laneId: () => "lane",
    turnId: "producing-turn",
    sources: new Map<string, RetainedResourcePresentation>(),
  };
  return { ...args, executor: retainedResourceExecutor(args)! };
}
const execution = {
  serverKey: "alternate",
  toolName: "qa_read",
  toolCallId: "call",
  input: {},
};
it("sends only the service control-plane owner reference when revalidating a retained result", async () => {
  vi.mocked(requestExecutionControl).mockResolvedValue({});
  const owner = {kind: "chat" as const, userId: "user", harnessSessionId: "lane", serverId: "server", connectionId: "account-a"};
  await readRetainedResourceScope(owner, "original-digest");
  expect(requestExecutionControl).toHaveBeenCalledWith({resourceOwner: {harnessSessionId: "lane", serverId: "server", connectionId: "account-a"}, operation: {kind: "resource_scope", expectedDigest: "original-digest"}}, expect.anything());
});
it("pins the selected alias and the manager's original authorization snapshot", async () => {
  const p = producer();
  const raw = { content: [], _meta: { private: "raw" } };
  const run = vi.fn(async () => raw);
  vi.mocked(requestExecutionControl).mockResolvedValue({
    binding: {
      owner: {
        kind: "chat",
        userId: "user",
        harnessSessionId: "lane",
        serverId: "server",
        connectionId: "account-b",
      },
      digest: "digest",
      projectId: "project",
      chatSessionId: "chat",
    },
  });
  expect(await p.executor(execution, run)).toBe(raw);
  expect(requestExecutionControl).toHaveBeenCalledWith(
    expect.objectContaining({
      resourceOwner: {
        harnessSessionId: "lane",
        serverId: "server",
        connectionId: "account-b",
      },
      operation: {
        kind: "resource_scope",
        snapshot: {
          hostConfigId: "original-host-config",
          hostId: "original-host",
          serverUpdatedAt: 123,
          credentialAuthorizedAt: 456,
        },
      },
    }),
    expect.anything(),
  );
  expect(p.sources.get("call")?.owner.connectionId).toBe("account-b");
  expect(run).toHaveBeenCalledOnce();
});
it.each(["sse", "stdio"])(
  "preserves existing %s execution",
  async (transport) => {
    const p = producer(transport);
    const run = vi.fn(async () => "unchanged");
    expect(await p.executor(execution, run)).toBe("unchanged");
    expect(requestExecutionControl).not.toHaveBeenCalled();
    expect(p.sources.size).toBe(0);
  },
);
it("refuses changed producer authority before dispatch", async () => {
  const p = producer();
  const run = vi.fn();
  vi.mocked(requestExecutionControl).mockRejectedValueOnce(
    new Error("scope_mismatch"),
  );
  await expect(p.executor(execution, run)).rejects.toThrow("scope_mismatch");
  expect(run).not.toHaveBeenCalled();
});
it("preserves the disabled path", () => {
  const p = producer();
  const existing = vi.fn();
  expect(retainedResourceExecutor({ ...p, existing, enabled: false })).toBe(existing);
  expect(retainedResourceExecutor({ ...p, enabled: false })).toBeUndefined();
});
it("checks each resource leg and refuses duplicate sends", async () => {
  const revalidate = vi.fn(async () => {});
  const send = vi.fn(async () => ({ contents: [] }));
  const gate = retainedResourceLegGate(
    revalidate,
    new AbortController().signal,
  );
  const leg = {
    operationId: "op",
    round: 0,
    request: { method: "resources/read", params: { uri: "test://account" } },
    send,
  };
  await gate(leg);
  expect(revalidate).toHaveBeenCalledTimes(2);
  await expect(gate(leg)).rejects.toThrow("already attempted");
  expect(send).toHaveBeenCalledOnce();
});
it("refuses tools in a resource continuation", async () => {
  const send = vi.fn();
  const gate = retainedResourceLegGate(
    async () => {},
    new AbortController().signal,
  );
  await expect(
    gate({
      operationId: "op",
      round: 1,
      request: { method: "tools/call", params: { name: "write" } },
      send,
    }),
  ).rejects.toThrow("method changed");
  expect(send).not.toHaveBeenCalled();
});

it("pins an ungrouped shared account using its canonical authorization identity", async () => {
  const p=producer();
  setManagerConnections(p.manager,{});
  setManagerResourceSnapshots(p.manager,new Map([["server",{serverUpdatedAt:123,credentialAuthorizedAt:456,credentialId:"shared-account",headersReconstructible:true}]]));
  vi.mocked(requestExecutionControl).mockResolvedValue({binding:{owner:{kind:"chat",userId:"user",harnessSessionId:"lane",serverId:"server",connectionId:"shared-account"},digest:"digest",projectId:"project",chatSessionId:"chat"}});
  const run=vi.fn(async()=>({content:[]}));
  await p.executor({...execution,serverKey:"server"},run);
  expect(requestExecutionControl).toHaveBeenLastCalledWith({resourceOwner:{harnessSessionId:"lane",serverId:"server",connectionId:"shared-account"},operation:{kind:"resource_scope",snapshot:{hostId:"original-host",hostConfigId:"original-host-config",serverUpdatedAt:123,credentialAuthorizedAt:456}}},expect.anything());
  expect(p.sources.get("call")?.owner.connectionId).toBe("shared-account");
  expect(run).toHaveBeenCalledOnce();
});

it("binds resources while preserving an existing form executor", async () => {
  const p = producer();
  vi.mocked(requestExecutionControl).mockResolvedValue({ binding: {
    owner: { kind: "chat", userId: "user", harnessSessionId: "lane", serverId: "server", connectionId: "account-b" },
    digest: "digest", projectId: "project", chatSessionId: "chat",
  }});
  const raw = { content: [{ type: "text", text: "preserved" }] };
  const run = vi.fn(async () => raw);
  const existing = vi.fn(async (input, execute) => { expect(input).toBe(execution); return execute(); });
  const bound = retainedResourceExecutor({ ...p, existing });
  expect(await bound!(execution, run)).toBe(raw);
  expect(existing).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  expect(p.sources.get("call")?.owner.connectionId).toBe("account-b");
});

it("snapshots the negotiated capabilities without restoring withheld configured claims", async () => {
  const p = producer();
  const negotiated = {extensions: {"openai/form": {enabled: true}}};
  const initialized = p.manager.getInitializationInfo("alternate");
  if (!initialized) throw Error("Missing initialization fixture");
  vi.mocked(p.manager.getInitializationInfo).mockReturnValue({...initialized, clientCapabilities: negotiated});
  vi.mocked(p.manager.getServerConfig).mockReturnValue({url: "https://fixture.example/mcp", clientCapabilities: {extensions: {"openai/elicitation": {form: {}}}}});
  vi.mocked(requestExecutionControl).mockResolvedValue({binding: {
    owner: {kind: "chat", userId: "user", harnessSessionId: "lane", serverId: "server", connectionId: "account-b"},
    digest: "digest", projectId: "project", chatSessionId: "chat",
  }});
  await p.executor(execution, async () => ({content: []}));
  negotiated.extensions["openai/form"].enabled = false;
  expect(p.sources.get("call")?.connectionCapabilities).toEqual({extensions: {"openai/form": {enabled: true}}});
});

it("preserves caller-only execution without minting a retained source", async () => {
  const p = producer();
  setManagerResourceSnapshots(p.manager, new Map([["alternate", {serverUpdatedAt: 123, credentialAuthorizedAt: null, headersReconstructible: false}]]));
  const raw = {content: [{type: "text", text: "caller-only result"}]};
  const run = vi.fn(async () => raw);
  const existing = vi.fn<ModelToolExecutor>(async (_execution, execute) => execute());
  const executor = retainedResourceExecutor({...p, existing});
  expect(await executor!(execution, run)).toBe(raw);
  expect(existing).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
  expect(requestExecutionControl).not.toHaveBeenCalled();
  expect(p.sources.size).toBe(0);
});
