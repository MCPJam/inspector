/**
 * `mcpjam readiness check` — grade a connector or plugin locally.
 *
 * ## Why this runs the engine instead of calling the API
 *
 * The hosted endpoints exist and are bound elsewhere in this group, but they
 * cannot do what a local run can. Two of OpenAI's four submission shapes carry
 * a PACKAGE, and a package is bytes on the developer's disk — there is no
 * upload for it, deliberately, so those shapes only ever grade here. The
 * intrusive Claude probes are the same story from the other direction: they
 * register an OAuth client on the target, which is a thing to do to a server
 * you own from a machine you control, and never something a hosted worker
 * should do on somebody's behalf.
 *
 * So the split is not "local is the offline fallback". It is: this command
 * grades what only the developer's machine can reach, the hosted commands
 * grade the server as the PLATFORM reaches it, and the two answers are worth
 * having separately.
 *
 * ## The mode is declared, never inferred
 *
 * `--submission-mode` is required for OpenAI and the per-mode input rules
 * below are usage errors rather than silent adjustments. Inferring a mode from
 * which inputs happen to be present is the failure this whole product is
 * built to avoid: a forgotten `--package` would read as `mcp-only`, the
 * package lane would report `not-applicable`, and a submitter would be handed
 * a clean bill of health for an artifact nobody looked at.
 */

import { Command } from "commander";
import {
  collectZipArchiveObservations,
  createDirectoryPluginFileSource,
  createZipPluginFileSource,
  gatherClaudeReadinessEvidence,
  gatherOpenAIReadinessEvidence,
  gradeClaudeReadiness,
  gradeOpenAIReadiness,
  xmldomParseXml,
  OPENAI_SUBMISSION_MODES,
  OPENAI_SUBMISSION_MODE_SHAPES,
  type OpenAISubmissionMode,
} from "@mcpjam/sdk";
import { readFile, stat } from "node:fs/promises";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import {
  directoryReadinessExitCode,
  reportReadinessGaps,
  reportReadinessVerdict,
} from "../lib/directory-readiness-exit-code.js";
import { parseReporterFormat } from "../lib/reporting.js";
import {
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAccessToken,
} from "../lib/credentials-file.js";
import { setProcessExitCode, usageError } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import {
  cancelReadinessRunOperation,
  getReadinessReportOperation,
  getReadinessRunOperation,
  listReadinessRunsOperation,
  startClaudeReadinessRunOperation,
  startOpenAIReadinessRunOperation,
  type ListReadinessRunsInput,
  type ReadinessRunScopedInput,
  type StartClaudeReadinessInput,
  type StartOpenAIReadinessInput,
} from "@mcpjam/sdk/platform";

interface ReadinessCheckOptions {
  submissionMode?: string;
  package?: string;
  accessToken?: string;
  credentialsFile?: string;
  header?: string[];
  timeout?: number;
  reporter?: string;
}

function getFormat(
  command: Command,
  reporter: ReturnType<typeof parseReporterFormat>,
): ConformanceOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return resolveConformanceOutputFormatForCli(
    opts.format,
    process.stdout.isTTY,
    reporter,
  );
}

