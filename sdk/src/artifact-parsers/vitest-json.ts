import type { EvalResultInput } from "../eval-reporting-types.js";

type VitestTask = {
  name?: string;
  fullName?: string;
  type?: string;
  mode?: string;
  result?: {
    state?: string;
    duration?: number;
    errors?: Array<{ message?: string } | string>;
  };
  tasks?: VitestTask[];
};

type VitestJsonArtifact = {
  testResults?: Array<{
    name?: string;
    assertionResults?: Array<{
      title?: string;
      fullName?: string;
      status?: string;
      duration?: number;
      failureMessages?: string[];
    }>;
  }>;
  files?: VitestTask[];
};

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function collectFromVitestTasks(
  tasks: VitestTask[],
  results: EvalResultInput[],
  indexRef: { value: number }
) {
  for (const task of tasks) {
    if (task.type === "test") {
      const state = task.result?.state;
      const isSkipped =
        state === "skipped" ||
        state === "todo" ||
        task.mode === "skip" ||
        task.mode === "todo";
      if (isSkipped) {
        continue;
      }
      const caseTitle = task.fullName || task.name || "test";
      const passed = state === "pass";
      const errors = Array.isArray(task.result?.errors)
        ? task.result?.errors
        : [];
      const error =
        passed || errors.length === 0
          ? undefined
          : errors
              .map((entry) =>
                typeof entry === "string"
                  ? entry
                  : (entry.message ?? "Test failed")
              )
              .join("\n");
      results.push({
        caseTitle,
        query: caseTitle,
        passed,
        durationMs: task.result?.duration,
        externalIterationId: `${sanitizeId(caseTitle)}-${indexRef.value + 1}`,
        error,
      });
      indexRef.value += 1;
    }
    if (Array.isArray(task.tasks) && task.tasks.length > 0) {
      collectFromVitestTasks(task.tasks, results, indexRef);
    }
  }
}

export function parseVitestJsonArtifact(
  artifact: VitestJsonArtifact
): EvalResultInput[] {
  const results: EvalResultInput[] = [];
  const indexRef = { value: 0 };

  if (Array.isArray(artifact.testResults)) {
    for (const suite of artifact.testResults) {
      const assertions = Array.isArray(suite.assertionResults)
        ? suite.assertionResults
        : [];
      for (const assertion of assertions) {
        const status = assertion.status ?? "failed";
        const isSkipped =
          status === "skipped" || status === "pending" || status === "todo";
        if (isSkipped) {
          continue;
        }
        const caseTitle =
          assertion.fullName || assertion.title || suite.name || "test";
        const passed = status === "passed";
        const failureMessages = Array.isArray(assertion.failureMessages)
          ? assertion.failureMessages
          : [];
        const error =
          passed || failureMessages.length === 0
            ? undefined
            : failureMessages.join("\n");
        results.push({
          caseTitle,
          query: caseTitle,
          passed,
          durationMs: assertion.duration,
          externalIterationId: `${sanitizeId(caseTitle)}-${indexRef.value + 1}`,
          error,
        });
        indexRef.value += 1;
      }
    }
  }

  if (results.length === 0 && Array.isArray(artifact.files)) {
    collectFromVitestTasks(artifact.files, results, indexRef);
  }

  if (results.length === 0) {
    throw new Error("No test results found in Vitest JSON artifact");
  }

  return results;
}
