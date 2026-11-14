/**
 * `mcpjam readiness submission handoff|findings|finding|export|events` pick a
 * directory submission up from its id alone. `status|snapshot|import-finding`
 * record what happened in the directory itself, which MCPJam cannot see: each
 * record names who made it and is never edited, so a correction is a newer one.
 *
 * Stdout carries the result alone: the JSON the operation answers or, from
 * `export`, the pack's exact bytes. Progress and hints go to stderr, which
 * `--quiet` silences. No flag takes a secret's value: a reviewer credential is
 * answered with the NAME of the project secret that holds it (`submission set
 * --answer <key>=<NAME>`), and `mcpjam cloud secrets set` reads the value from
 * a file, an environment variable or stdin.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Option, type Command } from "commander";
import { DIRECTORY_SNAPSHOT_LABELS, type DirectoryNextAction } from "@mcpjam/sdk";
import {
  exportDirectorySubmissionOperation,
  getDirectorySubmissionFindingOperation,
  getDirectorySubmissionHandoffOperation,
  importDirectoryFindingOperation,
  listDirectorySubmissionEventsOperation,
  listDirectorySubmissionFindingsOperation,
  recordDirectorySubmissionSnapshotOperation,
  recordDirectorySubmissionStatusOperation,
  type ListDirectorySubmissionFindingsInput,
  type ListDirectorySubmissionFindingsResult,
  type PlatformApiClient,
  type PlatformOperation,
  type RecordDirectorySubmissionEventResult,
} from "@mcpjam/sdk/platform";
import { writeFileAtomic } from "../lib/atomic-write.js";
import { CLI_BINDINGS, type CliBinding } from "../lib/op-bindings.js";
import { operationalError, usageError, writeResult } from "../lib/output.js";
import {
  addPlatformOptions,
  addProjectOption,
  bindOperation,
  platformOptionsOf,
  runPlatformOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { getGlobalOptions, parsePositiveInteger } from "../lib/server-config.js";

type Options = PlatformOptions & {
  project?: string;
  status?: string;
  step?: string;
  lane?: string;
  all?: boolean;
  markdown?: boolean;
  out?: string;
  kind?: string;
  observed?: boolean;
  idempotencyKey?: string;
  evidence?: string;
  state?: string;
  directoryLabel?: string;
  uncertain?: boolean;
  link?: string;
  reference?: string;
  detail?: string;
  label?: string;
  revision?: number;
  server?: string;
  capturedAt?: string;
  note?: string;
  textFile?: string;
  text?: string;
  /** The directory's words, read from `--text-file` or `--text -`. */
  words?: string;
  via?: string;
  severity?: string;
  code?: string;
  submissionVersion?: string;
  receivedAt?: string;
};

type Context = { client: PlatformApiClient; signal: AbortSignal };

/** Findings per page under `--all`: the most the route sends. */
const PAGE = 100;
const EVIDENCE = "What shows it: url=<https link>, text=<quoted words> or run=<run id>";

const scoped = (options: Options, submission = "") => ({ project: options.project, submission });

/**
 * The input as the operation's own schema reads it, so a flag of the wrong
 * kind is a usage error that names its field before anything is sent.
 */
function checked<TInput>(operation: Pick<PlatformOperation<TInput, unknown>, "inputSchema">, input: unknown): TInput {
  const parsed = operation.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw usageError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
}

/** Hints and progress on stderr, so stdout stays the result. `--quiet` drops them. */
function note(command: Command, lines: string[]): void {
  if (lines.length > 0 && !command.optsWithGlobals().quiet) process.stderr.write(`${lines.join("\n")}\n`);
}

/** `readiness submission <name> <submission>`, with `--project`. */
function verb(submission: Command, name: string, description: string): Command {
  return addProjectOption(submission.command(name).description(description).argument("<submission>", "Submission id"));
}

/** `--json`, as `results` takes it: JSON on stdout in a terminal too. */
function withJson(command: Command): Command {
  return command.option("--json", "Print JSON (same as --format json)").hook("preAction", (self) => {
    if (self.opts().json) self.setOptionValue("format", "json");
  });
}

