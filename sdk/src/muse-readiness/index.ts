/**
 * Muse directory readiness — a composite readiness product for Meta's Muse
 * connector platform, not a scored MCP conformance suite.
 *
 * Everything exported here is pure data or pure data reasoning: no MCP
 * client, no transport, no Node built-ins. The gatherer, which dials, lives in
 * `gather.ts` and is exported only from the Node entry.
 */

export {
  MUSE_READINESS_ENGINE_VERSION,
  MUSE_READINESS_LANES,
  MUSE_READINESS_STAGES,
  MUSE_RUNNER_CAPABILITIES,
  MUSE_STAGE_LANES,
  isDispositiveMuseFinding,
  rollUpMuseStage,
} from "./types.js";
export type {
  MuseLaneCoverage,
  MuseLaneStatus,
  MuseReadinessFinding,
  MuseReadinessLane,
  MuseReadinessLaneResult,
  MuseReadinessResult,
  MuseReadinessRunContext,
  MuseReadinessStage,
  MuseRunnerCapability,
} from "./types.js";

export {
  MUSE_PLATFORM_BASE_URL,
  MUSE_POLICY_MANIFEST,
  MUSE_POLICY_PAGES,
  MUSE_POLICY_SNAPSHOT_DATE,
  isMusePolicyCorpusVerified,
  musePolicySource,
} from "./manifest.js";
export type {
  MusePolicyPage,
  MusePolicySourceEntry,
  MusePolicySourceRef,
} from "./manifest.js";

export {
  MUSE_ATTESTATIONS,
  MUSE_AUTH_METHODS,
  MUSE_CREDENTIAL_ENVIRONMENTS,
  MUSE_DOCUMENTATION_TOPICS,
  MUSE_TOOL_CLASSES,
} from "./profile.js";
export type {
  MuseAttestation,
  MuseAuthMethod,
  MuseCredentialEnvironment,
  MuseDocumentationTopic,
  MuseToolClass,
} from "./profile.js";

export {
  museSubmissionProfileSchema,
  parseMuseSubmissionProfile,
} from "./submission-profile.js";
export type {
  MuseSubmissionProfile,
  MuseSubmissionProfileParse,
} from "./submission-profile.js";

export {
  buildMuseClassificationSheet,
  formatMuseClassificationSheet,
  suggestMuseToolClass,
} from "./classification.js";
export type {
  MuseClassificationBasis,
  MuseClassificationRow,
  MuseToolEvidence,
} from "./classification.js";

export { MUSE_READINESS_INPUTS, gradeMuseReadiness } from "./runner.js";
export type { MuseReadinessInput } from "./runner.js";

export { runMuseEndpointChecks } from "./checks/endpoint.js";
export type { MuseEndpointEvidence } from "./checks/endpoint.js";
export { runMuseToolChecks } from "./checks/tools.js";
export type {
  MuseToolCheckOutput,
  MuseToolListingCompleteness,
} from "./checks/tools.js";
export { runMuseSubmissionChecks } from "./checks/submission.js";
export type { MuseSubmissionEvidence } from "./checks/submission.js";
export type { MuseCheckDefinition, MuseCheckStamp } from "./checks/helpers.js";
