import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

/** The copy a refusal carries, when the backend wrote one for people. */
export function analyzeNowErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data) return data;
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { message?: unknown }).message === "string"
    )
      return (data as { message: string }).message;
  }
  return "Could not start the analysis. Try again in a minute.";
}

const HINT: Partial<
  Record<NonNullable<SharedChatThread["analysisPhase"]>, string>
> = {
  owed: "Analyze this session now instead of waiting for it to go quiet.",
  provisional:
    "The outcome fills in 30 minutes after the last message. Analyze now to treat this session as finished.",
  failed: "The last analysis failed. Try it again.",
};

/**
 * Analyze now, for one User Testing session (B5).
 *
 * Offered while there is something to change: the session has not been
 * analyzed yet (`owed`), was analyzed before its outcome could be asserted
 * (`provisional`), or failed. While a pass runs it reads "Analyzing…" and
 * stays inert. Members only: the mutation refuses a guest outright, so a
 * guest never sees a button that could only fail.
 *
 * Same request discipline as `SwarmJudgeSection`: a request that resolves
 * after the reader moved to another session, or after a newer request, must
 * not write over the current state.
 */
export function SessionAnalyzeNowButton({
  thread,
}: {
  thread: Pick<SharedChatThread, "_id" | "sourceType" | "analysisPhase">;
}) {
  const phase = thread.analysisPhase;
  // Decided before any hook runs, so the member check (a Convex query) is
  // only asked where its answer can change what renders.
  if (
    thread.sourceType !== "scenario" ||
    !phase ||
    (phase !== "analyzing" && !HINT[phase])
  )
    return null;
  return <AnalyzeNowForMembers thread={thread} />;
}

function AnalyzeNowForMembers({
  thread,
}: {
  thread: Pick<SharedChatThread, "_id" | "sourceType" | "analysisPhase">;
}) {
  const isMember = useIsMemberActor();
  const request = useMutation(
    "chatSessions:requestSessionAnalysis" as never,
  ) as unknown as (args: { sessionId: string }) => Promise<unknown>;
  // In-flight requests, by session. Keyed rather than a single flag so a
  // reader who leaves a session and comes back before its request settles
  // finds it still disabled, instead of a button that sends it again.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const activeThreadRef = useRef(thread._id);
  activeThreadRef.current = thread._id;
  const requestSerialRef = useRef(0);

  const analyzeNow = useCallback(async () => {
    const requestedFor = thread._id;
    const serial = ++requestSerialRef.current;
    // Only the toast is stale-guarded: the reader who moved on is told
    // nothing, but the pending mark always clears when its request settles.
    const isStale = () =>
      activeThreadRef.current !== requestedFor ||
      requestSerialRef.current !== serial;
    setPending((current) => new Set(current).add(requestedFor));
    try {
      await request({ sessionId: requestedFor });
      if (isStale()) return;
      toast.success("Analyzing this session");
    } catch (error) {
      if (isStale()) return;
      toast.error(analyzeNowErrorMessage(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(requestedFor);
        return next;
      });
    }
  }, [request, thread._id]);

  if (isMember !== true) return null;
  const phase = thread.analysisPhase;
  const analyzing = pending.has(thread._id) || phase === "analyzing";
  const hint = phase ? HINT[phase] : undefined;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 rounded-lg px-2.5 text-xs"
      data-testid="share-usage-analyze-now"
      disabled={analyzing}
      title={analyzing ? "Analyzing this session" : hint}
      onClick={() => void analyzeNow()}
    >
      {analyzing ? (
        <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
      )}
      {analyzing ? "Analyzing…" : "Analyze now"}
    </Button>
  );
}
