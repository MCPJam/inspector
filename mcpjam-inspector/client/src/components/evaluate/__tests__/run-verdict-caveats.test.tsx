import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readAllDecisionSummaryFixtures } from "@/test/eval-decision-summary-fixtures";
import { RunVerdictCaveats } from "../run-verdict-caveats";

afterEach(cleanup);

it("explains suite-wide execution counts without policy-version vocabulary", () => {
  const summary = readAllDecisionSummaryFixtures().find(
    ([, summary]) => summary.counts?.measurementUnit === "trial",
  )![1];
  const { container } = render(
    <RunVerdictCaveats
      summary={summary}
      shownDiagnostics={0}
      scannedIterations={0}
      serverComplete={true}
      walkExhausted={true}
    />,
  );
  expect(container.textContent).toContain(
    "A run decided by the suite accuracy threshold tallies each execution, so a case that ran twice is counted twice.",
  );
  expect(container.textContent).not.toMatch(
    /legacy|\bv2\b|upgrade|migrate|deprecated/i,
  );
});
