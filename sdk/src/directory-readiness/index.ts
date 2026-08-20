/**
 * `directory-readiness` — the result algebra every publisher's readiness
 * product is built on.
 *
 * This module grades nothing. It knows what a finding, a lane and a coverage
 * tally ARE, and how a set of lanes rolls up into one verdict; it does not
 * know a single requirement of any directory. The publisher modules
 * (`claude-readiness`, `openai-readiness`) supply the lanes, the corpus and
 * the checks.
 *
 * Pure data reasoning. Safe from the browser entry.
 */

export {
  DIRECTORY_EVIDENCE_PROVENANCE,
  DIRECTORY_FINDING_CLASSES,
  DIRECTORY_INTRUSIVENESS_LEVELS,
  decideLaneStatus,
  enforceCapabilityGate,
  isDispositiveDirectoryFinding,
  rollUpLaneStatus,
  summarizeLaneCoverage,
} from "./types.js";
export type {
  DirectoryCapabilityBadge,
  DirectoryEvidenceProvenance,
  DirectoryFindingClass,
  DirectoryFindingStatus,
  DirectoryIntrusiveness,
  DirectoryLaneCoverage,
  DirectoryLaneStatus,
  DirectoryReadinessFinding,
  DirectoryReadinessLaneResult,
} from "./types.js";

export { createFindingConstructors, derivedFrom } from "./helpers.js";
export type {
  DirectoryCheckDefinition,
  DirectoryCheckStamp,
  DirectoryFindingConstructorOptions,
  DirectoryFindingConstructors,
} from "./helpers.js";

export {
  DIRECTORY_OBSERVATION_CONFIDENCE,
  DIRECTORY_OBSERVATION_FINDING_CLASSES,
  DIRECTORY_OBSERVATION_LIMITS,
  DIRECTORY_OBSERVATION_REASONS,
  DIRECTORY_OBSERVATION_STATUSES,
  NOT_REQUESTED_OBSERVATIONS,
  mapObservationsToFindings,
  observationFailure,
  parseDirectoryObservationEnvelope,
} from "./observations.js";
export type {
  DirectoryObservation,
  DirectoryObservationCatalog,
  DirectoryObservationConfidence,
  DirectoryObservationEnvelope,
  DirectoryObservationFindingClass,
  DirectoryObservationMapping,
  DirectoryObservationParseFailure,
  DirectoryObservationParseResult,
  DirectoryObservationReason,
  DirectoryObservationSchema,
  DirectoryObservationState,
  DirectoryObservationStatus,
} from "./observations.js";

export {
  EVIDENCE_REUSE_REFUSALS,
  checkEvidenceReuse,
  sameReadinessTarget,
} from "./evidence-reuse.js";
export type {
  AttributableEvidenceSource,
  EvidenceReuse,
  EvidenceReuseExpectation,
  EvidenceReuseRefusal,
} from "./evidence-reuse.js";

/**
 * The MCP dial (`./mcp-dial.js`) is deliberately NOT re-exported here.
 *
 * This barrel's contract is the first line of its docblock: pure data
 * reasoning, safe from the browser entry. The dial opens sockets, so it is
 * reachable only from `sdk/src/index.ts` — the same arrangement the publisher
 * barrels use for their discovery modules, and the reason importing a result
 * model can never pull a transport in with it.
 */
