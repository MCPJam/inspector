/**
 * `mcpjam readiness submission plan …`: draft, read and save the test plan of
 * calls a submission's runs make on its server, and read what a run's calls
 * showed. `readiness submission run --test-plan-revision` starts a run that
 * makes them.
 *
 * A plan travels as JSON: `draft --output` writes one to a file, and `save
 * --file` sends one back. Each command is a bound platform operation, so it
 * answers as the API and the MCP tools do.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { DIRECTORY_TOOL_TEST_STATUSES } from "@mcpjam/sdk";
import {
  directoryTestPlanSchema,
  draftDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionTestPlanOperation,
  getDirectorySubmissionToolTestsOperation,
  saveDirectorySubmissionTestPlanOperation,
  type DraftDirectorySubmissionTestPlanInput,
  type SaveDirectorySubmissionTestPlanInput,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import { addProjectOption, bindOperation, type PlatformOptions } from "../lib/platform-command.js";
import { parseNonNegativeInteger, parsePositiveInteger } from "../lib/server-config.js";

type Options = PlatformOptions & {
  project?: string;
  revision?: number;
  output?: string;
  file?: string;
  expectedRevision?: number;
  run?: string;
  tool?: string;
  status?: (typeof DIRECTORY_TOOL_TEST_STATUSES)[number];
};

const scoped = (options: Options, submission = "") => ({ project: options.project, submission });

function readJson(file: string): unknown {
  let text: string;
  try {
    text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw usageError(`Could not read ${file} (${reason}). Pass the path of a plan file, or - for stdin.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${file} is not JSON. Pass a plan, as \`plan draft --output\` writes one.`);
  }
}

/**
 * The plan in `--file`: a plan, or what `plan show` or `plan draft` printed,
 * which also says the revision it was read at.
 */
function readPlanFile(options: Options, submission: string): SaveDirectorySubmissionTestPlanInput {
  const file = options.file ?? "";
  const value = readJson(file);
  const printed = value && typeof value === "object" && "plan" in value ? (value as Record<string, unknown>) : {};
  const parsed = directoryTestPlanSchema.safeParse("plan" in printed ? printed.plan : value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw usageError(`${file} is not a test plan. ${where}${issue?.message ?? "Unreadable."}`);
  }
  const read = [printed.revision, printed.currentRevision].find(
    (revision): revision is number => typeof revision === "number"
  );
  const expectedRevision = options.expectedRevision ?? read;
  if (expectedRevision === undefined) {
    throw usageError("Pass --expected-revision: the revision you read, or 0 for the submission's first plan.");
  }
  return { ...scoped(options, submission), expectedRevision, plan: parsed.data };
}

/** Register `readiness submission plan` on the submission group. */
export function registerTestPlanCommands(submission: Command): void {
  const plan = submission
    .command("plan")
    .description("Draft, read and save the test plan whose tool calls a submission's runs make");
  const verb = (name: string, description: string) =>
    addProjectOption(plan.command(name).description(description).argument("<submission>", "Submission id"));

  const show = verb("show", "Read the saved test plan, and what keeps it from running").option(
    "--revision <n>",
    "A kept revision to read. Defaults to the current plan.",
    (value: string) => parsePositiveInteger(value, "--revision")
  );
  bindOperation(show, getDirectorySubmissionTestPlanOperation, (options: Options, id) => ({
    ...scoped(options, id),
    revision: options.revision,
  }));

  const draft = verb("draft", "Draft a plan that calls every tool the server lists. Saves nothing.").option(
    "--output <file>",
    "Write the drafted plan to this file, to edit and then save with `plan save`"
  );
  bindOperation<Options, DraftDirectorySubmissionTestPlanInput & { output?: string }>(
    draft,
    {
      execute: async ({ output, ...input }, context) => {
        const drafted = await draftDirectorySubmissionTestPlanOperation.execute(input, context);
        if (output === undefined) return drafted;
        writeFileSync(output, `${JSON.stringify(drafted.plan, null, 2)}\n`);
        const { plan: _plan, ...rest } = drafted;
        return { ...rest, planFile: output };
      },
    },
    (options, id) => ({ ...scoped(options, id), output: options.output })
  );

  const save = verb("save", "Save a plan file as the submission's next revision")
    .requiredOption("--file <path>", "The plan: a file `plan draft --output` wrote, what `plan show` printed, or - for stdin")
    .option(
      "--expected-revision <n>",
      "The revision you read; 0 for the first plan. Defaults to the one in the file, when it names one.",
      (value: string) => parseNonNegativeInteger(value, "--expected-revision")
    );
  bindOperation(save, saveDirectorySubmissionTestPlanOperation, (options: Options, id = "") => readPlanFile(options, id));

  const results = verb("results", "Read what a run's test plan calls showed, tool by tool")
    .option("--run <id>", "A run's id. Defaults to the newest run that named a test plan.")
    .option("--tool <name>", "One tool, with the call behind each of its cases")
    .addOption(new Option("--status <status>", "List the tools with this status").choices(DIRECTORY_TOOL_TEST_STATUSES));
  bindOperation(results, getDirectorySubmissionToolTestsOperation, (options: Options, id) => ({
    ...scoped(options, id),
    run: options.run,
    tool: options.tool,
    status: options.status,
  }));
}
