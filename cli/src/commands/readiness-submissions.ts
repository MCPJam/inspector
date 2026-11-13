/**
 * `mcpjam readiness flows` and `mcpjam readiness submission …`: read a
 * directory's submission form, keep a rehearsal of it for a saved server, and
 * grade that rehearsal on the platform.
 *
 * Each command is a bound platform operation, so it answers as the REST API
 * and the MCP tools do. `run --wait` is the addition: it polls the run and
 * exits with the readiness codes, 0 ready, 1 not ready and 3 incomplete.
 */
import type { Command } from "commander";
import {
  createDirectorySubmissionOperation,
  deleteDirectorySubmissionOperation,
  directorySubmissionConflict,
  getDirectoryFlowOperation,
  getDirectorySubmissionOperation,
  getDirectorySubmissionResultsOperation,
  listDirectoryFlowsOperation,
  listDirectorySubmissionsOperation,
  startDirectorySubmissionRunOperation,
  updateDirectorySubmissionOperation,
  type PlatformApiClient,
  type PlatformReadinessRun,
  type UpdateDirectorySubmissionInput,
} from "@mcpjam/sdk/platform";
import { directoryReadinessExitCode, reportReadinessVerdict } from "../lib/directory-readiness-exit-code.js";
import { CliError, setProcessExitCode, usageError, writeResult } from "../lib/output.js";
import {
  addPlatformOptions,
  addProjectOption,
  bindOperation,
  platformOptionsOf,
  runPlatformOperation,
  type PlatformOptions,
  type RunPlatformOperationExtras,
} from "../lib/platform-command.js";
import { getGlobalOptions, parsePositiveInteger } from "../lib/server-config.js";
import { collectRepeated } from "./readiness-lazy-auth.js";

type Options = PlatformOptions & {
  project?: string;
  server?: string;
  flow?: string;
  step?: string;
  title?: string;
  limit?: number;
  run?: string;
  idempotencyKey?: string;
};

type SetOptions = Options & {
  answer: string[];
  unset: string[];
  confirm: string[];
  plugin?: string;
  pluginVersion?: string;
  clearPlugin?: boolean;
  attempt?: number;
  clearAttempt?: boolean;
  expectedRevision?: number;
  retryOnConflict?: boolean;
};

type RunOptions = Options & {
  wait?: boolean;
  aiObservations?: boolean;
  pluginVersion?: string;
};

/** The worker's 15-minute run deadline, plus time spent queued. */
const RUN_WAIT_MS = 20 * 60_000;
const RUN_POLL_MS = 5_000;
const RUN_ENDED = new Set(["completed", "failed", "cancelled"]);

/** `--project`, and the `<submission>` argument Commander guarantees. */
const scoped = (options: Options, submission = "") => ({ project: options.project, submission });

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `--plugin`, `--plugin-version` and `--attempt`, or their `--clear-*`, as the operation takes them. */
function subjectOf(
  options: SetOptions,
): Pick<UpdateDirectorySubmissionInput, "plugin" | "attempt"> {
  const { plugin: pluginId, pluginVersion: pluginVersionId, attempt } = options;
  const named = pluginId !== undefined || pluginVersionId !== undefined;
  if (options.clearPlugin && named) {
    throw usageError(
      "Pass --clear-plugin, or --plugin and --plugin-version, not both.",
    );
  }
  if (options.clearAttempt && attempt !== undefined) {
    throw usageError("Pass --attempt or --clear-attempt, not both.");
  }
  const plugin = named ? { pluginId, pluginVersionId } : undefined;
  return {
    plugin: options.clearPlugin ? null : plugin,
    attempt: options.clearAttempt ? null : attempt,
  };
}

/**
 * `--answer key=value`, `--unset key` and `--confirm key`, checked with the
 * operation's own schema so a value of the wrong kind is a usage error that
 * names the field, before anything is sent.
 */
function parseSetInput(options: SetOptions, submission: string): UpdateDirectorySubmissionInput {
  const answers = new Map<string, unknown>();
  const add = (key: string, value: unknown) => {
    if (answers.has(key)) throw usageError(`${key} is given twice. Pass one --answer or --unset per field.`);
    answers.set(key, value);
  };
  for (const pair of options.answer) {
    const split = pair.indexOf("=");
    if (split <= 0) throw usageError(`--answer takes key=value, not "${pair}".`);
    add(pair.slice(0, split).trim(), jsonOrText(pair.slice(split + 1)));
  }
  for (const key of options.unset) add(key.trim(), null);
  const subject = subjectOf(options);
  const unchanged = [options.title, subject.plugin, subject.attempt].every(
    (value) => value === undefined,
  );
  if (answers.size === 0 && options.confirm.length === 0 && unchanged) {
    throw usageError(
      "Nothing to save. Pass --answer, --unset, --confirm, --title, --plugin-version or --attempt.",
    );
  }
  const parsed = updateDirectorySubmissionOperation.inputSchema.safeParse({
    ...scoped(options, submission),
    ...(answers.size > 0 ? { answers: Object.fromEntries(answers) } : {}),
    ...(options.confirm.length > 0 ? { confirm: options.confirm } : {}),
    title: options.title,
    ...subject,
    expectedRevision: options.expectedRevision,
    idempotencyKey: options.idempotencyKey,
  });
  if (parsed.success) return parsed.data;
  throw usageError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
}

