import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHistoryTarget } from "../use-history-target";

describe("useHistoryTarget", () => {
  it("matches only the thread that is open now", () => {
    const { result, rerender } = renderHook(
      ({ chatSessionId, projectId }) => useHistoryTarget(chatSessionId, projectId),
      { initialProps: { chatSessionId: "chat-1", projectId: "p1" as string | null } },
    );
    const isOpen = result.current;
    expect(isOpen({ chatSessionId: "chat-1", projectId: "p1" })).toBe(true);
    expect(isOpen({ chatSessionId: "chat-1", projectId: null })).toBe(false);

    rerender({ chatSessionId: "chat-2", projectId: "p1" });
    // The same function, so callbacks that hold it stay stable.
    expect(result.current).toBe(isOpen);
    expect(isOpen({ chatSessionId: "chat-1", projectId: "p1" })).toBe(false);
    expect(isOpen({ chatSessionId: "chat-2", projectId: "p1" })).toBe(true);
  });
});
