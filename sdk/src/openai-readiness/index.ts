/**
 * OpenAI plugin-directory readiness — a local preflight, not a portal
 * simulator.
 *
 * Everything exported here is pure data or pure data reasoning: no MCP client,
 * no transport, no Node built-ins, so the whole module is safe from the browser
 * entry. The discovery half that dials a target lives in a sibling module that
 * is NOT re-exported from here.
 *
 * Deliberately does NOT re-export the shared `directory-readiness` algebra.
 * `decideLaneStatus` and friends belong to one module, and re-exporting them
 * from each publisher's barrel would make `sdk/src/index.ts` ambiguous about
 * which copy a caller gets.
 */

export {
  OPENAI_READINESS_ENGINE_VERSION,
  OPENAI_READINESS_INPUTS,
  OPENAI_READINESS_LANES,
  OPENAI_READINESS_STAGES,
  OPENAI_RUNNER_CAPABILITIES,
  OPENAI_STAGE_LANES,
  OPENAI_SUBMISSION_MODES,
  OPENAI_SUBMISSION_MODE_SHAPES,
  OPENAI_HEADLINE_STAGE,
  isLaneApplicableInMode,
  isOpenAIReadinessResult,
  stageLanesFor,
} from "./types.js";
export type {
  OpenAICapabilityBadge,
  OpenAILaneCoverage,
  OpenAILaneStatus,
  OpenAIReadinessAuthMode,
  OpenAIReadinessFinding,
  OpenAIReadinessInputName,
  OpenAIReadinessLane,
  OpenAIReadinessLaneResult,
  OpenAIReadinessResult,
  OpenAIReadinessRunContext,
  OpenAIReadinessStage,
  OpenAIReadinessStageResult,
  OpenAIRunnerCapability,
  OpenAISubmissionMode,
} from "./types.js";

export {
  OPENAI_EXTERNAL_POLICY_PAGES,
  OPENAI_PLUGINS_CHANGELOG_URL,
  OPENAI_PLUGINS_DOCS_BASE_URL,
  OPENAI_PLUGINS_LLMS_INDEX_URL,
  OPENAI_PLUGINS_POLICY_PAGES,
  OPENAI_POLICY_MANIFEST,
  OPENAI_POLICY_PAGES,
  OPENAI_POLICY_SNAPSHOT_DATE,
  isOpenAIPolicyCorpusVerified,
  openaiPolicySource,
} from "./manifest.js";
export type {
  OpenAIExternalPolicyPage,
  OpenAIPluginsPolicyPage,
  OpenAIPolicyPage,
  OpenAIPolicyPageFormat,
  OpenAIPolicySourceEntry,
  OpenAIPolicySourceRef,
} from "./manifest.js";

export {
  OPENAI_AGENT_METADATA_PATH,
  OPENAI_APP_HTML_MIME,
  OPENAI_ARCHIVE_LIMITS,
  OPENAI_BRAND_COLOR_CONTRAST,
  OPENAI_DOMAIN_VERIFICATION_PATH,
  OPENAI_EXPECTED_MCP_PATH,
  OPENAI_FIELD_LIMITS,
  OPENAI_HOST_PROFILE,
  OPENAI_IMAGE_CONSTRAINTS,
  OPENAI_LISTING_CATEGORIES,
  OPENAI_MANIFEST_LOCATIONS,
  OPENAI_MCP_SKILLS_EXTENSION,
  OPENAI_MCP_SKILLS_METHODS,
  OPENAI_MCP_SKILL_LIMITS,
  OPENAI_RELEASE_RULES,
  OPENAI_REQUIRED_TOOL_ANNOTATIONS,
  OPENAI_SKILL_METADATA_PATH,
  OPENAI_SUBMISSION_TEST_CASES,
} from "./profile.js";
export type { OpenAIListingCategory } from "./profile.js";

export {
  OPENAI_PORTAL_ERRORS,
  OPENAI_PORTAL_ERRORS_BY_ID,
  OPENAI_PORTAL_ERROR_CATEGORIES,
  groupPortalIssues,
  hasBlockingPortalIssue,
  openaiPortalIssue,
} from "./portal-errors.js";
export type {
  OpenAIPortalErrorCategory,
  OpenAIPortalErrorDefinition,
  OpenAIPortalErrorId,
  OpenAIPortalErrorSeverity,
  OpenAIPortalIssue,
} from "./portal-errors.js";

export {
  readImageDimensions,
  sniffImageMimeType,
} from "./package/image-dimensions.js";
export type {
  ImageDimensions,
  ImageDimensionsResult,
} from "./package/image-dimensions.js";

export {
  checkBrandColor,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
} from "./package/color.js";
export type { BrandColorCheck, RgbColor } from "./package/color.js";

export {
  findUnsupportedCharacters,
  hasSurroundingWhitespace,
  isSupportedText,
} from "./package/supported-text.js";
export type { UnsupportedCharacter } from "./package/supported-text.js";

export {
  crossCheckToolDependencies,
  parseOpenAIAgentMetadata,
} from "./package/openai-agent-metadata.js";
export type {
  OpenAIAgentInterface,
  OpenAIAgentMetadata,
  OpenAIAgentMetadataIssue,
  OpenAIAgentMetadataParse,
  OpenAIAgentPolicy,
  OpenAIAgentToolDependency,
} from "./package/openai-agent-metadata.js";

