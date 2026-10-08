import { describe, expect, it, vi } from "vitest";
import {
  PluginInstanceRegistry,
  type PluginInstanceBinding,
  type PluginInstanceInvocationPorts,
} from "../instances.js";
import {
  PluginContextWorkspace,
  PLUGIN_CONTEXT_REMOVAL_WINDOW,
} from "../context.js";
import type { PluginInstanceControlPort } from "../instance-store.js";
import { PluginInvocationError } from "../invocation.js";
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
  contextEnabled: true,
  activation: {
    selector: { kind: "thread", threadId: "fixture-thread" },
    toolName: "fixture-app",
    revision: "tool-revision",
  },
};
const signal = () => AbortSignal.timeout(5000);

/** Durable store double honoring expiry against a controllable clock. */
function store(now: () => number) {
  const rows = new Map<string, DurablePluginInstanceControl>();
  const anchors = new Map<string, { token: string; digest: string }>();
  const live = (token: string) => {
    const row = rows.get(token);
    return row && row.expiresAt > now() ? row : undefined;
  };
  const port: PluginInstanceControlPort = {
    read: async (token) => {
      if (rows.has(token) && !live(token))
        throw new Error("INSTANCE_UNAVAILABLE");
      return rows.get(token) ?? null;
    },
    issue: async () => {
      throw new Error("Unexpected ordinary issue");
    },
    readActivation: async (anchor, digest) => {
      const original = anchors.get(anchor);
      if (!original || !live(original.token)) return null;
      if (original.digest !== digest)
        throw new Error("ACTIVATION_BINDING_CHANGED");
      return { token: original.token, control: rows.get(original.token)! };
    },
    issueActivation: async (token, input) => {
      const original = anchors.get(input.anchor);
      if (original && live(original.token)) {
        if (original.digest !== input.bindingHash)
          throw new Error("ACTIVATION_BINDING_CHANGED");
        return { token: original.token, control: rows.get(original.token)! };
      }
      const control = {
        snapshotJson: input.snapshotJson,
        expiresAt: input.expiresAt,
        ...(input.contextToken ? { contextVersion: 0 } : {}),
      };
      rows.set(token, control);
      anchors.set(input.anchor, { token, digest: input.bindingHash });
      return { token, control };
    },
    renew: async (token, input) => {
      const row = live(token);
      if (!row || input.expiresAt <= row.expiresAt)
        throw new Error("INSTANCE_UNAVAILABLE");
      const next = { ...row, expiresAt: input.expiresAt };
      rows.set(token, next);
      return next;
    },
    writeContext: async (token, input) => {
      const before = live(token);
      if (!before) throw new Error("INSTANCE_UNAVAILABLE");
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
      rows.delete(token);
    },
  };
  return { port, rows };
}

function toolPorts(owner: unknown): PluginInstanceInvocationPorts {
  const authorization = {
    owner: owner as never,
    revision: "current-revision",
    enabled: true,
    tool: {
      name: "fixture-read",
      _meta: { ui: { visibility: ["app", "model"] } },
    },
    allowedOrigins: ["app"] as const,
    requiresApproval: false,
  };
  return {
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
    execute: vi.fn(async () => ({ content: [] })),
    classifyFailure: () => "unknown",
  };
}

