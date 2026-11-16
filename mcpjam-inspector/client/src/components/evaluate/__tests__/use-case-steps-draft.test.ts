import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import type { TestStep } from "@/shared/steps";
import { withFailOnToolError } from "@/shared/tool-error-policy";
import { useCaseStepsDraft } from "../case-steps/use-case-steps-draft";

const state = vi.hoisted(() => ({
  suite: undefined as unknown,
  cases: undefined as unknown,
  update: vi.fn(),
  ciOwned: false,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (name: string) =>
    name === "testSuites:getTestSuite" ? state.suite : state.cases,
  useMutation: (name: string) =>
    name === "testSuites:updateTestCase" ? state.update : vi.fn(),
}));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({
    capabilities: { ownership: { ciOwned: state.ciOwned } },
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "List my workspaces" },
];

const suite = {
  _id: "suite-1",
  name: "Asana basics",
  defaultPredicates: [{ type: "noToolErrors" }],
} as unknown as EvalSuite;

const storedCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u1",
  title: "List workspaces",
  query: "List my workspaces",
  models: [{ model: "gpt-5-nano", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
  steps,
  ...over,
});

function renderDraft() {
  return renderHook(() =>
    useCaseStepsDraft({ suiteId: "suite-1", testCaseId: "case-1" }),
  );
}

beforeEach(() => {
  state.suite = suite;
  state.cases = [storedCase()];
  state.update = vi.fn().mockResolvedValue(null);
  state.ciOwned = false;
  toast.error.mockClear();
  toast.success.mockClear();
});

describe("useCaseStepsDraft", () => {
  it("is loading until the suite and its cases arrive", () => {
    state.cases = undefined;
    expect(renderDraft().result.current.status).toBe("loading");
  });

  it("is missing when the case is not in the suite", () => {
    state.cases = [];
    expect(renderDraft().result.current.status).toBe("missing");
  });

  it("seeds a clean draft and its scorecard from the stored case", async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.status).toBe("ready");
    expect(result.current.draft?.steps).toEqual(steps);
    expect(result.current.dirty).toBe(false);
    expect(result.current.card).not.toBeNull();
    expect(result.current.readOnly).toBe(false);
  });

  it("saves overrides the draft cleared as null, and becomes dirty first", async () => {
    state.cases = [
      storedCase({
        judgeConfigOverride: { goalCompletion: { enabled: false } },
      }),
    ];
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() =>
      result.current.setDraft((draft) => ({
        ...draft,
        judgeConfigOverride: undefined,
      })),
    );
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        testCaseId: "case-1",
        judgeConfigOverride: null,
        predicates: null,
        matchOptions: null,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Changes saved");
  });

  it("sends {} when the tool-error switch goes back on and nothing else is set", async () => {
    state.cases = [storedCase({ advancedConfig: { failOnToolError: false } })];
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() =>
      result.current.setDraft((draft) => ({
        ...draft,
        advancedConfig: withFailOnToolError(draft.advancedConfig, true),
      })),
    );
    await act(async () => {
      await result.current.save({ quiet: true });
    });
    expect(state.update.mock.lastCall?.[0].advancedConfig).toEqual({});
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("refuses to save an empty prompt and sends nothing", async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() =>
      result.current.setDraft((draft) => ({
        ...draft,
        steps: [{ id: "p1", kind: "prompt", prompt: " " }],
      })),
    );
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("is read-only for a CI-owned suite and never saves", async () => {
    state.ciOwned = true;
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.readOnly).toBe(true);
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("says why a failed save did not go through", async () => {
    state.update = vi.fn().mockRejectedValue(new Error("network"));
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(toast.error).toHaveBeenCalled();
  });
});