type RunScope = { projectId: string; runId: string };
type ClientContext = { client: PlatformApiClient; signal: AbortSignal };

/**
 * Resume a run that stopped on the server. This caller started it, so its
 * credentials can grade the server again. A refusal is reported and the wait
 * goes on: the run's own status says how it ends.
 */
async function resumeRun(
  options: PlatformOptions,
  timeoutMs: number,
  run: RunScope,
  extras: RunPlatformOperationExtras
): Promise<void> {
  const resume = (context: ClientContext) =>
    context.client.resumeReadinessRun(run, { signal: context.signal });
  let note = `Run ${run.runId} stopped on the server and was resumed.`;
  try {
    await runPlatformOperation(options, timeoutMs, resume, extras);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    note = `Run ${run.runId} stopped on the server and could not be resumed: ${reason}`;
  }
  if (!extras.quiet) process.stderr.write(`${note}\n`);
}

/**
 * Poll a started run until it ends. Each read gets the command's own
 * deadline, so `--timeout` keeps bounding one request rather than the wait.
 * A run re-queued after its node stopped is resumed once per re-queue.
 */
async function waitForRun(
  options: PlatformOptions,
  timeoutMs: number,
  run: RunScope,
  extras: RunPlatformOperationExtras
): Promise<PlatformReadinessRun> {
  const giveUpAt = Date.now() + RUN_WAIT_MS;
  // Recovery counts each re-queue as an attempt, so the attempt names it.
  const resumedAttempts = new Set<number>();
  for (;;) {
    const read = (context: ClientContext) =>
      context.client.getReadinessRun(run, { signal: context.signal });
    const current = await runPlatformOperation(options, timeoutMs, read, extras);
    if (RUN_ENDED.has(current.status)) return current;
    if (current.resumable && !resumedAttempts.has(current.attemptCount)) {
      resumedAttempts.add(current.attemptCount);
      await resumeRun(options, timeoutMs, run, extras);
      // Read what the resume did before waiting out a poll interval.
      continue;
    }
    if (Date.now() + RUN_POLL_MS > giveUpAt) {
      const later = `mcpjam readiness status --run ${run.runId} --project ${run.projectId}`;
      throw new CliError(
        "RUN_NOT_FINISHED",
        `Run ${run.runId} is still ${current.status} after 20 minutes. Read it later with \`${later}\`.`,
        3
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
  }
}

async function runSubmission(submission: string, command: Command): Promise<void> {
  const options = platformOptionsOf<RunOptions>(command);
  const globals = getGlobalOptions(command);
  const extras = { announce: false, quiet: globals.quiet, command: "readiness submission run" };
  const input = {
    ...scoped(options, submission),
    includeLlmObservations: options.aiObservations ? true : undefined,
    idempotencyKey: options.idempotencyKey,
    pluginVersionId: options.pluginVersion,
  };
  const start = startDirectorySubmissionRunOperation;
  const started = await runPlatformOperation(options, globals.timeout, (context) => start.execute(input, context), extras);
  if (!options.wait) return writeResult(started, globals.format);
  const ids = { projectId: started.project.id, runId: started.run.runId };
  const run = await waitForRun(options, globals.timeout, ids, extras);
  writeResult({ ...started, run }, globals.format);
  // A run that did not complete graded nothing: incomplete, never not ready.
  const status = run.status === "completed" ? (run.overallStatus ?? undefined) : undefined;
  reportReadinessVerdict({ status, summary: status ? undefined : `the run ${run.status}` }, command);
  setProcessExitCode(directoryReadinessExitCode({ status }));
}

/** Register `readiness flows` and `readiness submission` on the readiness group. */
export function registerDirectorySubmissionCommands(readiness: Command): void {
  const flows = readiness
    .command("flows")
    .description("List the directory forms MCPJam can rehearse, or show one")
    .argument("[flow]", "Flow id, such as claude-connector")
    .option("--step <id>", "Show only this step of the flow");
  bindOperation<Options, { flow?: string; step?: string }>(
    flows,
    {
      execute: ({ flow, step }, context) =>
        flow
          ? getDirectoryFlowOperation.execute({ flow, step }, context)
          : listDirectoryFlowsOperation.execute({}, context),
    },
    (options, flow) => {
      if (options.step && !flow) {
        throw usageError("--step needs a flow, as in `mcpjam readiness flows claude-connector --step listing`.");
      }
      return { flow, step: options.step };
    }
  );

  const submission = readiness
    .command("submission")
    .description("Rehearse a directory submission for a saved server");
  const verb = (name: string, description: string, argument = true) => {
    const command = submission.command(name).description(description);
    return addProjectOption(argument ? command.argument("<submission>", "Submission id") : command);
  };

  const create = verb("create", "Start a rehearsal of a directory's form for a saved server", false)
    .requiredOption("--flow <id>", "Flow id, from `mcpjam readiness flows`")
    .requiredOption("--server <id-or-name>", "Saved server the submission is for")
    .option("--title <title>", "A name for the rehearsal")
    .option("--idempotency-key <key>", "Replay guard: a retry returns the same submission");
  // Commander requires --flow and --server, so the fallbacks never apply.
  bindOperation(
    create,
    createDirectorySubmissionOperation,
    ({ project, server = "", flow = "", title, idempotencyKey }: Options) => ({
      project,
      server,
      flow,
      title,
      idempotencyKey,
    })
  );

  const list = verb("list", "List a project's submissions, newest first", false)
    .option("--server <id-or-name>", "Narrow to one saved server")
    .option("--flow <id>", "Narrow to one flow")
    .option("--limit <n>", "Rows to return (1-100)", (value: string) => parsePositiveInteger(value, "Limit"));
  bindOperation(list, listDirectorySubmissionsOperation, ({ project, server, flow, limit }: Options) => ({
    project,
    server,
    flow,
    limit,
  }));

  const get = verb("get", "Read a submission: its answers, who set them, and the portal's checks");
  bindOperation(get, getDirectorySubmissionOperation, scoped);

  const set = verb("set", "Save answers to a submission")
    .option(
      "--answer <key=value>",
      'Set a field. The value is read as JSON when it parses (true, 3, ["a"]), otherwise as text. Repeatable.',
      collectRepeated,
      []
    )
    .option("--unset <key>", "Remove a field's answer. Repeatable.", collectRepeated, [])
    .option("--confirm <key>", "Confirm a declaration as the portal words it now. Repeatable.", collectRepeated, [])
    .option("--title <title>", "Rename the submission")
    .option("--plugin <id>", "A ChatGPT plugin submission's stored plugin")
    .option("--plugin-version <id>", "The plugin version to submit. It names its plugin, so --plugin can be left out")
    .option("--clear-plugin", "Remove the submission's plugin and version")
    .option("--attempt <n>", "Which submission this is: 1, then one more per resubmission", (value: string) =>
      parsePositiveInteger(value, "--attempt")
    )
    .option("--clear-attempt", "Remove the submission's attempt number")
    .option(
      "--expected-revision <n>",
      "The revision you read. Without it, the current revision is read first.",
      (value: string) => parsePositiveInteger(value, "--expected-revision")
    )
    .option(
      "--retry-on-conflict",
      "If someone changed a field you set since your revision, write once more over their change"
    )
    .option("--idempotency-key <key>", "Replay guard: a retry is answered from the first write");
  bindOperation<SetOptions, UpdateDirectorySubmissionInput & { retry: boolean }>(
    set,
    {
      // `--retry-on-conflict`: one more write, over the revision the refusal names.
      execute: async ({ retry, ...input }, context) => {
        try {
          return await updateDirectorySubmissionOperation.execute(input, context);
        } catch (error) {
          const conflict = retry ? directorySubmissionConflict(error) : undefined;
          if (!conflict) throw error;
          const again = { ...input, expectedRevision: conflict.currentRevision };
          return updateDirectorySubmissionOperation.execute(again, context);
        }
      },
    },
    (options, id = "") => ({ ...parseSetInput(options, id), retry: options.retryOnConflict === true })
  );

  const remove = verb("delete", "Delete a submission and its answers. This cannot be undone.");
  bindOperation(remove, deleteDirectorySubmissionOperation, scoped);

  const run = addPlatformOptions(
    verb("run", "Grade a submission's server and answers on the platform")
      .option("--wait", "Wait for the run to end, then exit 0 ready, 1 not ready or 3 incomplete")
      .option("--ai-observations", "Add optional model observations, included with MCPJam")
      .option("--plugin-version <id>", "The stored plugin version to grade. Required for a ChatGPT plugin submission")
      .option("--idempotency-key <key>", "Replay guard: a retry returns the run already started")
  );
  run.action(async (id: string, _options: RunOptions, command: Command) => {
    try {
      await runSubmission(id, command);
    } catch (error) {
      const waiting = platformOptionsOf<RunOptions>(command).wait;
      if (!waiting || !(error instanceof CliError) || error.exitCode === 2) throw error;
      // Under --wait the exit code is the verdict, and no run gave one.
      throw new CliError(error.code, error.message, 3, error.details);
    }
  });

  const results = verb("results", "Read a submission's results, grouped by the portal's steps")
    .option("--run <id>", "A completed run's id. Defaults to the latest.")
    .option("--json", "Print JSON (same as --format json)")
    .hook("preAction", (command) => {
      if (command.opts().json) command.setOptionValue("format", "json");
    });
  bindOperation(results, getDirectorySubmissionResultsOperation, (options: Options, id = "") => ({
    ...scoped(options, id),
    run: options.run,
  }));
}
