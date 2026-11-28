/**
 * "Test on a past iteration" for a code evaluator, on every agent surface:
 * run an unsaved draft against one stored iteration of a finished run before
 * saving it. The app's suite editor runs the same test.
 *
 * Separate from `operations.ts`, which builds its input schemas at module
 * load, so nothing here may import that file.
 */
import { z } from "zod";
import {
  codeEvaluatorTestRequestSchema,
  type CodeEvaluatorTestResult,
} from "../contract/code-evaluators.js";
import type { PlatformOperation } from "./operations.js";
import {
  evalIterationRef,
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { derivePermalinks } from "./permalinks.js";
import { resolveByIdOrName } from "./resource-selectors.js";
import type { SelectedProjectInfo } from "./show-servers.js";

const testEvalCodeEvaluatorInput = codeEvaluatorTestRequestSchema.extend({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z
    .string()
    .trim()
    .min(1)
    .describe("Eval suite name or ID; the iteration's run must be one of its."),
});

export type TestEvalCodeEvaluatorInput = z.infer<
  typeof testEvalCodeEvaluatorInput
>;

export type TestEvalCodeEvaluatorResult = CodeEvaluatorTestResult & {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
};

export const testEvalCodeEvaluatorOperation: PlatformOperation<
  TestEvalCodeEvaluatorInput,
  TestEvalCodeEvaluatorResult
> = {
  name: "test_eval_code_evaluator",
  title: "Test an MCPJam code evaluator on a past iteration",
  description:
    "Run an unsaved draft code evaluator once against one stored iteration of a finished eval run, and return its score, whether it passes its threshold (default 1), its reason and its output. Writes nothing: the suite, the run and its scores stay as they are. The iteration must come from one of the suite's finished runs. Each test boots a paid sandbox from the run's image and can take a couple of minutes, so test a draft rather than looping. When the run kept what it graded, the draft gets that exact iteration.json and declared files (`input: stored`); otherwise the iteration is rebuilt from its stored transcript, without the declared files (`input: transcript`). Needs code evaluators enabled for the organization, and the same person can test one iteration only every few seconds.",
  readOnly: false,
  risk: "spend",
  permalink: derivePermalinks((result) => [
    evalIterationRef(
      result.iterationId,
      result.runId,
      result.suite.id,
      result.project.id
    ),
  ]),
  inputSchema: testEvalCodeEvaluatorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const { items } = await client.listEvalSuites(
      { projectId: project.id },
      { signal }
    );
    const suite = resolveByIdOrName(
      items,
      input.suite,
      "Eval suite",
      `project "${project.name}"`
    );
    const test = await client.testEvalCodeEvaluator(
      {
        projectId: project.id,
        suiteId: suite.id,
        iterationId: input.iterationId,
        evaluator: input.evaluator,
        ...(input.network ? { network: input.network } : {}),
      },
      { signal }
    );
    return {
      ...test,
      project: toSelectedProjectInfo(project),
      suite: { id: suite.id, name: suite.name },
    };
  },
};
