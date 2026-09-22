/**
 * Shared plumbing for CLI commands that talk to MCPJam Cloud.
 *
 * `buildCloudClientContext` constructs the client without a whole-command
 * deadline. `runPlatformOperation` adds that deadline, external abort,
 * and error translation. Long-lived commands (`tunnel`) use the former;
 * bounded operations use the latter.
 *
 * Credential flags live on the `cloud` parent. `platformOptionsOf` walks the
 * Commander tree nearest-first so a value typed before or after a descendant
 * is visible to the action. Local commands, including hosted `readiness`,
 * still declare leaf flags where they need them.
 */
import type { Command } from "commander";
import {
  PlatformApiError,
  runOperationWithPermalinks,
  withPermalinkEnvelope,
  type PlatformPermalink,
  type PlatformPermalinkPolicy,
} from "@mcpjam/sdk/platform";
import {
  appendProjectLinkHint,
  resolveCloudProjectArgs,
  resolveProjectSelector,
  type CloudScope,
  type ProjectCloudScope,
  type ResolveProjectSelectorOptions,
} from "./cloud-scope.js";
import {
  announceCloudContext,
  preflightCloudCredentials,
} from "./cloud-context.js";
import {
  buildPlatformClient,
  toCliError,
  webOriginForApiBaseUrl,
} from "./platform-client.js";
import { getGlobalOptions } from "./server-config.js";
import { CliError, usageError, writeResult } from "./output.js";

export type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
  apiHeader?: string[];
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
   * When true (default), print the Cloud audience line to stderr before the
   * operation. Inner polls, `cloud whoami`, `cloud link`, and hosted
   * `readiness` set `false` so a user command announces at most once.
   */
  announce?: boolean;
  /**
   * Suppress the audience line. Wrappers pass the global `--quiet` flag;
   * `process.argv` is the fallback when a call site has not been updated.
   */
  quiet?: boolean;
  /**
   * Typed Cloud resource scope for the audience line. When omitted, a
   * project-scoped selector is inferred from `--project` / env / link /
   * automatic. Account-scoped callers pass `{ kind: "account" }` (or
   * `all-projects` / `organization`) so they do not pick up a project link.
   */
  cloudScope?: CloudScope;
  /**
   * How the project selector for this operation was chosen. Used to append
   * a re-link hint when a link-sourced selector fails online, and as the
   * audience scope when `cloudScope` is omitted.
   */
  projectScope?: ProjectCloudScope;
};

/**
 * Merge `--api-key` / `--api-url` (and any other flags) from this command and
 * its ancestors. Nearest declaration wins.
 *
 * READ THIS BEFORE USING `options.x` FOR CREDENTIAL OR PROJECT FLAGS. Each
 * may be declared on a group AND on its subcommands, and Commander does not
 * give the subcommand a copy: whichever command declares a flag NEAREST THE
 * TOP consumes it, wherever it appears on the line. `projects servers connect
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
    )
    .option(
      "--api-header <header...>",
      'Extra request header for a deployment behind an edge authenticator, as "Name: value" (repeatable; also MCPJAM_API_HEADERS, newline-separated)'
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

function cloudAnnounceScope(
  options: PlatformOptions,
  extras: RunPlatformOperationExtras
): CloudScope {
  if (extras.cloudScope) return extras.cloudScope;
  if (extras.projectScope) return extras.projectScope;
  return resolveProjectSelector({
    flagProject: (options as { project?: string }).project,
  });
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
  preflightCloudCredentials(options);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms. Raise it with --timeout <ms>. ` +
          "The server may still be working: a command that spends credits keeps " +
          "running after the client gives up, so retry with the SAME " +
          "--idempotency-key to replay that turn rather than start another.",
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
    const quiet = extras.quiet ?? process.argv.includes("--quiet");
    if (extras.announce !== false && quiet !== true) {
      announceCloudContext({
        scope: cloudAnnounceScope(options, extras),
        options,
      });
    }
    return await execute({ ...context, signal: controller.signal });
  } catch (error) {
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    const mapped = toCliError(error);
    throw new CliError(
      mapped.code,
      appendProjectLinkHint(mapped.message, extras.projectScope),
      mapped.exitCode,
      mapped.details
    );
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
 *
 * Cloud commands inherit `--api-key` / `--api-url` from the `cloud` parent.
 * Hosted `readiness` stays at the program root and still gets leaf flags.
 */
