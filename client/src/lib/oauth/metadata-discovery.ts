/**
 * OAuth Authorization Server Metadata Discovery
 * Supports both OAuth 2.0 (RFC8414) and OpenID Connect Discovery 1.0
 */

import { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

export type DiscoveryType = "oauth2" | "oidc";

export interface DiscoveryResult {
  metadata: OAuthMetadata;
  endpoint: string;
  type: DiscoveryType;
}

interface DiscoveryEndpoint {
  url: string;
  type: DiscoveryType;
}

/**
 * Service for discovering OAuth/OIDC authorization server metadata
 * Implements the multi-endpoint discovery strategy from the 2025-11-25 spec
 */
export class MetadataDiscoveryService {
  /**
   * Discovers authorization server metadata with OIDC fallback
   *
   * Per 2025-11-25 spec:
   * - For URLs with paths: tries OAuth path insertion, OIDC path insertion, OIDC path appending
   * - For URLs without paths: tries OAuth standard, OIDC standard
   *
   * @param authServerUrl The authorization server base URL
   * @returns Discovery result with metadata, endpoint used, and type
   * @throws Error if all discovery endpoints fail
   */
  async discoverMetadata(authServerUrl: URL): Promise<DiscoveryResult> {
    const endpoints = this.buildDiscoveryEndpoints(authServerUrl);

    const errors: Array<{ endpoint: string; error: string }> = [];

    for (const { url, type } of endpoints) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          errors.push({
            endpoint: url,
            error: `HTTP ${response.status}: ${response.statusText}`,
          });
          continue;
        }

        const contentType = response.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
          errors.push({
            endpoint: url,
            error: `Invalid content-type: ${contentType}`,
          });
          continue;
        }

        const metadata = await response.json();

        // Validate required fields
        const validationError = this.validateMetadata(metadata);
        if (validationError) {
          errors.push({
            endpoint: url,
            error: validationError,
          });
          continue;
        }

        // Success! Return the discovered metadata
        return {
          metadata: metadata as OAuthMetadata,
          endpoint: url,
          type,
        };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        errors.push({
          endpoint: url,
          error: errorMessage,
        });
        continue;
      }
    }

    // All endpoints failed - provide detailed error
    const errorDetails = errors
      .map(({ endpoint, error }) => `  • ${endpoint}\n    ${error}`)
      .join("\n");

    throw new Error(
      `Failed to discover authorization server metadata.\n\n` +
        `Tried ${errors.length} endpoint(s):\n${errorDetails}\n\n` +
        `Please verify the authorization server URL is correct.`,
    );
  }

  /**
   * Builds discovery endpoint URLs based on 2025-11-25 spec priority order
   *
   * For issuer URLs with path components (e.g., https://auth.example.com/tenant1):
   * 1. OAuth 2.0 with path insertion: https://auth.example.com/.well-known/oauth-authorization-server/tenant1
   * 2. OIDC with path insertion: https://auth.example.com/.well-known/openid-configuration/tenant1
   * 3. OIDC path appending: https://auth.example.com/tenant1/.well-known/openid-configuration
   *
   * For issuer URLs without path (e.g., https://auth.example.com):
   * 1. OAuth 2.0: https://auth.example.com/.well-known/oauth-authorization-server
   * 2. OIDC: https://auth.example.com/.well-known/openid-configuration
   */
  private buildDiscoveryEndpoints(authServerUrl: URL): DiscoveryEndpoint[] {
    const hasPath = authServerUrl.pathname && authServerUrl.pathname !== "/";
    const origin = authServerUrl.origin;
    const path = authServerUrl.pathname;

    if (hasPath) {
      // Per 2025-11-25 spec: try path insertion first, then path appending
      return [
        // OAuth 2.0 Authorization Server Metadata with path insertion
        {
          url: `${origin}/.well-known/oauth-authorization-server${path}`,
          type: "oauth2" as const,
        },
        // OpenID Connect Discovery with path insertion
        {
          url: `${origin}/.well-known/openid-configuration${path}`,
          type: "oidc" as const,
        },
        // OpenID Connect Discovery with path appending
        {
          url: `${authServerUrl}/.well-known/openid-configuration`,
          type: "oidc" as const,
        },
      ];
    }

    // No path: standard endpoints
    return [
      // OAuth 2.0 Authorization Server Metadata
      {
        url: `${authServerUrl}/.well-known/oauth-authorization-server`,
        type: "oauth2" as const,
      },
      // OpenID Connect Discovery
      {
        url: `${authServerUrl}/.well-known/openid-configuration`,
        type: "oidc" as const,
      },
    ];
  }

  /**
   * Validates that metadata contains required OAuth 2.0/OIDC fields
   */
  private validateMetadata(metadata: any): string | null {
    if (!metadata.authorization_endpoint) {
      return "Missing required field: authorization_endpoint";
    }

    if (!metadata.token_endpoint) {
      return "Missing required field: token_endpoint";
    }

    // Issuer should be present (required for OIDC, recommended for OAuth)
    if (!metadata.issuer) {
      console.warn("Metadata missing recommended field: issuer");
    }

    return null;
  }

  /**
   * Checks if metadata indicates PKCE support
   */
  isPkceSupported(metadata: OAuthMetadata): boolean {
    const methods = (metadata as any).code_challenge_methods_supported;
    return Array.isArray(methods) && methods.length > 0;
  }

  /**
   * Checks if metadata indicates Client ID Metadata Documents support
   */
  supportsClientIdMetadata(metadata: OAuthMetadata): boolean {
    return (metadata as any).client_id_metadata_document_supported === true;
  }

  /**
   * Gets supported PKCE methods, preferring S256
   */
  getPreferredPkceMethod(metadata: OAuthMetadata): string | null {
    const methods = (metadata as any).code_challenge_methods_supported;
    if (!Array.isArray(methods) || methods.length === 0) {
      return null;
    }

    // Per 2025-11-25 spec: MUST use S256 when technically capable
    if (methods.includes("S256")) {
      return "S256";
    }

    // Fallback to first available method
    return methods[0];
  }
}
