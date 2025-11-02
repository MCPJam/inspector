/**
 * OAuth Client Registration Service
 * Supports three registration methods:
 * 1. Client ID Metadata Documents (CIMD) - 2025-11-25 spec
 * 2. Dynamic Client Registration (DCR) - RFC7591
 * 3. Pre-registered client credentials
 */

import {
  OAuthMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import { MCPJAM_CLIENT_ID, getRedirectUri } from "./constants";
import type { DebugMCPOAuthClientProvider } from "../debug-oauth-provider";

export type RegistrationMethod =
  | "client_id_metadata"
  | "dynamic"
  | "pre_registered";

export type ProtocolVersion = "2025-06-18" | "2025-11-25";

export interface RegistrationResult {
  clientInfo: OAuthClientInformationFull | OAuthClientInformation;
  method: RegistrationMethod;
}

/**
 * Manages OAuth client registration using multiple strategies
 */
export class ClientRegistrationService {
  /**
   * Attempts client registration using available methods based on protocol version
   *
   * 2025-11-25 priority: CIMD > Pre-registered > DCR
   * 2025-06-18 priority: DCR > Pre-registered
   *
   * @param serverUrl The MCP server URL
   * @param metadata The authorization server metadata
   * @param protocolVersion Which protocol version to follow
   * @param provider The OAuth provider for storing credentials
   */
  async registerClient(
    serverUrl: string,
    metadata: OAuthMetadata,
    protocolVersion: ProtocolVersion,
    provider: DebugMCPOAuthClientProvider,
  ): Promise<RegistrationResult> {
    if (protocolVersion === "2025-11-25") {
      return this.registerClient_2025_11_25(serverUrl, metadata, provider);
    } else {
      return this.registerClient_2025_06_18(serverUrl, metadata, provider);
    }
  }

  /**
   * 2025-11-25 protocol registration flow
   * Priority: CIMD (SHOULD) > Pre-registered > DCR (MAY)
   */
  private async registerClient_2025_11_25(
    serverUrl: string,
    metadata: OAuthMetadata,
    provider: DebugMCPOAuthClientProvider,
  ): Promise<RegistrationResult> {
    const errors: string[] = [];

    // 1. Try Client ID Metadata Documents (preferred in 2025-11-25)
    if (this.supportsClientIdMetadata(metadata)) {
      try {
        const result = await this.useClientIdMetadata();
        provider.saveClientInformation(result.clientInfo);
        return result;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        errors.push(`CIMD failed: ${errorMsg}`);
        console.warn("CIMD registration failed, trying fallback:", e);
      }
    } else {
      errors.push(
        "CIMD not supported (client_id_metadata_document_supported not true)",
      );
    }

    // 2. Try pre-registered client
    const preRegistered = await provider.clientInformation();
    if (preRegistered) {
      return {
        clientInfo: preRegistered,
        method: "pre_registered",
      };
    }
    errors.push("No pre-registered client found");

    // 3. Fall back to DCR (MAY support in 2025-11-25)
    if (metadata.registration_endpoint) {
      try {
        return await this.useDynamicRegistration(serverUrl, metadata, provider);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        errors.push(`DCR failed: ${errorMsg}`);
      }
    } else {
      errors.push("DCR not supported (no registration_endpoint)");
    }

    // All methods failed
    throw new Error(
      `No supported registration method available.\n\n` +
        `Attempted methods:\n${errors.map((e) => `  • ${e}`).join("\n")}\n\n` +
        `The authorization server must support at least one registration method.`,
    );
  }

  /**
   * 2025-06-18 protocol registration flow
   * Priority: DCR (SHOULD) > Pre-registered
   */
  private async registerClient_2025_06_18(
    serverUrl: string,
    metadata: OAuthMetadata,
    provider: DebugMCPOAuthClientProvider,
  ): Promise<RegistrationResult> {
    const errors: string[] = [];

    // 1. Try DCR (SHOULD support in 2025-06-18)
    if (metadata.registration_endpoint) {
      try {
        return await this.useDynamicRegistration(serverUrl, metadata, provider);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        errors.push(`DCR failed: ${errorMsg}`);
        console.warn("DCR failed, trying pre-registered:", e);
      }
    } else {
      errors.push("DCR not supported (no registration_endpoint)");
    }

    // 2. Fall back to pre-registered
    const preRegistered = await provider.clientInformation();
    if (preRegistered) {
      return {
        clientInfo: preRegistered,
        method: "pre_registered",
      };
    }
    errors.push("No pre-registered client found");

    // All methods failed
    throw new Error(
      `No supported registration method available.\n\n` +
        `Attempted methods:\n${errors.map((e) => `  • ${e}`).join("\n")}\n\n` +
        `The authorization server must support at least one registration method.`,
    );
  }

  /**
   * Use Client ID Metadata Documents (2025-11-25 spec)
   * The client_id is an HTTPS URL that points to the metadata document
   */
  private async useClientIdMetadata(): Promise<RegistrationResult> {
    // First, validate that our CIMD is accessible
    await this.validateClientMetadata();

    // Use the URL as client_id - the auth server will fetch it during authorization
    const clientInfo: OAuthClientInformation = {
      client_id: MCPJAM_CLIENT_ID,
      // No client_secret for public client using CIMD
    };

    return {
      clientInfo,
      method: "client_id_metadata",
    };
  }

  /**
   * Validates that the CIMD endpoint is accessible and properly formatted
   */
  private async validateClientMetadata(): Promise<void> {
    try {
      const response = await fetch(MCPJAM_CLIENT_ID, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `CIMD endpoint returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const metadata = await response.json();

      // Validate per draft-parecki-oauth-client-id-metadata-document-03
      if (metadata.client_id !== MCPJAM_CLIENT_ID) {
        throw new Error(
          `CIMD client_id mismatch: expected ${MCPJAM_CLIENT_ID}, got ${metadata.client_id}`,
        );
      }

      if (
        !Array.isArray(metadata.redirect_uris) ||
        metadata.redirect_uris.length === 0
      ) {
        throw new Error("CIMD missing or invalid redirect_uris array");
      }

      if (!metadata.client_name) {
        throw new Error("CIMD missing required field: client_name");
      }

      // Verify our redirect URI is in the list
      const ourRedirectUri = getRedirectUri();
      if (!metadata.redirect_uris.includes(ourRedirectUri)) {
        console.warn(
          `Current redirect URI (${ourRedirectUri}) not found in CIMD document.\n` +
            `Available redirect URIs:\n${metadata.redirect_uris.map((u: string) => `  • ${u}`).join("\n")}`,
        );
      }
    } catch (e) {
      if (e instanceof Error) {
        throw new Error(`CIMD validation failed: ${e.message}`);
      }
      throw new Error(`CIMD validation failed: ${String(e)}`);
    }
  }

  /**
   * Use Dynamic Client Registration (RFC7591)
   */
  private async useDynamicRegistration(
    serverUrl: string,
    metadata: OAuthMetadata,
    provider: DebugMCPOAuthClientProvider,
  ): Promise<RegistrationResult> {
    try {
      // Prepare client metadata for registration
      const clientMetadata = { ...provider.clientMetadata } as any;

      // Include scopes if advertised by the server
      const scopesSupported = (metadata as any).scopes_supported;
      if (scopesSupported && scopesSupported.length > 0) {
        clientMetadata.scope = scopesSupported.join(" ");
      }

      const clientInfo = await registerClient(serverUrl, {
        metadata,
        clientMetadata,
      });

      provider.saveClientInformation(clientInfo);

      return {
        clientInfo,
        method: "dynamic",
      };
    } catch (e) {
      if (e instanceof Error) {
        throw new Error(`Dynamic client registration failed: ${e.message}`);
      }
      throw new Error(`Dynamic client registration failed: ${String(e)}`);
    }
  }

  /**
   * Check if authorization server supports Client ID Metadata Documents
   */
  private supportsClientIdMetadata(metadata: OAuthMetadata): boolean {
    return (metadata as any).client_id_metadata_document_supported === true;
  }
}
