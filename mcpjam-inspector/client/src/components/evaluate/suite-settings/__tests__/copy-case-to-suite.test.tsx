import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteOverviewEntry,
} from "../../../evals/types";
import {
  CI_LOCKED_COPY_TARGET_REASON,
  CopyCaseMenu,
  copyTargets,
  useCopyCaseToSuite,
} from "../copy-case-to-suite";

const duplicate = vi.fn();
const overview: { value: EvalSuiteOverviewEntry[] | undefined } = {
  value: undefined,
};
vi.mock("convex/react", () => ({
  useQuery: () => overview.value,
  useMutation: () => duplicate,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

const suite = (id: string, name: string, extra: Partial<EvalSuite> = {}) =>
  ({
    _id: id,
    name,
    createdBy: "u",
    description: "",
    configRevision: "r",
    environment: { servers: [] },
    createdAt: 1,
    updatedAt: 1,
    source: "ui",
    ...extra,
  }) as EvalSuite;
const entry = (s: EvalSuite) => ({ suite: s }) as EvalSuiteOverviewEntry;
const testCase = { _id: "c_1", title: "Draw a rectangle" } as EvalCase;

const source = suite("s_1", "Excalidraw quickstart");
const asana = suite("s_2", "Asana SDK ingestion");
const ci = suite("s_3", "CI suite", { declaredSuiteId: "from_file" });

describe("copyTargets", () => {
  it("lists the other suites by name, CI-owned ones disabled", () => {
    const targets = copyTargets([source, ci, asana].map(entry), "s_1");
    expect(targets.map((t) => t.suite.name)).toEqual([
      "Asana SDK ingestion",
      "CI suite",
    ]);
    expect(targets[0].disabledReason).toBeUndefined();
    expect(targets[1].disabledReason).toBe(CI_LOCKED_COPY_TARGET_REASON);
  });
});

describe("useCopyCaseToSuite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overview.value = [source, asana].map(entry);
  });

  it("copies into the target, stays put, and links to the copy", async () => {
    duplicate.mockResolvedValue({ _id: "c_9", testSuiteId: "s_2" });
    const onOpenCopy = vi.fn();
    const { result } = renderHook(() =>
      useCopyCaseToSuite({
        projectId: "p_1",
        sourceSuiteId: "s_1",
        onOpenCopy,
      }),
    );
    await act(() => result.current.copyCase(testCase, asana));
    expect(duplicate).toHaveBeenCalledWith({
      testCaseId: "c_1",
      targetSuiteId: "s_2",
    });
    const [message, options] = toast.success.mock.lastCall ?? [];
    expect(message).toBe("Copied “Draw a rectangle” to Asana SDK ingestion.");
    expect(options.description).toBe("Runs were not copied.");
    options.action.onClick();
    expect(onOpenCopy).toHaveBeenCalledWith("s_2", "c_9");
    expect(track).toHaveBeenCalledWith(
      "eval_test_case_duplicated",
      expect.objectContaining({ new_test_case_id: "c_9" }),
    );
  });

  it("shows the backend's reason when the copy is refused", async () => {
    duplicate.mockRejectedValue(
      Object.assign(new Error("Server Error"), {
        data: {
          code: "COPY_TARGET_OTHER_PROJECT",
          message:
            "The test case wasn't copied because the target suite is in another project. Pick a suite in this project.",
        },
      }),
    );
    const { result } = renderHook(() =>
      useCopyCaseToSuite({
        projectId: "p_1",
        sourceSuiteId: "s_1",
        onOpenCopy: vi.fn(),
      }),
    );
    await act(() => result.current.copyCase(testCase, asana));
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("target suite is in another project"),
    );
    expect(result.current.copyingCaseId).toBeNull();
  });
});

describe("CopyCaseMenu", () => {
  it("offers each suite and disables CI-owned ones with the reason", async () => {
    const onCopy = vi.fn();
    render(
      <TooltipProvider>
        <CopyCaseMenu
          testCase={testCase}
          targets={copyTargets([asana, ci].map(entry), "s_1")}
          copying={false}
          onCopy={onCopy}
        />
      </TooltipProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy test case: Draw a rectangle" }),
    );
    expect(screen.getByText(CI_LOCKED_COPY_TARGET_REASON)).toBeTruthy();
    expect(
      screen
        .getByRole("menuitem", { name: /CI suite/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Asana SDK ingestion" }),
    );
    expect(onCopy).toHaveBeenCalledWith(testCase, asana);
  });
});
