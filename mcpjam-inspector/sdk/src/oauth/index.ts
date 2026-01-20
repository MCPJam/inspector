/**
 * @mcpjam/sdk/oauth - OAuth helpers for MCP server authentication
 *
 * MCP servers require OAuth 2.1 authentication per the MCP Authorization spec.
 * This module provides auth providers for both interactive and programmatic flows.
 *
 * @example Programmatic auth (CI/CD)
 * ```typescript
 * import { MCPClientManager } from "@mcpjam/sdk";
 * import { createTokenAuthProvider } from "@mcpjam/sdk/oauth";
 *
 * const manager = new MCPClientManager({
 *   asana: {
 *     url: new URL("https://mcp.asana.com/sse"),
 *     authProvider: createTokenAuthProvider({
 *       accessToken: process.env.ASANA_ACCESS_TOKEN,
 *       refreshToken: process.env.ASANA_REFRESH_TOKEN,
 *       onTokenRefresh: (tokens) => {
 *         // Persist new tokens for next run
 *         console.log("Tokens refreshed:", tokens);
 *       }
 *     })
 *   }
 * });
 * ```
 *
 * @example Interactive auth (development)
 * ```typescript
 * import { MCPClientManager } from "@mcpjam/sdk";
 * import { createInteractiveOAuthProvider } from "@mcpjam/sdk/oauth";
 * import open from "open";
 *
 * const manager = new MCPClientManager({
 *   asana: {
 *     url: new URL("https://mcp.asana.com/sse"),
 *     authProvider: createInteractiveOAuthProvider({
 *       onRedirect: (url) => open(url),
 *     })
 *   }
 * });
 * ```
 */

// Export all types
export type {
  // Token types
  OAuthTokens,
  OnTokenRefreshCallback,

  // Provider configuration
  TokenAuthProviderOptions,
  InteractiveAuthProviderOptions,

  // OAuth metadata
  OAuthMetadata,

  // Provider interface
  AuthProvider,

  // Results
  TokenRefreshResult,
} from "./types.js";

// Placeholder exports for functions that will be implemented in Phase 1
// These are commented out until implementation:
// export { createTokenAuthProvider } from "./token-auth-provider.js";
// export { createInteractiveOAuthProvider } from "./interactive-auth-provider.js";
