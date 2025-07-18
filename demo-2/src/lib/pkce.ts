/**
 * PKCE (Proof Key for Code Exchange) Implementation
 * Implements RFC 7636 for OAuth 2.1 security
 */

import { PKCEParams, PKCE_METHODS } from './oauth-types';

/**
 * Generates a cryptographically secure random string
 * Uses the same character set as specified in RFC 7636
 */
function generateRandomString(length: number): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  
  return Array.from(array, byte => charset[byte % charset.length]).join('');
}

/**
 * Generates a SHA256 hash and returns base64url encoded result
 */
async function sha256(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  
  // Convert to base64url
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generates PKCE parameters for OAuth 2.1 authorization
 * 
 * @param method - The code challenge method ('S256' recommended, 'plain' for testing only)
 * @returns Promise with PKCE parameters
 */
export async function generatePKCEParams(
  method: 'S256' | 'plain' = PKCE_METHODS.S256
): Promise<PKCEParams> {
  // Generate code verifier (43-128 characters, RFC 7636 recommends 43+)
  const codeVerifier = generateRandomString(128);
  
  let codeChallenge: string;
  
  if (method === PKCE_METHODS.S256) {
    // S256: BASE64URL(SHA256(code_verifier))
    codeChallenge = await sha256(codeVerifier);
  } else {
    // Plain: code_challenge = code_verifier
    codeChallenge = codeVerifier;
  }
  
  return {
    code_verifier: codeVerifier,
    code_challenge: codeChallenge,
    code_challenge_method: method
  };
}

/**
 * Validates PKCE parameters
 */
export function validatePKCEParams(params: PKCEParams): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Validate code verifier
  if (!params.code_verifier) {
    errors.push('Missing code_verifier');
  } else {
    // RFC 7636: code verifier must be 43-128 characters
    if (params.code_verifier.length < 43 || params.code_verifier.length > 128) {
      errors.push('code_verifier must be 43-128 characters long');
    }
    
    // Validate character set: [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
    const validChars = /^[A-Za-z0-9\-._~]+$/;
    if (!validChars.test(params.code_verifier)) {
      errors.push('code_verifier contains invalid characters');
    }
  }
  
  // Validate code challenge
  if (!params.code_challenge) {
    errors.push('Missing code_challenge');
  }
  
  // Validate code challenge method
  if (!params.code_challenge_method) {
    errors.push('Missing code_challenge_method');
  } else if (!['S256', 'plain'].includes(params.code_challenge_method)) {
    errors.push('Invalid code_challenge_method (must be S256 or plain)');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Verifies a PKCE code challenge against a code verifier
 * Used by authorization servers to validate the PKCE flow
 */
export async function verifyPKCEChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method: 'S256' | 'plain'
): Promise<boolean> {
  try {
    let expectedChallenge: string;
    
    if (method === PKCE_METHODS.S256) {
      expectedChallenge = await sha256(codeVerifier);
    } else {
      expectedChallenge = codeVerifier;
    }
    
    // Constant-time comparison to prevent timing attacks
    return constantTimeEquals(expectedChallenge, codeChallenge);
  } catch (error) {
    console.error('PKCE verification error:', error);
    return false;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Generates state parameter for OAuth authorization request
 * Prevents CSRF attacks
 */
export function generateState(): string {
  return generateRandomString(32);
}

/**
 * Generates nonce parameter for OpenID Connect
 */
export function generateNonce(): string {
  return generateRandomString(32);
}

/**
 * Validates OAuth state parameter
 */
export function validateState(state: string): boolean {
  if (!state) return false;
  
  // State should be a random string (typically 32+ characters)
  if (state.length < 8) return false;
  
  // Basic character validation
  const validChars = /^[A-Za-z0-9\-._~]+$/;
  return validChars.test(state);
}

/**
 * Creates a PKCE-enabled authorization URL
 */
export function createAuthorizationUrl(
  authorizationEndpoint: string,
  clientId: string,
  redirectUri: string,
  pkceParams: PKCEParams,
  options: {
    scope?: string;
    state?: string;
    resource?: string | string[];
    additionalParams?: Record<string, string>;
  } = {}
): string {
  const { scope, state, resource, additionalParams = {} } = options;
  
  const url = new URL(authorizationEndpoint);
  const params = new URLSearchParams();
  
  // Required parameters
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('code_challenge', pkceParams.code_challenge);
  params.set('code_challenge_method', pkceParams.code_challenge_method);
  
  // Optional parameters
  if (redirectUri) params.set('redirect_uri', redirectUri);
  if (scope) params.set('scope', scope);
  if (state) params.set('state', state);
  
  // Resource indicators (RFC 8707)
  if (resource) {
    if (Array.isArray(resource)) {
      resource.forEach(r => params.append('resource', r));
    } else {
      params.set('resource', resource);
    }
  }
  
  // Additional parameters
  Object.entries(additionalParams).forEach(([key, value]) => {
    params.set(key, value);
  });
  
  url.search = params.toString();
  return url.toString();
}

/**
 * Parses authorization callback URL and extracts parameters
 */
export function parseAuthorizationCallback(
  callbackUrl: string
): {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
} {
  try {
    const url = new URL(callbackUrl);
    
    return {
      code: url.searchParams.get('code') || undefined,
      state: url.searchParams.get('state') || undefined,
      error: url.searchParams.get('error') || undefined,
      error_description: url.searchParams.get('error_description') || undefined,
      error_uri: url.searchParams.get('error_uri') || undefined,
    };
  } catch (error) {
    throw new Error(`Invalid callback URL: ${callbackUrl}`);
  }
}

/**
 * Securely stores PKCE parameters (in memory with timeout)
 * Use this to temporarily store PKCE params during the OAuth flow
 */
export class PKCEStorage {
  private storage = new Map<string, { params: PKCEParams; expires: number }>();
  private readonly TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  
  /**
   * Stores PKCE parameters with a unique key
   */
  store(key: string, params: PKCEParams): void {
    this.cleanup(); // Remove expired entries
    
    this.storage.set(key, {
      params,
      expires: Date.now() + this.TIMEOUT_MS
    });
  }
  
  /**
   * Retrieves and removes PKCE parameters
   */
  retrieve(key: string): PKCEParams | null {
    this.cleanup(); // Remove expired entries
    
    const entry = this.storage.get(key);
    if (!entry) return null;
    
    // Remove after retrieval (one-time use)
    this.storage.delete(key);
    
    return entry.params;
  }
  
  /**
   * Checks if PKCE parameters exist for a key
   */
  has(key: string): boolean {
    this.cleanup();
    return this.storage.has(key);
  }
  
  /**
   * Removes expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.storage.entries()) {
      if (entry.expires < now) {
        this.storage.delete(key);
      }
    }
  }
  
  /**
   * Clears all stored PKCE parameters
   */
  clear(): void {
    this.storage.clear();
  }
}

// Export a default instance for convenience
export const pkceStorage = new PKCEStorage();