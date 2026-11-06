import { describe, expect, it } from "vitest";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import type {
  JoinedScorecardGroup,
  JoinedScorecardRow,
  TrialRowResult,
} from "../../case-scorecard/trial-results";
import {
  buildTestRunScorecard,
  iterationScorecardGroups,
} from "../test-run-scorecard-model";
import { fixtureIteration, RUN_A } from "./test-run-fixtures";

function row(
  label: string,
  state: TrialRowResult["state"],
  extra: Partial<JoinedScorecardRow> = {},
): JoinedScorecardRow {
  return {
    key: label,
    stage: "selection",
    provenance: "case",
    label,
    kindLabel: label,
    role: "required",
    roleLock: "none",
    editable: false,
    tooltip: "",
    result: { state } as TrialRowResult,
    ...extra,
  };
}
const groupOf = (
  stage: UserValueStage,
  label: string,
  rows: JoinedScorecardRow[],
): JoinedScorecardGroup => ({ stage, label, question: "", rows });

const it1 = fixtureIteration("i1", "run-a");
const it2 = fixtureIteration("i2", "run-a", { result: "failed" });
const it3 = fixtureIteration("i3", "run-a", {
  result: "timed_out",
  status: "timed_out",
});

describe("buildTestRunScorecard", () => {
  it("totals one assertion across iterations into one row", () => {
    const card = buildTestRunScorecard([
      {
        iteration: it1,
        groups: [groupOf("selection", "Selection", [row("Reach", "passed")])],
      },
      {
        iteration: it2,
        groups: [groupOf("selection", "Selection", [row("Reach", "failed")])],
      },
      {
        iteration: it3,
        groups: [
          groupOf("selection", "Selection", [row("Reach", "notMeasured")]),
        ],
      },
    ]);
    expect(card.total).toBe(3);
    expect(card.timedOut).toBe(1);
    expect(card.stages).toEqual([
      {
        stage: "selection",
        label: "Selection",
        rows: [
          {
            key: "selection|case|Reach",
            label: "Reach",
            role: "required",
            builtin: false,
            passed: 1,
            failed: 1,
            firstFailedIterationId: "i2",
          },
        ],
      },
    ]);
  });

  it("flags built-in and advisory rows and keeps the first failing iteration", () => {
    const card = buildTestRunScorecard([
      {
        iteration: it2,
        groups: [
          groupOf("connection", "Connection", [
            row("Connected", "failed", {
              provenance: "builtin",
              stage: "connection",
            }),
          ]),
          groupOf("userValue", "User value", [
            row("Tokens", "passed", { role: "advisory", stage: "userValue" }),
          ]),
        ],
      },
      {
        iteration: it1,
        groups: [
          groupOf("connection", "Connection", [
            row("Connected", "failed", {
              provenance: "builtin",
              stage: "connection",
            }),
          ]),
        ],
      },
    ]);
    const [connection, userValue] = card.stages;
    expect(connection.rows[0]).toMatchObject({
      builtin: true,
      failed: 2,
      firstFailedIterationId: "i2",
    });
    expect(userValue.rows[0]).toMatchObject({ role: "advisory", passed: 1 });
  });

  it("leaves rows nobody measured at zero, and orders stages by the chain", () => {
    const card = buildTestRunScorecard([
      {
        iteration: it1,
        groups: [
          groupOf("response", "Response", [row("Errors", "skipped")]),
          groupOf("discovery", "Discovery", [row("Listed", "notMeasured")]),
        ],
      },
    ]);
    expect(card.stages.map((stage) => stage.stage)).toEqual([
      "discovery",
      "response",
    ]);
    expect(card.stages[0].rows[0]).toMatchObject({ passed: 0, failed: 0 });
  });
});

describe("iterationScorecardGroups", () => {
  it("composes the recorded iteration's groups without a report", () => {
    const groups = iterationScorecardGroups({
      iteration: it1,
      run: RUN_A,
      chain: null,
    });
    expect(Array.isArray(groups)).toBe(true);
    for (const group of groups) {
      for (const scored of group.rows) expect(scored.result.state).toBeTruthy();
    }
  });
});
