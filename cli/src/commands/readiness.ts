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
  hostedReadinessExitCode,
  reportReadinessGaps,
  reportReadinessVerdict,
} from "../lib/directory-readiness-exit-code.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import {
  addPlatformOptions,
  type PlatformOptions,
} from "../lib/platform-command.js";
import type {
  PlatformReadinessRun,
  PlatformReadinessSubmissionMode,
} from "@mcpjam/sdk/platform";
import { parseReporterFormat } from "../lib/reporting.js";
import {
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAccessToken,
} from "../lib/credentials-file.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";

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
 * Returns the group so the hosted run commands can be attached to the same
 * noun — `readiness check` and `readiness start` are two ways to grade one
 * thing, and splitting them across two top-level commands would make that a
 * detail the user has to know.
 */
export function registerReadinessCommands(program: Command): Command {
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
  return readiness;
}

// ── Hosted ──────────────────────────────────────────────────────────────

/**
 * `mcpjam readiness run|runs …` — the same grade, made durable.
 *
 * DELIBERATELY A SEPARATE GROUP FROM `check`, not a mode flag on it. The two
 * answer different questions and can disagree honestly: `check` grades what
 * the DEVELOPER'S MACHINE can reach — packages on disk, intrusive probes
 * against a server they own — while `run` grades the server as the PLATFORM
 * reaches it, from our egress, through the saved credential. Collapsing them
 * into one command with `--url` on one side and `--project/--server` on the
 * other would need a "you gave me both" error, and would let a reader think
 * one is a fallback for the other.
 *
 * WHAT HOSTED ADDS: the run survives the shell. It is leased, recovered by a
 * cron if the node dies, and readable later by id — so one CI job can start it
 * and another can gate on it. And it is the only place `--ai-observations` can
 * mean anything, because the broker, the lease and the payer live there.
 */
function registerHostedReadinessCommands(readiness: Command): void {
  const run = readiness
    .command("run")
    .description("Grade a saved project server on MCPJam (durable, needs auth)");

  for (const publisher of ["claude", "openai"] as const) {
    const command = run
      .command(publisher)
      .description(
        publisher === "claude"
          ? "Start a hosted Claude directory readiness run and wait for it"
          : "Start a hosted OpenAI plugin-directory readiness run and wait for it",
      )
      .requiredOption("--project <id-or-name>", "Project the server belongs to")
      .requiredOption("--server <id-or-name>", "Saved server to grade")
      .option(
        "--ai-observations",
        "Add model-written experience observations. SPENDS MCPJam credits, and is informational — observations never change a lane's status.",
      )
      .option(
        "--idempotency-key <key>",
        "Deduplicate a retried start. A readiness run dials a third party's server; a retry without this dials it twice.",
      )
      .option("--no-wait", "Print the run id and exit instead of polling")
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary or junit-xml",
      );

    if (publisher === "openai") {
      command.requiredOption(
        "--submission-mode <mode>",
        `Declared submission shape. Hosted runs grade ${HOSTED_SUBMISSION_MODES.join(
          " | ",
        )}; the package shapes are readable only by \`readiness check\`, which runs on your disk.`,
      );
    }

    addPlatformOptions(command).action(async (options, cmd: Command) => {
      await runHostedReadiness(publisher, options, cmd);
    });
  }

  registerReadinessRunsCommands(readiness);
}

/** The hosted submission shapes. The package ones live on `readiness check`. */
const HOSTED_SUBMISSION_MODES = ["mcp-only", "mcp-imported-skills"] as const;

/** Poll cadence, and how long before this stops waiting (never cancels). */
const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = 16 * 60_000;

interface HostedReadinessOptions {
  project: string;
  server: string;
  submissionMode?: string;
  aiObservations?: boolean;
  idempotencyKey?: string;
  wait?: boolean;
  reporter?: string;
}

