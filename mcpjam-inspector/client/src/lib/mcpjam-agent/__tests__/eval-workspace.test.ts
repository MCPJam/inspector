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