function writeReadinessOutput(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

/** The bearer a credentialed target needs, from either source but not both. */
function resolveAccessToken(
  options: ReadinessCheckOptions,
  target: string,
): string | undefined {
  assertNoCredentialsFileAuthConflicts(options);
  if (options.credentialsFile) {
    return resolveCredentialsFileAccessToken(options.credentialsFile, target);
  }
  return options.accessToken?.trim() || undefined;
}

function requestHeaders(
  options: ReadinessCheckOptions,
  target: string,
): Record<string, string> | undefined {
  const headers = { ...(parseHeadersOption(options.header) ?? {}) };
  const token = resolveAccessToken(options, target);
  if (token) headers.authorization = `Bearer ${token}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * A directory or a `.zip`, decided by what is on disk rather than by suffix.
 *
 * A submitter who points this at the folder they are about to zip should get
 * the same grade as one who points it at the archive, and a suffix check would
 * refuse the first for no reason.
 */
async function openPackage(path: string): Promise<{
  // Inferred rather than named: `PluginFileSource` is deliberately not part of
  // the SDK's public surface, and widening that surface for one annotation
  // would be the tail wagging the dog.
  source: ReturnType<typeof createDirectoryPluginFileSource>;
  archive?: Awaited<ReturnType<typeof collectZipArchiveObservations>>;
}> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw usageError(`Package path "${path}" does not exist.`);
  }

  if (info.isDirectory()) {
    // A directory has no compressed size and no raw entry table, so the
    // archive-shaped checks report their gaps rather than inventing an
    // answer — which is the honest grade for something that is not an archive
    // yet.
    return { source: createDirectoryPluginFileSource(path) };
  }

  const bytes = new Uint8Array(await readFile(path));
  return {
    source: await createZipPluginFileSource(bytes),
    // The RAW central directory, read before the zip library normalizes it:
    // the portal rejects backslashes, `..` and duplicate names, and a loader
    // that repairs those on the way in would grade a table with the
    // violations already fixed out of it.
    archive: await collectZipArchiveObservations(bytes),
  };
}

/**
 * Per-mode input rules, enforced as usage errors.
 *
 * Read off `OPENAI_SUBMISSION_MODE_SHAPES` rather than restated here, so a
 * fifth mode cannot arrive with this command quietly accepting the wrong
 * inputs for it.
 */
function assertModeInputs(
  mode: OpenAISubmissionMode,
  target: string | undefined,
  packagePath: string | undefined,
): void {
  const shape = OPENAI_SUBMISSION_MODE_SHAPES[mode];

  if (shape.hasMcpServer && !target) {
    throw usageError(
      `Submission mode "${mode}" grades an MCP server; pass its URL as the argument.`,
    );
  }
  if (!shape.hasMcpServer && target) {
    throw usageError(
      `Submission mode "${mode}" grades a package only; drop the URL argument.`,
    );
  }
  if (shape.hasUploadedPackage && !packagePath) {
    throw usageError(
      `Submission mode "${mode}" grades an uploaded package; pass --package <dir|zip>.`,
    );
  }
  if (!shape.hasUploadedPackage && packagePath) {
    throw usageError(
      `Submission mode "${mode}" does not upload a package; drop --package.`,
    );
  }
}

async function runClaudeCheck(
  target: string,
  options: ReadinessCheckOptions,
  command: Command,
): Promise<void> {
  const reporter = parseReporterFormat(options.reporter);
  const format = getFormat(command, reporter);

  const evidence = await gatherClaudeReadinessEvidence({
    enteredUrl: target,
    // The global fetch, on purpose. A hosted run pins DNS because it dials on
    // somebody else's behalf from shared infrastructure; this one dials from
    // the developer's own machine, where pinning would only stop them from
    // grading a server on their own network.
    fetchFn: fetch,
    headers: requestHeaders(options, target),
    timeoutMs: options.timeout,
  });

  const result = gradeClaudeReadiness(evidence);
  writeReadinessOutput(renderConformanceForCli(result, reporter, format));
  reportReadinessVerdict(result, command);
  reportReadinessGaps(result, command);

  const exitCode = directoryReadinessExitCode(result);
  if (exitCode !== 0) setProcessExitCode(exitCode);
}

async function runOpenAICheck(
  target: string | undefined,
  options: ReadinessCheckOptions,
  command: Command,
): Promise<void> {
  const reporter = parseReporterFormat(options.reporter);
  const format = getFormat(command, reporter);

  if (!options.submissionMode) {
    throw usageError(
      `--submission-mode is required and is never inferred. One of: ${OPENAI_SUBMISSION_MODES.join(
        ", ",
      )}.`,
    );
  }
  if (
    !(OPENAI_SUBMISSION_MODES as readonly string[]).includes(
      options.submissionMode,
    )
  ) {
    throw usageError(
      `Unknown submission mode "${
        options.submissionMode
      }". One of: ${OPENAI_SUBMISSION_MODES.join(", ")}.`,
    );
  }
  const mode = options.submissionMode as OpenAISubmissionMode;
  assertModeInputs(mode, target, options.package);

  const pkg = options.package ? await openPackage(options.package) : undefined;

  const evidence = await gatherOpenAIReadinessEvidence({
    // A package-only run has no server; the target names the artifact so the
    // report says what was graded.
    target: target ?? options.package ?? "package",
    mode,
    // Absent for a package-only run, and absent means "dialled nothing" rather
    // than "found nothing" — the wire lanes report their gaps.
    fetchFn: target ? fetch : undefined,
    headers: target ? requestHeaders(options, target) : undefined,
    timeoutMs: options.timeout,
    packageSource: pkg?.source,
    archive: pkg?.archive,
    // Without an XML parser the SVG assets are recorded as a gap rather than
    // graded, so it is passed even when no package is supplied — costing
    // nothing and removing one way to produce a quietly weaker grade.
    parseXml: xmldomParseXml,
  });

  const result = gradeOpenAIReadiness(evidence);
  writeReadinessOutput(renderConformanceForCli(result, reporter, format));
  reportReadinessVerdict(result, command);
  reportReadinessGaps(result, command);

  const exitCode = directoryReadinessExitCode(result);
  if (exitCode !== 0) setProcessExitCode(exitCode);
}

