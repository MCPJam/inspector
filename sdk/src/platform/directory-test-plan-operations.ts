/**
 * The test plan operations: draft, read and save the plan of calls a
 * directory submission's runs may make on its server, and read what a run's
 * calls showed, tool by tool.
 *
 * Naming a plan's revision when a run starts is the consent to its calls, so
 * nothing here fills a revision in for the caller: a save names the revision
 * it read, and a plan saved since is read before it is replaced.
 */
import { z } from "zod";
import {
  DIRECTORY_TOOL_TEST_STATUSES,
  type DirectoryToolTestResult,
  type DirectoryToolTestStatus,
} from "../directory-readiness/test-plan/outcome-types.js";
import {
  GATED_BETA,
  OPEN_BETA,
  SUBMISSION_PERMALINK,
  id,
  resolveScope,
  submissionInput,
  type Op,
  type ProjectResult,
} from "./directory-submission-operation-support.js";
import { directoryTestPlanSchema } from "./directory-test-plan-schema.js";
import type {
  PlatformDirectoryTestPlanDraft,
  PlatformDirectoryTestPlanSaved,
  PlatformDirectoryTestPlanView,
  PlatformDirectoryToolTests,
} from "./directory-test-plan-types.js";
import { resolutionError } from "./resource-selectors.js";

const readInput = submissionInput.extend({
  revision: z.number().int().min(1).optional().describe("A kept revision to read. Omit for the current plan."),
});

const saveInput = submissionInput.extend({
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .describe(
      "The `revision` you read, or the draft's `currentRevision`; 0 when the submission has no plan yet. A plan saved since is never overwritten."
    ),
  plan: directoryTestPlanSchema.describe(
    "The whole plan with your edits, in the shape the draft and the read return. In a case's `arguments`, `{ \"$fixture\": id, \"value\": name }` stands for a fixture's value."
  ),
});

const toolTestsInput = submissionInput.extend({
  run: id().optional().describe("A run's id. Omit for the newest run that named a test plan."),
  tool: id().optional().describe("Read one tool, with each case's call record."),
  status: z
    .enum(DIRECTORY_TOOL_TEST_STATUSES)
    .optional()
    .describe("List the tools with this status. Omit for the tools that need attention."),
});

export type GetDirectorySubmissionTestPlanInput = z.infer<typeof readInput>;
export type DraftDirectorySubmissionTestPlanInput = z.infer<typeof submissionInput>;
export type SaveDirectorySubmissionTestPlanInput = z.infer<typeof saveInput>;
export type GetDirectorySubmissionToolTestsInput = z.infer<typeof toolTestsInput>;

export type GetDirectorySubmissionTestPlanResult = ProjectResult & PlatformDirectoryTestPlanView;
export type DraftDirectorySubmissionTestPlanResult = ProjectResult & {
  submissionId: string;
} & PlatformDirectoryTestPlanDraft;
export type SaveDirectorySubmissionTestPlanResult = ProjectResult & PlatformDirectoryTestPlanSaved;
export type GetDirectorySubmissionToolTestsResult = ProjectResult & {
  submissionId: string;
} & PlatformDirectoryToolTests;

/** A tool that showed what it should, or that the plan leaves out on purpose. */
const SETTLED = new Set<DirectoryToolTestStatus>(["valid-input-succeeded", "expected-refusal", "excluded"]);

/** Without each case's call record: a large plan's records would make a model surface truncate the result. */
function withoutCallRecords(tool: DirectoryToolTestResult): DirectoryToolTestResult {
  return { ...tool, cases: tool.cases.map(({ call: _call, ...result }) => result) };
}

export const getDirectorySubmissionTestPlanOperation: Op<
  GetDirectorySubmissionTestPlanInput,
  GetDirectorySubmissionTestPlanResult
