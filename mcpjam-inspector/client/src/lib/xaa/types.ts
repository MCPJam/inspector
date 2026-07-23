// XAA flow-core types moved to @mcpjam/sdk (browser-safe). Re-exported here so
// existing `@/lib/xaa/types` importers keep their path.
export type {
  XAAFlowStep,
  RegistrationStrategy,
  XaaTokenEndpointAuthMethod,
  XaaRegistrationWarningCode,
  XaaRegistrationWarning,
  XaaEphemeralDcrCredentials,
  XaaDcrCredentialCache,
  XAAJWTInspectionIssue,
  XAADecodedJwt,
  XAAInfoLogEntry,
  XAAHttpHistoryEntry,
  XAAFlowState,
  XAARequestResult,
  XAARequestExecutor,
  BaseXAAStateMachineConfig,
  XAAStateMachine,
  XAACompatibilityReport,
} from "@mcpjam/sdk/browser";
export {
  EMPTY_XAA_FLOW_STATE,
  buildXaaDcrCredentialCacheKey,
  createInitialXAAFlowState,
  isXaaDcrClientSecretExpired,
} from "@mcpjam/sdk/browser";
