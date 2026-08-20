/**
 * `mcpjam readiness claude|openai` — will a directory list this server?
 *
 * TWO MODES, and the difference is not a flag on one command but WHICH INPUTS
 * you give it:
 *
 *   --url          LOCAL. This process dials the server, grades it, prints the
 *                  verdict and exits. Nothing is stored, nothing is billed, no
 *                  account is needed. Intrusive probes are available here and
 *                  only here, because the person running them is the person
 *                  whose server is being probed.
 *
 *   --project/--server
 *                  HOSTED. The platform starts a durable, leased run against a
 *                  server you have already saved, and this polls it. Needs a
 *                  credential. This is the only mode that can spend, and only
 *                  when `--ai-observations` asks it to.
 *
 * WHY LOCAL CANNOT DO OBSERVATIONS. They need a broker to hold the provider
 * key, a lease to bill against, and an organization to bill to. A local run
 * has none of the three, so `--ai-observations` outside hosted mode is a usage
 * error rather than a silently ignored flag — a flag that looked accepted and
 * did nothing would read as "asked for and refused".
 *
 * EXIT CODES CARRY THE VERDICT. See `lib/readiness-exit-code.ts`; the short
 * version is that `incomplete` has its own code, because a run that could not
 * establish anything must never exit 0.
 */

import { Command } from "commander";
import {
  gatherClaudeReadinessEvidence,
  gatherOpenAIReadinessEvidence,
  gradeClaudeReadiness,
  gradeOpenAIReadiness,
  OPENAI_SUBMISSION_MODES,
  type OpenAISubmissionMode,
} from "@mcpjam/sdk";
import type {
  PlatformReadinessRun,
  PlatformReadinessSubmissionMode,
} from "@mcpjam/sdk/platform";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import {
  addPlatformOptions,
  type PlatformOptions,
} from "../lib/platform-command.js";
import {
  describeReadinessExit,
  readinessExitCode,
} from "../lib/readiness-exit-code.js";
import {
  renderReadinessForHuman,
  toReadinessStructuredReport,
  type ReadinessLaneLike,
  type ReadinessReportInput,
} from "../lib/readiness-output.js";
import { parseReporterFormat, writeReporterResult } from "../lib/reporting.js";
import { parseHeadersOption } from "../lib/server-config.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAccessToken,
} from "../lib/credentials-file.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";

/** The submission shapes a HOSTED run can grade; local can grade them all. */
const HOSTED_SUBMISSION_MODES = ["mcp-only", "mcp-imported-skills"] as const;

/** How often a hosted run is polled, and how long before this gives up. */
const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = 16 * 60_000;

interface ReadinessOptions {
  url?: string;
  project?: string;
  server?: string;
  submissionMode?: string;
  accessToken?: string;
  credentialsFile?: string;
  header?: string[];
  timeout?: number;
  aiObservations?: boolean;
  reporter?: string;
}

export function registerReadinessCommands(program: Command): void {
  const readiness = program
    .command("readiness")
    .description(
      "Grade an MCP server against a directory's submission requirements",
    );

  for (const publisher of ["claude", "openai"] as const) {
    const command = readiness
      .command(publisher)
      .description(
        publisher === "claude"
          ? "Grade a server against Anthropic's directory requirements"
          : "Grade a server against OpenAI's plugin-directory requirements",
      )
      .option(
        "--url <url>",
        "MCP server URL. Runs LOCALLY: free, nothing stored.",
      )
      .option(
        "--project <id-or-name>",
        "Run on MCPJam against a saved project server. Requires --server.",
      )
      .option(
        "--server <id-or-name>",
        "Saved server to grade. Only with --project.",
      )
      .option("--access-token <token>", "Bearer access token, local mode only")
      .option(
        "--credentials-file <path>",
        "Load an OAuth access token from a file created by oauth login",
      )
      .option(
        "--header <header>",
        'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--ai-observations",
        "Add model-written experience observations. HOSTED ONLY, and SPENDS MCPJam credits. Informational — observations never change a lane's status.",
      )
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary or junit-xml",
      );
    // Only meaningful in hosted mode, but declared unconditionally: a flag
    // that existed on one subcommand and not the other would make `--help`
    // read as though local runs could not be authenticated at all, when the
    // real rule is that they need no credential.
    addPlatformOptions(command);

    if (publisher === "openai") {
      command.option(
        "--submission-mode <mode>",
        `The DECLARED submission shape, REQUIRED. One of: ${OPENAI_SUBMISSION_MODES.join(
          ", ",
        )}. Never inferred — a run with no declared shape reports its package lane not-applicable, turning a missing input into a clean bill of health.`,
      );
    }

    command.action(async (options: ReadinessOptions, cmd: Command) => {
      await runReadinessCommand(publisher, options, cmd);
    });
  }

  registerRunsCommands(readiness);
}

