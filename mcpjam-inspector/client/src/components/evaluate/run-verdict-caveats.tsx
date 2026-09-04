/**
 * How this verdict was counted — the honesty, one level down.
 *
 * Every sentence here was previously in the run-decision card's headline, where
 * it read as a disclaimer: "from legacy percent-threshold run", "counted in
 * trials — so these are trials, not cases", "1 non-passing of 3 trials
 * examined". Each is TRUE and worth keeping, and none of them is what a reader
 * opening a failed run needs first. Folding them under a disclosure keeps the
 * claim available to anyone who asks how a number was reached without making
 * everyone else read the accounting before the finding.
 *
 * Nothing here is re-derived: the lines come from the same presentation helpers
 * the existing card uses, so the two surfaces cannot drift into telling
 * different stories about one run.
 */
import {
  decisionReasonLines,
  decisionUndecidedLine,
  decisionVerdictSourceLabel,
  describeDiagnosticsScope,
} from "../evals/run-decision-summary-presentation";
import type { EvalRunDecisionSummary } from "@mcpjam/sdk/contract";

export function RunVerdictCaveats({
  summary,
  shownDiagnostics,
  scannedIterations,
  serverComplete,
  walkExhausted,
}: {
  summary: EvalRunDecisionSummary | null;
  shownDiagnostics: number;
  scannedIterations: number;
  serverComplete: boolean;
  walkExhausted: boolean;
}) {
  if (!summary) return null;

  const lines: string[] = [];

  lines.push(
    `The verdict comes from the ${decisionVerdictSourceLabel(summary)}.`,
  );

  if (summary.counts?.measurementUnit === "trial") {
    // The distinction the old card shouted and this one states: a legacy run
    // counts executions, so its "2 of 3" is not a count of cases.
    lines.push(
      "Counts are iterations, not cases. A legacy run tallies each execution, so a case that ran twice is counted twice.",
    );
  } else if (summary.counts?.measurementUnit === "caseVariant") {
    lines.push(
      "Counts are cases. Each case passes when its own iterations clear its threshold, and the run passes when every case does.",
    );
  }

  const undecided = decisionUndecidedLine(summary);
  if (undecided) lines.push(`No verdict was established: ${undecided}.`);

  for (const reason of decisionReasonLines(summary)) {
    lines.push(reason);
  }

  lines.push(
    describeDiagnosticsScope({
      shown: shownDiagnostics,
      scannedIterations,
      serverComplete,
      walkExhausted,
    }),
  );

  lines.push(
    "A first failed stage is where a chain stopped passing checks. It is a location, not a claim about what caused the stop.",
  );

  return (
    <details
      className="group rounded-lg border border-border/40 bg-muted/20 px-4 py-3"
      data-testid="run-verdict-caveats"
    >
      <summary className="cursor-pointer list-none text-[12.5px] text-muted-foreground marker:content-none hover:text-foreground">
        How this verdict was counted
      </summary>
      <ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-relaxed text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}
