import { getFunctionName } from "convex/server";
import { MCPClientManager } from "@mcpjam/sdk";
import { describe, expect, it, vi } from "vitest";
import { WebRouteError } from "../../../routes/web/errors.js";
import {
  loadEvalRunAccountPlan,
  loadQuickRunAccounts,
  loadSuiteConnectionIdSets,
  openEvalAccountGroups,
  type EvalAccountPlan,
} from "../suite-account-choices.js";
import { setManagerAuthorizedCredentials } from "../../../utils/mcp-connections.js";

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
      "testSuiteAccountSelections:getPersonalSuiteAccountChoices": [
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
      "testSuiteAccountSelections:getPersonalSuiteAccountChoices": (args: unknown) =>
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
      "testSuiteAccountSelections:getPersonalSuiteAccountChoices": [],
    });
    await expect(loadSuiteConnectionIdSets(convex, {})).resolves.toBeUndefined();
    await expect(
      loadSuiteConnectionIdSets(convex, { suiteId: "suite-1" }),
    ).resolves.toBeUndefined();
  });

  it("uses the case plan for Quick Run and preserves personal choices on other servers", async () => {
    const plan = [{ testCaseId: "case-1", serverId: "billing", connectionId: "admin", source: "case" }];
    const convex = convexAnswering({
      "testSuites:getTestCase": { testSuiteId: "suite-1" },
      "testSuiteAccountSelections:getPersonalSuiteAccountChoices": [
        { serverId: "billing", connectionIds: ["legacy"] },
        { serverId: "crm", connectionIds: ["personal"] },
      ],
      "testSuiteAccountSelections:getEvalRunAccountPlan": plan,
    });
    await expect(loadQuickRunAccounts(convex, {
      testCaseId: "case-1",
      serverIds: ["billing", "crm"],
    })).resolves.toEqual({
      accountContext: { plan, serverIds: ["billing", "crm"] },
      connectionIdSets: { billing: ["admin"], crm: ["personal"] },
    });
  });

  it("treats a backend without the feature as having no choices", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getMySuiteAccountChoices": new Error(
        "Could not find public function for 'testSuiteAccountSelections:getMySuiteAccountChoices'",
      ),
      "testSuiteAccountSelections:getPersonalSuiteAccountChoices": new Error(
        "Could not find public function for 'testSuiteAccountSelections:getPersonalSuiteAccountChoices'",
      ),
    });
    await expect(
      loadSuiteConnectionIdSets(convex, { suiteId: "suite-1" }),
    ).resolves.toBeUndefined();
  });

  it("refuses the run when the choice can't be read", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getPersonalSuiteAccountChoices": new Error(
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

describe("per-case eval accounts", () => {
  const plan: EvalAccountPlan = [
    { testCaseId: "inherits", serverId: "billing", connectionId: "auditor", source: "run" },
    { testCaseId: "pinned", serverId: "billing", connectionId: "admin", source: "case" },
    { testCaseId: "inherits", serverId: "crm", connectionId: "support", source: "suite" },
    { testCaseId: "pinned", serverId: "crm", connectionId: "support", source: "suite" },
  ];

  it("opens separate authorized managers and keeps the untouched server on both", async () => {
    const open = vi.fn(async (sets: Readonly<Record<string, readonly string[]>>) => {
      const manager = new MCPClientManager();
      vi.spyOn(manager, "listServers").mockReturnValue(Object.keys(sets));
      vi.spyOn(manager, "disconnectAllServers").mockResolvedValue();
      setManagerAuthorizedCredentials(manager, Object.fromEntries(
        Object.entries(sets).map(([serverId, [accountId]]) => [serverId, accountId]),
      ));
      return manager;
    });
    const groups = await openEvalAccountGroups(plan, open, {
      billing: ["legacy"],
      asana: ["personal"],
    });
    expect(open.mock.calls).toEqual([
      [{ billing: ["auditor"], crm: ["support"], asana: ["personal"] }],
      [{ billing: ["admin"], crm: ["support"], asana: ["personal"] }],
    ]);
    expect(groups.forCase("inherits")).not.toBe(groups.forCase("pinned"));
    expect(() => groups.forCase("unknown")).toThrow(/missing from the authorized account plan/i);
    await groups.close();
    expect(groups.forCase("inherits").disconnectAllServers).toHaveBeenCalledOnce();
    expect(groups.forCase("pinned").disconnectAllServers).toHaveBeenCalledOnce();
  });

  it("refuses a one-off override on a backend that has no account planner", async () => {
    const convex = convexAnswering({
      "testSuiteAccountSelections:getEvalRunAccountPlan": new Error(
        "Could not find public function for 'testSuiteAccountSelections:getEvalRunAccountPlan'",
      ),
    });
    await expect(loadEvalRunAccountPlan(convex, {
      suiteId: "suite-1",
      serverIds: ["billing"],
      runAccounts: [{ serverId: "billing", connectionId: "auditor" }],
    })).rejects.toThrow(/cannot use the accounts selected for this run/i);
  });
});
