/**
 * UI-tool-aware approval responses: Approve on a `ui_*` part executes in the
 * browser and ships the tool-result (never a bare approval response — the
 * server cannot execute a no-execute tool); Deny and non-UI tools use the
 * plain approval response. Plus the orphaned-defer fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import {
  createUiAwareApprovalResponseHandler,
  fulfillOrphanedDeferredUiToolCalls,
} from "../ui-tool-approval";
import {
  __resetUiToolExecutorForTests,
  handleUiToolCall,
} from "../ui-tool-executor";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "../ui-tools-registry";

function registerTool(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  const def: UiToolDefinition = {
    name: "ui_navigate",
    description: "Navigate",
    readOnly: false,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "navigated" }],
    })),
    ...extra,
  };
  useUiToolsRegistry.getState().registerUiTool(def);
  return def;
}

function uiPartMessage(overrides?: Record<string, unknown>) {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "ui_navigate",
        toolCallId: "tc-1",
        state: "approval-requested",
        input: { target: "servers" },
        approval: { id: "appr-1" },
        ...overrides,
      },
    ],
  } as any;
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createUiAwareApprovalResponseHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUiToolExecutorForTests();
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("Approve on a ui_* part executes and ships the result — no approval response", async () => {
    const def = registerTool();
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const handler = createUiAwareApprovalResponseHandler({
      getMessages: () => [uiPartMessage()],
      addToolApprovalResponse,
      addToolOutput,
    });

    handler({ id: "appr-1", approved: true });
    await flushMicrotasks();

    expect(def.execute).toHaveBeenCalledWith({ target: "servers" });
    expect(addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "ui_navigate", toolCallId: "tc-1" })
    );
    expect(addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it("Deny on a ui_* part sends the plain approval response — no execution", async () => {
    const def = registerTool();
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const handler = createUiAwareApprovalResponseHandler({
      getMessages: () => [uiPartMessage()],
      addToolApprovalResponse,
      addToolOutput,
    });

    handler({ id: "appr-1", approved: false });
    await flushMicrotasks();

    expect(addToolApprovalResponse).toHaveBeenCalledWith({
      id: "appr-1",
      approved: false,
    });
    expect(def.execute).not.toHaveBeenCalled();
    expect(addToolOutput).not.toHaveBeenCalled();
  });

  it("a duplicate approve after a deny never executes the denied call", async () => {
    const def = registerTool();
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const handler = createUiAwareApprovalResponseHandler({
      getMessages: () => [uiPartMessage()],
      addToolApprovalResponse,
      addToolOutput,
    });

    handler({ id: "appr-1", approved: false });
    handler({ id: "appr-1", approved: true }); // duplicate/replayed event
    await flushMicrotasks();

    expect(addToolApprovalResponse).toHaveBeenCalledWith({
      id: "appr-1",
      approved: false,
    });
    expect(def.execute).not.toHaveBeenCalled();
    expect(addToolOutput).not.toHaveBeenCalled();
  });

  it("non-UI tool parts fall through to the plain approval response", async () => {
    const addToolApprovalResponse = vi.fn();
    const addToolOutput = vi.fn();
    const handler = createUiAwareApprovalResponseHandler({
      getMessages: () => [
        uiPartMessage({ type: "tool-server_tool", toolName: undefined }),
      ],
      addToolApprovalResponse,
      addToolOutput,
    });

    handler({ id: "appr-1", approved: true });
    await flushMicrotasks();

    expect(addToolApprovalResponse).toHaveBeenCalledWith({
      id: "appr-1",
      approved: true,
    });
    expect(addToolOutput).not.toHaveBeenCalled();
  });

  it("approve fires the navigation handoff for mayNavigate tools", async () => {
    registerTool({ mayNavigate: true });
    const onNavigationToolCall = vi.fn();
    const handler = createUiAwareApprovalResponseHandler({
      getMessages: () => [uiPartMessage()],
      addToolApprovalResponse: vi.fn(),
      addToolOutput: vi.fn(),
      onNavigationToolCall,
    });

    handler({ id: "appr-1", approved: true });
    await flushMicrotasks();

    expect(onNavigationToolCall).toHaveBeenCalledWith("ui_navigate");
  });
});

describe("fulfillOrphanedDeferredUiToolCalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUiToolExecutorForTests();
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("executes deferred calls whose parts never got an approval request", async () => {
    const def = registerTool();
    const addToolOutput = vi.fn();
    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-1",
      input: { target: "servers" },
      addToolOutput,
      requireToolApproval: true,
    });

    fulfillOrphanedDeferredUiToolCalls({
      messages: [
        uiPartMessage({ state: "input-available", approval: undefined }),
      ],
      addToolOutput,
    });
    await flushMicrotasks();

    expect(def.execute).toHaveBeenCalledWith({ target: "servers" });
    expect(addToolOutput).toHaveBeenCalled();
  });

  it("leaves deferred calls whose parts are approval-requested parked for the pill", async () => {
    const def = registerTool();
    const addToolOutput = vi.fn();
    await handleUiToolCall({
      toolName: "ui_navigate",
      toolCallId: "tc-1",
      input: { target: "servers" },
      addToolOutput,
      requireToolApproval: true,
    });

    fulfillOrphanedDeferredUiToolCalls({
      messages: [uiPartMessage()],
      addToolOutput,
    });
    await flushMicrotasks();

    expect(def.execute).not.toHaveBeenCalled();
    expect(addToolOutput).not.toHaveBeenCalled();
  });
});
