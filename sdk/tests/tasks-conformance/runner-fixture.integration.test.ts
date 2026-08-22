/**
 * The Tasks conformance runner driven END TO END against the raw extension
 * fixture over a real socket — no mocked `withEphemeralClient`, no mocked
 * `ManagedMcpClient`.
 *
 * `runner.test.ts` covers the runner's decision logic against a hand-built
 * fake manager. That is necessary but not sufficient: it cannot catch a probe
 * that never reaches the wire, because a fake manager answers whatever the
 * test wants. Both bugs this file exists to pin were exactly that shape —
 * a `tools/list` the modern decoder refused (so DISCOVERY died before any
 * Tasks check ran) and an undeclared-capability probe that threw locally (so
 * the `-32021` requirement was never put to the server).
 *
 * So the assertions here are deliberately about the WIRE: the fixture's
 * `received` log is the witness that each probe actually left the process,
 * and each check's verdict is asserted in BOTH directions — conformant
 * fixture passes, misbehaving fixture fails and names the offending method.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import type {
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksConformanceResult,
} from "../../src/tasks-conformance/index.js";
import { MCP_TASKS_CHECK_IDS } from "../../src/tasks-conformance/index.js";
import {
  EXTENSION_PROTOCOL_VERSION,
  TASK_TOOL_NAME,
  declaresTasksExtension,
  serveExtensionTasksFixture,
  taskTool,
  type ExtensionTasksFixtureOptions,
  type ServedExtensionTasksFixture,
} from "../support/extension-tasks-fixture.js";

/**
 * A lifecycle that reaches `completed` on the second poll with no elicitation
 * gate — the conformance runner never answers `inputRequests`, so the default
 * phases would stall it against `pollTimeoutMs`.
 */
function quickPhases() {
  return [
    { status: "working" as const, ttlMs: 60_000, pollIntervalMs: 5 },
    {
      status: "completed" as const,
      ttlMs: 30_000,
      result: { content: [{ type: "text", text: "done" }], isError: false },
    },
  ];
}

const opened: ServedExtensionTasksFixture[] = [];

afterEach(async () => {
  // Unconditional teardown: a leaked HTTP server keeps the event loop alive
  // and makes vitest exit non-zero AFTER printing a green summary.
  for (const fixture of opened.splice(0)) {
    await fixture.close().catch(() => {});
  }
});

async function serve(
  options: ExtensionTasksFixtureOptions = {}
): Promise<ServedExtensionTasksFixture> {
  const fixture = await serveExtensionTasksFixture({
    tools: { [TASK_TOOL_NAME]: taskTool(quickPhases()) },
    ...options,
  });
  opened.push(fixture);
  return fixture;
}

function runAgainst(
  fixture: ServedExtensionTasksFixture,
  overrides: Record<string, unknown> = {}
): Promise<MCPTasksConformanceResult> {
  return new MCPTasksConformanceTest({
    url: fixture.url,
    mcpProtocolVersion: EXTENSION_PROTOCOL_VERSION,
    timeout: 10_000,
    // The fixture's tools carry no `execution.taskSupport` metadata (that is
    // 2025-11-25 shape, and the 2026 `ToolSchema` would strip it), so the
    // probe tool is named rather than auto-picked.
    toolName: TASK_TOOL_NAME,
    pollTimeoutMs: 5_000,
    ...overrides,
  } as never).run();
}

function unrunChecks(result: MCPTasksConformanceResult) {
  return result.checks.filter(
    (entry) => entry.status === "skipped" && entry.skipReason === "could-not-run"
  );
}

function check(
  result: MCPTasksConformanceResult,
  id: MCPTasksCheckId
): MCPTasksCheckResult {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`check ${id} was not produced`);
  return found;
}

/** Requests the fixture received for `method` that carried NO declaration. */
function undeclaredRequests(
  fixture: ServedExtensionTasksFixture,
  method: string
) {
  return fixture.received.filter(
    (entry) => entry.method === method && !declaresTasksExtension(entry.params)
  );
}

