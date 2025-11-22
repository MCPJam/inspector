import ngrok from '@ngrok/ngrok';
import type { Listener } from '@ngrok/ngrok';

type TunnelInfo = {
  listener: Listener;
  url: string;
  serverId: string;
};

class TunnelManager {
  private tunnels: Map<string, TunnelInfo> = new Map();
  private ngrokToken: string | null = null;

  // Set the ngrok token (fetched from Convex)
  setNgrokToken(token: string) {
    this.ngrokToken = token;
  }

  // Create a tunnel for a specific server
  async createTunnel(serverId: string): Promise<string> {
    // Check if tunnel already exists
    if (this.tunnels.has(serverId)) {
      return this.tunnels.get(serverId)!.url;
    }

    if (!this.ngrokToken) {
      throw new Error('Ngrok token not configured. Please fetch token first.');
    }

    try {
      // Create tunnel pointing to the base server
      // The full URL will be: https://xxxx.ngrok-free.dev/api/mcp/adapter-http/${serverId}
      const listener = await ngrok.forward({
        addr: 'http://localhost:6274',
        authtoken: this.ngrokToken,
      });

      const baseUrl = listener.url()!;
      // Construct the full URL with the path to the adapter-http endpoint
      const url = `${baseUrl}/api/mcp/adapter-http/${serverId}`;

      this.tunnels.set(serverId, { listener, url, serverId });

      console.log(`✓ Created tunnel for ${serverId}: ${url}`);
      return url;
    } catch (error: any) {
      console.error(`✗ Failed to create tunnel for ${serverId}:`, error.message);
      throw error;
    }
  }

  // Close a specific tunnel
  async closeTunnel(serverId: string): Promise<void> {
    const tunnel = this.tunnels.get(serverId);
    if (tunnel) {
      await tunnel.listener.close();
      this.tunnels.delete(serverId);
      console.log(`✓ Closed tunnel for ${serverId}`);
    }
  }

  // Get tunnel URL if it exists
  getTunnelUrl(serverId: string): string | null {
    return this.tunnels.get(serverId)?.url || null;
  }

  // Check if a tunnel exists for a server
  hasTunnel(serverId: string): boolean {
    return this.tunnels.has(serverId);
  }

  // Close all tunnels
  async closeAll(): Promise<void> {
    console.log(`Closing ${this.tunnels.size} tunnels...`);
    for (const [serverId, tunnel] of this.tunnels.entries()) {
      try {
        await tunnel.listener.close();
        console.log(`✓ Closed tunnel for ${serverId}`);
      } catch (error) {
        console.error(`✗ Error closing tunnel for ${serverId}:`, error);
      }
    }
    this.tunnels.clear();
  }

  // Get all active tunnels
  getActiveTunnels(): Array<{ serverId: string; url: string }> {
    return Array.from(this.tunnels.values()).map((t) => ({
      serverId: t.serverId,
      url: t.url,
    }));
  }
}

export const tunnelManager = new TunnelManager();
