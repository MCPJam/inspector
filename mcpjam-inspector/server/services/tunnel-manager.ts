import ngrok from "@ngrok/ngrok";
import type { Listener } from "@ngrok/ngrok";
import { logger } from "../utils/logger";

interface TunnelEntry {
  listener: Listener;
  baseUrl: string;
  credentialId?: string;
  domainId?: string;
  domain?: string;
}

interface CreateTunnelOptions {
  localAddr?: string;
  ngrokToken: string;
  credentialId?: string;
  domainId?: string;
  domain?: string;
}

class TunnelManager {
  private tunnels: Map<string, TunnelEntry> = new Map();
  private readonly sharedTunnelId = "shared";

  async createTunnel(
    tunnelId: string,
    options: CreateTunnelOptions,
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

      const listener = await ngrok.forward(config);
      const baseUrl = listener.url()!;
      this.tunnels.set(tunnelId, {
        listener,
        baseUrl,
        credentialId: options.credentialId,
        domainId: options.domainId,
        domain: options.domain,
      });

      logger.info(`✓ Created tunnel (${tunnelId}): ${baseUrl} -> ${addr}`);
      return baseUrl;
    } catch (error: any) {
      logger.error(`✗ Failed to create tunnel:`, error);
      throw error;
    }
  }

  async closeTunnel(tunnelId: string): Promise<void> {
    const entry = this.tunnels.get(tunnelId);
    if (!entry) {
      return;
    }

    await entry.listener.close();
    this.tunnels.delete(tunnelId);
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
    const perServerTunnelUrl = this.getTunnelUrl(serverId);
    const encodedServerId = encodeURIComponent(serverId);
    return perServerTunnelUrl
      ? `${perServerTunnelUrl}/api/mcp/adapter-http/${encodedServerId}`
      : null;
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
