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
 * the `-32003` requirement was never put to the server).
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
  fixture: ServedExtensionTasksFixture
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
  }).run();
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
    expect(result.checks).toHaveLength(8);
    expect(
      result.checks.filter((entry) => entry.status === "skipped")
    ).toHaveLength(0);
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
    const probes = check(result, "tasks-undeclared-capability-rejected").details
      ?.probes as Array<{
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
    });
    expect(result.passed).toBe(true);
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
