/**
 * The `getToolsForAiSdk` task seam, against real fixture servers.
 *
 * The headline invariant is BYTE-IDENTITY: a tool set built without the
 * `tasks` option must put exactly `{name, arguments}` on the wire — no `_meta`,
 * no declaration, nothing. Everything else in this file is downstream of that
 * one guarantee, because it is what makes the option safe to add to a shared
 * code path that every existing chat turn already runs through.
 */

import { afterEach, describe, expect, it } from "vitest";

import { MCPClientManager } from "../src/mcp-client-manager/MCPClientManager.js";
import {
  toolTaskSeamOptionsFor,
  TASK_SEAM_META_KEY,
  type ToolTaskSeamMeta,
} from "../src/mcp-client-manager/tool-task-seam.js";
import type { TaskCreatedEvent } from "../src/mcp-client-manager/task-created-event.js";
import {
  EXTENSION_PROTOCOL_VERSION,
  SYNC_TOOL_NAME,
  TASK_TOOL_NAME,
  declaresTasksExtension,
  failedTaskPhases,
  isErrorCompletedPhases,
  serveExtensionTasksFixture,
  taskTool,
  type ServedExtensionTasksFixture,
} from "./support/extension-tasks-fixture.js";

const SERVER_ID = "ext";

/**
 * Works, then completes. Deliberately NOT `defaultTaskPhases()`, whose
 * `input_required` round is unanswerable without an input handler and so
 * correctly ends the drive at `input-required` rather than `completed`.
 */
function completingPhases() {
  return [
    { status: "working" as const, pollIntervalMs: 10 },
    {
      status: "completed" as const,
      statusMessage: "Done.",
      result: { content: [{ type: "text", text: "task output" }] },
    },
  ];
}

const opened: {
  managers: MCPClientManager[];
  fixtures: ServedExtensionTasksFixture[];
} = { managers: [], fixtures: [] };

afterEach(async () => {
  for (const manager of opened.managers.splice(0)) {
    await manager.disconnectAllServers().catch(() => {});
  }
  for (const fixture of opened.fixtures.splice(0)) {
    await fixture.close().catch(() => {});
  }
});

async function serve(
  options: Parameters<typeof serveExtensionTasksFixture>[0] = {}
): Promise<ServedExtensionTasksFixture> {
  const fixture = await serveExtensionTasksFixture(options);
  opened.fixtures.push(fixture);
  return fixture;
}

async function connect(
  url: string,
  serverId = SERVER_ID,
  protocolVersion: string = EXTENSION_PROTOCOL_VERSION
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  await manager.connectToServer(serverId, {
    url,
    mcpProtocolVersion: protocolVersion,
    timeout: 10_000,
  });
  return manager;
}

/** Collects fan-out events and hands back the seam options that feed them. */
function collectingSeam(
  overrides: Partial<Parameters<typeof toolTaskSeamOptionsFor>[1]> = {},
  mode: "expose" | "await" = "expose"
) {
  const events: TaskCreatedEvent[] = [];
  const options = toolTaskSeamOptionsFor(mode, {
    surface: "chat",
    onTaskCreated: (event) => {
      events.push(event);
    },
    ...overrides,
  })!;
  return { events, options };
}

function callParamsFor(
  fixture: ServedExtensionTasksFixture,
  toolName: string
): Record<string, unknown> | undefined {
  const calls = fixture.received.filter(
    (entry) =>
      entry.method === "tools/call" &&
      (entry.params as { name?: string } | undefined)?.name === toolName
  );
  return calls.at(-1)?.params;
}

/**
 * Removes the tasks entry from a request's client-capability declaration,
 * leaving everything else — including an emptied `extensions` container —
 * exactly as it was, so the remainder can be compared to a pre-tasks baseline.
 */
function stripTasksDeclaration(
  params: Record<string, unknown>
): Record<string, unknown> {
  const clone = structuredClone(params) as any;
  const capabilities =
    clone?._meta?.["io.modelcontextprotocol/clientCapabilities"];
  const extensions = capabilities?.extensions;
  if (extensions && "io.modelcontextprotocol/tasks" in extensions) {
    delete extensions["io.modelcontextprotocol/tasks"];
  }
  return clone;
}

function seamMeta(result: unknown): ToolTaskSeamMeta | undefined {
  return (result as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
    TASK_SEAM_META_KEY
  ] as ToolTaskSeamMeta | undefined;
}

/**
 * Byte-identity is PER ERA, not absolute.
 *
 * On 2026-07-28 every request already carries an `_meta` block announcing the
 * protocol version, client info and client capabilities — era-standard, and
 * nothing to do with tasks. An earlier-era server gets a bare
 * `{name, arguments}` (asserted in the mixed-wire suite below). So the
 * invariant worth pinning is not "no `_meta` ever" but "the tasks option is
 * the ONLY thing that changes, and only on the extension wire".
 */
