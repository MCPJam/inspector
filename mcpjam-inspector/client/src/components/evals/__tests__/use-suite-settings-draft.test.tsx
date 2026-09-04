import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  initSuiteSettingsDraft,
  suiteSettingsReducer,
  type SuiteSettingsValues,
} from "../suite-settings-draft";
import { useSuiteSettingsCommit } from "../use-suite-settings-draft";

/**
 * What the commit hook REPORTS, not just what it sends.
 *
 * The hook has two paths — the composite mutation and the legacy fallback for
 * a deployment that predates it — and the fallback cannot carry every field.
 * The outcome it returns is what the caller rebases on, so a save that says
 * "saved" about a field it silently dropped is how an edit disappears while
 * its own toast promises the opposite.
 */

const mocks = vi.hoisted(() => ({
  applySuiteSettings: vi.fn(async () => ({ revisionNumber: 4 })),
  updateTestSuite: vi.fn(async () => ({})),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) =>
    name === "testSuites:applySuiteSettings"
      ? mocks.applySuiteSettings
      : mocks.updateTestSuite,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

const BASE: SuiteSettingsValues = {
  name: "Checkout suite",
  defaultPassCriteria: { minimumPassRate: 80 },
  minIterations: 3,
  computerEnvironmentId: undefined,
  defaultMatchOptions: undefined,
  defaultPredicates: [],
  judgeConfig: undefined,
  judgeRubric: undefined,
};

const RUBRIC = { criteria: [{ id: "crit_1", label: "Answers the question" }] };

function draftWithNameAndRubric() {
  let draft = initSuiteSettingsDraft({ suiteId: "suite-a", values: BASE });
  draft = suiteSettingsReducer(draft, {
    type: "edit",
    key: "name",
    value: "Renamed",
  });
  return suiteSettingsReducer(draft, {
    type: "edit",
    key: "judgeRubric",
    value: RUBRIC,
  });
}

const missingComposite = () =>
  new Error(
    "Could not find public function for 'testSuites:applySuiteSettings'",
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the legacy fallback tells the caller what it could not send", () => {
  it("names the dropped key so the edit stays retryable", async () => {
    mocks.applySuiteSettings.mockRejectedValueOnce(missingComposite());
    const { result } = renderHook(() => useSuiteSettingsCommit());

    let outcome!: Awaited<ReturnType<typeof result.current.commit>>;
    await act(async () => {
      outcome = await result.current.commit({
        draft: draftWithNameAndRubric(),
        suiteId: "suite-a",
      });
    });

    // The name travelled...
    const sent = mocks.updateTestSuite.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(sent.name).toBe("Renamed");
    expect("judgeRubric" in sent).toBe(false);

    // ...and the rubric is reported as NOT saved, which is what keeps it dirty
    // in the draft. Reporting a clean save here is the whole bug: the toast
    // says the field was kept, and the reducer then throws it away.
    expect(outcome).toEqual({
      status: "saved",
      revisionNumber: null,
      droppedKeys: ["judgeRubric"],
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("judgeRubric"),
    );
  });

  it("drops nothing when the draft has no unsupported field", async () => {
    mocks.applySuiteSettings.mockRejectedValueOnce(missingComposite());
    const { result } = renderHook(() => useSuiteSettingsCommit());

    let outcome!: Awaited<ReturnType<typeof result.current.commit>>;
    let draft = initSuiteSettingsDraft({ suiteId: "suite-a", values: BASE });
    draft = suiteSettingsReducer(draft, {
      type: "edit",
      key: "name",
      value: "Renamed",
    });
    await act(async () => {
      outcome = await result.current.commit({ draft, suiteId: "suite-a" });
    });

    expect(outcome).toEqual({
      status: "saved",
      revisionNumber: null,
      droppedKeys: [],
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Settings saved");
  });
});

describe("the composite path carries everything", () => {
  it("sends the rubric and drops nothing", async () => {
    const { result } = renderHook(() => useSuiteSettingsCommit());

    let outcome!: Awaited<ReturnType<typeof result.current.commit>>;
    await act(async () => {
      outcome = await result.current.commit({
        draft: draftWithNameAndRubric(),
        suiteId: "suite-a",
      });
    });

    const sent = mocks.applySuiteSettings.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(sent.judgeRubric).toEqual(RUBRIC);
    expect(outcome).toEqual({
      status: "saved",
      revisionNumber: 4,
      droppedKeys: [],
    });
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
  });
});
