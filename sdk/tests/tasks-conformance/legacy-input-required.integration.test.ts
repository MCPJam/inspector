/**
 * On 2025-11-25, a task parked on `input_required` gets a `tasks/result`, and
 * the client answers what the server asks over it.
 *
 * "When the requestor encounters the `input_required` status, it SHOULD
 * preemptively call `tasks/result`" (2025-11-25 tasks.mdx:449). On that wire
 * the call is how the server delivers its input requests: it holds the
 * response open, sends `elicitation/create` on its stream, and answers once
 * the task has ended. The suite used to read the task three more times and
 * stop.
 *
 * Driven end to end against a raw 2025-11-25 server over a real socket. The
 * shared legacy fixture does not model `input_required`, so this file has its
 * own. Every request and every answer is recorded, so the assertions are on
 * the wire.
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

const TOOL = "book_flight";
const TASK_ID = "parked-task-1";
const RELATED_TASK = "io.modelcontextprotocol/related-task";

type ResultMode =
  /** Keep the response open and never answer. */
  | "hold"
  /** End the task as completed and return its result. */
  | "complete"
  /** Refuse the call and leave the task parked (not what the spec asks). */
  | "refuse"
  /** Refuse it with -32001, the number a client timeout is often given. */
  | "refuse-32001"
  /** Send the questions on the held stream, then end the task. */
  | "ask";

interface Question {
  message: string;
  /** The one property the form asks for, and the values it takes. */
  property: string;
  values: string[];
}

const SEAT: Question = {
  message: "Window or aisle?",
  property: "seat",
  values: ["window", "aisle"],
};
const MEAL: Question = {
  message: "Which meal?",
  property: "meal",
  values: ["vegetarian", "standard"],
};

