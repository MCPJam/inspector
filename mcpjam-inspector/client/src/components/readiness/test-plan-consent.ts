/**
 * The saved test plan revision a person confirmed, in this browser, for one
 * submission. The API, the CLI and agents name a revision on purpose, but the
 * page fills it in. A run from the page therefore sends a revision only once
 * the person has confirmed that exact one. Saved revisions never change, so
 * confirming one confirms its calls, and a newer revision asks again.
 *
 * Storage that throws (a private window, a blocked origin) reads as never
 * confirmed, so the page asks every time.
 */
import type { SubmissionScope } from "@/lib/apis/directory-submissions-api";

const keyOf = ({ projectId, submissionId }: SubmissionScope) =>
  `mcpjam-readiness-test-plan-confirmed:${projectId}:${submissionId}`;

export function isConfirmed(scope: SubmissionScope, revision: number): boolean {
  try {
    return window.localStorage.getItem(keyOf(scope)) === String(revision);
  } catch {
    // No storage: nothing was confirmed, so the person is asked.
    return false;
  }
}

export function recordConfirmed(
  scope: SubmissionScope,
  revision: number,
): void {
  try {
    window.localStorage.setItem(keyOf(scope), String(revision));
  } catch {
    // No storage: this run goes ahead, and the next one asks again.
  }
}