> = {
  name: "get_directory_submission_test_plan",
  title: "Get a directory submission's test plan",
  description: `Read a directory submission's saved test plan: for each tool, what a call may change (\`effect\`) and whether it runs (\`action\`: \`run\`, \`negative-only\`, or \`excluded\` with a reason), the fixtures its writes may touch, the cases in the order they run with their arguments, the budget and the cleanup. \`issues\` lists what keeps the plan from running, checked against the tool list MCPJam last stored for the server (\`catalog\`; both \`null\` when it has none). To make these calls, start a run with start_directory_submission_run and this \`revision\` as \`testPlanRevision\`. Pass \`revision\` to read an older kept revision. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: readInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const view = await client.getDirectorySubmissionTestPlan({ ...scope, revision: input.revision }, { signal });
    return { project: info, ...view };
  },
};

export const draftDirectorySubmissionTestPlanOperation: Op<
  DraftDirectorySubmissionTestPlanInput,
  DraftDirectorySubmissionTestPlanResult
> = {
  name: "draft_directory_submission_test_plan",
  title: "Draft a directory submission's test plan",
  description: `Draft a test plan for a directory submission from the tool list MCPJam last stored for its server, and save nothing. Every tool is in the draft, because the directories' reviewers test every tool, and destructive calls run last. Cases that need arguments are left without them: \`issues\` lists those and every other gap to close before the plan can run, such as the fixtures a write may change. Edit the plan, then save it with save_directory_submission_test_plan and \`currentRevision\` as \`expectedRevision\`. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: submissionInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const draft = await client.draftDirectorySubmissionTestPlan(scope, { signal });
    return { project: info, submissionId: input.submission, ...draft };
  },
};

export const saveDirectorySubmissionTestPlanOperation: Op<
  SaveDirectorySubmissionTestPlanInput,
  SaveDirectorySubmissionTestPlanResult
> = {
  name: "save_directory_submission_test_plan",
  title: "Save a directory submission's test plan",
  description: `Save a directory submission's test plan as its next revision. Send the whole plan, and the \`revision\` you read as \`expectedRevision\` (0 for the first plan, or the draft's \`currentRevision\`): if someone saved a plan since, the save is refused with 409 naming the current revision, and their plan is kept. A plan over a limit is refused with its \`issues\`; any other issue is saved with the plan and returned, and keeps it from running until fixed. Saving the current plan again changes nothing (\`replayed: true\`). Saving calls no tool: a run makes the plan's calls only when start_directory_submission_run names its revision. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: saveInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const { expectedRevision, plan } = input;
    const saved = await client.saveDirectorySubmissionTestPlan({ ...scope, expectedRevision, plan }, { signal });
    return { project: info, ...saved };
  },
};

export const getDirectorySubmissionToolTestsOperation: Op<
  GetDirectorySubmissionToolTestsInput,
  GetDirectorySubmissionToolTestsResult
> = {
  name: "get_directory_submission_tool_tests",
  title: "Get a directory submission's tool tests",
  description: `Read what a run's test plan calls showed, tool by tool: each tool's \`status\` (\`valid-input-succeeded\`, \`expected-refusal\`, \`unexpected-failure\`, \`ambiguous\`, \`setup-blocked\`, \`excluded\`, \`untested\` or \`stale\`) with the case that decided it, and its valid-input and negative cases counted apart, since a tool that only refused bad input has not shown that it works. \`inDoubt\` names the calls that may have changed data and never finished: none is sent again, so check what each one changed. A finished run's results come from its report (\`source: "report"\`), with how its sweep ended in \`sweep\`: \`not-run\` with the plan's \`issues\` when the plan did not match the tools the server listed. While a run goes on, they are its calls so far (\`source: "ledger"\`). Reads the newest run that named a test plan, or \`run\`. \`tools\` lists the tools that need attention, without call records; pass \`status\` to list others, or \`tool\` for one tool's cases with the call behind each: who made it, as which account, when, and what the server answered. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: toolTestsInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const results = await client.getDirectorySubmissionToolTests({ ...scope, runId: input.run }, { signal });
    const base = { project: info, submissionId: input.submission, ...results };
    if (input.tool !== undefined) {
      const tools = results.tools.filter((tool) => tool.tool === input.tool);
      if (tools.length === 0 && results.run) {
        throw resolutionError(`${input.tool} is not in this run's test plan. Check the name against the plan, or leave out \`tool\`.`);
      }
      return { ...base, tools };
    }
    const shown = results.tools.filter((tool) =>
      input.status ? tool.status === input.status : !SETTLED.has(tool.status)
    );
    return { ...base, tools: shown.map(withoutCallRecords) };
  },
};
