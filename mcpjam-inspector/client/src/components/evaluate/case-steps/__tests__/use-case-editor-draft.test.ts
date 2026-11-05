import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { EvalCase } from "@/components/evals/types";
import { useCaseEditorDraft } from "../use-case-editor-draft";

const track = vi.fn();
const createTestCase = vi.fn();
const updateTestCase = vi.fn();
const toastError = vi.fn();
const storedCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  title: "Sketch a two-node flow",
  models: [{ provider: "openai", model: "openai/gpt-5.4-mini" }],
  steps: [{ id: "p1", kind: "prompt", prompt: "Sketch it" }],
  expectedOutput: "Two boxes",
  matchOptions: { toolCallOrder: "any" },
} as unknown as EvalCase;

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => track(...args),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "testSuites:getTestSuite")
      return { _id: "suite-1", name: "Excalidraw quickstart" };
    if (name === "testSuites:listTestCases") return [storedCase];
    return undefined;
  },
  useMutation: (ref: FunctionReference<"mutation">) =>
    getFunctionName(ref) === "testSuites:createTestCase"
      ? createTestCase
      : updateTestCase,
}));

describe("useCaseEditorDraft", () => {
  beforeEach(() => {
    track.mockClear();
    createTestCase.mockReset();
    updateTestCase.mockReset();
    toastError.mockClear();
  });

  it("updates an existing case and fires eval_test_case_edited", async () => {
    updateTestCase.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useCaseEditorDraft("suite-1", "case-1"),
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.update({ expectedOutput: "Three boxes" }));
    expect(result.current.isDirty).toBe(true);
    let saved: string | null = null;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe("case-1");
    expect(updateTestCase).toHaveBeenCalledWith(
      expect.objectContaining({
        testCaseId: "case-1",
        expectedOutput: "Three boxes",
      }),
    );
    expect(track).toHaveBeenCalledWith("eval_test_case_edited", {
      location: "case_steps_editor",
      suite_id: "suite-1",
      test_case_id: "case-1",
      num_models: 1,
      num_steps: 1,
      has_match_options: true,
      has_predicates: false,
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("creates a new case and fires eval_test_case_created", async () => {
    createTestCase.mockResolvedValue("case-2");
    const { result } = renderHook(() => useCaseEditorDraft("suite-1", null));
    act(() =>
      result.current.update({
        steps: [{ id: "p1", kind: "prompt", prompt: "Draw a box" }],
      }),
    );
    let saved: string | null = null;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe("case-2");
    expect(createTestCase).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        query: "Draw a box",
        models: storedCase.models,
      }),
    );
    expect(track).toHaveBeenCalledWith("eval_test_case_created", {
      location: "case_steps_editor",
      suite_id: "suite-1",
      test_case_id: "case-2",
      num_models: 1,
      num_steps: 1,
    });
  });

  it("refuses to save a case with an empty prompt", async () => {
    const { result } = renderHook(() => useCaseEditorDraft("suite-1", null));
    let saved: string | null = "unset";
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBeNull();
    expect(createTestCase).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
});