/**
 * One operation for a command that prints more than its result, as `results`
 * does: the global timeout, and no audience line, like all hosted readiness.
 */
function runFor<T>(command: Command, execute: (context: Context) => Promise<T>): Promise<T> {
  const { timeout, quiet } = getGlobalOptions(command);
  const extras = { announce: false, quiet, command: `readiness submission ${command.name()}` };
  return runPlatformOperation(platformOptionsOf(command), timeout, execute, extras);
}

/** A handoff's next actions, each as the command that takes it here. */
function nextSteps(actions: readonly DirectoryNextAction[]): string[] {
  const steps = actions.map(({ operation, why }) => {
    const binding: CliBinding | undefined = CLI_BINDINGS[operation];
    return `  ${binding && "command" in binding ? `mcpjam ${binding.command}` : operation}: ${why}`;
  });
  return steps.length > 0 ? ["Next:", ...steps] : [];
}

/**
 * Every page, from the first one's `nextCursor` on. Later pages name the
 * project the first was read in, so a default project cannot change midway.
 */
async function everyFinding(
  input: ListDirectorySubmissionFindingsInput,
  context: Context,
  command: Command
): Promise<ListDirectorySubmissionFindingsResult> {
  const list = listDirectorySubmissionFindingsOperation;
  const first = await list.execute(input, context);
  const findings = [...first.findings];
  const seen = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor) {
    // A cursor seen before would read the same pages forever.
    if (seen.has(cursor)) {
      const read = `${findings.length} findings`;
      throw operationalError(`The API sent the same findings page twice after ${read}. Run the command again.`);
    }
    seen.add(cursor);
    note(command, [`Read ${findings.length} findings. Reading the next page.`]);
    const page = await list.execute({ ...input, project: first.project.id, cursor }, context);
    findings.push(...page.findings);
    cursor = page.nextCursor;
  }
  return { project: first.project, submissionId: first.submissionId, findings };
}

