/**
 * On 2025-11-25, a task parked on `input_required` gets a `tasks/result`.
 *
 * "When the requestor encounters the `input_required` status, it SHOULD
 * preemptively call `tasks/result`" (2025-11-25 tasks.mdx). The suite used to
 * read the task three more times and stop.
 *
 * Driven end to end against a raw 2025-11-25 server over a real socket. The
 * shared legacy fixture does not model `input_required`, so this file has its
 * own: a task that parks, and a `tasks/result` that is held open, answered, or
 * refused. Every request is recorded, so the assertions are on the wire.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import type {
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksConformanceResult,
} from "../../src/tasks-conformance/index.js";
import {
  EXTENSION_PROTOCOL_VERSION,
  TASK_TOOL_NAME,
  defaultTaskPhases,
  serveExtensionTasksFixture,
  taskTool,
} from "../support/extension-tasks-fixture.js";

const TOOL = "needs_input";
const TASK_ID = "parked-task-1";

type ResultMode =
  /** Keep the response open and never answer. */
  | "hold"
  /** End the task as completed and return its result. */
  | "complete"
  /** Refuse the call and leave the task parked (not what the spec asks). */
  | "refuse";

interface Fixture {
  url: string;
  /** JSON-RPC methods in arrival order, notifications included. */
  methods: string[];
  close: () => Promise<void>;
}

async function serveParkedTask(options: {
  onResult: ResultMode;
  /** Start `completed` instead of parked. */
  neverParks?: boolean;
}): Promise<Fixture> {
  const methods: string[] = [];
  const held = new Set<http.ServerResponse>();
  let status = options.neverParks ? "completed" : "input_required";

  const task = () => ({
    taskId: TASK_ID,
    status,
    createdAt: "2026-07-27T00:00:00Z",
    lastUpdatedAt: "2026-07-27T00:00:00Z",
    ttl: 60_000,
    pollInterval: 5,
  });
  const finalResult = {
    content: [{ type: "text", text: "done" }],
    _meta: { "io.modelcontextprotocol/related-task": { taskId: TASK_ID } },
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: unknown;
        method: string;
        params?: Record<string, unknown>;
      };
      methods.push(message.method);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (payload: Record<string, unknown>) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
      };

      switch (message.method) {
        case "initialize":
          reply({
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {
                tools: { listChanged: false },
                tasks: { cancel: {}, requests: { tools: { call: {} } } },
              },
              serverInfo: { name: "parked-task-fixture", version: "1.0.0" },
            },
          });
          return;
        case "tools/list":
          reply({
            result: {
              tools: [
                {
                  name: TOOL,
                  description: "A task that asks for input.",
                  inputSchema: { type: "object", properties: {} },
                  execution: { taskSupport: "required" },
                },
              ],
            },
          });
          return;
        case "tools/call":
          reply({ result: { task: { ...task(), status: "working" } } });
          return;
        case "tasks/get":
          reply({ result: task() });
          return;
        case "tasks/result":
          if (status === "completed") {
            reply({ result: finalResult });
          } else if (options.onResult === "complete") {
            status = "completed";
            reply({ result: finalResult });
          } else if (options.onResult === "refuse") {
            reply({
              error: { code: -32602, message: "The task is not finished" },
            });
          } else {
            // Held open: this is what a server waiting for an answer does.
            held.add(res);
          }
          return;
        default:
          reply({ result: {} });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    methods,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of held) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const fixture of opened.splice(0)) {
    await fixture.close().catch(() => {});
  }
});

const CHECKS: MCPTasksCheckId[] = ["tasks-ttl-shape", "tasks-inline-result"];