export { readOpenAIPluginPackage } from "./package/reader.js";
export type {
  OpenAIArchiveObservations,
  OpenAIManifestLocation,
  OpenAIPackageAsset,
  OpenAIPackageEntryStats,
  OpenAIPackageGap,
  OpenAIPackageManifest,
  OpenAIPackageSkill,
  OpenAIPackageSurface,
  OpenAIPluginPackageEvidence,
  ReadOpenAIPluginPackageOptions,
} from "./package/reader.js";

// The finding CONSTRUCTORS are deliberately absent.
//
// `satisfied`, `violated`, `notEvaluated`, `notApplicable` and `informational`
// are bound to this product's engine version, and the Claude barrel already
// publishes a set under those exact names. Exporting both from
// `sdk/src/index.ts` is ambiguous to TypeScript and worse than ambiguous to a
// reader: nothing at a call site would say which publisher's version a finding
// had been stamped with. They stay internal to the check modules, which is the
// only place they belong.
//
// The DEFINITION types are public, because a surface rendering a finding needs
// to name the shape it is rendering.
export type {
  OpenAICheckDefinition,
  OpenAICheckStamp,
} from "./checks/helpers.js";

export {
  OPENAI_ATTESTATIONS,
  OPENAI_DATA_TYPES,
  OPENAI_DEMO_CREDENTIAL_DELIVERY,
  openaiSubmissionProfileSchema,
  parseOpenAISubmissionProfile,
  summarizeTestCases,
} from "./submission-profile.js";
export type {
  OpenAIAttestation,
  OpenAIDataType,
  OpenAISubmissionProfile,
  OpenAISubmissionProfileParse,
} from "./submission-profile.js";

export { runOpenAIPackageChecks } from "./checks/package.js";
export type { OpenAIPackageEvidenceInput } from "./checks/package.js";
export { runOpenAISubmissionChecks } from "./checks/submission.js";
export type { OpenAISubmissionEvidence } from "./checks/submission.js";

export {
  gatherOpenAIReadinessEvidence,
  gradeOpenAIReadiness,
} from "./runner.js";
export type {
  GatherOpenAIReadinessEvidenceOptions,
  OpenAIReadinessEvidence,
} from "./runner.js";

export {
  annotatedToolNames,
  runOpenAIAnnotationChecks,
} from "./checks/annotations.js";
export type { OpenAIToolEvidence } from "./checks/annotations.js";
export { runOpenAIAuthChecks } from "./checks/auth.js";
export { runOpenAIEndpointChecks } from "./checks/endpoint.js";
export { runOpenAIDomainVerificationChecks } from "./checks/domain-verification.js";
export type { OpenAIDomainVerificationInput } from "./checks/domain-verification.js";

export { runOpenAIAppsUiChecks } from "./checks/apps-ui.js";
export type {
  OpenAIAppsUiEvidence,
  OpenAIUiResourceEvidence,
} from "./checks/apps-ui.js";
export { runOpenAIMcpSkillChecks } from "./checks/mcp-skills.js";
export type { OpenAISkillsCheckInput } from "./checks/mcp-skills.js";
export { runOpenAIMigrationChecks } from "./checks/migration.js";
export { runOpenAIPolicyChecks } from "./checks/policy.js";
export type { OpenAIPolicyEvidence } from "./checks/policy.js";
export { runOpenAIOptionalFeatureChecks } from "./checks/optional-features.js";
export type {
  OpenAIOptionalFeatureEvidence,
  OpenAIOptionalFeatureOutput,
} from "./checks/optional-features.js";

export { captureOpenAIMetadataSnapshot, splitEndpoint } from "./snapshot.js";
export type {
  OpenAIMetadataSnapshot,
  OpenAIToolSnapshot,
  OpenAIUiResourceSnapshot,
} from "./snapshot.js";

export {
  compareOpenAISnapshots,
  runOpenAIReleaseContractChecks,
} from "./checks/release-contract.js";
export type {
  OpenAIReleaseContractInput,
  OpenAIReleaseDelta,
  OpenAIReleaseImpact,
} from "./checks/release-contract.js";

export {
  OPENAI_OBSERVATION_CATALOG,
  OPENAI_OBSERVATION_IDS,
  OPENAI_OBSERVATION_KINDS,
  OPENAI_OBSERVATION_SCHEMA,
  OPENAI_OBSERVATION_SCHEMA_VERSION,
  mapOpenAIObservationsToFindings,
  parseOpenAIExperienceObservations,
} from "./observations.js";
export type {
  OpenAIExperienceObservations,
  OpenAIObservationId,
  OpenAIObservationKind,
  OpenAIObservationState,
} from "./observations.js";

export type { OpenAIToolListingCompleteness } from "./checks/annotations.js";

export {
  OPENAI_APPS_EVIDENCE_KIND,
  adaptAppsResultToOpenAIUiEvidence,
} from "./evidence-adapters.js";
export type { AdaptAppsResultToOpenAIOptions } from "./evidence-adapters.js";