describe("byte-identity: no tasks option", () => {
  it("sends the era baseline and declares no tasks extension", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const tools = await manager.getToolsForAiSdk([SERVER_ID]);
    await (tools[SYNC_TOOL_NAME] as any).execute({});

    const params = callParamsFor(fixture, SYNC_TOOL_NAME);
    expect(params).toMatchObject({ name: SYNC_TOOL_NAME, arguments: {} });
    expect(declaresTasksExtension(params)).toBe(false);
  });

  it("sends identical params with the other tool options set", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const plain = await manager.getToolsForAiSdk([SERVER_ID]);
    await (plain[SYNC_TOOL_NAME] as any).execute({});
    const baseline = callParamsFor(fixture, SYNC_TOOL_NAME);

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      needsApproval: true,
      includeAppOnly: true,
      modelVisibleMcpToolResults: "all",
    });
    await (tools[SYNC_TOOL_NAME] as any).execute({});

    expect(callParamsFor(fixture, SYNC_TOOL_NAME)).toEqual(baseline);
  });

  it("adds the declaration and NOTHING else when the option is set", async () => {
    // The closed form of the invariant: diff the two request bodies and the
    // only difference may be the tasks entry under client capabilities.
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const plain = await manager.getToolsForAiSdk([SERVER_ID]);
    await (plain[SYNC_TOOL_NAME] as any).execute({});
    const baseline = callParamsFor(fixture, SYNC_TOOL_NAME)!;

    const { options } = collectingSeam();
    const wired = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    await (wired[SYNC_TOOL_NAME] as any).execute({});
    const withTasks = callParamsFor(fixture, SYNC_TOOL_NAME)!;

    expect(declaresTasksExtension(baseline)).toBe(false);
    expect(declaresTasksExtension(withTasks)).toBe(true);
    expect(stripTasksDeclaration(withTasks)).toEqual(baseline);
  });

  it("is what `off` resolves to — the mode is not representable in the seam", () => {
    expect(
      toolTaskSeamOptionsFor("off", {
        surface: "chat",
        onTaskCreated: () => {},
      })
    ).toBeUndefined();
  });
});

describe("expose mode", () => {
  it("declares eligibility, fires the fan-out, and returns a valid result", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const { events, options } = collectingSeam();

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    const result = await (tools[TASK_TOOL_NAME] as any).execute({});

    expect(declaresTasksExtension(callParamsFor(fixture, TASK_TOOL_NAME))).toBe(
      true
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      wire: "extension",
      surface: "chat",
      toolName: TASK_TOOL_NAME,
    });
    expect(events[0].identity.serverId).toBe(SERVER_ID);
    expect(events[0].identity.taskId).toEqual(expect.any(String));

    // Valid CallToolResult, so `assertCallToolResult` in both the manager and
    // `tool-converters` accept it.
    expect(Array.isArray((result as any).content)).toBe(true);
    expect((result as any).content[0].type).toBe("text");
    expect(seamMeta(result)?.taskId).toBe(events[0].identity.taskId);
  });

  it("returns a plain result untouched when the server answers synchronously", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const { events, options } = collectingSeam();

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    const result = await (tools[SYNC_TOOL_NAME] as any).execute({});

    // The server decides. A non-task result from a task-eligible call is valid
    // and must come back exactly as an unwired call would return it.
    expect(events).toHaveLength(0);
    expect(seamMeta(result)).toBeUndefined();
  });

  it("carries the handle in _meta when the fan-out throws, instead of failing the call", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const options = toolTaskSeamOptionsFor("expose", {
      surface: "chat",
      onTaskCreated: () => {
        throw new Error("tracker unavailable");
      },
    })!;

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    // Rethrowing here would fail `execute`, skip the raw-result preservation
    // and lose the taskId — the exact failure the sink exists to prevent.
    const result = await (tools[TASK_TOOL_NAME] as any).execute({});

    expect((result as any).isError).toBe(true);
    expect(seamMeta(result)?.taskId).toEqual(expect.any(String));
  });
});

describe("await mode", () => {
  it("drives a task to completion and returns the tool's own result", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(completingPhases()) },
    });
    const manager = await connect(fixture.url);
    const { events, options } = collectingSeam({}, "await");

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    const result = await (tools[TASK_TOOL_NAME] as any).execute({});

    expect(events).toHaveLength(1);
    expect(seamMeta(result)?.outcome).toBe("completed");
    expect(Array.isArray((result as any).content)).toBe(true);
  });

  it("treats a tool error as a COMPLETED task and preserves its isError", async () => {
    // A tool that reports failure ran to completion and said so. That is
    // categorically not a `failed` task (a JSON-RPC fault), and collapsing the
    // two would tell the model the task machinery broke.
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(isErrorCompletedPhases()) },
    });
    const manager = await connect(fixture.url);
    const { options } = collectingSeam({}, "await");

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    const result = await (tools[TASK_TOOL_NAME] as any).execute({});

    expect(seamMeta(result)?.outcome).toBe("completed");
    expect((result as any).isError).toBe(true);
  });

  it("reports a failed task as an error result carrying the handle", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(failedTaskPhases()) },
    });
    const manager = await connect(fixture.url);
    const { options } = collectingSeam({}, "await");

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    const result = await (tools[TASK_TOOL_NAME] as any).execute({});

    expect(seamMeta(result)?.outcome).toBe("failed");
    expect((result as any).isError).toBe(true);
    expect(seamMeta(result)?.taskId).toEqual(expect.any(String));
  });

  it("fires the fan-out BEFORE driving, so a crash still leaves a handle", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const seen: string[] = [];
    const options = toolTaskSeamOptionsFor("await", {
      surface: "eval",
      onTaskCreated: (event) => {
        seen.push(event.identity.taskId);
      },
      await: { timeoutMs: 50, maxConsecutiveErrors: 1 },
    })!;

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
    });
    await (tools[TASK_TOOL_NAME] as any).execute({});

    expect(seen).toHaveLength(1);
  });
});

