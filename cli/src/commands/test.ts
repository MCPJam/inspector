import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SuiteFileRunError,
  createSuiteFileRunner,
  formatLocalEvalRunSummary,
  loadEvalSuiteFile,
  renderStructuredRunJson,
  runSuiteFile,
  type RunSuiteFileOptions,
  type SuiteFileAuthRequired,
  type SuiteFileRunProgressEvent,
  type SuiteFileRunResult,
  type SuiteFileRunnerRuntime,
} from "@mcpjam/sdk";
import { Command } from "commander";
import { resolveHostFromOptions } from "../lib/host-resolve.js";
import {
  createMcpjamConnectionResolver,
  readProviderBaseUrls,
  readProviderKeys,
} from "../lib/local-credentials.js";
import { resolveLocalServerBindings } from "../lib/local-server-bindings.js";
import {
  LOCAL_TEST_EXIT,
  localTestExitCodeForError,
  localTestExitCodeForResult,
} from "../lib/local-test-exit-code.js";
import {
  CliError,
  authChallengeHint,
  displayableScope,
  cliError,
  setProcessExitCode,
  usageError,
  writeError,
  writeResult,
} from "../lib/output.js";
import {
  addPlatformOptions,
  addProjectOption,
} from "../lib/platform-command.js";
import {
  parseReporterFormat,
  writeReporterArtifact,
  writeReporterResult,
  type ReporterFormat,
} from "../lib/reporting.js";
import {
  addSharedServerOptions,
  getGlobalOptions,
  parsePositiveInteger,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { parseApprovalFlags } from "./eval.js";

/**
 * `mcpjam test <file>` — run a suite file locally.
 *
 * A THIN adapter: it discovers configuration (server bindings, provider keys,
 * the platform login), invokes the SDK's `runSuiteFile`, renders its report
 * and maps its outcome to an exit code. Validation, materialization,
 * execution, tool policy and the verdict all live in the SDK; nothing here
 * grades anything or recounts a decision.
 */

/**
 * Seams for the CLI's own tests: a model double threaded into the SDK's
 * internal runner, and the working directory / environment the command
 * discovers configuration from. Production never sets these.
 */
export interface LocalTestDependencies {
  runtime?: SuiteFileRunnerRuntime;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type TestCommandOptions = SharedServerTargetOptions & {
  case?: string[];
  server?: string[];
  mcpConfig?: string;
  inference?: string;
  allowApproximated?: string[];
  approvalReason?: string;
  concurrency?: string;
  iterationTimeout?: string;
  maxSteps?: string;
  reporter?: string;
  out?: string;
  apiKey?: string;
  apiUrl?: string;
  apiHeader?: string[];
  project?: string;
};

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * The approval flags, parsed by the same rules `cloud eval run --file` uses —
 * its own parser, so the two cannot drift. (Its `--suite` check never fires:
 * this command has no `--suite`.) The SDK enforces eligibility itself.
 */
function parseLocalApprovals(options: {
  allowApproximated?: string[];
  approvalReason?: string;
}): RunSuiteFileOptions["importApprovals"] {
  const parsed = parseApprovalFlags(options);
  return parsed?.cases.map((caseId) => ({ caseId, reason: parsed.reason }));
}

function parseInferenceMode(
  value: string | undefined
): "auto" | "byok" | "mcpjam" {
  const mode = (value ?? "auto").trim();
  if (mode === "auto" || mode === "byok" || mode === "mcpjam") return mode;
  throw usageError(
    `--inference must be auto, byok or mcpjam (received ${JSON.stringify(
      value
    )}).`
  );
}

/** The file's bytes as text, refusing anything that is not valid UTF-8. */
function readSuiteFile(
  filePath: string,
  cwd: string
): { text: string; resolvedPath: string } {
  const resolvedPath = path.resolve(cwd, filePath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolvedPath);
  } catch (error) {
    throw usageError(
      `Cannot read suite file ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    // Fatal decoding, and a byte-order mark KEPT, so the text hashed
    // downstream is exactly the file's bytes — the digest `cloud eval run
    // --file` takes of the raw buffer. The loader reads past the mark.
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes
      ),
      resolvedPath,
    };
  } catch {
    throw usageError(`Suite file ${resolvedPath} is not valid UTF-8.`);
  }
}

