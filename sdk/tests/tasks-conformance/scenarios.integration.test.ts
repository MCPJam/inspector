/**
 * The scenario depth added by the conformance-gap program, driven end to end
 * against the extension fixture over a real socket.
 *
 * Each check is asserted in BOTH directions — a conformant fixture passes, and
 * a fixture breaking exactly one rule fails and names it — for the same reason
 * `runner-fixture.integration.test.ts` gives: a check that has only ever been
 * seen pass is a check nobody has proven can fail.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import type {
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksConformanceResult,
} from "../../src/tasks-conformance/index.js";
import {
  DEFAULT_INPUT_REQUEST_KEY,
  EXTENSION_PROTOCOL_VERSION,
  TASK_TOOL_NAME,
  defaultTaskPhases,
  failedTaskPhases,
  serveExtensionTasksFixture,
  taskTool,
  type ExtensionTasksFixtureOptions,
  type ServedExtensionTasksFixture,
  type TaskPhase,
} from "../support/extension-tasks-fixture.js";

const opened: ServedExtensionTasksFixture[] = [];

afterEach(async () => {
  for (const fixture of opened.splice(0)) {
    await fixture.close().catch(() => {});
  }
});

/** Completes on the second poll without ever asking for input. */
function quickPhases(): TaskPhase[] {
  return [
    { status: "working", ttlMs: 60_000, pollIntervalMs: 5 },
    {
      status: "completed",
      ttlMs: 30_000,
      result: { content: [{ type: "text", text: "done" }], isError: false },
    },
  ];
}

async function serve(
  phases: TaskPhase[],
  options: ExtensionTasksFixtureOptions = {},
): Promise<ServedExtensionTasksFixture> {
  const fixture = await serveExtensionTasksFixture({
    tools: { [TASK_TOOL_NAME]: taskTool(phases) },
    ...options,
  });
  opened.push(fixture);
  return fixture;
}

async function run(
  fixture: ServedExtensionTasksFixture,
  checkIds: MCPTasksCheckId[],
  overrides: Record<string, unknown> = {},
): Promise<MCPTasksConformanceResult> {
  return await new MCPTasksConformanceTest({
    url: fixture.url,
    mcpProtocolVersion: EXTENSION_PROTOCOL_VERSION,
    timeout: 10_000,
    toolName: TASK_TOOL_NAME,
    pollTimeoutMs: 5_000,
    checkIds,
    ...overrides,
  } as never).run();
}

function check(
  result: MCPTasksConformanceResult,
  id: MCPTasksCheckId,
): MCPTasksCheckResult {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`check ${id} was not produced`);
  return found;
}