/** What the client sent back for one of the server's requests. */
interface ClientAnswer {
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Fixture {
  url: string;
  /** JSON-RPC methods in arrival order, notifications included. */
  methods: string[];
  /** The client's answers to the server's requests, in arrival order. */
  answers: ClientAnswer[];
  /** `capabilities` from the client's `initialize`. */
  clientCapabilities: () => Record<string, unknown> | undefined;
  /** Held `tasks/result` responses the CLIENT closed. */
  heldClosedByClient: () => number;
  /** When the tool call arrived. */
  taskStartedAt: () => number;
  close: () => Promise<void>;
}

async function serveParkedTask(options: {
  onResult: ResultMode;
  /** Start finished instead of parked. */
  neverParks?: boolean;
  /** With `neverParks`: how the task has finished. */
  neverParksAs?: "completed" | "failed";
  /** `pollInterval` on every task read. */
  pollInterval?: number;
  /** `pollInterval` on reads while the task is parked, when it differs. */
  parkedPollInterval?: unknown;
  /** For `ask`: fail the task even after an answer that fits. */
  failAfterAnswer?: boolean;
  /** `tasks/result` is not implemented: every call gets -32601. */
  resultMethodNotFound?: boolean;
  /** For `ask`: what the server needs, in order. */
  questions?: Question[];
  /** For `ask`: how long the task works after the last answer. */
  finishAfterMs?: number;
  /** `tasks/get` fails once `tasks/result` has been answered. */
  failGetAfterResult?: boolean;
  /** `ttl` on every task read. Absent ⇒ 60 s. `null` is "unlimited". */
  ttl?: unknown;
}): Promise<Fixture> {
  const methods: string[] = [];
  const answers: ClientAnswer[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let clientCapabilities: Record<string, unknown> | undefined;
  let heldClosedByClient = 0;
  let closing = false;
  let taskStartedAt = 0;
  let resultAnswered = false;
  let status = options.neverParks
    ? (options.neverParksAs ?? "completed")
    : "input_required";
  /** The open `tasks/result`, when the server is holding one. */
  let held: { res: http.ServerResponse; id: unknown } | undefined;
  const questions = [...(options.questions ?? [SEAT])];
  let asked = 0;

  const task = () => ({
    taskId: TASK_ID,
    status,
    createdAt: "2026-07-27T00:00:00Z",
    lastUpdatedAt: "2026-07-27T00:00:00Z",
    ttl: "ttl" in options ? options.ttl : 60_000,
    pollInterval:
      status === "input_required" && "parkedPollInterval" in options
        ? options.parkedPollInterval
        : (options.pollInterval ?? 5),
  });
  const related = { [RELATED_TASK]: { taskId: TASK_ID } };
  const finalResult = {
    content: [{ type: "text", text: "Flight booked." }],
    _meta: related,
  };
  const TASK_FAILED = { code: -32603, message: "The flight was not booked" };

  const sendOnHeld = (message: Record<string, unknown>, end = false) => {
    if (!held || held.res.writableEnded) return;
    held.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    if (end) {
      held.res.end();
      held = undefined;
    }
  };
  const ask = () => {
    const question = questions[asked];
    asked += 1;
    sendOnHeld({
      jsonrpc: "2.0",
      id: `ask-${asked}`,
      method: "elicitation/create",
      params: {
        mode: "form",
        message: question.message,
        requestedSchema: {
          type: "object",
          properties: {
            [question.property]: { type: "string", enum: question.values },
          },
          required: [question.property],
        },
        _meta: related,
      },
    });
  };
  /** End the task and answer the held `tasks/result`, as the spec asks. */
  const endTask = (ended: "completed" | "failed") => {
    status = ended;
    if (!held) return;
    resultAnswered = true;
    sendOnHeld(
      ended === "completed"
        ? { jsonrpc: "2.0", id: held.id, result: finalResult }
        : { jsonrpc: "2.0", id: held.id, error: TASK_FAILED },
      true,
    );
  };
  const onAnswer = (answer: ClientAnswer) => {
    answers.push(answer);
    const question = questions[asked - 1];
    const content = answer.result?.content as
      | Record<string, unknown>
      | undefined;
    const fits =
      answer.result?.action === "accept" &&
      question.values.includes(String(content?.[question.property]));
    if (!fits || options.failAfterAnswer) return endTask("failed");
    if (asked < questions.length) return ask();
    status = "working";
    const timer = setTimeout(
      () => endTask("completed"),
      options.finishAfterMs ?? 0,
    );
    timers.add(timer);
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
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      };
      // A JSON-RPC response: the client answering one of the server's requests.
      if (message.method === undefined) {
        res.writeHead(202).end();
        onAnswer({
          id: message.id,
          ...(message.result ? { result: message.result } : {}),
          ...(message.error ? { error: message.error } : {}),
        });
        return;
      }
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
          clientCapabilities = message.params?.capabilities as
            | Record<string, unknown>
            | undefined;
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
          taskStartedAt = Date.now();
          reply({
            result: {
              task: {
                ...task(),
                status: "working",
                pollInterval: options.pollInterval ?? 5,
              },
            },
          });
          return;
        case "tasks/get":
          if (options.failGetAfterResult && resultAnswered) {
            reply({ error: { code: -32603, message: "The task store is down" } });
            return;
          }
          reply({ result: task() });
          return;
        case "tasks/result":
          if (options.resultMethodNotFound) {
            reply({ error: { code: -32601, message: "Method not found" } });
          } else if (status === "completed") {
            reply({ result: finalResult });
          } else if (status === "failed") {
            reply({ error: TASK_FAILED });
          } else if (options.onResult === "complete") {
            status = "completed";
            resultAnswered = true;
            reply({ result: finalResult });
          } else if (options.onResult === "refuse") {
            resultAnswered = true;
            reply({
              error: { code: -32602, message: "The task is not finished" },
            });
          } else if (options.onResult === "refuse-32001") {
            resultAnswered = true;
            reply({ error: { code: -32001, message: "Request timed out" } });
          } else {
            // Held open: this is what a server waiting for an answer does.
            held = { res, id: message.id };
            res.on("close", () => {
              if (!closing && !res.writableEnded) heldClosedByClient += 1;
            });
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "mcp-protocol-version": "2025-11-25",
            });
            res.flushHeaders();
            if (options.onResult === "ask" && status === "input_required") ask();
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
    answers,
    clientCapabilities: () => clientCapabilities,
    heldClosedByClient: () => heldClosedByClient,
    taskStartedAt: () => taskStartedAt,
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        for (const timer of timers) clearTimeout(timer);
        held?.res.destroy();
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

/** `[status, skipReason]`, the two fields that make a verdict. */
function verdict(result: MCPTasksConformanceResult, id: MCPTasksCheckId) {
  const found = check(result, id);
  return [found.status, found.skipReason];
}

const COULD_NOT_RUN = ["skipped", "could-not-run"];

/** The task traffic only, in order. */
function taskWire(fixture: Fixture): string[] {
  return fixture.methods.filter(
    (method) => method === "tools/call" || method.startsWith("tasks/"),
  );
}

function resultCalls(fixture: Fixture): number {
  return fixture.methods.filter((method) => method === "tasks/result").length;
}

const accept = (content: Record<string, unknown>) => ({
  action: "accept",
  content,
});

describe("2025-11-25, no answers configured: a task parked on input_required", () => {
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
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
    expect(inline.error?.message).toContain("last status: input_required");
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      outcome: "no-answer",
    });
  });

  it("does not claim it can answer: no elicitation capability is declared", async () => {
    const fixture = await serveParkedTask({ onResult: "hold" });
    await run(fixture);

    expect(fixture.clientCapabilities()).toBeDefined();
    expect(fixture.clientCapabilities()).not.toHaveProperty("elicitation");
  });

  it("does not leave the held call open after the run", async () => {
    const fixture = await serveParkedTask({ onResult: "hold" });
    await run(fixture);

    // On 2025-11-25 the SDK does not close a timed-out request's stream; the
    // run's teardown does. So this pins that the run lets go of the call by
    // the time it ends, not that the time limit itself closes it.
    await vi.waitFor(() => expect(fixture.heldClosedByClient()).toBe(1), {
      timeout: 2_000,
    });
    expect(resultCalls(fixture)).toBe(1);
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
    // The report shows the call that came before the task ended.
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      outcome: "returned",
    });
  });

  it("stays parked when the server refuses the call, and does not call again", async () => {
    const fixture = await serveParkedTask({ onResult: "refuse" });
    const result = await run(fixture, { pollTimeoutMs: 1_000 });

    expect(resultCalls(fixture)).toBe(1);
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
    expect(
      check(result, "tasks-inline-result").details?.resultWhileInputRequired,
    ).toMatchObject({ outcome: "error", code: -32602 });
  });

  it("reads a -32001 the server sent as the server's answer", async () => {
    // The client's own timeout is not a number (`REQUEST_TIMEOUT`), so any
    // number came from the server, this one included.
    const fixture = await serveParkedTask({ onResult: "refuse-32001" });
    const result = await run(fixture, { pollTimeoutMs: 1_000 });

    expect(
      check(result, "tasks-inline-result").details?.resultWhileInputRequired,
    ).toMatchObject({ outcome: "error", code: -32001 });
  });

  it("does not fail the server for a task that failed because nobody answered", async () => {
    // The server asks although the client declared no elicitation. The client
    // has no answer to give, the SDK says Method not found, and the server
    // fails the task. That is this run's doing, not a result to grade.
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, { pollTimeoutMs: 1_500 });

    expect(fixture.answers).toHaveLength(1);
    expect(fixture.answers[0].error?.code).toBe(-32601);

    const inline = check(result, "tasks-inline-result");
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
    expect(inline.error?.message).toMatch(/asked for input/);
    // The report shows our call came first, and what the server said to it.
    expect(inline.details).toMatchObject({
      status: "failed",
      resultWhileInputRequired: { outcome: "error", code: -32603 },
    });
  });
});

