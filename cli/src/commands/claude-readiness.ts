import {
  runClaudeReadiness,
  type ClaudeReadinessResult,
  type ClaudeRunnerCapability,
} from "@mcpjam/sdk";
import {
  cancelClaudeReadinessRunOperation,
  getClaudeReadinessRunOperation,
  listClaudeReadinessRunsOperation,
  requestClaudeReadinessRunOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import {
  addPlatformOptions,
  parseIntegerOption,
  runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";
import { Command } from "commander";
import { readFile } from "node:fs/promises";

import {
  renderConformanceReporterResult,
  resolveConformanceOutputFormatForCli,
  type ConformanceOutputFormat,
} from "../lib/conformance-output.js";
import { parseReporterFormat, type ReporterFormat } from "../lib/reporting.js";
import {
  parseHeadersOption,
  parsePositiveInteger,
} from "../lib/server-config.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAccessToken,
} from "../lib/credentials-file.js";
import { setProcessExitCode, usageError } from "../lib/output.js";

/** The list operation's page cap, restated so `--limit` fails locally. */
const MAX_LIST_LIMIT = 100;

/** The request operation's key bound, restated for the same reason. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Trim-and-bound `--idempotency-key` the way the operation does.
 *
 * `--idempotency-key ""` is the case that matters: an empty string is not
 * "no key", so it would travel as a key, be rejected by a zod bound after the
 * project lookup, and report a field name nobody typed. Trimming here also
 * means a key pasted with a trailing newline matches the one sent before it.
 */
function parseIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw usageError("--idempotency-key must not be empty");
  }
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw usageError(
      `--idempotency-key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return trimmed;
}

export interface ClaudeReadinessOptions {
  url: string;
  accessToken?: string;
  credentialsFile?: string;
  header?: string[];
  timeout?: number;
  submissionProfile?: string;
  claimLazyAuth?: boolean;
  claimEnterpriseAuth?: boolean;
}

/**
 * Exit code for a readiness run.
 *
 * Keyed to the REQUIRED lanes only, and matching the conformance ladder so one
 * CI configuration reads both: `0` ready, `1` a requirement is unmet, `3` the
 * run could not establish readiness. Heuristics, badges and manual-review items
 * never move it — a job that goes red on an LLM's opinion gets `|| true`
 * appended, and then the real findings stop being read too.
 */
export function claudeReadinessExitCode(result: {
  status: "ready" | "not-ready" | "incomplete";
}): number {
  if (result.status === "not-ready") return 1;
  if (result.status === "incomplete") return 3;
  return 0;
}

/**
 * The human rendering.
 *
 * Lanes first, because the lane statuses ARE the product; coverage beside each
 * one, because a lane with no violations and nothing evaluated is not a pass
 * and the numbers are what say so.
 */
function renderHuman(result: ClaudeReadinessResult): string {
  const lines: string[] = [];
  lines.push(`Claude directory readiness: ${result.status.toUpperCase()}`);
  lines.push(result.summary);
  lines.push("");
  lines.push(
    `Target ${result.context.target} · auth ${result.context.authMode} · policy snapshot ${result.policySnapshotDate}`
  );
  lines.push(
    `Runner capabilities: ${result.context.capabilities.join(", ") || "none"}`
  );
  lines.push("");

  for (const lane of result.lanes) {
    const { evaluated, notEvaluated, notApplicable, missingInputs } =
      lane.coverage;
    lines.push(`[${lane.status}] ${lane.lane}`);
    lines.push(`    ${lane.summary}`);
    lines.push(
      `    evaluated ${evaluated} · not evaluated ${notEvaluated} · not applicable ${notApplicable}`
    );
    if (missingInputs.length > 0) {
      lines.push(`    supply to close: ${missingInputs.join(", ")}`);
    }
  }

  const violations = result.findings.filter(
    (finding) =>
      finding.status === "violated" &&
      (finding.class === "required" || finding.class === "runtime-blocker")
  );
  if (violations.length > 0) {
    lines.push("");
    lines.push(`Unmet requirements (${violations.length}):`);
    for (const finding of violations) {
      lines.push(`  ✗ ${finding.title}`);
      if (finding.remediation) lines.push(`    ${finding.remediation}`);
      lines.push(`    ${finding.source.page} → ${finding.source.section}`);
    }
  }

  const advisories = result.findings.filter(
    (finding) =>
      finding.status === "violated" &&
      finding.class !== "required" &&
      finding.class !== "runtime-blocker"
  );
  if (advisories.length > 0) {
    lines.push("");
    // Explicitly labelled as not affecting the verdict, so nobody reads the
    // list as a second failure column.
    lines.push(`Advisories (${advisories.length}, no effect on the verdict):`);
    for (const finding of advisories) {
      lines.push(`  · [${finding.class}] ${finding.title}`);
    }
  }

  if (result.badges.length > 0) {
    lines.push("");
    lines.push("Capability badges:");
    for (const badge of result.badges) {
      lines.push(
        `  ${badge.title}: ${badge.state}${
          badge.detail ? ` — ${badge.detail}` : ""
        }`
      );
    }
  }

  return lines.join("\n");
}

function render(
  result: ClaudeReadinessResult,
  reporter: ReporterFormat | undefined,
  format: ConformanceOutputFormat
): string {
  if (reporter) return renderConformanceReporterResult(result, reporter);
  return format === "human" ? renderHuman(result) : JSON.stringify(result);
}

/**
 * The hosted half: run a platform operation and print its result.
 *
 * Separate from the local grade above because they answer different questions.
 * `claude readiness` grades a URL from THIS machine and exits on the verdict —
 * that is the CI shape. `claude runs …` asks the platform to grade a SAVED
 * server and records the result in the project's history, which is what the
 * product surfaces render. A local run cannot do the second, and a hosted run
 * cannot grade a URL nobody saved.
 */
async function executeOp<TInput, TOutput>(
  op: PlatformOperation<TInput, TOutput>,
  input: TInput,
  options: PlatformOptions,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const result = await runPlatformCommand(
    options,
    globalOptions.timeout,
    ({ client, signal }) => op.execute(input, { client, signal }),
  );
  writeResult(result, globalOptions.format);
}

export function registerClaudeReadinessCommands(program: Command): void {
  const claude = program
    .command("claude")
    .description("Claude connector-directory readiness");

  claude
    .command("readiness")
    .description(
      "Grade an MCP server against Anthropic's connector-directory requirements"
    )
    .requiredOption(
      "--url <url>",
      "Connector URL, exactly as you would submit it"
    )
    .option("--access-token <token>", "Bearer access token for HTTP servers")
    .option(
      "--credentials-file <path>",
      "Load an OAuth access token from a file created by oauth login"
    )
    .option(
      "--header <header>",
      'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
      (value: string, previous: string[] = []) => [...previous, value],
      []
    )
    .option(
      "--timeout <ms>",
      "Per-request timeout in milliseconds",
      (value: string) => parsePositiveInteger(value, "Timeout"),
      20_000
    )
    .option(
      "--submission-profile <path>",
      "JSON file describing the listing you intend to submit. Without it the submission-artifacts lane reports incomplete — none of those fields can be inferred from the wire."
    )
    .option(
      "--claim-lazy-auth",
      "Declare that this connector supports lazy authentication"
    )
    .option(
      "--claim-enterprise-auth",
      "Declare that this connector supports enterprise-managed authentication"
    )
    .option("--reporter <format>", "junit-xml | json-summary")
    .action(async function readinessAction(
      this: Command,
      options: ClaudeReadinessOptions
    ) {
      // `--format` is the CLI-wide output flag and `--reporter` is per-command,
      // the same split every other conformance command uses. A local
      // `--output` here would be a third spelling, and the one the rest of the
      // CLI documents would be silently ignored.
      const globals = this.optsWithGlobals() as {
        format?: string;
        reporter?: string;
      };
      const reporter = globals.reporter
        ? parseReporterFormat(globals.reporter)
        : undefined;
      const format = resolveConformanceOutputFormatForCli(
        globals.format,
        process.stdout.isTTY,
        reporter
      );

      assertNoCredentialsFileAuthConflicts({
        credentialsFile: options.credentialsFile,
        accessToken: options.accessToken,
      });
      const accessToken =
        options.accessToken ??
        (options.credentialsFile
          ? resolveCredentialsFileAccessToken(
              options.credentialsFile,
              options.url
            )
          : undefined);

      let submissionProfile: unknown;
      // PRESENCE, not truthiness. `--submission-profile ""` is a path the
      // caller supplied and got wrong; skipping it on falsiness reported the
      // lane as "no profile supplied", which reads as our limitation rather
      // than their typo.
      if (options.submissionProfile !== undefined) {
        // Read but NOT validated here: a malformed profile becomes findings in
        // the submission-artifacts lane, which tells the submitter which field
        // is wrong. Rejecting it at the CLI boundary would replace that with
        // "invalid JSON" and lose the rest of the run.
        try {
          submissionProfile = JSON.parse(
            await readFile(options.submissionProfile, "utf8")
          );
        } catch (error) {
          throw usageError(
            `Could not read --submission-profile: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // LOCAL-FIRST, and honest about it: the CLI runs on a laptop, so it has
      // DNS and it does not have an interactive browser flow or the intrusive
      // opt-in. Recording that is what makes the resulting `incomplete`
      // self-describing rather than mysterious.
      const capabilities: ClaudeRunnerCapability[] = ["dns", "raw-origin"];

      const result = await runClaudeReadiness({
        serverUrl: options.url,
        // The plain global fetch: a CLI dialling localhost is the product, and
        // the pinned transport exists for the hosted node, not for a laptop.
        fetchFn: fetch,
        accessToken,
        customHeaders: parseHeadersOption(options.header),
        timeoutMs: options.timeout,
        submissionProfile,
        claimedFeatures: {
          lazyAuthentication: options.claimLazyAuth,
          enterpriseManagedAuth: options.claimEnterpriseAuth,
        },
        capabilities,
      });

      process.stdout.write(`${render(result, reporter, format)}\n`);
      setProcessExitCode(claudeReadinessExitCode(result));
    });

  // ── Hosted runs ────────────────────────────────────────────────────────
  //
  // A sibling group rather than subcommands of `readiness`: that command is a
  // leaf with its own action, and hanging `start`/`status` off it would make
  // `claude readiness --url …` and `claude readiness status …` look like the
  // same operation with a flag.
  const runs = claude
    .command("runs")
    .description("Readiness runs recorded on the MCPJam platform");

  addPlatformOptions(
    runs
      .command("start")
      .description(
        "Queue a readiness grade for a saved server. Returns as soon as the run is queued — poll `claude runs status`.",
      )
      .requiredOption("--server <id>", "Saved server ID. Its URL is graded.")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .option(
        "--idempotency-key <key>",
        "Replay protection. A retry with the same key joins the run it already started instead of dialling the target twice.",
        parseIdempotencyKey,
      ),
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        server: string;
        idempotencyKey?: string;
      },
      command: Command,
    ) => {
      await executeOp(
        requestClaudeReadinessRunOperation,
        {
          project: options.project,
          serverId: options.server,
          ...(options.idempotencyKey !== undefined
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
        },
        options,
        command,
      );
    },
  );

  addPlatformOptions(
    runs
      .command("list")
      .description("List recent readiness runs, newest first")
      .requiredOption("--project <id-or-name>", "Project name or ID")
      .option("--server <id>", "Only runs for this saved server")
      .option(
        "--limit <n>",
        "How many runs to return (1–100)",
        // The operation's own bounds, restated so an out-of-range number is
        // refused here rather than after a round trip that names a field the
        // user never typed. `parsePositiveInteger` alone accepts 5000.
        (value: string) =>
          parseIntegerOption(value, "--limit", { min: 1, max: MAX_LIST_LIMIT }),
      ),
  ).action(
    async (
      options: PlatformOptions & {
        project: string;
        server?: string;
        limit?: number;
      },
      command: Command,
    ) => {
      await executeOp(
        listClaudeReadinessRunsOperation,
        {
          project: options.project,
          ...(options.server !== undefined ? { serverId: options.server } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        },
        options,
        command,
      );
    },
  );

  addPlatformOptions(
    runs
      .command("status")
      .description(
        "Read one readiness run. `status` is the run's lifecycle; `overallStatus` is the verdict, and is absent until it finishes.",
      )
      .requiredOption("--run <id>", "Readiness run ID (from `claude runs start`)")
      .requiredOption("--project <id-or-name>", "Project name or ID"),
  ).action(
    async (
      options: PlatformOptions & { project: string; run: string },
      command: Command,
    ) => {
      await executeOp(
        getClaudeReadinessRunOperation,
        { project: options.project, runId: options.run },
        options,
        command,
      );
    },
  );

  addPlatformOptions(
    runs
      .command("cancel")
      .description(
        "Stop a run that is still queued or executing. It ends `cancelled` and is never reported as a failure of the connector.",
      )
      .requiredOption("--run <id>", "Readiness run ID")
      .requiredOption("--project <id-or-name>", "Project name or ID"),
  ).action(
    async (
      options: PlatformOptions & { project: string; run: string },
      command: Command,
    ) => {
      await executeOp(
        cancelClaudeReadinessRunOperation,
        { project: options.project, runId: options.run },
        options,
        command,
      );
    },
  );
}
