/**
 * One directory submission open on the Readiness page: its flow, its stored
 * answers with this tab's unsaved edits on top, and the run that grades it.
 *
 * EDITS CARRY THE REVISION THEY WERE MADE ON. A person here and an agent on
 * the API edit the same answers, and the backend refuses a save when a field
 * it touches changed after that revision. So a refresh never moves the
 * revision of edits still waiting: that would overwrite, unseen, a change
 * someone else made to the same field.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  directoryFlowField,
  validateDirectoryAnswers,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
  type DirectoryFieldIssue,
  type DirectoryFlow,
} from "@mcpjam/sdk/browser";
import { directorySubmissionConflict } from "@mcpjam/sdk/platform";
import { useDirectoryReadinessRun } from "@/hooks/use-directory-readiness-run";
import {
  getDirectoryFlow,
  getDirectorySubmission,
  startDirectorySubmissionRun,
  updateDirectorySubmission,
  type SubmissionPlugin,
  type SubmissionScope,
  type SubmissionView,
} from "@/lib/apis/directory-submissions-api";

export type AnswerValues = Record<string, DirectoryAnswerValue>;

interface Draft {
  flow: DirectoryFlow | null;
  view: SubmissionView | null;
  /** Edits not saved yet, and the revision they were made on. */
  pending: AnswerValues;
  /** Pending keys the person confirmed as shown: saved as confirmed, not set. */
  confirming: readonly string[];
  base: number | null;
  /** This tab's values for fields changed elsewhere, held for the person. */
  conflict: AnswerValues | null;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  /** A ChatGPT plugin choice on its way, and why the last one was refused. */
  pluginSaving: boolean;
  pluginError: string | null;
}

const EMPTY: Draft = {
  flow: null,
  view: null,
  pending: {},
  confirming: [],
  base: null,
  conflict: null,
  saving: false,
  savedAt: null,
  error: null,
  pluginSaving: false,
  pluginError: null,
};
const SAVE_DELAY_MS = 800;
/** The submission changes rarely; a run polls on its own ladder. */
const REFRESH_MS = 15_000;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isEmpty = (values: AnswerValues) => Object.keys(values).length === 0;
const keep = (values: AnswerValues, test: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(values).filter(([key]) => test(key)));