describe("2025-11-25: one time limit for the polls, the call and the reads after it", () => {
  it("takes the wait on a held call out of the poll budget", async () => {
    // Parked after three reads 400 ms apart, so about 800 ms in. The call may
    // then wait for what is left of the 2 s, not for a fresh 2 s.
    const fixture = await serveParkedTask({ onResult: "hold", pollInterval: 400 });
    await run(fixture, { pollTimeoutMs: 2_000 });

    expect(Date.now() - fixture.taskStartedAt()).toBeLessThan(2_500);
  });

  it("does not start a new poll budget after the server answers the call", async () => {
    // Parked about 1.6 s in. Reading the task again after the refusal must
    // end with the same 2 s, not run three more reads on a new 2 s.
    const fixture = await serveParkedTask({
      onResult: "refuse",
      pollInterval: 800,
    });
    await run(fixture, { pollTimeoutMs: 2_000 });

    expect(Date.now() - fixture.taskStartedAt()).toBeLessThan(2_600);
  });

  it("reports the error when the task cannot be read after the call", async () => {
    const fixture = await serveParkedTask({
      onResult: "complete",
      failGetAfterResult: true,
    });
    const result = await run(fixture, { pollTimeoutMs: 1_000 });

    const inline = check(result, "tasks-inline-result");
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
    // The real error, not advice to wait longer.
    expect(inline.error?.message).toContain("The task store is down");
    expect(inline.error?.message).not.toContain("raise --poll-timeout");
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      outcome: "returned",
    });
  });
});