function progressWriter(
  quiet: boolean
): (event: SuiteFileRunProgressEvent) => void {
  return (event) => {
    if (quiet) return;
    switch (event.type) {
      case "setup":
        if (event.stage === "connect" && event.server) {
          process.stderr.write(`Connecting to ${event.server}…\n`);
        } else if (event.stage === "lease" && event.model) {
          process.stderr.write(
            `Preparing MCPJam inference for ${event.model}…\n`
          );
        }
        return;
      case "caseStart":
        process.stderr.write(
          `Case ${event.index + 1}/${event.total}: ${event.caseId} (${
            event.iterations
          } iteration${event.iterations === 1 ? "" : "s"})\n`
        );
        return;
      default:
        return;
    }
  };
}

type AiSdkWarningLog = {
  warnings: Array<{
    type?: string;
    feature?: string;
    message?: string;
    details?: string;
  }>;
  provider?: string;
  model?: string;
};

/**
 * An AI SDK warning about the SDK's own internals rather than the user's
 * suite or credentials, so printing it only adds noise:
 *
 * - the provider-adapter `specificationVersion` compatibility notice;
 * - "The model "…" is unknown. The max output tokens have been limited to …".
 *   The AI SDK's built-in model table does not know gateway-style ids such as
 *   `anthropic/claude-haiku-4.5` (the MCPJam rail's), so it fires on every
 *   hosted-inference run, and no flag or file setting in `mcpjam test` can
 *   change it.
 */
export function isUnactionableAiSdkWarning(
  warning: AiSdkWarningLog["warnings"][number]
): boolean {
  if (
    warning.type === "compatibility" &&
    warning.feature === "specificationVersion"
  ) {
    return true;
  }
  return (
    typeof warning.message === "string" &&
    /is unknown\. The max output tokens have been limited to/.test(
      warning.message
    )
  );
}

/**
 * Route the AI SDK's warning log to stderr for the duration of a run.
 *
 * Left alone it prints with `console.info`/`console.warn`, and the first
 * banner lands on STDOUT — corrupting the one report document a pipeline
 * reads there. Each distinct warning is printed once; the ones nobody can act
 * on are dropped (see {@link isUnactionableAiSdkWarning}).
 */
function routeAiSdkWarnings(quiet: boolean): () => void {
  const holder = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
  const previous = holder.AI_SDK_LOG_WARNINGS;
  const seen = new Set<string>();
  holder.AI_SDK_LOG_WARNINGS = (log: AiSdkWarningLog) => {
    if (quiet) return;
    for (const warning of log.warnings ?? []) {
      if (isUnactionableAiSdkWarning(warning)) continue;
      const text =
        warning.message ??
        (warning.feature
          ? `"${warning.feature}" is not supported${
              warning.details ? `: ${warning.details}` : ""
            }`
          : JSON.stringify(warning));
      const line = `Model warning (${log.provider ?? "provider"} / ${
        log.model ?? "model"
      }): ${text}`;
      if (seen.has(line)) continue;
      seen.add(line);
      process.stderr.write(`${line}\n`);
    }
  };
  return () => {
    holder.AI_SDK_LOG_WARNINGS = previous;
  };
}

/**
 * One line per target server that asked for sign-in during the run: what it
 * refused and how to get it a credential. `mcpjam test` never signs in
 * itself; it names the command, and where the result is bound.
 */
export function localSignInHints(
  result: Pick<SuiteFileRunResult, "cases">,
  servers: RunSuiteFileOptions["servers"]
): string[] {
  const byServer = new Map<string, SuiteFileAuthRequired>();
  for (const entry of result.cases) {
    for (const iteration of entry.iterations) {
      const authRequired = iteration.authRequired;
      if (!authRequired?.server || byServer.has(authRequired.server)) continue;
      byServer.set(authRequired.server, authRequired);
    }
  }
  return [...byServer].map(([name, authRequired]) => {
    const binding = servers[name];
    const url =
      binding && "url" in binding.config && binding.config.url
        ? String(binding.config.url)
        : undefined;
    const requiredScope = displayableScope(
      authRequired.challenge.requiredScope
    );
    const lead = `Server "${name}" asked for sign-in when "${authRequired.toolName}" was called; a local run never signs in.`;
    // `--credentials-file` binds only the server `--url` names; every other
    // binding takes its credentials from its MCP config entry.
    if (binding?.source === "--url") {
      return `${lead} ${authChallengeHint(
        requiredScope !== undefined ? { requiredScope } : {},
        url
      )}`;
    }
    const scopes =
      requiredScope !== undefined ? ` --scopes "${requiredScope}"` : "";
    return `${lead} Sign in with \`mcpjam oauth login --url ${
      url ?? "<server-url>"
    }${scopes} --credentials-out <file>\`, then set "credentialsFile" to that file in the "${name}" entry of your MCP config.`;
  });
}

