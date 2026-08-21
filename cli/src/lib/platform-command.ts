/**
 * Shared plumbing for CLI commands that talk to MCPJam Cloud.
 *
 * `buildCloudClientContext` constructs the client without a whole-command
 * deadline. `runPlatformOperation` adds that deadline, external abort,
 * and error translation. Long-lived commands (`tunnel`) use the former;
 * bounded operations use the latter.
 *
 * Credential flags still live on each leaf in this revision so unmigrated
 * commands cannot accept-and-ignore a parent option. `platformOptionsOf`
 * walks the Commander tree nearest-first so a later hoist onto `cloud`
 * keeps working.
 */
import type { Command } from "commander";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import {
  buildPlatformClient,
  toCliError,
  webOriginForApiBaseUrl,
} from "./platform-client.js";
import { getGlobalOptions } from "./server-config.js";
import { usageError, writeResult } from "./output.js";

export type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

export type CloudClientContext = {
  client: ReturnType<typeof buildPlatformClient>["client"];
  credentialKind: "api-key" | "oauth";
  baseUrl: string;
  webOrigin: string;
};

export type PlatformOperationContext = CloudClientContext & {
  signal: AbortSignal;
};

export type RunPlatformOperationExtras = {
  /**
   * Cancels the request from outside its own deadline — today that is Ctrl-C
   * during a poll. Without it the only way out of an in-flight request is the
   * timeout, so a user who interrupted a watch still waits the better part of
   * `timeoutMs` for the terminal to come back.
   */
  externalSignal?: AbortSignal;
  /**
   * When true (default), announce Cloud context before the operation.
   * Inner polls set `false` so a user command announces once. No-op until
   * the audience-line change lands.
   */
  announce?: boolean;
};

/**
 * Merge `--api-key` / `--api-url` (and any other flags) from this command and
 * its ancestors. Nearest declaration wins.
 *
 * READ THIS BEFORE USING `options.x` FOR CREDENTIAL OR PROJECT FLAGS. Each
 * may be declared on a group AND on its subcommands, and Commander does not
 * give the subcommand a copy: whichever command declares a flag NEAREST THE
 * TOP consumes it, wherever it appears on the line. `projects server connect
 * --project alpha` stores `alpha` on `servers`, and `connect`'s own
 * `options.project` is `undefined`. Merging here is what makes the typed
 * value reachable.
 *
 * Commander's `optsWithGlobals()` reduces the other way — globals overwrite
 * locals — which is wrong while leaves still declare the same flags. Ancestors
 * are merged first and the action command last. Undefined values are skipped
 * so a future Commander that materializes an unset flag as `undefined` cannot
 * erase a real value.
 */
export function platformOptionsOf<T = PlatformOptions>(command: Command): T {
  const nearestFirst: Command[] = [];
  for (
    let current: Command | null = command;
    current !== null;
    current = current.parent
  ) {
    nearestFirst.push(current);
  }

  const merged: Record<string, unknown> = {};
  for (const cmd of nearestFirst.reverse()) {
    for (const [key, value] of Object.entries(cmd.opts())) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as T;
}

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
 * Resolve credential, deployment, client, and web origin. Does not install a
 * whole-command timer — individual HTTP calls still use the client request
 * timeout. `tunnel` uses this directly so a session may outlive `--timeout`.
 */
export function buildCloudClientContext(
  options: PlatformOptions,
  timeoutMs?: number
): CloudClientContext {
  const built = buildPlatformClient({ ...options, timeoutMs });
  return {
    client: built.client,
    credentialKind: built.credentialKind,
    baseUrl: built.baseUrl,
    webOrigin: webOriginForApiBaseUrl(built.baseUrl),
  };
}

/**
 * Run one bounded Cloud operation under the global timeout, translating every
 * failure into a CLI error.
 *
 * The abort reason is checked explicitly because a timeout surfaces as a bare
 * `AbortError` from fetch otherwise — "The operation was aborted" tells a user
 * nothing about what to change, where "Request timed out after 30000ms" tells
 * them to raise `--timeout`.
 */
export async function runPlatformOperation<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: PlatformOperationContext) => Promise<TOutput>,
  extras: RunPlatformOperationExtras = {}
): Promise<TOutput> {
  void extras.announce;
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

  const externalSignal = extras.externalSignal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const context = buildCloudClientContext(options, timeoutMs);
    return await execute({ ...context, signal: controller.signal });
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
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** @deprecated Use {@link runPlatformOperation}. Kept for unmigrated call sites. */
export async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
    webOrigin: string;
  }) => Promise<TOutput>,
  extras?: AbortSignal | RunPlatformOperationExtras
): Promise<TOutput> {
  const normalized =
    extras instanceof AbortSignal || extras === undefined
      ? { externalSignal: extras }
      : extras;
  return runPlatformOperation(options, timeoutMs, execute, normalized);
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
      const result = await runPlatformOperation(
        platformOptionsOf<TOptions>(invoked),
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
 * The `requiredOption` counterpart, with the same parsing and bounds.
 *
 * Exists only for the return type. Commander guarantees a required option is
 * present, so call sites were writing `parseIntegerOption(...) as number` — and
 * an assertion is a claim the compiler cannot check, repeated once per flag.
 * This keeps the one unchecked narrowing in a single place.
 */
export function parseRequiredIntegerOption(
  value: string,
  flag: string,
  bounds?: { min?: number; max?: number }
): number {
  return parseIntegerOption(value, flag, bounds) as number;
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
