import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaseStepsDraft } from "../case-steps/case-step-edits";
import { useCaseChecksAutosave } from "../case-steps/use-case-checks-autosave";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const draft: CaseStepsDraft = {
  title: "t",
  runs: 1,
  steps: [],
  expectedOutput: "",
  toolsChoice: "unset",
  stashedTools: [],
};

describe("useCaseChecksAutosave", () => {
  it("runs two quick saves one after the other, newest last", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const updateTestCase = vi.fn(
      (args: Record<string, unknown>) =>
        new Promise<void>((resolve) => {
          order.push(JSON.stringify(args.judgeConfigOverride));
          release = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useCaseChecksAutosave({
        testCaseId: "tc1",
        draft,
        readOnly: false,
        updateTestCase,
      }),
    );
    act(() => {
      result.current.saveChecks({
        judgeConfigOverride: { goalCompletion: { enabled: false } },
      });
      result.current.saveChecks({ judgeConfigOverride: undefined });
    });
    expect(result.current.checksSaveStatus).toBe("Saving…");
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateTestCase).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(updateTestCase).toHaveBeenCalledTimes(2);
    expect(order.at(-1)).toBe("null");
  });

  it("shows the retry toast when a save fails", async () => {
    const updateTestCase = vi.fn(async () => {
      throw new Error("nope");
    });
    const { result } = renderHook(() =>
      useCaseChecksAutosave({
        testCaseId: "tc1",
        draft,
        readOnly: false,
        updateTestCase,
      }),
    );
    await act(async () => {
      result.current.saveChecks({});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.checksSaveStatus).toBe(
      "Changes could not be saved. Edit again or retry.",
    );
    expect(toast.error.mock.lastCall![1].action.label).toBe("Retry");
  });

  it("refuses an incomplete assertion without calling the mutation", () => {
    const updateTestCase = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useCaseChecksAutosave({
        testCaseId: "tc1",
        draft,
        readOnly: false,
        updateTestCase,
      }),
    );
    act(() => {
      result.current.saveChecks({
        predicates: {
          mode: "extend",
          list: [{ type: "responseContains", needle: "" }],
        },
      });
    });
    expect(updateTestCase).not.toHaveBeenCalled();
    expect(result.current.checksSaveStatus).toBe(
      "Complete the assertion fields to save your changes.",
    );
  });
});
