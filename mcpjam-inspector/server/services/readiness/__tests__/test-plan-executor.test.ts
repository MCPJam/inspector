/**
 * Executing a test plan with the run's call ledger: plan order, a record
 * before and after every call, what a resumed run does with what an earlier
 * one left behind, and each way a sweep ends early.
 */

import { describe, expect, it } from "vitest";
import {
  directoryTestCaseDigest,
  summarizeDirectoryToolTests,
  validateDirectoryTestPlan,
  type DirectoryTestCallRecord,
  type DirectoryTestPlan,
  type DirectoryToolCallEvidence,
  type DirectoryToolTestResult,
  type SummarizeDirectoryToolTestsInput,
} from "@mcpjam/sdk";
import type { LedgerCallWrite } from "../call-ledger.js";
import {
  ReadinessLeaseLostError,
  ReadinessRunCancelledError,
} from "../runner.js";
import {
  executeDirectoryTestPlan,
  type ExecuteTestPlanInput,
  type TestPlanCallRequest,
} from "../test-plan-executor.js";
import {
  OK,
  TOOLS,
  memoryLedger,
  sampleAnswer,
  samplePlan,
  scriptedServer,
  storedCall,
  type Journal,
} from "./test-plan-fixtures.js";

const ENDPOINT = "https://connector.example.com/mcp";
const NEVER = Number.MAX_SAFE_INTEGER;

function setup(
  plan: DirectoryTestPlan = samplePlan(),
  earlier: DirectoryTestCallRecord[] = [],
  answer?: (
    request: TestPlanCallRequest,
  ) => DirectoryToolCallEvidence | Promise<DirectoryToolCallEvidence>,
) {
  const journal: Journal = [];
  const server = scriptedServer(journal, answer);
  const ledger = memoryLedger(journal, earlier);
  const input: ExecuteTestPlanInput = {
    plan,
    tools: TOOLS,
    ledger: earlier,
    send: server.send,
    record: ledger.record,
    casesBy: NEVER,
    cleanupBy: NEVER,
    endpoint: ENDPOINT,
  };
  return { plan, journal, server, ledger, input };
}

/** The ledger refuses the writes `refuse` picks, and takes the rest. */
function refusing(
  ledger: ReturnType<typeof memoryLedger>,
  refuse: (write: LedgerCallWrite) => Error | undefined,
) {
  const take = ledger.record.getMockImplementation()!;
  ledger.record.mockImplementation(async (write) => {
    const error = refuse(write);
    if (error) throw error;
    return take(write);
  });
}

function digestOf(plan: DirectoryTestPlan, caseId: string): string {
  const testCase = plan.cases.find((candidate) => candidate.id === caseId)!;
  const tool = TOOLS.find((candidate) => candidate.name === testCase.tool);
  return directoryTestCaseDigest(plan, testCase, tool);
}

function byTool(
  plan: DirectoryTestPlan,
  calls: DirectoryTestCallRecord[],
  stopped?: SummarizeDirectoryToolTestsInput["stopped"],
): Record<string, DirectoryToolTestResult> {
  const results = summarizeDirectoryToolTests({
    plan,
    tools: TOOLS,
    calls,
    ...(stopped ? { stopped } : {}),
  });
  return Object.fromEntries(results.map((result) => [result.tool, result]));
}

const sentTools = (server: ReturnType<typeof scriptedServer>) =>
  server.sent.map((request) => request.tool);

