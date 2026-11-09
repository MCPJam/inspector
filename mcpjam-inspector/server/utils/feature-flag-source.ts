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
 * neither a boolean nor a variant name is off. The server reads the file at
 * boot (`loadFeatureFlagFileAtBoot`) and prints both problems on stderr; a
 * process that never ran the boot step reports them through the logger at
 * the first evaluation. A report never quotes the file.
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

type Report = (problem: string) => void;

function readFlagFile(path: string, report: Report): FeatureFlagAnswers {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    report(
      `[flags] MCPJAM_FEATURE_FLAGS_FILE could not be read (${code}), so every feature flag is off. Fix the file and restart.`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the start of the file, which may be
    // something other than flags.
    report(
      "[flags] MCPJAM_FEATURE_FLAGS_FILE is not valid JSON, so every feature flag is off. Fix the file and restart.",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    report(
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
    report(
      `[flags] MCPJAM_FEATURE_FLAGS_FILE answers ${invalid.join(", ")} with something other than true, false or a variant name, so those flags are off. Fix the file and restart.`,
    );
  }
  // `fromEntries` defines each key as its own property, so a `__proto__` key
  // is a flag name like any other rather than a prototype.
  return Object.fromEntries(valid);
}

function flagFilePath(): string | undefined {
  return process.env.MCPJAM_FEATURE_FLAGS_FILE?.trim() || undefined;
}

function loadFlagFile(path: string, report: Report): FeatureFlagAnswers {
  if (loadedFile?.path !== path) {
    loadedFile = { path, answers: readFlagFile(path, report) };
  }
  return loadedFile.answers;
}

/**
 * Reads `MCPJAM_FEATURE_FLAGS_FILE` at boot, when it is set, so a missing or
 * malformed file is reported before the first flag is evaluated. On stderr,
 * because the logger prints in production only with `VERBOSE_LOGS=true`, and
 * under DO_NOT_TRACK, where a flag file is used, it reports nowhere else.
 */
export function loadFeatureFlagFileAtBoot(): void {
  const path = flagFilePath();
  if (path) {
    loadFlagFile(path, (problem) => process.stderr.write(`${problem}\n`));
  }
}

export function resolveFeatureFlagSource(): FeatureFlagSource {
  const path = flagFilePath();
  if (path) {
    const answers = loadFlagFile(path, (problem) => logger.error(problem));
    return { kind: "file", answers };
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
