import { describe, expect, it, vi } from "vitest";
import {
  AuthorizedToolInvoker,
  classifyPluginToolFailure,
  PluginRetainedResultBudget,
  PLUGIN_INVOCATION_ORIGINS,
  type AuthorizedInvocation,
  type PluginInvocationPorts,
  type TrustedInvocationOwner,
} from "../invocation.js";
import {
  PluginInstanceRegistry,
  PLUGIN_INSTANCES_PER_ACTOR,
  type PluginInstanceBinding,
} from "../instances.js";
import type { PluginInstanceControlPort } from "../instance-store.js";
import type { PluginInvocationReceiptPort } from "../receipt-store.js";
import type { DurablePluginInstanceControl } from "../../../../shared/plugin-invocation-receipts.js";

const owner: TrustedInvocationOwner = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  instanceId: "instance",
  generation: 1,
  serverId: "server",
  bindingId: "binding",
  placement: "interactive",
};
function ports(overrides: Partial<PluginInvocationPorts> = {}) {
  const authorization: AuthorizedInvocation = {
    revision: "r1",
    owner,
    enabled: true,
    tool: { name: "tool" },
    allowedOrigins: PLUGIN_INVOCATION_ORIGINS,
    requiresApproval: false,
  };
  return {
    authorize: vi.fn(async () => authorization),
    approve: vi.fn(async () => true),
    admit: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    classifyFailure: classifyPluginToolFailure,
    ...overrides,
  } satisfies PluginInvocationPorts;
}

describe("H2 bounded retained results", () => {
  it("budgets per actor and process, evicting the oldest values first", () => {
    const budget = new PluginRetainedResultBudget(100, 150);
    const evicted: string[] = [];
    const handle = (name: string) => ({ name });
    const a1 = handle("a1"),
      a2 = handle("a2"),
      b1 = handle("b1");
    budget.retain(a1, "a", 60, () => evicted.push("a1"));
    budget.retain(a2, "a", 60, () => evicted.push("a2"));
    expect(evicted).toEqual(["a1"]);
    expect(budget.usage("a")).toBe(60);
    budget.retain(b1, "b", 100, () => evicted.push("b1"));
    expect(evicted).toEqual(["a1", "a2"]);
    expect(budget.usage()).toBe(100);
    budget.retain(handle("huge"), "a", 101, () => evicted.push("huge"));
    expect(evicted.at(-1)).toBe("huge");
    budget.release(b1);
    expect(budget.usage()).toBe(0);
  });

  it("never re-executes an evicted call: replays from the durable receipt or explains", async () => {
    const budget = new PluginRetainedResultBudget(10, 10);
    const p = ports();
    const invoker = new AuthorizedToolInvoker(
      owner,
      p,
      2048,
      undefined,
      budget,
    );
    await invoker.invoke("app", "first", { name: "tool" });
    await invoker.invoke("app", "second", { name: "tool" });
    await Promise.resolve();
    await expect(
      invoker.invoke("app", "first", { name: "tool" }),
    ).rejects.toMatchObject({ code: "INVOCATION_RESULT_EXPIRED" });
    expect(p.execute).toHaveBeenCalledTimes(2);

    const value = { content: [{ type: "text", text: "durable" }] };
    const receipts: PluginInvocationReceiptPort = {
      read: vi.fn(async () => ({
        fingerprint: "unused",
        revision: "r1",
        expiresAt: Date.now() + 60_000,
        legs: [
          {
            round: 0,
            fingerprint: "a".repeat(64),
            state: "completed" as const,
            valueJson: JSON.stringify(value),
          },
        ],
      })),
      claim: vi.fn(async (_id, input) => ({
        claimed: true,
        receipt: {
          fingerprint: input.fingerprint,
          revision: input.revision,
          expiresAt: Date.now() + 60_000,
          legs: [],
        },
      })),
      write: vi.fn(async () => {}),
    };
    const durable = ports({ receipts });
    const recovering = new AuthorizedToolInvoker(
      owner,
      durable,
      2048,
      undefined,
      new PluginRetainedResultBudget(10, 10),
    );
    await recovering.invoke("app", "first", { name: "tool" });
    await recovering.invoke("app", "second", { name: "tool" });
    await Promise.resolve();
    // The durable read reports the original fingerprint for this ID.
    vi.mocked(receipts.read).mockImplementation(async () => {
      const claim = vi.mocked(receipts.claim).mock.calls[0][1];
      return {
        fingerprint: claim.fingerprint,
        revision: "r1",
        expiresAt: Date.now() + 60_000,
        legs: [
          {
            round: 0,
            fingerprint: claim.fingerprint,
            state: "completed" as const,
            valueJson: JSON.stringify(value),
          },
        ],
      };
    });
    await expect(
      recovering.invoke("app", "first", { name: "tool" }),
    ).resolves.toEqual(value);
    expect(durable.execute).toHaveBeenCalledTimes(2);
  });
});