export function createDraftStore(render: () => void) {
  let draft = EMPTY;
  let scope: SubmissionScope | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;

  const set = (patch: Partial<Draft>) => {
    draft = { ...draft, ...patch };
    render();
  };
  const isOpen = (id: string) => scope?.submissionId === id;

  /** A reply for another submission, or older than the one shown, is dropped. */
  function adopt(view: SubmissionView) {
    if (!isOpen(view.id) || view.revision < (draft.view?.revision ?? 0)) return;
    set({ view });
  }

  async function load() {
    const target = scope;
    if (!target) return;
    try {
      const view = await getDirectorySubmission(target);
      if (draft.flow?.id !== view.flowId) {
        const flow = await getDirectoryFlow(view.flowId);
        if (isOpen(view.id)) set({ flow });
      }
      adopt(view);
    } catch (error) {
      // A failed refresh leaves the last answers on screen; only a first
      // load has nothing else to show.
      if (isOpen(target.submissionId) && !draft.view) {
        set({ error: messageOf(error) });
      }
    }
  }

  function queue() {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  }

  function save(): Promise<void> {
    const { pending: sent, base: expectedRevision } = draft;
    const target = scope;
    if (inflight) return inflight;
    if (!target || expectedRevision === null || isEmpty(sent)) {
      return Promise.resolve();
    }
    // A confirmation goes with its value, so a default is stored as shown.
    const confirm = draft.confirming.filter((key) => key in sent);
    set({ saving: true });
    inflight = updateDirectorySubmission(target, {
      expectedRevision,
      answers: sent,
      ...(confirm.length > 0 ? { confirm } : {}),
    })
      .then(
        (saved) => {
          if (!isOpen(saved.id)) return;
          // Edits made while this save was out stay, on top of its result.
          const pending = keep(
            draft.pending,
            (key) => draft.pending[key] !== sent[key],
          );
          const base = isEmpty(pending) ? null : saved.revision;
          set({
            saving: false,
            error: null,
            savedAt: Date.now(),
            pending,
            confirming: draft.confirming.filter((key) => key in pending),
            base,
          });
          adopt(saved);
        },
        (error: unknown) => {
          if (isOpen(target.submissionId)) refused(error, sent);
        },
      )
      .finally(() => {
        inflight = null;
        // A save refused for any reason but a conflict waits for the person:
        // their next edit, or "Try again".
        if (!isEmpty(draft.pending) && !draft.error) queue();
      });
    return inflight;
  }

  function refused(error: unknown, sent: AnswerValues) {
    const conflict = directorySubmissionConflict(error);
    if (!conflict) return set({ saving: false, error: messageOf(error) });
    // A field this save touched changed elsewhere: show the saved value and
    // hold this tab's until the person chooses. The other edits go again on
    // top of the current revision.
    const clash = (key: string) =>
      key in sent && conflict.conflictingKeys.includes(key);
    const held = keep(draft.pending, clash);
    set({
      saving: false,
      error: null,
      pending: keep(draft.pending, (key) => !clash(key)),
      confirming: draft.confirming.filter((key) => !clash(key)),
      base: conflict.currentRevision,
      conflict: isEmpty(held) ? draft.conflict : { ...draft.conflict, ...held },
    });
    if (conflict.current) adopt(conflict.current);
    else void load();
  }

  return {
    draft: () => draft,
    load,
    adopt,
    /** Saves what waits for the submission open now, then opens another. */
    open(projectId: string, submissionId: string | null) {
      if (
        scope?.submissionId === submissionId &&
        scope?.projectId === projectId
      ) {
        return;
      }
      clearTimeout(timer);
      void save();
      scope = submissionId ? { projectId, submissionId } : null;
      draft = { ...EMPTY, flow: draft.flow };
      render();
      void load();
    },
    /** `confirm`: the person stands behind this value, as when they confirm a default. */
    setAnswer(key: string, value: DirectoryAnswerValue, confirm = false) {
      const conflict = draft.conflict && keep(draft.conflict, (k) => k !== key);
      const others = draft.confirming.filter((k) => k !== key);
      set({
        pending: { ...draft.pending, [key]: value },
        confirming: confirm ? [...others, key] : others,
        base: draft.base ?? draft.view?.revision ?? null,
        conflict: conflict && !isEmpty(conflict) ? conflict : null,
      });
      queue();
    },
    async saveNow() {
      clearTimeout(timer);
      await inflight;
      await save();
    },
    reapply() {
      set({
        pending: { ...draft.pending, ...draft.conflict },
        base: draft.base ?? draft.view?.revision ?? null,
        conflict: null,
      });
      queue();
    },
    keepSaved: () => set({ conflict: null }),
    /**
     * Replaces a ChatGPT submission's plugin at once, guarded like an answer
     * by the revision the person chose on: a plugin someone else saved in
     * between wins, and the page shows it.
     */
    async setPlugin(plugin: SubmissionPlugin | null) {
      const target = scope;
      const expectedRevision = draft.view?.revision;
      if (!target || expectedRevision === undefined) return;
      set({ pluginSaving: true, pluginError: null });
      try {
        const saved = await updateDirectorySubmission(target, {
          expectedRevision,
          plugin,
        });
        if (!isOpen(saved.id)) return;
        set({ pluginSaving: false });
        adopt(saved);
      } catch (error) {
        if (!isOpen(target.submissionId)) return;
        const conflict = directorySubmissionConflict(error);
        set({
          pluginSaving: false,
          pluginError: conflict
            ? "The plugin changed in another session, so yours was not saved. The page shows the saved one; choose yours again to replace it."
            : `The plugin was not saved. ${messageOf(error)} Choose it again.`,
        });
        if (conflict?.current) adopt(conflict.current);
        else if (conflict) void load();
      }
    },
  };
}

/**
 * A package-managed field with no answer was never imported: the package
 * holds it, and a run grades the package itself. So it is not known to be
 * missing, and the portal's error line would claim it is.
 */
function knownIssues(
  flow: DirectoryFlow,
  issues: readonly DirectoryFieldIssue[],
  answered: ReadonlySet<string>,
): DirectoryFieldIssue[] {
  return issues.filter(
    (issue) =>
      directoryFlowField(flow, issue.key)?.managedBy !== "package" ||
      answered.has(issue.key),
  );
}

