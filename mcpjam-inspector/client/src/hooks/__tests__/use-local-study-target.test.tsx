import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/local-study-setup", () => ({ requestLocalStudySetup: request }));
import { useLocalStudyTarget } from "../use-local-study-target";
const identity: { userId?: string; scenarioId?: string; accessVersion?: number } = { userId: "user", scenarioId: "study", accessVersion: 2 };
const ready = {
  token: "secret",
  expiresAt: "2999-01-01T00:00:00.000Z",
  target: { localStudySessionId: "reservation" },
};
beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(ready);
});
it("requires explicit setup and binds the result to the exact conversation", async () => {
  const { result } = renderHook(() => useLocalStudyTarget(identity));
  expect(request).not.toHaveBeenCalled();
  expect(result.current.requested).toBe(false);
  await act(() => result.current.setup("chat"));
  expect(request).toHaveBeenCalledWith({
    scenarioId: "study",
    accessVersion: 2,
    chatSessionId: "chat",
  });
  expect(result.current.resolveSendTarget("chat")).toEqual({
    target: ready.target,
    token: "secret",
  });
  expect(result.current.resolveSendTarget("other")).toBeNull();
});
it.each([
  { userId: "other" },
  { scenarioId: "other" },
  { accessVersion: 3 },
  { userId: undefined },
])("does not reuse a grant across identity changes: %j", async (change) => {
  const { result, rerender } = renderHook(
    (props) => useLocalStudyTarget(props),
    { initialProps: identity },
  );
  await act(() => result.current.setup("chat"));
  rerender({ ...identity, ...change });
  expect(result.current.requested).toBe(false);
  expect(result.current.resolveSendTarget("chat")).toBeNull();
});
it("ignores a setup response that arrives after the account changes", async () => {
  let complete: ((value: typeof ready) => void) | undefined;
  request.mockReturnValue(
    new Promise<typeof ready>((resolve) => {
      complete = resolve;
    }),
  );
  const { result, rerender } = renderHook(
    (props) => useLocalStudyTarget(props),
    { initialProps: identity },
  );
  let pending: Promise<void> = Promise.resolve();
  act(() => {
    pending = result.current.setup("chat");
  });
  rerender({ ...identity, userId: "other" });
  await act(async () => {
    complete?.(ready);
    await pending;
  });
  expect(result.current.resolveSendTarget("chat")).toBeNull();
  expect(result.current.requested).toBe(false);
});
it("keeps an explicit local request blocked after expiry or failure", async () => {
  request.mockResolvedValue({
    ...ready,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const { result } = renderHook(() => useLocalStudyTarget(identity));
  await act(() => result.current.setup("chat"));
  expect(result.current.requested).toBe(true);
  expect(result.current.resolveSendTarget("chat")).toBeNull();
  request.mockRejectedValue(new Error("Permission denied"));
  await act(() => result.current.setup("chat"));
  expect(result.current.error).toBe("Permission denied");
  expect(result.current.requested).toBe(true);
  act(() => result.current.useCloud("chat"));
  expect(result.current.requested).toBe(true);
  act(() => result.current.useCloud("other"));
  expect(result.current.requested).toBe(false);
});

it("keeps bound chats blocked after revocation and permits cloud in a new chat", async () => {
  const { result } = renderHook(() => useLocalStudyTarget(identity));
  await act(() => result.current.setup("chat"));
  act(() => result.current.useCloud("chat"));
  expect(result.current.requested).toBe(true);
  act(() => result.current.clearGrant());
  expect(result.current.ready).toBeUndefined();
  expect(result.current.isBoundConversation("chat")).toBe(true);
  expect(result.current.resolveSendTarget("chat")).toBeNull();
  expect(result.current.isBoundConversation("new-chat")).toBe(false);
  act(() => result.current.useCloud("new-chat"));
  expect(result.current.requested).toBe(false);
});
