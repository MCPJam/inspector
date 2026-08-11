export { redactForTelemetry } from "./telemetry-redaction.js";
/**
 * @deprecated Renamed to `redactForTelemetry`. Kept as an alias so external
 * consumers do not break on the rename; there is no plan to remove it soon.
 *
 * The rename exists because this is the SENTRY redactor: it over-redacts on
 * purpose and is length-capped. The OAuth *display* redactor is
 * `sanitizeOAuthTraceValue` in `oauth/state-machines/trace-redaction.ts`, and
 * the two must never be confused for each other — one being used where the
 * other belongs is how a credential either leaks or becomes unusable.
 */
export { redactForTelemetry as redactSensitiveValue } from "./telemetry-redaction.js";
export { probeMcpServer } from "./server-probe.js";
export { runHttpServerDoctor } from "./http-server-doctor.js";

export type {
  HttpServerConfig,
  RpcLogger,
} from "./mcp-client-manager/types.js";
export type {
  ProbeHttpAttempt,
  ProbeInitializeInfo,
  ProbeMcpServerConfig,
  ProbeMcpServerResult,
  ProbeOAuthDetails,
  ProbeTransportResult,
} from "./server-probe.js";
export type {
  ConnectedHttpServerDoctorState,
  HttpServerDoctorDependencies,
  RunHttpServerDoctorInput,
} from "./http-server-doctor.js";
export type {
  ConnectedServerDoctorState,
  ServerDoctorCheck,
  ServerDoctorChecks,
  ServerDoctorConnection,
  ServerDoctorError,
  ServerDoctorResult,
} from "./server-doctor-core.js";
