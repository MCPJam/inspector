import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCENARIO_TASK_HINT_MAX,
  SCENARIO_TASK_LIMIT,
  SCENARIO_TASK_TITLE_MAX,
  mintScenarioTaskId,
  readScenarioTaskChecks,
  scenarioTaskDraftsFromSettings,
  scenarioTasksEqual,
  scenarioTasksFromDrafts,
  scenarioTasksRemainingLabel,
  writeScenarioTaskChecks,
} from "@/lib/scenario-tasks";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("scenarioTaskDraftsFromSettings", () => {
  it("tolerates a backend that never sends the surface", () => {
    // Additive field: absent, null, and a `tasks` object with no `items` all
    // mean "no tasks", because the deployment on the other end is not one this
    // build controls.
    expect(scenarioTaskDraftsFromSettings(undefined)).toEqual([]);
    expect(scenarioTaskDraftsFromSettings(null)).toEqual([]);
    expect(scenarioTaskDraftsFromSettings({} as never)).toEqual([]);
  });

  it("carries titles and hints into editable rows", () => {
    expect(
      scenarioTaskDraftsFromSettings({
        items: [
          { id: "a", title: "One", hint: "detail" },
          { id: "b", title: "Two" },
        ],
      }),
    ).toEqual([
      { id: "a", title: "One", hint: "detail" },
      { id: "b", title: "Two", hint: "" },
    ]);
  });

  it("mints an id for a row stored without one", () => {
    // The id keys the tester's local check state, so a row cannot go into the
    // editor without one — two blank ids would make one checkbox drive two
    // rows.
    const drafts = scenarioTaskDraftsFromSettings({
      items: [
        { id: "", title: "One" },
        { id: "", title: "Two" },
      ],
    });
    expect(drafts[0].id).not.toBe("");
    expect(drafts[0].id).not.toBe(drafts[1].id);
  });
});

describe("scenarioTasksFromDrafts", () => {
  it("drops blank rows rather than making them an error", () => {
    // An empty trailing row is how the editor offers the next task; pressing
    // Save with one open is not a mistake to report.
    expect(
      scenarioTasksFromDrafts([
        { id: "a", title: "Real", hint: "" },
        { id: "b", title: "   ", hint: "orphan hint" },
      ]),
    ).toEqual([{ id: "a", title: "Real" }]);
  });

  it("omits an empty hint instead of storing a blank one", () => {
    const [item] = scenarioTasksFromDrafts([
      { id: "a", title: "Real", hint: "   " },
    ]);
    expect(item).toEqual({ id: "a", title: "Real" });
    expect("hint" in item).toBe(false);
  });

  it("trims and truncates to the stored limits", () => {
    const [item] = scenarioTasksFromDrafts([
      {
        id: "a",
        title: `  ${"x".repeat(SCENARIO_TASK_TITLE_MAX + 20)}  `,
        hint: "y".repeat(SCENARIO_TASK_HINT_MAX + 20),
      },
    ]);
    expect(item.title).toHaveLength(SCENARIO_TASK_TITLE_MAX);
    expect(item.hint).toHaveLength(SCENARIO_TASK_HINT_MAX);
  });

  it("caps the list at the same number the editor stops offering", () => {
    const items = scenarioTasksFromDrafts(
      Array.from({ length: SCENARIO_TASK_LIMIT + 3 }, (_, i) => ({
        id: `t${i}`,
        title: `Task ${i}`,
        hint: "",
      })),
    );
    expect(items).toHaveLength(SCENARIO_TASK_LIMIT);
  });
});

describe("scenarioTasksEqual", () => {
  it("treats an absent hint and an empty one as the same stored task", () => {
    expect(
      scenarioTasksEqual(
        [{ id: "a", title: "One" }],
        [{ id: "a", title: "One", hint: "" }],
      ),
    ).toBe(true);
  });

  it("notices a reorder, a rename, and a length change", () => {
    const base = [
      { id: "a", title: "One" },
      { id: "b", title: "Two" },
    ];
    expect(scenarioTasksEqual(base, [base[1], base[0]])).toBe(false);
    expect(
      scenarioTasksEqual(base, [{ id: "a", title: "One!" }, base[1]]),
    ).toBe(false);
    expect(scenarioTasksEqual(base, [base[0]])).toBe(false);
  });
});

describe("scenarioTasksRemainingLabel", () => {
  it("counts what is left, not what exists", () => {
    // A tester reads this to decide whether to keep going; "3 of 5" makes them
    // do the subtraction.
    expect(scenarioTasksRemainingLabel(3, 0)).toBe("3 left");
    expect(scenarioTasksRemainingLabel(3, 2)).toBe("1 left");
  });

  it("says Done rather than 0 left", () => {
    // Zero-of-anything reads as an error state.
    expect(scenarioTasksRemainingLabel(3, 3)).toBe("Done");
    // And a creator who removed tasks after the tester ticked them must not
    // produce a negative count.
    expect(scenarioTasksRemainingLabel(1, 4)).toBe("Done");
  });

  it("has nothing left when there is nothing to do", () => {
    expect(scenarioTasksRemainingLabel(0, 0)).toBe("Done");
  });
});

describe("tester check state", () => {
  it("round-trips per scenario", () => {
    writeScenarioTaskChecks("sbx_a", ["t1", "t2"]);
    writeScenarioTaskChecks("sbx_b", ["t9"]);
    expect(readScenarioTaskChecks("sbx_a")).toEqual(["t1", "t2"]);
    expect(readScenarioTaskChecks("sbx_b")).toEqual(["t9"]);
    expect(readScenarioTaskChecks("sbx_missing")).toEqual([]);
  });

  it("ignores stored junk rather than throwing at the tester", () => {
    sessionStorage.setItem("scenario-tasks-checked-sbx_bad", "not json");
    expect(readScenarioTaskChecks("sbx_bad")).toEqual([]);

    sessionStorage.setItem(
      "scenario-tasks-checked-sbx_shape",
      JSON.stringify({ t1: true }),
    );
    expect(readScenarioTaskChecks("sbx_shape")).toEqual([]);

    sessionStorage.setItem(
      "scenario-tasks-checked-sbx_mixed",
      JSON.stringify(["t1", 7, null, "t2"]),
    );
    expect(readScenarioTaskChecks("sbx_mixed")).toEqual(["t1", "t2"]);
  });

  it("survives a storage that throws, in both directions", () => {
    // A private window, or site data blocked: the checklist still works for
    // this page view, it just forgets.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(readScenarioTaskChecks("sbx_x")).toEqual([]);
    expect(() => writeScenarioTaskChecks("sbx_x", ["t1"])).not.toThrow();
  });
});

describe("mintScenarioTaskId", () => {
  it("does not repeat within a tab", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => mintScenarioTaskId()),
    );
    expect(ids.size).toBe(50);
  });
});
