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