/** A promise the test opens when it chooses. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

it("uses a sample plan the SDK accepts for the sample server", () => {
  expect(validateDirectoryTestPlan(samplePlan(), TOOLS)).toEqual([]);
});

describe("a sweep", () => {
  it("runs the cases in plan order, each recorded before it is sent and after it answers", async () => {
    const { input, journal, server } = setup();
    const execution = await executeDirectoryTestPlan(input);

    expect(journal).toEqual([
      "started list_projects#valid",
      "send list_projects",
      "succeeded list_projects#valid",
      "started get_project#valid",
      "send get_project",
      "succeeded get_project#valid",
      "started get_project#missing-id",
      "send get_project",
      "failed get_project#missing-id",
      "started create_project#valid",
      "send create_project",
      "succeeded create_project#valid",
      "started rename_project#valid",
      "send rename_project",
      "succeeded rename_project#valid",
      "started delete_project#valid",
      "send delete_project",
      "succeeded delete_project#valid",
      // Cleanup runs last, for the fixture the sweep created.
      "started cleanup:scratchProject",
      "send delete_project",
      "succeeded cleanup:scratchProject",
    ]);
    expect(sentTools(server)).not.toContain("send_invite");
    expect(execution.stopped).toBeUndefined();
    expect(execution.calls).toHaveLength(6);
    expect(execution.cleanup.map((call) => call.callKey)).toEqual([
      "cleanup:scratchProject",
    ]);
  });

  it("records the input digest, the client and the outcome, and fills fixtures from captured values", async () => {
    const { plan, input, ledger, server } = setup();
    await executeDirectoryTestPlan(input);
    const written = (callKey: string, phase: string) =>
      ledger.writes.find(
        (write) => write.callKey === callKey && write.phase === phase,
      );

    expect(written("get_project#valid", "started")).toEqual({
      callKey: "get_project#valid",
      tool: "get_project",
      effect: "read",
      phase: "started",
      inputDigest: digestOf(plan, "get_project#valid"),
      ranBy: { kind: "direct-call" },
      endpoint: ENDPOINT,
    });
    expect(written("get_project#missing-id", "failed")).toMatchObject({
      outcome: "tool-error",
    });
    expect(written("create_project#valid", "succeeded")).toMatchObject({
      effect: "write",
      outcome: "result",
      captured: [
        { fixture: "scratchProject", name: "id", value: "proj_scratch" },
      ],
    });
    expect(server.sent[1]?.arguments).toEqual({ projectId: "proj_demo" });
    expect(server.sent[3]).toEqual({
      tool: "create_project",
      arguments: { name: "Readiness scratch" },
      capture: ["project.id"],
    });
    expect(server.sent[4]?.arguments).toEqual({
      projectId: "proj_scratch",
      name: "Renamed by MCPJam",
    });
  });

  it("runs reads side by side up to the concurrency, and a write alone after them", async () => {
    const plan = samplePlan();
    plan.budget.concurrency = 2;
    let out = 0;
    let most = 0;
    const outAtWrite: number[] = [];
    const { input } = setup(plan, [], async (request) => {
      if (request.tool === "create_project") outAtWrite.push(out);
      out += 1;
      most = Math.max(most, out);
      await new Promise((resolve) => setTimeout(resolve, 5));
      out -= 1;
      return sampleAnswer(request);
    });
    await executeDirectoryTestPlan(input);
    expect(most).toBe(2);
    expect(outAtWrite).toEqual([0]);
  });

  it("does not send a case whose fixture value the creating call did not return", async () => {
    const { plan, input, server } = setup(samplePlan(), [], (request) =>
      request.tool === "create_project" ? OK : sampleAnswer(request),
    );
    const execution = await executeDirectoryTestPlan(input);
    expect(sentTools(server)).toEqual([
      "list_projects",
      "get_project",
      "get_project",
      "create_project",
    ]);
    expect(
      byTool(plan, execution.calls).rename_project?.cases[0],
    ).toMatchObject({
      status: "blocked",
      reason:
        "Case create_project#valid returned no id for scratchProject. Correct the fixture's capture path, then run again.",
    });
    // Nothing was created that the run could name, so nothing is cleaned up.
    expect(execution.cleanup).toEqual([]);
  });
});

describe("a resumed run", () => {
  it("marks a write an earlier worker left started ambiguous, never sends it, and runs a read again", async () => {
    const plan = samplePlan();
    const createDigest = digestOf(plan, "create_project#valid");
    const earlier = [
      storedCall(
        "list_projects#valid",
        "list_projects",
        digestOf(plan, "list_projects#valid"),
      ),
      storedCall(
        "get_project#valid",
        "get_project",
        digestOf(plan, "get_project#valid"),
        {
          phase: "succeeded",
          outcome: "result",
          finishedAt: 1_100,
        },
      ),
      storedCall("create_project#valid", "create_project", createDigest),
    ];
    const { input, ledger, server } = setup(plan, earlier);
    const execution = await executeDirectoryTestPlan(input);

    // The stopped read runs again and the new negative case runs; the
    // finished read keeps its evidence; the write is never sent again.
    expect(
      server.sent.map(({ tool, arguments: args }) => [tool, args]),
    ).toEqual([
      ["list_projects", {}],
      ["get_project", {}],
    ]);
    expect(
      ledger.writes.filter((write) => write.callKey === "create_project#valid"),
    ).toEqual([
      {
        callKey: "create_project#valid",
        tool: "create_project",
        effect: "write",
        inputDigest: createDigest,
        ranBy: { kind: "direct-call" },
        phase: "ambiguous",
      },
    ]);
    const results = byTool(plan, execution.calls);
    expect(results.create_project?.status).toBe("ambiguous");
    expect(results.rename_project?.cases[0]).toMatchObject({
      status: "blocked",
      reason:
        "scratchProject was not created: case create_project#valid is ambiguous.",
    });
    expect(results.get_project?.cases[0]?.call?.finishedAt).toBe(1_100);
  });

  it("counts the calls an earlier execution made against the budget", async () => {
    const plan = samplePlan();
    plan.budget.maxCalls = 2;
    const earlier = [
      storedCall(
        "list_projects#valid",
        "list_projects",
        digestOf(plan, "list_projects#valid"),
        {
          phase: "succeeded",
          outcome: "result",
        },
      ),
    ];
    const { input, server } = setup(plan, earlier);
    const execution = await executeDirectoryTestPlan(input);
    expect(sentTools(server)).toEqual(["get_project"]);
    expect(execution.stopped).toEqual({ by: "budget" });
  });
});

describe("a sweep that ends early", () => {
  it("stops at the call budget, leaves the rest untested, and still cleans up what it created", async () => {
    const plan = samplePlan();
    plan.budget.maxCalls = 4;
    const { input, server } = setup(plan);
    const execution = await executeDirectoryTestPlan(input);

    expect(execution.stopped).toEqual({ by: "budget" });
    // Four cases, then the cleanup step, which the budget does not count.
    expect(sentTools(server)).toEqual([
      "list_projects",
      "get_project",
      "get_project",
      "create_project",
      "delete_project",
    ]);
    expect(execution.cleanup).toEqual([
      expect.objectContaining({
        callKey: "cleanup:scratchProject",
        phase: "succeeded",
      }),
    ]);
    expect(
      byTool(plan, execution.calls, execution.stopped).rename_project,
    ).toMatchObject({
      status: "untested",
      reason:
        "rename_project#valid: The sweep used its call budget before this case. Raise the budget and run again.",
    });
  });

  it("starts no case once its time is up", async () => {
    const { input, server } = setup();
    const execution = await executeDirectoryTestPlan({
      ...input,
      casesBy: 0,
      now: () => 1,
    });
    expect(execution.stopped).toEqual({ by: "deadline" });
    expect(server.sent).toEqual([]);
  });

  it("sends nothing the ledger could not record, and stops", async () => {
    const { input, ledger, server } = setup();
    ledger.record.mockRejectedValueOnce(new Error("HTTP 503"));
    const execution = await executeDirectoryTestPlan(input);
    expect(server.sent).toEqual([]);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(execution.stopped).toMatchObject({ by: "setup" });
    expect(execution.stopped?.detail).toMatch(/could not record a call/);
  });

  it("leaves a call the ledger refused unsent, with the ledger's record of it", async () => {
    const plan = samplePlan();
    const { input, ledger, server } = setup(plan);
    const take = ledger.record.getMockImplementation()!;
    const held = storedCall(
      "rename_project#valid",
      "rename_project",
      digestOf(plan, "rename_project#valid"),
      { phase: "succeeded", outcome: "result" },
    );
    ledger.record.mockImplementation(async (write) =>
      write.callKey === "rename_project#valid"
        ? { kind: "refused", error: "phase_backward", call: held }
        : take(write),
    );
    const execution = await executeDirectoryTestPlan(input);
    expect(sentTools(server)).not.toContain("rename_project");
    expect(execution.calls).toContainEqual(held);
  });
});

describe("a lost lease", () => {
  it("stops the sweep: nothing more is sent or written", async () => {
    const { input, ledger, journal } = setup();
    refusing(ledger, (write) =>
      write.callKey === "create_project#valid"
        ? new ReadinessLeaseLostError()
        : undefined,
    );
    await expect(executeDirectoryTestPlan(input)).rejects.toBeInstanceOf(
      ReadinessLeaseLostError,
    );
    expect(journal.at(-1)).toBe("failed get_project#missing-id");
    expect(journal).not.toContain("send create_project");
    expect(ledger.record).toHaveBeenCalledTimes(7);
  });

  it("writes no answer for a read that was out beside the call that met it", async () => {
    const plan = samplePlan();
    plan.budget.concurrency = 2;
    const listOut = gate();
    const answered = gate();
    const { input, ledger, journal } = setup(plan, [], async (request) => {
      if (request.tool === "list_projects") {
        listOut.open();
        await answered.opened;
      }
      return sampleAnswer(request);
    });
    const take = ledger.record.getMockImplementation()!;
    ledger.record.mockImplementation(async (write) => {
      if (write.callKey !== "get_project#valid") return take(write);
      // The lease is lost while the read beside this call is out.
      await listOut.opened;
      throw new ReadinessLeaseLostError();
    });
    await expect(executeDirectoryTestPlan(input)).rejects.toBeInstanceOf(
      ReadinessLeaseLostError,
    );
    answered.open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(journal).toEqual([
      "started list_projects#valid",
      "send list_projects",
    ]);
  });

  it("sends no call whose start was being recorded when the call beside it met it", async () => {
    const plan = samplePlan();
    plan.budget.concurrency = 2;
    const lost = gate();
    const { input, ledger, journal } = setup(plan);
    const take = ledger.record.getMockImplementation()!;
    ledger.record.mockImplementation(async (write) => {
      if (write.callKey === "get_project#valid") {
        // The other start is answered in the same turn this one is refused.
        lost.open();
        throw new ReadinessLeaseLostError();
      }
      const answer = await take(write);
      if (write.callKey === "list_projects#valid") await lost.opened;
      return answer;
    });
    await expect(executeDirectoryTestPlan(input)).rejects.toBeInstanceOf(
      ReadinessLeaseLostError,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(journal).toEqual(["started list_projects#valid"]);
  });

  it("writes no answer for a call that was out when the run was cancelled", async () => {
    const controller = new AbortController();
    const { input, journal } = setup(samplePlan(), [], (request) => {
      if (request.tool === "create_project") controller.abort();
      return sampleAnswer(request);
    });
    await expect(
      executeDirectoryTestPlan({ ...input, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ReadinessRunCancelledError);
    expect(journal.slice(-2)).toEqual([
      "started create_project#valid",
      "send create_project",
    ]);
  });
});
