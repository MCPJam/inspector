import { resolveAppVersion, resolveEnvironment } from "./log-events.js";

/**
 * Fields every `/health` response carries.
 *
 * `version` exists because "what is production actually serving?" was
 * unanswerable over HTTP during a deploy investigation: a release had run, but
 * nothing the running process exposed could confirm which build was live, so
 * the question could only be settled by opening the hosting dashboard. A
 * health check that cannot identify the build it belongs to is a health check
 * you have to take on faith.
 *
 * `null` rather than an omitted key when the version is genuinely unknown — a
 * missing field reads as "old build that predates this" and is exactly the
 * ambiguity this is meant to remove.
 */
export function buildHealthMeta(): {
  version: string | null;
  environment: string;
} {
  return {
    version: resolveAppVersion(),
    environment: resolveEnvironment(),
  };
}
