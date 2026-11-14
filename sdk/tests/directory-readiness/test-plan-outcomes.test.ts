/**
 * What a plan's calls showed, tool by tool: a negative case passes when the
 * tool refuses and never counts as valid-input coverage (V12), a write left
 * unfinished is named as ambiguous and never resent (V11), and a refusal
 * before the tool ran is a setup problem.
 */

import { describe, expect, it } from "vitest";

import {
  classifyDirectoryTestCall,
  directoryTestCaseDigest,
  resolveDirectoryTestArguments,
  resumeDirectoryTestCall,
  summarizeDirectoryToolTests,
  type DirectoryTestCallRecord,
  type DirectoryTestPlan,
  type DirectoryToolTestResult,
  type SummarizeDirectoryToolTestsInput,
} from "../../src/directory-readiness/index.js";
import type { DirectoryToolCallEvidence } from "../../src/directory-readiness/mcp-tool-call.js";
import {
  SAMPLE_TOOLS,
  completePlan,
  scratch,
} from "../support/directory-test-plan.js";

const ACCOUNT = "reviewer-account-1";

function record(
  plan: DirectoryTestPlan,
  callKey: string,
  rest: Partial<DirectoryTestCallRecord> = {}
): DirectoryTestCallRecord {
  const testCase = plan.cases.find((candidate) => candidate.id === callKey);
  if (!testCase) throw new Error(`no case ${callKey}`);
  const tool = SAMPLE_TOOLS.find(
    (candidate) => candidate.name === testCase.tool
  );
  return {
    callKey,
    tool: testCase.tool,
    phase: "succeeded",
    outcome: "result",
    inputDigest: directoryTestCaseDigest(plan, testCase, tool),
    ranBy: { kind: "direct-call" },
    account: ACCOUNT,
    endpoint: "https://mcp.example.com/mcp",
    startedAt: 1_000,
    finishedAt: 1_200,
    ...rest,
  };
}

function summarize(
  plan: DirectoryTestPlan,
  calls: DirectoryTestCallRecord[],
  rest: Partial<SummarizeDirectoryToolTestsInput> = {}
): Record<string, DirectoryToolTestResult> {
  const results = summarizeDirectoryToolTests({
    plan,
    tools: SAMPLE_TOOLS,
    calls,
    account: ACCOUNT,
    ...rest,
  });
  return Object.fromEntries(results.map((result) => [result.tool, result]));
}

const READ_ANSWERS: Array<[DirectoryToolCallEvidence, string, string]> = [
  [{ status: 200, result: { isError: false } }, "succeeded", "result"],
  [{ status: 200, result: { isError: true } }, "failed", "tool-error"],
  [
    { status: 200, result: { isError: true }, invalidArguments: true },
    "failed",
    "invalid-arguments",
  ],
  [
    { status: 400, rpcError: { code: -32602 }, invalidArguments: true },
    "failed",
    "invalid-arguments",
  ],
  [{ status: 200, rpcError: { code: -32603 } }, "failed", "rpc-error"],
  [{ status: 500, rpcError: { code: -32603 } }, "failed", "server-error"],
  [{ status: 401, rpcError: { code: -32001 } }, "failed", "refused"],
  [{ status: 429 }, "failed", "refused"],
  [
    { status: 200, error: "tools/call returned no result" },
    "failed",
    "server-error",
  ],
  [{ unreachable: true, error: "timed out" }, "failed", "unreachable"],
];

describe("classifyDirectoryTestCall", () => {
  it.each(READ_ANSWERS)(
    "reads %j from a read as %s, %s",
    (evidence, phase, outcome) => {
      expect(classifyDirectoryTestCall(evidence, "read")).toEqual({
        phase,
        outcome,
      });
    }
  );

  it("calls a write that got no answer ambiguous: it may have landed", () => {
    const silent = { unreachable: true, error: "timed out" };
    expect(classifyDirectoryTestCall(silent, "write")).toEqual({
      phase: "ambiguous",
      outcome: "unreachable",
    });
    expect(classifyDirectoryTestCall(silent, "destructive").phase).toBe(
      "ambiguous"
    );
    // A refusal before the tool ran changed nothing, write or not.
    expect(
      classifyDirectoryTestCall({ status: 403 }, "destructive").phase
    ).toBe("failed");
  });
});

