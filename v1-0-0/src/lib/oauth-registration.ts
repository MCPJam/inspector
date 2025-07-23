import {
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  AuthorizationServerMetadata,
  OAuthError,
  MCP_OAUTH_ERRORS,
  GRANT_TYPES,
  RESPONSE_TYPES,
  TOKEN_ENDPOINT_AUTH_METHODS,
  OAUTH_SCOPES,
} from "./oauth-types";
import { getOAuthCallbackUrl, getBaseUrl } from "./url-utils";

export interface RegistrationOptions {
  timeout?: number;
  client_name?: string;
  client_description?: string;
  redirect_uris?: string[];
  scopes?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  mcp_capabilities?: {
    tools?: string[];
    resources?: string[];
    prompts?: string[];
  };
}

export interface RegistrationResult {
  success: boolean;
  client_registration?: ClientRegistrationResponse;
  error?: OAuthError;
  registered_at?: number;
}

/**
 * Registers a new OAuth client with the authorization server
 */
export async function registerOAuthClient(
  authServerMetadata: AuthorizationServerMetadata,
  options: RegistrationOptions = {},
): Promise<RegistrationResult> {
  const {
    timeout = 30000,
    client_name = "MCP Inspector",
    client_description = "MCP Inspector OAuth Client",
    redirect_uris = [getOAuthCallbackUrl()],
    scopes = [OAUTH_SCOPES.MCP_FULL],
    grant_types = [GRANT_TYPES.AUTHORIZATION_CODE, GRANT_TYPES.REFRESH_TOKEN],
    response_types = [RESPONSE_TYPES.CODE],
    token_endpoint_auth_method = TOKEN_ENDPOINT_AUTH_METHODS.NONE,
    mcp_capabilities = {},
  } = options;

  // Check if registration is supported
  if (!authServerMetadata.registration_endpoint) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          "Authorization server does not support dynamic client registration",
      },
    };
  }

  try {
    // Build registration request
    const registrationRequest: ClientRegistrationRequest = {
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      scope: scopes.join(" "),
      // MCP-specific fields
      mcp_version: "1.0",
      mcp_client_name: client_name,
      mcp_client_description: client_description,
    };

    // Add optional fields
    if (mcp_capabilities.tools?.length) {
      registrationRequest.software_id = "mcp-inspector";
      registrationRequest.software_version = "1.0.0";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(authServerMetadata.registration_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MCP-Inspector/1.0",
      },
      body: JSON.stringify(registrationRequest),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const clientRegistration =
        (await response.json()) as ClientRegistrationResponse;

      const validation = validateClientRegistrationResponse(clientRegistration);
      if (!validation.valid) {
        console.warn(
          "OAuth registration validation issues:",
          validation.errors,
        );
        console.warn("Registration response data:", clientRegistration);

        // Only fail if client_id is missing (critical error)
        const criticalErrors = validation.errors.filter(
          (error) =>
            error.includes("client_id") ||
            error.includes("Missing required field"),
        );

        if (criticalErrors.length > 0) {
          return {
            success: false,
            error: {
              error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
              error_description: `Critical registration error: ${criticalErrors.join(", ")}`,
            },
          };
        }

        // For non-critical errors, proceed but log warnings
        console.warn(
          "Proceeding with registration despite validation warnings",
        );
      }

      return {
        success: true,
        client_registration: clientRegistration,
        registered_at: Date.now(),
      };
    } else {
      // Parse error response
      let errorResponse: OAuthError;
      try {
        errorResponse = (await response.json()) as OAuthError;
      } catch {
        errorResponse = {
          error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
          error_description: `Registration failed with status ${response.status}`,
        };
      }

      return {
        success: false,
        error: errorResponse,
      };
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        success: false,
        error: {
          error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
          error_description: "Registration request timed out",
        },
      };
    }

    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          error instanceof Error ? error.message : "Unknown registration error",
      },
    };
  }
}

