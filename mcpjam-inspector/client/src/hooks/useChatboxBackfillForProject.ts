import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";

/**
 * Eagerly back-mint chatboxes for every host in the active project.
 *
 * The 1:1 host↔chatbox invariant is enforced going forward (host
 * creation auto-mints a chatbox), but hosts that pre-date the invariant
 * — or hosts imported from a deploy that didn't enforce it — have no
 * chatbox row. Without this backfill, clicking the Chatboxes tab for
 * such a host blocks behind a `chatboxes.ensureChatboxForHost` round
 * trip every time. Firing the project-wide ensure once at app shell
 * mount makes that tab instant for the rest of the session.
 *
 * Idempotent on the backend (`ensureChatboxesForProject` is a no-op for
 * hosts that already have a chatbox), and latched per `projectId` in
 * this hook so a re-render won't refire it. Cleared by reloading the
 * tab (refs reset on mount).
 */
export function useChatboxBackfillForProject({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  const ensure = useMutation("chatboxes:ensureChatboxesForProject" as any);
  const firedFor = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!projectId) return;
    if (firedFor.current.has(projectId)) return;
    firedFor.current.add(projectId);
    void ensure({ projectId } as any).catch((err: unknown) => {
      // Don't surface the error — backfill is best-effort, and the
      // per-host fallback in `ChatboxesTab` will catch any host the
      // batch missed. Unlatch so a subsequent project switch back can
      // retry, but log so dev sees the issue.
      firedFor.current.delete(projectId);
      console.warn("[useChatboxBackfillForProject] ensure failed", err);
    });
  }, [ensure, isAuthenticated, projectId]);
}