async function runHostedReadiness(
  publisher: "claude" | "openai",
  options: HostedReadinessOptions,
  command: Command,
): Promise<void> {
  const reporter = parseReporterFormat(options.reporter);
  const requested = options.aiObservations === true;

  if (publisher === "openai") {
    const mode = options.submissionMode?.trim();
    if (!mode || !(HOSTED_SUBMISSION_MODES as readonly string[]).includes(mode)) {
      // Named rather than silently downgraded: the package shapes are not
      // unsupported, they live on the command that can read your disk.
      throw usageError(
        `A hosted run grades ${HOSTED_SUBMISSION_MODES.join(" or ")}. For a package shape use: mcpjam readiness check openai --submission-mode ${mode ?? "<mode>"} --package <path>`,
      );
    }
  }

  const { client } = buildPlatformClient(
    command.optsWithGlobals() as PlatformOptions,
  );

  try {
    const receipt =
      publisher === "claude"
        ? await client.startClaudeReadinessRun({
            projectId: options.project,
            serverId: options.server,
            includeLlmObservations: requested,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          })
        : await client.startOpenAIReadinessRun({
            projectId: options.project,
            serverId: options.server,
            submissionMode:
              options.submissionMode as PlatformReadinessSubmissionMode,
            includeLlmObservations: requested,
            ...(options.idempotencyKey
              ? { idempotencyKey: options.idempotencyKey }
              : {}),
          });

    if (options.wait === false) {
      // The run keeps going; this only declines to watch it. Printing the id
      // is the whole point — the other job reads it with `readiness runs get`.
      writeResult(receipt, resolveHostedFormat(command));
      return;
    }

    const run = await pollHostedReadinessRun(
      client,
      options.project,
      receipt.runId,
      command,
    );
    await emitHostedReadinessRun(client, options.project, run, reporter, command);
  } catch (error) {
    throw toCliError(error);
  }
}

