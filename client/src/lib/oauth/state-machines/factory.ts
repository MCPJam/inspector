/**
 * Factory for creating protocol-specific OAuth state machines
 *
 * This factory selects the appropriate state machine implementation
 * based on the protocol version specified in the configuration.
 */

import type {
  OAuthStateMachine,
  OAuthProtocolVersion,
  BaseOAuthStateMachineConfig,
  RegistrationStrategy2025_03_26,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "./types";

import {
  createDebugOAuthStateMachine as create2025_03_26,
  type DebugOAuthStateMachineConfig as Config2025_03_26,
} from "./debug-oauth-2025-03-26";

import {
  createDebugOAuthStateMachine as create2025_06_18,
  type DebugOAuthStateMachineConfig as Config2025_06_18,
} from "./debug-oauth-2025-06-18";

import {
  createDebugOAuthStateMachine as create2025_11_25,
  type DebugOAuthStateMachineConfig as Config2025_11_25,
} from "./debug-oauth-2025-11-25";

/**
 * Configuration for creating an OAuth state machine with protocol version selection
 */
export interface OAuthStateMachineFactoryConfig
  extends BaseOAuthStateMachineConfig {
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy:
    | RegistrationStrategy2025_03_26
    | RegistrationStrategy2025_06_18
    | RegistrationStrategy2025_11_25;
}

/**
 * Creates an OAuth state machine based on the specified protocol version
 *
 * @param config - Configuration including protocol version and registration strategy
 * @returns An OAuth state machine implementation for the specified protocol version
 *
 * @example
 * ```typescript
 * // Create a 2025-11-25 state machine with CIMD
 * const machine = createOAuthStateMachine({
 *   protocolVersion: "2025-11-25",
 *   registrationStrategy: "cimd",
 *   serverUrl: "https://mcp.example.com",
 *   serverName: "Example MCP Server",
 *   state: EMPTY_OAUTH_FLOW_STATE,
 *   updateState: (updates) => setState(updates),
 * });
 *
 * // Create a 2025-06-18 state machine with DCR
 * const legacyMachine = createOAuthStateMachine({
 *   protocolVersion: "2025-06-18",
 *   registrationStrategy: "dcr",
 *   serverUrl: "https://mcp.example.com",
 *   serverName: "Legacy MCP Server",
 *   state: EMPTY_OAUTH_FLOW_STATE,
 *   updateState: (updates) => setState(updates),
 * });
 * ```
 */
export function createOAuthStateMachine(
  config: OAuthStateMachineFactoryConfig,
): OAuthStateMachine {
  const { protocolVersion, ...baseConfig } = config;

  switch (protocolVersion) {
    case "2025-03-26":
      // Validate registration strategy for 2025-03-26
      if (config.registrationStrategy === "cimd") {
        throw new Error(
          "CIMD registration is not supported in 2025-03-26 protocol. " +
            "Use 'dcr' or 'preregistered' instead.",
        );
      }
      return create2025_03_26(baseConfig as Config2025_03_26);

    case "2025-06-18":
      // Validate registration strategy for 2025-06-18
      if (config.registrationStrategy === "cimd") {
        throw new Error(
          "CIMD registration is not supported in 2025-06-18 protocol. " +
            "Use 'dcr' or 'preregistered' instead.",
        );
      }
      return create2025_06_18(baseConfig as Config2025_06_18);

    case "2025-11-25":
      // All registration strategies are valid for 2025-11-25
      return create2025_11_25(baseConfig as Config2025_11_25);

    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = protocolVersion;
      throw new Error(`Unknown protocol version: ${_exhaustive}`);
  }
}

/**
 * Gets the default registration strategy for a given protocol version
 */
export function getDefaultRegistrationStrategy(
  protocolVersion: OAuthProtocolVersion,
): string {
  switch (protocolVersion) {
    case "2025-03-26":
      return "dcr";
    case "2025-06-18":
      return "dcr";
    case "2025-11-25":
      return "cimd";
    default:
      return "dcr";
  }
}

/**
 * Gets the supported registration strategies for a given protocol version
 */
export function getSupportedRegistrationStrategies(
  protocolVersion: OAuthProtocolVersion,
): ReadonlyArray<string> {
  switch (protocolVersion) {
    case "2025-03-26":
      return ["dcr", "preregistered"] as const;
    case "2025-06-18":
      return ["dcr", "preregistered"] as const;
    case "2025-11-25":
      return ["cimd", "dcr", "preregistered"] as const;
    default:
      return ["dcr", "preregistered"] as const;
  }
}

/**
 * Protocol version metadata for UI display
 */
export const PROTOCOL_VERSION_INFO = {
  "2025-03-26": {
    label: "2025-03-26 (Legacy)",
    description: "Original MCP OAuth specification with direct discovery",
    features: [
      "Dynamic Client Registration (DCR) SHOULD be supported",
      "Direct RFC8414 discovery from MCP server base URL",
      "Fallback to default endpoints (/authorize, /token, /register)",
      "PKCE is REQUIRED for all clients",
      "No Protected Resource Metadata (RFC9728)",
    ],
  },
  "2025-06-18": {
    label: "2025-06-18",
    description: "Current MCP OAuth specification with resource metadata",
    features: [
      "Dynamic Client Registration (DCR) SHOULD be supported",
      "Protected Resource Metadata (RFC9728) required",
      "RFC8414 discovery ONLY (no OIDC) with root fallback",
      "PKCE recommended but not strictly enforced",
    ],
  },
  "2025-11-25": {
    label: "2025-11-25 (Latest)",
    description: "Proposed MCP OAuth specification with CIMD support",
    features: [
      "Client ID Metadata Documents (CIMD) SHOULD be supported",
      "Protected Resource Metadata (RFC9728) required",
      "RFC8414 OR OIDC discovery without root fallback",
      "PKCE strictly required and enforced",
      "Enhanced security with URL-based client IDs",
    ],
  },
} as const;
