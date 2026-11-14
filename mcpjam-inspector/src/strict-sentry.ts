import * as Sentry from "@sentry/electron/main";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sentryBuildMetadata } from "../shared/sentry-build-metadata.js";
import { telemetryOptedOut } from "../shared/sentry-identity.js";
import {
  buildElectronSentryConfig,
  electronBuildSurface,
} from "../shared/sentry-config.js";
import { getDesktopSentryIdentity } from "../shared/desktop-sentry-state.js";
import {
  INSPECTOR_SENTRY_CATALOG,
  withSentryBoundary,
} from "../shared/strict-sentry.js";
import {
  crashReportingIntegrations,
  dropUpdaterInstallSpawnRejection,
} from "./crash-reporting.js";
import type { DesktopStartupFailureCode } from "../shared/desktop-startup-failure.js";

/**
 * Page #mcpjam-alerts: the app still could not start after its automatic
 * restart, so the user is looking at the startup dialog. `surface` and
 * `page_class` are what the alert rule matches; `code` and `port` are the
 * only details the strict boundary lets through.
 *
 * Flushed before returning because the caller shows a blocking dialog and
 * then quits; an event still queued at exit is never sent.
 */
export async function reportDesktopStartupFailure(details: {
  code: DesktopStartupFailureCode;
  port?: number;
}): Promise<void> {
  Sentry.captureMessage(
    "Desktop app could not start after an automatic restart",
    {
      level: "error",
      tags: { surface: "desktop", page_class: "incident" },
      extra: { ...details },
    },
  );
  await Sentry.flush(2000);
}

export function initDesktopSentry(input: {
  release: string;
  packaged: boolean;
  root: string;
}): void {
  const frameAliases = Object.fromEntries(
    INSPECTOR_SENTRY_CATALOG.files.flatMap((name) => [
      [resolve(input.root, name), name],
      [pathToFileURL(resolve(input.root, name)).href, name],
      [`app:///${name}`, name],
    ]),
  );
  const metadata = sentryBuildMetadata(input.root, [".vite/build/main.cjs"]);
  const options = () => ({
    ...INSPECTOR_SENTRY_CATALOG,
    ...metadata,
    frameAliases: { ...frameAliases, ...metadata.frameAliases },
    release: input.release,
    environment: input.packaged ? ("prod" as const) : ("dev" as const),
    platform: "javascript" as const,
    dist: electronBuildSurface(process.platform),
    actorId: getDesktopSentryIdentity()?.id,
  });
  const disabled = () => telemetryOptedOut(process.env.DO_NOT_TRACK, process.env.MCPJAM_TELEMETRY_DISABLED);
  Sentry.init({
    ...buildElectronSentryConfig({
      environment: input.packaged ? "prod" : "dev",
      release: input.release,
      dist: electronBuildSurface(process.platform),
      deployment: "self_hosted",
      enabled: !disabled(),
      tracesSampleRate: 0,
    }),
    ipcMode: Sentry.IPCMode.Both,
    sendDefaultPii: false,
    attachScreenshot: false,
    sendClientReports: true,
    integrations: crashReportingIntegrations,
    beforeSend: dropUpdaterInstallSpawnRejection,
    beforeSendTransaction: undefined,
    beforeBreadcrumb: undefined,
    transport: (config) => withSentryBoundary(
      Sentry.makeElectronTransport(config), options, disabled,
      config.recordDroppedEvent,
    ),
  });
}
