/**
 * A submission's test plan on the Readiness page: read, drafted and edited
 * without saving, saved at the revision the edits were made on, and what a
 * refused save shows.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  draftDirectoryTestPlan,
  type DirectoryTestPlan,
} from "@mcpjam/sdk/browser";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import { useDirectoryTestPlan } from "../use-directory-test-plan";

const api = vi.hoisted(() => ({
  getTestPlan: vi.fn(),
  draftTestPlan: vi.fn(),
  saveTestPlan: vi.fn(),
  getToolTests: vi.fn(),
}));
vi.mock("@/lib/apis/directory-test-plan-api", () => api);

const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };
const PLAN = draftDirectoryTestPlan([
  { name: "search_docs", annotations: { readOnlyHint: true } },
]);
const CATALOG = { revisionNumber: 7, capturedAt: 4 };
const MISSING = {
  code: "argumentsMissing",
  message: "Case search_docs#valid has no arguments yet. Draft or enter them.",
  caseId: "search_docs#valid",
};

function saved(revision: number, plan: DirectoryTestPlan = PLAN) {
  const counts = { tools: 1, cases: 1, fixtures: 0, cleanup: 0 };
  const base = { submissionId: "sub_1", revision, counts, savedBy: "user_1" };
  return { ...base, savedAt: 5, plan, issues: [MISSING], catalog: CATALOG };
}

const withArguments = (plan: DirectoryTestPlan): DirectoryTestPlan => ({
  ...plan,
  cases: plan.cases.map((entry) => ({ ...entry, arguments: { q: "pricing" } })),
});

function refusal(status: number, message: string, details?: object) {
  return new PlatformApiError(
    message,
    status === 409 ? "CONFLICT" : "VALIDATION_ERROR",
    {
      status,
      details: details as Record<string, unknown> | undefined,
      codeSource: "envelope",
    },
  );
}

function open(runKey = "run_1:run_1:done") {
  return renderHook(
    ({ key }: { key: string }) =>
      useDirectoryTestPlan({ ...SCOPE, runKey: key }),
    { initialProps: { key: runKey } },
  );
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getTestPlan.mockResolvedValue(saved(2));
  api.getToolTests.mockResolvedValue({ run: null, tools: [], inDoubt: [] });
});

describe("useDirectoryTestPlan", () => {
  it("reads the saved plan, and the results once the submission is read", async () => {
    const hook = open("");
    await waitFor(() => expect(hook.result.current.saved?.revision).toBe(2));
    expect(hook.result.current.plan).toEqual(PLAN);
    expect(hook.result.current.issues).toEqual([MISSING]);
    expect(api.getToolTests).not.toHaveBeenCalled();
    hook.rerender({ key: "run_1:run_1:done" });
    await waitFor(() => expect(api.getToolTests).toHaveBeenCalledTimes(1));
    expect(api.getTestPlan).toHaveBeenCalledTimes(1);
  });

  it("drafts a first plan without saving it", async () => {
    api.getTestPlan.mockResolvedValue(null);
    api.draftTestPlan.mockResolvedValue({
      plan: PLAN,
      issues: [MISSING],
      catalog: CATALOG,
      currentRevision: 0,
    });
    const hook = open();
    await waitFor(() => expect(hook.result.current.saved).toBeNull());
    expect(hook.result.current.plan).toBeNull();
    await act(() => hook.result.current.draft());
    expect(hook.result.current.edited).toEqual(PLAN);
    expect(hook.result.current).toMatchObject({ base: 0, issues: [MISSING] });
    expect(api.saveTestPlan).not.toHaveBeenCalled();
  });

  it("saves edits at the revision they were made on, as the next revision", async () => {
    const hook = open();
    await waitFor(() => expect(hook.result.current.saved?.revision).toBe(2));
    act(() => hook.result.current.edit(withArguments));
    const { plan: _plan, ...revision } = saved(3);
    api.saveTestPlan.mockResolvedValue({ ...revision, issues: [] });
    await act(() => hook.result.current.save());
    expect(api.saveTestPlan).toHaveBeenCalledWith(
      SCOPE,
      2,
      withArguments(PLAN),
    );
    expect(hook.result.current.saved).toMatchObject({
      revision: 3,
      plan: withArguments(PLAN),
    });
    expect(hook.result.current).toMatchObject({
      edited: null,
      base: 3,
      issues: [],
    });
  });

  it("keeps the edits when another revision was saved first, until the person loads it", async () => {
    const hook = open();
    await waitFor(() => expect(hook.result.current.saved?.revision).toBe(2));
    act(() => hook.result.current.edit(withArguments));
    api.saveTestPlan.mockRejectedValue(
      refusal(409, "The test plan changed since you read it.", {
        currentRevision: 4,
      }),
    );
    await act(() => hook.result.current.save());
    expect(hook.result.current.conflict).toBe(4);
    expect(hook.result.current.edited).toEqual(withArguments(PLAN));
    api.getTestPlan.mockResolvedValue(saved(4));
    await act(() => hook.result.current.discard());
    expect(hook.result.current).toMatchObject({
      edited: null,
      conflict: null,
      base: 4,
    });
    expect(hook.result.current.saved?.revision).toBe(4);
  });

  it("marks the issues a plan over a limit was refused with", async () => {
    const hook = open();
    await waitFor(() => expect(hook.result.current.saved?.revision).toBe(2));
    act(() => hook.result.current.edit(withArguments));
    const over = {
      code: "limit",
      message: "Concurrency must be a whole number from 1 to 4.",
    };
    api.saveTestPlan.mockRejectedValue(
      refusal(400, "The test plan was not saved.", { issues: [over] }),
    );
    await act(() => hook.result.current.save());
    expect(hook.result.current.issues).toEqual([over]);
    expect(hook.result.current.error).toBe(
      "The plan was not saved. Fix the issues marked below, then save it again.",
    );
  });

  it("says how to get a tool list when MCPJam has none to check the plan against", async () => {
    const hook = open();
    await waitFor(() => expect(hook.result.current.saved?.revision).toBe(2));
    act(() => hook.result.current.edit(withArguments));
    api.saveTestPlan.mockRejectedValue(
      refusal(
        409,
        "MCPJam has no stored tool list for this server yet. Connect the server in MCPJam, then try again.",
      ),
    );
    await act(() => hook.result.current.save());
    expect(hook.result.current.conflict).toBeNull();
    expect(hook.result.current.error).toBe(
      "The plan was not saved. MCPJam has no stored tool list for this server yet. Connect the server in MCPJam, then try again.",
    );
  });

  it("reads the plan and results again when the run changes, keeping the edits", async () => {
    const hook = open();
    await waitFor(() => expect(api.getToolTests).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.edit(withArguments));
    api.getTestPlan.mockResolvedValue(saved(5));
    hook.rerender({ key: "run_2:run_1:running" });
    await waitFor(() => expect(hook.result.current.saved?.revision).toBe(5));
    expect(api.getToolTests).toHaveBeenCalledTimes(2);
    expect(hook.result.current.edited).toEqual(withArguments(PLAN));
    expect(hook.result.current.base).toBe(2);
  });
});