describe("long-lived App limits", () => {
  it("accepts context update 2,049 live and after restoring saved state", () => {
    const ws = new PluginContextWorkspace("w");
    const instanceId = "11111111-1111-4111-8111-111111111111";
    const attach = (target: PluginContextWorkspace) =>
      target.attach(instanceId, 1, {
        workspaceId: "w",
        scope: { kind: "global" },
        pluginVersionId: "v",
        serverId: "s",
        bindingId: "b",
        origin: { kind: "global", id: "app" },
      });
    attach(ws);
    for (let sequence = 1; sequence <= 2049; sequence++)
      ws.update(instanceId, 1, {
        operationId: `op-${sequence}`,
        sequence,
        params: { content: [{ type: "text", text: `n${sequence}` }] },
      });
    expect(ws.snapshot(instanceId, 1).sequence).toBe(2049);
    const cold = new PluginContextWorkspace("w");
    attach(cold);
    cold.restore(instanceId, 1, ws.export(instanceId, 1), 2049);
    expect(cold.snapshot(instanceId, 1).state?.content).toEqual([
      { type: "text", text: "n2049" },
    ]);
    // Still monotonic: a stale or skipped sequence is refused.
    expect(() =>
      cold.update(instanceId, 1, {
        operationId: "stale",
        sequence: 2049,
        params: { content: [] },
      }),
    ).toThrow("INSTANCE_CONTEXT_SEQUENCE_DENIED");
    expect(() =>
      cold.update(instanceId, 1, {
        operationId: "skip",
        sequence: 2052,
        params: { content: [] },
      }),
    ).toThrow("INSTANCE_CONTEXT_SEQUENCE_DENIED");
    cold.update(instanceId, 1, {
      operationId: "op-2050",
      sequence: 2050,
      params: { content: [{ type: "text", text: "n2050" }] },
    });
    expect(cold.snapshot(instanceId, 1).sequence).toBe(2050);
  });

  it("compacts removal receipts so removals never permanently stop context", () => {
    const ws = new PluginContextWorkspace("w");
    const instanceId = "22222222-2222-4222-8222-222222222222";
    const identityFor = {
      workspaceId: "w",
      scope: { kind: "global" as const },
      pluginVersionId: "v",
      serverId: "s",
      bindingId: "b",
      origin: { kind: "global" as const, id: "app" },
    };
    ws.attach(instanceId, 1, identityFor);
    let firstRemoval: { operationId: string; updateId: string } | undefined;
    for (let round = 1; round <= PLUGIN_CONTEXT_REMOVAL_WINDOW + 44; round++) {
      // After a removal only the person re-attaching brings context back.
      ws.update(instanceId, 1, {
        operationId: `u-${round}`,
        sequence: round,
        params: { content: [{ type: "text", text: `r${round}` }] },
        attach: "user",
      });
      const updateId = ws.snapshot(instanceId, 1).state!.updateId;
      const request = { operationId: `rm-${round}`, updateId, index: 0 };
      firstRemoval ??= request;
      expect(ws.remove(instanceId, 1, request).state).toBeNull();
    }
    const saved = JSON.parse(ws.export(instanceId, 1));
    expect(saved.removals.length).toBe(PLUGIN_CONTEXT_REMOVAL_WINDOW);
    // A compacted receipt cannot repeat its effect: the retry is stale.
    ws.update(instanceId, 1, {
      operationId: "after",
      sequence: PLUGIN_CONTEXT_REMOVAL_WINDOW + 45,
      params: { content: [{ type: "text", text: "kept" }] },
      attach: "user",
    });
    expect(() =>
      ws.remove(instanceId, 1, { ...firstRemoval!, index: 0 }),
    ).toThrow("INSTANCE_CONTEXT_REMOVAL_STALE");
    expect(ws.snapshot(instanceId, 1).state?.content).toEqual([
      { type: "text", text: "kept" },
    ]);
    // Recent receipts stay idempotent, and the saved state round-trips.
    const cold = new PluginContextWorkspace("w");
    cold.attach(instanceId, 1, identityFor);
    cold.restore(instanceId, 1, ws.export(instanceId, 1));
    expect(cold.snapshot(instanceId, 1).state?.content).toEqual([
      { type: "text", text: "kept" },
    ]);
  });

  it("renews a retained App past its original expiry and keeps the same activation", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const s = store(clock);
    const registry = new PluginInstanceRegistry(clock, 100);
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    const authorize = vi.fn(async () => {});
    const contextAuthorize = vi.fn(async () => {});
    now += 80;
    const renewed = await registry.renewPersistent(
      opened.token,
      identity,
      signal(),
      authorize,
      s.port,
    );
    expect(renewed).toEqual({ expiresAt: now + 100, renewed: true });
    expect(authorize).toHaveBeenCalledOnce();
    now += 60; // Past the original 100 ms lease, inside the renewed one.
    expect(registry.get(opened.token, identity).owner.instanceId).toBe(
      opened.instance.owner.instanceId,
    );
    // Reopening (hide -> reopen) returns the same instance and operation.
    const reopened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    expect(reopened.token).toBe(opened.token);
    expect(reopened.instance.activation.operationId).toBe(
      opened.instance.activation.operationId,
    );
    // A cold process restores the extended lease from saved state.
    const cold = new PluginInstanceRegistry(clock, 100);
    const restored = await cold.getPersistent(
      opened.token,
      identity,
      signal(),
      s.port,
    );
    expect(restored.owner).toEqual(opened.instance.owner);
    // Context update, removal and a tool call all succeed after recovery.
    for (const target of [registry, cold]) {
      await target.getPersistent(opened.token, identity, signal(), s.port);
      const before = target.contextSnapshot(opened.token, identity);
      const updated = await target.changeContextPersistent(
        opened.token,
        identity,
        {
          kind: "update",
          request: {
            operationId: `update-${before.sequence + 1}`,
            sequence: before.sequence + 1,
            params: { content: [{ type: "text", text: "still here" }] },
            // The earlier removal holds in the durable copy too; the person
            // re-attaches.
            attach: "user",
          },
        },
        signal(),
        contextAuthorize,
        s.port,
      );
      const removed = await target.changeContextPersistent(
        opened.token,
        identity,
        {
          kind: "remove",
          request: {
            operationId: `remove-${before.sequence + 1}`,
            updateId: updated.snapshot.state!.updateId,
            index: 0,
          },
        },
        signal(),
        contextAuthorize,
        s.port,
      );
      expect(removed.snapshot.state).toBeNull();
    }
    const read = vi
      .spyOn(registry, "getPersistent")
      .mockImplementation((token, actor, current) =>
        PluginInstanceRegistry.prototype.getPersistent.call(
          registry,
          token,
          actor,
          current,
          s.port,
        ),
      );
    const ports = toolPorts(opened.instance.owner);
    const call = () =>
      registry.invoke(opened.token, identity, ports, "after-renewal", {
        name: "fixture-read",
        arguments: {},
      });
    await expect(call()).resolves.toEqual({ content: [] });
    await expect(call()).resolves.toEqual({ content: [] });
    expect(ports.execute).toHaveBeenCalledOnce(); // No repeated effect.
    read.mockRestore();
  });

  it("does not renew a closed or expired App", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const s = store(clock);
    const registry = new PluginInstanceRegistry(clock, 100);
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    now += 101;
    await expect(
      registry.renewPersistent(
        opened.token,
        identity,
        signal(),
        async () => {},
        s.port,
      ),
    ).rejects.toThrow();
    const second = await registry.openActivationPersistent(
      identity,
      { ...binding, activation: { ...binding.activation, toolName: "other" } },
      signal(),
      s.port,
    );
    await registry.closePersistent(second.token, identity, signal(), s.port);
    await expect(
      registry.renewPersistent(
        second.token,
        identity,
        signal(),
        async () => {},
        s.port,
      ),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
  });

  it("refuses renewal when the binding fence fails, without extending the lease", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const s = store(clock);
    const registry = new PluginInstanceRegistry(clock, 100);
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    const renew = vi.spyOn(s.port, "renew");
    now += 50;
    await expect(
      registry.renewPersistent(
        opened.token,
        identity,
        signal(),
        async () => {
          throw new Error("INSTANCE_HOST_CHANGED");
        },
        s.port,
      ),
    ).rejects.toThrow("INSTANCE_HOST_CHANGED");
    expect(renew).not.toHaveBeenCalled();
  });

  it("treats a lost renew race as the other process's longer lease", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const s = store(clock);
    const registry = new PluginInstanceRegistry(clock, 100);
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    now += 50;
    // Another process already extended the lease past what we would ask for.
    s.rows.set(opened.token, {
      ...s.rows.get(opened.token)!,
      expiresAt: now + 100,
    });
    const renew = vi.fn(async () => {
      throw new PluginInvocationError("INVALID_INSTANCE_CONTROL");
    });
    s.port.renew = renew;
    now += 1;
    await expect(
      registry.renewPersistent(
        opened.token,
        identity,
        signal(),
        async () => {},
        s.port,
      ),
    ).resolves.toEqual({ expiresAt: now + 99, renewed: false });
    expect(renew).toHaveBeenCalledOnce();
    // Other refusals still surface.
    renew.mockImplementationOnce(async () => {
      throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
    });
    now += 60;
    await expect(
      registry.renewPersistent(
        opened.token,
        identity,
        signal(),
        async () => {},
        s.port,
      ),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
  });

  const readOnlyFile = {
    kind: "saved-resource" as const,
    version: 1 as const,
    uri: "cad://parts/7",
    name: "part.cad",
  };
  it.each([
    [
      "quick-action App",
      {
        selector: { kind: "quick-action" as const, requestId: crypto.randomUUID() },
        toolName: "fixture-action",
        sourceToolName: "fixture-launcher",
        arguments: {},
        presentation: "app" as const,
        revision: "tool-revision",
      },
    ],
    [
      "read-only file viewer",
      {
        selector: { kind: "file" as const, requestId: crypto.randomUUID() },
        toolName: "fixture-viewer",
        revision: "tool-revision",
        file: readOnlyFile,
      },
    ],
  ])("renews a %s past its original expiry like any App", async (_, activation) => {
    let now = 1_000_000;
    const clock = () => now;
    const s = store(clock);
    const registry = new PluginInstanceRegistry(clock, 100);
    const opened = await registry.openActivationPersistent(
      identity,
      { ...binding, activation },
      signal(),
      s.port,
    );
    expect(opened.expiresAt).toBe(now + 100);
    for (let round = 0; round < 3; round++) {
      now += 80;
      await expect(
        registry.renewPersistent(
          opened.token,
          identity,
          signal(),
          async () => {},
          s.port,
        ),
      ).resolves.toEqual({ expiresAt: now + 100, renewed: true });
    }
    // Well past the original lease: the same activation is still live.
    expect(registry.get(opened.token, identity).activation.operationId).toBe(
      opened.instance.activation.operationId,
    );
  });

  it("renews a writable file viewer past its original expiry, keeping the same activation", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const s = store(clock);
    const registry = new PluginInstanceRegistry(clock, 100);
    const file = {
      ...readOnlyFile,
      localTarget: {
        root: "/fixture/files",
        relativePath: "part.cad",
        uri: readOnlyFile.uri,
        exclusiveWrites: true as const,
      },
    };
    const opened = await registry.openActivationPersistent(
      identity,
      {
        ...binding,
        activation: {
          selector: { kind: "file", requestId: crypto.randomUUID() },
          toolName: "fixture-viewer",
          revision: "tool-revision",
          file,
        },
      },
      signal(),
      s.port,
    );
    const deadline = now + 100;
    // No fixed ceiling: its file grant renews with the lease (the route
    // extends it in place), so unsaved App state survives a long session.
    for (let round = 0; round < 3; round++) {
      now += 80;
      await expect(
        registry.renewPersistent(
          opened.token,
          identity,
          signal(),
          async () => {},
          s.port,
        ),
      ).resolves.toEqual({ expiresAt: now + 100, renewed: true });
    }
    expect(now).toBeGreaterThan(deadline);
    expect(registry.get(opened.token, identity).activation.operationId).toBe(
      opened.instance.activation.operationId,
    );
    // Unrenewed, it still ends: never reused after its deadline.
    now += 101;
    expect(() => registry.get(opened.token, identity)).toThrow(
      "INSTANCE_UNAVAILABLE",
    );
  });

  it("returns the live original when only per-request permissions changed, but not for a new host binding", async () => {
    const s = store(Date.now);
    const registry = new PluginInstanceRegistry();
    const opened = await registry.openActivationPersistent(
      identity,
      { ...binding, messageEnabled: true },
      signal(),
      s.port,
    );
    // Model context and messages toggled off since the App opened.
    const reopened = await registry.openActivationPersistent(
      identity,
      { ...binding, contextEnabled: false, messageEnabled: false },
      signal(),
      s.port,
    );
    expect(reopened.token).toBe(opened.token);
    expect(reopened.instance.activation.operationId).toBe(
      opened.instance.activation.operationId,
    );
    await expect(
      registry.openActivationPersistent(
        identity,
        { ...binding, hostRevision: "another-host-binding" },
        signal(),
        s.port,
      ),
    ).rejects.toThrow("ACTIVATION_BINDING_CHANGED");
  });

  it("explains when the durable store cannot renew", async () => {
    const s = store(Date.now);
    const registry = new PluginInstanceRegistry();
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      s.port,
    );
    const { renew: _renew, ...withoutRenew } = s.port;
    await expect(
      registry.renewPersistent(
        opened.token,
        identity,
        signal(),
        async () => {},
        withoutRenew,
      ),
    ).rejects.toThrow("INSTANCE_RENEWAL_UNAVAILABLE");
  });
});
