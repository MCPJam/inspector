import * as Sentry from "@sentry/electron/main";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sentryBuildMetadata } from "../shared/sentry-build-metadata.js";
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
  const disabled = () => ["1", "true"].includes(process.env.DO_NOT_TRACK ?? "");
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
    sendClientReports: false,
    integrations: crashReportingIntegrations,
    beforeSend: dropUpdaterInstallSpawnRejection,
    beforeSendTransaction: undefined,
    beforeBreadcrumb: undefined,
    transport: (config) => withSentryBoundary(
      Sentry.makeElectronTransport(config), options, disabled,
    ),
  });
}
