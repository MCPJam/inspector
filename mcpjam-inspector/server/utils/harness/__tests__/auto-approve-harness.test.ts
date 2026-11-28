import { describe, expect, it, vi } from "vitest";
import type {
  HarnessV1,
  HarnessV1PromptControl,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";
import {
  APPROVE_NATIVE_REQUEST,
  DENY_UNANSWERED,
  withAnsweredNativeRequests,
  withDeniedGatedHostTools,
} from "../auto-approve-harness.js";

const request = {
  type: "tool-approval-request",
  approvalId: "approval",
  toolCallId: "call",
} as HarnessV1StreamPart;
function fixture(beforeControl = false, failure?: Error) {
  let emit: (part: HarnessV1StreamPart) => void;
  const submitToolApproval = vi.fn(async () => {
    if (failure) throw failure;
  });
  let finish!: () => void;
  const control = {
    submitToolResult: vi.fn(async () => {}),
    submitToolApproval,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  } as HarnessV1PromptControl;
  const start = vi.fn(async (options: { emit: typeof emit }) => {
    emit = options.emit;
    if (beforeControl) emit(request);
    return control;
  });
  const session = {
    doPromptTurn: start,
    doContinueTurn: start,
    doStop: vi.fn(),
  };
  const harness = {
    doStart: vi.fn(async () => session),
  } as unknown as HarnessV1;
  return {
    harness,
    submitToolApproval,
    send: (part: HarnessV1StreamPart) => emit(part),
    finish,
    session,
  };
}
describe("native automatic approval", () => {
  it.each(["doPromptTurn", "doContinueTurn"] as const)(
    "approves and drops duplicate native requests in %s, preserving other parts",
    async (method) => {
      const f = fixture();
      const emit = vi.fn();
      const onApproval = vi.fn();
      const session = await withAnsweredNativeRequests(
        f.harness,
        APPROVE_NATIVE_REQUEST,
        { onAnswer: onApproval },
      ).doStart({} as never);
      const control = await session[method]({ emit } as never);
      f.send(request);
      f.send(request);
      const part = {
        type: "text-delta",
        id: "text",
        delta: "hello",
      } as HarnessV1StreamPart;
      f.send(part);
      f.finish();
      await control.done;
      expect(f.submitToolApproval).toHaveBeenCalledExactlyOnceWith({
        approvalId: "approval",
        approved: true,
      });
      expect(emit.mock.calls).toEqual([[part]]);
      expect(onApproval).toHaveBeenCalledExactlyOnceWith("approval");
    },
  );
  it("queues requests emitted before control is returned", async () => {
    const f = fixture(true);
    const emit = vi.fn();
    const session = await withAnsweredNativeRequests(
      f.harness,
      APPROVE_NATIVE_REQUEST,
    ).doStart({} as never);
    const control = await session.doPromptTurn({ emit } as never);
    f.finish();
    await control.done;
    expect(f.submitToolApproval).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });
  it("propagates approval submission errors through done", async () => {
    const f = fixture(true, new Error("bridge unavailable"));
    const session = await withAnsweredNativeRequests(
      f.harness,
      APPROVE_NATIVE_REQUEST,
    ).doStart({} as never);
    const control = await session.doPromptTurn({ emit: vi.fn() } as never);
    await expect(control.done).rejects.toThrow("bridge unavailable");
  });
  it("leaves an already pending decision to the user's continuation", async () => {
    const f = fixture(true);
    const emit = vi.fn();
    const session = await withAnsweredNativeRequests(
      f.harness,
      APPROVE_NATIVE_REQUEST,
      { pendingApprovalIds: new Set(["approval"]) },
    ).doStart({} as never);
    const control = await session.doContinueTurn({ emit } as never);
    f.finish();
    await control.done;
    expect(emit).toHaveBeenCalledExactlyOnceWith(request);
    expect(f.submitToolApproval).not.toHaveBeenCalled();
  });
});

it("auto-answers only registered forwarded MCP names, leaving built-ins and unknown IDs alone", async () => {
  const f = fixture(); const emit = vi.fn();
  const session = await withAnsweredNativeRequests(f.harness, APPROVE_NATIVE_REQUEST, { covers: name => !!name?.startsWith("mcp__server__") }).doStart({} as never);
  const control = await session.doPromptTurn({ emit } as never);
  f.send({ type: "tool-call", toolCallId: "call", toolName: "mcp__server__read", input: {} });
  f.send(request);
  f.send({ type: "tool-call", toolCallId: "builtin", toolName: "Bash", input: {} });
  f.send({ type: "tool-approval-request", toolCallId: "builtin", approvalId: "builtin-approval" });
  f.send({ type: "tool-approval-request", toolCallId: "missing", approvalId: "unknown-approval" });
  f.finish(); await control.done;
  expect(f.submitToolApproval).toHaveBeenCalledExactlyOnceWith({ approvalId: "approval", approved: true });
  expect(emit.mock.calls.flat().filter(part => part.type === "tool-approval-request").map(part => part.approvalId)).toEqual(["builtin-approval", "unknown-approval"]);
});

it("reads a call's JSON-text input for runtimes that name the server only there", async () => {
  const f = fixture(); const emit = vi.fn();
  const seen: unknown[] = [];
  const session = await withAnsweredNativeRequests(f.harness, APPROVE_NATIVE_REQUEST, { covers: (_name, input) => {
    seen.push(input);
    return (input as { providerIdentifier?: string } | undefined)?.providerIdentifier === "server";
  } }).doStart({} as never);
  const control = await session.doPromptTurn({ emit } as never);
  // The ACP adapter streams every MCP call under an opaque name, input as JSON text.
  f.send({ type: "tool-call", toolCallId: "call", toolName: "acp_tool_1", input: JSON.stringify({ providerIdentifier: "server", toolName: "read", args: {} }) });
  f.send(request);
  f.send({ type: "tool-call", toolCallId: "shell", toolName: "acp_tool_2", input: JSON.stringify({ command: "ls" }) });
  f.send({ type: "tool-approval-request", toolCallId: "shell", approvalId: "shell-approval" });
  f.finish(); await control.done;
  expect(seen).toEqual([{ providerIdentifier: "server", toolName: "read", args: {} }, { command: "ls" }]);
  expect(f.submitToolApproval).toHaveBeenCalledExactlyOnceWith({ approvalId: "approval", approved: true });
  expect(emit.mock.calls.flat().filter(part => part.type === "tool-approval-request").map(part => part.approvalId)).toEqual(["shell-approval"]);
});

describe("a turn nobody can answer", () => {
  it("denies every native request with the engine's synthetic-session result", async () => {
    const f = fixture();
    const emit = vi.fn();
    const onAnswer = vi.fn();
    const session = await withAnsweredNativeRequests(f.harness, DENY_UNANSWERED, {
      onAnswer,
    }).doStart({} as never);
    const control = await session.doPromptTurn({ emit } as never);
    f.send({ type: "tool-call", toolCallId: "call", toolName: "Bash", input: "{}" } as HarnessV1StreamPart);
    f.send(request);
    f.finish();
    await control.done;
    expect(f.submitToolApproval).toHaveBeenCalledExactlyOnceWith({
      approvalId: "approval",
      approved: false,
      reason: "approval-denied (synthetic session)",
    });
    // Nothing reaches the turn to pause on.
    expect(emit.mock.calls.flat().map((part) => part.type)).toEqual(["tool-call"]);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("approval");
  });

  it("refuses a host tool that asks where it runs, and leaves the rest alone", async () => {
    const asks = { needsApproval: true, execute: vi.fn(async () => "wrote") };
    const decides = { needsApproval: () => true, execute: vi.fn(async () => "wrote") };
    const reads = { needsApproval: false, execute: vi.fn(async () => "read") };
    const tools = withDeniedGatedHostTools({ asks, decides, reads });
    for (const name of ["asks", "decides"] as const) {
      expect(tools[name].needsApproval).toBe(false);
      await expect(tools[name].execute()).resolves.toEqual({
        error: "approval-denied (synthetic session)",
      });
    }
    expect(asks.execute).not.toHaveBeenCalled();
    expect(decides.execute).not.toHaveBeenCalled();
    expect(tools.reads).toBe(reads);
  });
});
