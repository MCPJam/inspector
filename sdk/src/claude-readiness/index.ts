/**
 * Claude directory readiness — a composite readiness product, not a fifth
 * scored MCP conformance suite.
 *
 * Everything exported here is pure data or pure data reasoning: no MCP client,
 * no transport, no Node built-ins, so the whole module is safe from the
 * browser entry. The runner and the checks that dial a target live in sibling
 * modules that are NOT re-exported from here.
 */

export {
  CLAUDE_READINESS_LANES,
  CLAUDE_FINDING_CLASSES,
  CLAUDE_EVIDENCE_PROVENANCE,
  CLAUDE_INTRUSIVENESS_LEVELS,
  CLAUDE_RUNNER_CAPABILITIES,
  CLAUDE_REQUIRED_LANES,
  decideLaneStatus,
  rollUpLaneStatus,
  summarizeLaneCoverage,
  CLAUDE_READINESS_ENGINE_VERSION,
} from "./types.js";
export type {
  ClaudeCapabilityBadge,
  ClaudeEvidenceProvenance,
  ClaudeFindingClass,
  ClaudeFindingStatus,
  ClaudeIntrusiveness,
  ClaudeLaneCoverage,
  ClaudeLaneStatus,
  ClaudeReadinessAuthMode,
  ClaudeReadinessFinding,
  ClaudeReadinessLane,
  ClaudeReadinessLaneResult,
  ClaudeReadinessResult,
  ClaudeReadinessRunContext,
  ClaudeRunnerCapability,
} from "./types.js";

export {
  CLAUDE_DOCS_BASE_URL,
  CLAUDE_POLICY_MANIFEST,
  CLAUDE_POLICY_PAGES,
  CLAUDE_POLICY_SNAPSHOT_DATE,
  claudePolicySource,
  isPolicyCorpusVerified,
} from "./manifest.js";
export type {
  ClaudePolicyPage,
  ClaudePolicySourceEntry,
  ClaudePolicySourceRef,
} from "./manifest.js";

export {
  claudeAppContentDomain,
  claudeAppResourceEvidenceFrom,
  claudeAppToolEvidenceFrom,
  runClaudeAppsChecks,
} from "./checks/apps.js";
export type {
  ClaudeAppResourceEvidence,
  ClaudeAppToolEvidence,
  ClaudeAppsEvidence,
} from "./checks/apps.js";
export {
  canonicalResourceIndicator,
  runClaudeAuthChecks,
} from "./checks/auth.js";
export type {
  ClaudeAuthEvidence,
  ClaudeAuthCheckOutput,
  ClaudePrmDiscoveryStep,
} from "./checks/auth.js";
export { runClaudeOptionalFeatureChecks } from "./checks/optional-features.js";
export type {
  ClaudeOptionalFeatureEvidence,
  ClaudeOptionalFeatureOutput,
} from "./checks/optional-features.js";
export {
  CLAUDE_SUBMISSION_PROFILE_INPUT,
  runClaudeSubmissionChecks,
} from "./checks/submission.js";
export type { ClaudeSubmissionEvidence } from "./checks/submission.js";
export { runClaudeToolChecks } from "./checks/tools.js";
export { runClaudeEndpointChecks } from "./checks/endpoint.js";
export type {
  ClaudeEndpointEvidence,
  ClaudeRedirectHop,
} from "./checks/endpoint.js";
export {
  derivedFrom,
  informational,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
} from "./checks/helpers.js";
export type {
  ClaudeCheckDefinition,
  ClaudeCheckStamp,
} from "./checks/helpers.js";

export {
  CLAUDE_ATTESTATIONS,
  CLAUDE_DATA_HANDLING_MODES,
  CLAUDE_DECLARED_AUTH_MODES,
  claudeSubmissionProfileSchema,
  parseClaudeSubmissionProfile,
} from "./submission-profile.js";
export type {
  ClaudeAttestation,
  ClaudeDataHandlingMode,
  ClaudeDeclaredAuthMode,
  ClaudeSubmissionProfile,
  ClaudeSubmissionProfileParse,
} from "./submission-profile.js";

export {
  CLAUDE_APP_CONTENT_DOMAIN_HASH_LENGTH,
  CLAUDE_APP_CONTENT_DOMAIN_SUFFIX,
  CLAUDE_APP_DESIGN_BUDGETS,
  CLAUDE_APP_HTML_MIME,
  CLAUDE_CALLBACK_URLS,
  CLAUDE_HOST_PROFILE,
  CLAUDE_LATENCY_BUDGETS,
  CLAUDE_LOOPBACK_REDIRECT_IGNORES_PORT,
  CLAUDE_SUBMISSION_LIMITS,
} from "./profile.js";
