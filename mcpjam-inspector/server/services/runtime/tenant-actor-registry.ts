import { randomUUID } from "crypto";
import { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "../../utils/logger";
import { RpcLogBus } from "../rpc-log-bus";
import { ProgressStore } from "../progress-store";
import {
  InMemoryRuntimeDirectory,
  type RuntimeDirectory,
  type RuntimeDirectoryRecord,
} from "./runtime-directory";
import { ensureElicitationCallback } from "../elicitation-hub";

export type RuntimeTier = "shared" | "dedicated";

export interface TenantRuntimeActor {
  tenantId: string;
  actorId: string;
  shardId: string;
  tier: RuntimeTier;
  mcpClientManager: MCPClientManager;
  rpcLogBus: RpcLogBus;
  progressStore: ProgressStore;
  createdAt: number;
  lastSeenAt: number;
}

interface ManagedActor {
  actor: TenantRuntimeActor;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hashTenant(tenantId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < tenantId.length; i += 1) {
    hash ^= tenantId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function inferShardId(): string {
  return (
    process.env.MCPJAM_SHARD_ID ||
    process.env.HOSTNAME ||
    `mcpjam-shard-${process.pid}`
  );
}

function selectShard(tenantId: string, localShardId: string): string {
  const shards = parseList(process.env.MCPJAM_RUNTIME_SHARDS);
  if (shards.length === 0) return localShardId;
  const index = hashTenant(tenantId) % shards.length;
  return shards[index];
}

async function disconnectAllServers(manager: MCPClientManager): Promise<void> {
  const serverIds = manager.listServers();
  await Promise.all(
    serverIds.map(async (serverId) => {
      try {
        await manager.disconnectServer(serverId);
      } catch (error) {
        logger.warn("Failed to disconnect server while evicting actor", {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        manager.removeServer(serverId);
      } catch (error) {
        logger.warn("Failed to remove server while evicting actor", {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

export class TenantActorRegistry {
  private readonly actors = new Map<string, ManagedActor>();
  private readonly directory: RuntimeDirectory;
  private readonly idleTtlMs: number;
  private readonly localShardId: string;
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options?: {
    directory?: RuntimeDirectory;
    idleTtlMs?: number;
    localShardId?: string;
    cleanupIntervalMs?: number;
  }) {
    this.directory = options?.directory ?? new InMemoryRuntimeDirectory();
    this.idleTtlMs =
      options?.idleTtlMs ??
      Number(process.env.MCPJAM_ACTOR_IDLE_TTL_MS || 15 * 60 * 1000);
    this.localShardId = options?.localShardId ?? inferShardId();
    this.cleanupIntervalMs =
      options?.cleanupIntervalMs ??
      Number(process.env.MCPJAM_ACTOR_CLEANUP_INTERVAL_MS || 60_000);

    if (this.idleTtlMs > 0 && this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.evictIdleActors();
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  getOrCreateActor(tenantId: string, tier: RuntimeTier = "shared") {
    const existing = this.actors.get(tenantId);
    if (existing) {
      existing.actor.lastSeenAt = Date.now();
      this.directory.upsert(this.toDirectoryRecord(existing.actor, "active"));
      return existing.actor;
    }

    const assignedShard = selectShard(tenantId, this.localShardId);
    const enforceShard = process.env.MCPJAM_ENFORCE_SHARD_ASSIGNMENT === "true";
    if (enforceShard && assignedShard !== this.localShardId) {
      throw new Error(
        `Tenant '${tenantId}' belongs to shard '${assignedShard}', local shard is '${this.localShardId}'`,
      );
    }

    const actorId = randomUUID();
    const rpcLogBus = new RpcLogBus();
    const progressStore = new ProgressStore();
    const mcpClientManager = new MCPClientManager(
      {},
      {
        rpcLogger: ({ direction, message, serverId }) => {
          rpcLogBus.publish({
            serverId,
            direction,
            timestamp: new Date().toISOString(),
            message,
          });
        },
        progressHandler: ({
          serverId,
          progressToken,
          progress,
          total,
          message,
        }) => {
          progressStore.publish({
            serverId,
            progressToken,
            progress,
            total,
            message,
            timestamp: new Date().toISOString(),
          });
        },
      },
    );

    ensureElicitationCallback(mcpClientManager);

    const now = Date.now();
    const actor: TenantRuntimeActor = {
      tenantId,
      actorId,
      shardId: assignedShard,
      tier,
      mcpClientManager,
      rpcLogBus,
      progressStore,
      createdAt: now,
      lastSeenAt: now,
    };

    this.actors.set(tenantId, { actor });
    this.directory.upsert(this.toDirectoryRecord(actor, "active"));
    logger.info(
      `[runtime] Created tenant actor tenant=${tenantId} actor=${actorId} shard=${assignedShard} tier=${tier}`,
    );
    return actor;
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async evictIdleActors(now = Date.now()): Promise<void> {
    if (this.idleTtlMs <= 0) return;

    const evictions: string[] = [];
    for (const [tenantId, managed] of this.actors.entries()) {
      if (now - managed.actor.lastSeenAt > this.idleTtlMs) {
        evictions.push(tenantId);
      }
    }

    await Promise.all(
      evictions.map(async (tenantId) => {
        const managed = this.actors.get(tenantId);
        if (!managed) return;

        await disconnectAllServers(managed.actor.mcpClientManager);
        managed.actor.progressStore.stopCleanupInterval();
        this.actors.delete(tenantId);
        this.directory.upsert(this.toDirectoryRecord(managed.actor, "evicted"));
        this.directory.remove(tenantId);
        logger.info(
          `[runtime] Evicted idle actor tenant=${tenantId} actor=${managed.actor.actorId}`,
        );
      }),
    );
  }

  private toDirectoryRecord(
    actor: TenantRuntimeActor,
    status: RuntimeDirectoryRecord["status"],
  ): RuntimeDirectoryRecord {
    return {
      tenantId: actor.tenantId,
      shardId: actor.shardId,
      actorId: actor.actorId,
      tier: actor.tier,
      status,
      lastSeenAt: actor.lastSeenAt,
    };
  }
}

export const tenantActorRegistry = new TenantActorRegistry();