/**
 * `readiness runs …` — the durable runs, after the fact.
 *
 * `readiness claude --project …` starts one and waits. These are for the other
 * shape of script: start a run in one job, read it in another, or look at what
 * a project has already graded without dialling anybody's server again. Every
 * one of them is a READ except `cancel`, and none of them can spend.
 */
function registerRunsCommands(readiness: Command): void {
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
      .option("--limit <n>", "Maximum runs to return (1-100)", (value) =>
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
          ? { readinessKind: parsePublisher(options.readinessKind) }
          : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      writeResult(page, resolveFormat(command));
    } catch (error) {
      throw toCliError(error);
    }
  });

  addPlatformOptions(
    runs
      .command("get")
      .description("Read one readiness run: lane statuses, coverage, AI axis")
      .requiredOption("--project <id-or-name>", "Project the run belongs to")
      .requiredOption("--run <id>", "Readiness run ID"),
  ).action(async (options, command: Command) => {
    const { client } = buildPlatformClient(
      command.optsWithGlobals() as PlatformOptions,
    );
    try {
      const run = await client.getReadinessRun({
        projectId: options.project,
        runId: options.run,
      });
      writeResult(run, resolveFormat(command));
      // The exit code carries the verdict here too, so `runs get` is usable as
      // a CI gate on a run some earlier job started.
      const code = readinessExitCode({
        overallStatus: run.overallStatus,
        runStatus: run.status,
        requestedObservations: run.includeLlmObservations,
        observationStatus: run.llmObservations?.status,
      });
      if (code !== 0) setProcessExitCode(code);
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
      // Always JSON: a report is per-finding evidence, and there is no useful
      // human rendering of it that is not just the JSON with the structure
      // taken out.
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
      writeResult(cancelled, resolveFormat(command));
    } catch (error) {
      throw toCliError(error);
    }
  });
}

function resolveFormat(command: Command): "json" | "human" {
  const opts = command.optsWithGlobals() as { format?: string };
  return opts.format === "human" ? "human" : "json";
}

function parsePublisher(value: string): "claude" | "openai" {
  if (value !== "claude" && value !== "openai") {
    throw usageError(`Unknown publisher: ${value}. Use claude or openai.`);
  }
  return value;
}

function parseRunLimit(value: string): number {
  const limit = Number(value);
  // An integer and a ceiling, not merely a number: the endpoint bounds it, and
  // failing here says which value was wrong rather than surfacing a 400.
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw usageError(`--limit must be an integer between 1 and 100.`);
  }
  return limit;
}

async function runReadinessCommand(
  publisher: "claude" | "openai",
  options: ReadinessOptions,
  command: Command,
): Promise<void> {
  const reporter = parseReporterFormat(options.reporter);
  const hosted = Boolean(options.project || options.server);

  if (hosted && options.url) {
    throw usageError(
      "Use --url for a local run OR --project/--server for a hosted one, not both. They dial the same kind of server but only one of them can bill, and guessing which you meant is not something this should do.",
    );
  }
  if (!hosted && !options.url) {
    throw usageError(
      "Provide --url for a local run, or --project and --server for a hosted one.",
    );
  }
  if (hosted && !(options.project && options.server)) {
    throw usageError("A hosted run needs both --project and --server.");
  }
  if (!hosted && options.aiObservations) {
    // Not silently ignored. Observations need a broker holding the provider
    // key, a lease to bill against and an organization to bill to; a local run
    // has none of the three, so the flag has nothing to switch on.
    throw usageError(
      "--ai-observations needs a hosted run: use --project and --server. A local run has no broker, no lease and no payer, so there is nothing for the flag to do.",
    );
  }

  const submissionMode = resolveSubmissionMode(publisher, options, hosted);
  const started = Date.now();

  const input = hosted
    ? await runHosted(publisher, options, command, submissionMode, started)
    : await runLocal(publisher, options, submissionMode, started);

  if (reporter) {
    writeReporterResult(reporter, toReadinessStructuredReport(input));
  } else {
    process.stdout.write(`${renderReadinessForHuman(input)}\n`);
  }

  const code = readinessExitCode({
    overallStatus: input.overallStatus,
    requestedObservations: input.requestedObservations,
    observationStatus: input.observations?.status as never,
  });
  // stderr, like every other advisory line here, so a `--reporter` stdout
  // stays parseable — and suppressed by `--quiet` for the same reason the
  // conformance score line is.
  const explanation = describeReadinessExit(
    code,
    failingLaneNames(input.lanes),
  );
  if (explanation && !command.optsWithGlobals().quiet) {
    process.stderr.write(`${explanation}\n`);
  }
  if (code !== 0) setProcessExitCode(code);
}

