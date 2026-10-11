import { describe, expect, it, vi } from "vitest";
import {
  PluginInstanceRegistry,
  type PluginInstanceBinding,
  type PluginInstanceInvocationPorts,
} from "../instances.js";
import type { PluginInstanceControlPort } from "../instance-store.js";
import type { DurablePluginInstanceControl } from "../../../../shared/plugin-invocation-receipts.js";
const identity = {
  actorId: "fixture-actor",
  projectId: "fixture-project",
  workspaceId: "fixture-workspace",
  subject: "verified-subject",
};
const binding: PluginInstanceBinding = {
  runtime: "chatgpt",
  hostId: "fixture-host",
  hostRevision: "host-revision",
  serverId: "fixture-server",
  bindingId: "target-digest",
  resourceUri: "ui://fixture/app",
  serverIdentity: { kind: "standalone", serverId: "fixture-server" },
  activation: {
    selector: { kind: "thread", threadId: "fixture-thread" },
    toolName: "fixture-app",
    revision: "tool-revision",
  },
};
function store() {
  const rows = new Map<string, DurablePluginInstanceControl>();
  const anchors = new Map<string, { token: string; digest: string }>();
  const closed = new Set<string>();
  const port: PluginInstanceControlPort = {
    read: async (token) => {
      if (closed.has(token)) throw new Error("INSTANCE_UNAVAILABLE");
      return rows.get(token) ?? null;
    },
    issue: async () => {
      throw new Error("Unexpected ordinary issue");
    },
    readActivation: async (anchor, digest) => {
      const original = anchors.get(anchor);
      if (!original || closed.has(original.token)) return null;
      if (original.digest !== digest)
        throw new Error("ACTIVATION_BINDING_CHANGED");
      return { token: original.token, control: rows.get(original.token)! };
    },
    issueActivation: async (token, input) => {
      const original = await port.readActivation!(
        input.anchor,
        input.bindingHash,
        AbortSignal.timeout(1000),
      );
      if (original) return original;
      const control = {
        snapshotJson: input.snapshotJson,
        expiresAt: input.expiresAt,
        ...(input.contextToken ? { contextVersion: 0 } : {}),
      };
      rows.set(token, control);
      anchors.set(input.anchor, { token, digest: input.bindingHash });
      return { token, control };
    },
    writeContext: async (token, input) => {
      const before = rows.get(token)!;
      if (before.contextVersion !== input.expectedVersion)
        throw new Error("CONFLICT");
      const next = {
        ...before,
        contextVersion: input.expectedVersion + 1,
        contextJson: input.contextJson,
      };
      rows.set(token, next);
      return next;
    },
    close: async (token) => {
      closed.add(token);
      rows.delete(token);
    },
  };
  return { port, rows };
}
const signal = () => AbortSignal.timeout(1000);
describe("durable thread App ownership", () => {
  it("issues nonrenewable versioned saved-resource controls and restores their original identity", async () => {
    const s = store(),
      registry = new PluginInstanceRegistry();
    const issue = vi.spyOn(
      s.port as Required<PluginInstanceControlPort>,
      "issueActivation",
    );
    const file: PluginInstanceBinding = {
      ...binding,
      activation: {
        ...binding.activation,
        selector: {
          kind: "file",
          requestId: "32f09e2b-85b0-4cee-80dc-1e5b00b2b889",
        },
        file: {
          kind: "saved-resource",
          version: 1,
          uri: "cad://disposable",
          name: "part.stl",
        },
      },
    };
    const first = await registry.openActivationPersistent(
      identity,
      file,
      signal(),
      s.port,
    );
    expect(issue.mock.calls[0][1].renewable).toBe(false);
    const restored = await new PluginInstanceRegistry().getPersistent(
      first.token,
      identity,
      signal(),
      s.port,
    );
    expect(restored.owner).toEqual(first.instance.owner);
    expect(restored.activation.file).toEqual(file.activation.file);
  });
  it("issues quick-action controls as nonrenewable and reuses their receipt", async () => {
    const s = store();
    const issue = vi.spyOn(
      s.port as Required<PluginInstanceControlPort>,
      "issueActivation",
    );
    const action: PluginInstanceBinding = {
      ...binding,
      activation: {
        ...binding.activation,
        selector: {
          kind: "quick-action",
          requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        },
        arguments: {},
      },
    };
    const first = await new PluginInstanceRegistry().openActivationPersistent(
      identity,
      action,
      signal(),
      s.port,
    );
    expect(issue.mock.calls[0][1].renewable).toBe(false);
    const restored =
      await new PluginInstanceRegistry().openActivationPersistent(
        identity,
        action,
        signal(),
        s.port,
      );
    expect(restored.token).toBe(first.token);
    // One durable round trip per open; the store returns the original winner.
    expect(issue).toHaveBeenCalledTimes(2);
    expect(s.rows.size).toBe(1);
  });

  it.each(["quick-action", "file"] as const)(
    "gives each %s control its own conversation ports, never its source's",
    async (kind) => {
      const s = store();
      const registry = new PluginInstanceRegistry();
      const candidate = (requestId: string): PluginInstanceBinding => ({
        ...binding,
        contextEnabled: true,
        messageEnabled: true,
        activation: {
          ...binding.activation,
          selector: { kind, requestId },
          ...(kind === "file"
            ? {
                file: {
                  kind: "saved-resource" as const,
                  version: 1 as const,
                  uri: "cad://disposable",
                  name: "part.stl",
                },
              }
            : { arguments: {} }),
        },
      });
      // The launching thread App owns its own context and chips.
      const source = await registry.openActivationPersistent(
        identity,
        { ...binding, contextEnabled: true, messageEnabled: true },
        signal(),
        s.port,
      );
      const opened = await registry.openActivationPersistent(
        identity,
        candidate("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        signal(),
        s.port,
      );
      const sibling = await registry.openActivationPersistent(
        identity,
        candidate("aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"),
        signal(),
        s.port,
      );
      expect(opened.instance.contextEnabled).toBe(true);
      expect(opened.instance.messageEnabled).toBe(true);
      expect(s.rows.get(opened.token)?.contextVersion).toBe(0);
      expect(new Set([source.token, opened.token, sibling.token]).size).toBe(3);
      const authorize = vi.fn().mockResolvedValue(undefined);
      const updated = await registry.changeContextPersistent(
        opened.token,
        identity,
        {
          kind: "update",
          request: {
            operationId: "file-update",
            sequence: 1,
            params: { content: [{ type: "text", text: "Viewing part.stl" }] },
          },
        },
        signal(),
        authorize,
        s.port,
      );
      expect(updated.snapshot.state?.content).toEqual([
        { type: "text", text: "Viewing part.stl" },
      ]);
      // Nothing leaks into the launching App or a sibling instance.
      expect(registry.contextSnapshot(source.token, identity).state).toBeNull();
      expect(registry.contextSnapshot(sibling.token, identity).state).toBeNull();
      expect(() =>
        registry.prepareMessage(opened.token, identity, "message-1", "digest"),
      ).not.toThrow();
      const restored = await new PluginInstanceRegistry().openActivationPersistent(
        identity,
        candidate("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        signal(),
        s.port,
      );
      expect(restored.token).toBe(opened.token);
      const cold = new PluginInstanceRegistry();
      await cold.getPersistent(opened.token, identity, signal(), s.port);
      expect(cold.contextSnapshot(opened.token, identity)).toEqual(
        updated.snapshot,
      );
      const removed = await cold.changeContextPersistent(
        opened.token,
        identity,
        {
          kind: "remove",
          request: {
            operationId: "file-remove",
            updateId: updated.snapshot.state!.updateId,
            index: 0,
          },
        },
        signal(),
        authorize,
        s.port,
      );
      expect(removed.snapshot.state).toBeNull();
    },
  );
  it("withholds conversation ports from settings controls", async () => {
    const s = store();
    const opened = await new PluginInstanceRegistry().openActivationPersistent(
      identity,
      {
        ...binding,
        contextEnabled: true,
        messageEnabled: true,
        activation: {
          ...binding.activation,
          selector: { kind: "settings" },
          settings: {
            readTool: "fixture-read",
            updateTool: "save",
            revision: "settings-revision",
          },
        },
      },
      signal(),
      s.port,
    );
    expect(opened.instance.contextEnabled).toBe(false);
    expect(opened.instance.messageEnabled).toBe(false);
    expect(s.rows.get(opened.token)?.contextVersion).toBeUndefined();
  });

  it("persists context and exact removal across cold registry recovery", async () => {
    const s = store();
    const registry = new PluginInstanceRegistry();
    const open = await registry.openActivationPersistent(
      identity,
      { ...binding, contextEnabled: true },
      signal(),
      s.port,
    );
    const authorize = vi.fn().mockResolvedValue(undefined);
    const first = await registry.changeContextPersistent(
      open.token,
      identity,
      {
        kind: "update",
        request: {
          operationId: "update",
          sequence: 1,
          params: { content: [{ type: "text", text: "Selected bolt" }] },
        },
      },
      signal(),
      authorize,
      s.port,
    );
    const cold = new PluginInstanceRegistry();
    await cold.getPersistent(open.token, identity, signal(), s.port);
    expect(cold.contextSnapshot(open.token, identity)).toEqual(first.snapshot);
    const removed = await cold.changeContextPersistent(
      open.token,
      identity,
      {
        kind: "remove",
        request: {
          operationId: "remove",
          updateId: first.snapshot.state!.updateId,
          index: 0,
        },
      },
      signal(),
      authorize,
      s.port,
    );
    expect(removed.snapshot.state).toBeNull();
    await registry.getPersistent(open.token, identity, signal(), s.port);
    expect(registry.contextSnapshot(open.token, identity).state).toBeNull();
    expect(authorize).toHaveBeenCalledTimes(4);
    await cold.closePersistent(open.token, identity, signal(), s.port);
    expect(() => cold.contextSnapshot(open.token, identity)).toThrow();
  });
  it("separates global and thread activation anchors and restores global ownership", async () => {
    const s = store(),
      registry = new PluginInstanceRegistry();
    const global: PluginInstanceBinding = {
      ...binding,
      activation: { ...binding.activation, selector: { kind: "global" } },
    };
    const first = await registry.openActivationPersistent(
      identity,
      global,
      signal(),
      s.port,
    );
    const thread = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    expect(first.token).not.toBe(thread.token);
    const restored =
      await new PluginInstanceRegistry().openActivationPersistent(
        identity,
        global,
        signal(),
        s.port,
      );
    expect(restored.token).toBe(first.token);
    expect(restored.instance.activation.operationId).toBe(
      first.instance.activation.operationId,
    );
  });
  async function ownedInvocation(instanceBinding = binding) {
    const s = store(),
      registry = new PluginInstanceRegistry();
    const opened = await registry.openActivationPersistent(
      identity,
      instanceBinding,
      signal(),
      s.port,
    );
    const originalRead = registry.getPersistent.bind(registry);
    const read = vi
      .spyOn(registry, "getPersistent")
      .mockImplementation((token, actor, currentSignal) =>
        originalRead(token, actor, currentSignal, s.port),
      );
    const authorization: Awaited<
      ReturnType<PluginInstanceInvocationPorts["authorize"]>
    > = {
      owner: opened.instance.owner,
      revision: "current-revision",
      enabled: true,
      tool: {
        name: "fixture-read",
        _meta: { ui: { visibility: ["app", "model"] } },
      },
      allowedOrigins: ["app"],
      requiresApproval: false,
    };
    const ports: PluginInstanceInvocationPorts = {
      authorize: vi.fn(async () => authorization),
      authorizeInstance: vi.fn(
        async (_owner, _origin, _params, _signal, together) => {
          await together(async () => "before-target");
          await together(async () => "after-metadata");
          return authorization;
        },
      ),
      approve: vi.fn(async () => true),
      admit: vi.fn(async () => undefined),
      metadata: vi.fn(async () => ({})),
      execute: vi.fn(async () => ({ content: [] })),
      classifyFailure: () => "unknown",
    };
    const invoke = () =>
      registry.invoke(opened.token, identity, ports, "read-operation", {
        name: "fixture-read",
        arguments: {},
      });
    return { s, registry, opened, read, ports, authorization, invoke };
  }
  it("runs settings only on a declared settings owner and preserves cached-effect admission", async () => {
    const f = await ownedInvocation({
      ...binding,
      activation: {
        ...binding.activation,
        selector: { kind: "settings" },
        settings: {
          readTool: "fixture-read",
          updateTool: "save",
          revision: "settings-revision",
        },
      },
    });
    f.authorization.allowedOrigins = ["settings"];
    const call = () =>
      f.registry.invoke(
        f.opened.token,
        identity,
        f.ports,
        "settings-read",
        { name: "fixture-read", arguments: {} },
        signal(),
        "settings",
      );
    await call();
    await call();
    expect(f.ports.execute).toHaveBeenCalledOnce();
    expect(f.read.mock.calls.length).toBeGreaterThan(2);
    const ordinary = await ownedInvocation();
    expect(() =>
      ordinary.registry.invoke(
        ordinary.opened.token,
        identity,
        ordinary.ports,
        "settings-read",
        { name: "fixture-read" },
        signal(),
        "settings",
      ),
    ).toThrow("INSTANCE_DENIED");
    expect(ordinary.ports.execute).not.toHaveBeenCalled();
  });
  it("preserves both durable reads at every coordinated authorization and does not repeat a cached effect", async () => {
    const f = await ownedInvocation();
    await f.invoke();
    expect(f.ports.authorize).not.toHaveBeenCalled();
    expect(f.read.mock.calls.length).toBeGreaterThan(2);
    expect(f.read.mock.calls.length).toBe(
      vi.mocked(f.ports.authorizeInstance!).mock.calls.length * 2,
    );
    expect(f.ports.execute).toHaveBeenCalledOnce();
    await f.invoke();
    expect(f.ports.execute).toHaveBeenCalledOnce();
    expect(f.read.mock.calls.length).toBe(
      vi.mocked(f.ports.authorizeInstance!).mock.calls.length * 2,
    );
  });
  it("keeps ordinary adapter authorization behind both serial durable reads", async () => {
    const f = await ownedInvocation();
    delete f.ports.authorizeInstance;
    await f.invoke();
    expect(f.read.mock.calls.length).toBe(
      vi.mocked(f.ports.authorize).mock.calls.length * 2,
    );
    expect(f.ports.execute).toHaveBeenCalledOnce();
  });
  it("omits absent metadata in fresh request ports without inventing a callback", async () => {
    const f = await ownedInvocation();
    delete f.ports.metadata;
    await f.invoke();
    expect(f.ports.execute).toHaveBeenCalledOnce();
    await f.invoke();
    expect(f.ports.execute).toHaveBeenCalledOnce();
  });
  it("refuses an immutable control change during the paired metadata wait before any effect", async () => {
    const f = await ownedInvocation();
    f.ports.authorizeInstance = vi.fn(
      async (_owner, _origin, _params, _signal, together) => {
        await together(async () => "before-target");
        const saved = f.s.rows.get(f.opened.token)!;
        const changed = JSON.parse(saved.snapshotJson);
        changed.instance.hostRevision = "changed";
        f.s.rows.set(f.opened.token, {
          ...saved,
          snapshotJson: JSON.stringify(changed),
        });
        await together(async () => "after-metadata");
        return f.authorization;
      },
    );
    await expect(f.invoke()).rejects.toThrow("INSTANCE_CONTROL_CHANGED");
    expect(f.ports.execute).not.toHaveBeenCalled();
    expect(f.ports.approve).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    "accepts a coordinated authorization with %i ownership fences (warm, cold)",
    async (count) => {
      const f = await ownedInvocation();
      f.ports.authorizeInstance = vi.fn(
        async (_owner, _origin, _params, _signal, together) => {
          for (let i = 0; i < count; i++) await together(async () => i);
          return f.authorization;
        },
      );
      await f.invoke();
      expect(f.ports.execute).toHaveBeenCalledOnce();
      // Each fenced read is one durable control read beside admission.
      expect(f.read.mock.calls.length).toBe(
        vi.mocked(f.ports.authorizeInstance!).mock.calls.length * count,
      );
    },
  );
  it.each([0, 3])(
    "refuses a coordinated adapter with %i ownership fences",
    async (count) => {
      const f = await ownedInvocation();
      f.ports.authorizeInstance = vi.fn(
        async (_owner, _origin, _params, _signal, together) => {
          for (let i = 0; i < count; i++) await together(async () => i);
          return f.authorization;
        },
      );
      await expect(f.invoke()).rejects.toThrow(
        "INSTANCE_AUTHORIZATION_INVALID",
      );
      expect(f.ports.execute).not.toHaveBeenCalled();
    },
  );
  // The route resolves once before the invoker starts, through the same
  // fence; the invoker's first authorization may stand on it.
  const fencedInvoke = (
    f: Awaited<ReturnType<typeof ownedInvocation>>,
    fence: ReturnType<PluginInstanceRegistry["fence"]>,
    reads: (call: number) => number,
    operation = "fenced-operation",
  ) => {
    let calls = 0;
    f.ports.authorizeInstance = vi.fn(
      async (_owner, _origin, _params, _signal, together) => {
        for (let i = 0, n = reads(calls++); i < n; i++)
          await together(async () => i);
        return f.authorization;
      },
    );
    return f.registry.invoke(
      f.opened.token,
      identity,
      f.ports,
      operation,
      { name: "fixture-read", arguments: {} },
      signal(),
      "app",
      fence,
    );
  };
  it("lets only the first authorization stand on a complete route fence", async () => {
    const f = await ownedInvocation();
    const fence = f.registry.fence(f.opened.token, identity, signal());
    await fence.read(async () => "before-catalog");
    await fence.read(async () => "after-catalog");
    const fenceReads = f.read.mock.calls.length;
    await fencedInvoke(f, fence, (call) => (call === 0 ? 0 : 2));
    expect(f.ports.execute).toHaveBeenCalledOnce();
    // Every later authorization still made both durable reads.
    const calls = vi.mocked(f.ports.authorizeInstance!).mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(f.read.mock.calls.length - fenceReads).toBe((calls - 1) * 2);
  });
  it("lets a one-read route fence (a warm resolution) serve the first authorization", async () => {
    const f = await ownedInvocation();
    const fence = f.registry.fence(f.opened.token, identity, signal());
    await fence.read(async () => "before-catalog");
    const fenceReads = f.read.mock.calls.length;
    await fencedInvoke(f, fence, (call) => (call === 0 ? 0 : 1));
    expect(f.ports.execute).toHaveBeenCalledOnce();
    const calls = vi.mocked(f.ports.authorizeInstance!).mock.calls.length;
    expect(f.read.mock.calls.length - fenceReads).toBe(calls - 1);
  });
  it("stands the route's first fenced read on the request's own control read, once", async () => {
    const f = await ownedInvocation();
    const queries: string[] = [];
    const { instance, fence } = await f.registry.readFenced(
      f.opened.token,
      identity,
      signal(),
    );
    expect(instance.owner).toEqual(f.opened.instance.owner);
    // readFenced made the control read; the first fenced read adds only the
    // admission query beside it, the second makes both legs again.
    expect(f.read).toHaveBeenCalledTimes(1);
    await fence.read(async () => queries.push("first"));
    expect(f.read).toHaveBeenCalledTimes(1);
    await fence.read(async () => queries.push("second"));
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(queries).toEqual(["first", "second"]);
    // A plain fence never skips its control leg.
    const plain = f.registry.fence(f.opened.token, identity, signal());
    await plain.read(async () => "plain");
    expect(f.read).toHaveBeenCalledTimes(3);
  });
  it("refuses a closed App at the primed first read without a second control read", async () => {
    const f = await ownedInvocation();
    const { fence } = await f.registry.readFenced(
      f.opened.token,
      identity,
      signal(),
    );
    await f.registry.closePersistent(
      f.opened.token,
      identity,
      signal(),
      f.s.port,
    );
    const query = vi.fn(async () => "never");
    await expect(fence.read(query)).rejects.toThrow("INSTANCE_UNAVAILABLE");
    expect(query).not.toHaveBeenCalled();
  });
  it.each([0])(
    "refuses to stand on a route fence with %i reads",
    async (count) => {
      const f = await ownedInvocation();
      const fence = f.registry.fence(f.opened.token, identity, signal());
      for (let i = 0; i < count; i++) await fence.read(async () => i);
      await expect(
        fencedInvoke(f, fence, (call) => (call === 0 ? 0 : 2)),
      ).rejects.toThrow("INSTANCE_AUTHORIZATION_INVALID");
      expect(f.ports.execute).not.toHaveBeenCalled();
    },
  );
  it("never lets a fence serve a second authorization, a second call or another App", async () => {
    const f = await ownedInvocation();
    const complete = async () => {
      const fence = f.registry.fence(f.opened.token, identity, signal());
      await fence.read(async () => 1);
      await fence.read(async () => 2);
      return fence;
    };
    // Only the first authorization of the call.
    await expect(fencedInvoke(f, await complete(), () => 0)).rejects.toThrow(
      "INSTANCE_AUTHORIZATION_INVALID",
    );
    expect(f.ports.execute).not.toHaveBeenCalled();
    // Only one call.
    const once = await complete();
    await fencedInvoke(f, once, (call) => (call === 0 ? 0 : 2), "first");
    expect(f.ports.execute).toHaveBeenCalledOnce();
    await expect(
      fencedInvoke(f, once, (call) => (call === 0 ? 0 : 2), "second"),
    ).rejects.toThrow("INSTANCE_AUTHORIZATION_INVALID");
    expect(f.ports.execute).toHaveBeenCalledOnce();
    // Only its own App.
    const other = await f.registry.openActivationPersistent(
      identity,
      {
        ...binding,
        activation: {
          ...binding.activation,
          selector: { kind: "thread", threadId: "other-thread" },
        },
      },
      signal(),
      f.s.port,
    );
    const foreign = f.registry.fence(other.token, identity, signal());
    expect(() =>
      f.registry.invoke(
        f.opened.token,
        identity,
        f.ports,
        "foreign",
        { name: "fixture-read", arguments: {} },
        signal(),
        "app",
        foreign,
      ),
    ).toThrow("INSTANCE_AUTHORIZATION_INVALID");
  });
  it("coalesces launch and recovers original operation and owner in a new registry", async () => {
    const s = store(),
      registry = new PluginInstanceRegistry();
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    expect(
      await registry.openActivationPersistent(
        identity,
        binding,
        signal(),
        s.port,
      ),
    ).toEqual(opened);
    const next = new PluginInstanceRegistry();
    expect(
      await next.getPersistent(opened.token, identity, signal(), s.port),
    ).toEqual(opened.instance);
    expect(s.rows.get(opened.token)!.snapshotJson).not.toContain(
      identity.subject,
    );
    expect(next.get(opened.token, identity).activation.operationId).toBe(
      opened.instance.activation.operationId,
    );
  });
  it.each(["actorId", "projectId", "workspaceId", "subject"] as const)(
    "refuses foreign %s and immutable binding changes",
    async (key) => {
      const s = store(),
        registry = new PluginInstanceRegistry();
      const opened = await registry.openActivationPersistent(
        identity,
        binding,
        signal(),
        s.port,
      );
      expect(() =>
        registry.get(opened.token, { ...identity, [key]: "foreign" }),
      ).toThrow("INSTANCE_DENIED");
      await expect(
        registry.openActivationPersistent(
          identity,
          { ...binding, hostRevision: "changed" },
          signal(),
          s.port,
        ),
      ).rejects.toThrow("ACTIVATION_BINDING_CHANGED");
    },
  );
  it("close aborts the live owner and cannot restore a tombstoned control", async () => {
    const s = store(),
      registry = new PluginInstanceRegistry();
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    const ownerSignal = registry.signal(opened.token, identity);
    await registry.closePersistent(opened.token, identity, signal(), s.port);
    expect(ownerSignal.aborted).toBe(true);
    await expect(
      registry.getPersistent(opened.token, identity, signal(), s.port),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
  });
  it("allows authenticated cleanup after expiry without restoring execution", async () => {
    let now = Date.now();
    const s = store(),
      registry = new PluginInstanceRegistry(() => now, 100);
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    now += 101;
    expect(() => registry.get(opened.token, identity)).toThrow();
    await registry.closePersistent(opened.token, identity, signal(), s.port);
    expect(s.rows.has(opened.token)).toBe(false);
    await expect(
      registry.getPersistent(opened.token, identity, signal(), s.port),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
  });
  it("fails closed without private service and on cancelled admission", async () => {
    // Hosted deployments without a service token have no control port.
    await expect(
      new PluginInstanceRegistry().openActivationPersistent(
        identity,
        binding,
        signal(),
        {} as PluginInstanceControlPort,
      ),
    ).rejects.toThrow("INSTANCE_STORE_UNAVAILABLE");
    await expect(
      new PluginInstanceRegistry().openActivationPersistent(
        identity,
        binding,
        AbortSignal.abort(),
        store().port,
      ),
    ).rejects.toThrow();
  });
});