function refusalToCliError(error: SuiteFileRunError): CliError {
  return cliError(error.code, error.message, localTestExitCodeForError(error), {
    phase: error.phase,
    category: error.category,
    ...(error.details.problems ? { problems: error.details.problems } : {}),
  });
}

export function registerTestCommand(
  program: Command,
  dependencies: LocalTestDependencies = {}
): void {
  const command = program
    .command("test")
    .description(
      "Run a suite file locally against your MCP servers (BYOK or MCPJam-hosted inference). Results are never uploaded."
    )
    .argument(
      "<file>",
      "Suite file (YAML or JSON), e.g. .mcpjam/evals/example.yaml"
    )
    .option(
      "--case <id>",
      "Run only this case id (exact; repeatable)",
      collect,
      []
    )
    .option(
      "--server <name=url>",
      "Bind a target server to an HTTP(S) URL (repeatable; wins over MCP config files)",
      collect,
      []
    )
    .option(
      "--mcp-config <path>",
      "MCP JSON config to bind target servers from (before ./.mcp.json and ./.mcpjam/mcp.json)"
    )
    .option(
      "--host <template>",
      "Emulate this host template's handshake and settings (e.g. claude-code, chatgpt); never the real client"
    )
    .option("--inference <mode>", "auto (default), byok, or mcpjam")
    .option(
      "--allow-approximated <case>",
      "Approve an approximated imported case for this run (repeatable; needs --approval-reason)",
      collect,
      []
    )
    .option(
      "--approval-reason <text>",
      "Why the approximated cases may run (1-500 characters)"
    )
    .option(
      "--concurrency <n>",
      "Iterations of one case in flight at once (default 1)"
    )
    .option(
      "--iteration-timeout <ms>",
      "Per-iteration execution timeout in milliseconds (default 120000)"
    )
    .option("--max-steps <n>", "Model steps per prompt (default 10)")
    .option(
      "--reporter <format>",
      "Write a report to stdout: json-summary, junit-xml, or html"
    )
    .option(
      "--out <path>",
      "Write the report to this file (the --reporter format, or JSON)"
    );
  addProjectOption(addPlatformOptions(addSharedServerOptions(command)));

  command.action(
    async (file: string, options: TestCommandOptions, cmd: Command) => {
      const globalOptions = getGlobalOptions(cmd);
      const cwd = dependencies.cwd ?? process.cwd();
      const env = dependencies.env ?? process.env;

      // ── flags: usage errors exit 2 directly ────────────────────────────────
      const reporter: ReporterFormat | undefined = parseReporterFormat(
        options.reporter
      );
      const inferenceMode = parseInferenceMode(options.inference);
      if (options.host !== undefined) {
        // The existing conflict check (`--host` vs `--client-capabilities`) and
        // template vocabulary; the SDK resolves the template itself.
        resolveHostFromOptions({
          host: options.host,
          ...(options.clientCapabilities !== undefined
            ? { clientCapabilities: options.clientCapabilities }
            : {}),
        });
      }
      const approvals = parseLocalApprovals(options);
      const concurrency =
        options.concurrency !== undefined
          ? parsePositiveInteger(options.concurrency, "--concurrency")
          : undefined;
      const iterationTimeoutMs =
        options.iterationTimeout !== undefined
          ? parsePositiveInteger(
              options.iterationTimeout,
              "--iteration-timeout"
            )
          : undefined;
      const maxSteps =
        options.maxSteps !== undefined
          ? parsePositiveInteger(options.maxSteps, "--max-steps")
          : undefined;
      const caseIds =
        options.case && options.case.length > 0 ? options.case : undefined;
      const { text } = readSuiteFile(file, cwd);

      // Target names come from the file; the SDK re-validates everything.
      const loaded = loadEvalSuiteFile(text);
      const targetNames = loaded.ok
        ? (loaded.resolved.target.servers ?? []).map((server) => server.name)
        : [];

      const controller = new AbortController();
      const onSignal = (signal: NodeJS.Signals) => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        if (!globalOptions.quiet) {
          process.stderr.write(
            `\nReceived ${signal}; stopping and writing the partial report…\n`
          );
        }
        controller.abort(new Error(`interrupted by ${signal}`));
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      const restoreWarnings = routeAiSdkWarnings(globalOptions.quiet);

      let result: SuiteFileRunResult;
      let servers: RunSuiteFileOptions["servers"] = {};
      try {
        // A binding that cannot be SET UP (missing, unreadable config, unset
        // variable) is held back until the SDK has validated the file and every
        // selected case: an unsupported case or a bad flag is the more useful
        // thing to report, and exits 2 rather than 4. A binding USAGE error
        // (malformed --server, an unknown name) is reported at once.
        let bindingError: CliError | undefined;
        if (loaded.ok && targetNames.length > 0) {
          try {
            servers = resolveLocalServerBindings({
              targetNames,
              serverOverrides: options.server ?? [],
              ...(options.mcpConfig
                ? { mcpConfigPath: options.mcpConfig }
                : {}),
              singleServer: options,
              cwd,
              env,
              requestTimeoutMs: globalOptions.timeout,
            });
          } catch (error) {
            if (
              !(error instanceof CliError) ||
              error.exitCode === LOCAL_TEST_EXIT.usage
            ) {
              throw error;
            }
            bindingError = error;
          }
        }
        const runOptions: RunSuiteFileOptions = {
          servers,
          ...(caseIds ? { caseIds } : {}),
          inference: {
            mode: inferenceMode,
            providerKeys: readProviderKeys(env),
            baseUrls: readProviderBaseUrls(env),
            resolveMcpjam: createMcpjamConnectionResolver(
              {
                ...(options.apiKey ? { apiKey: options.apiKey } : {}),
                ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
                ...(options.apiHeader ? { apiHeader: options.apiHeader } : {}),
                ...(options.project ? { project: options.project } : {}),
              },
              {
                env,
                timeoutMs: globalOptions.timeout,
                signal: controller.signal,
              }
            ),
          },
          ...(options.host !== undefined
            ? { hostTemplateId: options.host }
            : {}),
          ...(approvals ? { importApprovals: approvals } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(iterationTimeoutMs !== undefined ? { iterationTimeoutMs } : {}),
          ...(maxSteps !== undefined ? { maxSteps } : {}),
          setupTimeoutMs: globalOptions.timeout,
          signal: controller.signal,
          // Progress is always stderr, so stdout stays one document.
          onProgress: progressWriter(globalOptions.quiet),
        };
        const runner = dependencies.runtime
          ? createSuiteFileRunner(dependencies.runtime)
          : { run: runSuiteFile };
        try {
          result = await runner.run(text, runOptions);
        } catch (error) {
          if (error instanceof SuiteFileRunError) {
            if (bindingError && error.code === "SERVER_BINDING_MISSING")
              throw bindingError;
            throw refusalToCliError(error);
          }
          // Unknown before any evidence came back: setup.
          throw cliError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
            LOCAL_TEST_EXIT.setup
          );
        }
      } catch (error) {
        if (error instanceof CliError) {
          writeError(error, globalOptions.format);
          setProcessExitCode(error.exitCode);
          return;
        }
        throw error;
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        restoreWarnings();
      }

      // ── output: exactly one report document on stdout ──────────────────────
      let artifactWriteFailed = false;
      let artifactPath: string | undefined;
      try {
        if (options.out) {
          try {
            artifactPath = await writeReporterArtifact(
              path.resolve(cwd, options.out),
              reporter ?? "json-summary",
              result.report
            );
          } catch (error) {
            artifactWriteFailed = true;
            writeError(error, globalOptions.format);
          }
        }
        const summary = formatLocalEvalRunSummary(result.report);
        if (reporter) {
          writeReporterResult(reporter, result.report);
          if (!globalOptions.quiet) process.stderr.write(`${summary}\n`);
        } else if (globalOptions.format === "json") {
          writeResult(renderStructuredRunJson(result.report), "json");
        } else {
          process.stdout.write(`${summary}\n`);
        }
        if (artifactPath && !globalOptions.quiet) {
          (reporter || globalOptions.format === "json"
            ? process.stderr
            : process.stdout
          ).write(`Report written to ${artifactPath}\n`);
        }
      } catch (error) {
        // A rendering failure after evidence came back establishes nothing.
        writeError(error, globalOptions.format);
        setProcessExitCode(LOCAL_TEST_EXIT.notEstablished);
        return;
      }
      // After the report, so stdout stays one document; reported, never a
      // changed exit code (see `SuiteFileRunIssue`).
      if (!globalOptions.quiet) {
        for (const hint of localSignInHints(result, servers)) {
          process.stderr.write(`${hint}\n`);
        }
      }
      const exitCode = localTestExitCodeForResult(result, {
        artifactWriteFailed,
      });
      setProcessExitCode(exitCode);
    }
  );
}
