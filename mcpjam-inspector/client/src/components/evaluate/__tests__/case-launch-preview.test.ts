import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ConvexError } from "convex/values";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { refuseCaseSave } from "../../evals/case-save-feedback";
import type { EvalCase, EvalSuite } from "../../evals/types";
import {
  caseLaunchTarget,
  savedCaseTargets,
  startCaseReview,
} from "../case-workspace/case-launch-preview";
import {
  beginCaseLaunch,
  trackCaseLaunchTarget,
  useCaseLaunches,
} from "../case-workspace/pending-case-launches";

vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
const suite = {
  _id: "suite",
  projectId: "project",
  hostAttachments: [{ namedHostId: "a" }, { namedHostId: "b" }],
} as EvalSuite;
const cases = [
  { _id: "case", models: [{ model: "alpha" }, { model: "beta" }] },
] as EvalCase[];
const props = {
  suite,
  cases,
  hostNamesById: new Map([
    ["a", "Claude"],
    ["b", "ChatGPT"],
  ]),
};
beforeEach(() => {
  useCaseLaunches.setState({ launches: [] });
  vi.clearAllMocks();
});

it("labels an inherited model with the known client model", () => {
  expect(
    caseLaunchTarget({ hostId: "a" }, props.hostNamesById, "haiku"),
  ).toMatchObject({
    model: "haiku",
    clientDefault: true,
  });
});

it("removes every model of a failed legacy host without removing another host", async () => {
  const targets = savedCaseTargets(props);
  const id = beginCaseLaunch(
    { projectId: "project", suiteId: "suite", caseId: "case" },
    targets,
    2,
  );
  await trackCaseLaunchTarget(id, 1, Promise.resolve({ runId: "accepted-b" }));
  await expect(
    trackCaseLaunchTarget(id, 0, Promise.reject(new Error("Offline"))),
  ).rejects.toThrow("Offline");
  const rows = useCaseLaunches.getState().launches[0].rows;
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.model)).toEqual([
    "alpha",
    "alpha",
    "beta",
    "beta",
  ]);
  expect(
    rows.every(
      (row) => row.client === "ChatGPT" && row.suiteRunId === "accepted-b",
    ),
  ).toBe(true);
});

it("reports preparation or save errors through the submission toast after closing", async () => {
  const onClose = vi.fn();
  const onStart = vi.fn(async () => {
    throw new Error("Save the test case before running.");
  });
  await startCaseReview(
    { ...props, onClose, onStart },
    savedCaseTargets(props),
    1,
  );
  expect(onClose).toHaveBeenCalledOnce();
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
    onStart.mock.invocationCallOrder[0],
  );
  const id = vi.mocked(toast.loading).mock.calls[0][1]?.id;
  expect(id).toEqual(expect.any(String));
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    "Save the test case before running.",
    { id },
  );
  expect(useCaseLaunches.getState().launches).toEqual([]);
});

it("does not invent model variants for a model-free case", () => {
  const modelFree = [
    {
      ...cases[0],
      steps: [
        { id: "assert", kind: "assert", assertion: { type: "noToolCalls" } },
      ],
    },
  ] as EvalCase[];
  const targets = savedCaseTargets({ ...props, cases: modelFree });
  expect(targets.map((target) => target.model)).toEqual([
    "Client default",
    "Client default",
  ]);
});

it.each([
  "Complete the highlighted fields before saving.",
  "Add a user turn before this assertion.",
  getBillingErrorMessage(
    new ConvexError({ code: "COLLABORATIVE_EDITING_REQUIRED" }),
    "Failed to save changes",
  ),
])(
  "keeps the specific quiet-save reason in one post-close toast: %s",
  async (message) => {
    const onClose = vi.fn();
    await startCaseReview(
      {
        ...props,
        onClose,
        onStart: async () => {
          expect(onClose).toHaveBeenCalledOnce();
          refuseCaseSave(message, true);
        },
      },
      savedCaseTargets(props),
      1,
    );
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(message, {
      id: vi.mocked(toast.loading).mock.calls[0][1]?.id,
    });
    expect(useCaseLaunches.getState().launches).toEqual([]);
  },
);

it("reports direct save refusals without throwing", () => {
  expect(refuseCaseSave("Fix this field.", false)).toBe(false);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("Fix this field.");
});

it("settles the startup toast on success", async () => {
  await startCaseReview(
    {
      ...props,
      onClose: vi.fn(),
      onStart: async (_suite, options) => {
        toast.success("Run started.", { id: options?.caseLaunchId });
      },
    },
    savedCaseTargets(props),
    1,
  );
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("Run started.", {
    id: vi.mocked(toast.loading).mock.calls[0][1]?.id,
  });
  expect(useCaseLaunches.getState().launches[0].starting).toBe(false);
  expect(toast.error).not.toHaveBeenCalled();
});

it("keeps accepted placeholders after partial failure and settles the same toast", async () => {
  await startCaseReview(
    {
      ...props,
      onClose: vi.fn(),
      onStart: async (_suite, options) => {
        await trackCaseLaunchTarget(
          options?.caseLaunchId,
          0,
          Promise.resolve({ runId: "accepted" }),
        );
        await expect(
          trackCaseLaunchTarget(
            options?.caseLaunchId,
            1,
            Promise.reject(new Error("Offline")),
          ),
        ).rejects.toThrow("Offline");
        toast.error("One client could not start.", {
          id: options?.caseLaunchId,
        });
      },
    },
    savedCaseTargets(props),
    1,
  );
  expect(
    useCaseLaunches
      .getState()
      .launches[0].rows.every((row) => row.suiteRunId === "accepted"),
  ).toBe(true);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    "One client could not start.",
    {
      id: vi.mocked(toast.loading).mock.calls[0][1]?.id,
    },
  );
});
