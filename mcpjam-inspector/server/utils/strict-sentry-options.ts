import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSPECTOR_SENTRY_CATALOG,
  type SentryBoundaryOptions,
} from "../../shared/strict-sentry.js";
import { sentryIdentityMetadata } from "./sentry-request-identity.js";
import { resolveAppVersion, resolveEnvironment } from "./log-events.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const frameAliases = Object.fromEntries(
  INSPECTOR_SENTRY_CATALOG.files.flatMap((name) => [
    [resolve(root, name), name],
    [new URL(name, `file://${root}/`).href, name],
  ]),
);

export function strictServerSentryOptions(): SentryBoundaryOptions {
  const identity = sentryIdentityMetadata();
  const environment = resolveEnvironment();
  return {
    ...INSPECTOR_SENTRY_CATALOG,
    frameAliases,
    actorId: "user" in identity ? identity.user?.id : undefined,
    release: resolveAppVersion() ?? undefined,
    environment:
      environment === "prod"
        ? "production"
        : environment === "staging"
          ? "staging"
          : environment === "test"
            ? "test"
            : "dev",
  };
}
