import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  checklistProgressKey,
  updateChecklistProgress,
  useChecklistProgress,
} from "../checklist-progress";
import {
  consumeHomeChecklistAutorun,
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
  it("is read once", () => {
    writeHomeChecklistAutorun({ prompt: "What can this server do?", progressKey: "k" });
    expect(consumeHomeChecklistAutorun()).toEqual({
      prompt: "What can this server do?",
      progressKey: "k",
    });
    expect(consumeHomeChecklistAutorun()).toBeNull();
  });
});
