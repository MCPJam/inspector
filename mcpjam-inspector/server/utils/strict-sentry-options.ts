import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INSPECTOR_SENTRY_CATALOG,
  type SentryBoundaryOptions,
} from "../../shared/strict-sentry.js";
import { sentryIdentityMetadata } from "./sentry-request-identity.js";
import { resolveAppVersion, resolveEnvironment } from "./log-events.js";
import { sentryBuildMetadata } from "../../shared/sentry-build-metadata.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const frameAliases = Object.fromEntries(
  INSPECTOR_SENTRY_CATALOG.files.flatMap((name) => [
    [resolve(root, name), name],
    [pathToFileURL(resolve(root, name)).href, name],
  ]),
);
const metadata = sentryBuildMetadata(root, ["dist/server/index.js"]);

export function strictServerSentryOptions(): SentryBoundaryOptions {
  const identity = sentryIdentityMetadata();
  const environment = resolveEnvironment();
  return {
    ...INSPECTOR_SENTRY_CATALOG,
    ...metadata,
    frameAliases: { ...frameAliases, ...metadata.frameAliases },
    actorId: "user" in identity ? identity.user?.id : undefined,
    release: resolveAppVersion() ?? undefined,
    environment,
    platform: "node",
  };
}
