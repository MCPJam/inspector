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
