/**
 * A directory submission's test plan on the Readiness page: the saved
 * revision, this tab's unsaved plan on top of it (a draft, or edits), and
 * what the newest run that named a revision showed.
 *
 * EDITS CARRY THE REVISION THEY WERE MADE ON, as answers do. A save names it,
 * and the backend refuses a save made on a revision someone has replaced
 * since, so this tab never overwrites a plan it has not seen. Nothing is
 * saved until the person saves, a draft included, and a run only ever names
 * the saved revision.
 */
import { useEffect, useReducer, useState } from "react";
import type {
  DirectoryTestPlan,
  DirectoryTestPlanIssue,
} from "@mcpjam/sdk/browser";
import {
  directorySubmissionConflict,
  isPlatformApiError,
  type PlatformDirectoryTestPlanCatalog,
} from "@mcpjam/sdk/platform";
import type { SubmissionScope } from "@/lib/apis/directory-submissions-api";
import {
  draftTestPlan,
  getTestPlan,
  getToolTests,
  saveTestPlan,
  type TestPlanView,
  type ToolTests,
} from "@/lib/apis/directory-test-plan-api";

export interface TestPlanState {
  /** The saved plan; `null` when there is none, `undefined` until read. */
  saved: TestPlanView | null | undefined;
  /** This tab's plan, not saved: a draft or edits. `null` when there is none. */
  edited: DirectoryTestPlan | null;
  /** The revision the edits were made on, which a save names; 0 before the first plan. */
  base: number;
  /** From the last read, draft or save; `null` while MCPJam holds no tool list. */
  issues: DirectoryTestPlanIssue[] | null;
  catalog: PlatformDirectoryTestPlanCatalog | null;
  busy: "draft" | "save" | null;
  /** What failed, with what to do next. */
  error: string | null;
  /** The revision another session saved while these edits were open. */
  conflict: number | null;
  results: ToolTests | null;
  resultsError: string | null;
}

const EMPTY: TestPlanState = {
  saved: undefined,
  edited: null,
  base: 0,
  issues: null,
  catalog: null,
  busy: null,
  error: null,
  conflict: null,
  results: null,
  resultsError: null,
};

/**
 * What went wrong: a failure's first sentence. An API refusal ends with its
 * own next step, which each message below replaces with one this page
 * offers, so a message never gives two.
 */
function reasonOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  const first = /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/**
 * A conflict that names no revision: on a draft or a save, MCPJam holds no
 * usable tool list for the server; on the results, the run's plan revision
 * is no longer kept.
 */
const conflicted = (error: unknown) =>
  isPlatformApiError(error) && error.status === 409;

