/**
 * `mcpjam readiness submission evals …`: the eval suite that holds a
 * submission's test cases. `link` and `unlink` choose the suite and the run
 * that last ran it, `import` copies a ChatGPT plugin package's cases into the
 * suite, `show` reads each case's result, and `export` writes the cases in the
 * shape ChatGPT's form takes.
 *
 * Stdout carries the result alone: the JSON the operation answers or, from
 * `export`, the file's exact bytes. Notes go to stderr, which `--quiet`
 * silences.
 */
import { statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  exportDirectorySubmissionTestCasesOperation,
  getDirectorySubmissionEvalsOperation,
  importDirectorySubmissionTestCasesOperation,
  setDirectorySubmissionEvalsOperation,
  type ExportDirectorySubmissionTestCasesResult,
  type SetDirectorySubmissionEvalsInput,
} from "@mcpjam/sdk/platform";
import { writeFileAtomic } from "../lib/atomic-write.js";
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
  suite?: string;
  run?: string;
  runOnly?: boolean;
  expectedRevision?: number;
  idempotencyKey?: string;
  pluginVersion?: string;
  out?: string;
};

const scoped = (options: Options, submission = "") => ({ project: options.project, submission });

/** `--expected-revision` and `--idempotency-key`, as `submission set` takes them. */
function guarded(command: Command): Command {
  return command
    .option(
      "--expected-revision <n>",
      "The revision you read. Without it, the current revision is read first.",
      (value: string) => parsePositiveInteger(value, "--expected-revision")
    )
    .option("--idempotency-key <key>", "Replay guard: a retry is answered from the first write");
}

function linkInput(options: Options, submission: string, change: Pick<SetDirectorySubmissionEvalsInput, "suite" | "run">) {
  const { expectedRevision, idempotencyKey } = options;
  return { ...scoped(options, submission), ...change, expectedRevision, idempotencyKey };
}

/** `--out`: a file, or a folder to keep the file in under the name the API gave it. */
async function saveFile(out: string, filename: string, content: string): Promise<string> {
  // The name is the server's: only its last segment, so the file stays in the folder.
  const folder = statSync(out, { throwIfNoEntry: false })?.isDirectory();
  const target = folder ? path.join(out, path.basename(filename)) : out;
  try {
    return await writeFileAtomic(target, content, { createParents: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw operationalError(`Could not save the test cases to ${target} (${reason}). Pass another --out path.`);
  }
}

/** What to fix before the file goes into the form, on stderr. */
function shortfall({ counts, required, omitted }: ExportDirectorySubmissionTestCasesResult): string[] {
  const lines = omitted.map(
    ({ title, reason }) =>
      `Left out "${title}": it has no ${reason === "no_prompt" ? "prompt" : "expectation"}. Add one to the case, then export again.`
  );
  if (counts.successful !== required.successful || counts.gracefulFailure !== required.gracefulFailure) {
    lines.push(
      `The form asks for ${required.successful} successful and ${required.gracefulFailure} graceful-failure cases; this file has ${counts.successful} and ${counts.gracefulFailure}.`
    );
  }
  return lines;
}

/** Register `readiness submission evals` on the submission group. */
export function registerSubmissionEvalCommands(submission: Command): void {
  const evals = submission
    .command("evals")
    .description("Link, import, read and export the eval suite that holds a submission's test cases");
  const verb = (name: string, description: string) =>
    addProjectOption(evals.command(name).description(description).argument("<submission>", "Submission id"));

  const show = verb("show", "Read the linked suite and run, and each case's result in that run");
  bindOperation(show, getDirectorySubmissionEvalsOperation, scoped);

  const link = guarded(
    verb("link", "Link the eval suite that holds the submission's test cases, or the run that last ran them")
      .option("--suite <id>", "An eval suite in the submission's project")
      .option("--run <id>", "A run of the linked suite, or of --suite")
  );
  bindOperation(link, setDirectorySubmissionEvalsOperation, (options: Options, id = "") => {
    if (options.suite === undefined && options.run === undefined) {
      throw usageError("Pass --suite, --run or both.");
    }
    return linkInput(options, id, { suite: options.suite, run: options.run });
  });

  const unlink = guarded(
    verb("unlink", "Unlink the submission's eval suite and its run").option(
      "--run-only",
      "Keep the suite and clear only the run"
    )
  );
  bindOperation(unlink, setDirectorySubmissionEvalsOperation, (options: Options, id = "") =>
    linkInput(options, id, options.runOnly ? { run: null } : { suite: null })
  );

  const add = verb("import", "Import the test cases of the submission's ChatGPT plugin version into its linked suite")
    .option("--plugin-version <id>", "The version you expect the submission to name; refused if it names another");
  bindOperation(add, importDirectorySubmissionTestCasesOperation, (options: Options, id) => ({
    ...scoped(options, id),
    pluginVersionId: options.pluginVersion,
  }));

  const pack = addPlatformOptions(
    verb("export", "Export the linked suite's cases in the shape ChatGPT's form takes, byte for byte").option(
      "--out <path>",
      "Save the file to this path, or in this folder under its own name"
    )
  );
  pack.action(async (id: string, _options: Options, command: Command) => {
    const options = platformOptionsOf<Options>(command);
    const { timeout, quiet, format } = getGlobalOptions(command);
    const extras = { announce: false, quiet, command: "readiness submission evals export" };
    const read = exportDirectorySubmissionTestCasesOperation;
    const result = await runPlatformOperation(options, timeout, (context) => read.execute(scoped(options, id), context), extras);
    const { content, ...file } = result;
    if (options.out === undefined) {
      process.stdout.write(content);
    } else {
      const saved = await saveFile(options.out, file.filename, content);
      writeResult({ ...file, path: saved, bytes: Buffer.byteLength(content) }, format);
    }
    const notes = shortfall(result);
    if (notes.length > 0 && !quiet) process.stderr.write(`${notes.join("\n")}\n`);
  });
}
