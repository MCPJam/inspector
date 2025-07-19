/**
 * OAuth Security and Token Management
 * Handles secure storage, validation, and lifecycle management of OAuth tokens
 */

import { OAuthClientState, TokenResponse, OAuthError } from './oauth-types';

export interface SecureTokenStorage {
  store(key: string, tokens: TokenResponse): Promise<void>;
  retrieve(key: string): Promise<TokenResponse | null>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  isExpired(key: string): Promise<boolean>;
}

/**
 * Browser-based secure token storage using sessionStorage with encryption
 * Note: This is a simplified implementation. In production, consider using:
 * - Secure HTTP-only cookies for token storage
 * - Server-side session management
 * - Hardware security modules (HSM) for key material
 */
export class BrowserTokenStorage implements SecureTokenStorage {
  private readonly storagePrefix = 'mcp-oauth-tokens:';
  private readonly encryptionKey: string;

  constructor(encryptionKey?: string) {
    // In production, derive this from user authentication or use a proper key derivation function
    this.encryptionKey = encryptionKey || this.generateEncryptionKey();
  }

  async store(key: string, tokens: TokenResponse): Promise<void> {
    try {
      const data = {
        ...tokens,
        stored_at: Date.now(),
        expires_at: tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : undefined
      };

      const encrypted = await this.encrypt(JSON.stringify(data));
      sessionStorage.setItem(this.storagePrefix + key, encrypted);
    } catch (error) {
      console.error('Failed to store OAuth tokens:', error);
      throw new Error('Token storage failed');
    }
  }

  async retrieve(key: string): Promise<TokenResponse | null> {
    try {
      const encrypted = sessionStorage.getItem(this.storagePrefix + key);
      if (!encrypted) return null;

      const decrypted = await this.decrypt(encrypted);
      const data = JSON.parse(decrypted);

      // Check if token is expired
      if (data.expires_at && Date.now() > data.expires_at) {
        await this.remove(key);
        return null;
      }

      return data as TokenResponse;
    } catch (error) {
      console.error('Failed to retrieve OAuth tokens:', error);
      await this.remove(key); // Remove corrupted data
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    sessionStorage.removeItem(this.storagePrefix + key);
  }

  async clear(): Promise<void> {
    const keys = Object.keys(sessionStorage);
    keys.forEach(key => {
      if (key.startsWith(this.storagePrefix)) {
        sessionStorage.removeItem(key);
      }
    });
  }

  async isExpired(key: string): Promise<boolean> {
    const tokens = await this.retrieve(key);
    return tokens === null;
  }

  private generateEncryptionKey(): string {
    // Generate a simple key from browser fingerprint + session
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('MCP Inspector Fingerprint', 2, 2);
    
    const fingerprint = canvas.toDataURL();
    const sessionId = sessionStorage.getItem('mcp-session-id') || Math.random().toString(36);
    sessionStorage.setItem('mcp-session-id', sessionId);
    
    // Simple hash function (not cryptographically secure - use proper crypto in production)
    let hash = 0;
    const combined = fingerprint + sessionId;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return Math.abs(hash).toString(36);
  }

  private async encrypt(data: string): Promise<string> {
    // Simple XOR encryption (not secure - use Web Crypto API in production)
    const key = this.encryptionKey;
    let result = '';
    
    for (let i = 0; i < data.length; i++) {
      const keyChar = key.charCodeAt(i % key.length);
      const dataChar = data.charCodeAt(i);
      result += String.fromCharCode(dataChar ^ keyChar);
    }
    
    return btoa(result);
  }

  private async decrypt(encryptedData: string): Promise<string> {
    // Simple XOR decryption
    const data = atob(encryptedData);
    const key = this.encryptionKey;
    let result = '';
    
    for (let i = 0; i < data.length; i++) {
      const keyChar = key.charCodeAt(i % key.length);
      const dataChar = data.charCodeAt(i);
      result += String.fromCharCode(dataChar ^ keyChar);
    }
    
    return result;
  }
}

/**
 * OAuth Token Manager
 * Handles token lifecycle, refresh, and validation
 */
export class OAuthTokenManager {
  private storage: SecureTokenStorage;
  private refreshThresholdMinutes: number;

  constructor(storage?: SecureTokenStorage, refreshThresholdMinutes = 5) {
    this.storage = storage || new BrowserTokenStorage();
    this.refreshThresholdMinutes = refreshThresholdMinutes;
  }

  /**
   * Stores OAuth tokens securely
   */
  async storeTokens(serverName: string, tokens: TokenResponse): Promise<void> {
    await this.storage.store(serverName, tokens);
  }

  /**
   * Retrieves valid OAuth tokens, refreshing if necessary
   */
  async getValidTokens(
    serverName: string,
    refreshCallback?: (refreshToken: string) => Promise<TokenResponse>
  ): Promise<TokenResponse | null> {
    const tokens = await this.storage.retrieve(serverName);
    if (!tokens) return null;

    // Check if token needs refresh
    if (this.shouldRefreshToken(tokens) && tokens.refresh_token && refreshCallback) {
      try {
        const newTokens = await refreshCallback(tokens.refresh_token);
        await this.storeTokens(serverName, newTokens);
        return newTokens;
      } catch (error) {
        console.error('Token refresh failed:', error);
        await this.removeTokens(serverName);
        return null;
      }
    }

    return tokens;
  }