/**
 * Updates an existing OAuth client registration
 */
export async function updateOAuthClient(
  clientRegistration: ClientRegistrationResponse,
  updates: Partial<ClientRegistrationRequest>,
  options: { timeout?: number } = {},
): Promise<RegistrationResult> {
  const { timeout = 30000 } = options;

  if (
    !clientRegistration.registration_client_uri ||
    !clientRegistration.registration_access_token
  ) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          "Client registration does not support updates (missing registration URI or access token)",
      },
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(clientRegistration.registration_client_uri, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${clientRegistration.registration_access_token}`,
        "User-Agent": "MCP-Inspector/1.0",
      },
      body: JSON.stringify({
        ...extractRegistrationRequest(clientRegistration),
        ...updates,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const updatedRegistration =
        (await response.json()) as ClientRegistrationResponse;

      return {
        success: true,
        client_registration: updatedRegistration,
        registered_at: Date.now(),
      };
    } else {
      let errorResponse: OAuthError;
      try {
        errorResponse = (await response.json()) as OAuthError;
      } catch {
        errorResponse = {
          error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
          error_description: `Update failed with status ${response.status}`,
        };
      }

      return {
        success: false,
        error: errorResponse,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          error instanceof Error ? error.message : "Unknown update error",
      },
    };
  }
}

/**
 * Reads current client registration from the authorization server
 */
export async function readOAuthClient(
  clientRegistration: ClientRegistrationResponse,
  options: { timeout?: number } = {},
): Promise<RegistrationResult> {
  const { timeout = 30000 } = options;

  if (
    !clientRegistration.registration_client_uri ||
    !clientRegistration.registration_access_token
  ) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          "Client registration does not support reading (missing registration URI or access token)",
      },
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(clientRegistration.registration_client_uri, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${clientRegistration.registration_access_token}`,
        "User-Agent": "MCP-Inspector/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const currentRegistration =
        (await response.json()) as ClientRegistrationResponse;

      return {
        success: true,
        client_registration: currentRegistration,
      };
    } else {
      let errorResponse: OAuthError;
      try {
        errorResponse = (await response.json()) as OAuthError;
      } catch {
        errorResponse = {
          error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
          error_description: `Read failed with status ${response.status}`,
        };
      }

      return {
        success: false,
        error: errorResponse,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          error instanceof Error ? error.message : "Unknown read error",
      },
    };
  }
}

/**
 * Deletes a client registration from the authorization server
 */