export function createTestPlanStore(render: () => void) {
  let state = EMPTY;
  let scope: SubmissionScope | null = null;
  /** The run key last seen for the open submission. */
  let seen: string | undefined;
  const set = (patch: Partial<TestPlanState>) => {
    state = { ...state, ...patch };
    render();
  };
  /** A reply for a submission no longer open is dropped. */
  const isOpen = (target: SubmissionScope) => target === scope;

  async function load() {
    const target = scope;
    if (!target) return;
    try {
      const saved = await getTestPlan(target);
      if (!isOpen(target)) return;
      // Edits keep the revision and issues they were made on.
      const checked = state.edited
        ? {}
        : {
            base: saved?.revision ?? 0,
            issues: saved?.issues ?? null,
            catalog: saved?.catalog ?? null,
          };
      set({ saved, ...checked });
    } catch (error) {
      if (!isOpen(target)) return;
      const reason = reasonOf(error);
      set({
        error: `The test plan did not load. ${reason} Reopen this rehearsal to load the plan again.`,
      });
    }
  }

  async function loadResults() {
    const target = scope;
    if (!target) return;
    try {
      const results = await getToolTests(target);
      if (isOpen(target)) set({ results, resultsError: null });
    } catch (error) {
      if (!isOpen(target)) return;
      const reason = reasonOf(error);
      set({
        resultsError: conflicted(error)
          ? `The tool test results did not load. ${reason} Run checks again to test the current plan.`
          : `The tool test results did not load. ${reason} Reopen this rehearsal to load the results again.`,
      });
    }
  }

  async function draft() {
    const target = scope;
    if (!target || state.busy) return;
    set({ busy: "draft", error: null });
    try {
      const drafted = await draftTestPlan(target);
      if (!isOpen(target)) return;
      // Made on what this tab last read, so a plan saved since is refused
      // at the save rather than replaced unseen.
      set({
        busy: null,
        edited: drafted.plan,
        base: state.saved?.revision ?? 0,
        issues: drafted.issues,
        catalog: drafted.catalog,
      });
    } catch (error) {
      if (!isOpen(target)) return;
      const reason = reasonOf(error);
      set({
        busy: null,
        error: conflicted(error)
          ? `The plan was not drafted. ${reason} Connect the server in MCPJam to store its tools, then draft the plan again.`
          : `The plan was not drafted. ${reason} Try drafting it again.`,
      });
    }
  }

  async function save() {
    const target = scope;
    const plan = state.edited;
    if (!target || !plan || state.busy) return;
    set({ busy: "save", error: null });
    try {
      const result = await saveTestPlan(target, state.base, plan);
      if (!isOpen(target)) return;
      const { replayed: _replayed, ...saved } = result;
      set({
        busy: null,
        saved: { ...saved, plan },
        edited: null,
        base: saved.revision,
        issues: saved.issues,
        catalog: saved.catalog,
        conflict: null,
      });
    } catch (error) {
      if (!isOpen(target)) return;
      refused(error);
    }
  }

  function refused(error: unknown) {
    const conflict = directorySubmissionConflict(error);
    // A plan over a limit comes back with the issues that refused it.
    const issues =
      isPlatformApiError(error) && error.status === 400
        ? error.details?.issues
        : undefined;
    if (conflict) {
      set({ busy: null, conflict: conflict.currentRevision });
    } else if (Array.isArray(issues)) {
      set({
        busy: null,
        issues: issues as DirectoryTestPlanIssue[],
        error:
          "The plan was not saved. Fix the issues marked below, then save it again.",
      });
    } else {
      const reason = reasonOf(error);
      set({
        busy: null,
        error: conflicted(error)
          ? `The plan was not saved. ${reason} Connect the server in MCPJam to store its tools, then save the plan again.`
          : `The plan was not saved. ${reason} Try saving it again.`,
      });
    }
  }

  return {
    state: () => state,
    open(projectId: string, submissionId: string | null) {
      const same =
        scope?.projectId === projectId && scope?.submissionId === submissionId;
      if (same || (!scope && !submissionId)) return;
      scope = submissionId ? { projectId, submissionId } : null;
      seen = undefined;
      state = EMPTY;
      render();
      void load();
    },
    /**
     * Reads the results when a submission opens, and the plan and results
     * again whenever its run starts or ends. This tab's edits stay.
     */
    sync(runKey: string) {
      if (!scope || !runKey || runKey === seen) return;
      if (seen !== undefined) void load();
      seen = runKey;
      void loadResults();
    },
    draft,
    save,
    /** Changes this tab's plan, starting from the saved one. */
    edit(change: (plan: DirectoryTestPlan) => DirectoryTestPlan) {
      const plan = state.edited ?? state.saved?.plan;
      if (plan) set({ edited: change(plan) });
    },
    /** Drops this tab's plan and reads the saved one: after a refused save, the other session's. */
    async discard() {
      set({ edited: null, error: null, conflict: null });
      await load();
    },
  };
}

export function useDirectoryTestPlan({
  projectId,
  submissionId,
  runKey,
}: {
  projectId: string;
  submissionId: string | null;
  /**
   * Changes when the submission's run starts or ends, which reads the results
   * and the saved plan again. Empty until the submission is read.
   */
  runKey: string;
}) {
  const [, render] = useReducer((tick: number) => tick + 1, 0);
  const [store] = useState(() => createTestPlanStore(render));

  useEffect(() => {
    store.open(projectId, submissionId);
    return () => store.open(projectId, null);
  }, [store, projectId, submissionId]);
  useEffect(() => store.sync(runKey), [store, runKey, submissionId]);

  const state = store.state();
  return {
    ...state,
    /** The plan shown: this tab's, else the saved one. */
    plan: state.edited ?? state.saved?.plan ?? null,
    draft: store.draft,
    save: store.save,
    edit: store.edit,
    discard: store.discard,
  };
}

export type DirectoryTestPlanSession = ReturnType<typeof useDirectoryTestPlan>;
