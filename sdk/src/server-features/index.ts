/**
 * Server feature model (KES-886): catalog, evidence contract and evaluator
 * for the server canvas. Browser-safe.
 */

export * from "./types.js";
export * from "./families.js";
export * from "./context.js";
export * from "./snapshot.js";
export { SERVER_FEATURE_CATALOG } from "./catalog/index.js";
export {
  CORE_REVISIONS,
  compareCoreRevisions,
  isCoreRevision,
  type CoreRevision,
} from "./catalog/revisions.js";
export {
  SPEC_CHECKED_AT,
  SPEC_PINS,
  coreSpec,
  extensionSpec,
  externalSpec,
} from "./catalog/spec-refs.js";
export {
  CHECK_FEATURE_MAPS,
  checkRef,
  checksForFeature,
  featuresForCheck,
  type CheckFeatureTarget,
} from "./check-map/index.js";
export { toDeclaredSurface, type DeclaredSurfaceSource } from "./declared-surface.js";
export {
  FEATURE_PROTOCOL_VERSIONS,
  featureApplicability,
  featureMarkers,
  isDeprecatedAt,
  isKnownFeatureVersion,
} from "./applicability.js";
export { evaluateServerFeatures } from "./evaluate.js";
export {
  checkEvidenceFromDigest,
  isConformanceCheckRef,
  isConformanceSuiteKey,
  type ConformanceDigestStatus,
  type ConformanceDigestSuite,
} from "./check-evidence.js";
export {
  listEvidenceContexts,
  parseCaptureContext,
  selectServerEvidence,
  type CaptureAttempt,
  type EvidenceContextOption,
  type ProbeFailure,
  type SelectedServerEvidence,
  type StoredServerEvidence,
} from "./evidence-input.js";