/**
 * Register the `readiness` group and its local `check` command.
 *
 * Hosted run commands attach to the same noun in this function —
 * `readiness check` and `readiness start` are two ways to grade one
 * thing, and splitting them across two top-level commands would make that a
 * detail the user has to know.
 */
export function registerReadinessCommands(program: Command): void {
  const readiness = program
    .command("readiness")
    .description("Grade a server or plugin against a publisher's directory");

  const check = readiness
    .command("check")
    .description("Grade locally, without a MCPJam account (free)");

  check
    .command("claude")
    .description("Grade an MCP server against Anthropic's connector directory")
    .argument("<url>", "MCP server URL")
    .option("--access-token <token>", "Bearer access token for the server")
    .option(
      "--credentials-file <path>",
      "Load the access token from a file written by oauth login",
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--timeout <ms>",
      "Per-request timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Timeout"),
    )
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(async (url: string, options: ReadinessCheckOptions, command) => {
      await runClaudeCheck(url, options, command);
    });

  check
    .command("openai")
    .description("Grade a server or plugin against OpenAI's app directory")
    .argument(
      "[url]",
      "MCP server URL. Omit for a package-only submission shape.",
    )
    .requiredOption(
      "--submission-mode <mode>",
      `Declared submission shape: ${OPENAI_SUBMISSION_MODES.join(" | ")}`,
    )
    .option("--package <path>", "Plugin package directory or .zip to grade")
    .option("--access-token <token>", "Bearer access token for the server")
    .option(
      "--credentials-file <path>",
      "Load the access token from a file written by oauth login",
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--timeout <ms>",
      "Per-request timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Timeout"),
    )
    .option(
      "--reporter <reporter>",
      "Structured reporter output: json-summary or junit-xml",
    )
    .action(
      async (
        url: string | undefined,
        options: ReadinessCheckOptions,
        command,
      ) => {
        await runOpenAICheck(url, options, command);
      },
    );

  registerHostedReadinessCommands(readiness);
}

/**
 * The hosted half: the same grade, run by the platform.
 *
 * NOT a remote copy of `check`. A hosted run reaches the server through the
 * SAVED row and the authorize exchange, which is how the platform itself
 * reaches it — a different question from "can this machine grade it", and the
 * only one whose answer predicts what a hosted host will see. It is also the
 * only half that can spend for optional model observations, and the only one
 * that leaves a record to come back to.
 *
 * Every command here returns immediately. A run takes minutes, so `start`
 * hands back an id and says to poll, exactly as `journeys run` does — no
 * `--wait` in this version, because a flag that blocks a terminal for fifteen
 * minutes deserves its own design rather than a default.
 */
interface HostedStartOptions extends PlatformOptions {
  project?: string;
  server: string;
  /**
   * Commander guarantees this for the OpenAI start via `requiredOption`, so
   * the operation's own enum is what validates the VALUE — a bad mode is a
   * schema error naming the legal ones, which beats a hand-rolled check that
   * would drift from the union it copies.
   */
  submissionMode: HostedSubmissionMode;
  aiObservations?: boolean;
  idempotencyKey?: string;
}

