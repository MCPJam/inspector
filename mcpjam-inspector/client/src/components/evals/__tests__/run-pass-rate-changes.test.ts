import { describe, expect, it } from "vitest";
import { buildRunPassRateChanges } from "../run-pass-rate-changes";
import type { ProjectRunRow } from "../project-runs-table";
import type { SuiteRunHistoryRow } from "../../evaluate/suite-detail-model";

const row = (
  id: string,
  suiteId: string,
  runNumber: number,
  status = "completed",
) =>
  ({
    _id: id,
    suiteId,
    runNumber,
    createdAt: runNumber * 1000,
    status,
    result: "passed",
  } as ProjectRunRow);
const rates = (values: Record<string, number | null>) =>
  new Map(
    Object.entries(values).map(([id, passRate]) => [
      id,
      { passRate } as SuiteRunHistoryRow,
    ]),
  );

describe("run pass-rate changes", () => {
  it("reports up, down, and unchanged percentage points within each suite", () => {
    const rows = [
      row("a4", "a", 4),
      row("b2", "b", 2),
      row("a2", "a", 2),
      row("a3", "a", 3),
      row("a1", "a", 1),
      row("b1", "b", 1),
    ];
    const changes = buildRunPassRateChanges(
      rows,
      rates({ a1: 40, a2: 70, a3: 50, a4: 50, b1: 90, b2: 100 }),
    );
    expect(changes.get("a2")).toEqual({ points: 30, previousRunNumber: 1 });
    expect(changes.get("a3")).toEqual({ points: -20, previousRunNumber: 2 });
    expect(changes.get("a4")).toEqual({ points: 0, previousRunNumber: 3 });
    expect(changes.get("b2")).toEqual({ points: 10, previousRunNumber: 1 });
    expect(changes.has("a1")).toBe(false);
  });

  it("does not invent a baseline for missing, unfinished, or inconclusive runs", () => {
    for (const previous of [
      row("old", "a", 1, "running"),
      { ...row("old", "a", 1), result: "inconclusive" } as ProjectRunRow,
    ]) {
      expect(
        buildRunPassRateChanges(
          [previous, row("new", "a", 2)],
          rates({ old: 20, new: 80 }),
        ).size,
      ).toBe(0);
    }
    expect(
      buildRunPassRateChanges(
        [row("old", "a", 1), row("missing", "a", 2), row("new", "a", 3)],
        rates({ old: 20, new: 80 }),
      ).size,
    ).toBe(0);
    expect(
      buildRunPassRateChanges(
        [row("old", "a", 1), row("new", "a", 2, "grading")],
        rates({ old: 20, new: 80 }),
      ).size,
    ).toBe(0);
  });

  it("orders simultaneous runs by their run number", () => {
    const rows = [
      { ...row("new", "a", 2), createdAt: 1000 },
      row("old", "a", 1),
    ];
    expect(
      buildRunPassRateChanges(rows, rates({ old: 0, new: 70 })).get("new")
        ?.points,
    ).toBe(70);
  });
});
