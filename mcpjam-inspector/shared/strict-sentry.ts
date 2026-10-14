export {
  sentryInjectedDebugId,
  rebuildSentryEvent,
  rebuildSentryFrameLocations,
  rebuildSentryTransaction,
  rebuildSentrySpan,
  rebuildSentryBreadcrumb,
  restrictSentryEnvelope,
  withSentryBoundary,
  telemetryActorId,
  type SentryBoundaryOptions,
} from "@mcpjam/sdk/internal/telemetry";
export { default as INSPECTOR_SENTRY_CATALOG } from "./telemetry-catalog.generated.json";