function hasCloudAncestor(command: Command): boolean {
  for (
    let current: Command | null = command.parent;
    current !== null;
    current = current.parent
  ) {
    if (current.name() === "cloud") return true;
  }
  return false;
}

function commandHasProjectOption(command: Command): boolean {
  return command.options.some((option) => option.long === "--project");
}

export type BindOperationExtras<TOutput> = {
  /**
   * Print the Cloud audience line. Defaults to "only under `mcpjam cloud`";
   * root-level Cloud groups (`registry`) opt in so a user can see which
   * deployment and project a command hit, while hosted `readiness` stays
   * silent by convention.
   */
  announce?: boolean;
  /**
   * Audience scope for commands that are not project-scoped (no `--project`
   * option). Without it a directory read would announce an inferred project
   * selector it never uses.
   */
  cloudScope?: CloudScope;
  /**
   * Apply the ambient project precedence (flag > MCPJAM_PROJECT > repo link >
   * automatic) to a root-level command that declares `--project`. Under
   * `mcpjam cloud` it always applies; outside it a group must opt in, because
   * hosted `readiness` deliberately takes no ambient Cloud project context
   * (pinned in cloud-link-status.test.ts) while `registry` — a group of
   * project writes — must resolve exactly like `cloud projects …`.
   */
  ambientProject?: boolean;
  /**
   * Human rendering for `--format human`. Other formats always go through
   * `writeResult`, so JSON output stays machine-shaped.
   */
  formatHuman?: (result: TOutput) => string;
  /**
   * The `--timeout` default for THIS command, when the caller passed none.
   *
   * The 30s program default is sized for an MCP probe. A command that BLOCKS
   * on a model turn — `sessions send` — routinely runs longer than that, and
   * the client giving up does NOT stop the turn: it keeps running, keeps
   * spending, and the caller sees only a timeout. Raising the default per
   * command keeps the probe commands snappy without making the blocking ones
   * lie about what happened. `eval run` needs none of this: it returns once
   * the run has STARTED, and the run is then polled.
   */
  defaultTimeoutMs?: number;
};

/**
 * `View: <url>` per permalink, after the command's own human output.
 *
 * Human format only, and always LAST, so the payload a person is reading
 * stays first. `--quiet` is deliberately unaffected: it suppresses the cloud
 * CONTEXT announcement, not the command's own result — and the link is part
 * of the result.
 */
function writeHumanPermalinks(permalinks: readonly PlatformPermalink[]): void {
  if (permalinks.length === 0) return;
  process.stdout.write(
    `${permalinks.map((permalink) => `View: ${permalink.url}`).join("\n")}\n`
  );
}

export function bindOperation<
  TOptions extends PlatformOptions,
  TInput,
  TOutput = unknown,