export function useDirectorySubmission({
  projectId,
  submissionId,
  server,
}: {
  projectId: string;
  submissionId: string | null;
  server: { name: string; config?: unknown };
}) {
  const [, render] = useReducer((tick: number) => tick + 1, 0);
  const [store] = useState(() => createDraftStore(render));
  const { flow, view, pending, confirming, ...status } = store.draft();

  useEffect(() => {
    store.open(projectId, submissionId);
    if (!submissionId) return;
    const refresh = () => {
      if (!document.hidden) void store.load();
    };
    const interval = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      store.open(projectId, null);
    };
  }, [store, projectId, submissionId]);

  // The run reuses the readiness run poller; a new `start` resets it. So the
  // plugin version a ChatGPT run grades, and the test plan revision the person
  // started the run with, are read when the run starts.
  const consented = useRef<number | undefined>(undefined);
  const start = useCallback(
    (key: string) =>
      startDirectorySubmissionRun(
        { projectId, submissionId: submissionId ?? "" },
        key,
        store.draft().view?.pluginVersionId,
        consented.current,
      ),
    [projectId, submissionId, store],
  );
  const runner = useDirectoryReadinessRun({
    publisher: "claude",
    server,
    start,
  });
  const { watch, run } = runner;
  const lastRunId = view?.lastRunId;
  useEffect(() => {
    if (lastRunId) watch(lastRunId);
  }, [lastRunId, watch]);
  // A run that finished after these results were read: read them again.
  const finished =
    runner.state.run?.status === "completed" ? runner.state.run.id : null;
  const resultsRunId = view?.resultsRunId ?? null;
  useEffect(() => {
    if (finished && finished !== resultsRunId) void store.load();
  }, [finished, resultsRunId, store]);

  // An edit not saved yet has no stamp: nobody to attribute it to yet.
  const answers = useMemo((): DirectoryAnswer[] => {
    const stored = view?.answers.filter((answer) => !(answer.key in pending));
    const edits = Object.entries(pending).map(([key, value]) => {
      const origin: DirectoryAnswer["origin"] = confirming.includes(key)
        ? "confirmed"
        : "set";
      return { key, value, origin };
    });
    return [...(stored ?? []), ...edits];
  }, [view, pending, confirming]);
  const values = useMemo(
    () => Object.fromEntries(answers.map(({ key, value }) => [key, value])),
    [answers],
  );
  // The portal's own checks, live as the person types.
  const issues = useMemo(() => {
    if (!flow) return [];
    const answered = new Set(answers.map((answer) => answer.key));
    return knownIssues(flow, validateDirectoryAnswers(flow, answers), answered);
  }, [flow, answers]);
  // The review page also asks for what no step does, such as Claude's author.
  const reviewIssues = useMemo(
    () =>
      flow ? validateDirectoryAnswers(flow, answers, { on: "review" }) : [],
    [flow, answers],
  );
  /**
   * `testPlanRevision` is the saved plan revision the person started the run
   * with, which authorizes its calls; without one the run calls no tool.
   */
  const startRun = useCallback(
    async (testPlanRevision?: number) => {
      // A run grades the answers stored when it starts.
      await store.saveNow();
      consented.current = testPlanRevision;
      await run();
    },
    [store, run],
  );
  const confirm = useCallback(
    (key: string) => {
      const value = values[key];
      if (value !== undefined && value !== null) {
        store.setAnswer(key, value, true);
      }
    },
    [store, values],
  );

  return {
    flow,
    view,
    /** Stored answers with their origins, and this tab's edits on top. */
    answers,
    values,
    issues,
    reviewIssues,
    ...status,
    run: runner.state,
    startRun,
    setAnswer: store.setAnswer,
    /** Stand behind the answer shown, such as a declaration on a default. */
    confirm,
    saveNow: store.saveNow,
    reapply: store.reapply,
    keepSaved: store.keepSaved,
    setPlugin: store.setPlugin,
    /** Shows a submission another write returned, such as the gate's. */
    adopt: store.adopt,
  };
}

export type DirectorySubmissionSession = ReturnType<
  typeof useDirectorySubmission
>;
