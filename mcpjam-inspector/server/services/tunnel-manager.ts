import { logger } from "../utils/logger";
import { RelayConnection, type RelayConnectionOptions } from "./relay-client";
import {
  registerTunnelDomain,
  unregisterTunnelDomain,
} from "./tunnel-registry";

/**
 * A tunnel is bound to one path scope. `adapter-http` (default) fronts the
 * desktop MCP adapter; `harness-web` fronts the hosted harness proxy route.
 * Both can be live for the same server simultaneously, so the manager keys
 * entries by `(scope, serverId)`.
 */
export type TunnelScope = "adapter-http" | "harness-web";

function entryKey(scope: TunnelScope, serverId: string): string {
  return `${scope}\x1f${serverId}`;
}

interface TunnelEntry {
  connection: RelayConnection;
  /** Public host ({slug}.tunnels.mcpjam.com) registered for isolation checks. */
  host: string;
  baseUrl: string;
  slug: string;
  // Full bearer URL (contains the ?k= secret). Held in memory ONLY — the
  // backend persists just the secret hash, so this entry is the single
  // holder of the plaintext URL while the connection lives.
  publicUrl: string;
  secretVersion?: number;
}

export interface CreateTunnelOptions {
  localAddr: string;
  slug: string;
  relayWsUrl: string;
  connectToken: string;
  publicUrl: string;
  secretVersion?: number;
}

class TunnelManager {
  private tunnels: Map<string, TunnelEntry> = new Map();

  /**
   * Open the relay connection for a server and return the public base URL.
   * Idempotent per server: an existing live tunnel is returned as-is.
   */
  async createTunnel(
    serverId: string,
    options: CreateTunnelOptions,
    scope: TunnelScope = "adapter-http"
  ): Promise<string> {
    const key = entryKey(scope, serverId);
    const existingTunnel = this.tunnels.get(key);
    if (existingTunnel) {
      return existingTunnel.baseUrl;
    }

    const host = new URL(options.publicUrl).hostname;
    let registered = false;
    let earlyPermanentFailure: { reason: string; code: number } | null = null;
    const connection = new RelayConnection({
      serverId,
      slug: options.slug,
      relayWsUrl: options.relayWsUrl,
      connectToken: options.connectToken,
      localAddr: options.localAddr,
      publicHost: host,
      onPermanentFailure: (reason, code) => {
        // The relay refused this grant for good (expired, replaced by
        // another inspector, or revoked) — drop the entry so the UI offers
        // a fresh create instead of advertising a dead URL.
        if (!registered) {
          earlyPermanentFailure = { reason, code };
          return;
        }
        this.dropEntry(key, serverId, reason, code);
      },
    } satisfies RelayConnectionOptions);

    try {
      await connection.connect();
      // Snapshot with an `as` cast: the closure-assigned `let` is otherwise
      // flow-narrowed to its `null` initializer (the assignment is invisible to
      // TS), which makes the `||` truthy-branch collapse to `never`. The cast
      // restores the real declared type.
      const early = earlyPermanentFailure as {
        reason: string;
        code: number;
      } | null;
      if (early || connection.permanentFailure) {
        throw new Error(
          early?.reason ??
            connection.permanentFailure ??
            "Tunnel relay closed permanently before registration"
        );
      }
      if (!connection.isConnected) {
        throw new Error("Tunnel relay closed before registration");
      }
    } catch (error: any) {
      connection.close();
      logger.error(`✗ Failed to create tunnel:`, error);
      throw error;
    }

    // A permanent close (4000/4001/4002) can land between the handshake
    // resolving and the registration below; its onPermanentFailure→dropEntry
    // would be a no-op (entry not in the map yet), and we'd register a dead
    // connection. Bail if the relay already gave up — this synchronous check
    // and the registration that follows can't be interleaved by a later
    // 'close' event, so registering past it is safe (that drop finds the
    // entry).
    if (connection.permanentFailure) {
      const reason = connection.permanentFailure;
      connection.close();
      logger.warn(`✗ Tunnel (${serverId}) died during handshake: ${reason}`);
      throw new Error(reason);
    }

    const baseUrl = `https://${host}`;
    this.tunnels.set(key, {
      connection,
      host,
      baseUrl,
      slug: options.slug,
      publicUrl: options.publicUrl,
      secretVersion: options.secretVersion,
    });
    registered = true;
    // Register the host for tunnel isolation + the session-token-leak guard
    // (which must deny the session token on harness-web tunnel hosts too).
    registerTunnelDomain(host, serverId);

    logger.info(
      `✓ Created tunnel [${scope}] (${serverId}): ${baseUrl} -> ${options.localAddr}`
    );
    return baseUrl;
  }

  /**
   * Re-establish the connection with a fresh grant (rotation). The slug is
   * normally stable so the base URL never changes — only the bearer secret
   * in the URL does (a `full` rotation swaps the slug too). The backend has
   * already revoked the old grant at the edge, so close-then-connect is
   * pure reconnection, not revocation.
   */
  async rotateTunnel(
    serverId: string,
    options: CreateTunnelOptions,
    scope: TunnelScope = "adapter-http"
  ): Promise<string> {
    await this.closeTunnel(serverId, scope);
    return this.createTunnel(serverId, options, scope);
  }

  async closeTunnel(
    serverId: string,
    scope: TunnelScope = "adapter-http"
  ): Promise<void> {
    const key = entryKey(scope, serverId);
    const entry = this.tunnels.get(key);
    if (!entry) {
      return;
    }

    entry.connection.close();
    this.tunnels.delete(key);
    unregisterTunnelDomain(entry.host);
    logger.info(`✓ Closed tunnel [${scope}] (${serverId})`);
  }

  getServerTunnelUrl(
    serverId: string,
    scope: TunnelScope = "adapter-http"
  ): string | null {
    return this.tunnels.get(entryKey(scope, serverId))?.publicUrl ?? null;
  }

  getServerTunnelSlug(
    serverId: string,
    scope: TunnelScope = "adapter-http"
  ): string | null {
    return this.tunnels.get(entryKey(scope, serverId))?.slug ?? null;
  }

  hasTunnel(): boolean {
    return this.tunnels.size > 0;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const entry of entries) {
      entry.connection.close();
      unregisterTunnelDomain(entry.host);
    }
  }

  private dropEntry(
    key: string,
    serverId: string,
    reason: string,
    code: number
  ): void {
    const entry = this.tunnels.get(key);
    if (!entry) return;
    this.tunnels.delete(key);
    unregisterTunnelDomain(entry.host);
    logger.warn(`Tunnel (${serverId}) ended by relay [${code}]: ${reason}`);
  }
}

export const tunnelManager = new TunnelManager();