describe("2025-11-25, answers configured: the client answers over tasks/result", () => {
  const SEAT_ANSWER = { seat: accept({ seat: "aisle" }) };

  it("declares elicitation, answers the question, and the task completes", async () => {
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, {
      pollTimeoutMs: 3_000,
      inputResponses: SEAT_ANSWER,
    });

    // A client that will answer says so in initialize.
    expect(fixture.clientCapabilities()).toHaveProperty("elicitation");

    // "aisle", not Method not found.
    expect(fixture.answers).toHaveLength(1);
    expect(fixture.answers[0]).toMatchObject({
      id: "ask-1",
      result: { action: "accept", content: { seat: "aisle" } },
    });
    // "All requests, notifications, and responses related to a task MUST
    // include the related-task key" (tasks.mdx:470).
    expect(fixture.answers[0].result?._meta).toEqual({
      [RELATED_TASK]: { taskId: TASK_ID },
    });

    const inline = check(result, "tasks-inline-result");
    expect([inline.status, inline.details?.status]).toEqual([
      "passed",
      "completed",
    ]);
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      outcome: "returned",
      answered: [{ message: "Window or aisle?", key: "seat", action: "accept" }],
    });
    // The call that received the question also brought the final result, so
    // tasks-inline-result grades that one instead of asking again.
    expect(resultCalls(fixture)).toBe(1);
  });

  it("declares elicitation even when the run sends an exact capability set", async () => {
    // Every Inspector run sends `clientCapabilities`, which is advertised as
    // written. Without elicitation in it, the answers would never be asked for.
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, {
      pollTimeoutMs: 3_000,
      inputResponses: SEAT_ANSWER,
      clientCapabilities: { extensions: {} },
    });

    expect(fixture.clientCapabilities()).toHaveProperty("elicitation");
    expect(fixture.answers[0]).toMatchObject({
      result: { action: "accept", content: { seat: "aisle" } },
    });
    expect(check(result, "tasks-inline-result").status).toBe("passed");
  });

  it("reads the finished task even when it ends close to the deadline", async () => {
    // Parked after three reads 400 ms apart. The task ends about 450 ms into
    // the call, leaving less than one poll interval of the 1.5 s budget. The
    // task must be read at once, not after that interval, which would run
    // past the deadline and report the parked frame from before the call.
    const fixture = await serveParkedTask({
      onResult: "ask",
      pollInterval: 400,
      finishAfterMs: 450,
    });
    const result = await run(fixture, {
      pollTimeoutMs: 1_500,
      inputResponses: SEAT_ANSWER,
    });

    const inline = check(result, "tasks-inline-result");
    expect([inline.status, inline.details?.status]).toEqual([
      "passed",
      "completed",
    ]);
  });

  it("grades a task that failed after every answer fit, as the spec reads it", async () => {
    // The server got what it asked for and failed the task anyway, then
    // returned the task's JSON-RPC error from tasks/result as it MUST
    // (tasks.mdx:464). That is not setup to fix, and it is not a fault.
    const fixture = await serveParkedTask({
      onResult: "ask",
      failAfterAnswer: true,
    });
    const result = await run(fixture, {
      pollTimeoutMs: 1_500,
      inputResponses: SEAT_ANSWER,
    });

    const inline = check(result, "tasks-inline-result");
    expect(inline.status).toBe("passed");
    expect(inline.details).toMatchObject({ status: "failed", errorCode: -32603 });
    expect(inline.details).not.toHaveProperty("missingInput");
    // The held call already brought that final error: it is not asked again,
    // so a second request cannot lose it.
    expect(resultCalls(fixture)).toBe(1);
  });

  it("still grades the parked frames when polling goes on after the answer", async () => {
    // The parked frames carry a bad pollInterval and the finished one a good
    // one. tasks-ttl-shape grades every frame, so the bad ones still count.
    const fixture = await serveParkedTask({
      onResult: "ask",
      parkedPollInterval: "soon",
    });
    const result = await run(fixture, {
      pollTimeoutMs: 3_000,
      inputResponses: SEAT_ANSWER,
    });

    expect(check(result, "tasks-inline-result").status).toBe("passed");
    expect(check(result, "tasks-ttl-shape").status).toBe("failed");
  });

  it("makes the call but sends no answers in a group that does not grade the result", async () => {
    // Only tasks-inline-result reads what the call brings. Answering here
    // would drive a real task to its side effect for nothing, so this group
    // does not say it can answer. It still calls `tasks/result` once, as a
    // requestor SHOULD when a task asks for input (tasks.mdx:449).
    const fixture = await serveParkedTask({ onResult: "hold" });
    const result = await run(fixture, {
      pollTimeoutMs: 1_000,
      inputResponses: SEAT_ANSWER,
      checkIds: ["tasks-ttl-shape"],
    });

    expect(resultCalls(fixture)).toBe(1);
    expect(fixture.answers).toEqual([]);
    expect(fixture.clientCapabilities()).not.toHaveProperty("elicitation");
    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
  });

  it("does not finish a real task in a group that does not answer, when the server asks anyway", async () => {
    // The server asks although nothing declared elicitation. This group
    // answers nothing, so the SDK says Method not found and the fixture fails
    // the task: ended, never driven to its side effect. TTL Shape still
    // grades what it read.
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, {
      pollTimeoutMs: 1_500,
      checkIds: ["tasks-ttl-shape"],
    });

    expect(resultCalls(fixture)).toBe(1);
    expect(fixture.answers).toHaveLength(1);
    expect(fixture.answers[0].error?.code).toBe(-32601);
    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
  });

  it("makes the call when a declared elicitation is not sent, because nothing answers it", async () => {
    // An Inspector host profile can declare elicitation while setup has no
    // answers. The manager leaves it out of initialize when nothing answers
    // it, so a server cannot ask, and the call is safe.
    const fixture = await serveParkedTask({ onResult: "hold" });
    const result = await run(fixture, {
      pollTimeoutMs: 1_000,
      clientCapabilities: { elicitation: {} },
    });

    expect(fixture.clientCapabilities()).not.toHaveProperty("elicitation");
    expect(resultCalls(fixture)).toBe(1);
    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
  });

  it("makes no call when the run advertises roots and has nothing to answer with", async () => {
    // `roots` is advertised as written. A server may ask `roots/list` over
    // the call, be refused, and end the task, so a run without answers does
    // not make the call.
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, {
      pollTimeoutMs: 1_000,
      clientCapabilities: { roots: {} },
    });

    expect(fixture.clientCapabilities()).toHaveProperty("roots");
    expect(resultCalls(fixture)).toBe(0);
    expect(fixture.answers).toEqual([]);
    expect(check(result, "tasks-ttl-shape").status).toBe("passed");
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
  });

  it("still answers over the call when the host also advertises roots", async () => {
    // Several seed host templates declare roots. With answers in setup the
    // call is how they reach the server, as before this change.
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, {
      pollTimeoutMs: 3_000,
      inputResponses: SEAT_ANSWER,
      clientCapabilities: { roots: {} },
    });

    expect(resultCalls(fixture)).toBe(1);
    expect(fixture.answers[0]).toMatchObject({
      result: { action: "accept", content: { seat: "aisle" } },
    });
    expect(check(result, "tasks-inline-result").status).toBe("passed");
  });

  it("answers two questions on one held call, each with the answer that fits it", async () => {
    const fixture = await serveParkedTask({
      onResult: "ask",
      questions: [SEAT, MEAL],
    });
    // Written in the other order: the legacy wire has no keys to match on, so
    // the answer is chosen by the form it fits.
    const result = await run(fixture, {
      pollTimeoutMs: 3_000,
      inputResponses: {
        meal: accept({ meal: "vegetarian" }),
        seat: accept({ seat: "window" }),
      },
    });

    expect(fixture.answers.map((answer) => answer.result?.content)).toEqual([
      { seat: "window" },
      { meal: "vegetarian" },
    ]);
    expect(check(result, "tasks-inline-result").status).toBe("passed");
  });

  it("goes on polling when the task takes a while after the answer", async () => {
    const fixture = await serveParkedTask({
      onResult: "ask",
      finishAfterMs: 300,
    });
    const result = await run(fixture, {
      pollTimeoutMs: 3_000,
      inputResponses: SEAT_ANSWER,
    });

    expect(check(result, "tasks-inline-result").status).toBe("passed");
  });

  it("treats a task that failed on a configured answer as setup to fix, not a server fault", async () => {
    const fixture = await serveParkedTask({ onResult: "ask" });
    const result = await run(fixture, {
      pollTimeoutMs: 1_500,
      // Not one of the form's values: the server fails the task.
      inputResponses: { seat: accept({ seat: "roof" }) },
    });

    const inline = check(result, "tasks-inline-result");
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
    expect(inline.error?.message).toMatch(/answers/i);
    expect(inline.details).toMatchObject({
      status: "failed",
      missingInput: "tasksProbe",
    });
  });

  it("says so when the task asks for more than was configured", async () => {
    const fixture = await serveParkedTask({
      onResult: "ask",
      questions: [SEAT, MEAL],
    });
    const result = await run(fixture, {
      pollTimeoutMs: 1_500,
      inputResponses: SEAT_ANSWER,
    });

    // The second question has no answer left: the client says it has none.
    expect(fixture.answers).toHaveLength(2);
    expect(fixture.answers[1].result?.action).toBe("cancel");

    const inline = check(result, "tasks-inline-result");
    expect(verdict(result, "tasks-inline-result")).toEqual(COULD_NOT_RUN);
    expect(inline.details?.resultWhileInputRequired).toMatchObject({
      answered: [
        { message: "Window or aisle?", action: "accept" },
        { message: "Which meal?", action: "cancel" },
      ],
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
    const inline = check(result, "tasks-inline-result");
    expect(inline.status).toBe("passed");
    expect(inline.details).not.toHaveProperty("resultWhileInputRequired");
  });

  it("passes a task that failed, when tasks/result returns its JSON-RPC error", async () => {
    // "it MUST return the final result of the underlying request, whether
    // that is a successful result or a JSON-RPC error" (tasks.mdx:464). The
    // same rule the extension wire is graded by.
    const fixture = await serveParkedTask({
      onResult: "hold",
      neverParks: true,
      neverParksAs: "failed",
    });
    const result = await run(fixture);

    expect(taskWire(fixture)).toEqual([
      "tools/call",
      "tasks/get",
      "tasks/result",
    ]);
    const inline = check(result, "tasks-inline-result");
    expect(inline.status).toBe("passed");
    expect(inline.details).toMatchObject({ status: "failed", errorCode: -32603 });
  });

  it("does not pass a failed task when tasks/result is not implemented", async () => {
    // -32601 says the server never ran tasks/result, so it did not return the
    // task's final error.
    const fixture = await serveParkedTask({
      onResult: "hold",
      neverParks: true,
      neverParksAs: "failed",
      resultMethodNotFound: true,
    });
    const result = await run(fixture);

    const inline = check(result, "tasks-inline-result");
    expect(inline.status).toBe("failed");
    expect(inline.error?.message).toContain("legacy tasks/result failed");
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

describe("tasks-ttl-shape on the 2025-11-25 wire", () => {
  // `Task.ttl` is "Actual retention duration from creation in milliseconds,
  // null for unlimited": `ttl: number | null` (2025-11-25 schema.ts:1378).
  it("passes a task whose ttl is null (unlimited)", async () => {
    const fixture = await serveParkedTask({
      onResult: "hold",
      neverParks: true,
      ttl: null,
    });
    const result = await run(fixture, { checkIds: ["tasks-ttl-shape"] });

    const ttl = check(result, "tasks-ttl-shape");
    expect(ttl.status).toBe("passed");
    expect(ttl.error).toBeUndefined();
  });

  it("still fails a ttl of another type", async () => {
    const fixture = await serveParkedTask({
      onResult: "hold",
      neverParks: true,
      ttl: "60000",
    });
    const result = await run(fixture, { checkIds: ["tasks-ttl-shape"] });

    expect(check(result, "tasks-ttl-shape")).toMatchObject({
      status: "failed",
      details: { violations: ["legacy task ttl must be a number or null"] },
    });
  });
});
