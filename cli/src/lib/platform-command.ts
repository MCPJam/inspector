/**
 * Shared plumbing for CLI commands that are thin wrappers over one platform
 * operation.
 *
 * `commands/journeys.ts` and `commands/scenarios.ts` each carry their own copy
 * of `addPlatformOptions` + `runPlatformCommand`. Two copies was tolerable;
 * the swarms authoring surface would have made it four, across files that must
 * agree on how `--api-key`, `--api-url` and the global timeout behave. This
 * module is the one copy for everything added from here on. The existing files
 * are deliberately left alone — moving them is churn in a diff that is already
 * about something else, and their copies still behave identically.
 */
import type { Command } from "commander";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import { buildPlatformClient, toCliError } from "./platform-client.js";
import { getGlobalOptions } from "./server-config.js";
import { usageError, writeResult } from "./output.js";

export type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

/** The credential flags every platform command accepts. */
export function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)"
    );
}

/**
 * Run one operation under the global timeout, translating every failure into a
 * CLI error.
 *
 * The abort reason is checked explicitly because a timeout surfaces as a bare
 * `AbortError` from fetch otherwise — "The operation was aborted" tells a user
 * nothing about what to change, where "Request timed out after 30000ms" tells
 * them to raise `--timeout`.
 */
export async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
  }) => Promise<TOutput>
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        }
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const { client } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({ client, signal: controller.signal });
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Wire a subcommand to an operation: credential flags, the global timeout, and
 * printing in the caller's chosen format.
 *
 * `buildInput` maps the parsed flags onto the operation's input. It is the only
 * per-command code most of these need, which is the point — a command that is
 * "call this operation with these flags" should not also be 30 lines of
 * identical error handling.
 */
export function bindOperation<TOptions extends PlatformOptions, TInput>(
  command: Command,
  operation: {
    execute: (
      input: TInput,
      context: {
        client: ReturnType<typeof buildPlatformClient>["client"];
        signal: AbortSignal;
      }
    ) => Promise<unknown>;
  },
  buildInput: (options: TOptions) => TInput
): void {
  addPlatformOptions(command).action(
    async (options: TOptions, invoked: Command) => {
      const globalOptions = getGlobalOptions(invoked);
      const result = await runPlatformCommand(
        options,
        globalOptions.timeout,
        ({ client, signal }) =>
          operation.execute(buildInput(options), { client, signal })
      );
      writeResult(result, globalOptions.format);
    }
  );
}

/** `--project` is optional everywhere: it defaults to the newest project. */
export function addProjectOption(command: Command): Command {
  return command.option(
    "--project <id-or-name>",
    "Project name or ID (defaults to the most recently updated project)"
  );
}

/**
 * Parse an integer flag, or fail with a message that names the flag.
 *
 * Commander hands option values through as strings, and `Number("abc")` is
 * `NaN` — which would reach the API as a validation error about a field the
 * user never typed.
 */
export function parseIntegerOption(
  value: string | undefined,
  flag: string,
  bounds?: { min?: number; max?: number }
): number | undefined {
  if (value === undefined) return undefined;
  // `Number("")` is 0 and `Number.isInteger(0)` is true, so an empty flag value
  // would sail through this guard and be rejected by a zod bound two hops
  // later — with a field name the user never typed.
  const trimmed = value.trim();
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  // `usageError`, not a bare Error: a bare one surfaces as INTERNAL_ERROR with
  // exit code 1, which tells a script the CLI broke when in fact the flag was
  // mistyped. Malformed input is exit code 2.
  if (!Number.isInteger(parsed)) {
    throw usageError(`${flag} must be a whole number`);
  }
  // Bounds are checked HERE rather than left to the API so a typo fails
  // locally and instantly, instead of after a round trip that reports a field
  // name the user never typed.
  if (bounds?.min !== undefined && parsed < bounds.min) {
    throw usageError(`${flag} must be at least ${bounds.min}`);
  }
  if (bounds?.max !== undefined && parsed > bounds.max) {
    throw usageError(`${flag} must be at most ${bounds.max}`);
  }
  return parsed;
}

/**
 * Exactly one of two mutually exclusive flags, both optional individually.
 *
 * The generation endpoints ground a model in either an environment or a legacy
 * server attachment, and reject neither/both with a 400. Checking here means
 * the user finds out before a model call is made rather than after.
 */
export function requireExactlyOne(flags: Record<string, unknown>): void {
  const supplied = Object.entries(flags).filter(
    ([, value]) => value !== undefined && value !== ""
  );
  if (supplied.length === 1) return;
  const names = Object.keys(flags).join(" or ");
  throw usageError(
    supplied.length === 0
      ? `Provide ${names}.`
      : `Provide only one of ${names}.`
  );
}

/**
 * Two flags that must be supplied together or not at all.
 *
 * The execution knobs are one `config` object upstream, so a one-sided update
 * is rejected server-side. Failing locally names both flags, which the server's
 * message about a nested field cannot.
 */
export function requireTogether(
  first: { flag: string; value: unknown },
  second: { flag: string; value: unknown }
): void {
  if ((first.value === undefined) === (second.value === undefined)) return;
  throw usageError(
    `${first.flag} and ${second.flag} must be given together — they are one execution config upstream.`
  );
}
