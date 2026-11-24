import { describe, expect, it } from "vitest";
import { climbForOptions } from "../climb-for.js";
import { climb, evidence } from "./fixtures.js";

const ids = (options: ReturnType<typeof climbForOptions>) => options.map((option) => option.id);

describe("climbForOptions", () => {
  const run = (over = {}, index = 0) =>
    evidence({ iterationId: `it-${index}`, caseKey: `case-${index}`, ...over });

  it("lists every option once, each with its measure", () => {
    const options = climbForOptions(climb(), [run()]);
    expect(ids(options).sort()).toEqual(
      ["apps", "cost", "fewer_tools", "instructions", "missing_capability", "pass_rate", "prompts_and_resources", "skills", "tokens", "tool_calls", "tool_descriptions", "tool_inputs", "tool_results"].sort(),
    );
    const measureOf = Object.fromEntries(options.map((option) => [option.id, option.measure]));
    expect(measureOf).toMatchObject({ tokens: "tokens", cost: "cost", tool_calls: "tool_calls", tool_descriptions: "pass_rate", instructions: "pass_rate" });
  });

  it("counts the failures that point at each part of the server, and ranks those first", () => {
    const options = climbForOptions(climb(), [
      run({ failureCategory: "selection" }, 1),
      run({ failureCategory: "selection" }, 2),
      run({ failureCategory: "arguments", failedStage: { stage: "call", reason: "argumentMismatch" } }, 3),
      run({ outcome: "passed" }, 4),
    ]);
    const byId = Object.fromEntries(options.map((option) => [option.id, option]));
    expect(byId.tool_descriptions!.number).toMatchObject({ value: 2, unit: "failed_iterations" });
    expect(byId.tool_inputs!.number.value).toBe(1);
    expect(byId.pass_rate!.number).toMatchObject({ value: 3, text: "3 of 4 steering iterations failed" });
    expect(ids(options).slice(0, 2)).toEqual(["pass_rate", "tool_descriptions"]);
  });

  it("gives each option at most three failed runs, each with a reason and the link, spread over cases", () => {
    const failures = [1, 2, 3, 4, 5].map((index) => run({ failureCategory: "selection" }, index));
    const description = climbForOptions(climb(), failures).find((option) => option.id === "tool_descriptions")!;
    expect(description.failedRuns).toHaveLength(3);
    expect(new Set(description.failedRuns.map((failed) => failed.caseKey)).size).toBe(3);
    expect(description.failedRuns[0]).toMatchObject({
      reason: expect.stringContaining("Failed at Selection"),
      link: expect.stringContaining("iteration=it-"),
      environmentId: "env-a",
    });
  });

  it("takes the mean of passing iterations for a measure the environments recorded", () => {
    const options = climbForOptions(climb({ measure: "tokens" }), [
      run({ outcome: "passed", tokens: 1000 }, 1),
      run({ outcome: "passed", tokens: 2000 }, 2),
      run({ outcome: "failed", tokens: 99999 }, 3),
    ]);
    const tokens = options.find((option) => option.id === "tokens")!;
    expect(tokens).toMatchObject({ available: true, number: { value: 1500, unit: "tokens" } });
    // Cost was recorded by one environment only, and that environment's passing iterations carry none here.
    expect(options.find((option) => option.id === "cost")!.number.value).toBeNull();
  });

  it("marks a measure no environment recorded as unavailable, with why", () => {
    const base = climb();
    for (const env of base.baseline!.environments) env.recorded.cost = false;
    const cost = climbForOptions(base, [run()]).find((option) => option.id === "cost")!;
    expect(cost).toMatchObject({ available: false, reason: expect.stringContaining("No environment recorded cost") });
    expect(ids(climbForOptions(base, [run()])).at(-1)).toBe("cost");
  });

  it("points 'something the server lacks' at iterations that expect a tool it does not list", () => {
    const options = climbForOptions(climb(), [run({ expectedToolNotListed: true }, 1), run({}, 2)]);
    expect(options.find((option) => option.id === "missing_capability")!.number.value).toBe(1);
  });

  it("does not suggest fewer tools for a short listing", () => {
    expect(climbForOptions(climb(), [run()], { toolCount: 3 }).find((option) => option.id === "fewer_tools")!.number.value).toBe(0);
    expect(
      climbForOptions(climb(), [run()], { toolCount: 40 }).find((option) => option.id === "fewer_tools")!.number.value,
    ).toBe(1);
  });

  it("counts a lost iteration neither as failed nor as counted", () => {
    const options = climbForOptions(climb(), [run({ outcome: "lost" }, 1), run({}, 2)]);
    expect(options.find((option) => option.id === "pass_rate")!.number.text).toBe("1 of 1 steering iterations failed");
  });
});
