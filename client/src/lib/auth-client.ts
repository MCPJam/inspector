import { OAuthTokens } from "./auth-types";

export class SimpleOAuthClient {
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  // Get stored tokens from localStorage
  getStoredTokens(): OAuthTokens | null {
    try {
      const stored = localStorage.getItem(`oauth-tokens-${this.serverUrl}`);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error("Failed to parse stored tokens:", error);
      return null;
    }
  }

  // Save tokens to localStorage
  saveTokens(tokens: OAuthTokens): void {
    localStorage.setItem(`oauth-tokens-${this.serverUrl}`, JSON.stringify(tokens));
  }

  // Clear stored tokens
  clearTokens(): void {
    localStorage.removeItem(`oauth-tokens-${this.serverUrl}`);
  }

  // Quick refresh using existing tokens (simplified for now)
  async quickRefresh(): Promise<OAuthTokens> {
    const existingTokens = this.getStoredTokens();
    
    if (!existingTokens) {
      throw new Error("No existing tokens found for refresh");
    }

    if (!existingTokens.refresh_token) {
      throw new Error("No refresh token available");
    }

    // For now, simulate a refresh by returning the existing tokens
    // In a real implementation, this would make an API call to refresh the tokens
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API call
    
    // Simulate updated tokens
    const refreshedTokens: OAuthTokens = {
      ...existingTokens,
      access_token: `refreshed_${Date.now()}`,
      expires_in: 3600,
    };

    this.saveTokens(refreshedTokens);
    return refreshedTokens;
  }

  // Simulate initial OAuth flow (simplified)
  async initiateOAuth(): Promise<OAuthTokens> {
    if (!this.serverUrl) {
      throw new Error("Server URL is required");
    }

    // Simulate OAuth flow
    await new Promise(resolve => setTimeout(resolve, 2000));

    const tokens: OAuthTokens = {
      access_token: `token_${Date.now()}`,
      refresh_token: `refresh_${Date.now()}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp:*",
    };

    this.saveTokens(tokens);
    return tokens;
  }
}
