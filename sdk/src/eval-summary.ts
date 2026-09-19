import type { EvalRunResult } from "./EvalTest.js";
import type { EvalSuiteResult } from "./EvalSuite.js";
import type { EvalReportingReceipt } from "./eval-reporting-types.js";
import { definitionHash } from "./contract/derive.js";
import { meanValueOf } from "./contract/scorer-rollup.js";
import { calculateLatencyStats } from "./percentiles.js";

/** Local observations only. Hosted policy decisions are never recomputed here. */
export function formatRunSummaryTable(
  result: EvalRunResult | EvalSuiteResult,
  receipt?: EvalReportingReceipt
): string {
  const cases =
    "tests" in result
      ? [...result.tests.entries()]
      : [["Case", result] as const];
  const lines = [
    "Case | Evaluator | Scored | Error | Skipped | Not applicable | Unmeasured | Mean",
  ];
  let total = 0;
  let passed = 0;
  const latencies: number[] = [];
  const safe = (value: string) =>
    value.replace(/[\r\n\t|\u001b]/g, " ").slice(0, 160);
  for (const [name, run] of cases) {
    total += run.iterations;
    passed += run.successes;
    for (const iteration of run.iterationDetails)
      for (const latency of iteration.latencies) {
        if (Number.isFinite(latency.e2eMs)) latencies.push(latency.e2eMs);
      }
    for (const definition of run.evaluationConfig?.definitions ?? []) {
      const hash = definitionHash(definition);
      const rows = run.iterationDetails.flatMap(
        (iteration) =>
          iteration.scores?.filter((row) => row.definitionHash === hash) ?? []
      );
      const values = rows.flatMap((row) =>
        row.status === "scored" && row.value !== undefined ? [row.value] : []
      );
      const mean = meanValueOf(values);
      lines.push(
        [
          safe(name),
          safe(definition.label ?? definition.scorerId),
          values.length,
          rows.filter((row) => row.status === "error").length,
          rows.filter((row) => row.status === "skipped").length,
          rows.filter((row) => row.status === "not_applicable").length,
          Math.max(0, run.iterations - rows.length),
          mean === null ? "not measured" : mean.toFixed(3),
        ].join(" | ")
      );
    }
  }
  lines.push(
    `Overall: ${passed}/${total} iterations passed${total === 0 ? " (no execution)" : ""}`
  );
  lines.push(
    `Observed prompt latency p95: ${latencies.length ? `${calculateLatencyStats(latencies).p95.toFixed(1)} ms (${latencies.length} prompt samples)` : "not measured"}`
  );
  if ("selection" in result && result.selection)
    lines.push(
      `Selection: ${result.selection.scope} (${result.selection.selectedCaseIds.length}/${result.selection.sourceCaseIds.length} cases)`
    );
  if (receipt)
    lines.push(
      `Reporting: ${receipt.state}${receipt.report?.url ? ` — ${receipt.report.url}` : ""}`
    );
  return lines.join("\n");
}
