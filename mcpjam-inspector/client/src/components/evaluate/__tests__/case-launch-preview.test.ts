import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { EvalCase, EvalSuite } from "../../evals/types";
import {
  savedCaseTargets,
  startCaseReview,
} from "../case-workspace/case-launch-preview";
import {
  beginCaseLaunch,
  trackCaseLaunchTarget,
  useCaseLaunches,
} from "../case-workspace/pending-case-launches";

vi.mock("sonner", () => ({ toast: { loading: vi.fn(), error: vi.fn() } }));
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