function failingLaneNames(lanes: ReadinessLaneLike[]): string | undefined {
  const names = lanes
    .filter((lane) => lane.status !== "ready")
    .map((lane) => lane.lane);
  return names.length > 0 ? names.join(", ") : undefined;
}

function resolveSubmissionMode(
  publisher: "claude" | "openai",
  options: ReadinessOptions,
  hosted: boolean,
): OpenAISubmissionMode | undefined {
  if (publisher === "claude") {
    if (options.submissionMode) {
      throw usageError(
        "--submission-mode is an OpenAI concept; Anthropic's directory declares no submission shape.",
      );
    }
    return undefined;
  }

  const mode = options.submissionMode?.trim();
  if (!mode) {
    throw usageError(
      `An OpenAI readiness run must declare its submission mode. One of: ${OPENAI_SUBMISSION_MODES.join(
        ", ",
      )}.`,
    );
  }
  if (!(OPENAI_SUBMISSION_MODES as readonly string[]).includes(mode)) {
    throw usageError(
      `Unknown submission mode: ${mode}. One of: ${OPENAI_SUBMISSION_MODES.join(
        ", ",
      )}.`,
    );
  }
  if (
    hosted &&
    !(HOSTED_SUBMISSION_MODES as readonly string[]).includes(mode)
  ) {
    // The package shapes need an archive on the caller's disk, which no hosted
    // run can reach. Refusing here names the local flag; letting it through
    // would produce a run whose package lane can never evaluate.
    throw usageError(
      `A hosted run cannot grade "${mode}": the archive lives on your disk, and only a local run (--url) can read it.`,
    );
  }
  return mode as OpenAISubmissionMode;
}

// ── Local ───────────────────────────────────────────────────────────────

