/**
 * OAuth State Machine Facade
 *
 * This file provides backward compatibility by re-exporting from the
 * protocol-specific state machine implementations.
 *
 * For new code, prefer importing from:
 * - `./oauth/state-machines/factory` for version-aware creation
 * - `./oauth/state-machines/types` for shared types
 * - `./oauth/state-machines/debug-oauth-2025-06-18` for 2025-06-18 specific
 * - `./oauth/state-machines/debug-oauth-2025-11-25` for 2025-11-25 specific
 */

// Re-export types for backward compatibility
export type {
  OAuthFlowStep,
  OAuthFlowState,
  OAuthStateMachine,
  OAuthProtocolVersion,
  RegistrationStrategy2025_06_18,
  RegistrationStrategy2025_11_25,
} from "./oauth/state-machines/types";

export { EMPTY_OAUTH_FLOW_STATE } from "./oauth/state-machines/types";

// Legacy type aliases
export type { OauthFlowStateJune2025 } from "./oauth/state-machines/debug-oauth-2025-06-18";
export type { DebugOAuthStateMachine } from "./oauth/state-machines/debug-oauth-2025-06-18";

// Legacy state export
export { EMPTY_OAUTH_FLOW_STATE_V2 } from "./oauth/state-machines/debug-oauth-2025-06-18";

// Re-export factory and utilities
export {
  createOAuthStateMachine,
  getDefaultRegistrationStrategy,
  getSupportedRegistrationStrategies,
  PROTOCOL_VERSION_INFO,
  type OAuthStateMachineFactoryConfig,
} from "./oauth/state-machines/factory";

// Re-export individual state machine creators for advanced use cases
export { createDebugOAuthStateMachine as createDebugOAuthStateMachine_2025_06_18 } from "./oauth/state-machines/debug-oauth-2025-06-18";
export { createDebugOAuthStateMachine as createDebugOAuthStateMachine_2025_11_25 } from "./oauth/state-machines/debug-oauth-2025-11-25";

// Backward compatible default export (2025-11-25)
// For legacy code that imports the default state machine
import { createDebugOAuthStateMachine as create2025_11_25 } from "./oauth/state-machines/debug-oauth-2025-11-25";
export const createDebugOAuthStateMachine = create2025_11_25;

// Configuration type for backward compatibility
export type { DebugOAuthStateMachineConfig } from "./oauth/state-machines/debug-oauth-2025-11-25";

/**
 * @deprecated Use createOAuthStateMachine from factory instead for protocol version selection
 *
 * @example
 * ```typescript
 * // Old way (still works, defaults to 2025-11-25)
 * const machine = createDebugOAuthStateMachine(config);
 *
 * // New way (recommended - explicit protocol version)
 * const machine = createOAuthStateMachine({
 *   protocolVersion: "2025-11-25",
 *   ...config
 * });
 * ```
 */
export const createLegacyStateMachine = create2025_11_25;
