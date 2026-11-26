import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_STAR_PROMPT_STORAGE_KEY,
  closeGitHubStarPrompt,
  recordGitHubStarPromptUse,
  requestGitHubStarPrompt,
  useGitHubStarPrompt,
  useGitHubStarPromptOnReturn,
} from "../github-star-prompt";

function reset() {
  act(() => closeGitHubStarPrompt());
  localStorage.clear();
}

beforeEach(() => {
  reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("github star prompt", () => {
  it("keeps the first request and ignores the rest", () => {
    const { result } = renderHook(() => useGitHubStarPrompt());
    act(() => {
      requestGitHubStarPrompt({ trigger: "oauth", reason: "completed" });
      requestGitHubStarPrompt({ trigger: "xaa", reason: "completed" });
    });
    expect(result.current).toEqual({ trigger: "oauth", reason: "completed" });
  });

  it("never asks a browser twice, whichever flow asks", () => {
    const { result } = renderHook(() => useGitHubStarPrompt());
    act(() => {
      requestGitHubStarPrompt({
        trigger: "conformance",
        reason: "completed",
        hasAdvice: false,
      });
      closeGitHubStarPrompt();
    });
    expect(localStorage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY)).toBe("asked");
    act(() =>
      requestGitHubStarPrompt({ trigger: "oauth", reason: "completed" }),
    );
    expect(result.current).toBeNull();
  });

  it("does not ask on the day a debugger is first used", () => {
    const { result } = renderHook(() => {
      useGitHubStarPromptOnReturn("oauth");
      return useGitHubStarPrompt();
    });
    act(() => recordGitHubStarPromptUse("oauth"));
    renderHook(() => useGitHubStarPromptOnReturn("oauth"));
    expect(result.current).toBeNull();
  });

  it("asks when the debugger opens on a later day", () => {
    recordGitHubStarPromptUse("xaa");
    vi.setSystemTime(new Date(2026, 10, 20, 9));
    recordGitHubStarPromptUse("xaa");
    const { result } = renderHook(() => {
      useGitHubStarPromptOnReturn("xaa");
      return useGitHubStarPrompt();
    });
    expect(result.current).toEqual({ trigger: "xaa", reason: "return_visit" });
  });

  it("does not count use of the other debugger as a return", () => {
    recordGitHubStarPromptUse("xaa");
    vi.setSystemTime(new Date(2026, 10, 20, 9));
    const { result } = renderHook(() => {
      useGitHubStarPromptOnReturn("oauth");
      return useGitHubStarPrompt();
    });
    expect(result.current).toBeNull();
  });
});
