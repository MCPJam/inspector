import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  checklistProgressKey,
  updateChecklistProgress,
  useChecklistProgress,
} from "../checklist-progress";
import {
  clearHomeChecklistAutorun,
  readHomeChecklistAutorun,
  writeHomeChecklistAutorun,
} from "../playground-autorun";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("checklist progress", () => {
  it("keeps progress per user and project", () => {
    const key = checklistProgressKey("me", "p1");
    const { result } = renderHook(() => useChecklistProgress(key));
    act(() => updateChecklistProgress(key, { chat: true }));
    expect(result.current.progress).toEqual({ chat: true });
    act(() => result.current.update({ agent: true }));
    expect(result.current.progress).toEqual({ chat: true, agent: true });
    expect(
      renderHook(() => useChecklistProgress(checklistProgressKey("me", "p2")))
        .result.current.progress,
    ).toEqual({});
  });
});

describe("Playground autorun handoff", () => {
  it("stays until cleared, so a remount still sees it", () => {
    writeHomeChecklistAutorun({ prompt: "What can this server do?", progressKey: "k" });
    expect(readHomeChecklistAutorun()).toEqual({
      prompt: "What can this server do?",
      progressKey: "k",
    });
    expect(readHomeChecklistAutorun()).not.toBeNull();
    clearHomeChecklistAutorun();
    expect(readHomeChecklistAutorun()).toBeNull();
  });

  it("ignores a prompt left unsent for too long", () => {
    vi.useFakeTimers();
    try {
      writeHomeChecklistAutorun({ prompt: "What can this server do?", progressKey: "k" });
      vi.advanceTimersByTime(6 * 60_000);
      expect(readHomeChecklistAutorun()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
