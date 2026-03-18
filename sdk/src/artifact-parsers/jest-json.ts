import type { EvalResultInput } from "../eval-reporting-types.js";

type JestAssertion = {
  title?: string;
  fullName?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
  ancestorTitles?: string[];
};

type JestSuite = {
  assertionResults?: JestAssertion[];
  name?: string;
};

type JestJsonArtifact = {
  testResults?: JestSuite[];
};

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

export function parseJestJsonArtifact(
  artifact: JestJsonArtifact
): EvalResultInput[] {
  const suites = Array.isArray(artifact.testResults)
    ? artifact.testResults
    : [];
  const results: EvalResultInput[] = [];
  let index = 0;

  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults)
      ? suite.assertionResults
      : [];
    for (const assertion of assertions) {
      const status = assertion.status ?? "failed";
      const isSkipped =
        status === "skipped" ||
        status === "pending" ||
        status === "todo" ||
        status === "disabled";
      if (isSkipped) {
        continue;
      }
      const fullName =
        assertion.fullName ||
        [...(assertion.ancestorTitles ?? []), assertion.title ?? ""]
          .filter(Boolean)
          .join(" ");
      const caseTitle = fullName || assertion.title || suite.name || "test";
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
        durationMs:
          typeof assertion.duration === "number"
            ? assertion.duration
            : undefined,
        externalIterationId: `${sanitizeId(caseTitle)}-${index + 1}`,
        error,
      });
      index += 1;
    }
  }

  if (results.length === 0) {
    throw new Error("No assertion results found in Jest JSON artifact");
  }

  return results;
}