/** The two shapes a hosted run can grade; the package pair is CLI-local. */
type HostedSubmissionMode = "mcp-only" | "mcp-imported-skills";

interface HostedRunOptions extends PlatformOptions {
  project?: string;
  run: string;
}

interface HostedListOptions extends PlatformOptions {
  project?: string;
  kind?: "claude" | "openai";
  server?: string;
  limit?: number;
}

function registerHostedReadinessCommands(readiness: Command): void {
  const start = readiness
    .command("start")
    .description("Start a hosted readiness run against a saved server");

  const startClaude = addProjectOption(
    start
      .command("claude")
      .description("Grade a saved server against Anthropic's directory")
      .requiredOption("--server <idOrName>", "Saved server to grade")
      .option(
        "--ai-observations",
        "Add optional model observations. CONSUMES MCPJam credits.",
      )
      .option("--idempotency-key <key>", "Replay guard for a retried start"),
  );
  bindOperation<HostedStartOptions, StartClaudeReadinessInput>(
    startClaude,
    startClaudeReadinessRunOperation,
    (options) => ({
      project: options.project,
      server: options.server,
      ...(options.aiObservations ? { includeLlmObservations: true } : {}),
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    }),
  );

  const startOpenAI = addProjectOption(
    start
      .command("openai")
      .description("Grade a saved server against OpenAI's directory")
      .requiredOption("--server <idOrName>", "Saved server to grade")
      .requiredOption(
        "--submission-mode <mode>",
        "Declared submission shape: mcp-only | mcp-imported-skills. Never inferred. Package shapes run locally — see `readiness check openai`.",
      )
      .option(
        "--ai-observations",
        "Add optional model observations. CONSUMES MCPJam credits.",
      )
      .option("--idempotency-key <key>", "Replay guard for a retried start"),
  );
  bindOperation<HostedStartOptions, StartOpenAIReadinessInput>(
    startOpenAI,
    startOpenAIReadinessRunOperation,
    (options) => ({
      project: options.project,
      server: options.server,
      submissionMode: options.submissionMode,
      ...(options.aiObservations ? { includeLlmObservations: true } : {}),
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
    }),
  );

  const status = addProjectOption(
    readiness
      .command("status")
      .description("Read one hosted readiness run")
      .requiredOption("--run <id>", "Readiness run id"),
  );
  bindOperation<HostedRunOptions, ReadinessRunScopedInput>(
    status,
    getReadinessRunOperation,
    (options) => ({ project: options.project, run: options.run }),
  );

  const list = addProjectOption(
    readiness
      .command("list")
      .description("List hosted readiness runs, newest first")
      .option("--kind <publisher>", "Narrow to claude or openai")
      .option("--server <idOrName>", "Narrow to one saved server")
      .option("--limit <n>", "Rows to return (1-100)", (value: string) =>
        parsePositiveInteger(value, "Limit"),
      ),
  );
  bindOperation<HostedListOptions, ListReadinessRunsInput>(
    list,
    listReadinessRunsOperation,
    (options) => ({
      project: options.project,
      ...(options.kind ? { readinessKind: options.kind } : {}),
      ...(options.server ? { server: options.server } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }),
  );

  const cancel = addProjectOption(
    readiness
      .command("cancel")
      .description("Stop a hosted readiness run that is still going")
      .requiredOption("--run <id>", "Readiness run id"),
  );
  bindOperation<HostedRunOptions, ReadinessRunScopedInput>(
    cancel,
    cancelReadinessRunOperation,
    (options) => ({ project: options.project, run: options.run }),
  );

  const report = addProjectOption(
    readiness
      .command("report")
      .description("Read a finished hosted run's findings")
      .requiredOption("--run <id>", "Readiness run id"),
  );
  bindOperation<HostedRunOptions, ReadinessRunScopedInput>(
    report,
    getReadinessReportOperation,
    (options) => ({ project: options.project, run: options.run }),
  );
}