describe("resumeDirectoryTestCall", () => {
  it("never resends a write that started and did not finish (V11)", () => {
    expect(resumeDirectoryTestCall({ phase: "started" }, "write")).toBe(
      "ambiguous"
    );
    expect(resumeDirectoryTestCall({ phase: "started" }, "destructive")).toBe(
      "ambiguous"
    );
    expect(resumeDirectoryTestCall({ phase: "ambiguous" }, "read")).toBe(
      "ambiguous"
    );
  });

  it("runs a read again, and keeps every finished call's evidence", () => {
    expect(resumeDirectoryTestCall(undefined, "write")).toBe("run");
    expect(resumeDirectoryTestCall({ phase: "planned" }, "destructive")).toBe(
      "run"
    );
    expect(resumeDirectoryTestCall({ phase: "started" }, "read")).toBe("run");
    expect(
      resumeDirectoryTestCall(
        { phase: "succeeded", outcome: "result" },
        "write"
      )
    ).toBe("skip");
    expect(
      resumeDirectoryTestCall(
        { phase: "failed", outcome: "tool-error" },
        "write"
      )
    ).toBe("skip");
  });

  it("tries again a call that never reached the tool", () => {
    expect(
      resumeDirectoryTestCall({ phase: "failed", outcome: "refused" }, "write")
    ).toBe("run");
    expect(
      resumeDirectoryTestCall(
        { phase: "failed", outcome: "unreachable" },
        "read"
      )
    ).toBe("run");
  });
});

describe("directoryTestCaseDigest", () => {
  const plan = completePlan();
  const rename = plan.cases.find(
    (candidate) => candidate.id === "rename_project#valid"
  );
  const tool = SAMPLE_TOOLS.find(
    (candidate) => candidate.name === "rename_project"
  );
  if (!rename || !tool) throw new Error("sample plan changed");
  const digest = directoryTestCaseDigest(plan, rename, tool);

  it("ignores key order and wording", () => {
    const reordered = {
      ...rename,
      arguments: { name: "Renamed by MCPJam", projectId: scratch },
    };
    expect(directoryTestCaseDigest(plan, reordered, tool)).toBe(digest);
    const reworded = {
      ...rename,
      expectation: "The project gets its new name.",
    };
    const described = plan.fixtures.map((fixture) => ({
      ...fixture,
      description: "New words",
    }));
    expect(
      directoryTestCaseDigest({ fixtures: described }, reworded, tool)
    ).toBe(digest);
    expect(
      directoryTestCaseDigest(plan, rename, {
        ...tool,
        title: "Rename",
      } as typeof tool)
    ).toBe(digest);
  });

  it("changes with the arguments, a fixture the case uses, or the tool's schema", () => {
    const renamed = {
      ...rename,
      arguments: { projectId: scratch, name: "Other" },
    };
    expect(directoryTestCaseDigest(plan, renamed, tool)).not.toBe(digest);
    const recaptured = plan.fixtures.map((fixture) =>
      fixture.id === "scratchProject"
        ? { ...fixture, capture: { id: "id" } }
        : fixture
    );
    expect(
      directoryTestCaseDigest({ fixtures: recaptured }, rename, tool)
    ).not.toBe(digest);
    expect(
      directoryTestCaseDigest(plan, rename, { ...tool, inputSchema: {} })
    ).not.toBe(digest);
  });
});