describe("H3 pre-dispatch failures and known server failures", () => {
  it("lets a retry with the same ID ask for approval again after a denial", async () => {
    const p = ports();
    vi.mocked(p.authorize).mockImplementation(async () => ({
      revision: "r1",
      owner,
      enabled: true,
      tool: { name: "tool" },
      allowedOrigins: PLUGIN_INVOCATION_ORIGINS,
      requiresApproval: true,
    }));
    vi.mocked(p.approve).mockResolvedValueOnce(false);
    const invoker = new AuthorizedToolInvoker(owner, p);
    await expect(
      invoker.invoke("app", "op", { name: "tool" }),
    ).rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    await Promise.resolve();
    await expect(invoker.invoke("app", "op", { name: "tool" })).resolves.toEqual(
      { content: [{ type: "text", text: "ok" }] },
    );
    expect(p.approve).toHaveBeenCalledTimes(2);
    expect(p.execute).toHaveBeenCalledOnce();
  });

  it("releases a durable claim as refused, falling back to a final failure on older stores", async () => {
    const writes: string[] = [];
    const receipts: PluginInvocationReceiptPort = {
      read: vi.fn(async () => null),
      claim: vi.fn(async (_id, input) => ({
        claimed: true,
        receipt: {
          fingerprint: input.fingerprint,
          revision: input.revision,
          expiresAt: Date.now() + 60_000,
          legs: [],
        },
      })),
      write: vi.fn(async (_id, input) => {
        writes.push(input.state);
        if (input.state === "refused") throw new Error("CONTINUATION_DENIED");
      }),
    };
    const p = ports({ receipts, admit: vi.fn(async () => {
      throw new Error("admission timeout");
    }) });
    const invoker = new AuthorizedToolInvoker(owner, p);
    await expect(invoker.invoke("app", "op", { name: "tool" })).rejects.toThrow(
      "admission timeout",
    );
    expect(writes).toEqual(["refused", "failed"]);
    expect(p.execute).not.toHaveBeenCalled();
  });

  it("classifies a JSON-RPC error from the server as a known failure", async () => {
    const serverError = Object.assign(new Error("Bad part id"), {
      code: -32602,
    });
    const writes: { state: string; errorCode?: string }[] = [];
    const receipts: PluginInvocationReceiptPort = {
      read: vi.fn(async () => null),
      claim: vi.fn(async (_id, input) => ({
        claimed: true,
        receipt: {
          fingerprint: input.fingerprint,
          revision: input.revision,
          expiresAt: Date.now() + 60_000,
          legs: [],
        },
      })),
      write: vi.fn(async (_id, input) => {
        writes.push({ state: input.state, errorCode: input.errorCode });
      }),
    };
    const p = ports({
      receipts,
      execute: vi.fn(async () => {
        throw serverError;
      }),
    });
    const invoker = new AuthorizedToolInvoker(owner, p);
    await expect(invoker.invoke("app", "op", { name: "tool" })).rejects.toBe(
      serverError,
    );
    expect(writes.at(-1)).toEqual({
      state: "failed",
      errorCode: "TOOL_CALL_FAILED",
    });
    // A transport timeout stays uncertain.
    const timeout = ports({
      execute: vi.fn(async () => {
        throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
      }),
    });
    await expect(
      new AuthorizedToolInvoker(owner, timeout).invoke("app", "op", {
        name: "tool",
      }),
    ).rejects.toMatchObject({ code: "INVOCATION_OUTCOME_UNKNOWN" });
    expect(classifyPluginToolFailure({ code: -32001 })).toBe("unknown");
    expect(classifyPluginToolFailure({ code: -32603 })).toBe("failed");
    expect(classifyPluginToolFailure(new Error("x"))).toBe("unknown");
  });
});

