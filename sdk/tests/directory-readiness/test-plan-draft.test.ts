/**
 * The default test plan: every tool the server lists, ordered so nothing
 * changes until the reads are done and nothing is destroyed until the end.
 */

import { describe, expect, it } from "vitest";

import * as browser from "../../src/browser.js";
import {
  directoryToolEffect,
  draftDirectoryTestPlan,
  orderDirectoryTestCases,
  validateDirectoryTestPlan,
} from "../../src/directory-readiness/index.js";
import {
  SAMPLE_TOOLS,
  caseIds,
  completePlan,
} from "../support/directory-test-plan.js";

describe("directoryToolEffect", () => {
  it("reads only when the tool says it is read-only", () => {
    expect(
      directoryToolEffect({ annotations: { readOnlyHint: true } })
    ).toEqual({
      effect: "read",
      openWorld: true,
    });
    // destructiveHint means nothing for a read-only tool.
    expect(
      directoryToolEffect({
        annotations: { readOnlyHint: true, destructiveHint: true },
      }).effect
    ).toBe("read");
  });

  it("treats a write as destructive unless the tool says it is not", () => {
    expect(
      directoryToolEffect({ annotations: { destructiveHint: false } }).effect
    ).toBe("write");
    expect(
      directoryToolEffect({ annotations: { readOnlyHint: false } }).effect
    ).toBe("destructive");
  });

  it("applies MCP's defaults to a tool with no annotations", () => {
    expect(directoryToolEffect({})).toEqual({
      effect: "destructive",
      openWorld: true,
    });
    expect(
      directoryToolEffect({ annotations: { openWorldHint: false } }).openWorld
    ).toBe(false);
  });
});

describe("draftDirectoryTestPlan", () => {
  const plan = draftDirectoryTestPlan(SAMPLE_TOOLS);

  it("puts every listed tool in the plan to run, excluding none", () => {
    expect(plan.tools.map((entry) => entry.tool).sort()).toEqual(
      SAMPLE_TOOLS.map((tool) => tool.name).sort()
    );
    expect(plan.tools.every((entry) => entry.action === "run")).toBe(true);
    expect(plan.tools.find((entry) => entry.tool === "purge_cache")).toEqual({
      tool: "purge_cache",
      effect: "destructive",
      openWorld: true,
      action: "run",
      writes: [],
    });
  });

  it("orders reads, then writes, then destructive calls, closed world first", () => {
    expect(caseIds(plan.cases)).toEqual([
      "get_project#valid",
      "get_project#missing-arguments",
      "list_projects#valid",
      "search_web#valid",
      "search_web#missing-arguments",
      "create_project#valid",
      "rename_project#valid",
      "send_invite#valid",
      "delete_project#valid",
      "purge_cache#valid",
    ]);
  });

  it("drafts arguments only for a call that needs none", () => {
    const drafted = Object.fromEntries(
      plan.cases.map((testCase) => [testCase.id, testCase.arguments])
    );
    expect(drafted["list_projects#valid"]).toEqual({});
    expect(drafted["purge_cache#valid"]).toEqual({});
    expect(drafted["get_project#valid"]).toBeUndefined();
    expect(drafted["delete_project#valid"]).toBeUndefined();
  });

  it("adds a missing-arguments refusal for reads only, never for a write", () => {
    const negative = plan.cases.filter(
      (testCase) => testCase.kind === "negative"
    );
    expect(caseIds(negative)).toEqual([
      "get_project#missing-arguments",
      "search_web#missing-arguments",
    ]);
    expect(negative[0]?.arguments).toEqual({});
    // Any refusal will do: servers word a missing argument differently.
    expect(negative[0]?.expectedError).toBeUndefined();
  });

  it("budgets one call per drafted case", () => {
    expect(plan.budget).toEqual({
      maxCalls: 10,
      concurrency: 1,
      callTimeoutMs: 30_000,
    });
    expect(
      draftDirectoryTestPlan(SAMPLE_TOOLS, { budget: { maxCalls: 4 } }).budget
    ).toEqual({
      maxCalls: 4,
      concurrency: 1,
      callTimeoutMs: 30_000,
    });
    expect(draftDirectoryTestPlan([]).budget.maxCalls).toBe(1);
  });

  it("keeps the first of two tools listed under one name", () => {
    const twice = draftDirectoryTestPlan([
      { name: "echo", annotations: { readOnlyHint: true } },
      { name: "echo" },
    ]);
    expect(twice.tools).toEqual([
      {
        tool: "echo",
        effect: "read",
        openWorld: true,
        action: "run",
        writes: [],
      },
    ]);
    expect(caseIds(twice.cases)).toEqual(["echo#valid"]);
  });

  it("lists what a person or the drafting model still has to fill in", () => {
    const codes = validateDirectoryTestPlan(plan, SAMPLE_TOOLS).map(
      (issue) => `${issue.code} ${issue.caseId ?? issue.tool}`
    );
    expect(codes.sort()).toEqual(
      [
        "argumentsMissing create_project#valid",
        "argumentsMissing delete_project#valid",
        "argumentsMissing get_project#valid",
        "argumentsMissing rename_project#valid",
        "argumentsMissing search_web#valid",
        "argumentsMissing send_invite#valid",
        "writeScope create_project",
        "writeScope delete_project",
        "writeScope purge_cache",
        "writeScope rename_project",
        "writeScope send_invite",
      ].sort()
    );
  });
});

describe("orderDirectoryTestCases", () => {
  it("runs the case that creates a fixture before the reads that use it", () => {
    const plan = completePlan();
    expect(
      caseIds(
        orderDirectoryTestCases({ ...plan, cases: [...plan.cases].reverse() })
      )
    ).toEqual([
      "create_project#valid",
      "list_projects#valid",
      "get_project#missing-arguments",
      "get_project#valid",
      "search_web#valid",
      "rename_project#valid",
      "delete_project#valid",
    ]);
  });

  it("puts a case whose tool is not in the plan with the destructive ones", () => {
    const plan = completePlan();
    const stray = {
      id: "stray",
      tool: "unlisted",
      kind: "valid" as const,
      arguments: {},
    };
    const ordered = orderDirectoryTestCases({
      ...plan,
      cases: [stray, ...plan.cases],
    });
    expect(caseIds(ordered).slice(-2)).toEqual([
      "delete_project#valid",
      "stray",
    ]);
  });
});

describe("exports", () => {
  it("reaches the browser entry", () => {
    expect(typeof browser.draftDirectoryTestPlan).toBe("function");
    expect(typeof browser.validateDirectoryTestPlan).toBe("function");
    expect(typeof browser.summarizeDirectoryToolTests).toBe("function");
    expect(browser.DIRECTORY_TOOL_TEST_STATUSES).toContain("expected-refusal");
  });
});
