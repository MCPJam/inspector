import { describe, expect, it } from "vitest";
import {
  formatCaseTitleForSidebar,
  getEvalCaseSidebarGroupKey,
  groupEvalCasesForSidebar,
} from "../case-name-utils";

describe("case-name-utils", () => {
  it("groups iter-suffixed cases under a shared prefix", () => {
    const key = getEvalCaseSidebarGroupKey("suite-get_task-iter-1");
    expect(key).toBe("suite-get_task");
  });

  it("formats iter cases with suffix on line 1 and base on line 2", () => {
    const f = formatCaseTitleForSidebar("suite-get_task-iter-2");
    expect(f.line1).toBe("iter-2");
    expect(f.line2).toBe("suite-get_task");
    expect(f.fullTitle).toBe("suite-get_task-iter-2");
  });

  it("groups multiple cases in sidebar order", () => {
    const grouped = groupEvalCasesForSidebar([
      { _id: "a", title: "suite-get_task-iter-2" },
      { _id: "b", title: "suite-get_task-iter-1" },
      { _id: "c", title: "standalone-case" },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].groupKey).toBe("standalone-case");
    expect(grouped[1].cases.map((c) => c.title)).toEqual([
      "suite-get_task-iter-1",
      "suite-get_task-iter-2",
    ]);
  });
});
