import { describe, expect, it, vi } from "vitest";
import { PluginMentionRegistry } from "../mention-instances.js";
import type { PluginInvocationPorts } from "../invocation.js";

const identity = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "subject",
};
function fixture() {
  let now = 100,
    allowed = true;
  const registry = new PluginMentionRegistry(() => now, 100, 2);
  const { token, lease } = registry.open(identity, {
    runtime: "chatgpt",
    hostId: "host",
    hostRevision: "host-revision",
    serverId: "server",
    bindingId: "binding",
    serverIdentity: { kind: "standalone", serverId: "server" },
    toolName: "mentions",
    revision: "revision",
  });
  const tool = {
    name: "mentions",
    _meta: {
      "openai/extensions": { "mentions/search": {} },
      ui: { visibility: ["app"] },
    },
  };
  const ports: PluginInvocationPorts = {
    authorize: vi.fn(async () => ({
      owner: lease.owner,
      revision: "revision",
      enabled: allowed,
      tool,
      allowedOrigins: ["mention"] as const,
      requiresApproval: false,
    })),
    approve: vi.fn(async () => false),
    admit: vi.fn(async () => {}),
    metadata: vi.fn(async () => ({})),
    execute: vi.fn(async () => ({
      content: [],
      structuredContent: {
        items: [{ type: "resource_link", uri: "fixture://bolt", name: "Bolt" }],
      },
    })),
    classifyFailure: () => "unknown",
  };
  const search = (
    id = "operation",
    params: unknown = { query: "" },
    signal = new AbortController().signal,
  ) => registry.search(token, identity, ports, id, params, signal);
  return {
    registry,
    token,
    lease,
    tool,
    ports,
    search,
    expire: () => {
      now = 201;
    },
    revoke: () => {
      allowed = false;
    },
  };
}
describe("owned mention search", () => {
  it("uses the common invoker and retains duplicate receipts without URI effects", async () => {
    const f = fixture();
    await f.search();
    await f.search();
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
    expect(f.ports.execute).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "mention" }),
      { name: "mentions", arguments: { query: "" } },
      expect.any(AbortSignal),
      "operation",
    );
    await expect(f.search("operation", { query: "different" })).rejects.toThrow(
      "INVOCATION_ID_REUSED",
    );
  });
  it.each(["actorId", "projectId", "workspaceId", "subject"])(
    "refuses foreign %s ownership",
    (field) => {
      const f = fixture();
      expect(() =>
        f.registry.get(f.token, { ...identity, [field]: "foreign" }),
      ).toThrow("INSTANCE_DENIED");
    },
  );
  it("expires and closes pending searches, while cleanup survives revocation", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    vi.mocked(f.ports.execute).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.search();
    const rejection = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.revoke();
    f.registry.close(f.token, identity);
    await rejection;
    resolve({ content: [], structuredContent: { items: [] } });
    expect(() => f.registry.get(f.token, identity)).toThrow();
    const second = fixture();
    second.expire();
    await expect(second.search()).rejects.toThrow();
  });
  it("fences cancelled and revoked waits before dispatch", async () => {
    const f = fixture(),
      abort = new AbortController();
    vi.mocked(f.ports.admit).mockImplementation(async () => {
      f.revoke();
    });
    await expect(f.search()).rejects.toThrow();
    expect(f.ports.execute).not.toHaveBeenCalled();
    abort.abort();
    await expect(
      f.search("cancelled", { query: "a" }, abort.signal),
    ).rejects.toThrow();
  });
  it("requires a fresh explicit mention declaration and App visibility", async () => {
    const f = fixture();
    f.tool._meta.ui.visibility = ["model"];
    await expect(f.search()).rejects.toThrow("TOOL_MENTION_DECLARATION_DENIED");
    expect(f.ports.execute).not.toHaveBeenCalled();
  });
  it.each([
    { query: "a", serverId: "forged" },
    { query: "a".repeat(1025) },
    { query: 1 },
  ])("rejects invalid query before dispatch", async (params) => {
    const f = fixture();
    await expect(f.search("invalid", params)).rejects.toThrow();
    expect(f.ports.authorize).not.toHaveBeenCalled();
  });
  it("rejects malformed results without repeating the dispatched call", async () => {
    const f = fixture();
    vi.mocked(f.ports.execute).mockResolvedValue({
      content: [],
      structuredContent: { items: [{ type: "resource", title: "no URI" }] },
    });
    await expect(f.search()).rejects.toThrow();
    await expect(f.search()).rejects.toThrow();
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
  });
  it("inherits policy and approval denial", async () => {
    const f = fixture();
    vi.mocked(f.ports.authorize).mockImplementation(async () => ({
      owner: f.lease.owner,
      revision: "revision",
      enabled: true,
      tool: f.tool,
      allowedOrigins: ["mention"] as const,
      requiresApproval: true,
    }));
    await expect(f.search()).rejects.toThrow("APPROVAL_DENIED");
    expect(f.ports.execute).not.toHaveBeenCalled();
  });
});
