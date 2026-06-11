import ngrok from "@ngrok/ngrok";
import type { Listener } from "@ngrok/ngrok";
import { logger } from "../utils/logger";
import {
  registerTunnelDomain,
  unregisterTunnelDomain,
} from "./tunnel-registry";

interface TunnelEntry {
  listener: Listener;
  baseUrl: string;
  credentialId?: string;
  domainId?: string;
  domain?: string;
  // Full bearer URL (contains the ?k= secret). Held in memory ONLY — the
  // backend persists just the secret hash, so this entry is the single
  // holder of the plaintext URL while the listener is live.
  publicUrl?: string;
  secretVersion?: number;
}

interface CreateTunnelOptions {
  localAddr?: string;
  ngrokToken: string;
  credentialId?: string;
  domainId?: string;
  domain?: string;
  // Stringified ngrok Traffic Policy enforcing the bearer secret, the
  // per-server path scope, and rate limiting at the edge.
  trafficPolicy?: string;
  publicUrl?: string;
  secretVersion?: number;
}

class TunnelManager {
  private tunnels: Map<string, TunnelEntry> = new Map();
  private readonly sharedTunnelId = "shared";

  async createTunnel(
    tunnelId: string,
    options: CreateTunnelOptions
  ): Promise<string> {
    const existingTunnel = this.tunnels.get(tunnelId);
    if (existingTunnel) {
      return existingTunnel.baseUrl;
    }

    const addr = options.localAddr || "http://localhost:6274";

    try {
      const config: any = {
        addr,
        authtoken: options.ngrokToken,
      };

      if (options.domain) {
        config.domain = options.domain;
        // Add X-Forwarded-Host and X-Forwarded-Proto headers to preserve the original
        // ngrok domain and protocol. This allows downstream servers to know the public URL.
        config.request_header_add = [
          `X-Forwarded-Host:${options.domain}`,
          `X-Forwarded-Proto:https`,
        ];
      }

      if (options.trafficPolicy) {
        config.traffic_policy = options.trafficPolicy;
      }

      const listener = await ngrok.forward(config);
      const baseUrl = listener.url()!;
      this.tunnels.set(tunnelId, {
        listener,
        baseUrl,
        credentialId: options.credentialId,
        domainId: options.domainId,
        domain: options.domain,
        publicUrl: options.publicUrl,
        secretVersion: options.secretVersion,
      });
      if (options.domain) {
        registerTunnelDomain(
          options.domain,
          tunnelId === this.sharedTunnelId ? null : tunnelId
        );
      }

      logger.info(`✓ Created tunnel (${tunnelId}): ${baseUrl} -> ${addr}`);
      return baseUrl;
    } catch (error: any) {
      logger.error(`✗ Failed to create tunnel:`, error);
      throw error;
    }
  }

  /**
   * Re-establish the listener with a fresh authtoken + traffic policy.
   * ngrok bakes both in at listen time, so rotation is close-then-forward;
   * the reserved domain is reused so the base URL never changes — only the
   * bearer secret in the policy/URL does.
   */
  async rotateTunnel(
    tunnelId: string,
    options: CreateTunnelOptions
  ): Promise<string> {
    await this.closeTunnel(tunnelId);
    return this.createTunnel(tunnelId, options);
  }

  async closeTunnel(tunnelId: string): Promise<void> {
    const entry = this.tunnels.get(tunnelId);
    if (!entry) {
      return;
    }

    await entry.listener.close();
    this.tunnels.delete(tunnelId);
    if (entry.domain) {
      unregisterTunnelDomain(entry.domain);
    }
    logger.info(`✓ Closed tunnel (${tunnelId})`);

    try {
      if (this.tunnels.size === 0) {
        await ngrok.disconnect();
      }
    } catch (error) {
      // Already disconnected or no active listeners
    }
  }

  getCredentialId(tunnelId: string): string | null {
    return this.tunnels.get(tunnelId)?.credentialId ?? null;
  }

  getDomainId(tunnelId: string): string | null {
    return this.tunnels.get(tunnelId)?.domainId ?? null;
  }

  clearCredentials(tunnelId: string): void {
    const entry = this.tunnels.get(tunnelId);
    if (!entry) {
      return;
    }
    entry.credentialId = undefined;
    entry.domainId = undefined;
    entry.domain = undefined;
  }

  getTunnelUrl(tunnelId: string = this.sharedTunnelId): string | null {
    return this.tunnels.get(tunnelId)?.baseUrl ?? null;
  }

  getServerTunnelUrl(serverId: string): string | null {
    const entry = this.tunnels.get(serverId);
    if (!entry) {
      return null;
    }
    // Prefer the bearer URL (contains the edge-enforced secret); fall back
    // to the bare adapter path for legacy listeners without a policy.
    if (entry.publicUrl) {
      return entry.publicUrl;
    }
    const encodedServerId = encodeURIComponent(serverId);
    return `${entry.baseUrl}/api/mcp/adapter-http/${encodedServerId}`;
  }

  hasTunnel(): boolean {
    return this.tunnels.size > 0;
  }

  async closeAll(): Promise<void> {
    const tunnelIds = [...this.tunnels.keys()];
    for (const tunnelId of tunnelIds) {
      await this.closeTunnel(tunnelId);
    }

    try {
      await ngrok.disconnect();
    } catch (error) {
      // Already disconnected
    }
  }
}

export const tunnelManager = new TunnelManager();
