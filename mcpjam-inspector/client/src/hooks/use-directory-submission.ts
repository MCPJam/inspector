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
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  validateDirectoryAnswers,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
  type DirectoryFlow,
} from "@mcpjam/sdk/browser";
import { directorySubmissionConflict } from "@mcpjam/sdk/platform";
import { useDirectoryReadinessRun } from "@/hooks/use-directory-readiness-run";
import {
  getDirectoryFlow,
  getDirectorySubmission,
  startDirectorySubmissionRun,
  updateDirectorySubmission,
  type SubmissionScope,
  type SubmissionView,
} from "@/lib/apis/directory-submissions-api";

export type AnswerValues = Record<string, DirectoryAnswerValue>;

interface Draft {
  flow: DirectoryFlow | null;
  view: SubmissionView | null;
  /** Edits not saved yet. */
  pending: AnswerValues;
  /**
   * The revision each pending edit was made on. Edits made while a save is
   * out keep theirs: that save's revision covers only the fields it sent.
   */
  bases: Record<string, number>;
  /** This tab's values for fields changed elsewhere, held for the person. */
  conflict: AnswerValues | null;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
}

const EMPTY: Draft = {
  flow: null,
  view: null,
  pending: {},
  bases: {},
  conflict: null,
  saving: false,
  savedAt: null,
  error: null,
};
const SAVE_DELAY_MS = 800;
/** The submission changes rarely; a run polls on its own ladder. */
const REFRESH_MS = 15_000;
/** Saves one `saveNow` may make: one per revision its edits were made on. */
const MAX_SAVES = 10;

type SaveOutcome = "saved" | "conflict" | "failed" | "idle";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isEmpty = (values: AnswerValues) => Object.keys(values).length === 0;
const keep = (values: AnswerValues, test: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(values).filter(([key]) => test(key)));

/** One save carries one revision: the edits made on the oldest one. */
function nextBatch(draft: Draft) {
  const revisions = Object.keys(draft.pending)
    .map((key) => draft.bases[key])
    .filter((revision): revision is number => revision !== undefined);
  if (revisions.length === 0) return null;
  const expectedRevision = Math.min(...revisions);
  const answers = keep(
    draft.pending,
    (key) => draft.bases[key] === expectedRevision,
  );
  return { expectedRevision, answers };
}

/** The bases of `pending`, with the fields `sent` checked moved to `revision`. */
function rebase(
  draft: Draft,
  pending: AnswerValues,
  sent: AnswerValues,
  revision: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.keys(pending).map((key) => [
      key,
      key in sent ? revision : draft.bases[key]!,
    ]),
  );
}

/** One submission's draft. It outlives the page's interest until it is saved. */
function createSubmissionDraft(
  scope: SubmissionScope | null,
  initial: Draft,
  render: () => void,
) {
  let draft = initial;
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<SaveOutcome> | null = null;

  const set = (patch: Partial<Draft>) => {
    draft = { ...draft, ...patch };
    if (live) render();
  };

  /** A reply older than the one shown is dropped. */
  function adopt(view: SubmissionView) {
    if (view.revision < (draft.view?.revision ?? 0)) return;
    set({ view });
  }

  async function load() {
    if (!scope || !live) return;
    try {
      const view = await getDirectorySubmission(scope);
      if (draft.flow?.id !== view.flowId) {
        set({ flow: await getDirectoryFlow(view.flowId) });
      }
      adopt(view);
    } catch (error) {
      // A failed refresh leaves the last answers on screen; only a first
      // load has nothing else to show.
      if (!draft.view) set({ error: messageOf(error) });
    }
  }

  function queue() {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DELAY_MS);
  }

  function save(): Promise<SaveOutcome> {
    if (inflight) return inflight;
    const batch = nextBatch(draft);
    if (!scope || !batch) return Promise.resolve("idle");
    const sent = batch.answers;
    set({ saving: true });
    inflight = updateDirectorySubmission(scope, batch)
      .then(
        (saved): SaveOutcome => {
          // Edits made while this save was out stay, on top of its result.
          const pending = keep(
            draft.pending,
            (key) => draft.pending[key] !== sent[key],
          );
          set({
            saving: false,
            error: null,
            savedAt: Date.now(),
            pending,
            bases: rebase(draft, pending, sent, saved.revision),
          });
          adopt(saved);
          return "saved";
        },
        (error: unknown) => refused(error, sent),
      )
      .finally(() => {
        inflight = null;
        // A save refused for any reason but a conflict waits for the person:
        // their next edit, or "Try again".
        if (!isEmpty(draft.pending) && !draft.error) queue();
      });
    return inflight;
  }

  function refused(error: unknown, sent: AnswerValues): SaveOutcome {
    const conflict = directorySubmissionConflict(error);
    if (!conflict) {
      set({ saving: false, error: messageOf(error) });
      return "failed";
    }
    // A field this save touched changed elsewhere: show the saved value and
    // hold this tab's until the person chooses. The other fields it sent go
    // again on the current revision; fields it did not send were not checked.
    const clash = (key: string) =>
      key in sent && conflict.conflictingKeys.includes(key);
    const held = keep(draft.pending, clash);
    const pending = keep(draft.pending, (key) => !clash(key));
    set({
      saving: false,
      error: null,
      pending,
      bases: rebase(draft, pending, sent, conflict.currentRevision),
      conflict: isEmpty(held) ? draft.conflict : { ...draft.conflict, ...held },
    });
    if (conflict.current) adopt(conflict.current);
    else void load();
    return "conflict";
  }

  /** Save until nothing waits. True when every edit is saved. */
  async function flush(): Promise<boolean> {
    clearTimeout(timer);
    for (let saves = 0; saves < MAX_SAVES; saves += 1) {
      const outcome = await save();
      if (outcome === "failed") return false;
      if (outcome === "idle") break;
    }
    clearTimeout(timer);
    return isEmpty(draft.pending) && draft.conflict === null;
  }

  /** Edits on the revision on screen, unless the field already waits on one. */
  function edit(values: AnswerValues, conflict: AnswerValues | null) {
    const revision = draft.view?.revision;
    const bases = { ...draft.bases };
    for (const key of Object.keys(values)) {
      if (bases[key] === undefined && revision !== undefined) {
        bases[key] = revision;
      }
    }
    set({ pending: { ...draft.pending, ...values }, bases, conflict });
    queue();
  }

  return {
    scope,
    draft: () => draft,
    load,
    flush,
    /** Another submission is open: stop rendering, keep saving. */
    detach() {
      live = false;
    },
    /** Open again, with whatever it still holds. */
    attach() {
      live = true;
    },
    setAnswer(key: string, value: DirectoryAnswerValue) {
      const conflict = draft.conflict && keep(draft.conflict, (k) => k !== key);
      edit({ [key]: value }, conflict && !isEmpty(conflict) ? conflict : null);
    },
    reapply: () => edit(draft.conflict ?? {}, null),
    keepSaved: () => set({ conflict: null }),
  };
}

