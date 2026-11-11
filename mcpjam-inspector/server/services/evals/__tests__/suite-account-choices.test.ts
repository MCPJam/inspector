import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { WebRouteError } from "../../../routes/web/errors.js";
import { loadSuiteConnectionIdSets } from "../suite-account-choices.js";

function convexAnswering(
  answers: Record<string, unknown | ((args: unknown) => unknown)>,
) {
  return {
    query: vi.fn(async (ref: unknown, args: unknown) => {
      const answer = answers[getFunctionName(ref as never)];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(args) : answer;
    }),
  };
}

describe("loadSuiteConnectionIdSets", () => {
  it("reads the acting person's choice for a suite", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getMySuiteAccountChoices": [
        { serverId: "asana", connectionIds: ["dummy"] },
      ],
    });
    await expect(
      loadSuiteConnectionIdSets(convex, { suiteId: "suite-1" }),
    ).resolves.toEqual({ asana: ["dummy"] });
    expect(convex.query).toHaveBeenCalledWith(expect.anything(), {
      suiteId: "suite-1",
    });
  });

  it("finds a quick run's suite from its case", async () => {
    const convex = convexAnswering({
      "testSuites:getTestCase": { testSuiteId: "suite-1" },
      "testSuiteAccountSelections:getMySuiteAccountChoices": (args: unknown) =>
        (args as { suiteId: string }).suiteId === "suite-1"
          ? [{ serverId: "asana", connectionIds: ["dummy"] }]
          : [],
    });
    await expect(
      loadSuiteConnectionIdSets(convex, { testCaseId: "case-1" }),
    ).resolves.toEqual({ asana: ["dummy"] });
  });

  it("has nothing to apply without a suite or a saved choice", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getMySuiteAccountChoices": [],
    });
    await expect(loadSuiteConnectionIdSets(convex, {})).resolves.toBeUndefined();
    await expect(
      loadSuiteConnectionIdSets(convex, { suiteId: "suite-1" }),
    ).resolves.toBeUndefined();
  });

  it("treats a backend without the feature as having no choices", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getMySuiteAccountChoices": new Error(
        "Could not find public function for 'testSuiteAccountSelections:getMySuiteAccountChoices'",
      ),
    });
    await expect(
      loadSuiteConnectionIdSets(convex, { suiteId: "suite-1" }),
    ).resolves.toBeUndefined();
  });

  it("refuses the run when the choice can't be read", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getMySuiteAccountChoices": new Error(
        "fetch failed",
      ),
    });
    const run = loadSuiteConnectionIdSets(convex, { suiteId: "suite-1" });
    await expect(run).rejects.toBeInstanceOf(WebRouteError);
    await expect(run).rejects.toThrow(
      "MCPJam couldn't load the accounts chosen for this suite",
    );
  });
});