describe("MCPTasksConformanceTest against the extension fixture", () => {
  it("completes discovery and reaches every Tasks check", async () => {
    const fixture = await serve();
    const result = await runAgainst(fixture);

    // Discovery is the gate the missing `ttlMs`/`cacheScope` on `tools/list`
    // used to slam shut: without it the runner returns a single synthetic
    // connect failure and no Tasks check exists at all.
    expect(result.discovery).toMatchObject({
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      wire: "extension",
      toolCount: 1,
      probedTool: TASK_TOOL_NAME,
    });
    expect(result.discovery.createdTaskId).toBeTruthy();
    expect(result.checks).toHaveLength(MCP_TASKS_CHECK_IDS.length);
    // One skip is expected and correct: this fixture's task completes without
    // ever asking for input, so the `input_required` round trip is not
    // applicable to it (a task that never asks is the normal case, not a
    // defect). Everything else ran.
    expect(
      result.checks
        .filter((entry) => entry.status === "skipped")
        .map((entry) => [entry.id, entry.skipReason])
    ).toEqual([["tasks-input-required-update-completes", "not-applicable"]]);
  });

  it("passes the undeclared-capability checks against a conformant fixture, having actually sent the probes", async () => {
    const fixture = await serve();
    const result = await runAgainst(fixture);

    expect(check(result, "tasks-undeclared-capability-rejected").status).toBe(
      "passed"
    );
    expect(check(result, "tasks-undeclared-creation-refused").status).toBe(
      "passed"
    );

    // The whole point: the probes are only meaningful if the SERVER saw them.
    for (const method of [
      "tasks/get",
      "tasks/update",
      "tasks/cancel",
      "subscriptions/listen",
    ]) {
      expect(
        undeclaredRequests(fixture, method).length,
        `${method} never reached the fixture without a declaration`
      ).toBeGreaterThan(0);
    }
    // …and the runner agrees, per probe, that it did.
    const probes = (check(result, "tasks-undeclared-capability-rejected")
      .details?.probes ?? []) as Array<{
      method: string;
      outcome: string;
      reachedWire?: boolean;
    }>;
    expect(probes.map((probe) => probe.outcome)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(probes.every((probe) => probe.reachedWire === true)).toBe(true);

    // The undeclared tools/call reached it too, and produced no task.
    expect(undeclaredRequests(fixture, "tools/call").length).toBeGreaterThan(0);
    expect(fixture.tasks()).toHaveLength(1);
  });

  it("passes the rest of the suite against a conformant fixture", async () => {
    const fixture = await serve();
    const result = await runAgainst(fixture);

    const verdicts = Object.fromEntries(
      result.checks.map((entry) => [entry.id, entry.status])
    );
    expect(verdicts).toEqual({
      "tasks-wire-resolvable": "passed",
      "tasks-declaration-hygiene": "passed",
      "tasks-result-type-discipline": "passed",
      "tasks-undeclared-creation-refused": "passed",
      "tasks-undeclared-capability-rejected": "passed",
      "tasks-ttl-shape": "passed",
      "tasks-inline-result": "passed",
      "tasks-mcp-name-routing": "passed",
      // The scenario depth added by the conformance-gap program. All of them
      // are outside the `mcp-tasks` profile's scored set, so they report these
      // verdicts without moving the number.
      "tasks-invalid-task-id-rejected": "passed",
      "tasks-status-payload-shape": "passed",
      "tasks-cancel-ack-shape": "passed",
      "tasks-ttl-integer-shape": "passed",
      "tasks-undeclared-capability-names-requirements": "passed",
      "tasks-input-required-update-completes": "skipped",
    });
    // Green DESPITE the skip, because the skipped check is `not-applicable`
    // (this task never asks for input) rather than `could-not-run`.
    expect(result.passed).toBe(true);
    expect(result.profile).toMatchObject({
      profileId: "mcp-tasks",
      pendingCheckIds: [
        "tasks-cancel-ack-shape",
        "tasks-input-required-update-completes",
        "tasks-invalid-task-id-rejected",
        "tasks-status-payload-shape",
        "tasks-ttl-integer-shape",
        "tasks-undeclared-capability-names-requirements",
      ],
    });
  });

  it("fails the undeclared-capability check when the fixture answers undeclared task requests, naming every offending method", async () => {
    const fixture = await serve({
      misbehave: {
        answerUndeclaredTaskRequests: true,
        answerUndeclaredTaskSubscription: true,
      },
    });
    const result = await runAgainst(fixture);

    const rejected = check(result, "tasks-undeclared-capability-rejected");
    expect(rejected.status).toBe("failed");
    for (const method of [
      "tasks/get",
      "tasks/update",
      "tasks/cancel",
      "subscriptions/listen",
    ]) {
      expect(rejected.error?.message).toContain(
        `${method} was answered instead of rejected`
      );
    }
    expect(result.passed).toBe(false);
  });

  it("fails the undeclared-creation check when the fixture hands a task to a non-declaring caller", async () => {
    const fixture = await serve({
      misbehave: { createTaskForUndeclaredCall: true },
    });
    const result = await runAgainst(fixture);

    const creation = check(result, "tasks-undeclared-creation-refused");
    expect(creation.status).toBe("failed");
    expect(creation.error?.message).toContain("CreateTaskResult");
    expect(creation.details).toMatchObject({ tool: TASK_TOOL_NAME });
    // The violation is real on the wire, not inferred: the fixture minted a
    // second task for the call that carried no declaration.
    expect(fixture.tasks().length).toBeGreaterThan(1);
    expect(result.passed).toBe(false);
  });

  it("fails the discipline check when a task carries no resultType discriminator", async () => {
    // The invisible-task break. The server DOES create a task, but omits the
    // one field that says so, and this client decodes the response as an
    // ordinary tool result — so the work runs to completion server-side with
    // no handle. Detection has to read the raw wire, because by the time the
    // result reaches the runner it no longer looks like a task at all.
    const fixture = await serve({ misbehave: { omitCreateResultType: true } });
    const result = await runAgainst(fixture);

    const discipline = check(result, "tasks-result-type-discipline");
    expect(discipline.status).toBe("failed");
    expect(discipline.error?.message).toContain('resultType "task"');
    expect(discipline.error?.message).toContain("UNREACHABLE");
    // The task really exists on the server — this is a lost handle, not a
    // server that simply declined to create one.
    expect(fixture.tasks().length).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it("fails the creation check when a non-declaring caller gets a task with no discriminator", async () => {
    // Doubly-misbehaving: violates tasks.md:61 (task for an undeclaring
    // caller) AND tasks.md:102 (no discriminator) at once. Before the raw
    // capture this scored a PASS, because the second violation hid the first.
    const fixture = await serve({
      misbehave: { createTaskForUndeclaredCall: true, omitCreateResultType: true },
    });
    const result = await runAgainst(fixture);

    const creation = check(result, "tasks-undeclared-creation-refused");
    expect(creation.status).toBe("failed");
    expect(creation.error?.message).toContain("raw wire");
    expect(fixture.tasks().length).toBeGreaterThan(1);
    expect(result.passed).toBe(false);
  });

  it("reports INCOMPLETE, not success, when no toolName is given on the extension wire", async () => {
    // The false green this suite exists to make impossible: auto-selection
    // reads `execution.taskSupport`, which the 2026 ToolSchema strips, so
    // without a `toolName` six task-dependent checks never run. Two of eight
    // passing must never be reported as conformance.
    const fixture = await serve();
    const result = await runAgainst(fixture, { toolName: undefined });

    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
    expect(result.checks.some((entry) => entry.status === "failed")).toBe(false);

    // Only the checks that need no created task genuinely ran; nothing else
    // may read as a pass, and none of the gaps may be excused as "not
    // applicable". `tasks-invalid-task-id-rejected` is here because it probes a
    // FABRICATED id and so establishes a real requirement even on a run that
    // could not provoke a task.
    expect(
      result.checks
        .filter((entry) => entry.status === "passed")
        .map((entry) => entry.id)
        .sort()
    ).toEqual([
      "tasks-declaration-hygiene",
      "tasks-invalid-task-id-rejected",
      "tasks-wire-resolvable",
    ]);
    expect(unrunChecks(result)).toHaveLength(11);
    expect(
      result.checks.filter(
        (entry) =>
          entry.status === "skipped" && entry.skipReason === "not-applicable"
      )
    ).toHaveLength(0);

    // The reason has to tell the user what to do and why the runner could not
    // do it for them.
    expect(result.incompleteReason).toContain("could not run");
    expect(result.incompleteReason).toContain("--tool-name");
    expect(result.incompleteReason).toContain("execution.taskSupport");
    expect(result.incompleteReason).toContain("2026-07-28");
    expect(result.incompleteReason).toContain(TASK_TOOL_NAME);
    // The SUMMARY counts only the scored checks, so it still reads 6: the five
    // new task-dependent gaps are pending under `mcp-tasks@2026-08-22.1`.
    expect(result.summary).toContain("6 could not run");
    expect(result.summary).toContain("pending");
    expect(result.categorySummary.creation.couldNotRun).toBe(2);
    expect(result.discovery.createdTaskId).toBeUndefined();
  });

  it("reports INCOMPLETE, naming the tool, when toolName is not listed by the server", async () => {
    // A typo must not silently skip six checks either.
    const fixture = await serve();
    const result = await runAgainst(fixture, { toolName: "task_toool" });

    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
    expect(unrunChecks(result)).toHaveLength(11);
    expect(result.incompleteReason).toContain('"task_toool"');
    expect(result.incompleteReason).toContain("is not listed by this server");
    // …and it points at what the server DOES list.
    expect(result.incompleteReason).toContain(TASK_TOOL_NAME);
    // No tools/call was attempted with a name the server never advertised.
    expect(
      fixture.received.filter((entry) => entry.method === "tools/call")
    ).toHaveLength(0);
  });

  it("keeps an unlimited (null) TTL null across the whole round trip", async () => {
    // `ttlMs: null` means unlimited and is semantically distinct from absent.
    // A `??` default in the fixture's seed used to turn a deliberate phase-zero
    // null into 60_000, so the wire shape could never be exercised.
    const received: unknown[] = [];
    const fixture = await serve({
      tools: {
        [TASK_TOOL_NAME]: taskTool([
          { status: "working", ttlMs: null, pollIntervalMs: 5 },
          {
            status: "completed",
            ttlMs: null,
            result: { content: [{ type: "text", text: "done" }] },
          },
        ]),
      },
    });

    const result = await runAgainst(fixture, {
      rpcLogger: (event: { direction: string; message: unknown }) => {
        if (event.direction === "receive") received.push(event.message);
      },
    });

    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
    // The fixture kept the seed rather than defaulting it…
    expect(fixture.tasks()[0].ttlMs).toBeNull();
    // …and `null` reached the client as a PRESENT null, not as an absent key.
    const withTask = received
      .map((message) => (message as { result?: Record<string, unknown> }).result)
      .filter(
        (payload): payload is Record<string, unknown> =>
          // `taskId` narrows this to task payloads: `tools/list` also carries a
          // (numeric) `ttlMs` of its own under SEP-2549.
          !!payload && "taskId" in payload && "ttlMs" in payload
      );
    expect(withTask.length).toBeGreaterThan(0);
    expect(withTask.every((payload) => payload.ttlMs === null)).toBe(true);
  });

  it("reports a connect failure as one failed run, not a green suite", async () => {
    // The other direction of the discovery gate: nothing to talk to at all
    // must surface as a failure, never as "no Tasks check ran, so nothing
    // failed". (Probe-level "could not execute" is pinned deterministically in
    // `runner.test.ts`, which can inject the exception; a live socket cannot
    // be torn down at a reproducible point mid-run.)
    const fixture = await serve();
    const url = fixture.url;
    await fixture.close();
    opened.splice(0);

    const result = await new MCPTasksConformanceTest({
      url,
      mcpProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      timeout: 2_000,
      toolName: TASK_TOOL_NAME,
      pollTimeoutMs: 1_000,
    }).run();

    expect(result.passed).toBe(false);
    expect(result.checks.every((entry) => entry.status !== "passed")).toBe(
      true
    );
  }, 20_000);
});
