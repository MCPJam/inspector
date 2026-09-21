import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerEvalSuite,
  registerEvalDraft,
  isEvalContextReady,
  useEvalContextVersion,
  startEvalGeneration,
  useEvalGeneration,
  evalSuiteKey,
  editGeneratedDraft,
  saveGeneratedDraft,
  stageMarkdownDrafts,
  followAuthoringJob,
} from "../eval-workspace";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
const scope: EvalAgentScope = {
  kind: "evals",
  version: 1,
  id: "scope",
  projectId: "p",
  suiteId: "s",
  suiteName: "Suite",
};
const input = {
  suiteId: "s",
  caseId: "stable-case",
  title: "Generated",
  query: "Find a ticket",
  models: [],
  expectedToolCalls: [],
  runs: 1,
  isNegativeTest: false,
  steps: [{ id: "p1", kind: "prompt" as const, prompt: "Find a ticket" }],
};
beforeEach(() => useEvalGeneration.setState({ suites: {} }));

it("lets a newer authoring job take the suite over from an older one", async () => {
  // Opening a link to an older import while a newer one is being followed
  // pointed two pollers at one store key. The loser used to keep writing, so
  // the reader watched the job they had just opened get overwritten.
  const key = evalSuiteKey(scope);
  useEvalGeneration.setState({
    suites: {
      [key]: { status: "running", drafts: [], authoringJobId: "new" } as never,
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: { jobId: "old", status: "completed", drafts: [], warnings: [] },
    }),
  );
  try {
    await followAuthoringJob(
      { projectId: scope.projectId, suiteId: scope.suiteId },
      "old",
    );
    // The old job announced itself once — that write is what a takeover is
    // measured against — but never overwrote the newer job's outcome.
    expect(useEvalGeneration.getState().suites[key]?.status).toBe("running");
  } finally {
    fetchMock.mockRestore();
  }
});

it("clears a failed generation's error when an import stages its drafts", () => {
  const key = evalSuiteKey(scope);
  // Generation and import share this store. A generation failure used to keep
  // its message on screen above drafts that had just imported fine — and it
  // named a tool-coverage setting the import surface does not offer.
  useEvalGeneration.setState({
    suites: {
      [key]: {
        status: "ready",
        drafts: [],
        error:
          "No tools are marked read-only on these servers. Choose Read and write or add read-only tool annotations, then try again.",
      } as never,
    },
  });
  stageMarkdownDrafts(
    { projectId: scope.projectId, suiteId: scope.suiteId },
    [
      {
        title: "Imported case",
        prompt: "Browse the Grocery category.",
        expectedOutput: "The list renders.",
        issues: [],
        source: { fileName: "cases.md" },
      } as never,
    ],
    [],
  );
  const state = useEvalGeneration.getState().suites[key];
  expect(state.error).toBeUndefined();
  expect(state.drafts).toHaveLength(1);
});
describe("reviewable eval generation", () => {
  it("stages without saving, rejects duplicate jobs and out-of-suite edits, then commits once", async () => {
    let finish!: () => void;
    const save = vi.fn(async () => "saved-id");
    const cleanup = registerEvalSuite(scope, {
      read: () => ({}),
      save,
      generate: async (_instructions, stage) => {
        await stage(input);
        await new Promise<void>((r) => {
          finish = r;
        });
      },
    });
    startEvalGeneration(scope, "Failure paths");
    expect(() => startEvalGeneration(scope, "Again")).toThrow(
      "already running",
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(save).not.toHaveBeenCalled();
    const draft =
      useEvalGeneration.getState().suites[evalSuiteKey(scope)].drafts[0];
    expect(() =>
      editGeneratedDraft(
        { ...scope, suiteId: "other" },
        draft.id,
        draft.revision,
        { title: "wrong" },
      ),
    ).toThrow();
    editGeneratedDraft(scope, draft.id, draft.revision, { title: "Refined" });
    expect(() =>
      editGeneratedDraft(scope, draft.id, draft.revision, { title: "stale" }),
    ).toThrow();
    await Promise.all([
      saveGeneratedDraft(scope, draft.id),
      saveGeneratedDraft(scope, draft.id),
    ]);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Refined", caseId: "stable-case" }),
    );
    expect(
      useEvalGeneration.getState().suites[evalSuiteKey(scope)].drafts,
    ).toHaveLength(0);
    finish();
    cleanup();
  });
  it("preserves generated drafts after a failed commit", async () => {
    const cleanup = registerEvalSuite(scope, {
      read: () => ({}),
      generate: async (_i, stage) => {
        await stage(input);
      },
      save: async () => {
        throw new Error("Offline");
      },
    });
    startEvalGeneration(scope, "Main workflow");
    await vi.waitFor(() =>
      expect(
        useEvalGeneration.getState().suites[evalSuiteKey(scope)].status,
      ).toBe("ready"),
    );
    const draft =
      useEvalGeneration.getState().suites[evalSuiteKey(scope)].drafts[0];
    await saveGeneratedDraft(scope, draft.id);
    expect(
      useEvalGeneration.getState().suites[evalSuiteKey(scope)].drafts[0],
    ).toMatchObject({ saving: false, error: "Offline" });
    cleanup();
  });
});

