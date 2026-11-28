/**
 * `tasks-invalid-task-id-rejected` on the 2025-11-25 wire.
 *
 * "Receivers MUST return standard JSON-RPC errors for the following protocol
 * error cases: Invalid or nonexistent `taskId` in `tasks/get`, `tasks/result`,
 * or `tasks/cancel`: `-32602` (Invalid params)" (2025-11-25
 * basic/utilities/tasks.mdx:766-768). On this wire all three are a MUST, so
 * a wrong answer on any of them fails the check. `tasks/cancel` is sent only
 * to a server that declares `tasks.cancel` ("`capabilities.tasks.cancel`
 * controls if the `tasks/cancel` operation is supported", tasks.mdx:105).
 *
 * Driven against the shared raw 2025-11-25 fixture over a real socket.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import type {
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksConformanceResult,
} from "../../src/tasks-conformance/index.js";
import {
  serveLegacyTasksFixture,
  type LegacyTasksFixtureOptions,
  type ServedLegacyTasksFixture,
} from "../support/legacy-tasks-fixture.js";

const ID: MCPTasksCheckId = "tasks-invalid-task-id-rejected";
const opened: ServedLegacyTasksFixture[] = [];

afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});

async function run(
  options: LegacyTasksFixtureOptions = {}
): Promise<{ result: MCPTasksConformanceResult; fixture: ServedLegacyTasksFixture }> {
  const fixture = await serveLegacyTasksFixture({
    rejectUnknownTaskIds: true,
    ...options,
  });
  opened.push(fixture);
  const result = await new MCPTasksConformanceTest({
    url: fixture.url,
    mcpProtocolVersion: "2025-11-25",
    timeout: 5_000,
    checkIds: [ID],
  } as never).run();
  return { result, fixture };
}

function check(result: MCPTasksConformanceResult): MCPTasksCheckResult {
  const found = result.checks.find((entry) => entry.id === ID);
  if (!found) throw new Error(`no result for ${ID}`);
  return found;
}

/** The task methods the run sent with a made-up id, in order. */
function probed(fixture: ServedLegacyTasksFixture): string[] {
  return fixture.received
    .filter(
      (request) =>
        request.method.startsWith("tasks/") &&
        String(request.params?.taskId).startsWith("mcpjam-conformance-unknown-task-")
    )
    .map((request) => request.method);
}

describe("tasks-invalid-task-id-rejected on the 2025-11-25 wire", () => {
  it("passes a server that answers -32602 on get, result and cancel", async () => {
    const { result, fixture } = await run();

    expect(check(result)).toMatchObject({ status: "passed" });
    expect(check(result).error).toBeUndefined();
    expect(probed(fixture)).toEqual(["tasks/get", "tasks/result", "tasks/cancel"]);
    expect(check(result).details).toMatchObject({
      get: { outcome: "rejected", code: -32602 },
      result: { outcome: "rejected", code: -32602 },
      cancel: { outcome: "rejected", code: -32602 },
    });
  });

  it("fails a server that answers tasks/get for an id it never issued", async () => {
    const { result } = await run({
      unknownTaskReplies: { "tasks/get": { answer: true } },
    });

    expect(check(result).status).toBe("failed");
    expect(check(result).error?.message).toMatch(
      /^tasks\/get answered with a normal result/
    );
  });

  it("fails another code on tasks/result: it is a MUST on this wire, not advice", async () => {
    const { result } = await run({
      unknownTaskReplies: { "tasks/result": { code: -32603 } },
    });

    expect(check(result).status).toBe("failed");
    expect(check(result).error?.message).toContain(
      "tasks/result answered with -32603"
    );
    expect(
      result.readiness?.some(
        (advice) => advice.id === "tasks-readiness-unknown-task-id-mutations"
      ) ?? false
    ).toBe(false);
  });

  it("fails another code on tasks/cancel", async () => {
    const { result } = await run({
      unknownTaskReplies: { "tasks/cancel": { code: -32603 } },
    });

    expect(check(result).status).toBe("failed");
    expect(check(result).error?.message).toContain(
      "tasks/cancel answered with -32603"
    );
  });

  it("does not send tasks/cancel to a server that does not declare tasks.cancel", async () => {
    const { result, fixture } = await run({
      tasksCapability: { requests: { tools: { call: {} } } },
    });

    expect(probed(fixture)).toEqual(["tasks/get", "tasks/result"]);
    expect(check(result).status).toBe("passed");
    expect(check(result).details).toMatchObject({
      cancel: { outcome: "not-declared" },
    });
  });

  it("cannot run when a rate limiter answers instead (catalog T9.W2)", async () => {
    // HTTP 429 with a JSON-RPC body: what answered was the limit, not the
    // task lookup, so there is no verdict on the unknown id.
    const { result } = await run({
      unknownTaskReplies: {
        "tasks/get": { code: -32000, httpStatus: 429 },
      },
    });

    expect([check(result).status, check(result).skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
  });
});
