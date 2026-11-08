import { useState } from "react";
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
  const [messages, setMessages] = useState(pending);
  return { messages, ...useHarnessApprovalStop({ owner, messages, setMessages }) };
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