describe("summarizeDirectoryToolTests", () => {
  it("passes valid input that returned a result, and keeps who ran the call", () => {
    const plan = completePlan();
    const call = record(plan, "list_projects#valid");
    const { list_projects } = summarize(plan, [call]);
    expect(list_projects).toMatchObject({
      status: "valid-input-succeeded",
      cases: [{ status: "passed", call }],
    });
    expect(list_projects?.reason).toBeUndefined();
    expect(list_projects?.cases[0]?.call?.ranBy).toEqual({
      kind: "direct-call",
    });
    expect(list_projects?.validInput.passed).toBe(1);
  });

  it("passes a negative case that errored, without counting it as valid input (V12)", () => {
    const plan = completePlan();
    const { get_project } = summarize(plan, [
      record(plan, "get_project#valid", {
        phase: "failed",
        outcome: "refused",
      }),
      record(plan, "get_project#missing-arguments", {
        phase: "failed",
        outcome: "tool-error",
      }),
    ]);
    expect(get_project?.status).toBe("setup-blocked");
    expect(get_project?.negative.passed).toBe(1);
    expect(get_project?.validInput.passed).toBe(0);
    expect(get_project?.validInput.blocked).toBe(1);
  });

  it("calls a negative-only tool that refused an expected refusal", () => {
    const plan = completePlan();
    plan.tools = plan.tools.map((entry) =>
      entry.tool === "get_project"
        ? { ...entry, action: "negative-only" as const }
        : entry
    );
    plan.cases = plan.cases.filter(
      (candidate) => candidate.id !== "get_project#valid"
    );
    const { get_project } = summarize(plan, [
      record(plan, "get_project#missing-arguments", {
        phase: "failed",
        outcome: "invalid-arguments",
      }),
    ]);
    expect(get_project?.status).toBe("expected-refusal");
    expect(get_project?.validInput.passed).toBe(0);
  });

  it("fails a negative case the tool accepted, refused differently, or crashed on", () => {
    const plan = completePlan();
    const accepted = summarize(plan, [
      record(plan, "get_project#missing-arguments"),
    ]);
    expect(accepted.get_project).toMatchObject({
      status: "unexpected-failure",
      reason:
        "get_project#missing-arguments: The tool accepted input it should refuse.",
    });
    const negative = plan.cases.find(
      (candidate) => candidate.id === "get_project#missing-arguments"
    );
    if (negative) negative.expectedError = "invalid-arguments";
    const wrong = summarize(plan, [
      record(plan, "get_project#missing-arguments", {
        phase: "failed",
        outcome: "tool-error",
      }),
    ]);
    expect(wrong.get_project?.reason).toBe(
      "get_project#missing-arguments: It expected an invalid-arguments refusal and got an error from the tool."
    );
    if (negative) negative.expectedError = undefined;
    const crashed = summarize(plan, [
      record(plan, "get_project#missing-arguments", {
        phase: "failed",
        outcome: "server-error",
      }),
    ]);
    expect(crashed.get_project?.status).toBe("unexpected-failure");
  });

  it("never passes a negative case on a refusal before the tool ran", () => {
    const plan = completePlan();
    const { get_project } = summarize(plan, [
      record(plan, "get_project#missing-arguments", {
        phase: "failed",
        outcome: "refused",
      }),
    ]);
    expect(get_project?.cases.map((result) => result.status)).toEqual([
      "untested",
      "blocked",
    ]);
    expect(get_project?.negative.passed).toBe(0);
  });

  it("fails valid input that errored", () => {
    const plan = completePlan();
    const { search_web } = summarize(plan, [
      record(plan, "search_web#valid", {
        phase: "failed",
        outcome: "invalid-arguments",
      }),
    ]);
    expect(search_web).toMatchObject({
      status: "unexpected-failure",
      reason: "search_web#valid: Valid input got an invalid-arguments refusal.",
    });
  });

  it("names a write left unfinished, and blocks what needed its fixture (V11)", () => {
    const plan = completePlan();
    const results = summarize(plan, [
      record(plan, "create_project#valid", {
        phase: "started",
        outcome: undefined,
        finishedAt: undefined,
      }),
      record(plan, "list_projects#valid", {
        phase: "started",
        outcome: undefined,
      }),
    ]);
    expect(results.create_project?.status).toBe("ambiguous");
    expect(results.create_project?.reason).toBe(
      "create_project#valid: The call started and did not finish, so it may have changed data. Check what it changed, then record what happened or rerun it."
    );
    expect(results.rename_project?.cases[0]).toMatchObject({
      status: "blocked",
      reason:
        "scratchProject was not created: case create_project#valid is ambiguous.",
    });
    // A read that stopped changed nothing; it runs again on resume.
    expect(results.list_projects?.status).toBe("untested");
  });

  it("keeps an ambiguous write ambiguous after the plan is edited", () => {
    const plan = completePlan();
    const ambiguous = record(plan, "rename_project#valid", {
      phase: "ambiguous",
      outcome: "unreachable",
    });
    const edited = completePlan();
    const rename = edited.cases.find(
      (candidate) => candidate.id === "rename_project#valid"
    );
    if (rename) rename.arguments = { projectId: scratch, name: "Edited" };
    expect(summarize(edited, [ambiguous]).rename_project?.status).toBe(
      "ambiguous"
    );
  });

  it("marks a result stale when the case or the reviewer account changed", () => {
    const plan = completePlan();
    const calls = [
      record(plan, "search_web#valid"),
      record(plan, "list_projects#valid", { account: "someone-else" }),
    ];
    const edited = completePlan();
    const search = edited.cases.find(
      (candidate) => candidate.id === "search_web#valid"
    );
    if (search) search.arguments = { query: "another query" };
    const results = summarize(edited, calls);
    expect(results.search_web?.status).toBe("stale");
    expect(results.list_projects).toMatchObject({
      status: "stale",
      reason:
        "list_projects#valid: It ran as another reviewer account. Run it again.",
    });
    // Rewording what a case expects keeps its result.
    if (search) search.arguments = { query: "model context protocol" };
    if (search) search.expectation = "Results come back.";
    expect(summarize(edited, calls).search_web?.status).toBe(
      "valid-input-succeeded"
    );
  });

  it("blocks a case whose fixture is missing or whose arguments are not drafted", () => {
    const plan = completePlan();
    const search = plan.cases.find(
      (candidate) => candidate.id === "search_web#valid"
    );
    if (search) search.arguments = undefined;
    const results = summarize(plan, [], { missingFixtures: ["demoProject"] });
    expect(results.get_project?.cases[0]).toMatchObject({
      status: "blocked",
      reason:
        "demoProject was not found in the reviewer's account. Add it there, or update the fixture.",
    });
    expect(results.search_web).toMatchObject({
      status: "setup-blocked",
      reason:
        "search_web#valid: Its arguments are not drafted yet. Draft or enter them.",
    });
  });

  it("leaves what a stopped sweep did not reach untested, or blocked on setup", () => {
    const plan = completePlan();
    const budget = summarize(plan, [], { stopped: { by: "budget" } });
    expect(budget.list_projects).toMatchObject({
      status: "untested",
      reason:
        "list_projects#valid: The sweep used its call budget before this case. Raise the budget and run again.",
    });
    const setup = summarize(plan, [], {
      stopped: { by: "setup", detail: "The reviewer connection is not ready." },
    });
    expect(setup.list_projects).toMatchObject({
      status: "setup-blocked",
      reason: "list_projects#valid: The reviewer connection is not ready.",
    });
    expect(summarize(plan, []).list_projects?.reason).toBe(
      "list_projects#valid: It has not run yet."
    );
  });

  it("reports an excluded tool with its reason and no cases", () => {
    const plan = completePlan();
    const results = summarize(plan, []);
    expect(results.send_invite).toMatchObject({
      status: "excluded",
      reason: "external-effects: It emails a real person.",
      cases: [],
    });
    expect(results.purge_cache?.reason).toBe("costly");
  });

  it("grades the latest record for a case", () => {
    const plan = completePlan();
    const { list_projects } = summarize(plan, [
      record(plan, "list_projects#valid", {
        phase: "failed",
        outcome: "tool-error",
      }),
      record(plan, "list_projects#valid"),
    ]);
    expect(list_projects?.status).toBe("valid-input-succeeded");
  });
});

describe("resolveDirectoryTestArguments", () => {
  it("fills fixture references and names any it cannot fill", () => {
    const args = {
      projectId: scratch,
      tags: [{ $fixture: "demoProject", value: "id" }],
      name: "x",
    };
    expect(
      resolveDirectoryTestArguments(args, {
        scratchProject: { id: "proj_scratch" },
        demoProject: { id: "proj_demo" },
      })
    ).toEqual({
      arguments: { projectId: "proj_scratch", tags: ["proj_demo"], name: "x" },
    });
    expect(resolveDirectoryTestArguments(args, { demoProject: {} })).toEqual({
      missing: ["scratchProject.id", "demoProject.id"],
    });
  });

  it("never fills a reference from an inherited key", () => {
    const inherited = { name: { $fixture: "constructor", value: "name" } };
    expect(resolveDirectoryTestArguments(inherited, {})).toEqual({
      missing: ["constructor.name"],
    });
  });
});
