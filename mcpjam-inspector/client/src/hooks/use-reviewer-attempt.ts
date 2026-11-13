/**
 * A submission's reviewer sign-in on the Readiness page: its newest attempt,
 * read again while it runs, and what a person does to it.
 *
 * Every action reads the attempt again when it settles, so the page shows
 * what is true now: a teammate or an agent may have resumed or cancelled it
 * first. An action's error stays while the attempt is in the state it was
 * refused in, and goes once that changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmissionScope } from "@/lib/apis/directory-submissions-api";
import {
  cancelReviewerAttempt,
  getLatestReviewerAttempt,
  resumeReviewerAttempt,
  startReviewerAttempt,
  type ReviewerAttempt,
  type ReviewerSignIn,
} from "@/lib/apis/reviewer-attempts-api";

/** A sign-in moves stage by stage within seconds; at rest, rarely. */
export const RUNNING_POLL_MS = 4_000;
export const IDLE_POLL_MS = 15_000;

export type ReviewerAction = "load" | "start" | "resume" | "cancel";

export interface ReviewerFailure {
  action: ReviewerAction;
  error: unknown;
}

type Loaded = ReviewerAttempt | null | undefined;

const stateOf = (attempt: Loaded) => attempt?.state ?? "none";

/** A read that left before the answer on screen loses to it. */
function newer(next: ReviewerAttempt | null, current: Loaded) {
  if (!current || !next) return next;
  const older =
    next.id === current.id
      ? next.updatedAt < current.updatedAt
      : next.createdAt < current.createdAt;
  return older ? current : next;
}

export function useReviewerAttempt({
  projectId,
  submissionId,
}: SubmissionScope) {
  // `undefined` until the first read answers; `null` before the first attempt.
  const [attempt, setAttempt] = useState<Loaded>();
  const [failure, setFailure] = useState<
    (ReviewerFailure & { state: string }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  // Bumped when an action settles: read now, at the pace the answer sets.
  const [reads, setReads] = useState(0);
  const pace = useRef(IDLE_POLL_MS);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      // A hidden tab skips the read; the next one after it shows again.
      if (!document.hidden) {
        try {
          const latest = await getLatestReviewerAttempt(
            { projectId, submissionId },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          pace.current =
            latest?.state === "running" ? RUNNING_POLL_MS : IDLE_POLL_MS;
          setAttempt((current) => newer(latest, current));
          setFailure((current) =>
            current?.action === "load" ? null : current,
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          // An action's refusal outranks a read that failed after it.
          setFailure((current) =>
            current && current.action !== "load"
              ? current
              : { action: "load", error, state: "none" },
          );
        }
      }
      if (controller.signal.aborted) return;
      timer = setTimeout(() => void read(), pace.current);
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, submissionId, reads]);

  const act = useCallback(
    async (
      action: Exclude<ReviewerAction, "load">,
      from: Loaded,
      call: () => Promise<ReviewerAttempt>,
    ) => {
      setBusy(true);
      setFailure(null);
      try {
        const next = await call();
        setAttempt((current) => newer(next, current));
      } catch (error) {
        setFailure({ action, error, state: stateOf(from) });
      } finally {
        setBusy(false);
        setReads((count) => count + 1);
      }
    },
    [],
  );

  const scope = { projectId, submissionId };
  const start = (signIn: ReviewerSignIn) =>
    act("start", attempt, () =>
      // One key per press: a retried request replays onto its attempt.
      startReviewerAttempt(
        scope,
        signIn,
        `ui-reviewer-${submissionId}-${Date.now()}`,
      ),
    );
  const resume = (target: ReviewerAttempt) =>
    act("resume", attempt, () => resumeReviewerAttempt(scope, target.id));
  const cancel = (target: ReviewerAttempt) =>
    act("cancel", attempt, () => cancelReviewerAttempt(scope, target.id));

  // A failed first read has nothing else to show; a failed later one leaves
  // the last answer on screen. An action's error belongs to its state.
  const shown =
    failure &&
    (failure.action === "load"
      ? attempt === undefined
      : failure.state === stateOf(attempt))
      ? { action: failure.action, error: failure.error }
      : null;

  return { attempt, busy, failure: shown, start, resume, cancel };
}

export type ReviewerRehearsal = ReturnType<typeof useReviewerAttempt>;
