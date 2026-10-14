import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ConvexError } from "convex/values";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  CASE_SAVE_FAILURE_MESSAGE,
  refuseCaseSave,
  refuseInvalidCaseSave,
} from "../../evals/case-save-feedback";
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
    throw new Error(CASE_SAVE_FAILURE_MESSAGE);
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
    "We couldn’t save this test. Check its settings and try again.",
    { id },
  );
  expect(useCaseLaunches.getState().launches).toEqual([]);
});

it("saves the clicked draft after closing and before any launch work", async () => {
  const onClose = vi.fn();
  const saveBeforeRun = vi.fn(async () => true);
  const onStart = vi.fn(async () => {});
  await startCaseReview(
    { ...props, onClose, onStart, saveBeforeRun },
    savedCaseTargets(props),
    1,
  );
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
    saveBeforeRun.mock.invocationCallOrder[0],
  );
  expect(saveBeforeRun.mock.invocationCallOrder[0]).toBeLessThan(
    onStart.mock.invocationCallOrder[0],
  );
  expect(toast.error).not.toHaveBeenCalled();
});

it("launches nothing when the save is refused", async () => {
  const onStart = vi.fn();
  await startCaseReview(
    { ...props, onClose: vi.fn(), onStart, saveBeforeRun: async () => false },
    savedCaseTargets(props),
    1,
  );
  expect(onStart).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    CASE_SAVE_FAILURE_MESSAGE,
    { id: vi.mocked(toast.loading).mock.calls[0][1]?.id },
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

it.each([
  "Choose whether this test uses tools.",
  "Add a user turn before this assertion.",
])(
  "uses the agreed save message for invalid startup settings: %s",
  async (reason) => {
    await startCaseReview(
      {
        ...props,
        onClose: vi.fn(),
        onStart: async () => {
          refuseInvalidCaseSave(reason, true);
        },
      },
      savedCaseTargets(props),
      1,
    );
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "We couldn’t save this test. Check its settings and try again.",
      { id: vi.mocked(toast.loading).mock.calls[0][1]?.id },
    );
  },
);

it("uses the save fallback for a save error without a readable message", async () => {
  await startCaseReview(
    {
      ...props,
      onClose: vi.fn(),
      onStart: async () => {
        refuseCaseSave(
          getBillingErrorMessage(new Error(""), CASE_SAVE_FAILURE_MESSAGE),
          true,
        );
      },
    },
    savedCaseTargets(props),
    1,
  );
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    "We couldn’t save this test. Check its settings and try again.",
    { id: vi.mocked(toast.loading).mock.calls[0][1]?.id },
  );
});

it("keeps detailed validation feedback for a direct save", () => {
  expect(
    refuseInvalidCaseSave("Choose whether this test uses tools.", false),
  ).toBe(false);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    "Choose whether this test uses tools.",
  );
});

it.each([
  {
    name: "iteration quota without a message",
    payload: {
      code: "billing_limit_reached",
      limitName: "maxEvalIterationsPerMonth",
      allowedValue: 100,
    },
    expected:
      "This organization has reached its eval iteration limit (100). Upgrade to continue.",
  },
  {
    name: "iteration quota with a readable message",
    payload: {
      code: "billing_limit_reached",
      limit: "maxEvalIterationsPerMonth",
      message: "Eval iteration limit reached on the free plan (100 per day).",
    },
    expected: "Eval iteration limit reached on the free plan (100 per day).",
  },
  {
    name: "credit limit with a readable message",
    payload: {
      code: "billing_limit_reached",
      message: "You’ve used your available credits.",
    },
    expected: "You’ve used your available credits.",
  },
  {
    name: "another quota without a message",
    payload: {
      code: "billing_limit_reached",
      limitName: "maxEvalRunsPerMonth",
      allowedValue: 20,
    },
    expected:
      "This organization has reached its monthly eval run limit (20). Upgrade to continue.",
  },
])(
  "formats a billing quota refusal like every other launch: $name",
  async ({ payload, expected }) => {
    await startCaseReview(
      {
        ...props,
        onClose: vi.fn(),
        onStart: async () => {
          throw new ConvexError(payload);
        },
      },
      savedCaseTargets(props),
      1,
    );
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(expected, {
      id: vi.mocked(toast.loading).mock.calls[0][1]?.id,
    });
    expect(useCaseLaunches.getState().launches).toEqual([]);
  },
);

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
