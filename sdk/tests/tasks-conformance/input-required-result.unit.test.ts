/**
 * The 2025-11-25 step for a task parked on `input_required`: "When the
 * requestor encounters the `input_required` status, it SHOULD preemptively
 * call `tasks/result`", and the questions the server sends over that call get
 * the answers from setup.
 *
 * These pin the call (one request, bounded, classified by what came back),
 * the answers (which one, once each, never invented), when the run goes on
 * polling, and what it says about a task that ended without a result.
 */

import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  INPUT_REQUIRED_RESULT_WAIT_MS,
  InputRequiredResultLeg,
  TaskInputAnswers,
  answersNeedPin,
  callResultWhileInputRequired,
  describeResultCall,
  inputRequiredResultWaitMs,
  serverConfigForAnswers,
  taskInputAnswersFor,
} from "../../src/tasks-conformance/input-required-result.js";
import { TaskOperations } from "../../src/tasks-conformance/task-operations.js";
import { normalizeMCPTasksConformanceConfig } from "../../src/tasks-conformance/validation.js";

const RELATED_TASK = "io.modelcontextprotocol/related-task";

function rpcError(code: number | string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** What the SDK throws when its own time limit cuts a request. */
const sdkTimeout = () => rpcError("REQUEST_TIMEOUT", "Request timed out");

function fakeManager(getTaskResult: ReturnType<typeof vi.fn>) {
  return { getTaskResult } as unknown as Pick<MCPClientManager, "getTaskResult">;
}

function form(property: string, values: string[], message = `${property}?`) {
  return {
    message,
    requestedSchema: {
      type: "object",
      properties: { [property]: { type: "string", enum: values } },
      required: [property],
    },
  } as never;
}

const accept = (content: Record<string, unknown>) => ({
  action: "accept",
  content,
});

describe("callResultWhileInputRequired", () => {
  it("sends one tasks/result for the task, with the time limit", async () => {
    const getTaskResult = vi.fn().mockResolvedValue({ content: [] });
    const call = await callResultWhileInputRequired({
      manager: fakeManager(getTaskResult),
      serverId: "server",
      taskId: "task-1",
      timeoutMs: 1_234,
    });

    expect(getTaskResult).toHaveBeenCalledTimes(1);
    expect(getTaskResult).toHaveBeenCalledWith("server", "task-1", {
      timeout: 1_234,
    });
    expect(call).toMatchObject({
      outcome: "returned",
      result: { content: [] },
      answered: [],
    });
  });

  it.each([
    ["the task's own failure", -32603],
    ["a refusal", -32602],
    // The number a timeout is often given. The SDK's own timeout is not a
    // number, so this one came from the server.
    ["-32001 sent by the server", -32001],
  ])("reads %s as the server's answer", async (_label, code) => {
    const call = await callResultWhileInputRequired({
      manager: fakeManager(vi.fn().mockRejectedValue(rpcError(code, "no"))),
      serverId: "server",
      taskId: "task-1",
      timeoutMs: 1_000,
    });

    expect(call).toMatchObject({ outcome: "error", code, message: "no" });
  });

  it.each([
    ["the SDK's own timeout", sdkTimeout()],
    ["a dropped connection", new Error("fetch failed")],
  ])("reads %s as no answer", async (_label, error) => {
    const call = await callResultWhileInputRequired({
      manager: fakeManager(vi.fn().mockRejectedValue(error)),
      serverId: "server",
      taskId: "task-1",
      timeoutMs: 1_000,
    });

    expect(call.outcome).toBe("no-answer");
    expect(call).not.toHaveProperty("code");
  });

  it("reports the input requests answered while this call was open, and only those", async () => {
    const answers = new TaskInputAnswers({
      seat: accept({ seat: "aisle" }),
      meal: accept({ meal: "standard" }),
    });
    // Answered before this call: not this call's.
    await answers.handler(form("seat", ["aisle"]));
    const getTaskResult = vi.fn().mockImplementation(async () => {
      await answers.handler(form("meal", ["standard"], "Which meal?"));
      return { content: [] };
    });

    const call = await callResultWhileInputRequired({
      manager: fakeManager(getTaskResult),
      serverId: "server",
      taskId: "task-1",
      timeoutMs: 1_000,
      answers,
    });

    expect(call.answered).toEqual([
      { message: "Which meal?", key: "meal", action: "accept", fits: true },
    ]);
  });
});

describe("inputRequiredResultWaitMs", () => {
  it("is 5 s when more than that is left", () => {
    expect(INPUT_REQUIRED_RESULT_WAIT_MS).toBe(5_000);
    expect(inputRequiredResultWaitMs(30_000)).toBe(5_000);
  });

  it("is what is left of the poll budget when that is less", () => {
    expect(inputRequiredResultWaitMs(300)).toBe(300);
  });

  it("is never negative", () => {
    expect(inputRequiredResultWaitMs(-1)).toBe(0);
  });
});

describe("TaskInputAnswers", () => {
  it("answers with the configured answer that fits the form, whatever the order written", async () => {
    const answers = new TaskInputAnswers({
      meal: accept({ meal: "vegetarian" }),
      seat: accept({ seat: "aisle" }),
    });

    expect(await answers.handler(form("seat", ["window", "aisle"]))).toEqual(
      accept({ seat: "aisle" }),
    );
    expect(await answers.handler(form("meal", ["vegetarian"]))).toEqual(
      accept({ meal: "vegetarian" }),
    );
    expect(answers.log.map((entry) => entry.key)).toEqual(["seat", "meal"]);
  });

  it("falls back to the order written when no answer fits the form", async () => {
    // The answer is still the caller's to send: the server decides what to
    // do with one that does not fit.
    const answers = new TaskInputAnswers({ seat: accept({ seat: "roof" }) });

    expect(await answers.handler(form("seat", ["window", "aisle"]))).toEqual(
      accept({ seat: "roof" }),
    );
    // Recorded as not fitting, so the report can say which answer to fix.
    expect(answers.log).toEqual([
      { message: "seat?", key: "seat", action: "accept", fits: false },
    ]);
  });

  it("does not let an answer for another question fit a form whose fields are optional", async () => {
    // Schema validation alone passes `{ seat }` against an optional `notes`
    // form. Its keys are not the form's, so it is not that form's answer.
    const answers = new TaskInputAnswers({
      seat: accept({ seat: "aisle" }),
      notes: accept({ notes: "none" }),
    });
    const optionalNotes = {
      message: "Any notes?",
      requestedSchema: {
        type: "object",
        properties: { notes: { type: "string" } },
      },
    } as never;

    expect(await answers.handler(optionalNotes)).toEqual(
      accept({ notes: "none" }),
    );
    expect(await answers.handler(form("seat", ["window", "aisle"]))).toEqual(
      accept({ seat: "aisle" }),
    );
  });

  it("says it has no answer to a URL-mode request, and keeps its answers", async () => {
    const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });

    expect(
      await answers.handler({
        mode: "url",
        message: "Sign in on this page",
        url: "https://example.test/consent",
        elicitationId: "e-1",
      } as never),
    ).toEqual({ action: "cancel" });
    expect(answers.log).toEqual([
      { message: "Sign in on this page", action: "cancel", mode: "url" },
    ]);
    // The form that comes next still gets its answer.
    expect(await answers.handler(form("seat", ["aisle"]))).toEqual(
      accept({ seat: "aisle" }),
    );
  });

  it("skips configured answers the client could not send", async () => {
    // No `action`, or content that is not flat: the SDK would refuse to send
    // either, so neither is used up or reported as an answer.
    const answers = new TaskInputAnswers({
      noAction: { content: { seat: "aisle" } },
      nested: accept({ seat: { code: "A" } }),
      seat: accept({ seat: "aisle" }),
    });

    expect(await answers.handler(form("seat", ["window"]))).toEqual(
      accept({ seat: "aisle" }),
    );
    expect(answers.log.map((entry) => entry.key)).toEqual(["seat"]);
  });

  it("sends a configured decline as written", async () => {
    const answers = new TaskInputAnswers({ seat: { action: "decline" } });

    expect(await answers.handler(form("seat", ["aisle"]))).toEqual({
      action: "decline",
    });
    expect(answers.log).toEqual([
      { message: "seat?", key: "seat", action: "decline" },
    ]);
  });

  it("uses each answer once, then says it has none", async () => {
    const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });

    await answers.handler(form("seat", ["aisle"]));
    // Asked again: it does not repeat itself and does not make one up.
    expect(await answers.handler(form("seat", ["aisle"], "Again?"))).toEqual({
      action: "cancel",
    });
    expect(answers.log.at(-1)).toEqual({ message: "Again?", action: "cancel" });
  });

  it("puts the task's related-task key on the answer", async () => {
    const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });
    const related = { [RELATED_TASK]: { taskId: "task-1" } };

    const answer = await answers.handler({
      ...(form("seat", ["aisle"]) as object),
      _meta: related,
    } as never);

    expect(answer).toEqual({ ...accept({ seat: "aisle" }), _meta: related });
  });

  it("ignores a configured answer that is not an object", async () => {
    const answers = new TaskInputAnswers({ seat: "aisle" });

    expect(await answers.handler(form("seat", ["aisle"]))).toEqual({
      action: "cancel",
    });
  });
});