>(
  command: Command,
  operation: {
    name?: string;
    permalink?: PlatformPermalinkPolicy<TInput, TOutput>;
    execute: (
      input: TInput,
      context: {
        client: ReturnType<typeof buildPlatformClient>["client"];
        signal: AbortSignal;
        onScopeResolved?: (scope: {
          projectId: string;
          organizationId?: string;
        }) => void;
      }
    ) => Promise<TOutput>;
  },
  buildInput: (
    options: TOptions,
    ...positionals: (string | undefined)[]
  ) => TInput,
  bindExtras: BindOperationExtras<TOutput> = {}
): void {
  if (!hasCloudAncestor(command)) {
    addPlatformOptions(command);
  }
  command.action(async (...invocation: unknown[]) => {
    const invoked = invocation[invocation.length - 1] as Command;
    const options = invocation[invocation.length - 2] as TOptions;
    const positionals = invocation.slice(0, -2) as (string | undefined)[];
    const globalOptions = getGlobalOptions(invoked, bindExtras.defaultTimeoutMs);
    const merged = platformOptionsOf<TOptions & { project?: string }>(invoked);
    const underCloud = hasCloudAncestor(invoked);
    // Gating ambient resolution on the parent being named `cloud` alone
    // silently sent root-level writes (`registry install`) to the most
    // recently updated project even inside a repo linked to a specific one —
    // hence the explicit `ambientProject` opt-in for root-level groups.
    const applyAmbient =
      (underCloud || bindExtras.ambientProject === true) &&
      commandHasProjectOption(invoked);
    const resolved = applyAmbient
      ? resolveCloudProjectArgs({ project: merged.project })
      : undefined;
    const inputOptions = resolved
      ? ({ ...options, project: resolved.project } as TOptions)
      : options;
    // Permalinks come back alongside the result so both output formats can
    // use them: human prints `View: <url>`, JSON carries the typed array.
    // Derived from the RAW result, before `formatHuman` reshapes anything.
    let permalinks: PlatformPermalink[] = [];
    const result = await runPlatformOperation(
      platformOptionsOf<TOptions>(invoked),
      globalOptions.timeout,
      async ({ client, signal, webOrigin }) => {
        const input = buildInput(inputOptions, ...positionals);
        if (!operation.permalink || !operation.name) {
          return operation.execute(input, { client, signal });
        }
        const ran = await runOperationWithPermalinks<
          TInput,
          TOutput,
          Parameters<typeof operation.execute>[1]
        >(
          {
            name: operation.name,
            permalink: operation.permalink,
            execute: operation.execute,
          },
          input,
          { client, signal },
          {
            appOrigin: webOrigin,
            // stderr, so `--format json` stdout stays a parseable contract.
            onError: (error, operationName) => {
              process.stderr.write(
                `mcpjam: could not build a permalink for ${operationName}: ${
                  error instanceof Error ? error.message : String(error)
                }\n`
              );
            },
          }
        );
        permalinks = ran.permalinks;
        return ran.result;
      },
      {
        announce: bindExtras.announce ?? underCloud,
        quiet: globalOptions.quiet,
        ...(resolved
          ? {
              projectScope: resolved.projectScope,
              cloudScope: resolved.projectScope,
            }
          : bindExtras.cloudScope
            ? { cloudScope: bindExtras.cloudScope }
            : {}),
      }
    );
    if (globalOptions.format === "human") {
      if (bindExtras.formatHuman) {
        process.stdout.write(`${bindExtras.formatHuman(result)}\n`);
      } else {
        writeResult(result, globalOptions.format);
      }
      writeHumanPermalinks(permalinks);
      return;
    }
    // JSON carries the TYPED array instead of trailing prose: `--format json`
    // bytes are a contract scripts parse, and a `View:` line appended to them
    // would break every one of those parsers.
    writeResult(
      permalinks.length > 0
        ? withPermalinkEnvelope(result, permalinks)
        : result,
      globalOptions.format
    );
  });
}

/**
 * Run a project-scoped Cloud operation, applying flag / input / env / link /
 * automatic precedence to `--project` without writing the resolved selector
 * back onto `options.project`.
 */
export async function runCloudOp<
  TOptions extends PlatformOptions & { project?: string },
  TOutput,
>(
  command: Command,
  options: TOptions,
  execute: (
    context: PlatformOperationContext,
    project: { project?: string }
  ) => Promise<TOutput>,
  extra: Omit<ResolveProjectSelectorOptions, "flagProject"> & {
    extras?: RunPlatformOperationExtras;
  } = {}
): Promise<TOutput> {
  const globalOptions = getGlobalOptions(command);
  const { extras: nestedExtras, ...selectorExtra } = extra;
  const resolved = resolveCloudProjectArgs(options, selectorExtra);
  return runPlatformOperation(
    platformOptionsOf(command),
    globalOptions.timeout,
    (context) =>
      execute(
        context,
        resolved.project !== undefined ? { project: resolved.project } : {}
      ),
    {
      ...nestedExtras,
      projectScope: resolved.projectScope,
      cloudScope: nestedExtras?.cloudScope ?? resolved.projectScope,
      quiet: nestedExtras?.quiet ?? globalOptions.quiet,
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
 * Organization filter. ID-only — unlike `--project`, which is a name-or-id
 * selector. `mcpjam cloud organizations list` is how you learn the id.
 */
export function addOrgOption(command: Command): Command {
  return command.option(
    "--org <id>",
    "Organization ID (see `mcpjam cloud organizations list`)"
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
