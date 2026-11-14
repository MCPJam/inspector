/**
 * JUnit XML for a composite conformance run (`runConformance`).
 *
 * One document, one `<testsuites>` root, every suite's `<testsuite>` elements
 * beneath it. Rendering each suite as its own document and concatenating them
 * produces a second XML prolog and a second root, which no JUnit consumer can
 * parse.
 */

import { renderConformanceReportJUnitSuites } from "./conformance-reporting.js";
import {
  CONFORMANCE_SUITE_KINDS,
  type ConformanceRunReportV1,
} from "./conformance-run-types.js";

const RUN_NAME = "MCPJam Conformance";

export function renderConformanceRunJUnitXml(
  run: ConformanceRunReportV1
): string {
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const parts: string[] = [];

  for (const kind of CONFORMANCE_SUITE_KINDS) {
    if (!run.requestedSuites.includes(kind)) continue;
    const report = run.reports[kind];
    if (!report) {
      // A requested suite that never reported leaves the run incomplete. It
      // still gets a testsuite, so the file accounts for every suite asked for.
      tests += 1;
      skipped += 1;
      parts.push(
        `  <testsuite name="${kind}" tests="1" failures="0" skipped="1" time="0.000">\n` +
          `    <testcase name="${kind} suite" classname="mcpjam.${kind}" time="0.000">\n` +
          `      <skipped message="The ${kind} suite did not report results, so the run is incomplete."/>\n` +
          `    </testcase>\n` +
          `  </testsuite>`
      );
      continue;
    }
    const suites = renderConformanceReportJUnitSuites(report);
    tests += suites.tests;
    failures += suites.failures;
    skipped += suites.skipped;
    if (suites.xml) parts.push(suites.xml);
  }

  const time = (run.durationMs / 1000).toFixed(3);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${RUN_NAME}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${parts.join("\n")}\n</testsuites>\n`;
}