/** `--out`: a file, or a folder to keep the pack in under the name the API gave it. */
async function savePack(out: string, filename: string, content: string): Promise<string> {
  // The name is the server's: only its last segment, so the pack stays in the folder.
  const folder = statSync(out, { throwIfNoEntry: false })?.isDirectory();
  const target = folder ? path.join(out, path.basename(filename)) : out;
  try {
    return await writeFileAtomic(target, content, { createParents: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw operationalError(`Could not save the pack to ${target} (${reason}). Pass another --out path.`);
  }
}

/** `--evidence kind=value`. The operation's schema checks the kind and the value. */
function evidenceOf(value: string | undefined): { kind: string; value: string } | undefined {
  if (value === undefined) return undefined;
  const split = value.indexOf("=");
  if (split <= 0) throw usageError("--evidence takes kind=value, such as url=https://example.com/status.");
  return { kind: value.slice(0, split), value: value.slice(split + 1) };
}

/** A date and time, as the epoch milliseconds a record keeps. */
function epochOf(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw usageError(`${flag} takes a date and time, such as 2026-11-13T09:30:00Z.`);
  return time;
}

/**
 * The directory's words, from `--text-file` or `--text -` and never from argv,
 * where a shell rewrites quotes and `$`. Only the line ending the file or the
 * pipe added is dropped.
 */
function directoryWords({ textFile, text }: Options): string {
  if ((textFile === undefined) === (text === undefined)) {
    throw usageError("Pass the directory's words with --text-file <path>, or pipe them in with --text -.");
  }
  if (text !== undefined && text !== "-") {
    throw usageError("--text reads stdin only, as --text -. Put the words in a file and pass --text-file <path>.");
  }
  // A terminal on stdin means nothing was piped in: say so, rather than wait.
  if (textFile === undefined && process.stdin.isTTY) {
    throw usageError("--text - reads stdin, and nothing is piped in. Pipe the words in, or pass --text-file <path>.");
  }
  const source = textFile ?? "stdin";
  let words: string;
  try {
    words = readFileSync(textFile ?? 0, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError(`Could not read ${source} (${reason}). Pass a file you can read.`);
  }
  if (words.trim() === "") throw usageError(`${source} holds no text. Pass the directory's words.`);
  return words;
}

/** What every record takes: whether it was seen first hand, and a replay guard. */
function recordVerb(submission: Command, name: string, description: string): Command {
  return withJson(verb(submission, name, description))
    .option("--observed", "You saw it yourself. Without it, it is recorded as reported: someone told you.")
    .option("--idempotency-key <key>", "Replay guard: a retry returns the event already recorded");
}

/** Bind a record. A replayed one is said on stderr: nothing new was recorded. */
function bindRecord<TInput>(
  command: Command,
  operation: PlatformOperation<TInput, RecordDirectorySubmissionEventResult>,
  fields: (options: Options) => Record<string, unknown>
): void {
  bindOperation<Options, TInput, RecordDirectorySubmissionEventResult>(
    command,
    {
      execute: async (input, context) => {
        const result = await operation.execute(input, context);
        if (result.event.replayed) {
          note(command, [`This idempotency key already recorded event ${result.event.id}. Nothing new was recorded.`]);
        }
        return result;
      },
    },
    (options, id) =>
      checked(operation, {
        ...scoped(options, id),
        ...fields(options),
        reportedOrObserved: options.observed ? "observed" : undefined,
        idempotencyKey: options.idempotencyKey,
      })
  );
}

/** Register the handoff reads and the directory's records on `readiness submission`. */
export function registerSubmissionHandoffCommands(submission: Command): void {
  const handoff = addPlatformOptions(
    withJson(verb(submission, "handoff", "Where the submission stands and what to do next, from its id alone"))
  );
  handoff.action(async (id: string, _options: Options, command: Command) => {
    const read = getDirectorySubmissionHandoffOperation;
    const input = checked(read, scoped(platformOptionsOf<Options>(command), id));
    const result = await runFor(command, (context) => read.execute(input, context));
    writeResult(result, getGlobalOptions(command).format);
    note(command, nextSteps(result.nextActions));
  });

  const findings = addPlatformOptions(
    withJson(verb(submission, "findings", "List the submission's stored findings, newest first, a page at a time"))
      .option("--status <status>", "Only findings with this status, such as violated")
      .option("--step <id>", "Only findings shown at this portal step")
      .option("--lane <lane>", "Only findings from this lane, such as directory-policy")
      .option("--all", "Read every page, not only the first")
  );
  findings.action(async (id: string, _options: Options, command: Command) => {
    const options = platformOptionsOf<Options>(command);
    const { status, step, lane, all } = options;
    const list = listDirectorySubmissionFindingsOperation;
    const input = checked(list, { ...scoped(options, id), status, step, lane, limit: all ? PAGE : undefined });
    const result = await runFor(command, (context) =>
      all ? everyFinding(input, context, command) : list.execute(input, context)
    );
    writeResult(result, getGlobalOptions(command).format);
    if (result.nextCursor) {
      note(command, [`Showing the first ${result.findings.length} findings. Pass --all to read every page.`]);
    }
  });

  const finding = withJson(
    verb(submission, "finding", "Read one check's stored result, with the observation behind it")
  ).argument("<checkId>", "The check's id, such as claude.endpoint.https");
  bindOperation(finding, getDirectorySubmissionFindingOperation, (options: Options, id, check) =>
    checked(getDirectorySubmissionFindingOperation, { ...scoped(options, id), check })
  );

  const pack = addPlatformOptions(
    verb(submission, "export", "Export the pack the team receives, byte for byte as the API serves it")
      .option("--markdown", "The Markdown pack, for a person or a ticket, in place of JSON")
      .option("--out <path>", "Save the pack to this file, or in this folder under its own name")
  );
  pack.action(async (id: string, _options: Options, command: Command) => {
    // `--format` is the program's json or human output, whatever command it follows.
    if (command.optsWithGlobals().format === "markdown") {
      throw usageError("For the Markdown pack, pass --markdown. --format chooses json or human output.");
    }
    const options = platformOptionsOf<Options>(command);
    const read = exportDirectorySubmissionOperation;
    const input = checked(read, { ...scoped(options, id), format: options.markdown ? "markdown" : undefined });
    const { content, ...file } = await runFor(command, (context) => read.execute(input, context));
    if (options.out === undefined) {
      process.stdout.write(content);
      return;
    }
    const saved = await savePack(options.out, file.filename, content);
    writeResult({ ...file, path: saved, bytes: Buffer.byteLength(content) }, getGlobalOptions(command).format);
  });

  const events = withJson(
    verb(submission, "events", "List what was recorded about the submission outside MCPJam, newest first")
  ).option("--kind <kind>", "Only events of this kind, such as status or directory-finding");
  bindOperation(events, listDirectorySubmissionEventsOperation, (options: Options, id) =>
    checked(listDirectorySubmissionEventsOperation, { ...scoped(options, id), kind: options.kind })
  );

  const status = recordVerb(submission, "status", "Record where the directory has the submission, as seen or as told")
    .requiredOption("--state <state>", "The stage, such as submitted, in-review or approved")
    .option("--directory-label <words>", "The directory's own words for the state, verbatim")
    .option("--uncertain", "The portal's outcome was unclear, such as a submit dialog that stayed busy")
    .option("--link <url>", "An https link to the submission in the directory")
    .option("--reference <text>", "A confirmation reference the directory gave")
    .option("--detail <text>", "Anything else the next person should know")
    .option("--evidence <kind=value>", EVIDENCE);
  bindRecord(status, recordDirectorySubmissionStatusOperation, (options) => ({
    state: options.state,
    directoryLabel: options.directoryLabel,
    uncertain: options.uncertain,
    link: options.link,
    reference: options.reference,
    detail: options.detail,
    evidence: evidenceOf(options.evidence),
  }));

  const snapshot = recordVerb(submission, "snapshot", "Record which server revision one copy of the catalog holds")
    .addOption(new Option("--label <label>", "Which copy").choices(DIRECTORY_SNAPSHOT_LABELS).makeOptionMandatory())
    .option(
      "--revision <n>",
      "The server revision it holds. Without one, what it holds stays unknown.",
      (value: string) => parsePositiveInteger(value, "--revision")
    )
    .option("--server <id-or-name>", "The saved server the copy is of. Defaults to the submission's own.")
    .option("--captured-at <time>", "When the copy was seen, such as 2026-11-13T09:30:00Z")
    .option("--note <text>", "How you know, such as what the portal's tool list showed")
    .option("--evidence <kind=value>", EVIDENCE);
  bindRecord(snapshot, recordDirectorySubmissionSnapshotOperation, (options) => ({
    label: options.label,
    revisionNumber: options.revision,
    server: options.server,
    capturedAt: epochOf("--captured-at", options.capturedAt),
    note: options.note,
    evidence: evidenceOf(options.evidence),
  }));

  const said = recordVerb(submission, "import-finding", "Keep what the directory said about the submission, verbatim")
    .option("--text-file <path>", "Read the directory's words from this file")
    .option("--text <source>", "Pass - to read the directory's words from stdin")
    .requiredOption("--via <channel>", "How it arrived: email, portal or other")
    .option("--severity <text>", "The directory's own severity, as given")
    .option("--code <text>", "The directory's code for it, as given")
    .option("--submission-version <text>", "The version of the submission it is about")
    .option("--received-at <time>", "When it arrived, such as 2026-11-13T09:30:00Z")
    .option("--link <url>", "An https link to the message, if it has one")
    // Read before the request's deadline starts, which a slow pipe would run down.
    .hook("preAction", (self) => {
      self.setOptionValue("words", directoryWords(self.opts<Options>()));
    });
  bindRecord(said, importDirectoryFindingOperation, (options) => ({
    text: options.words,
    via: options.via,
    severity: options.severity,
    code: options.code,
    version: options.submissionVersion,
    receivedAt: epochOf("--received-at", options.receivedAt),
    link: options.link,
  }));
}
