import type { NodeOptions } from "@sentry/node";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { packagedTelemetryCatalog } from "./packaged-telemetry.js";
import catalog from "./telemetry-catalog.generated.json" with { type: "json" };
import {
  rebuildSentryBreadcrumb,
  rebuildSentryEvent,
  rebuildSentrySpan,
  rebuildSentryTransaction,
  restrictSentryEnvelope,
} from "./telemetry.js";

export function sdkTelemetryDisabled(): boolean {
  return [process.env.DO_NOT_TRACK, process.env.MCPJAM_TELEMETRY_DISABLED].some(
    (value) => value === "1" || value === "true"
  );
}

export function sdkDiagnosticBoundary(release: string) {
  // Bundled SDK entry and source execution each have an exact trusted location.
  const directory = dirname(fileURLToPath(import.meta.url));
  const frameAliases = Object.fromEntries([
    [fileURLToPath(import.meta.url), "dist/index.js"],
    [resolve(directory, "../sentry.ts"), "src/sentry.ts"],
  ]);
  const packaged = packagedTelemetryCatalog(import.meta.url);
  const sourceFrames: Record<string, readonly string[]> = { ...catalog.frames };
  delete sourceFrames["dist/index.js"];
  const options = {
    ...catalog,
    frames: { ...sourceFrames, ...packaged.frames },
    frameAliases,
    release,
  };
  const hooks: Pick<
    NodeOptions,
    | "beforeSend"
    | "beforeSendTransaction"
    | "beforeSendSpan"
    | "beforeBreadcrumb"
  > = {
    beforeSend(event, hint) {
      hint.attachments = [];
      return sdkTelemetryDisabled() ? null : rebuildSentryEvent(event, options);
    },
    beforeSendTransaction(event, hint) {
      hint.attachments = [];
      return sdkTelemetryDisabled()
        ? null
        : rebuildSentryTransaction(event, options);
    },
    beforeSendSpan: (span) => rebuildSentrySpan(span, options),
    beforeBreadcrumb: rebuildSentryBreadcrumb,
  };
  function envelope(value: Parameters<typeof restrictSentryEnvelope>[0]) {
    if (sdkTelemetryDisabled()) value[1].splice(0);
    else restrictSentryEnvelope(value, options);
  }
  return { hooks, envelope };
}
