/**
 * The eval operations of a directory submission: link the eval suite that
 * holds its test cases and the run that last ran them, import the cases a
 * ChatGPT plugin package declares, read each case's result, and export the
 * cases in the shape the directory's form takes.
 *
 * Test cases need a conversation, so they run as evals: a person or an agent
 * runs the linked suite with run_eval_suite, and the submission only points at
 * the suite and the run. Every result keeps the client that ran it.
 */
import { z } from "zod";
import { canonicalDigest } from "../contract/canonical.js";
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
import type {
  PlatformDirectorySubmissionEvalExport,
  PlatformDirectorySubmissionEvalImport,
  PlatformDirectorySubmissionEvalLink,
  PlatformDirectorySubmissionEvals,
} from "./directory-submission-eval-types.js";
import { operationInputError } from "./resource-selectors.js";

const linkInput = submissionInput.extend({
  suite: id().nullable().optional().describe(
    "The id of an eval suite in the submission's project, from list_eval_suites. `null` unlinks the suite and its run."
  ),
  run: id().nullable().optional().describe(
    "The id of a run of the linked suite, from list_eval_suite_runs. `null` clears it."
  ),
  expectedRevision: z.number().int().min(1).optional().describe(
    "The submission's `revision` you read. Omitted, the operation reads the current one first."
  ),
  idempotencyKey: id().max(200).optional().describe(
    "Replay guard. Omitted, one is derived from the change and `expectedRevision`, so retrying the same change is answered from the first write."
  ),
});

const importInput = submissionInput.extend({
  pluginVersionId: id().optional().describe(
    "The plugin version the submission names, as you read it. Sent, the import is refused if the submission names another version by then."
  ),
});

export type SetDirectorySubmissionEvalsInput = z.infer<typeof linkInput>;
export type ImportDirectorySubmissionTestCasesInput = z.infer<typeof importInput>;

export type GetDirectorySubmissionEvalsResult = ProjectResult & PlatformDirectorySubmissionEvals;
export type SetDirectorySubmissionEvalsResult = ProjectResult & PlatformDirectorySubmissionEvalLink;
export type ImportDirectorySubmissionTestCasesResult = ProjectResult & {
  submissionId: string;
} & PlatformDirectorySubmissionEvalImport;
export type ExportDirectorySubmissionTestCasesResult = ProjectResult & PlatformDirectorySubmissionEvalExport;

export const getDirectorySubmissionEvalsOperation: Op<
  z.infer<typeof submissionInput>,
  GetDirectorySubmissionEvalsResult
> = {
  name: "get_directory_submission_evals",
  title: "Get a directory submission's evals",
  description: `Read the eval suite that holds a directory submission's test cases, the eval run of it that last ran them, and each case's result in that run: its prompt and expectation, whether it is a negative case (it passes when no tool is called), the plugin version and list an imported case came from (\`source\`), how its iterations were graded (\`assertions\`: \`deterministic\`, \`judge\`, \`both\` or \`none\`), whether the judge's verdict counts (\`judge.enforced\`; otherwise it is advisory) and its \`threshold\`, the client the run ran as, and its iterations counted by result. A result is that client's: the same prompt can behave differently in the directory's own client. \`results\` is empty until a run is linked; \`truncated\` means the run has more iterations than one read returns. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: submissionInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    return { project: info, ...(await client.getDirectorySubmissionEvals(scope, { signal })) };
  },
};

export const setDirectorySubmissionEvalsOperation: Op<
  SetDirectorySubmissionEvalsInput,
  SetDirectorySubmissionEvalsResult
> = {
  name: "set_directory_submission_evals",
  title: "Link a directory submission's evals",
  description: `Link a directory submission to the eval suite in its project that holds its test cases, and to the run of that suite that last ran them, so get_directory_submission_evals reads each case's result. \`suite\` links a suite; linking another drops the run unless \`run\` names one of the new suite's. \`run\` records a run of the linked suite, such as one run_eval_suite started. \`null\` unlinks either, and unlinking the suite unlinks its run. Nothing runs and no case changes. Send the submission's \`revision\` as \`expectedRevision\`: the write is refused with 409 only when the link changed since, and the refusal names the current revision. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: linkInput,
  async execute(input, context) {
    // Here, not in the schema: the CLI calls `execute` without parsing.
    if (input.suite === undefined && input.run === undefined) {
      throw operationInputError("Nothing to change. Pass suite to link or unlink a suite, or run for its run.");
    }
    const { client, signal, scope, info } = await resolveScope(input, context);
    const body = {
      expectedRevision:
        input.expectedRevision ?? (await client.getDirectorySubmissionEvals(scope, { signal })).revision,
      // `null` is a change: it unlinks.
      ...(input.suite !== undefined ? { suiteId: input.suite } : {}),
      ...(input.run !== undefined ? { runId: input.run } : {}),
    };
    // Derived, as for an answer, so a retry of a call whose answer was lost is
    // answered from the first write instead of refused as a conflict.
    const key = input.idempotencyKey ?? `derived:${canonicalDigest({ ...scope, ...body })}`;
    const linked = await client.setDirectorySubmissionEvals({ ...scope, ...body, idempotencyKey: key }, { signal });
    return { project: info, ...linked };
  },
};

export const importDirectorySubmissionTestCasesOperation: Op<
  ImportDirectorySubmissionTestCasesInput,
  ImportDirectorySubmissionTestCasesResult
> = {
  name: "import_directory_submission_test_cases",
  title: "Import a plugin's test cases into a directory submission's evals",
  description: `Import the review test cases a ChatGPT plugin package declares, from the stored plugin version the submission names, into the eval suite linked to the submission: each positive case becomes an eval case with its prompt and expected behaviour, and each negative case a negative case, which passes when no tool is called. Each case records the version, list and position it came from. Importing the same version again writes nothing (\`existing\` counts what it found), and a case edited since is left as it is. Declared cases that cannot become eval cases come back in \`skipped\` with the reason. Link a suite with set_directory_submission_evals first; running the cases is run_eval_suite's. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: importInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const imported = await client.importDirectorySubmissionTestCases(
      { ...scope, pluginVersionId: input.pluginVersionId },
      { signal }
    );
    return { project: info, submissionId: input.submission, ...imported };
  },
};

export const exportDirectorySubmissionTestCasesOperation: Op<
  z.infer<typeof submissionInput>,
  ExportDirectorySubmissionTestCasesResult
> = {
  name: "export_directory_submission_test_cases",
  title: "Export a directory submission's test cases",
  description: `Export the test cases in a directory submission's linked eval suite in the shape ChatGPT's form takes them: \`successful\`, the cases the plugin should complete, and \`gracefulFailure\`, the negative cases it should decline, each \`{prompt, expectation}\`. \`content\` is the JSON file's exact bytes, to save as it is. A case's expectation is its expected output, or for a negative case the scenario that says why it should decline. A case the form would refuse, with no prompt or no expectation, is left out and named in \`omitted\`; \`counts\` beside \`required\` says whether the file has the five and three a first review asks for. Claude's directory takes no test cases, so a Claude submission is refused. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: submissionInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    return { project: info, ...(await client.exportDirectorySubmissionTestCases(scope, { signal })) };
  },
};
