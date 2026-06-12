import { logger } from "../utils/logger";
import { RelayConnection, type RelayConnectionOptions } from "./relay-client";
import {
  registerTunnelDomain,
  unregisterTunnelDomain,
} from "./tunnel-registry";

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
    options: CreateTunnelOptions
  ): Promise<string> {
    const existingTunnel = this.tunnels.get(serverId);
    if (existingTunnel) {
      return existingTunnel.baseUrl;
    }

    const host = new URL(options.publicUrl).hostname;
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
        this.dropEntry(serverId, reason, code);
      },
    } satisfies RelayConnectionOptions);

    try {
      await connection.connect();
    } catch (error: any) {
      connection.close();
      logger.error(`✗ Failed to create tunnel:`, error);
      throw error;
    }

    const baseUrl = `https://${host}`;
    this.tunnels.set(serverId, {
      connection,
      host,
      baseUrl,
      slug: options.slug,
      publicUrl: options.publicUrl,
      secretVersion: options.secretVersion,
    });
    registerTunnelDomain(host, serverId);

    logger.info(
      `✓ Created tunnel (${serverId}): ${baseUrl} -> ${options.localAddr}`
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
    options: CreateTunnelOptions
  ): Promise<string> {
    await this.closeTunnel(serverId);
    return this.createTunnel(serverId, options);
  }

  async closeTunnel(serverId: string): Promise<void> {
    const entry = this.tunnels.get(serverId);
    if (!entry) {
      return;
    }

    entry.connection.close();
    this.tunnels.delete(serverId);
    unregisterTunnelDomain(entry.host);
    logger.info(`✓ Closed tunnel (${serverId})`);
  }

  getServerTunnelUrl(serverId: string): string | null {
    return this.tunnels.get(serverId)?.publicUrl ?? null;
  }

  getServerTunnelSlug(serverId: string): string | null {
    return this.tunnels.get(serverId)?.slug ?? null;
  }

  hasTunnel(): boolean {
    return this.tunnels.size > 0;
  }

  async closeAll(): Promise<void> {
    const serverIds = [...this.tunnels.keys()];
    for (const serverId of serverIds) {
      await this.closeTunnel(serverId);
    }
  }

  private dropEntry(serverId: string, reason: string, code: number): void {
    const entry = this.tunnels.get(serverId);
    if (!entry) return;
    this.tunnels.delete(serverId);
    unregisterTunnelDomain(entry.host);
    logger.warn(`Tunnel (${serverId}) ended by relay [${code}]: ${reason}`);
  }
}

export const tunnelManager = new TunnelManager();
