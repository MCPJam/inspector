import { describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import type { ToolNotification } from "../../../../shared/tool-notification.js";
import {
  createAiSdkEvalTraceContext,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../../evals/eval-trace-capture.js";
import { buildDirectChatTraceCallbacks } from "../../../utils/direct-chat-sse-callbacks.js";
import { serveMock, type MockDoor } from "../../mock/route.js";
import { resolvedMock } from "../../mock/__tests__/helpers.js";
import {
  forwardToolLogs,
  reportToolProgress,
  withToolNotifications,
} from "../tool-notifications.js";

const door: MockDoor = {
  kind: "in-process",
  grant: "grant-ann",
  bearerToken: "bearer-ann",
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  projectId: "proj1",
  profile: { timeoutMs: 5_000 },
};

const working = resolvedMock({
  baseServerId: undefined,
  definition: {
    tools: {
      run_task: {
        description: "Runs.",
        inputSchema: { type: "object", properties: {} },
        answer: {
          from: "saved",
          cases: [
            {
              steps: [
                { kind: "progress", progress: 1, total: 2, message: "half" },
                { kind: "log", level: "info", data: "working on it", logger: "job" },
                { kind: "progress", progress: 2, total: 2 },
              ],
              result: { content: [{ type: "text", text: "task finished" }] },
            },
          ],
        },
      },
    },
  },
});

describe.each(["2025-06-18", "2026-07-28"] as const)(
  "V34: a Playground tool call shows what its server sends (revision %s)",
  (version) => {
    it("hands both progress messages and the log to the running call, and the result carries neither", async () => {
      const manager = new MCPClientManager(
        {},
        { progressHandler: (event) => void reportToolProgress(event) },
      );
      await manager.connectToServer("mock", {
        url: "https://mock.mcpjam.invalid/mock1",
        mcpProtocolVersion: version,
        baseFetch: (input: string | URL | Request, init?: RequestInit) =>
          serveMock(new Request(input, init), "mock1", door, {
            resolve: vi.fn(async () => working),
          }),
      });
      forwardToolLogs(manager, ["mock"]);
      const trace = createAiSdkEvalTraceContext(Date.now());
      registerAiSdkPrepareStep(trace, 0);
      const seen: ToolNotification[] = [];
      trace.onToolNotification = (n) => seen.push(n);
      const tools = wrapToolSetForEvalTrace(
        await manager.getToolsForAiSdk(["mock"]),
        trace,
      ) as Record<
        string,
        { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }
      >;

      const result = await tools.run_task!.execute({}, { toolCallId: "call-1" });

      expect(seen.filter((n) => n.kind === "progress")).toEqual([
        { toolCallId: "call-1", kind: "progress", progress: 1, total: 2, message: "half" },
        { toolCallId: "call-1", kind: "progress", progress: 2, total: 2 },
      ]);
      expect(seen.filter((n) => n.kind === "log")).toEqual([
        { toolCallId: "call-1", kind: "log", level: "info", logger: "job", text: "working on it" },
      ]);
      expect(JSON.stringify(result)).toContain("task finished");
      expect(JSON.stringify(result)).not.toContain("working on it");
      await manager.disconnectAllServers();
    });
  },
);

describe("forwardToolLogs", () => {
  it("registers once per manager and server, and a log outside a call is dropped", () => {
    const handlers: Array<(n: unknown) => void> = [];
    const manager = {
      setPerRequestLogLevel: vi.fn(),
      onLogMessage: vi.fn((_id: string, h: (n: unknown) => void) => {
        handlers.push(h);
      }),
      listServers: () => ["a", "b"],
    };
    forwardToolLogs(manager, ["a", "b"]);
    forwardToolLogs(manager, ["a"]);
    expect(manager.onLogMessage).toHaveBeenCalledTimes(2);
    expect(manager.setPerRequestLogLevel).toHaveBeenCalledWith("a", "debug");
    const emit = vi.fn();
    handlers[0]!({ params: { level: "warning", data: { a: 1 } } });
    expect(emit).not.toHaveBeenCalled();
    withToolNotifications({ toolCallId: "c", emit }, () =>
      handlers[0]!({ params: { level: "warning", data: { a: 1 } } }),
    );
    expect(emit).toHaveBeenCalledWith({
      toolCallId: "c",
      kind: "log",
      level: "warning",
      text: '{"a":1}',
    });
  });

  it("forwards every server for a turn with no selection, and none for an empty one", () => {
    const manager = {
      setPerRequestLogLevel: vi.fn(),
      onLogMessage: vi.fn(),
      listServers: () => ["a", "b"],
    };
    forwardToolLogs(manager, []);
    expect(manager.onLogMessage).not.toHaveBeenCalled();
    forwardToolLogs(manager, undefined);
    expect(manager.onLogMessage.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("reports no owner for progress that no call is running", () => {
    expect(reportToolProgress({ serverId: "s", progress: 1 })).toBe(false);
  });
});

describe("the chat stream", () => {
  it("carries each notification as a transient part, never as part of a message", () => {
    const write = vi.fn();
    buildDirectChatTraceCallbacks({ write }).onToolNotification?.({
      toolCallId: "c",
      kind: "progress",
      progress: 1,
    });
    expect(write).toHaveBeenCalledWith({
      type: "data-tool-notification",
      data: { toolCallId: "c", kind: "progress", progress: 1 },
      transient: true,
    });
  });
});
