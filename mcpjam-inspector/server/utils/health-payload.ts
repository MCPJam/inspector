import { resolveEnvironment } from "./log-events.js";

/**
 * Baked into the bundle by `server/tsup.config.ts` (`define`).
 *
 * MUST stay a literal `process.env.X` member expression — esbuild's `define`
 * is a syntactic substitution and cannot see through a dynamic
 * `process.env[name]` lookup, which would leave the shipped server reporting
 * no version at all. Under `tsx` in dev the define is absent and this reads
 * the real environment, where npm provides `npm_package_version`.
 *
 * Same mechanism `server/sentry.ts` uses for the release tag.
 */
const BAKED_VERSION = process.env.MCPJAM_INSPECTOR_VERSION;

function blankToUndefined(value: string | undefined): string | undefined {
  // Container platforms materialize a declared-but-unset variable as `""`,
  // which `??` does not catch.
  return value === undefined || value.trim() === "" ? undefined : value;
}

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
    version:
      blankToUndefined(BAKED_VERSION) ??
      blankToUndefined(process.env.npm_package_version) ??
      null,
    environment: resolveEnvironment(),
  };
}
