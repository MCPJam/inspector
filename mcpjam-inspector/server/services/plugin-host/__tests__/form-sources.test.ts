import { describe, expect, it } from "vitest";
import {
  PluginFormSourceRegistry,
  pluginFormSources,
  type PluginFormSource,
} from "../form-sources";
import { PluginInstanceRegistry } from "../instances";

const now = 1_000_000;
const fixture = (): PluginFormSource => ({
  owner: {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "instance",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive",
  },
  hostId: "host",
  hostRevision: "host-revision",
  invocationId: "operation",
  origin: "app",
  revision: "tool-revision",
  toolName: "tool",
  parent: { kind: "legacy", id: "rendezvous", round: 0 },
  requestedSchema: { type: "object", properties: { note: { type: "string" } } },
  expiresAt: now + 1000,
});
describe("original-operation form source links", () => {
  it("keeps immutable snapshots and returns an opaque stable handle with no request ports", () => {
    const registry = new PluginFormSourceRegistry(() => now);
    const input = fixture();
    const lease = registry.bind(input);
    expect(lease.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(registry.bind(fixture()).token).toBe(lease.token);
    input.hostRevision = "changed";
    const returned = registry.get(
      lease.token,
      fixture().owner,
      fixture().parent,
    );
    expect(returned.source).toEqual(fixture());
    returned.source.owner.actorId = "changed";
    expect(
      registry.get(lease.token, fixture().owner, fixture().parent).source.owner
        .actorId,
    ).toBe("actor");
    expect(Object.keys(returned.source).sort()).toEqual(
      Object.keys(fixture()).sort(),
    );
    lease.release();
    expect(returned.signal.aborted).toBe(true);
    expect(() =>
      registry.get(lease.token, fixture().owner, fixture().parent),
    ).toThrow("FORM_SOURCE_UNAVAILABLE");
  });
  it.each(["actorId", "projectId", "workspaceId"] as const)(
    "refuses a foreign %s",
    (key) => {
      const registry = new PluginFormSourceRegistry(() => now);
      const lease = registry.bind(fixture());
      expect(() =>
        registry.get(
          lease.token,
          { ...fixture().owner, [key]: "foreign" },
          fixture().parent,
        ),
      ).toThrow("FORM_SOURCE_UNAVAILABLE");
    },
  );
  it.each([
    { kind: "legacy", id: "foreign", round: 0 },
    { kind: "mrtr", id: "rendezvous", round: 1, inputRequestKey: "input" },
  ] as const)("refuses another parent or transport %j", (parent) => {
    const registry = new PluginFormSourceRegistry(() => now);
    const lease = registry.bind(fixture());
    expect(() => registry.get(lease.token, fixture().owner, parent)).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
  });
  it.each([
    "hostRevision",
    "revision",
    "invocationId",
    "toolName",
    "hostId",
  ] as const)("cannot replace immutable %s on the same parent", (key) => {
    const registry = new PluginFormSourceRegistry(() => now);
    registry.bind(fixture());
    expect(() => registry.bind({ ...fixture(), [key]: "changed" })).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
  });
  it("fences MRTR request keys/rounds and cancels only the exact old round", () => {
    const registry = new PluginFormSourceRegistry(() => now);
    const a = {
      ...fixture(),
      parent: {
        kind: "mrtr" as const,
        id: "continuation",
        round: 1,
        inputRequestKey: "a",
      },
    };
    const b = { ...a, parent: { ...a.parent, inputRequestKey: "b" } };
    const next = { ...a, parent: { ...a.parent, round: 2 } };
    const leases = [a, b, next].map((value) => registry.bind(value));
    expect(() => registry.get(leases[0].token, a.owner, b.parent)).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
    expect(() => registry.get(leases[0].token, a.owner, next.parent)).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
    registry.closeRound(a.owner, a.invocationId, a.parent.id, 1);
    for (const [i, source] of [a, b].entries())
      expect(() =>
        registry.get(leases[i].token, source.owner, source.parent),
      ).toThrow("FORM_SOURCE_UNAVAILABLE");
    const { signal } = registry.get(leases[2].token, next.owner, next.parent);
    registry.closeOperation(a.owner, a.invocationId);
    expect(signal.aborted).toBe(true);
  });
  it("expires and aborts reads, then frees its capacity; restart fails closed", () => {
    let clock = now;
    const registry = new PluginFormSourceRegistry(() => clock, 1);
    const lease = registry.bind(fixture());
    const { signal } = registry.get(
      lease.token,
      fixture().owner,
      fixture().parent,
    );
    expect(() =>
      registry.bind({
        ...fixture(),
        parent: { kind: "legacy", id: "another", round: 0 },
      }),
    ).toThrow("FORM_SOURCE_LIMIT");
    clock += 1000;
    expect(() =>
      registry.get(lease.token, fixture().owner, fixture().parent),
    ).toThrow("FORM_SOURCE_UNAVAILABLE");
    expect(signal.aborted).toBe(true);
    const next = { ...fixture(), expiresAt: clock + 1000 };
    registry.bind(next);
    expect(() =>
      new PluginFormSourceRegistry(() => clock).get(
        lease.token,
        next.owner,
        next.parent,
      ),
    ).toThrow("FORM_SOURCE_UNAVAILABLE");
  });
  it("bounds schema UTF-8 bytes and total retained bytes", () => {
    const value = fixture();
    value.requestedSchema = { type: "object", description: "π".repeat(131072) };
    expect(() => new PluginFormSourceRegistry(() => now).bind(value)).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
    expect(() =>
      new PluginFormSourceRegistry(() => now, 10, 1).bind(fixture()),
    ).toThrow("FORM_SOURCE_LIMIT");
  });
  it("requires the original live instance, exact generation/binding and credential subject", async () => {
    const instances = new PluginInstanceRegistry();
    const actor = {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      subject: "subject",
    };
    const port = {
      readActivation: async () => null,
      issueActivation: async (token: string, input: any) => ({
        token,
        control: {
          snapshotJson: input.snapshotJson,
          expiresAt: input.expiresAt,
        },
      }),
      close: async () => {},
    } as any;
    const opened = await instances.openActivationPersistent(
      actor,
      {
        runtime: "codex",
        hostId: "host",
        hostRevision: "revision",
        serverId: "server",
        bindingId: "binding",
        resourceUri: "ui://fixture",
        serverIdentity: { kind: "standalone", serverId: "server" },
        activation: {
          selector: { kind: "thread", threadId: "thread" },
          toolName: "source-tool",
          revision: "tool-revision",
        },
      },
      AbortSignal.timeout(1000),
      port,
    );
    const source = {
      ...fixture(),
      owner: opened.instance.owner,
      expiresAt: Date.now() + 10000,
    };
    const lease = pluginFormSources.bind(source);
    const { signal } = pluginFormSources.get(lease.token, actor, source.parent);
    expect(instances.getFormOwner(source.owner, actor)).toBe(opened.instance);
    for (const owner of [
      { ...source.owner, generation: 2 },
      { ...source.owner, bindingId: "changed" },
    ])
      expect(() => instances.getFormOwner(owner, actor)).toThrow(
        "FORM_SOURCE_UNAVAILABLE",
      );
    expect(() =>
      instances.getFormOwner(source.owner, {
        ...actor,
        subject: "other-credential",
      }),
    ).toThrow("INSTANCE_DENIED");
    await instances.closePersistent(
      opened.token,
      actor,
      AbortSignal.timeout(1000),
      port,
    );
    expect(signal.aborted).toBe(true);
    expect(() => instances.getFormOwner(source.owner, actor)).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
    expect(() =>
      pluginFormSources.get(lease.token, actor, source.parent),
    ).toThrow("FORM_SOURCE_UNAVAILABLE");
  });
});
