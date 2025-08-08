import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformation,
  OAuthTokens,
  OAuthClientMetadata,
  OAuthMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Debug OAuth provider that uses sessionStorage and debug redirect URLs
 * Based on the inspector's DebugInspectorOAuthClientProvider
 */
export class DebugMCPOAuthClientProvider implements OAuthClientProvider {
  constructor(protected serverUrl: string) {
    // Save the server URL to session storage
    sessionStorage.setItem("debug-oauth-server-url", serverUrl);
  }

  get redirectUrl(): string {
    // For debugging, we can also try using a simpler redirect URL
    // or fall back to a localhost URL if the current origin has issues
    const origin = window.location.origin;

    return `${origin}/oauth/callback/debug`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "MCPJam",
      client_uri: "https://github.com/mcpjam/inspector",
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const key = `debug-client-info-${this.serverUrl}`;
    const stored = sessionStorage.getItem(key);
    if (!stored) {
      return undefined;
    }
    return JSON.parse(stored);
  }

  saveClientInformation(clientInformation: OAuthClientInformation): void {
    const key = `debug-client-info-${this.serverUrl}`;
    sessionStorage.setItem(key, JSON.stringify(clientInformation));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const key = `debug-tokens-${this.serverUrl}`;
    const tokens = sessionStorage.getItem(key);
    if (!tokens) {
      return undefined;
    }
    return JSON.parse(tokens);
  }

  saveTokens(tokens: OAuthTokens): void {
    const key = `debug-tokens-${this.serverUrl}`;
    sessionStorage.setItem(key, JSON.stringify(tokens));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // For debugging, we'll show the URL instead of redirecting

    // In a real debug environment, we might want to copy to clipboard or show in UI
  }

  saveCodeVerifier(codeVerifier: string): void {
    const key = `debug-verifier-${this.serverUrl}`;
    sessionStorage.setItem(key, codeVerifier);
  }

  codeVerifier(): string {
    const key = `debug-verifier-${this.serverUrl}`;
    const verifier = sessionStorage.getItem(key);
    if (!verifier) {
      throw new Error("No code verifier saved for debug session");
    }
    return verifier;
  }

  // Debug-specific method to save server metadata
  saveServerMetadata(metadata: OAuthMetadata): void {
    const key = `debug-server-metadata-${this.serverUrl}`;
    sessionStorage.setItem(key, JSON.stringify(metadata));
  }

  getServerMetadata(): OAuthMetadata | null {
    const key = `debug-server-metadata-${this.serverUrl}`;
    const metadata = sessionStorage.getItem(key);
    if (!metadata) {
      return null;
    }
    return JSON.parse(metadata);
  }

  clear(): void {
    const keys = [
      `debug-client-info-${this.serverUrl}`,
      `debug-tokens-${this.serverUrl}`,
      `debug-verifier-${this.serverUrl}`,
      `debug-server-metadata-${this.serverUrl}`,
    ];
    
    keys.forEach(key => sessionStorage.removeItem(key));
  }
}
