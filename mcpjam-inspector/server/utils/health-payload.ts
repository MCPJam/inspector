import {
  resolveSandboxIsolation,
  type SandboxIsolationStatus,
} from "../config.js";
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
 *
 * `sandboxIsolation` answers the question no browser can: whether MCP Apps
 * widget content is served from a hostname of its own. The boot log says the
 * same thing once; this says it on demand, to a canary that would rather poll
 * than read logs. See `resolveSandboxIsolation`.
 */
export function buildHealthMeta(): {
  version: string | null;
  environment: string;
  sandboxIsolation: SandboxIsolationStatus;
} {
  return {
    version: resolveAppVersion(),
    environment: resolveEnvironment(),
    sandboxIsolation: resolveSandboxIsolation(),
  };
}