describe("taskInputAnswersFor: when the run declares it will answer", () => {
  const ANSWERS = { seat: accept({ seat: "aisle" }) };
  const config = (
    mcpProtocolVersion: string | undefined,
    inputResponses?: Record<string, unknown>,
  ) =>
    normalizeMCPTasksConformanceConfig({
      url: "https://example.test/mcp",
      ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
      ...(inputResponses ? { inputResponses } : {}),
    } as never);

  it("answers on a run pinned to 2025-11-25 with answers configured", () => {
    const pinned = config("2025-11-25", ANSWERS);

    expect(taskInputAnswersFor(pinned)).toBeInstanceOf(TaskInputAnswers);
    expect(answersNeedPin(pinned)).toBe(false);
  });

  it.each([
    ["no answers", undefined],
    ["an empty set of answers", {}],
    // Declaring elicitation for these would only lead to `cancel` answers.
    ["answers that are not objects", { seat: "aisle" }],
    ["answers with no action", { seat: { content: { seat: "aisle" } } }],
  ])("does not answer with %s", (_label, inputResponses) => {
    const pinned = config("2025-11-25", inputResponses);

    expect(taskInputAnswersFor(pinned)).toBeUndefined();
    expect(answersNeedPin(pinned)).toBe(false);
  });

  it.each([
    ["the extension wire's revision", "2026-07-28"],
    ["no pin", undefined],
  ])("leaves %s as it is, and says the answers were not sent", (_label, pin) => {
    const other = config(pin, ANSWERS);

    expect(taskInputAnswersFor(other)).toBeUndefined();
    expect(answersNeedPin(other)).toBe(true);
  });
});

