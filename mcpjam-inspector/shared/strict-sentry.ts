export {
  rebuildSentryEvent,
  rebuildSentryFrameLocations,
  rebuildSentryTransaction,
  rebuildSentrySpan,
  rebuildSentryBreadcrumb,
  restrictSentryEnvelope,
  withSentryBoundary,
  telemetryActorId,
  sentryEnvelopeHeaders,
  sentryEventId,
  sentryInjectedDebugId,
  rebuildSentryClientReport,
  sentryDropCategory,
  type SentryBoundaryOptions,
  type SentryDropCounter,
} from "@mcpjam/sdk/internal/telemetry";
export { default as INSPECTOR_SENTRY_CATALOG } from "./telemetry-catalog.generated.json";
export { default as BROWSER_SENTRY_CATALOG } from "./browser-telemetry-catalog.generated.json";
export { default as BROWSER_SENTRY_SOURCE_FILES } from "./browser-telemetry-source-files.generated.json";