async function run(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<MCPTasksConformanceResult> {
  opened.push(fixture);
  return await new MCPTasksConformanceTest({
    url: fixture.url,
    mcpProtocolVersion: "2025-11-25",
    timeout: 10_000,
    toolName: TOOL,
    pollTimeoutMs: 400,
    checkIds: CHECKS,
    ...overrides,
  } as never).run();
}

function check(
  result: MCPTasksConformanceResult,
  id: MCPTasksCheckId,
): MCPTasksCheckResult {
  const found = result.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no result for ${id}`);
  return found;
}

/** The task traffic only, in order. */
function taskWire(fixture: Fixture): string[] {
  return fixture.methods.filter(
    (method) => method === "tools/call" || method.startsWith("tasks/"),
  );
}

describe("2025-11-25: a task parked on input_required", () => {
  it("gets one tasks/result after the polls, and the run does not hang on it", async () => {
    const fixture = await serveParkedTask({ onResult: "hold" });
    const startedAt = Date.now();
    const result = await run(fixture);

    expect(taskWire(fixture)).toEqual([
      "tools/call",
      "tasks/get",
      "tasks/get",
      "tasks/get",
      "tasks/result",
    ]);
    // Bounded by the 400 ms poll budget, not by the 10 s request timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    // The verdicts are what they were: the task is still parked.
    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
    const inline = check(result, "tasks-inline-result");
    expect([inline.status, inline.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(inline.error?.message).toContain("last status: input_required");
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      outcome: "no-answer",
    });
  });

  it("tells the server it stopped waiting", async () => {
    // The call is cut by the client's time limit. A client that gives up on a
    // request says so, so the server is not left holding it open.
    const fixture = await serveParkedTask({ onResult: "hold" });
    await run(fixture);

    // The notification is sent as the call is abandoned, so it can land just
    // after the run returns.
    await vi.waitFor(
      () => expect(fixture.methods).toContain("notifications/cancelled"),
      { timeout: 2_000 },
    );
    expect(
      fixture.methods.filter((method) => method === "tasks/result"),
    ).toHaveLength(1);
  });

  it("grades the finished task when tasks/result returns", async () => {
    const fixture = await serveParkedTask({ onResult: "complete" });
    const result = await run(fixture);

    const wire = taskWire(fixture);
    // Three polls see it parked, then the call, then the task is read again.
    expect(wire.slice(0, 6)).toEqual([
      "tools/call",
      "tasks/get",
      "tasks/get",
      "tasks/get",
      "tasks/result",
      "tasks/get",
    ]);
    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
    const inline = check(result, "tasks-inline-result");
    expect([inline.status, inline.details?.status]).toEqual([
      "passed",
      "completed",
    ]);
  });

  it("stays parked when the server refuses the call", async () => {
    const fixture = await serveParkedTask({ onResult: "refuse" });
    const result = await run(fixture);

    expect(
      fixture.methods.filter((method) => method === "tasks/result"),
    ).toHaveLength(1);
    const inline = check(result, "tasks-inline-result");
    expect([inline.status, inline.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      outcome: "error",
      code: -32602,
    });
  });
});

describe("tasks that are not parked on the 2025-11-25 wire", () => {
  it("sends no early tasks/result for a task that finishes on its own", async () => {
    const fixture = await serveParkedTask({ onResult: "hold", neverParks: true });
    const result = await run(fixture);

    // The only tasks/result is the one tasks-inline-result has always made
    // for a finished task.
    expect(taskWire(fixture)).toEqual([
      "tools/call",
      "tasks/get",
      "tasks/result",
    ]);
    expect(check(result, "tasks-inline-result").status).toBe("passed");
  });

  it("sends no tasks/result on the extension wire", async () => {
    const fixture = await serveExtensionTasksFixture({
      tools: { [TASK_TOOL_NAME]: taskTool(defaultTaskPhases()) },
    });
    opened.push(fixture);
    await new MCPTasksConformanceTest({
      url: fixture.url,
      mcpProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      timeout: 10_000,
      toolName: TASK_TOOL_NAME,
      pollTimeoutMs: 400,
      checkIds: ["tasks-ttl-shape", "tasks-update-ack-shape"],
    } as never).run();

    // The task parks on input_required here too (no answers are configured),
    // and this wire answers with tasks/update, never tasks/result.
    expect(
      fixture.received.some((request) => request.method === "tasks/get"),
    ).toBe(true);
    expect(
      fixture.received.filter((request) => request.method === "tasks/result"),
    ).toEqual([]);
  });
});
