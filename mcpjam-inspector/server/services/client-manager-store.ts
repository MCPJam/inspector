import type { MCPClientManager } from "@mcpjam/sdk";
import { logger as appLogger } from "../utils/logger.js";

const DEFAULT_SESSION_KEY = "default";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

type ManagerFactory = (sessionKey?: string) => MCPClientManager;

type SessionEntry = {
  manager: MCPClientManager;
  lastAccessedAt: number;
};

export interface ClientManagerStore {
  getManager(sessionKey?: string): MCPClientManager;
  dispose(): Promise<void>;
}

export interface SessionClientManagerStoreOptions {
  ttlMs?: number;
  sweepIntervalMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface CreateClientManagerStoreOptions {
  hostedMode: boolean;
  managerFactory: ManagerFactory;
  sessionStoreOptions?: SessionClientManagerStoreOptions;
}

export function readSessionStoreOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SessionClientManagerStoreOptions {
  return {
    ttlMs: readPositiveInteger(
      env.MCPJAM_MANAGER_SESSION_TTL_MS,
      DEFAULT_TTL_MS,
    ),
    sweepIntervalMs: readPositiveInteger(
      env.MCPJAM_MANAGER_SWEEP_INTERVAL_MS,
      DEFAULT_SWEEP_INTERVAL_MS,
    ),
    maxEntries: readPositiveInteger(
      env.MCPJAM_MANAGER_MAX_SESSIONS,
      DEFAULT_MAX_ENTRIES,
    ),
  };
}

export function createClientManagerStore({
  hostedMode,
  managerFactory,
  sessionStoreOptions,
}: CreateClientManagerStoreOptions): ClientManagerStore {
  if (!hostedMode) {
    return new SingletonClientManagerStore(managerFactory);
  }

  return new SessionClientManagerStore(managerFactory, sessionStoreOptions);
}

export class SingletonClientManagerStore implements ClientManagerStore {
  private manager: MCPClientManager | null = null;

  constructor(private readonly managerFactory: ManagerFactory) {}

  getManager(_sessionKey?: string): MCPClientManager {
    if (!this.manager) {
      this.manager = this.managerFactory(_sessionKey);
    }
    return this.manager;
  }

  async dispose(): Promise<void> {
    const manager = this.manager;
    this.manager = null;
    if (manager) {
      await disconnectManager(manager);
    }
  }
}

export class SessionClientManagerStore implements ClientManagerStore {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastSweepAt = 0;

  constructor(
    private readonly managerFactory: ManagerFactory,
    options: SessionClientManagerStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  getManager(sessionKey?: string): MCPClientManager {
    const key = normalizeSessionKey(sessionKey);
    const now = this.now();
    this.maybeSweep(now);

    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessedAt = now;
      return existing.manager;
    }

    this.evictIfAtCapacity();

    const manager = this.managerFactory(key);
    this.entries.set(key, { manager, lastAccessedAt: now });
    return manager;
  }

  async dispose(): Promise<void> {
    const managers = Array.from(this.entries.values()).map((e) => e.manager);
    this.entries.clear();
    await Promise.all(managers.map((manager) => disconnectManager(manager)));
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;

    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.lastAccessedAt >= this.ttlMs) {
        this.evictSession(key, "ttl_expired");
      }
    }
  }

  private evictIfAtCapacity(): void {
    if (this.entries.size < this.maxEntries) return;

    let oldestKey: string | null = null;
    let oldestAccessedAt = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.lastAccessedAt < oldestAccessedAt) {
        oldestAccessedAt = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.evictSession(oldestKey, "capacity");
    }
  }

  private evictSession(sessionKey: string, reason: "ttl_expired" | "capacity") {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;

    this.entries.delete(sessionKey);
    appLogger.debug("[client-manager-store] evict session manager", {
      sessionKey,
      reason,
    });
    void disconnectManager(entry.manager);
  }
}

async function disconnectManager(manager: MCPClientManager): Promise<void> {
  const serverIds = manager.listServers();

  await Promise.all(
    serverIds.map(async (serverId) => {
      try {
        const client = manager.getClient(serverId);
        if (client) {
          await manager.disconnectServer(serverId);
        }
      } catch (error) {
        appLogger.warn("[client-manager-store] failed to disconnect server", {
          serverId,
          error,
        });
      }

      try {
        manager.removeServer(serverId);
      } catch (error) {
        appLogger.warn("[client-manager-store] failed to remove server", {
          serverId,
          error,
        });
      }
    }),
  );
}

function readPositiveInteger(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeSessionKey(sessionKey?: string): string {
  if (!sessionKey) return DEFAULT_SESSION_KEY;
  return sessionKey;
}
