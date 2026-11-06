import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import type { EvalSuite } from "@/components/evals/types";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  mutationName: [] as string[],
  toast: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    mocks.mutationName.push(getFunctionName(ref));
    return mocks.mutation;
  },
}));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign((...args: unknown[]) => mocks.toast(...args), {
    error: (...args: unknown[]) => mocks.toastError(...args),
  }),
}));

import {
  buildCopyTargets,
  copiedToastTitle,
  copyTestCaseToSuiteRef,
  useCopyTestCase,
} from "../use-copy-test-case";

const suite = (id: string, extra: Partial<EvalSuite> = {}): EvalSuite => ({
  _id: id,
  createdBy: "u",
  name: `Suite ${id}`,
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
  ...extra,
});

const target = { suiteId: "s2", name: "Asana SDK ingestion", locked: false };
const testCase = { caseId: "c1", title: "Draw a rectangle" };

beforeEach(() => {
  mocks.mutation.mockReset();
  mocks.mutationName.length = 0;
  mocks.toast.mockReset();
  mocks.toastError.mockReset();
});

describe("buildCopyTargets (P-2, P-3)", () => {
  it("drops the current suite, keeps order, and locks CI-owned suites", () => {
    expect(
      buildCopyTargets(
        [
          suite("a"),
          suite("current"),
          suite("ci", { declaredSuiteId: "from-file" }),
          suite("b"),
        ],
        "current",
      ),
    ).toEqual([
      { suiteId: "a", name: "Suite a", locked: false },
      { suiteId: "ci", name: "Suite ci", locked: true },
      { suiteId: "b", name: "Suite b", locked: false },
    ]);
  });
});

describe("useCopyTestCase", () => {
  it("calls testCaseCopy:copyTestCaseToSuite once and toasts the source title (P-5, P-6)", async () => {
    mocks.mutation.mockResolvedValue({
      testCaseId: "copy-1",
      title: "Draw a rectangle (copy)",
    });
    const onOpenCopy = vi.fn();
    const { result } = renderHook(() => useCopyTestCase({ onOpenCopy }));
    expect(getFunctionName(copyTestCaseToSuiteRef)).toBe(
      "testCaseCopy:copyTestCaseToSuite",
    );
    expect(mocks.mutationName).toContain("testCaseCopy:copyTestCaseToSuite");

    await act(() => result.current.copy(testCase, target));

    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    expect(mocks.mutation).toHaveBeenCalledWith({
      testCaseId: "c1",
      targetSuiteId: "s2",
    });
    const [title, options] = mocks.toast.mock.calls[0];
    expect(title).toBe("Copied “Draw a rectangle” to Asana SDK ingestion");
    expect(title).toBe(copiedToastTitle("Draw a rectangle", target.name));
    expect(options.description).toBe("Runs were not copied.");
    expect(options.action.label).toBe("Open copy");
    expect(options.classNames.actionButton).toContain("!text-primary");
    options.action.onClick();
    expect(onOpenCopy).toHaveBeenCalledWith({
      suiteId: "s2",
      testCaseId: "copy-1",
    });
  });

  it("marks the row pending and refuses a second copy while one is in flight", async () => {
    let resolve: (value: { testCaseId: string; title: string }) => void = () =>
      undefined;
    mocks.mutation.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() =>
      useCopyTestCase({ onOpenCopy: vi.fn() }),
    );
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.copy(testCase, target);
    });
    expect(result.current.pendingCaseId).toBe("c1");
    await act(() => result.current.copy(testCase, target));
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ testCaseId: "copy-1", title: "x" });
      await first;
    });
    expect(result.current.pendingCaseId).toBeNull();
  });

  it("shows a ConvexError's own message (P-7)", async () => {
    mocks.mutation.mockRejectedValue(
      new ConvexError({
        code: "CI_OWNED_SUITE_READ_ONLY",
        message:
          "Could not copy to Asana SDK ingestion. It runs from CI, so edit its cases in the repo.",
      }),
    );
    const { result } = renderHook(() =>
      useCopyTestCase({ onOpenCopy: vi.fn() }),
    );
    await act(() => result.current.copy(testCase, target));
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Could not copy to Asana SDK ingestion. It runs from CI, so edit its cases in the repo.",
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("falls back to its own sentence when the error says nothing (P-7)", async () => {
    mocks.mutation.mockRejectedValue(new Error(""));
    const { result } = renderHook(() =>
      useCopyTestCase({ onOpenCopy: vi.fn() }),
    );
    await act(() => result.current.copy(testCase, target));
    expect(mocks.toastError.mock.calls[0][0]).toContain(
      "Could not copy “Draw a rectangle” to Asana SDK ingestion. Try again.",
    );
  });

  it("never copies into a locked target", async () => {
    const { result } = renderHook(() =>
      useCopyTestCase({ onOpenCopy: vi.fn() }),
    );
    await act(() => result.current.copy(testCase, { ...target, locked: true }));
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
