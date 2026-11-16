import type { Command } from "commander";

/**
 * How a CLI run ended, sent as `cli_command.outcome`.
 *
 * - `ok`: exit code 0.
 * - `check_failed`: the command finished and reported a failing result
 *   through `setProcessExitCode` (a readiness verdict, failing conformance
 *   checks, a failed eval gate).
 * - `error`: the command threw, or reported an error it caught itself.
 * - `usage_error`: bad arguments, an unknown command or a missing option.
 * - `interrupted`: the user stopped the run with Ctrl+C or SIGTERM. This wins
 *   over whatever the command reports after the signal.
 */
export type CommandOutcome =
  | "ok"
  | "check_failed"
  | "error"
  | "usage_error"
  | "interrupted";

export type RecordableOutcome = "check_failed" | "error" | "interrupted";

export interface ResolvedOutcome {
  outcome: CommandOutcome;
  /** Present only for `error` and `usage_error`. */
  errorCode?: string;
}

/** `command` for a usage error whose first token matches no command. */
export const UNKNOWN_COMMAND = "(unknown)";

interface RecordedOutcome {
  outcome: RecordableOutcome;
  errorCode?: string;
}

// A process-wide slot, like `process.exitCode`, which the command sets next
// to it. `main()` resets both so in-process runs stay independent.
let recorded: RecordedOutcome | undefined;

/**
 * Record how the current command ended, for when its exit code alone can't
 * say. A later call replaces an earlier one, except that nothing replaces
 * `interrupted`.
 */
export function recordCommandOutcome(
  outcome: RecordableOutcome,
  errorCode?: string,
): void {
  if (recorded?.outcome === "interrupted") {
    return;
  }
  recorded = errorCode === undefined ? { outcome } : { outcome, errorCode };
}

export function resetCommandOutcome(): void {
  recorded = undefined;
}

/**
 * Combine the exit code, a thrown error's code (if the command threw) and the
 * recorded outcome into one outcome.
 */
export function resolveCommandOutcome(
  exitCode: number,
  thrownErrorCode?: string,
): ResolvedOutcome {
  if (recorded?.outcome === "interrupted") {
    return { outcome: "interrupted" };
  }
  if (thrownErrorCode !== undefined) {
    return {
      outcome: thrownErrorCode === "USAGE_ERROR" ? "usage_error" : "error",
      errorCode: thrownErrorCode,
    };
  }
  if (exitCode === 0) {
    return { outcome: "ok" };
  }
  if (recorded?.outcome === "check_failed") {
    return { outcome: "check_failed" };
  }
  // A command that caught and printed its own usage error still had one.
  const errorCode = recorded?.errorCode ?? "UNKNOWN_ERROR";
  return {
    outcome: errorCode === "USAGE_ERROR" ? "usage_error" : "error",
    errorCode,
  };
}

/**
 * The registered command path that argv names, for errors commander raises
 * before any action runs. Walks argv from the root, descending into a
 * subcommand whenever a token matches its name or an alias, and skips every
 * other token. The result holds registered names only, so no argv text
 * leaves the machine. An empty result means nothing matched.
 */
export function resolveRegisteredCommandPath(
  program: Command,
  argv: readonly string[],
): string[] {
  const path: string[] = [];
  let current = program;

  for (const token of argv.slice(2)) {
    if (token === "--") {
      break;
    }
    if (token.startsWith("-")) {
      continue;
    }
    const next = current.commands.find(
      (command) => command.name() === token || command.aliases().includes(token),
    );
    if (next) {
      path.push(next.name());
      current = next;
    }
  }

  return path;
}

/** `--no-telemetry` anywhere before `--`, for runs that never parsed. */
export function argvOptsOutOfTelemetry(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--no-telemetry");
}
