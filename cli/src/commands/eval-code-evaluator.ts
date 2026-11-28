/**
 * `cloud eval code-evaluator test <file>`: run an unsaved code evaluator, read
 * from a local file, once against one iteration of a suite's finished run.
 * The app's suite editor runs the same test. Nothing is saved; each test
 * boots a paid sandbox.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { CODE_EVALUATOR_TEST_TIMEOUT_MS } from "@mcpjam/sdk/contract";
import {
  testEvalCodeEvaluatorOperation,
  type TestEvalCodeEvaluatorInput,
  type TestEvalCodeEvaluatorResult,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";

type TestOptions = PlatformOptions & {
  project?: string;
  suite: string;
  iteration: string;
  threshold?: string;
  id?: string;
  network?: string;
};

function readScript(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw usageError(
      `Couldn't read ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** The operation's input, checked here so a bad draft costs no request. */
function testInput(
  options: TestOptions,
  file: string | undefined
): TestEvalCodeEvaluatorInput {
  if (!file) throw usageError("Name the evaluator file to test.");
  const raw = {
    ...(options.project === undefined ? {} : { project: options.project }),
    suite: options.suite,
    iterationId: options.iteration,
    evaluator: {
      fileName: basename(file),
      script: readScript(file),
      ...(options.threshold === undefined
        ? {}
        : { threshold: Number(options.threshold) }),
      ...(options.id === undefined ? {} : { id: options.id }),
    },
    ...(options.network === undefined ? {} : { network: options.network }),
  };
  const parsed = testEvalCodeEvaluatorOperation.inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw usageError(
      `Invalid input: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

function formatTest(test: TestEvalCodeEvaluatorResult): string {
  const outcome =
    test.result.status === "scored"
      ? `${test.result.passed ? "Passed" : "Failed"}: scored ${test.result.score}, needs ${test.result.threshold}.${test.result.reason ? ` ${test.result.reason}` : ""}`
      : `Error: ${test.result.error}`;
  const input =
    test.input === "stored"
      ? "the iteration.json and declared files the run graded"
      : "rebuilt from the stored transcript, without declared files";
  return [
    outcome,
    `Input: ${input}`,
    `Network: ${test.network}`,
    `Took ${test.logs.durationMs} ms${test.logs.exitCode === undefined ? "" : `, exit code ${test.logs.exitCode}`}`,
    test.logs.output ? `Output:\n${test.logs.output.trimEnd()}` : "No output.",
  ].join("\n");
}

export function registerEvalCodeEvaluatorCommands(evals: Command): void {
  const codeEvaluator = evals
    .command("code-evaluator")
    .description(
      "Code evaluators: scripts that grade an iteration in a sandbox"
    );

  bindOperation(
    addProjectOption(
      codeEvaluator
        .command("test <file>")
        .description(
          "Run an unsaved code evaluator (a .sh, .py, .ts or .js file) once against one iteration of a suite's finished run, in a fresh sandbox. Saves nothing; each test boots a paid sandbox."
        )
        .requiredOption("--suite <id-or-name>", "Eval suite name or ID")
        .requiredOption(
          "--iteration <id>",
          "An iteration of one of the suite's finished runs (from `eval iterations`)"
        )
        .option(
          "--threshold <score>",
          "The score the iteration needs to pass, above 0 and up to 1 (default 1)"
        )
        .option(
          "--id <id>",
          "Names the evaluator's result file (default draft)"
        )
        .option(
          "--network <network>",
          "none or web; defaults to the suite's saved grading network"
        )
    ),
    testEvalCodeEvaluatorOperation,
    testInput,
    // The program's 30s default would give up mid-test.
    {
      defaultTimeoutMs: CODE_EVALUATOR_TEST_TIMEOUT_MS,
      formatHuman: formatTest,
    }
  );
}