async function pollHostedReadinessRun(
  client: ReturnType<typeof buildPlatformClient>["client"],
  projectId: string,
  runId: string,
  command: Command,
): Promise<PlatformReadinessRun> {
  const deadline = Date.now() + POLL_CEILING_MS;
  for (;;) {
    const run = await client.getReadinessRun({ projectId, runId });
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      return run;
    }
    if (Date.now() > deadline) {
      // NOT a cancellation: the run continues server-side and stays readable.
      // Say so, and say how to read it, rather than implying it was stopped.
      if (!command.optsWithGlobals().quiet) {
        process.stderr.write(
          `Stopped waiting after 16 minutes; the run is still going. Read it with: mcpjam readiness runs get --project ${projectId} --run ${runId}\n`,
        );
      }
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Render a finished hosted run the SAME way `check` renders a local one.
 *
 * The report blob IS the SDK result, so fetching it lets both halves of this
 * command group share one renderer and one set of verdict lines. A run with no
 * readable report still reports its lanes from the row — a partial rendering
 * of a real verdict, which beats printing nothing and beats pretending the run
 * failed.
 */
async function emitHostedReadinessRun(
  client: ReturnType<typeof buildPlatformClient>["client"],
  projectId: string,
  run: PlatformReadinessRun,
  reporter: ReturnType<typeof parseReporterFormat>,
  command: Command,
): Promise<void> {
  const format = getFormat(command, reporter);
  let result: unknown;
  if (run.status === "completed" && run.hasReport) {
    result = await client
      .getReadinessReport({ projectId, runId: run.id })
      .catch(() => undefined);
  }

  if (result) {
    writeReadinessOutput(
      renderConformanceForCli(result as never, reporter, format),
    );
    reportReadinessVerdict(result as never, command);
    reportReadinessGaps(result as never, command);
  } else {
    // No report to render: the row's lanes are still this run's verdict.
    writeResult(run, resolveHostedFormat(command));
  }

  reportObservationOutcome(run, command);
  const exitCode = hostedReadinessExitCode(run);
  if (exitCode !== 0) setProcessExitCode(exitCode);
}

/**
 * The observation axis, on stderr, beside the verdict rather than inside it.
 *
 * Printed only when the caller ASKED. A run that never opted in has
 * `not-requested` on this field forever, and announcing that on every free run
 * would train people to ignore the line that matters.
 */
function reportObservationOutcome(
  run: PlatformReadinessRun,
  command: Command,
): void {
  if (run.includeLlmObservations !== true) return;
  const status = run.llmObservations?.status;
  if (!status || status === "completed") return;
  if (command.optsWithGlobals().quiet) return;

  const why =
    run.llmObservations?.reason === "billing_limit_reached"
      ? "the MCPJam credit limit was reached"
      : (run.llmObservations?.detail ?? status);
  process.stderr.write(
    `AI observations were not produced: ${why}. The grade above is complete and unaffected.\n`,
  );
}

// ── `readiness runs …` ──────────────────────────────────────────────────

/**
 * Reading hosted runs after the fact.
 *
 * The other shape of script: start in one CI job, gate in another, or look at
 * what a project has already graded without dialling anybody's server again.
 * Every one is a read except `cancel`, and none of them can spend.
 */
function registerReadinessRunsCommands(readiness: Command): void {
  const runs = readiness
    .command("runs")
    .description("Read, list and cancel hosted readiness runs");

  addPlatformOptions(
    runs
      .command("list")
      .description("List a project's readiness runs, newest first")
      .requiredOption("--project <id-or-name>", "Project to list runs for")
      .option("--server <id-or-name>", "Only runs against this saved server")
      .option(
        "--readiness-kind <publisher>",
        "Only one publisher's runs: claude or openai",
      )
      .option("--limit <n>", "Maximum runs to return (1-100)", (value: string) =>
        parseRunLimit(value),
      ),
  ).action(async (options, command: Command) => {
    const { client } = buildPlatformClient(
      command.optsWithGlobals() as PlatformOptions,
    );
    try {
      const page = await client.listReadinessRuns({
        projectId: options.project,
        ...(options.server ? { serverId: options.server } : {}),
        ...(options.readinessKind
          ? { readinessKind: parseReadinessPublisher(options.readinessKind) }
          : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      writeResult(page, resolveHostedFormat(command));
    } catch (error) {
      throw toCliError(error);
    }
  });

  addPlatformOptions(
    runs
      .command("get")
      .description("Read one readiness run: lane statuses, coverage, AI axis")
      .requiredOption("--project <id-or-name>", "Project the run belongs to")
      .requiredOption("--run <id>", "Readiness run ID")
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary or junit-xml",
      ),
  ).action(async (options, command: Command) => {
    const { client } = buildPlatformClient(
      command.optsWithGlobals() as PlatformOptions,
    );
    try {
      const run = await client.getReadinessRun({
        projectId: options.project,
        runId: options.run,
      });
      // Carries the verdict in its EXIT CODE too, so this works as a CI gate
      // on a run some earlier job started.
      await emitHostedReadinessRun(
        client,
        options.project,
        run,
        parseReporterFormat(options.reporter),
        command,
      );
    } catch (error) {
      throw toCliError(error);
    }
  });

  addPlatformOptions(
    runs
      .command("report")
      .description("Fetch a finished run's full report — every finding")
      .requiredOption("--project <id-or-name>", "Project the run belongs to")
      .requiredOption("--run <id>", "Readiness run ID"),
  ).action(async (options, command: Command) => {
    const { client } = buildPlatformClient(
      command.optsWithGlobals() as PlatformOptions,
    );
    try {
      const report = await client.getReadinessReport({
        projectId: options.project,
        runId: options.run,
      });
      // Always JSON: a report is per-finding evidence, and there is no human
      // rendering of it that is not the JSON with its structure removed.
      writeResult(report, "json");
    } catch (error) {
      throw toCliError(error);
    }
  });

  addPlatformOptions(
    runs
      .command("cancel")
      .description("Stop an in-flight readiness run")
      .requiredOption("--project <id-or-name>", "Project the run belongs to")
      .requiredOption("--run <id>", "Readiness run ID"),
  ).action(async (options, command: Command) => {
    const { client } = buildPlatformClient(
      command.optsWithGlobals() as PlatformOptions,
    );
    try {
      const cancelled = await client.cancelReadinessRun({
        projectId: options.project,
        runId: options.run,
      });
      writeResult(cancelled, resolveHostedFormat(command));
    } catch (error) {
      throw toCliError(error);
    }
  });
}

function resolveHostedFormat(command: Command): "json" | "human" {
  const opts = command.optsWithGlobals() as { format?: string };
  return opts.format === "human" ? "human" : "json";
}

function parseReadinessPublisher(value: string): "claude" | "openai" {
  if (value !== "claude" && value !== "openai") {
    throw usageError(`Unknown publisher: ${value}. Use claude or openai.`);
  }
  return value;
}

function parseRunLimit(value: string): number {
  const limit = Number(value);
  // An integer AND a ceiling: the endpoint bounds it, and failing here names
  // the bad value instead of surfacing a 400 from a request nobody saw.
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw usageError("--limit must be an integer between 1 and 100.");
  }
  return limit;
}
