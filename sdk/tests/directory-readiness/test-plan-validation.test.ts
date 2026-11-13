/**
 * The validator's refusals for a plan a person or an agent edited. Each test
 * breaks one thing in a plan that otherwise passes and expects one issue.
 */

import { describe, expect, it } from "vitest";

import {
  DIRECTORY_TEST_PLAN_ISSUE_CODES,
  DIRECTORY_TEST_PLAN_LIMITS,
  validateDirectoryTestPlan,
  type DirectoryTestPlan,
  type DirectoryTestPlanIssue,
} from "../../src/directory-readiness/index.js";
import wording from "../../src/directory-readiness/test-plan/wording.json" with { type: "json" };
import {
  SAMPLE_TOOLS,
  completePlan,
  scratch,
} from "../support/directory-test-plan.js";

function issuesAfter(
  edit: (plan: DirectoryTestPlan) => void
): DirectoryTestPlanIssue[] {
  const plan = completePlan();
  edit(plan);
  return validateDirectoryTestPlan(plan, SAMPLE_TOOLS);
}

function entry(plan: DirectoryTestPlan, tool: string) {
  const found = plan.tools.find((candidate) => candidate.tool === tool);
  if (!found) throw new Error(`no entry for ${tool}`);
  return found;
}

function testCase(plan: DirectoryTestPlan, id: string) {
  const found = plan.cases.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

function move(plan: DirectoryTestPlan, id: string, index: number) {
  const from = plan.cases.findIndex((candidate) => candidate.id === id);
  const [moved] = plan.cases.splice(from, 1);
  if (moved) plan.cases.splice(index, 0, moved);
}

describe("a complete plan", () => {
  it("has no issues", () => {
    expect(validateDirectoryTestPlan(completePlan(), SAMPLE_TOOLS)).toEqual([]);
  });

  it("words every issue under a known code, with no placeholder left", () => {
    for (const key of Object.keys(wording.issues)) {
      expect(DIRECTORY_TEST_PLAN_ISSUE_CODES).toContain(key.split(".")[0]);
    }
    const issues = validateDirectoryTestPlan(
      { ...completePlan(), tools: [], cases: [], cleanup: [] },
      SAMPLE_TOOLS
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.message).not.toMatch(/[{}]/);
  });
});

describe("parity: every tool is in the plan", () => {
  it("refuses a plan that leaves out a tool the server lists", () => {
    const issues = issuesAfter((plan) => {
      plan.tools = plan.tools.filter(
        (candidate) => candidate.tool !== "list_projects"
      );
      plan.cases = plan.cases.filter(
        (candidate) => candidate.tool !== "list_projects"
      );
    });
    expect(issues).toEqual([
      {
        code: "missingTool",
        tool: "list_projects",
        message:
          "list_projects is not in the plan. Add a case for it, or exclude it with a reason.",
      },
    ]);
  });

  it("refuses a tool the server does not list, and a case calling a tool the plan lacks", () => {
    const issues = issuesAfter((plan) => {
      plan.tools.push({
        tool: "archive_project",
        effect: "read",
        openWorld: false,
        action: "run",
        writes: [],
      });
      plan.cases.unshift({
        id: "archive#valid",
        tool: "archive_project",
        kind: "valid",
        arguments: {},
      });
      plan.cases.unshift({
        id: "ghost#valid",
        tool: "ghost",
        kind: "valid",
        arguments: {},
      });
    });
    expect(issues.map((issue) => [issue.code, issue.tool])).toEqual([
      ["unknownTool", "archive_project"],
      ["unknownTool", "ghost"],
    ]);
    expect(issues[1]?.message).toBe(
      "Case ghost#valid calls ghost, which is not in the plan. Add the tool, or remove the case."
    );
  });
});

describe("exclusions", () => {
  it("accepts a costly or destructive tool excluded with a reason", () => {
    const issues = issuesAfter((plan) => {
      entry(plan, "delete_project").action = "excluded";
      entry(plan, "delete_project").exclusion = { reason: "destructive" };
      plan.cases = plan.cases.filter(
        (candidate) => candidate.tool !== "delete_project"
      );
      plan.cleanup = [];
      entry(plan, "create_project").action = "excluded";
      entry(plan, "create_project").exclusion = {
        reason: "costly",
        note: "It starts a paid job.",
      };
      plan.cases = plan.cases.filter(
        (candidate) => candidate.tool !== "create_project"
      );
      plan.cases = plan.cases.filter(
        (candidate) => candidate.tool !== "rename_project"
      );
      entry(plan, "rename_project").action = "excluded";
      entry(plan, "rename_project").exclusion = { reason: "needs-a-person" };
      plan.fixtures = plan.fixtures.filter(
        (fixture) => fixture.origin === "existing"
      );
      for (const tool of plan.tools) tool.writes = [];
    });
    expect(issues).toEqual([]);
  });

  it("refuses an exclusion with no reason, and another reason with no note", () => {
    const issues = issuesAfter((plan) => {
      entry(plan, "send_invite").exclusion = undefined;
      entry(plan, "purge_cache").exclusion = { reason: "other", note: "  " };
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "send_invite is excluded without a reason. Choose a reason.",
      "purge_cache is excluded for another reason. Say which in a note.",
    ]);
  });

  it("refuses cases for an excluded tool, and a run without a valid-input case", () => {
    const issues = issuesAfter((plan) => {
      plan.cases.push({
        id: "purge#valid",
        tool: "purge_cache",
        kind: "valid",
        arguments: {},
      });
      plan.cases = plan.cases.filter(
        (candidate) => candidate.id !== "list_projects#valid"
      );
      entry(plan, "get_project").action = "negative-only";
      entry(plan, "search_web").action = "negative-only";
    });
    expect(
      issues.map((issue) => [issue.code, issue.tool, issue.message])
    ).toEqual([
      [
        "actionCases",
        "purge_cache",
        "purge_cache is excluded but has cases. Remove its cases, or include the tool.",
      ],
      [
        "actionCases",
        "search_web",
        "search_web is negative only and has no negative case. Add one.",
      ],
      [
        "actionCases",
        "list_projects",
        "list_projects has no valid-input case. Add one, or plan the tool as negative only.",
      ],
    ]);
  });
});

describe("annotations", () => {
  it("refuses a plan that treats a tool as safer than the server says", () => {
    const issues = issuesAfter((plan) => {
      entry(plan, "delete_project").effect = "write";
      entry(plan, "rename_project").effect = "read";
      entry(plan, "rename_project").writes = [];
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "The server marks delete_project as destructive, so the plan cannot treat it as write. Set it to destructive.",
      "The server marks rename_project as write, so the plan cannot treat it as read. Set it to write.",
    ]);
  });

  it("accepts a plan that treats a tool as more dangerous than it says", () => {
    const issues = issuesAfter((plan) => {
      entry(plan, "rename_project").effect = "destructive";
      move(plan, "rename_project#valid", plan.cases.length - 1);
    });
    expect(issues).toEqual([]);
  });
});

describe("permitted writes and fixtures", () => {
  it("refuses a tool that may change data and names no fixture", () => {
    const issues = issuesAfter((plan) => {
      entry(plan, "delete_project").writes = [];
    });
    expect(issues).toEqual([
      {
        code: "writeScope",
        tool: "delete_project",
        message:
          "delete_project can change data and names no fixture it may change. Name its fixtures, or exclude it.",
      },
    ]);
  });

  it("refuses a case that creates a fixture its tool may not write", () => {
    const issues = issuesAfter((plan) => {
      entry(plan, "create_project").writes = ["demoProject"];
    });
    expect(
      issues.map((issue) => [issue.code, issue.caseId, issue.fixture])
    ).toEqual([["writeScope", "create_project#valid", "scratchProject"]]);
  });

  it("refuses references to an undeclared fixture or a value it does not provide", () => {
    const issues = issuesAfter((plan) => {
      testCase(plan, "get_project#valid").arguments = {
        projectId: { $fixture: "demoProject", value: "slug" },
        owner: { nested: [{ $fixture: "teamMember", value: "id" }] },
      };
      entry(plan, "rename_project").writes.push("archive");
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "rename_project names the fixture archive, which the plan does not declare. Declare it, or correct the name.",
      'Case get_project#valid uses the value "slug" of demoProject, which that fixture does not provide. Add it to the fixture, or correct the reference.',
      "Case get_project#valid names the fixture teamMember, which the plan does not declare. Declare it, or correct the name.",
    ]);
  });

  it("refuses a created fixture nothing creates, or more than one case creates", () => {
    const none = issuesAfter((plan) => {
      testCase(plan, "create_project#valid").creates = [];
    });
    expect(none.map((issue) => [issue.code, issue.fixture])).toContainEqual([
      "fixtureCreation",
      "scratchProject",
    ]);
    const twice = issuesAfter((plan) => {
      testCase(plan, "rename_project#valid").creates = ["scratchProject"];
    });
    expect(twice.map((issue) => issue.message)).toEqual([
      "More than one case creates scratchProject. Keep one.",
    ]);
  });

  it("refuses a case that creates a fixture already in the reviewer's account", () => {
    const issues = issuesAfter((plan) => {
      testCase(plan, "create_project#valid").creates = [
        "scratchProject",
        "demoProject",
      ];
      entry(plan, "create_project").writes.push("demoProject");
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "demoProject is already in the reviewer's account, so case create_project#valid cannot create it. Mark the fixture created, or remove it from the case.",
    ]);
  });

  it("refuses a case with no arguments", () => {
    const issues = issuesAfter((plan) => {
      testCase(plan, "search_web#valid").arguments = undefined;
    });
    expect(issues.map((issue) => [issue.code, issue.caseId])).toEqual([
      ["argumentsMissing", "search_web#valid"],
    ]);
  });
});

describe("order", () => {
  it("refuses a destructive case before a non-destructive one", () => {
    const issues = issuesAfter((plan) => move(plan, "delete_project#valid", 1));
    expect(issues).toEqual([
      {
        code: "order",
        tool: "delete_project",
        caseId: "delete_project#valid",
        message:
          "Case delete_project#valid can destroy data and runs before case rename_project#valid. Move destructive cases to the end.",
      },
    ]);
  });

  it("refuses a case that uses a fixture before the case that creates it", () => {
    const issues = issuesAfter((plan) => move(plan, "create_project#valid", 5));
    expect(issues.map((issue) => issue.message)).toEqual([
      "Case rename_project#valid uses scratchProject before case create_project#valid creates it. Move it after that case.",
    ]);
  });
});

describe("cleanup", () => {
  it("refuses a created fixture that is never removed", () => {
    const issues = issuesAfter((plan) => {
      plan.cleanup = [];
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      "scratchProject is created by the plan and never removed. Add a cleanup step for it.",
    ]);
  });

  it("refuses removing an existing fixture, or removing with a tool the plan does not run", () => {
    const issues = issuesAfter((plan) => {
      plan.cleanup.push({
        fixture: "demoProject",
        tool: "purge_cache",
        arguments: { id: scratch },
      });
    });
    expect(
      issues.map((issue) => [issue.code, issue.fixture, issue.tool])
    ).toEqual([
      ["cleanup", "demoProject", "purge_cache"],
      ["cleanup", "demoProject", "purge_cache"],
    ]);
    expect(issues[1]?.message).toBe(
      "Cleanup calls purge_cache, which the plan does not run. Use a tool the plan includes."
    );
  });
});

describe("duplicates and limits", () => {
  it("refuses a repeated tool, case or fixture", () => {
    const issues = issuesAfter((plan) => {
      plan.tools.push({ ...entry(plan, "list_projects") });
      plan.cases.splice(1, 0, { ...testCase(plan, "list_projects#valid") });
      plan.fixtures.push({
        id: "demoProject",
        description: "Again",
        origin: "existing",
        values: { id: "x" },
      });
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
  });

  it("refuses a budget out of range", () => {
    const issues = issuesAfter((plan) => {
      plan.budget = { maxCalls: 0, concurrency: 1.5, callTimeoutMs: 500 };
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      `The call budget must be a whole number from 1 to ${DIRECTORY_TEST_PLAN_LIMITS.maxCalls}.`,
      `Concurrency must be a whole number from 1 to ${DIRECTORY_TEST_PLAN_LIMITS.maxConcurrency}.`,
      `The call timeout must be a whole number of milliseconds from 1000 to ${DIRECTORY_TEST_PLAN_LIMITS.maxCallTimeoutMs}.`,
    ]);
  });

  it("refuses a plan too large to store, and arguments that are not JSON", () => {
    const large = issuesAfter((plan) => {
      testCase(plan, "search_web#valid").arguments = {
        query: "x".repeat(DIRECTORY_TEST_PLAN_LIMITS.maxPlanLength),
      };
    });
    expect(large.map((issue) => issue.code)).toEqual(["limit"]);
    const notJson = issuesAfter((plan) => {
      testCase(plan, "search_web#valid").arguments = { limit: Number.NaN };
    });
    expect(notJson.map((issue) => issue.code)).toEqual(["limit"]);
  });

  it("refuses an empty or overlong id, and more cases than a plan holds", () => {
    const ids = issuesAfter((plan) => {
      testCase(plan, "list_projects#valid").id = "";
      testCase(plan, "search_web#valid").id = "s".repeat(
        DIRECTORY_TEST_PLAN_LIMITS.maxIdLength + 1
      );
    });
    expect(ids.map((issue) => issue.code)).toEqual(["limit", "limit"]);
    const many = issuesAfter((plan) => {
      const extra = Array.from(
        { length: DIRECTORY_TEST_PLAN_LIMITS.maxCases },
        (_, index) => ({
          id: `list_projects#${index}`,
          tool: "list_projects",
          kind: "valid" as const,
          arguments: {},
        })
      );
      plan.cases.unshift(...extra);
    });
    expect(many.map((issue) => issue.message)).toEqual([
      `The plan has ${DIRECTORY_TEST_PLAN_LIMITS.maxCases + 7} cases; it can hold ${DIRECTORY_TEST_PLAN_LIMITS.maxCases}. Remove some cases.`,
    ]);
  });
});
