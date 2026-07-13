// Browser-safe XAA flow-core types + capability preflight, moved from the
// inspector client so the CLI and the UI can share one engine. `XaaRegistration
// Strategy` (xaa/constants.ts) and `JWT_BEARER_GRANT` (oauth/client-identity.ts)
// are intentionally omitted here — they have canonical homes already exported
// from the SDK entries, so re-exporting them would duplicate.
export type {
  XAAFlowStep,
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
} from "./types.js";
export {
  EMPTY_XAA_FLOW_STATE,
  createInitialXAAFlowState,
} from "./types.js";
export type {
  XAAVendor,
  XAAVendorVerdict,
  XAAVendorHint,
  XAACheckStatus,
  XAACompatibilityCheck,
  XAACompatibilityVerdict,
  XAACompatibilityReport,
} from "./capability-preflight.js";
export {
  detectVendor,
  analyzeAsCompatibility,
  deriveCapabilityEvidence,
  selectTokenEndpointAuthMethod,
} from "./capability-preflight.js";
export {
  createXAAStateMachine,
  CLIENT_SECRET_MASK,
} from "./state-machine.js";
export { runXaaStateMachine } from "./runner.js";
export type {
  RunXaaStateMachineOptions,
  XaaStateMachineRunResult,
} from "./runner.js";
