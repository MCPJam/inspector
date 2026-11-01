/**
 * Where this process's feature flag answers come from, for every server flag
 * consumer: the browser and local-harness rollouts in `analytics.ts`, and the
 * client flags `GET /api/web/flags` serves to the browser.
 *
 *   1. `MCPJAM_FEATURE_FLAGS_FILE` names a JSON file: its answers, for every
 *      actor, and PostHog is never asked. A self-hosted install that cannot
 *      reach PostHog decides its flags here.
 *   2. Otherwise, under `DO_NOT_TRACK`: every flag off, and PostHog is never
 *      asked. Evaluating a flag sends PostHog the actor's id, so the opt-out
 *      covers it.
 *   3. Otherwise: PostHog, which already answers every flag off when it
 *      cannot be reached.
 *
 * The file holds one JSON object of flag key to answer: `true` or `false` for
 * a boolean flag, a variant name for a multivariate one.
 *
 *   { "evaluate-enabled": true, "guest-credit-wall-copy": "treatment" }
 *
 * A key the file does not name is off. It is read once per process, so a
 * change applies on restart. A file that cannot be read or is not a JSON
 * object answers every flag off, never PostHog; an entry whose answer is
 * neither a boolean nor a variant name is off. Both are reported through the
 * logger.
 */
import { readFileSync } from "node:fs";
import { telemetryOptedOut } from "../../shared/sentry-identity.js";
import { logger } from "./logger.js";

export type FeatureFlagAnswers = Readonly<Record<string, boolean | string>>;

export type FeatureFlagSource =
  | { kind: "file"; answers: FeatureFlagAnswers }
  | { kind: "off" }
  | { kind: "posthog" };

let loadedFile: { path: string; answers: FeatureFlagAnswers } | undefined;

function readFlagFile(path: string): FeatureFlagAnswers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    logger.error(
      "[flags] MCPJAM_FEATURE_FLAGS_FILE could not be read as JSON, so every feature flag is off. Fix the file and restart.",
      error,
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.error(
      "[flags] MCPJAM_FEATURE_FLAGS_FILE must hold one JSON object of flag keys to answers, so every feature flag is off. Fix the file and restart.",
    );
    return {};
  }
  const entries: Array<[string, unknown]> = Object.entries(parsed);
  const isAnswer = (
    entry: [string, unknown],
  ): entry is [string, boolean | string] =>
    typeof entry[1] === "boolean" ||
    (typeof entry[1] === "string" && entry[1].length > 0);
  const valid = entries.filter(isAnswer);
  const invalid = entries
    .filter((entry) => !isAnswer(entry))
    .map(([key]) => `"${key}"`);
  if (invalid.length > 0) {
    logger.error(
      `[flags] MCPJAM_FEATURE_FLAGS_FILE answers ${invalid.join(", ")} with something other than true, false or a variant name, so those flags are off. Fix the file and restart.`,
    );
  }
  // `fromEntries` defines each key as its own property, so a `__proto__` key
  // is a flag name like any other rather than a prototype.
  return Object.fromEntries(valid);
}

export function resolveFeatureFlagSource(): FeatureFlagSource {
  const path = process.env.MCPJAM_FEATURE_FLAGS_FILE?.trim();
  if (path) {
    if (loadedFile?.path !== path) {
      loadedFile = { path, answers: readFlagFile(path) };
    }
    return { kind: "file", answers: loadedFile.answers };
  }
  return telemetryOptedOut(process.env.DO_NOT_TRACK)
    ? { kind: "off" }
    : { kind: "posthog" };
}

/**
 * A boolean rollout's answer when PostHog is not the source, or `undefined`
 * when it is. Only `true` turns a rollout on: a variant name is not a yes.
 */
export function rolloutAnswerWithoutPostHog(key: string): boolean | undefined {
  const source = resolveFeatureFlagSource();
  if (source.kind === "posthog") return undefined;
  return source.kind === "file" && source.answers[key] === true;
}
