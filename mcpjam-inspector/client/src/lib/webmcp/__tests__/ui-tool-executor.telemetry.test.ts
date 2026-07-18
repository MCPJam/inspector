import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  track: trackMock,
}));

import {
  __resetUiToolExecutorForTests,
  fulfillApprovedUiToolCall,
  handleUiToolCall,
  settleDeniedUiToolCall,
} from "../ui-tool-executor";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "../ui-tools-registry";

// Sentinels that must NEVER appear in any emitted property: args in, output
// out. The hard telemetry rule is names/booleans/counts/durations only.
const SECRET_ARG = "SECRET_ARG_never_in_telemetry";
const SECRET_OUTPUT = "SECRET_OUTPUT_never_in_telemetry";

function makeTool(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  return {
    name: "ui_navigate",
    description: "Navigate",
    readOnly: false,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: SECRET_OUTPUT }],
    })),
    ...extra,
  };
}

function eventCalls(
  event: string,
): Array<Record<string, unknown>> {
  return trackMock.mock.calls
    .filter(([name]) => name === event)
    .map(([, props]) => props as Record<string, unknown>);
}

describe("ui-tool-executor outcome telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUiToolExecutorForTests();
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("success path: one started + one completed with outcome success", async () => {
    useUiToolsRegistry.getState().registerUiTool(makeTool());

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-success",
      input: { target: SECRET_ARG },
      addToolOutput: vi.fn(),
    });

    const started = eventCalls("ui_tool_call_started");
    const completed = eventCalls("ui_tool_call_completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]).toMatchObject({
      tool_name: "ui_navigate",
      needs_approval: false,
    });
    expect(typeof started[0].surface_id).toBe("string");
    expect(started[0].surface_id).not.toBe("");
    expect(completed[0]).toMatchObject({
      tool_name: "ui_navigate",
      outcome: "success",
      approval: "not_required",
      duplicate_of_previous: false,
    });
    expect(typeof completed[0].duration_ms).toBe("number");
    expect(completed[0]).not.toHaveProperty("error_code");
    expect(completed[0]).not.toHaveProperty("calls_since_duplicate");
  });

  it("throwing execute completes with outcome error and code tool_threw", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => {
          throw new Error(SECRET_OUTPUT);
        },
      }),
    );

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-throw",
      input: { target: SECRET_ARG },
      addToolOutput: vi.fn(),
    });

    const completed = eventCalls("ui_tool_call_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      outcome: "error",
      error_code: "tool_threw",
      approval: "not_required",
    });
  });

  it("extracts ONLY whitelisted structured codes from isError outputs", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => ({
          content: [
            {
              type: "text" as const,
              text: `unsupported_in_mode: ${SECRET_OUTPUT}`,
            },
          ],
          isError: true,
        }),
      }),
    );

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-coded",
      input: {},
      addToolOutput: vi.fn(),
    });

    const completed = eventCalls("ui_tool_call_completed");
    expect(completed[0]).toMatchObject({
      outcome: "error",
      error_code: "unsupported_in_mode",
    });
  });

  it("free-text error outputs emit NO error_code at all", async () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool({
        execute: async () => ({
          content: [
            { type: "text" as const, text: "Missing required 'target' string." },
          ],
          isError: true,
        }),
      }),
    );

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-freetext",
      input: {},
      addToolOutput: vi.fn(),
    });

    const completed = eventCalls("ui_tool_call_completed");
    expect(completed[0]).toMatchObject({ outcome: "error" });
    expect(completed[0]).not.toHaveProperty("error_code");
  });

  it("deferred → denied: started at defer time, one completed with outcome denied", async () => {
    const def = makeTool();
    useUiToolsRegistry.getState().registerUiTool(def);

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-deny",
      input: { target: SECRET_ARG },
      addToolOutput: vi.fn(),
      requireToolApproval: true,
    });

    const started = eventCalls("ui_tool_call_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ needs_approval: true });
    expect(eventCalls("ui_tool_call_completed")).toHaveLength(0);

    settleDeniedUiToolCall("tc-deny");

    const completed = eventCalls("ui_tool_call_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      tool_name: "ui_navigate",
      outcome: "denied",
      approval: "denied",
    });
    expect(typeof completed[0].duration_ms).toBe("number");
    expect(def.execute).not.toHaveBeenCalled();
  });

  it("deferred → approved: one completed with approval approved", async () => {
    useUiToolsRegistry.getState().registerUiTool(makeTool());
    const addToolOutput = vi.fn();

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-approve",
      input: { target: SECRET_ARG },
      addToolOutput,
      requireToolApproval: true,
    });
    await fulfillApprovedUiToolCall({ toolCallId: "tc-approve", addToolOutput });

    expect(eventCalls("ui_tool_call_started")).toHaveLength(1);
    const completed = eventCalls("ui_tool_call_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      outcome: "success",
      approval: "approved",
    });
  });

  it("re-emitted calls for a settled id emit no additional events", async () => {
    useUiToolsRegistry.getState().registerUiTool(makeTool());
    const opts = {
      toolName: "ui_navigate",
      toolCallId: "tc-reemit",
      input: {},
      addToolOutput: vi.fn(),
    };

    await handleUiToolCall(opts);
    await handleUiToolCall(opts);

    expect(eventCalls("ui_tool_call_started")).toHaveLength(1);
    expect(eventCalls("ui_tool_call_completed")).toHaveLength(1);
  });

  it("NO event property ever contains args or output content", async () => {
    useUiToolsRegistry.getState().registerUiTool(makeTool());
    const addToolOutput = vi.fn();

    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-leak-1",
      input: { target: SECRET_ARG, nested: { deep: SECRET_ARG } },
      addToolOutput,
    });
    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-leak-2",
      input: { target: SECRET_ARG },
      addToolOutput,
      requireToolApproval: true,
    });
    settleDeniedUiToolCall("tc-leak-2");

    expect(trackMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, props] of trackMock.mock.calls) {
      const serialized = JSON.stringify(props);
      expect(serialized).not.toContain(SECRET_ARG);
      expect(serialized).not.toContain(SECRET_OUTPUT);
    }
  });

  describe("duplicate-call detection", () => {
    it("flags an identical repeat with calls_since_duplicate 1", async () => {
      useUiToolsRegistry.getState().registerUiTool(makeTool());
      const addToolOutput = vi.fn();

      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-dup-1",
        // Key order deliberately differs from the repeat below — the
        // signature canonicalizes, so these are the SAME call.
        input: { a: 1, target: "servers" },
        addToolOutput,
      });
      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-dup-2",
        input: { target: "servers", a: 1 },
        addToolOutput,
      });

      const completed = eventCalls("ui_tool_call_completed");
      expect(completed).toHaveLength(2);
      expect(completed[0]).toMatchObject({ duplicate_of_previous: false });
      expect(completed[0]).not.toHaveProperty("calls_since_duplicate");
      expect(completed[1]).toMatchObject({
        duplicate_of_previous: true,
        calls_since_duplicate: 1,
      });
    });

    it("different args are not duplicates; distance counts intervening calls", async () => {
      useUiToolsRegistry.getState().registerUiTool(makeTool());
      const addToolOutput = vi.fn();

      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-d-1",
        input: { target: "servers" },
        addToolOutput,
      });
      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-d-2",
        input: { target: "playground" },
        addToolOutput,
      });
      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-d-3",
        input: { target: "servers" },
        addToolOutput,
      });

      const completed = eventCalls("ui_tool_call_completed");
      expect(completed).toHaveLength(3);
      expect(completed[1]).toMatchObject({ duplicate_of_previous: false });
      expect(completed[2]).toMatchObject({
        duplicate_of_previous: true,
        calls_since_duplicate: 2,
      });
    });

    it("reload-then-deny emits a full started/completed pair from part metadata", () => {
      // No handleUiToolCall first: simulates a deny after a page reload,
      // where the defer happened in a previous load and no in-memory entry
      // exists. The approval part's persisted metadata establishes the
      // lifecycle.
      settleDeniedUiToolCall("tc-reload-deny", {
        toolName: "ui_remove_server",
        input: { serverName: "disposable" },
        telemetryScope: "chat-session-a",
      });

      const started = eventCalls("ui_tool_call_started");
      const completed = eventCalls("ui_tool_call_completed");
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        tool_name: "ui_remove_server",
        needs_approval: true,
      });
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        tool_name: "ui_remove_server",
        outcome: "denied",
        approval: "denied",
      });
    });

    it("reload-then-deny reports null duration (reconstructed lifecycle)", () => {
      settleDeniedUiToolCall("tc-recon-deny", {
        toolName: "ui_remove_server",
        input: { serverName: "x" },
        telemetryScope: "s",
      });
      const completed = eventCalls("ui_tool_call_completed");
      expect(completed).toHaveLength(1);
      // No real start time survived the reload → null, not a misleading ~0ms.
      expect(completed[0].duration_ms).toBeNull();
    });

    it("re-emitted deferred call is claimed without a second started event", async () => {
      useUiToolsRegistry.getState().registerUiTool(
        makeTool({ readOnly: false, annotations: { destructiveHint: true } }),
      );
      const addToolOutput = vi.fn();

      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-defer-re",
        input: { target: "servers" },
        addToolOutput,
      });
      expect(eventCalls("ui_tool_call_started")).toHaveLength(1);

      // SDK re-emits the same still-deferred call (e.g. stream resume).
      const claimed = await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-defer-re",
        input: { target: "servers" },
        addToolOutput,
      });
      expect(claimed).toBe(true);
      expect(eventCalls("ui_tool_call_started")).toHaveLength(1);
      expect(addToolOutput).not.toHaveBeenCalled();
    });

    it("re-emitted settled call with an unregistered tool emits no telemetry", async () => {
      const unregister = useUiToolsRegistry
        .getState()
        .registerUiTool(makeTool());
      const addToolOutput = vi.fn();

      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-r-1",
        input: { target: "servers" },
        addToolOutput,
      });
      expect(eventCalls("ui_tool_call_completed")).toHaveLength(1);

      // HMR/unmount: tool gone, name still shipped. The SDK re-emits the
      // already-fulfilled call during resume.
      unregister();
      trackMock.mockClear();
      addToolOutput.mockClear();
      const claimed = await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-r-1",
        input: { target: "servers" },
        addToolOutput,
      });

      expect(claimed).toBe(true); // still ours — but nothing re-runs
      expect(addToolOutput).not.toHaveBeenCalled();
      expect(eventCalls("ui_tool_call_started")).toHaveLength(0);
      expect(eventCalls("ui_tool_call_completed")).toHaveLength(0);
    });

    it("identical calls in different telemetry scopes are not duplicates", async () => {
      useUiToolsRegistry.getState().registerUiTool(makeTool());
      const addToolOutput = vi.fn();

      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-s-1",
        input: { target: "servers" },
        addToolOutput,
        telemetryScope: "chat-session-a",
      });
      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-s-2",
        input: { target: "servers" },
        addToolOutput,
        telemetryScope: "chat-session-b",
      });
      await handleUiToolCall({
        toolName: "ui_navigate",
        toolCallId: "tc-s-3",
        input: { target: "servers" },
        addToolOutput,
        telemetryScope: "chat-session-a",
      });

      const completed = eventCalls("ui_tool_call_completed");
      expect(completed).toHaveLength(3);
      // Session B's identical call is NOT a duplicate of session A's.
      expect(completed[1]).toMatchObject({ duplicate_of_previous: false });
      // Session A's own repeat is, at distance 1 within its scope.
      expect(completed[2]).toMatchObject({
        duplicate_of_previous: true,
        calls_since_duplicate: 1,
      });
    });
  });
});
