/**
 * HP-44 — golden-trace parity harness.
 *
 * Makes "the emulator behaves exactly like the real host" mechanically
 * checkable, and is therefore the acceptance oracle for HP-43.
 *
 * Pipeline:
 *   CAPTURE  `captureEmulatorTrace` (in-process run) or `captureHarTrace` (proxy)
 *   NORMALIZE + REDACT at capture time — never at render time
 *   OBSERVE  `deriveObservations` reduces the wire to diff-relevant facts
 *   DIFF     `diffGoldenTraces` reports field-by-field parity, gaps and all
 *   PROJECT  `traceToOAuthProfile` feeds `HostConfigOAuthProfileV1`
 */

export {
  GOLDEN_TRACE_VERSION,
  MCP_WIRE_LEGS,
  OAUTH_DISCOVERY_LEGS,
  TRACE_DIFF_DIMENSIONS,
  TRACE_DIFF_SEVERITIES,
  TRACE_LEGS,
  TRACE_OBSERVATION_STATES,
  absent,
  notObserved,
  observedValue,
  present,
} from "./types.js";

export type {
  DcrIdentityUsage,
  GoldenTrace,
  Observation,
  PkceUsage,
  ProtocolVersionUsage,
  ResourceIndicatorUsage,
  ResourceIndicatorValueSource,
  TraceBody,
  TraceCaptureMeta,
  TraceCaptureMethod,
  TraceDiffDimension,
  TraceDiffFinding,
  TraceDiffResult,
  TraceDiffSeverity,
  TraceExchange,
  TraceLeg,
  TraceOAuthImplementation,
  TraceObservations,
  TraceObservationState,
  TraceRequest,
  TraceResponse,
  TraceScenario,
  TraceScenarioCapabilities,
  TraceSubject,
  UserAgentUsage,
} from "./types.js";

export {
  NORMALIZER_VERSION,
  REDACTED,
  assertTraceIsRedacted,
  buildOriginMap,
  extractLoopbackPorts,
  findRedactionViolations,
  isLoopbackHost,
  normalizeBody,
  normalizeExchange,
  normalizeHeaders,
  normalizeLoopbackPort,
  normalizeRequest,
  normalizeResponse,
  normalizeUrl,
  normalizeWire,
} from "./normalize.js";
export type {
  NormalizeOptions,
  NormalizedUrl,
  OriginPlaceholders,
  RedactionViolation,
} from "./normalize.js";

export {
  classifyLeg,
  deriveObservations,
  findObservationDrift,
  legForOAuthFlowStep,
  withObservedLoopbackPorts,
} from "./observe.js";
export type { LegClassificationInput } from "./observe.js";

export { collectRedirectUris, parseFormFields, parseTraceBody } from "./parse.js";

export { compareObservation, diffGoldenTraces } from "./diff.js";
export type { TraceDiffMode, TraceDiffOptions } from "./diff.js";

export {
  buildTraceId,
  captureEmulatorTrace,
  collectHttpHistory,
} from "./from-conformance.js";
export type { CaptureEmulatorTraceInput } from "./from-conformance.js";

export { captureHarTrace } from "./from-har.js";
export type { CaptureHarTraceInput, HarIngestReport } from "./from-har.js";

export { traceToOAuthProfile } from "./to-profile.js";
export type { TraceToProfileOptions } from "./to-profile.js";

export {
  formatHarIngestReportHuman,
  formatTraceDiffHuman,
  formatTraceSummaryHuman,
} from "./format.js";