describe("serverConfigForAnswers: the client says it can answer", () => {
  const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });
  const base = { url: "https://example.test/mcp" } as never;

  it("adds elicitation to an exact capability set that lacks it", () => {
    // An exact set is advertised as written, so without this the server
    // would never be told the client can answer.
    const config = serverConfigForAnswers(
      { ...(base as object), clientCapabilities: { extensions: {} } } as never,
      answers,
    );

    expect(config.clientCapabilities).toEqual({
      extensions: {},
      elicitation: {},
    });
  });

  it("leaves a set that already declares elicitation as it is", () => {
    const declared = {
      ...(base as object),
      clientCapabilities: { elicitation: { form: {} } },
    } as never;

    expect(serverConfigForAnswers(declared, answers)).toBe(declared);
  });

  it("changes nothing for a run that does not answer, or has no exact set", () => {
    const exact = {
      ...(base as object),
      clientCapabilities: { extensions: {} },
    } as never;

    expect(serverConfigForAnswers(exact, undefined)).toBe(exact);
    expect(serverConfigForAnswers(base, answers)).toBe(base);
  });
});

describe("InputRequiredResultLeg: when polling goes on after the call", () => {
  const run = (leg: InputRequiredResultLeg, getTaskResult: ReturnType<typeof vi.fn>) =>
    leg.run(fakeManager(getTaskResult), "server", "task-1", 2_000);

  it("reads the task again at once when the server returned: the task has ended", async () => {
    const leg = new InputRequiredResultLeg();

    expect(await run(leg, vi.fn().mockResolvedValue({ content: [] }))).toBe(
      "reread",
    );
    // The final result is in hand, so tasks-inline-result need not ask again.
    expect(leg.returnedResult()).toEqual({ result: { content: [] } });
  });

  it("reads the task again at once when the server answered with an error", async () => {
    const leg = new InputRequiredResultLeg();

    expect(
      await run(leg, vi.fn().mockRejectedValue(rpcError(-32603, "failed"))),
    ).toBe("reread");
    expect(leg.returnedResult()).toBeUndefined();
    // Kept, so a task that then reads as failed is graded on it.
    expect(leg.returnedError()).toEqual({ code: -32603, message: "failed" });
  });

  it("stops when nothing came back and nothing was answered: the task is parked", async () => {
    const leg = new InputRequiredResultLeg();

    expect(await run(leg, vi.fn().mockRejectedValue(sdkTimeout()))).toBe(false);
  });

  it("goes on when the call timed out but a question was answered during it", async () => {
    const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });
    const leg = new InputRequiredResultLeg(answers);
    const getTaskResult = vi.fn().mockImplementation(async () => {
      await answers.handler(form("seat", ["aisle"]));
      throw sdkTimeout();
    });

    expect(await run(leg, getTaskResult)).toBe("reread");
  });

  it("gives the call what is left of the poll budget, capped at 5 s", async () => {
    const getTaskResult = vi.fn().mockResolvedValue({});
    const manager = fakeManager(getTaskResult);

    await new InputRequiredResultLeg().run(manager, "server", "task-1", 700);
    await new InputRequiredResultLeg().run(manager, "server", "task-1", 20_000);

    expect(getTaskResult.mock.calls.map((call) => call[2])).toEqual([
      { timeout: 700 },
      { timeout: 5_000 },
    ]);
  });

  it("makes no call when the poll budget is already spent", async () => {
    const getTaskResult = vi.fn();
    const leg = new InputRequiredResultLeg();

    expect(await leg.run(fakeManager(getTaskResult), "server", "task-1", 0)).toBe(
      false,
    );
    expect(getTaskResult).not.toHaveBeenCalled();
    expect(leg.details()).toBeUndefined();
  });

  it("does not call again when the last call brought no question", async () => {
    // A server that refuses the call leaves the task parked. Asking again
    // would only repeat the refusal until the budget ran out.
    const leg = new InputRequiredResultLeg();
    const getTaskResult = vi
      .fn()
      .mockRejectedValue(rpcError(-32602, "not finished"));

    expect(await run(leg, getTaskResult)).toBe("reread");
    expect(await run(leg, getTaskResult)).toBe(false);
    expect(getTaskResult).toHaveBeenCalledTimes(1);
  });

  it("calls again when the task asks again after an answer", async () => {
    const answers = new TaskInputAnswers({
      seat: accept({ seat: "aisle" }),
      meal: accept({ meal: "standard" }),
    });
    const leg = new InputRequiredResultLeg(answers);
    const getTaskResult = vi
      .fn()
      .mockImplementationOnce(async () => {
        await answers.handler(form("seat", ["aisle"], "Seat?"));
        throw sdkTimeout();
      })
      .mockImplementationOnce(async () => {
        await answers.handler(form("meal", ["standard"], "Meal?"));
        return {};
      });

    expect(await run(leg, getTaskResult)).toBe("reread");
    expect(await run(leg, getTaskResult)).toBe("reread");
    expect(getTaskResult).toHaveBeenCalledTimes(2);
    // The report carries the last call and every answer.
    expect(leg.details()).toEqual({
      resultWhileInputRequired: {
        outcome: "returned",
        waitedMs: expect.any(Number),
        calls: 2,
        answered: [
          { message: "Seat?", key: "seat", action: "accept", fits: true },
          { message: "Meal?", key: "meal", action: "accept", fits: true },
        ],
      },
    });
  });

  it("reports an answer given outside any call", async () => {
    // A server may ask on the GET stream (tasks.mdx:439). The answer still
    // belongs in the report, though no tasks/result was open.
    const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });
    const leg = new InputRequiredResultLeg(answers);
    await answers.handler(form("seat", ["aisle"], "Seat?"));

    expect(leg.details()).toEqual({
      resultWhileInputRequired: {
        answered: [
          { message: "Seat?", key: "seat", action: "accept", fits: true },
        ],
      },
    });
    expect(leg.couldNotAnswer()).toBe(false);
  });
});