describe("H1 capacity per actor and subject", () => {
  function store() {
    const rows = new Map<string, DurablePluginInstanceControl>();
    const anchors = new Map<string, string>();
    const port: PluginInstanceControlPort = {
      read: async (token) => rows.get(token) ?? null,
      issue: async () => {
        throw new Error("unexpected");
      },
      issueActivation: async (token, input) => {
        const original = anchors.get(input.anchor);
        if (original && rows.has(original))
          return { token: original, control: rows.get(original)! };
        const control = {
          snapshotJson: input.snapshotJson,
          expiresAt: input.expiresAt,
        };
        rows.set(token, control);
        anchors.set(input.anchor, token);
        return { token, control };
      },
      close: async (token) => {
        rows.delete(token);
      },
    };
    return port;
  }
  const binding = (threadId: string): PluginInstanceBinding => ({
    runtime: "chatgpt",
    hostId: "host",
    hostRevision: "rev",
    serverId: "server",
    bindingId: "binding",
    resourceUri: "ui://app",
    serverIdentity: { kind: "standalone", serverId: "server" },
    activation: {
      selector: { kind: "thread", threadId },
      toolName: "app",
      revision: "tool-rev",
    },
  });
  const signal = () => AbortSignal.timeout(5000);
  it("caps one actor across client-chosen workspaces, not per workspace", async () => {
    const port = store();
    const registry = new PluginInstanceRegistry();
    for (let i = 0; i < PLUGIN_INSTANCES_PER_ACTOR; i++)
      await registry.openActivationPersistent(
        { actorId: "a", projectId: "p", workspaceId: `w${i}`, subject: "s" },
        binding("t"),
        signal(),
        port,
      );
    await expect(
      registry.openActivationPersistent(
        { actorId: "a", projectId: "p", workspaceId: "fresh", subject: "s" },
        binding("t"),
        signal(),
        port,
      ),
    ).rejects.toThrow("INSTANCE_LIMIT");
    await expect(
      registry.openActivationPersistent(
        { actorId: "b", projectId: "p", workspaceId: "w0", subject: "s2" },
        binding("t"),
        signal(),
        port,
      ),
    ).resolves.toBeDefined();
  });
  it("does not count closed Apps toward capacity", async () => {
    const port = store();
    const registry = new PluginInstanceRegistry(Date.now, 30 * 60_000, 4);
    const identity = {
      actorId: "a",
      projectId: "p",
      workspaceId: "w",
      subject: "s",
    };
    for (let i = 0; i < 10; i++) {
      const opened = await registry.openActivationPersistent(
        identity,
        binding(`t${i}`),
        signal(),
        port,
      );
      await registry.closePersistent(opened.token, identity, signal(), port);
    }
    for (let i = 0; i < 4; i++)
      await registry.openActivationPersistent(
        identity,
        binding(`open${i}`),
        signal(),
        port,
      );
    await expect(
      registry.openActivationPersistent(
        identity,
        binding("one-too-many"),
        signal(),
        port,
      ),
    ).rejects.toThrow("INSTANCE_LIMIT");
  });
});
