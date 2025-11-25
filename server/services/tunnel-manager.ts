import ngrok from "@ngrok/ngrok";
import type { Listener } from "@ngrok/ngrok";

class TunnelManager {
  private listener: Listener | null = null;
  private baseUrl: string | null = null;
  private ngrokToken: string | null = null;
  private credentialId: string | null = null;
  private domainId: string | null = null;
  private domain: string | null = null;

  setNgrokToken(
    token: string,
    credentialId?: string,
    domainId?: string,
    domain?: string,
  ) {
    this.ngrokToken = token;
    if (credentialId) this.credentialId = credentialId;
    if (domainId) this.domainId = domainId;
    if (domain) this.domain = domain;
  }

  async createTunnel(localAddr?: string): Promise<string> {
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
      this.baseUrl = null;
    }

    if (this.baseUrl) {
      return this.baseUrl;
    }

    if (!this.ngrokToken) {
      throw new Error("Ngrok token not configured. Please fetch token first.");
    }

    const addr = localAddr || "http://localhost:6274";

    try {
      const config: any = {
        addr,
        authtoken: this.ngrokToken,
      };

      if (this.domain) {
        config.domain = this.domain;
      }

      this.listener = await ngrok.forward(config);
      this.baseUrl = this.listener.url()!;

      console.log(`✓ Created tunnel: ${this.baseUrl} -> ${addr}`);
      return this.baseUrl;
    } catch (error: any) {
      console.error(`✗ Failed to create tunnel:`, error.message);
      this.clearCredentials();
      throw error;
    }
  }

  async closeTunnel(): Promise<void> {
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
      this.baseUrl = null;
    }

    try {
      await ngrok.disconnect();
      console.log(`✓ Closed tunnel`);
    } catch (error) {
      // Already disconnected
    }

    this.clearCredentials();
  }

  getCredentialId(): string | null {
    return this.credentialId;
  }

  getDomainId(): string | null {
    return this.domainId;
  }

  clearCredentials(): void {
    this.ngrokToken = null;
    this.credentialId = null;
    this.domainId = null;
    this.domain = null;
  }

  getTunnelUrl(): string | null {
    return this.baseUrl;
  }

  getServerTunnelUrl(serverId: string): string | null {
    if (!this.baseUrl) {
      return null;
    }
    return `${this.baseUrl}/api/mcp/adapter-http/${serverId}`;
  }

  hasTunnel(): boolean {
    return this.baseUrl !== null;
  }

  async closeAll(): Promise<void> {
    if (this.listener) {
      await this.closeTunnel();
    }
  }
}

export const tunnelManager = new TunnelManager();