describe("InputRequiredResultLeg: what the report says", () => {
  it("has nothing to say when no call was made", () => {
    expect(new InputRequiredResultLeg().details()).toBeUndefined();
  });

  it("reports each outcome without inventing fields", () => {
    expect(
      describeResultCall({
        outcome: "returned",
        result: { content: [] },
        waitedMs: 12,
        answered: [],
      }),
    ).toEqual({ outcome: "returned", waitedMs: 12 });
    expect(
      describeResultCall({
        outcome: "error",
        code: -32603,
        message: "failed",
        waitedMs: 20,
        answered: [],
      }),
    ).toEqual({
      outcome: "error",
      code: -32603,
      message: "failed",
      waitedMs: 20,
    });
    expect(
      describeResultCall({
        outcome: "no-answer",
        message: "Request timed out",
        waitedMs: 5_000,
        answered: [],
      }),
    ).toEqual({
      outcome: "no-answer",
      message: "Request timed out",
      waitedMs: 5_000,
    });
  });

  it("says the answers were not sent on a run that is not pinned", async () => {
    const leg = new InputRequiredResultLeg(undefined, true);
    await leg.run(
      fakeManager(vi.fn().mockRejectedValue(sdkTimeout())),
      "server",
      "task-1",
      100,
    );

    expect(leg.details()?.resultWhileInputRequired).toMatchObject({
      answersNotSent: expect.stringContaining("pinned to 2025-11-25"),
    });
    expect(leg.unfinishedReason("failed").message).toContain(
      "pinned to 2025-11-25",
    );
  });

  describe("a task that asked for input and ended without completing", () => {
    it("is the run's doing when it had no answer to give", async () => {
      const leg = new InputRequiredResultLeg();
      await leg.run(
        fakeManager(vi.fn().mockRejectedValue(rpcError(-32603, "failed"))),
        "server",
        "task-1",
        100,
      );

      expect(leg.unfinishedReason("failed")).toEqual({
        message:
          "The task asked for input, this run had no answer to give, and it ended as failed, so there was no result to check.",
        setup: false,
      });
    });

    it("names the answer in setup that does not fit", async () => {
      const answers = new TaskInputAnswers({ seat: accept({ seat: "roof" }) });
      const leg = new InputRequiredResultLeg(answers);
      await leg.run(
        fakeManager(
          vi.fn().mockImplementation(async () => {
            await answers.handler(form("seat", ["aisle"]));
            throw rpcError(-32603, "failed");
          }),
        ),
        "server",
        "task-1",
        100,
      );

      expect(leg.couldNotAnswer()).toBe(true);
      const reason = leg.unfinishedReason("failed");
      expect(reason.setup).toBe(true);
      expect(reason.message).toContain('"seat"');
      expect(reason.message).toContain("doesn't fit what the task asked");
    });

    it("is not the run's doing when every answer fit", async () => {
      // The server got what it asked for and still failed the task: that is
      // graded like any finished task, not excused as setup.
      const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });
      const leg = new InputRequiredResultLeg(answers);
      await leg.run(
        fakeManager(
          vi.fn().mockImplementation(async () => {
            await answers.handler(form("seat", ["aisle"]));
            throw rpcError(-32603, "failed");
          }),
        ),
        "server",
        "task-1",
        100,
      );

      expect(leg.couldNotAnswer()).toBe(false);
    });

    it("is the run's doing when it was asked for a URL-mode action", async () => {
      const answers = new TaskInputAnswers({ seat: accept({ seat: "aisle" }) });
      const leg = new InputRequiredResultLeg(answers);
      await answers.handler({ mode: "url", message: "Sign in" } as never);

      expect(leg.couldNotAnswer()).toBe(true);
      expect(leg.unfinishedReason("failed")).toMatchObject({
        message: expect.stringContaining("URL mode"),
        setup: false,
      });
    });

    it("says an answer is missing when the task asked for more than was configured", async () => {
      const answers = new TaskInputAnswers({});
      const leg = new InputRequiredResultLeg(answers);
      await leg.run(
        fakeManager(
          vi.fn().mockImplementation(async () => {
            await answers.handler(form("meal", ["standard"]));
            throw rpcError(-32603, "failed");
          }),
        ),
        "server",
        "task-1",
        100,
      );

      const reason = leg.unfinishedReason("cancelled");
      expect(reason.setup).toBe(true);
      expect(reason.message).toContain("more input than the answers in setup");
      expect(reason.message).toContain("ended as cancelled");
    });
  });
});

