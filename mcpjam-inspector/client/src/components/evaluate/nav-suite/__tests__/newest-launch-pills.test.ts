import { describe, expect, it } from "vitest";
import type { EvalSuiteRunListItem } from "@/components/evals/types";
import { newestLaunchPills } from "../newest-launch-pills";

function run(
  overrides: Partial<EvalSuiteRunListItem> & { _id: string },
): EvalSuiteRunListItem {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    configRevision: "1",
    runNumber: 1,
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    namedHostId: "host-1",
    ...overrides,
  };
}

const hosts = new Map<string, string | null>([
  ["host-1", "Claude"],
  ["host-2", "Cursor"],
]);

describe("newestLaunchPills", () => {
  it("names the newest run's model and client", () => {
    expect(
      newestLaunchPills(
        [
          run({ _id: "a", runNumber: 1, effectiveModelId: "old-model" }),
          run({ _id: "b", runNumber: 2, effectiveModelId: "new-model" }),
        ],
        hosts,
      ),
    ).toEqual({ models: ["new-model"], clients: ["Claude"] });
  });

  it("returns nothing for a suite that has never run", () => {
    expect(newestLaunchPills([], hosts)).toEqual({ models: [], clients: [] });
  });
});