type SubmissionDraft = ReturnType<typeof createSubmissionDraft>;
const keyOf = (scope: SubmissionScope) =>
  `${scope.projectId}/${scope.submissionId}`;

export function createDraftStore(render: () => void) {
  let current = createSubmissionDraft(null, EMPTY, render);
  /**
   * Drafts left behind until their edits are saved. A save that fails or
   * conflicts keeps its draft here, so reopening the submission shows the
   * unsaved edits and the notice again.
   */
  const left = new Map<string, SubmissionDraft>();
  return {
    draft: () => current.draft(),
    load: () => current.load(),
    /**
     * Opens another submission. The one open now keeps its draft until the
     * edits waiting on it, including any made during a save, are saved.
     */
    open(projectId: string, submissionId: string | null) {
      const { scope } = current;
      if (
        scope?.submissionId === submissionId &&
        scope?.projectId === projectId
      ) {
        return;
      }
      const outgoing = current;
      outgoing.detach();
      if (outgoing.scope) {
        const key = keyOf(outgoing.scope);
        left.set(key, outgoing);
        void outgoing.flush().then((saved) => {
          if (saved && left.get(key) === outgoing) left.delete(key);
        });
      }
      const next = submissionId ? { projectId, submissionId } : null;
      const resumed = next ? left.get(keyOf(next)) : undefined;
      if (next && resumed) {
        left.delete(keyOf(next));
        resumed.attach();
      }
      current =
        resumed ??
        createSubmissionDraft(
          next,
          { ...EMPTY, flow: outgoing.draft().flow },
          render,
        );
      render();
      void current.load();
    },
    setAnswer: (key: string, value: DirectoryAnswerValue) =>
      current.setAnswer(key, value),
    /** Saves every waiting edit. False when one failed or conflicted. */
    saveNow: () => current.flush(),
    reapply: () => current.reapply(),
    keepSaved: () => current.keepSaved(),
  };
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
  const { flow, view, pending, ...status } = store.draft();

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

  // The run reuses the readiness run poller; a new `start` resets it.
  const start = useCallback(
    (key: string) =>
      startDirectorySubmissionRun(
        { projectId, submissionId: submissionId ?? "" },
        key,
      ),
    [projectId, submissionId],
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

  const answers = useMemo((): DirectoryAnswer[] => {
    const stored = view?.answers.filter((answer) => !(answer.key in pending));
    const edits = Object.entries(pending).map(([key, value]) => {
      return { key, value, origin: "set" as const };
    });
    return [...(stored ?? []), ...edits];
  }, [view, pending]);
  const values = useMemo(
    () => Object.fromEntries(answers.map(({ key, value }) => [key, value])),
    [answers],
  );
  // The portal's own checks, live as the person types.
  const issues = useMemo(
    () => (flow ? validateDirectoryAnswers(flow, answers) : []),
    [flow, answers],
  );
  const startRun = useCallback(async () => {
    // A run grades the answers stored when it starts, so it starts only
    // once every edit is saved.
    if (await store.saveNow()) await run();
  }, [store, run]);

  return {
    flow,
    view,
    values,
    issues,
    ...status,
    run: runner.state,
    startRun,
    setAnswer: store.setAnswer,
    saveNow: store.saveNow,
    reapply: store.reapply,
    keepSaved: store.keepSaved,
  };
}

export type DirectorySubmissionSession = ReturnType<
  typeof useDirectorySubmission
>;
