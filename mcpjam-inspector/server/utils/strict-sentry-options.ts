import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSPECTOR_SENTRY_CATALOG,
  type SentryBoundaryOptions,
} from "../../shared/strict-sentry.js";
import { sentryIdentityMetadata } from "./sentry-request-identity.js";
import { resolveAppVersion, resolveEnvironment } from "./log-events.js";
import {
  sentryBuildMetadata,
  sentryFrameAliases,
} from "../../shared/sentry-build-metadata.js";
import { isSentryBuildSurface } from "../../shared/sentry-config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const frameAliases = sentryFrameAliases(root, INSPECTOR_SENTRY_CATALOG.files);
const metadata = sentryBuildMetadata(root, ["dist/server/index.js"]);

/** The `dist` its maps were uploaded under, baked by `server/tsup.config.ts`. */
export function serverBuildSurface() {
  const surface = process.env.MCPJAM_BUILD_SURFACE;
  return surface && isSentryBuildSurface(surface) ? surface : undefined;
}

export function strictServerSentryOptions(): SentryBoundaryOptions {
  const identity = sentryIdentityMetadata();
  const environment = resolveEnvironment();
  return {
    ...INSPECTOR_SENTRY_CATALOG,
    ...metadata,
    frameAliases: { ...frameAliases, ...metadata.frameAliases },
    actorId: "user" in identity ? identity.user?.id : undefined,
    release: resolveAppVersion() ?? undefined,
    dist: serverBuildSurface(),
    environment,
    platform: "node",
  };
}
