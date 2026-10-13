import * as Sentry from "@sentry/electron/main";
import { resolve } from "node:path";
import {
  buildElectronSentryConfig,
  electronBuildSurface,
} from "../shared/sentry-config.js";
import { getDesktopSentryIdentity } from "../shared/desktop-sentry-state.js";
import {
  INSPECTOR_SENTRY_CATALOG,
  rebuildSentryBreadcrumb,
  rebuildSentryEvent,
  rebuildSentrySpan,
  rebuildSentryTransaction,
  restrictSentryEnvelope,
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
    Object.keys(INSPECTOR_SENTRY_CATALOG.frames).flatMap((name) => [
      [resolve(input.root, name), name],
      [new URL(name, `file://${input.root}/`).href, name],
    ]),
  );
  const options = () => ({
    ...INSPECTOR_SENTRY_CATALOG,
    frameAliases,
    release: input.release,
    environment: input.packaged ? ("production" as const) : ("dev" as const),
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
    beforeSend: (event, hint) => {
      hint.attachments = [];
      return disabled() || dropUpdaterInstallSpawnRejection(event) === null
        ? null
        : rebuildSentryEvent(event, options());
    },
    beforeSendTransaction: (event, hint) => {
      hint.attachments = [];
      return disabled() ? null : rebuildSentryTransaction(event, options());
    },
    beforeSendSpan: (span) => rebuildSentrySpan(span, options()),
    beforeBreadcrumb: rebuildSentryBreadcrumb,
  });
  Sentry.getClient()?.on("beforeEnvelope", (envelope) => {
    if (disabled()) envelope[1].splice(0);
    else restrictSentryEnvelope(envelope, options());
  });
}