async function runLocal(
  publisher: "claude" | "openai",
  options: ReadinessOptions,
  submissionMode: OpenAISubmissionMode | undefined,
  started: number,
): Promise<ReadinessReportInput> {
  const target = options.url!.trim();
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw usageError(`Invalid URL: ${target}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // Readiness grades what a HOST would see, and every host in question
    // reaches a server over HTTP. A stdio server is not a connector these
    // directories can list.
    throw usageError(
      `Directory readiness grades HTTP connectors; ${target} uses a different scheme.`,
    );
  }

  assertNoCredentialsFileAuthConflicts(options);
  const accessToken = options.credentialsFile
    ? resolveCredentialsFileAccessToken(options.credentialsFile, target)
    : options.accessToken;
  const headers: Record<string, string> = {
    ...(parseHeadersOption(options.header) ?? {}),
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const wire = Object.keys(headers).length > 0 ? headers : undefined;

  if (publisher === "openai") {
    const evidence = await gatherOpenAIReadinessEvidence({
      target,
      mode: submissionMode!,
      headers: wire,
      fetchFn: fetch,
    });
    const result = gradeOpenAIReadiness(evidence);
    return toReportInput(publisher, target, result, {
      submissionMode,
      started,
      requestedObservations: false,
    });
  }

  const evidence = await gatherClaudeReadinessEvidence({
    enteredUrl: target,
    headers: wire,
    fetchFn: fetch,
  });
  const result = gradeClaudeReadiness(evidence);
  return toReportInput(publisher, target, result, {
    started,
    requestedObservations: false,
  });
}

function toReportInput(
  publisher: "claude" | "openai",
  target: string,
  result: {
    status: "ready" | "not-ready" | "incomplete";
    lanes: Array<{
      lane: string;
      status: "ready" | "not-ready" | "incomplete";
      coverage: {
        evaluated: number;
        notEvaluated: number;
        notApplicable: number;
        missingInputs: string[];
      };
    }>;
    stages?: Array<{ stage: string; status: string; lanes: string[] }>;
    engineVersion?: string;
    policySnapshotDate?: string;
  },
  extra: {
    submissionMode?: string;
    started: number;
    requestedObservations: boolean;
  },
): ReadinessReportInput {
  return {
    publisher,
    target,
    overallStatus: result.status,
    // The lane's STATUS lives on the lane and its counts on `coverage`; a
    // renderer that read only the coverage would drop the verdict and report
    // every lane as unfinished.
    lanes: result.lanes.map((lane) => ({
      lane: lane.lane,
      status: lane.status,
      evaluated: lane.coverage.evaluated,
      notEvaluated: lane.coverage.notEvaluated,
      notApplicable: lane.coverage.notApplicable,
      missingInputs: lane.coverage.missingInputs,
    })),
    ...(result.stages ? { stages: result.stages } : {}),
    ...(extra.submissionMode ? { submissionMode: extra.submissionMode } : {}),
    ...(result.engineVersion ? { engineVersion: result.engineVersion } : {}),
    ...(result.policySnapshotDate
      ? { policySnapshotDate: result.policySnapshotDate }
      : {}),
    requestedObservations: extra.requestedObservations,
    durationMs: Date.now() - extra.started,
  };
}

// ── Hosted ──────────────────────────────────────────────────────────────

async function runHosted(
  publisher: "claude" | "openai",
  options: ReadinessOptions,
  command: Command,
  submissionMode: OpenAISubmissionMode | undefined,
  started: number,
): Promise<ReadinessReportInput> {
  const platformOptions = command.optsWithGlobals() as PlatformOptions;
  const { client } = buildPlatformClient(platformOptions);
  const requestedObservations = options.aiObservations === true;

  try {
    const receipt =
      publisher === "claude"
        ? await client.startClaudeReadinessRun({
            projectId: options.project!,
            serverId: options.server!,
            includeLlmObservations: requestedObservations,
          })
        : await client.startOpenAIReadinessRun({
            projectId: options.project!,
            serverId: options.server!,
            submissionMode: submissionMode as PlatformReadinessSubmissionMode,
            includeLlmObservations: requestedObservations,
          });

    const run = await pollHostedRun(
      client,
      options.project!,
      receipt.runId,
      receipt.status,
    );

    return {
      publisher,
      target: run.serverUrl,
      // A run that never finished has no verdict, and reporting the lanes it
      // happened to write would present a partial grade as a whole one.
      overallStatus: run.status === "completed" ? run.overallStatus : null,
      lanes: (run.lanes ?? []).map((lane) => ({
        lane: lane.lane,
        status: lane.status,
        evaluated: lane.evaluated,
        notEvaluated: lane.notEvaluated,
        notApplicable: lane.notApplicable,
        missingInputs: lane.missingInputs,
      })),
      ...(run.stages ? { stages: run.stages } : {}),
      ...(run.submissionMode ? { submissionMode: run.submissionMode } : {}),
      ...(run.engineVersion ? { engineVersion: run.engineVersion } : {}),
      ...(run.policySnapshotDate
        ? { policySnapshotDate: run.policySnapshotDate }
        : {}),
      observations: run.llmObservations,
      requestedObservations,
      runId: run.id,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    throw toCliError(error);
  }
}

async function pollHostedRun(
  client: ReturnType<typeof buildPlatformClient>["client"],
  projectId: string,
  runId: string,
  startStatus: string,
): Promise<PlatformReadinessRun> {
  // A replayed idempotency key can name a run that already finished, in which
  // case the first read IS the answer — but the read still happens, because
  // the receipt carries no lanes.
  void startStatus;
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
      // NOT a cancellation: the run keeps going server-side and the row stays
      // readable. This only stops waiting, and says so.
      process.stderr.write(
        `Stopped waiting after 16 minutes. The run is still going — read it with: mcpjam readiness ${
          run.readinessKind
        } --project ${projectId} --server ${run.serverId ?? "<server>"}\n`,
      );
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