describe("tasks-invalid-task-id-rejected", () => {
  const ID: MCPTasksCheckId = "tasks-invalid-task-id-rejected";

  it("passes a server that answers -32602 for an id it never issued", async () => {
    const entry = check(await run(await serve(quickPhases()), [ID]), ID);
    expect([entry.status, entry.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails a server that fabricates a task for an unknown id", async () => {
    const fixture = await serve(quickPhases(), {
      misbehave: { answerUnknownTaskId: true },
    });
    const entry = check(await run(fixture, [ID]), ID);
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("answered instead of rejected");
  });

  it("only WARNS when the mutating methods use another code", async () => {
    // tasks.md:795 makes -32602 a MUST for `tasks/get` and a SHOULD for
    // `tasks/update` and `tasks/cancel`, so the same wrong answer must not
    // fail on the two where the spec only recommends it.
    const fixture = await serve(quickPhases(), {
      unknownTaskCodeForMutations: -32603,
    });
    const entry = check(await run(fixture, [ID]), ID);
    expect(entry.status).toBe("passed");
    expect(entry.warnings?.join(" ")).toContain("tasks/update");
    expect(entry.warnings?.join(" ")).toContain("SHOULD");
  });

  it("runs even when no task could be created", async () => {
    // It probes a FABRICATED id, so it establishes a real requirement on a run
    // that could not provoke a task at all — where every other lifecycle check
    // can only report a gap.
    const fixture = await serve(quickPhases());
    const entry = check(await run(fixture, [ID], { toolName: undefined }), ID);
    expect(entry.status).toBe("passed");
  });
});

describe("tasks-status-payload-shape", () => {
  const ID: MCPTasksCheckId = "tasks-status-payload-shape";

  it("passes a completed task that carries its result", async () => {
    const entry = check(await run(await serve(quickPhases()), [ID]), ID);
    expect([entry.status, entry.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails a completed task with no result field", async () => {
    const phases = quickPhases();
    phases[1] = { ...phases[1]!, omit: ["result"] };
    const entry = check(await run(await serve(phases), [ID]), ID);
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("`result`");
  });

  it("grades a frame the DECODED task never even reported", async () => {
    // Two properties at once, and the second is the stronger one.
    //
    // (1) Every observed payload is graded, not just the state the task ended
    //     in — `inspectedPayloads` is 3 here.
    // (2) The violating frame is one the client never surfaced AT ALL: without
    //     `inputRequests` the decoder cannot resolve the `input_required`
    //     variant, so the round-trip check beside this one reports the task
    //     "never reported input_required". A check reading the decoded task
    //     would therefore see nothing wrong; the wire is the only witness.
    const result = await run(
      await serve([
        { status: "working", ttlMs: 60_000, pollIntervalMs: 5 },
        { status: "input_required", polls: 1, omit: ["inputRequests"] },
        {
          status: "completed",
          ttlMs: 30_000,
          result: { content: [{ type: "text", text: "done" }], isError: false },
        },
      ]),
      [ID, "tasks-input-required-update-completes"],
      {
        inputResponses: {
          [DEFAULT_INPUT_REQUEST_KEY]: {
            result: { action: "accept", content: { name: "Ada" } },
          },
        },
      },
    );

    const entry = check(result, ID);
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("input_required");
    expect(entry.error?.message).toContain("`inputRequests`");
    expect(Number(entry.details?.inspectedPayloads)).toBeGreaterThan(1);

    // The decoded view never saw the state the raw frame was rejected for.
    expect(
      check(result, "tasks-input-required-update-completes").error?.message,
    ).toContain("never reported input_required");
  });

  it("reports a repeated bad snapshot once, not once per poll", async () => {
    // The fixture re-sends its `input_required` snapshot on every poll while
    // the gate is open. One finding, not N copies of it.
    const phases = defaultTaskPhases();
    const gateIndex = phases.findIndex(
      (phase) => phase.status === "input_required",
    );
    phases[gateIndex] = { ...phases[gateIndex]!, omit: ["inputRequests"] };

    const entry = check(await run(await serve(phases), [ID]), ID);
    expect(entry.status).toBe("failed");
    const occurrences = (
      entry.error?.message.match(/`inputRequests`/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
    expect(Number(entry.details?.inspectedPayloads)).toBeGreaterThan(1);
  });

  it("fails a failed task with no error field, which the client itself rejects", async () => {
    // The reason this check reads RAW frames. The SDK's payload schema refuses
    // a `failed` task carrying no `error`, so the decoded task never reaches a
    // check at all — reading it would score this server green on exactly the
    // state the check exists to catch.
    const phases = failedTaskPhases();
    phases[phases.length - 1] = {
      ...phases[phases.length - 1]!,
      omit: ["error"],
    };
    const entry = check(await run(await serve(phases), [ID]), ID);
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("`error`");
  });
});

describe("tasks-cancel-ack-shape", () => {
  const ID: MCPTasksCheckId = "tasks-cancel-ack-shape";

  it("passes an empty acknowledgement", async () => {
    const entry = check(await run(await serve(quickPhases()), [ID]), ID);
    expect([entry.status, entry.error?.message]).toEqual(["passed", undefined]);
  });

  it("does not require the task to become cancelled", async () => {
    // The spec is explicit that cancellation is eventually consistent and the
    // status "MAY remain working … and MAY ultimately reach a terminal status
    // other than cancelled". A check demanding `cancelled` would fail servers
    // for behavior the extension permits, so this pins that it does not.
    const fixture = await serve(quickPhases());
    const result = await run(fixture, [ID]);
    expect(check(result, ID).status).toBe("passed");
    // The fixture saw the cancel and the task still ended non-`cancelled`,
    // which is exactly the state the spec permits and the check must accept.
    const task = fixture.tasks()[0];
    expect(task?.cancelRequested).toBe(true);
  });
});

describe("tasks-ttl-integer-shape", () => {
  const ID: MCPTasksCheckId = "tasks-ttl-integer-shape";

  it("passes integer milliseconds", async () => {
    const entry = check(await run(await serve(quickPhases()), [ID]), ID);
    expect([entry.status, entry.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails a fractional ttlMs", async () => {
    const phases = quickPhases();
    phases[1] = { ...phases[1]!, ttlMs: 1500.5 };
    const entry = check(await run(await serve(phases), [ID]), ID);
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("not an integer");
  });

  it("only warns on a negative ttlMs, which the extension never forbids", async () => {
    const phases = quickPhases();
    phases[1] = { ...phases[1]!, ttlMs: -1 };
    const entry = check(await run(await serve(phases), [ID]), ID);
    expect(entry.status).toBe("passed");
    expect(entry.warnings?.join(" ")).toContain("unlimited");
  });

  it("leaves an unlimited (null) TTL alone", async () => {
    const phases = quickPhases();
    phases[1] = { ...phases[1]!, ttlMs: null };
    const entry = check(await run(await serve(phases), [ID]), ID);
    expect([entry.status, entry.warnings]).toEqual(["passed", undefined]);
  });
});

describe("tasks-input-required-update-completes", () => {
  const ID: MCPTasksCheckId = "tasks-input-required-update-completes";
  const RESPONSES = {
    [DEFAULT_INPUT_REQUEST_KEY]: {
      result: { action: "accept", content: { name: "Ada" } },
    },
  };

  it("completes the round trip when responses are supplied", async () => {
    const fixture = await serve(defaultTaskPhases());
    const result = await run(fixture, [ID], { inputResponses: RESPONSES });
    const entry = check(result, ID);
    expect([entry.status, entry.error?.message]).toEqual(["passed", undefined]);
    expect(entry.details).toMatchObject({ finalStatus: "completed" });
    // The wire is the witness: a `tasks/update` really left the process.
    expect(
      fixture.received.filter((request) => request.method === "tasks/update"),
    ).not.toHaveLength(0);
  });

  it("skips, naming what it needs, when no responses are configured", async () => {
    const fixture = await serve(defaultTaskPhases());
    const entry = check(await run(fixture, [ID]), ID);
    expect([entry.status, entry.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(entry.error?.message).toContain("inputResponses");
    expect(entry.error?.message).toContain(DEFAULT_INPUT_REQUEST_KEY);
  });

  it("does not burn the poll timeout on an unanswerable task", async () => {
    // Before this, an input-gated task polled to `pollTimeoutMs` to arrive at
    // the state it was already in, and every dependent check reported its gap
    // seconds later than it had to.
    //
    // Counted in REQUESTS, not wall-clock: the fixture parks on
    // `input_required` with `pollIntervalMs: 20`, so burning a 5s timeout is
    // ~250 `tasks/get` calls while stopping early is a handful. A count bound
    // states that gap exactly and cannot go red because CI was slow.
    const fixture = await serve(defaultTaskPhases());
    await run(fixture, [ID], { pollTimeoutMs: 5_000 });
    const polls = fixture.received.filter(
      (request) => request.method === "tasks/get",
    );
    expect(polls.length).toBeLessThanOrEqual(12);
  });

  it("is not applicable when the task never asks for input", async () => {
    const entry = check(await run(await serve(quickPhases()), [ID]), ID);
    expect([entry.status, entry.skipReason]).toEqual([
      "skipped",
      "not-applicable",
    ]);
  });

  it("fails when tasks/update is rejected for a task that asked for input", async () => {
    const fixture = await serve(defaultTaskPhases(), {
      rejectUpdateWithInvalidParams: true,
    });
    const entry = check(
      await run(fixture, [ID], { inputResponses: RESPONSES }),
      ID,
    );
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("rejected");
  });
});

describe("tasks-undeclared-capability-names-requirements", () => {
  const ID: MCPTasksCheckId = "tasks-undeclared-capability-names-requirements";

  it("passes when the -32021 names the missing capability", async () => {
    const entry = check(await run(await serve(quickPhases()), [ID]), ID);
    expect([entry.status, entry.error?.message]).toEqual(["passed", undefined]);
  });

  it("is a separate obligation from the rejection itself", async () => {
    // A server can reject correctly and still say nothing about WHAT is
    // missing, which leaves the client unable to act on the error. Both checks
    // read one shared probe round, so this costs no extra traffic.
    const result = await run(await serve(quickPhases()), [
      "tasks-undeclared-capability-rejected",
      ID,
    ]);
    expect(
      result.checks.map((entry) => [entry.id, entry.status]).sort(),
    ).toEqual([
      ["tasks-undeclared-capability-names-requirements", "passed"],
      ["tasks-undeclared-capability-rejected", "passed"],
    ]);
  });
});

describe("the mcp-tasks profile", () => {
  it("keeps every new check out of the verdict", async () => {
    // The point of landing them pending: a fixture that breaks one of them is
    // still not reported as non-conformant until a profile version says so.
    const fixture = await serve(quickPhases(), {
      misbehave: { answerUnknownTaskId: true },
    });
    const result = await run(fixture, [
      "tasks-invalid-task-id-rejected",
      "tasks-wire-resolvable",
    ]);
    expect(check(result, "tasks-invalid-task-id-rejected").status).toBe(
      "failed",
    );
    expect(result.outcome).not.toBe("failed");
    expect(result.profile).toMatchObject({
      profileId: "mcp-tasks",
      pendingCheckIds: ["tasks-invalid-task-id-rejected"],
    });
  });
});
