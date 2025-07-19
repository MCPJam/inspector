/**
 * OAuth Discovery Implementation
 * Handles RFC 8414 Authorization Server Discovery and RFC 9728 Protected Resource Metadata
 */

import { 
  AuthorizationServerMetadata, 
  ProtectedResourceMetadata, 
  WELL_KNOWN_PATHS,
  MCP_OAUTH_ERRORS,
  OAuthError 
} from './oauth-types';

export interface DiscoveryOptions {
  timeout?: number;
  follow_redirects?: boolean;
  max_redirects?: number;
  validate_tls?: boolean;
}

export interface DiscoveryResult {
  authorization_server_metadata?: AuthorizationServerMetadata;
  protected_resource_metadata?: ProtectedResourceMetadata;
  discovery_url: string;
  discovered_at: number;
  error?: OAuthError;
}

/**
 * Discovers OAuth authorization server metadata
 * Implements RFC 8414 discovery
 */
export async function discoverAuthorizationServer(
  serverUrl: string, 
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const { timeout = 10000, follow_redirects = true, max_redirects = 5 } = options;
  
  try {
    const url = new URL(serverUrl);
    
    // Try multiple discovery endpoints in order of preference
    const discoveryUrls = [
      // MCP-specific OAuth discovery
      new URL(WELL_KNOWN_PATHS.MCP_OAUTH, url.origin).toString(),
      // Standard OAuth authorization server discovery
      new URL(WELL_KNOWN_PATHS.AUTHORIZATION_SERVER, url.origin).toString(),
      // Try with path prefix if original URL has a path
      ...(url.pathname !== '/' ? [
        new URL(url.pathname + WELL_KNOWN_PATHS.MCP_OAUTH, url.origin).toString(),
        new URL(url.pathname + WELL_KNOWN_PATHS.AUTHORIZATION_SERVER, url.origin).toString()
      ] : [])
    ];

    for (const discoveryUrl of discoveryUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(discoveryUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'MCP-Inspector/1.0'
          },
          signal: controller.signal,
          redirect: follow_redirects ? 'follow' : 'manual'
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const metadata = await response.json() as AuthorizationServerMetadata;
          
          // Validate required fields
          if (!metadata.issuer || !metadata.response_types_supported) {
            continue; // Try next URL
          }

          // Validate issuer matches the expected format
          const issuerUrl = new URL(metadata.issuer);
          if (issuerUrl.origin !== url.origin) {
            throw new Error(`Issuer ${metadata.issuer} does not match server origin ${url.origin}`);
          }

          return {
            authorization_server_metadata: metadata,
            discovery_url: discoveryUrl,
            discovered_at: Date.now()
          };
        }
      } catch (error) {
        // Continue to next URL on error
        console.debug(`Discovery failed for ${discoveryUrl}:`, error);
        continue;
      }
    }

    // If we get here, all discovery attempts failed
    return {
      discovery_url: discoveryUrls[0],
      discovered_at: Date.now(),
      error: {
        error: MCP_OAUTH_ERRORS.DISCOVERY_FAILED,
        error_description: 'Authorization server metadata not found at any well-known endpoint'
      }
    };

  } catch (error) {
    return {
      discovery_url: serverUrl,
      discovered_at: Date.now(),
      error: {
        error: MCP_OAUTH_ERRORS.DISCOVERY_FAILED,
        error_description: error instanceof Error ? error.message : 'Unknown discovery error'
      }
    };
  }
}

/**
 * Discovers protected resource metadata
 * Implements RFC 9728 discovery
 */
export async function discoverProtectedResource(
  resourceUrl: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const { timeout = 10000, follow_redirects = true } = options;
  
  try {
    const url = new URL(resourceUrl);
    
    // Try protected resource discovery endpoints
    const discoveryUrls = [
      // MCP-specific discovery first
      new URL(WELL_KNOWN_PATHS.MCP_OAUTH, url.origin).toString(),
      // Standard protected resource discovery
      new URL(WELL_KNOWN_PATHS.PROTECTED_RESOURCE, url.origin).toString(),
      // Try with path prefix if original URL has a path
      ...(url.pathname !== '/' ? [
        new URL(url.pathname + WELL_KNOWN_PATHS.MCP_OAUTH, url.origin).toString(),
        new URL(url.pathname + WELL_KNOWN_PATHS.PROTECTED_RESOURCE, url.origin).toString()
      ] : [])
    ];

    for (const discoveryUrl of discoveryUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(discoveryUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'MCP-Inspector/1.0'
          },
          signal: controller.signal,
          redirect: follow_redirects ? 'follow' : 'manual'
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const metadata = await response.json() as ProtectedResourceMetadata;
          
          // Validate required fields
          if (!metadata.resource_server) {
            continue; // Try next URL
          }

          return {
            protected_resource_metadata: metadata,
            discovery_url: discoveryUrl,
            discovered_at: Date.now()
          };
        }
      } catch (error) {
        // Continue to next URL on error
        console.debug(`Protected resource discovery failed for ${discoveryUrl}:`, error);
        continue;
      }
    }

    // If we get here, all discovery attempts failed
    return {
      discovery_url: discoveryUrls[0],
      discovered_at: Date.now(),
      error: {
        error: MCP_OAUTH_ERRORS.DISCOVERY_FAILED,
        error_description: 'Protected resource metadata not found at any well-known endpoint'
      }
    };

  } catch (error) {
    return {
      discovery_url: resourceUrl,
      discovered_at: Date.now(),
      error: {
        error: MCP_OAUTH_ERRORS.DISCOVERY_FAILED,
        error_description: error instanceof Error ? error.message : 'Unknown discovery error'
      }
    };
  }
}

