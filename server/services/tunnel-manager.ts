import ngrok from '@ngrok/ngrok';
import type { Listener } from '@ngrok/ngrok';

class TunnelManager {
  private listener: Listener | null = null;
  private baseUrl: string | null = null;
  private ngrokToken: string | null = null;

  // Set the ngrok token (fetched from Convex)
  setNgrokToken(token: string) {
    this.ngrokToken = token;
  }

  // Create a single shared tunnel to the Hono server
  async createTunnel(localAddr?: string): Promise<string> {
    // Return existing tunnel if already created
    if (this.baseUrl) {
      return this.baseUrl;
    }

    if (!this.ngrokToken) {
      throw new Error('Ngrok token not configured. Please fetch token first.');
    }

    // Default to localhost:6274 if not provided for backward compatibility
    const addr = localAddr || 'http://localhost:6274';

    try {
      // Create a single tunnel pointing to the Hono server
      this.listener = await ngrok.forward({
        addr,
        authtoken: this.ngrokToken,
      });

      this.baseUrl = this.listener.url()!;

      console.log(`✓ Created shared tunnel: ${this.baseUrl} -> ${addr}`);
      return this.baseUrl;
    } catch (error: any) {
      console.error(`✗ Failed to create tunnel:`, error.message);
      throw error;
    }
  }

  // Close the tunnel
  async closeTunnel(): Promise<void> {
    if (this.listener) {
      await this.listener.close();
      console.log(`✓ Closed tunnel`);
      this.listener = null;
      this.baseUrl = null;
    }
  }

  // Get the base tunnel URL
  getTunnelUrl(): string | null {
    return this.baseUrl;
  }

  // Get the full URL for a specific server
  getServerTunnelUrl(serverId: string): string | null {
    if (!this.baseUrl) {
      return null;
    }
    return `${this.baseUrl}/api/mcp/adapter-http/${serverId}`;
  }

  // Check if a tunnel exists
  hasTunnel(): boolean {
    return this.baseUrl !== null;
  }

  // Close all tunnels (kept for compatibility, now just closes the single tunnel)
  async closeAll(): Promise<void> {
    if (this.listener) {
      console.log(`Closing tunnel...`);
      await this.closeTunnel();
    }
  }
}

export const tunnelManager = new TunnelManager();
