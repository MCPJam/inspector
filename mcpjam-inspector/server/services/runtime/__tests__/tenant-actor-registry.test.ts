import { afterEach, describe, expect, it } from "vitest";
import {
  TenantActorRegistry,
  type TenantRuntimeActor,
} from "../tenant-actor-registry";
import { InMemoryRuntimeDirectory } from "../runtime-directory";

const registries: TenantActorRegistry[] = [];

afterEach(() => {
  for (const registry of registries) {
    registry.stop();
  }
  registries.length = 0;
});

function createRegistry() {
  const registry = new TenantActorRegistry({
    directory: new InMemoryRuntimeDirectory(),
    localShardId: "test-shard",
    idleTtlMs: 50,
    cleanupIntervalMs: 0,
  });
  registries.push(registry);
  return registry;
}

function publishActorLog(actor: TenantRuntimeActor, message: unknown) {
  actor.rpcLogBus.publish({
    serverId: "shared-server-name",
    direction: "send",
    timestamp: new Date().toISOString(),
    message,
  });
}

describe("TenantActorRegistry", () => {
  it("returns the same actor for repeated requests of the same tenant", () => {
    const registry = createRegistry();
    const first = registry.getOrCreateActor("tenant-a", "shared");
    const second = registry.getOrCreateActor("tenant-a", "shared");

    expect(second.actorId).toBe(first.actorId);
  });

  it("isolates rpc log buffers between tenants with same serverId", () => {
    const registry = createRegistry();
    const actorA = registry.getOrCreateActor("tenant-a", "shared");
    const actorB = registry.getOrCreateActor("tenant-b", "shared");

    publishActorLog(actorA, { from: "tenant-a" });
    publishActorLog(actorB, { from: "tenant-b" });

    const logsA = actorA.rpcLogBus.getBuffer(["shared-server-name"], 10);
    const logsB = actorB.rpcLogBus.getBuffer(["shared-server-name"], 10);

    expect(logsA).toHaveLength(1);
    expect(logsB).toHaveLength(1);
    expect(logsA[0].message).toEqual({ from: "tenant-a" });
    expect(logsB[0].message).toEqual({ from: "tenant-b" });
  });

  it("evicts idle actors and recreates fresh actor on next access", async () => {
    const registry = createRegistry();
    const initialActor = registry.getOrCreateActor("tenant-a", "shared");

    initialActor.lastSeenAt = Date.now() - 500;
    await registry.evictIdleActors(Date.now());

    const recreatedActor = registry.getOrCreateActor("tenant-a", "shared");
    expect(recreatedActor.actorId).not.toBe(initialActor.actorId);
  });
});
