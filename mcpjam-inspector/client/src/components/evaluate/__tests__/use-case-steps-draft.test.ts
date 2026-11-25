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
  create: vi.fn(),
  ciOwned: false,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (name: string) =>
    name === "testSuites:getTestSuite" ? state.suite : state.cases,
  useMutation: (name: string) =>
    name === "testSuites:updateTestCase" ? state.update : state.create,
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
  state.create = vi.fn().mockResolvedValue("new-case");
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

  it("runs one save at a time and reports it while it runs", async () => {
    let finish = () => {};
    state.update = vi.fn(
      () => new Promise<null>((resolve) => (finish = () => resolve(null))),
    );
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    let first: Promise<{ ok: boolean }> = Promise.resolve({ ok: false });
    let second: Promise<{ ok: boolean }> = first;
    act(() => {
      first = result.current.save();
      second = result.current.save();
    });
    expect(result.current.saving).toBe(true);
    await act(async () => {
      finish();
      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: false });
    });
    expect(state.update).toHaveBeenCalledOnce();
    expect(result.current.saving).toBe(false);
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

  it("takes a newer stored case when the draft has no edits, and keeps edits", async () => {
    const { result, rerender } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    state.cases = [storedCase({ title: "Renamed elsewhere" })];
    rerender();
    await waitFor(() =>
      expect(result.current.draft?.title).toBe("Renamed elsewhere"),
    );
    expect(result.current.dirty).toBe(false);
    act(() =>
      result.current.setDraft((draft) => ({ ...draft, scenario: "Mine" })),
    );
    state.cases = [storedCase({ title: "Renamed again" })];
    rerender();
    expect(result.current.draft?.scenario).toBe("Mine");
    expect(result.current.draft?.title).toBe("Renamed elsewhere");
    expect(result.current.dirty).toBe(true);
  });

  it("a New case reseeds when the suite changes", async () => {
    const { result, rerender } = renderHook(
      ({ suiteId }) => useCaseStepsDraft({ suiteId, testCaseId: null }),
      { initialProps: { suiteId: "suite-1" } },
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() =>
      result.current.setDraft((draft) => ({ ...draft, title: "Suite 1 case" })),
    );
    rerender({ suiteId: "suite-2" });
    await waitFor(() =>
      expect(result.current.draft?.title).not.toBe("Suite 1 case"),
    );
  });
});

describe("new test name conflicts", () => {
  it("requests server name validation and preserves the draft on rejection", async () => {
    const message =
      'A test named "List workspaces" already exists in this suite. Give this test a different name.';
    state.create.mockRejectedValue(
      Object.assign(new Error("Server Error"), {
        data: { code: "CONFLICT", field: "title", message },
      }),
    );
    const { result } = renderHook(() =>
      useCaseStepsDraft({ suiteId: "suite-1", testCaseId: null }),
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() =>
      result.current.setDraft((draft) => ({
        ...draft,
        title: "List workspaces",
        steps,
        toolsChoice: "noTool",
      })),
    );
    await act(async () => {
      expect(await result.current.save()).toEqual({ ok: false });
    });
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        title: "List workspaces",
        requireUniqueTitle: true,
      }),
    );
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.draft?.title).toBe("List workspaces");
    expect(result.current.saving).toBe(false);
    state.create.mockResolvedValue("new-case");
    act(() =>
      result.current.setDraft((draft) => ({
        ...draft,
        title: "List projects",
      })),
    );
    await act(async () => {
      expect(await result.current.save()).toEqual({
        ok: true,
        testCaseId: "new-case",
      });
    });
  });
});
