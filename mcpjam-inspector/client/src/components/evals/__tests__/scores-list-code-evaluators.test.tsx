import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  buildEvaluationConfigSnapshot,
  errorScoreResult,
  finalizeScoreResult,
  resolveScoreDefinition,
  type ScoreDefinition,
} from "@mcpjam/sdk/contract";
import { ScoresList } from "../scores-list";
import { parseCodeEvaluatorLogs } from "../code-grading/code-evaluator-score-logs";

// The `code:<id>` definitions a run declares: Required fails closed on an
// error or a skip, Advisory ignores both (`code-score-family.ts`).
function codeDefinition(
  id: string,
  label: string,
  role: "required" | "advisory",
): ScoreDefinition {
  const required = role === "required";
  return {
    scorerId: `code:${id}`,
    idSource: "explicit",
    scorerVersion: "1",
    implementationHash: `impl-${id}`,
    label,
    deterministic: true,
    passThreshold: 1,
    role,
    onError: required ? "fail" : "ignore",
    onSkipped: required ? "fail" : "ignore",
  };
}

const TOTALS = codeDefinition(
  "check_totals",
  "Invoice totals add up",
  "required",
);
const LEDGER = codeDefinition(
  "match_ledger",
  "Totals match the ledger",
  "required",
);
const REPORT = codeDefinition("report_exists", "Report written", "advisory");
const ASSERTION: ScoreDefinition = {
  scorerId: "refund-mentioned",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-refund",
  label: "refund is mentioned",
  deterministic: true,
  passThreshold: 1,
  role: "required",
};
const snapshot = buildEvaluationConfigSnapshot([
  TOTALS,
  LEDGER,
  REPORT,
  ASSERTION,
]);
const resolved = (definition: ScoreDefinition) =>
  resolveScoreDefinition(definition);

const passed = finalizeScoreResult(resolved(TOTALS), {
  kind: "scored",
  value: 1,
  rationale: "Every invoice total matches its items",
  evidence: ["Checked 2 invoices"],
});
const timedOut = errorScoreResult(
  resolved(LEDGER),
  "Stopped at its time limit.",
);
const reportFailed = finalizeScoreResult(resolved(REPORT), {
  kind: "scored",
  value: 0,
  rationale: "The agent didn't write /home/user/app/report.json",
});
const assertionPassed = finalizeScoreResult(resolved(ASSERTION), {
  kind: "scored",
  value: 1,
});

const LOGS = parseCodeEvaluatorLogs(
  {
    codeEvaluatorLogs: {
      "code:check_totals": {
        output: "Read 3 tool calls\nChecked 2 invoices\n",
      },
      "code:match_ledger": { output: "Requesting rates\n", durationMs: 60_000 },
      "code:report_exists": { output: "" },
    },
  },
  [
    { id: "check_totals", fileName: "check_totals.py" },
    { id: "match_ledger", fileName: "match_ledger.ts" },
    { id: "report_exists", fileName: "report_exists.sh" },
  ],
);

function renderScores(
  scores = [passed, timedOut, reportFailed, assertionPassed],
) {
  render(
    <ScoresList
      scores={scores}
      evaluationConfig={snapshot}
      codeEvaluatorLogs={LOGS}
    />,
  );
}

const row = (label: string) => screen.getByText(label).closest("li")!;

describe("code evaluator rows on the scorecard", () => {
  it("groups them under Code evaluators, Required apart from Advisory", () => {
    renderScores();
    const code = screen.getByRole("region", { name: "Code evaluators" });
    const groups = within(code).getAllByRole("list");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("Invoice totals add up");
    expect(groups[0]).toHaveTextContent("Totals match the ledger");
    expect(groups[1]).toHaveTextContent("Report written");
    // Other scores keep their own groups.
    expect(code).not.toHaveTextContent("refund is mentioned");
  });

  it("names each row's file beside its logs", () => {
    renderScores();
    const logs = within(row("Invoice totals add up"))
      .getByText("Logs")
      .closest("details")!;
    expect(logs).toHaveTextContent("Logs check_totals.py");
    expect(logs).not.toHaveAttribute("open");
    const output = logs.querySelector("pre")!;
    expect(output).toHaveTextContent("Checked 2 invoices");
    expect(output.className).toContain("font-code");
    expect(output.className).toContain("[font-variant-ligatures:none]");
    // The evidence line repeats the logs, so it stays out of the row.
    expect(
      within(row("Invoice totals add up")).getAllByText(/Checked 2 invoices/),
    ).toHaveLength(1);
    expect(
      within(row("Report written")).getByText("No output."),
    ).toBeInTheDocument();
  });

  it("leaves an iteration with a Required error out of the pass rate", () => {
    renderScores();
    expect(
      screen.getByText("unresolved, left out of the pass rate"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/required evaluators passed/)).toBeNull();
    const ledger = row("Totals match the ledger");
    expect(ledger).toHaveTextContent("Stopped at its time limit.");
    expect(ledger).toHaveTextContent("Not counted as a failure.");
    // An evaluator error is not styled as the reason the iteration failed.
    expect(ledger.className).not.toContain("border-destructive");
  });

  it("says every code evaluator error isn't counted as a failure", () => {
    const advisoryError = errorScoreResult(
      resolved(REPORT),
      "It finished without writing a result to $MCPJAM_RESULT.",
    );
    renderScores([passed, advisoryError]);
    expect(row("Report written")).toHaveTextContent(
      "Not counted as a failure.",
    );
    // An Advisory error leaves the count alone.
    expect(
      screen.getByText("1 / 1 required evaluators passed"),
    ).toBeInTheDocument();
  });

  it("still fails the iteration on a Required evaluator that scored low", () => {
    const low = finalizeScoreResult(resolved(TOTALS), {
      kind: "scored",
      value: 0,
    });
    renderScores([low]);
    expect(
      screen.getByText("0 / 1 required evaluators passed"),
    ).toBeInTheDocument();
    expect(row("Invoice totals add up").className).toContain(
      "border-destructive",
    );
  });
});

describe("parseCodeEvaluatorLogs", () => {
  it("keeps code rows' logs, named from the run's evaluators", () => {
    expect(
      parseCodeEvaluatorLogs(
        {
          codeEvaluatorLogs: {
            "code:a": { output: "hi", exitCode: 0 },
            "code:b": { output: 42 },
            "judge:x": { output: "not code" },
          },
        },
        [{ id: "a", fileName: "a.py" }],
      ),
    ).toEqual({ "code:a": { output: "hi", fileName: "a.py" } });
    expect(parseCodeEvaluatorLogs(undefined)).toEqual({});
    expect(
      parseCodeEvaluatorLogs({
        codeEvaluatorLogs: { "code:a": { output: "x" } },
      }),
    ).toEqual({ "code:a": { output: "x" } });
  });
});