/**
 * Performs full OAuth discovery for MCP server
 * Discovers both authorization server and protected resource metadata
 */
export async function discoverMCPOAuth(
  serverUrl: string,
  options: DiscoveryOptions = {}
): Promise<{
  authorization_server?: DiscoveryResult;
  protected_resource?: DiscoveryResult;
  error?: OAuthError;
}> {
  try {
    // Try to discover both in parallel
    const [authServerResult, protectedResourceResult] = await Promise.allSettled([
      discoverAuthorizationServer(serverUrl, options),
      discoverProtectedResource(serverUrl, options)
    ]);

    const authServer = authServerResult.status === 'fulfilled' ? authServerResult.value : undefined;
    const protectedResource = protectedResourceResult.status === 'fulfilled' ? protectedResourceResult.value : undefined;

    // Check if we got at least one successful discovery
    if (authServer?.authorization_server_metadata || protectedResource?.protected_resource_metadata) {
      return {
        authorization_server: authServer,
        protected_resource: protectedResource
      };
    }

    // Both failed
    return {
      authorization_server: authServer,
      protected_resource: protectedResource,
      error: {
        error: MCP_OAUTH_ERRORS.DISCOVERY_FAILED,
        error_description: 'Failed to discover OAuth metadata for MCP server'
      }
    };

  } catch (error) {
    return {
      error: {
        error: MCP_OAUTH_ERRORS.DISCOVERY_FAILED,
        error_description: error instanceof Error ? error.message : 'Unknown discovery error'
      }
    };
  }
}

/**
 * Validates authorization server metadata
 */
export function validateAuthorizationServerMetadata(
  metadata: AuthorizationServerMetadata
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!metadata.issuer) {
    errors.push('Missing required field: issuer');
  }

  if (!metadata.response_types_supported || metadata.response_types_supported.length === 0) {
    errors.push('Missing required field: response_types_supported');
  }

  // Validate URLs
  const urlFields = [
    'issuer', 'authorization_endpoint', 'token_endpoint', 
    'userinfo_endpoint', 'jwks_uri', 'registration_endpoint'
  ];

  for (const field of urlFields) {
    const value = metadata[field as keyof AuthorizationServerMetadata];
    if (value && typeof value === 'string') {
      try {
        new URL(value);
      } catch {
        errors.push(`Invalid URL in field: ${field}`);
      }
    }
  }

  // Validate issuer is HTTPS (except localhost for development)
  if (metadata.issuer) {
    try {
      const issuerUrl = new URL(metadata.issuer);
      if (issuerUrl.protocol !== 'https:' && issuerUrl.hostname !== 'localhost') {
        errors.push('Issuer must use HTTPS (except localhost)');
      }
    } catch {
      errors.push('Invalid issuer URL format');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates protected resource metadata
 */
export function validateProtectedResourceMetadata(
  metadata: ProtectedResourceMetadata
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!metadata.resource_server) {
    errors.push('Missing required field: resource_server');
  }

  // Validate URLs
  const urlFields = ['jwks_uri', 'resource_documentation', 'resource_policy_uri', 'resource_tos_uri'];

  for (const field of urlFields) {
    const value = metadata[field as keyof ProtectedResourceMetadata];
    if (value && typeof value === 'string') {
      try {
        new URL(value);
      } catch {
        errors.push(`Invalid URL in field: ${field}`);
      }
    }
  }

  // Validate authorization servers are valid URLs
  if (metadata.authorization_servers) {
    for (const authServer of metadata.authorization_servers) {
      try {
        new URL(authServer);
      } catch {
        errors.push(`Invalid authorization server URL: ${authServer}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Checks if the server supports MCP OAuth extensions
 */
export function supportsMCPOAuth(
  authServerMetadata?: AuthorizationServerMetadata,
  protectedResourceMetadata?: ProtectedResourceMetadata
): boolean {
  return !!(
    authServerMetadata?.mcp_version || 
    authServerMetadata?.mcp_capabilities ||
    protectedResourceMetadata?.mcp_version ||
    protectedResourceMetadata?.mcp_capabilities
  );
}

/**
 * Gets the MCP capabilities from discovered metadata
 */
export function getMCPCapabilities(
  authServerMetadata?: AuthorizationServerMetadata,
  protectedResourceMetadata?: ProtectedResourceMetadata
): {
  version?: string;
  capabilities?: string[];
  tools?: string[];
  resources?: string[];
  prompts?: string[];
} {
  return {
    version: authServerMetadata?.mcp_version || protectedResourceMetadata?.mcp_version,
    capabilities: [
      ...(authServerMetadata?.mcp_capabilities || []),
      ...(protectedResourceMetadata?.mcp_capabilities || [])
    ],
    tools: protectedResourceMetadata?.mcp_tools || [],
    resources: protectedResourceMetadata?.mcp_resources || [],
    prompts: protectedResourceMetadata?.mcp_prompts || []
  };
}