describe("TaskOperations.pollToTerminal: one budget for the whole step", () => {
  it("tells the parked callback how much of the poll budget is left", async () => {
    const getTask = vi.fn().mockResolvedValue({
      taskId: "task-1",
      status: "input_required",
      pollInterval: 50,
    });
    const operations = new TaskOperations(
      normalizeMCPTasksConformanceConfig({
        url: "https://example.test/mcp",
        pollTimeoutMs: 2_000,
      }),
    );
    const continueAfterInput = vi.fn().mockResolvedValue(false);

    await operations.pollToTerminal(
      { getTask } as unknown as MCPClientManager,
      "server",
      "legacy",
      "task-1",
      { stopOnInputRequired: true, continueAfterInput },
    );

    // Three reads 50 ms apart came out of the 2 s first.
    const [, remainingMs] = continueAfterInput.mock.calls[0]!;
    expect(remainingMs).toBeGreaterThan(1_500);
    expect(remainingMs).toBeLessThan(2_000);
  });

  it("reads again at once after the callback says the task moved", async () => {
    // The last parked read asks for a 60 s wait. A task that ended during
    // the callback must be read now, not after that wait (which would run
    // past the 2 s deadline and report the stale parked frame).
    const parked = (pollInterval: number) => ({
      taskId: "task-1",
      status: "input_required",
      pollInterval,
    });
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(parked(1))
      .mockResolvedValueOnce(parked(1))
      .mockResolvedValueOnce(parked(60_000))
      .mockResolvedValue({ taskId: "task-1", status: "completed" });
    const operations = new TaskOperations(
      normalizeMCPTasksConformanceConfig({
        url: "https://example.test/mcp",
        pollTimeoutMs: 2_000,
      }),
    );
    const startedAt = Date.now();

    const polled = await operations.pollToTerminal(
      { getTask } as unknown as MCPClientManager,
      "server",
      "legacy",
      "task-1",
      {
        stopOnInputRequired: true,
        continueAfterInput: vi.fn().mockResolvedValue("reread"),
      },
    );

    expect(polled.task?.status).toBe("completed");
    expect(getTask).toHaveBeenCalledTimes(4);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("after a re-read that is still parked, asks the callback again without three more reads", async () => {
    const getTask = vi.fn().mockResolvedValue({
      taskId: "task-1",
      status: "input_required",
      pollInterval: 1,
    });
    const operations = new TaskOperations(
      normalizeMCPTasksConformanceConfig({
        url: "https://example.test/mcp",
        pollTimeoutMs: 2_000,
      }),
    );
    const continueAfterInput = vi
      .fn()
      .mockResolvedValueOnce("reread")
      .mockResolvedValue(false);

    const polled = await operations.pollToTerminal(
      { getTask } as unknown as MCPClientManager,
      "server",
      "legacy",
      "task-1",
      { stopOnInputRequired: true, continueAfterInput },
    );

    expect(polled.inputRequired).toBe(true);
    // Three reads to see it parked, one more after the callback.
    expect(getTask).toHaveBeenCalledTimes(4);
    expect(continueAfterInput).toHaveBeenCalledTimes(2);
  });
});