  /**
   * Removes stored tokens
   */
  async removeTokens(serverName: string): Promise<void> {
    await this.storage.remove(serverName);
  }

  /**
   * Clears all stored tokens
   */
  async clearAllTokens(): Promise<void> {
    await this.storage.clear();
  }

  /**
   * Checks if a token should be refreshed
   */
  private shouldRefreshToken(tokens: TokenResponse): boolean {
    if (!tokens.expires_in) return false;

    const storedAt = (tokens as any).stored_at || Date.now();
    const expiresAt = storedAt + (tokens.expires_in * 1000);
    const refreshThreshold = this.refreshThresholdMinutes * 60 * 1000;

    return (expiresAt - Date.now()) < refreshThreshold;
  }
}

/**
 * OAuth Security Validator
 * Validates OAuth configurations and prevents common security issues
 */
export class OAuthSecurityValidator {
  /**
   * Validates OAuth configuration for security issues
   */
  static validateOAuthConfig(config: {
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    redirectUri?: string;
    scopes?: string[];
    useHTTPS?: boolean;
  }): { valid: boolean; warnings: string[]; errors: string[] } {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Validate HTTPS usage
    if (config.authorizationEndpoint) {
      const authUrl = new URL(config.authorizationEndpoint);
      if (authUrl.protocol !== 'https:' && authUrl.hostname !== 'localhost') {
        errors.push('Authorization endpoint must use HTTPS (except localhost for development)');
      }
    }

    if (config.tokenEndpoint) {
      const tokenUrl = new URL(config.tokenEndpoint);
      if (tokenUrl.protocol !== 'https:' && tokenUrl.hostname !== 'localhost') {
        errors.push('Token endpoint must use HTTPS (except localhost for development)');
      }
    }

    // Validate redirect URI
    if (config.redirectUri) {
      const redirectUrl = new URL(config.redirectUri);
      
      // Check for secure redirect URI
      if (redirectUrl.protocol !== 'https:' && redirectUrl.hostname !== 'localhost') {
        warnings.push('Redirect URI should use HTTPS in production');
      }

      // Check for wildcard or overly broad redirect URIs
      if (redirectUrl.pathname.includes('*') || redirectUrl.search.includes('*')) {
        errors.push('Redirect URI must not contain wildcards');
      }
    }

    // Validate scopes
    if (config.scopes) {
      const suspiciousScopes = ['admin', 'root', 'superuser', '*:*'];
      const foundSuspicious = config.scopes.filter(scope => 
        suspiciousScopes.some(suspicious => scope.includes(suspicious))
      );
      
      if (foundSuspicious.length > 0) {
        warnings.push(`Requesting broad scopes: ${foundSuspicious.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors
    };
  }

  /**
   * Validates OAuth state parameter to prevent CSRF attacks
   */
  static validateStateParameter(
    expectedState: string,
    receivedState: string
  ): boolean {
    if (!expectedState || !receivedState) return false;
    
    // Constant-time comparison to prevent timing attacks
    if (expectedState.length !== receivedState.length) return false;
    
    let result = 0;
    for (let i = 0; i < expectedState.length; i++) {
      result |= expectedState.charCodeAt(i) ^ receivedState.charCodeAt(i);
    }
    
    return result === 0;
  }

  /**
   * Sanitizes OAuth error messages to prevent information disclosure
   */
  static sanitizeOAuthError(error: OAuthError): OAuthError {
    const sanitizedError = { ...error };
    
    // Remove potentially sensitive information from error descriptions
    if (sanitizedError.error_description) {
      sanitizedError.error_description = sanitizedError.error_description
        .replace(/client_secret=[^&\s]+/gi, 'client_secret=[REDACTED]')
        .replace(/password=[^&\s]+/gi, 'password=[REDACTED]')
        .replace(/token=[^&\s]+/gi, 'token=[REDACTED]');
    }
    
    return sanitizedError;
  }
}

/**
 * OAuth Session Manager
 * Manages OAuth sessions and prevents session fixation attacks
 */
export class OAuthSessionManager {
  private sessions = new Map<string, {
    serverName: string;
    state: string;
    codeVerifier: string;
    createdAt: number;
    expiresAt: number;
  }>();

  private readonly SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes

  /**
   * Creates a new OAuth session
   */
  createSession(
    sessionId: string,
    serverName: string,
    state: string,
    codeVerifier: string
  ): void {
    const now = Date.now();
    
    this.sessions.set(sessionId, {
      serverName,
      state,
      codeVerifier,
      createdAt: now,
      expiresAt: now + this.SESSION_TIMEOUT
    });

    // Clean up expired sessions
    this.cleanupExpiredSessions();
  }

  /**
   * Validates and retrieves an OAuth session
   */
  validateSession(
    sessionId: string,
    state: string
  ): { valid: boolean; session?: any } {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return { valid: false };
    }

    // Check if session is expired
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return { valid: false };
    }

    // Validate state parameter
    if (!OAuthSecurityValidator.validateStateParameter(session.state, state)) {
      return { valid: false };
    }

    return { valid: true, session };
  }

  /**
   * Removes an OAuth session
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Cleans up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

// Export default instances for convenience
export const tokenManager = new OAuthTokenManager();
export const sessionManager = new OAuthSessionManager();