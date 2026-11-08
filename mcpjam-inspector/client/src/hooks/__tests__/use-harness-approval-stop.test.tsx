import { useState, useRef } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { useHarnessApprovalStop } from "../use-harness-approval-stop";

const db = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock("convex/react", () => ({ useConvex: () => db }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const pending: UIMessage[] = [{ id: "assistant", role: "assistant", parts: [
  { type: "step-start" },
  { type: "dynamic-tool", toolName: "qa_write", toolCallId: "call", state: "approval-requested",
    input: { runId: "stop" }, approval: { id: "approval" } },
] }];
const owner = { projectId: "project", harnessId: "opencode" as const, chatSessionId: "chat" };

function useTestChat() {
  const dispatchBlocked = useRef(false);
  const [messages, setMessages] = useState(pending);
  return { messages, dispatchBlocked, ...useHarnessApprovalStop({ owner, messages, setMessages, dispatchBlocked }) };
}

beforeEach(() => {
  db.query.mockReset().mockResolvedValue([]);
  db.mutation.mockReset().mockResolvedValue("cancelled");
});

describe("hosted harness approval Stop", () => {
  it("waits for durable cancellation and does not synthesize a Deny continuation", async () => {
    const { result } = renderHook(useTestChat);
    expect(result.current.canStopApproval).toBe(true);
    await act(async () => { await result.current.stopApproval(); });
    expect(db.mutation).toHaveBeenCalledWith(expect.anything(), { ...owner, approvalIds: ["approval"] });
    expect(result.current.canStopApproval).toBe(false);
    expect(lastAssistantMessageIsCompleteWithApprovalResponses({ messages: result.current.messages })).toBe(false);
    expect(result.current.messages[0].parts[1]).toMatchObject({ state: "output-denied" });
  });

  it("coalesces simultaneous Stop triggers", async () => {
    const { result } = renderHook(useTestChat);
    await act(async () => {
      await Promise.all([result.current.stopApproval(), result.current.stopApproval()]);
    });
    expect(db.mutation).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending card when Approve already claimed the lane", async () => {
    db.mutation.mockResolvedValue("already-continuing");
    const { result } = renderHook(useTestChat);
    await act(async () => { await result.current.stopApproval(); });
    expect(result.current.canStopApproval).toBe(true);
  });

  it("does not restore an approval card from the saved pre-Stop transcript", async () => {
    db.query.mockResolvedValue(["approval"]);
    const { result } = renderHook(useTestChat);
    await waitFor(() => expect(result.current.canStopApproval).toBe(false));
    expect(result.current.messages[0].parts[1]).toMatchObject({ state: "output-denied" });
    expect(db.mutation).not.toHaveBeenCalled();
  });
});

describe("active harness Stop", () => {
  it("blocks a follow-up until the durable request cancellation completes", async () => {
    let finish!: () => void;
    db.mutation.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(useTestChat);
    let pending!: Promise<void>;
    act(() => { pending = result.current.stopActiveTurn("request-before-lane"); });
    expect(result.current.stopping).toBe(true);
    expect(result.current.dispatchBlocked.current).toBe(true);
    expect(db.mutation).toHaveBeenCalledWith(expect.anything(), { ...owner, requestId: "request-before-lane" });
    await act(async () => { finish(); await pending; });
    expect(result.current.stopping).toBe(false);
    expect(result.current.stopFailed).toBe(false);
    expect(result.current.dispatchBlocked.current).toBe(false);
  });

  it("keeps dispatch blocked when cancellation could not be confirmed", async () => {
    db.mutation.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(useTestChat);
    await act(async () => { await result.current.stopActiveTurn("request"); });
    expect(result.current.stopFailed).toBe(true);
    expect(result.current.dispatchBlocked.current).toBe(true);
    expect(result.current.stopping).toBe(false);
  });
  it("keeps a newer Stop blocked when an older cancellation completes", async () => {
    const completions: Array<() => void> = [];
    db.mutation.mockImplementation(() => new Promise<void>((resolve) => { completions.push(resolve); }));
    const { result } = renderHook(useTestChat);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.stopActiveTurn("old"); second = result.current.stopActiveTurn("new"); });
    await act(async () => { completions[0](); await first; });
    expect(result.current.dispatchBlocked.current).toBe(true);
    expect(result.current.stopping).toBe(true);
    await act(async () => { completions[1](); await second; });
    expect(result.current.dispatchBlocked.current).toBe(false);
  });

});
