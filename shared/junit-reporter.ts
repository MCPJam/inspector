import { XMLBuilder } from "fast-xml-parser";

export type TestToolSummary = {
  calledTools: string[];
  missingTools: string[];
  unexpectedTools: string[];
  error?: string;
};

export type TestRunResult = {
  title: string;
  passed: boolean;
  durationMs: number;
  summary: TestToolSummary;
};

export type SuiteResult = {
  suiteName: string;
  results: TestRunResult[];
};

export function generateJUnitXML({ suiteName, results }: SuiteResult): string {
  const numTests = results.length;
  const numFailures = results.filter((r) => !r.passed).length;
  const timeSeconds = results.reduce((acc, r) => acc + r.durationMs, 0) / 1000;

  const testcases = results.map((r) => {
    const systemOut = [
      `called: ${r.summary.calledTools.join(", ") || "(none)"}`,
      `missing: ${r.summary.missingTools.join(", ") || "(none)"}`,
      `unexpected: ${r.summary.unexpectedTools.join(", ") || "(none)"}`,
      r.summary.error ? `error: ${r.summary.error}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    const testcase: any = {
      "@_name": r.title,
      "@_time": (r.durationMs / 1000).toFixed(3),
      "system-out": systemOut,
    };
    if (!r.passed) {
      const message = r.summary.error
        ? r.summary.error
        : `Missing tools: ${r.summary.missingTools.join(", ") || "(none)"}; Unexpected tools: ${
            r.summary.unexpectedTools.join(", ") || "(none)"
          }`;
      testcase.failure = {
        "@_message": message,
      };
    }
    return testcase;
  });

  const root = {
    testsuite: {
      "@_name": suiteName || "MCPJAM Tests",
      "@_tests": String(numTests),
      "@_failures": String(numFailures),
      "@_time": timeSeconds.toFixed(3),
      testcase: testcases,
    },
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
  });
  return builder.build(root);
}