/**
 * A suppressed tool call gets a day-long request timeout so the call itself is
 * never cancelled by its own timer. That budget belongs to the CALL and must
 * not spread to the seam's reads.
 *
 * Ending a `tasks/get` does not cancel the task, so a poll gains nothing from
 * the long timer — and loses something real to it: the await driver's deadline
 * abandons an in-flight poll rather than aborting its request (it only stops
 * waiting), so a hung poll on the call's timer would hold its socket for a day
 * with nothing left to end it.
 */
describe("cancellation suppression does not reach the seam's reads", () => {
  async function optionsSeenBy(
    toolCallCancellation: { legacy?: boolean; modern?: boolean } | undefined
  ) {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(completingPhases()) },
    });
    const manager = await connect(fixture.url);
    const { options } = collectingSeam({}, "await");

    const seen: Array<Record<string, unknown> | undefined> = [];
    const realGetTaskExt = manager.getTaskExt.bind(manager);
    (manager as any).getTaskExt = (
      serverId: string,
      taskId: string,
      requestOptions?: Record<string, unknown>
    ) => {
      seen.push(requestOptions);
      return realGetTaskExt(serverId, taskId, requestOptions as never);
    };

    const tools = await manager.getToolsForAiSdk([SERVER_ID], {
      tasks: options,
      ...(toolCallCancellation ? { toolCallCancellation } : {}),
    });
    // A live turn: the signal is what makes the policy apply at all, and it is
    // never aborted here — the question is only which options each leg gets.
    await (tools[TASK_TOOL_NAME] as any).execute(
      {},
      {
        toolCallId: "c1",
        messages: [],
        abortSignal: new AbortController().signal,
      }
    );
    expect(seen.length).toBeGreaterThan(0);
    return seen;
  }

  it("leaves polls on the connection's own timeout when the call is suppressed", async () => {
    const seen = await optionsSeenBy({ legacy: false, modern: false });

    // No day-long timer, and no signal either: withholding the signal is the
    // suppression, and it is about the call, not the poll.
    for (const requestOptions of seen) {
      expect(requestOptions?.timeout).toBeUndefined();
      expect(requestOptions?.signal).toBeUndefined();
    }
  });

  it("still hands polls the turn's signal when nothing is suppressed", async () => {
    // The control: without suppression the reads are unchanged from before the
    // split, so aborting a turn still ends an in-flight poll.
    const seen = await optionsSeenBy(undefined);

    for (const requestOptions of seen) {
      expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(requestOptions?.timeout).toBeUndefined();
    }
  });
});

describe("mixed wires", () => {
  it("declares only on the extension server and never throws on the others", async () => {
    // `withTaskEligibilityDeclaration` THROWS on `wire: "none"`, so a turn
    // spanning a 2025-06-18 server is exactly the case that would explode from
    // inside `execute` without the seam's per-server wire check.
    const extension = await serve();
    const noTasks = await serve({
      supportedVersions: ["2025-06-18"],
      advertiseTasksExtension: false,
    });

    const manager = new MCPClientManager();
    opened.managers.push(manager);
    await manager.connectToServer("ext", {
      url: extension.url,
      mcpProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      timeout: 10_000,
    });
    await manager.connectToServer("old", {
      url: noTasks.url,
      mcpProtocolVersion: "2025-06-18",
      timeout: 10_000,
    });

    expect(manager.getTasksSupport("old").wire).toBe("none");

    const { options } = collectingSeam();
    const extTools = await manager.getToolsForAiSdk(["ext"], {
      tasks: options,
    });
    const oldTools = await manager.getToolsForAiSdk(["old"], {
      tasks: options,
    });

    await expect(
      (oldTools[SYNC_TOOL_NAME] as any).execute({})
    ).resolves.toBeDefined();
    await (extTools[TASK_TOOL_NAME] as any).execute({});

    // The no-tasks server got a bare call; the extension server got the
    // declaration. One turn, one option, two correct wires.
    expect(declaresTasksExtension(callParamsFor(noTasks, SYNC_TOOL_NAME))).toBe(
      false
    );
    expect(callParamsFor(noTasks, SYNC_TOOL_NAME)).toEqual({
      name: SYNC_TOOL_NAME,
      arguments: {},
    });
    expect(
      declaresTasksExtension(callParamsFor(extension, TASK_TOOL_NAME))
    ).toBe(true);
  });
});