export async function deleteOAuthClient(
  clientRegistration: ClientRegistrationResponse,
  options: { timeout?: number } = {},
): Promise<{ success: boolean; error?: OAuthError }> {
  const { timeout = 30000 } = options;

  if (
    !clientRegistration.registration_client_uri ||
    !clientRegistration.registration_access_token
  ) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          "Client registration does not support deletion (missing registration URI or access token)",
      },
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(clientRegistration.registration_client_uri, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${clientRegistration.registration_access_token}`,
        "User-Agent": "MCP-Inspector/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok || response.status === 204) {
      return { success: true };
    } else {
      let errorResponse: OAuthError;
      try {
        errorResponse = (await response.json()) as OAuthError;
      } catch {
        errorResponse = {
          error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
          error_description: `Delete failed with status ${response.status}`,
        };
      }

      return {
        success: false,
        error: errorResponse,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          error instanceof Error ? error.message : "Unknown delete error",
      },
    };
  }
}

/**
 * Validates a client registration response
 */
export function validateClientRegistrationResponse(
  response: ClientRegistrationResponse,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!response.client_id) {
    errors.push("Missing required field: client_id");
  }

  // Validate URLs if present - be lenient for testing servers
  const urlFields = [
    "client_uri",
    "logo_uri",
    "tos_uri",
    "policy_uri",
    "jwks_uri",
    "registration_client_uri",
  ];

  for (const field of urlFields) {
    const value = response[field as keyof ClientRegistrationResponse];
    if (value && typeof value === "string" && value.trim() !== "") {
      try {
        // Allow relative URLs for registration_client_uri as some servers may return them
        if (
          field === "registration_client_uri" &&
          (value.startsWith("/") || value.startsWith("."))
        ) {
          // Relative URL - this is acceptable
          continue;
        }

        // Try to parse as URL
        new URL(value);
      } catch {
        // Be more lenient - only warn about invalid URLs, don't fail validation
        console.warn(`Potentially invalid URL in field ${field}: ${value}`);

        // Check if it's a completely malformed URL or just non-standard
        if (value.includes("://") || value.startsWith("http")) {
          // Looks like it's trying to be a URL but malformed
          console.warn(
            `Malformed URL detected in ${field}, but continuing anyway`,
          );
        }

        // Don't add to errors - be permissive for testing
      }
    }
  }

  // Validate redirect URIs
  if (response.redirect_uris) {
    for (const uri of response.redirect_uris) {
      try {
        const url = new URL(uri);
        // Validate redirect URI scheme (should be http/https for web clients)
        if (!["http:", "https:"].includes(url.protocol)) {
          errors.push(`Invalid redirect URI scheme: ${uri}`);
        }
      } catch {
        errors.push(`Invalid redirect URI: ${uri}`);
      }
    }
  }

  // Validate timestamps
  if (response.client_id_issued_at && response.client_id_issued_at <= 0) {
    errors.push("Invalid client_id_issued_at timestamp");
  }

  if (
    response.client_secret_expires_at &&
    response.client_secret_expires_at <= 0
  ) {
    errors.push("Invalid client_secret_expires_at timestamp");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extracts registration request from registration response
 * Useful for updates
 */
function extractRegistrationRequest(
  response: ClientRegistrationResponse,
): ClientRegistrationRequest {
  return {
    redirect_uris: response.redirect_uris,
    token_endpoint_auth_method: response.token_endpoint_auth_method,
    grant_types: response.grant_types,
    response_types: response.response_types,
    client_name: response.client_name,
    client_uri: response.client_uri,
    logo_uri: response.logo_uri,
    scope: response.scope,
    contacts: response.contacts,
    tos_uri: response.tos_uri,
    policy_uri: response.policy_uri,
    jwks_uri: response.jwks_uri,
    jwks: response.jwks,
    software_id: response.software_id,
    software_version: response.software_version,
  };
}

/**
 * Checks if client secret will expire soon
 */
export function isClientSecretExpiringSoon(
  clientRegistration: ClientRegistrationResponse,
  thresholdMinutes: number = 60,
): boolean {
  if (!clientRegistration.client_secret_expires_at) {
    return false; // Secret doesn't expire
  }

  const expiresAt = clientRegistration.client_secret_expires_at * 1000; // Convert to milliseconds
  const thresholdMs = thresholdMinutes * 60 * 1000;

  return expiresAt - Date.now() < thresholdMs;
}

/**
 * Generates default registration options for MCP Inspector
 */
export function getDefaultRegistrationOptions(
  baseUrl?: string,
): RegistrationOptions {
  const effectiveBaseUrl = baseUrl || getBaseUrl();
  return {
    client_name: "MCP Inspector",
    client_description:
      "Interactive MCP (Model Context Protocol) Server Inspector",
    redirect_uris: [`${effectiveBaseUrl}/oauth/callback`],
    scopes: [OAUTH_SCOPES.MCP_FULL],
    grant_types: [GRANT_TYPES.AUTHORIZATION_CODE, GRANT_TYPES.REFRESH_TOKEN],
    response_types: [RESPONSE_TYPES.CODE],
    token_endpoint_auth_method: TOKEN_ENDPOINT_AUTH_METHODS.NONE, // Use PKCE instead
    mcp_capabilities: {
      tools: ["*"],
      resources: ["*"],
      prompts: ["*"],
    },
  };
}
