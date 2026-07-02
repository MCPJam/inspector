import { describe, expect, it } from "vitest";
import {
  appendWidgetCheckStep,
  type ScriptedStep,
  type ScriptedWidgetCheck,
} from "../scripted-steps";

const click = (testId: string): ScriptedStep => ({
  kind: "click",
  target: { testId },
});

describe("appendWidgetCheckStep (Tier 3 recorder attribution)", () => {
  it("creates the tool's group when none exists", () => {
    const next = appendWidgetCheckStep(undefined, "create_view", click("a"));
    expect(next).toEqual([
      { toolName: "create_view", steps: [click("a")] },
    ]);
  });

  it("accumulates steps in order for the same tool", () => {
    let groups: ScriptedWidgetCheck[] | undefined;
    groups = appendWidgetCheckStep(groups, "create_view", click("a"));
    groups = appendWidgetCheckStep(groups, "create_view", click("b"));
    const group = groups.find((g) => g.toolName === "create_view");
    expect(group?.steps).toEqual([click("a"), click("b")]);
  });

  it("attributes to the right group and preserves the others", () => {
    const start: ScriptedWidgetCheck[] = [
      { toolName: "show_map", steps: [click("zoom")] },
    ];
    const next = appendWidgetCheckStep(start, "create_view", click("draw"));
    // existing group untouched...
    expect(next.find((g) => g.toolName === "show_map")?.steps).toEqual([
      click("zoom"),
    ]);
    // ...new group gets the step.
    expect(next.find((g) => g.toolName === "create_view")?.steps).toEqual([
      click("draw"),
    ]);
  });

  it("merges duplicate groups for the same tool without dropping steps", () => {
    const start: ScriptedWidgetCheck[] = [
      { toolName: "create_view", steps: [click("a")] },
      { toolName: "show_map", steps: [click("zoom")] },
      { toolName: "create_view", steps: [click("b")] },
    ];
    const next = appendWidgetCheckStep(start, "create_view", click("c"));
    // All create_view steps survive, merged into the first occurrence's slot,
    // and show_map keeps its authored position.
    expect(next).toEqual([
      { toolName: "create_view", steps: [click("a"), click("b"), click("c")] },
      { toolName: "show_map", steps: [click("zoom")] },
    ]);
  });

  it("does not mutate the input array or groups", () => {
    const start: ScriptedWidgetCheck[] = [
      { toolName: "create_view", steps: [click("a")] },
    ];
    const startCopy = JSON.parse(JSON.stringify(start));
    appendWidgetCheckStep(start, "create_view", click("b"));
    expect(start).toEqual(startCopy);
  });
});