it("waits for the exact case context and recovers when its bridges register", () => {
  const target = {
    ...scope,
    suiteId: "loading-suite",
    caseId: "draft:describe",
  };
  expect(isEvalContextReady(target)).toBe(false);
  const changed = vi.fn();
  const unsubscribe = useEvalContextVersion.subscribe(changed);
  const removeSuite = registerEvalSuite(target, {
    read: () => ({}),
    generate: vi.fn(),
    save: vi.fn(),
  });
  expect(isEvalContextReady(target)).toBe(false);
  const removeDraft = registerEvalDraft(target, {
    read: () => ({
      draft: { title: "New case", steps: [] },
      revision: "1",
      tools: [],
    }),
    edit: vi.fn(),
    undo: vi.fn(),
  });
  expect(isEvalContextReady(target)).toBe(true);
  expect(isEvalContextReady({ ...target, caseId: "another-case" })).toBe(false);
  removeDraft();
  expect(isEvalContextReady(target)).toBe(false);
  removeSuite();
  expect(changed).toHaveBeenCalledTimes(4);
  unsubscribe();
});

vi.mock("@/lib/apis/eval-authoring-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readAuthoringJob: vi.fn(),
  authoringRequest: vi.fn(),
}));
import { readAuthoringJob } from "@/lib/apis/eval-authoring-api";
import { followAuthoringJob } from "../eval-workspace";
describe("authoring polling recovery", () => {
  it("retries reads with the same job ID and resets the budget after success", async () => {
    vi.useFakeTimers();
    const read = vi.mocked(readAuthoringJob);
    read.mockReset();
    const status = {
      jobId: "job",
      phase: "draft",
      drafts: [],
      warnings: [],
      error: null,
    };
    read
      .mockRejectedValueOnce(new Error("Network"))
      .mockRejectedValueOnce(new Error("Network"))
      .mockRejectedValueOnce(new Error("Network"))
      .mockResolvedValueOnce({ ...status, status: "pending" })
      .mockRejectedValueOnce(new Error("Network"))
      .mockResolvedValueOnce({ ...status, status: "completed" });
    try {
      const polling = followAuthoringJob(scope, "job");
      await vi.runAllTimersAsync();
      await polling;
      expect(read).toHaveBeenCalledTimes(6);
      expect(read.mock.calls.every(([id]) => id === "job")).toBe(true);
      expect(
        useEvalGeneration.getState().suites[evalSuiteKey(scope)],
      ).toMatchObject({ status: "ready", error: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops after three retries and retains the resumable job ID", async () => {
    vi.useFakeTimers();
    vi.mocked(readAuthoringJob)
      .mockReset()
      .mockRejectedValue(new Error("Offline"));
    try {
      const polling = followAuthoringJob(scope, "failed-read");
      await vi.runAllTimersAsync();
      await polling;
      expect(readAuthoringJob).toHaveBeenCalledTimes(4);
      expect(
        useEvalGeneration.getState().suites[evalSuiteKey(scope)],
      ).toMatchObject({
        status: "error",
        error: "Offline",
        authoringJobId: "failed-read",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
