import { describe, expect, it } from "vitest";
import {
  groupProjectRuns,
  projectRunRollup,
  suiteRollupRows,
} from "../project-run-suite-groups";
import type { ProjectRunRow } from "../project-runs-table";
import type { ProjectRunHistoryDetail } from "../use-project-run-history";

const row = (id: string, suiteId: string, createdAt: number) =>
  ({
    _id: id,
    suiteId,
    suiteName: "Same name",
    createdAt,
    runNumber: createdAt,
  } as ProjectRunRow);
const detail = (
  id: string,
  total: number,
  passed: number,
  runGroupId?: string,
): ProjectRunHistoryDetail => ({
  run: {
    _id: id,
    runGroupId,
    summary: { total, passed, failed: total - passed },
  } as ProjectRunHistoryDetail["run"],
  iterations: [],
});

describe("project suite grouping", () => {
  it("keeps same-named suites and coincident launch IDs distinct, newest first", () => {
    const rows = [
      row("old", "a", 1),
      row("other", "b", 2),
      row("new", "a", 3),
      row("solo", "a", 0),
    ];
    const details = new Map(
      rows.map((run) => [
        run._id,
        detail(run._id, 1, 1, run._id === "solo" ? undefined : "shared"),
      ]),
    );
    const groups = groupProjectRuns(rows, details);
    expect(groups.map((group) => group.suiteId)).toEqual(["a", "b"]);
    expect(
      groups[0].launches.map((launch) => launch.runs.map((run) => run._id)),
    ).toEqual([["new", "old"], ["solo"]]);
    expect(groups[1].launches[0].runs.map((run) => run._id)).toEqual(["other"]);
    expect(groupProjectRuns([], details)).toEqual([]);
  });

  it("weights suite pass rates by the iteration population and withholds incomplete totals", () => {
    const rows = [row("small", "a", 1), row("large", "a", 2)];
    const details = new Map([
      ["small", detail("small", 1, 1)],
      ["large", detail("large", 9, 0)],
    ]);
    expect(projectRunRollup(rows, details)).toMatchObject({
      total: 10,
      passed: 1,
      passRate: 10,
      totalTokens: null,
      latencyP50: null,
      toolCalls: null,
    });
    details.delete("large");
    expect(projectRunRollup(rows, details)).toBeNull();
    details.set("large", detail("large", 0, 0));
    expect(projectRunRollup([rows[1]], details)?.passRate).toBeNull();
  });

  it("leaves a subset rerun out of the suite roll-up but keeps it listed", () => {
    const rows = [row("full", "a", 1), row("rerun", "a", 2)];
    const rerun = detail("rerun", 1, 1);
    rerun.run.rerunOfRunId = "full";
    rerun.run.rerunScope = "failed_cases";
    const details = new Map([
      ["full", detail("full", 4, 2)],
      ["rerun", rerun],
    ]);
    // Counting the rerun would make the failed case pass on its second try.
    expect(projectRunRollup(rows, details)?.passRate).toBe(60);
    expect(
      projectRunRollup(suiteRollupRows(rows, details), details)?.passRate,
    ).toBe(50);
    expect(groupProjectRuns(rows, details)[0].rows).toHaveLength(2);
    // A row whose detail has not loaded is kept, so the roll-up waits for it.
    expect(
      suiteRollupRows(rows, new Map([["full", detail("full", 4, 2)]])),
    ).toHaveLength(2);
  });
});
