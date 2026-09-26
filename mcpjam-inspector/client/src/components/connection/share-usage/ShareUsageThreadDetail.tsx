import {
  requestPayloadEnvelopeFields,
  useRequestPayloads,
} from "@/hooks/use-request-payloads";
import { TranscriptEmptyState } from "@/components/chat-v2/transcript-empty-state";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { modelDefinitionForId } from "@/lib/model-definition-for-id";
import { useHostSnapshotForSession } from "@/hooks/use-host-snapshot";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { hydrateMessageTimestamps } from "@mcpjam/chat-ui";
import { artifactStableKey, fetchArtifact } from "@/lib/artifact-urls";
import {
  adaptTraceToUiMessages,
  snapshotsToTraceWidgetSnapshots,
  type TraceEnvelope,
  type TraceWidgetSnapshot,
} from "@/components/evals/trace-viewer-adapter";
import { TraceViewer } from "@/components/evals/trace-viewer";
import { BrowserArtifactsView } from "@/components/evals/browser-artifacts-view";
import { hasReplayArtifacts } from "@/components/evals/browser-step-replay";
import {
  expectedTurnTraceSpanCount,
  hydrateTurnTraceSpans,
  SPAN_LOAD_FAILURE,
  SPAN_LOAD_FAILURE_CONSEQUENCE,
  turnTraceWallClockRange,
} from "@/components/evals/turn-trace-spans";
import {
  ChatTraceViewModeHeaderBar,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import {
  useSharedChatThread,
  useSharedChatWidgetSnapshots,
  useSharedChatTurnTraces,
  useSessionBrowserArtifacts,
} from "@/hooks/useSharedChatThreads";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { SessionScoredTranscript } from "@/components/connection/share-usage/session-scored-transcript";
import { SessionFeedbackMark } from "@/components/connection/share-usage/session-feedback-mark";
import { SessionClientModelChip } from "@/components/connection/share-usage/session-client-model";
import { SessionAnalyzeNowButton } from "@/components/connection/share-usage/session-analyze-now";
import { ConvertPromotableSessionDialog } from "@/components/chat-v2/history/convert-promotable-session-dialog";
import { navigateToPromotedTestCase } from "@/components/chat-v2/shared/promote-to-eval-navigation";
import { useAction } from "convex/react";
import { Gavel, RotateCcw } from "lucide-react";
import { JudgeVerdictCard } from "@/components/shared/session-quality/judge-presentation";
import {
  SwarmSessionNotRun,
  threadNeverRan,
} from "@/components/swarms/swarm-session-not-run";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

const EMPTY_SPANS: EvalTraceSpan[] = [];

/**
 * Goal-completion judge section for SWARM sessions — auto-runs on open when
 * no verdict exists yet. States: pending/running → judging placeholder;
 * completed → shared JudgeVerdictCard + Re-judge; failed → "Judge unavailable"
 * + Retry. A session that is not yet gradeable (no succeeded attempt) is a
 * skip, not a failure: no toast, no stuck spinner. Calls
 * `requestSwarmSessionJudge` (sessionId only) and refreshes via the reactive
 * thread subscription.
 */
export function isNotGradeableSwarmSessionError(err: unknown): boolean {
  const data =
    err && typeof err === "object" && "data" in err
      ? (err as { data?: unknown }).data
      : undefined;
  const fromData = typeof data === "string" ? data : "";
  const fromMessage = err instanceof Error ? err.message : "";
  return (
    fromData.includes("not a gradeable swarm session") ||
    fromMessage.includes("not a gradeable swarm session")
  );
}

export function SwarmJudgeSection({
  threadId,
  goalScore,
}: {
  threadId: string;
  goalScore?: SharedChatThread["goalScore"];
}) {
  const requestJudge = useAction(
    "swarmJudge:requestSwarmSessionJudge" as never,
  ) as unknown as (args: { sessionId: string }) => Promise<unknown>;
  const [requesting, setRequesting] = useState(false);
  const [notGradeable, setNotGradeable] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const autoAttemptedRef = useRef(false);
  // The session the UI is currently showing. A judge request that resolves
  // after the reader moved on must not write over the new session's state.
  const activeThreadRef = useRef(threadId);
  activeThreadRef.current = threadId;
  // Matching on the session id alone is not enough. A reader who leaves this
  // session and comes back starts a SECOND request for the same id, and the
  // first one — still in flight — would pass an id-only staleness check and
  // overwrite the newer request's state. Each request also carries a serial,
  // so only the most recent one may write.
  const requestSerialRef = useRef(0);

  const rerun = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const requestedFor = threadId;
      const serial = ++requestSerialRef.current;
      const isStale = () =>
        activeThreadRef.current !== requestedFor ||
        requestSerialRef.current !== serial;
      setRequesting(true);
      setRequestError(null);
      try {
        const result = await requestJudge({ sessionId: requestedFor });
        if (isStale()) return;
        // Current backend returns null for an honest skip. Older deploys
        // still throw; both mean the same thing.
        setNotGradeable(result == null);
      } catch (err) {
        if (isStale()) return;
        if (isNotGradeableSwarmSessionError(err)) {
          setNotGradeable(true);
          return;
        }
        setNotGradeable(false);
        const message =
          err instanceof Error ? err.message : "Failed to run the judge";
        setRequestError(message);
        if (!silent) {
          toast.error(message);
        }
      } finally {
        if (!isStale()) setRequesting(false);
      }
    },
    [requestJudge, threadId],
  );

  useEffect(() => {
    autoAttemptedRef.current = false;
    setNotGradeable(false);
    setRequestError(null);
    // A request for the previous session is abandoned, not awaited.
    setRequesting(false);
  }, [threadId]);

  useEffect(() => {
    if (goalScore || autoAttemptedRef.current) return;
    autoAttemptedRef.current = true;
    void rerun({ silent: true });
  }, [goalScore, rerun]);

  const judging = requesting || goalScore?.status === "running";

  return (
    <div className="shrink-0 space-y-1.5 px-4 pt-2">
      {judging ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Judging against the journey goal…
        </div>
      ) : !goalScore && notGradeable ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
          <Gavel className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Not ready to judge — this session has no succeeded attempt yet.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0 rounded-xl"
            onClick={() => void rerun()}
          >
            <RotateCcw className="mr-1.5 size-3.5" />
            Retry
          </Button>
        </div>
      ) : !goalScore && requestError ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2 text-xs">
          <Gavel
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="font-medium uppercase tracking-wide text-muted-foreground">
            Judge unavailable
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {requestError}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0 rounded-xl"
            onClick={() => void rerun()}
          >
            <RotateCcw className="mr-1.5 size-3.5" />
            Retry
          </Button>
        </div>
      ) : goalScore &&
        goalScore.status === "completed" &&
        typeof goalScore.score === "number" &&
        Number.isFinite(goalScore.score) &&
        typeof goalScore.passed === "boolean" ? (
        // Both fields validated — a malformed `passed` must not render as
        // "below threshold" (same guard as the list badge).
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <JudgeVerdictCard
              verdict={{
                score: goalScore.score,
                passed: goalScore.passed,
                reason: goalScore.reason,
              }}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 rounded-xl"
            onClick={() => void rerun()}
            title="Re-run the judge on this session"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      ) : goalScore?.status === "failed" ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2 text-xs">
          <Gavel
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="font-medium uppercase tracking-wide text-muted-foreground">
            Judge unavailable
          </span>
          {goalScore.error ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {goalScore.error}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0 rounded-xl"
            onClick={() => void rerun()}
          >
            <RotateCcw className="mr-1.5 size-3.5" />
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface ShareUsageThreadDetailProps {
  threadId: string;
  /**
   * Full URL that deep-links back to this session. When provided the copy
   * button copies it; otherwise it falls back to the raw session id (the
   * host share-usage dialog has no deep-link target yet).
   */
  sessionLink?: string;
  /**
   * Enables the "Promote to test case" affordance.
   *
   * Supplied by surfaces that know the two things a `SharedChatThread` cannot
   * tell us: which project the session belongs to, and whether the viewer is
   * a member. The dialog state and default navigation live here rather than
   * in each parent — that per-parent duplication is what this prop replaces.
   * Omit it (as the host share-usage dialog does) and no promote UI renders.
   */
  promote?: {
    projectId: string;
    /** Member tier. Fail closed; the backend enforces it independently. */
    canPromote: boolean;
    /** Overrides the default navigate-to-test-editor behavior. */
    onImported?: (result: { suiteId: string; testCaseId: string }) => void;
  };
  /**
   * Softens the top and bottom edges of the panes that scroll — Chat and Raw —
   * as you scroll them (`scroll-fade-y`), so a cut-off message or line reads
   * as "there is more" rather than as a pane that stops mid-sentence.
   *
   * OPT-IN, and off by default, because this component is the session detail
   * for FIVE surfaces — User Testing, the two Swarm panels, the cross-surface
   * Sessions page and the host share-usage dialog. The same treatment would
   * suit all of them; turning it on for all of them is a call the people who
   * own those surfaces should make, not a side effect of fixing one.
   *
   * NOT the Trace tab. Its timeline has sticky column headers, and a mask on
   * their scroll container would fade the headers along with the rows they are
   * there to label.
   */
  fadeScrollEdges?: boolean;
  /**
   * Drop the identity / share header when a parent already supplies that
   * chrome — the Evaluate inspect sheet is the one caller today.
   */
  hideHeader?: boolean;
}

/**
 * Surfaces whose sessions the shared promote dialog can carry.
 *
 * Mirrors the backend allowlist (`PROMOTABLE_CHAT_SESSION_SOURCE_TYPES`)
 * minus `direct`, which keeps its own adapter because it must also serve
 * guest/HOSTED_MODE actors over the HTTP detail route.
 */
const PROMOTABLE_SOURCE_TYPES = new Set(["swarm", "scenario"]);

/**
 * One line per page load, not one per session: the skew is a property of the
 * deployment, so a warning per rendered session would bury it in its own noise.
 */
let warnedMissingRunAttemptStatus = false;
function warnMissingRunAttemptStatusOnce(): void {
  if (warnedMissingRunAttemptStatus) return;
  warnedMissingRunAttemptStatus = true;
  console.warn(
    "[share-usage] Swarm sessions carry no runAttemptStatus. The backend " +
      "predates the promote gate, so every swarm session will report an " +
      "unknown run outcome and promotion is off until it is deployed.",
  );
}

export function ShareUsageThreadDetail({
  threadId,
  sessionLink,
  promote,
  fadeScrollEdges = false,
  hideHeader = false,
}: ShareUsageThreadDetailProps) {
  const host = useHostSnapshotForSession(threadId);
  const { thread } = useSharedChatThread({
    threadId,
    includeRecordedContext: true,
  });
  const { snapshots } = useSharedChatWidgetSnapshots({ threadId });
  const { traces: turnTraces } = useSharedChatTurnTraces({ threadId });
  const requestPayloads = useRequestPayloads(threadId, turnTraces);
  const { artifacts: browserArtifacts } = useSessionBrowserArtifacts({
    threadId,
  });
  const [messages, setMessages] = useState<unknown[] | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  // The eval-only "browser" mode lives outside the shared TraceViewMode union
  // (see trace-view-mode-tabs.tsx) — widen locally, mirroring TraceViewer's
  // own internal state.
  const [viewMode, setViewMode] = useState<TraceViewMode | "browser">("chat");
  const [hydratedSpans, setHydratedSpans] = useState<EvalTraceSpan[]>([]);
  /**
   * The recorded spans could not be loaded, though the transcript may have
   * been. Its OWN slot, never `error`: that one belongs to the transcript,
   * gets cleared on every re-run of the transcript effect, and drives a
   * branch that replaces the whole viewer — none of which fits a session
   * whose transcript rendered fine and whose span blobs did not.
   */
  const [spanError, setSpanError] = useState<string | null>(null);

  // Fetch messages from blob URL. Links expire and are re-minted for the same
  // transcript: a renewed link to the transcript already on screen is not new
  // content and must not refetch it or swap the viewer for a spinner, while a
  // renewed link after a FAILED load is exactly how that load gets retried.
  const loadedMessagesKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const messagesBlobUrl = thread?.messagesBlobUrl;
    if (!messagesBlobUrl) {
      loadedMessagesKeyRef.current = null;
      setMessages(null);
      return;
    }
    const messagesKey = artifactStableKey(messagesBlobUrl);
    if (loadedMessagesKeyRef.current === messagesKey) return;
    // Names only what is on screen: from here the shown transcript is stale.
    loadedMessagesKeyRef.current = null;

    let isActive = true;
    const controller = new AbortController();

    async function fetchMessages(url: string) {
      setIsLoadingMessages(true);
      setError(null);
      try {
        const response = await fetchArtifact(url, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.status}`);
        }
        const data = await response.json();
        if (isActive) {
          setMessages(data);
          loadedMessagesKeyRef.current = messagesKey;
        }
      } catch (err) {
        if (!isActive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load thread messages:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load messages",
        );
      } finally {
        if (isActive) {
          setIsLoadingMessages(false);
        }
      }
    }

    void fetchMessages(messagesBlobUrl);
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [thread?.messagesBlobUrl]);

  /**
   * Eval blobs are anchored at the RUN start by `drive-local-eval-turn`, while
   * their per-turn rows carry a persist-time `turnStartedAt`. Rebasing them
   * would displace every span by the persist round-trip, so an eval thread
   * keeps the offsets its blobs already carry.
   *
   * Compared as a string on purpose: `SharedChatSourceType` is
   * `"scenario" | "swarm"`, so TS calls this branch dead — but the sessions
   * feed types the same field as `"direct" | "scenario" | "eval" | "swarm"`
   * and `SessionsPanel` renders this component for every row without a gate.
   * The narrow type is the thing that is wrong here, not the check.
   *
   * Hoisted out of the hydration effect because the axis anchor below has to
   * make the SAME call: the rows' timestamps are persist-time noise for evals,
   * which is why their spans aren't rebased from them, and that disqualifies
   * them as the wall clock too.
   */
  const sessionAnchored = (thread?.sourceType as string | undefined) === "eval";

  // Hydrate span blobs when turn traces arrive
  useEffect(() => {
    if (!turnTraces || turnTraces.length === 0) {
      setHydratedSpans(EMPTY_SPANS);
      setSpanError(null);
      return;
    }

    let isActive = true;
    // Each attempt decides for itself, so a retry that succeeds is not
    // reported through the failure its predecessor left behind.
    setSpanError(null);
    const expectedSpans = expectedTurnTraceSpanCount(turnTraces);
    void hydrateTurnTraceSpans(turnTraces, { sessionAnchored })
      .then((spans) => {
        if (!isActive) return;
        setHydratedSpans(spans);
        // `hydrateTurnTraceSpans` swallows every per-blob failure and returns
        // [], which made a total load failure indistinguishable from a session
        // that never recorded spans — and the timeline then states the wrong
        // one of those two: `getRecordedSpans` reads [] as `undefined`, the
        // timeline lands on `mode: "none"`, and it prints "No timing data
        // recorded" — a claim about the SESSION. `spanCount` is the rows' own
        // record of what should be there, so "expected some, got none" is
        // exactly the case where that claim is false.
        if (expectedSpans > 0 && spans.length === 0) {
          setSpanError(SPAN_LOAD_FAILURE);
        }
      })
      .catch(() => {
        if (!isActive) return;
        setHydratedSpans(EMPTY_SPANS);
        setSpanError(SPAN_LOAD_FAILURE);
      });
    return () => {
      isActive = false;
    };
  }, [turnTraces, sessionAnchored]);

  // Transform snapshots to TraceWidgetSnapshot format
  const widgetSnapshots: TraceWidgetSnapshot[] = useMemo(() => {
    if (!snapshots || !thread) return [];
    return snapshotsToTraceWidgetSnapshots(snapshots);
  }, [snapshots, thread]);

  // Browser-rendered MCP App artifacts (synthetic sessions). Tab visibility =
  // artifact presence, the same heuristic the eval trace viewer uses.
  const renderObservations = browserArtifacts?.widgetRenderObservations ?? [];
  const interactionSteps = browserArtifacts?.browserInteractionSteps ?? [];
  const replayUrl = browserArtifacts?.videoUrl ?? null;
  // The SHARED predicate — observations OR steps OR video. Steps count now that
  // the Replay tab carries the synchronized filmstrip: a session that drove one
  // already-mounted widget by Computer Use has a full recording and no render
  // observations, and used to get no tab at all.
  const hasBrowserArtifacts = hasReplayArtifacts({
    widgetRenderObservations: renderObservations,
    browserInteractionSteps: interactionSteps,
    videoUrl: replayUrl,
  });

  // The "browser" mode is only valid while the LOADED session actually has
  // artifacts. `viewMode` is component state that survives a `threadId`
  // switch, so without this clamp a session without artifacts would render
  // an orphaned empty Browser panel whose tab is hidden (Cursor Bugbot,
  // PR 2610). Render-time fallback (not a reset effect) so flipping back to
  // an artifact-carrying session restores the Browser view.
  const effectiveViewMode: TraceViewMode | "browser" =
    viewMode === "browser" && !hasBrowserArtifacts ? "chat" : viewMode;

  // Build a TraceEnvelope for the TraceViewer (timeline + raw). Browser
  // artifacts ride the envelope so the Raw view includes them.
  const traceEnvelope: TraceEnvelope | null = useMemo(() => {
    if (!messages) return null;
    return {
      ...(thread?.recordedContext
        ? { recordedContext: thread.recordedContext }
        : {}),
      messages: messages as any,
      widgetSnapshots,
      spans: hydratedSpans,
      ...requestPayloadEnvelopeFields(requestPayloads),
      ...(renderObservations.length > 0
        ? { widgetRenderObservations: renderObservations }
        : {}),
      ...(interactionSteps.length > 0
        ? { browserInteractionSteps: interactionSteps }
        : {}),
      ...(replayUrl ? { videoUrl: replayUrl } : {}),
    };
  }, [
    messages,
    thread?.recordedContext,
    widgetSnapshots,
    hydratedSpans,
    requestPayloads,
    replayUrl,
    renderObservations,
    interactionSteps,
  ]);

  // Adapt trace to UI messages for the chat view
  const adaptedTrace = useMemo(() => {
    if (!messages) return null;
    const adapted = adaptTraceToUiMessages({
      trace: { messages: messages as any, widgetSnapshots },
      toolResultDisplay:
        thread?.sourceType === "scenario" ? "attached-to-tool" : "sibling-text",
    });
    return {
      ...adapted,
      messages: hydrateMessageTimestamps(adapted.messages, turnTraces),
    };
  }, [messages, thread?.sourceType, turnTraces, widgetSnapshots]);

  const resolvedModel = useMemo(
    () => modelDefinitionForId(thread?.modelId),
    [thread?.modelId],
  );

  // Trace timing from the turn rows. Non-finite rows are filtered inside the
  // shared helper, matching `hydrateTurnTraceSpans` — without that a single
  // garbage `startedAt` gave the axis a NaN anchor while the spans kept a
  // finite base, measuring labels and positions from two different origins.
  // `null` when nothing usable is left, the same answer as having no traces.
  //
  // An eval thread gets NO anchor rather than a wrong one. `getTraceStartAnchorMs`
  // labels span offset 0 with `traceStartedAtMs`, and for an eval that offset is
  // the RUN start while these rows hold each turn's persist time — the earliest
  // of which lands after turn 1 finished. Passing it would print a clock time
  // for offset 0 that is minutes off. This is the same disqualification that
  // keeps `sessionAnchored` from rebasing off those timestamps; making it twice
  // from one flag is the point of hoisting it.
  const wallClock = useMemo(
    () => turnTraceWallClockRange(turnTraces ?? []),
    [turnTraces],
  );
  const traceStartedAtMs = sessionAnchored ? null : wallClock.startedAtMs;
  const traceEndedAtMs = sessionAnchored ? null : wallClock.endedAtMs;

  const canPromoteThread = Boolean(
    promote?.canPromote &&
      thread?.sourceType &&
      PROMOTABLE_SOURCE_TYPES.has(thread.sourceType),
  );

  /**
   * Why the backend would refuse this promote, when we can know it up front.
   * `null` means "nothing we can see stops it" — never "it will succeed",
   * since the server re-checks everything (BB-247).
   *
   * Only swarm sessions have a run to have finished. Promotion requires their
   * attempt to have reached 'succeeded', and a failed, rate-limited or
   * still-running attempt leaves a transcript that reads exactly like a
   * complete one — so without this the button looked live and the dialog
   * answered with a server error. A missing status (older backend, or an
   * attempt row that claims no session) blocks too: we cannot vouch for it,
   * and offering the action is what produced the bad error in the first place.
   */
  // Ties the button to its explanation for assistive tech; see the render.
  const promoteBlockedReasonId = useId();

  const promoteBlockedReason = useMemo((): string | null => {
    if (!canPromoteThread || thread?.sourceType !== "swarm") return null;
    switch (thread.runAttemptStatus) {
      case "succeeded":
        return null;
      case "pending":
      case "running":
        return "This session is still running. It can be promoted once the run finishes.";
      case "rate_limited":
        return "This session's run stopped on a rate limit, so the conversation is incomplete. Only sessions from runs that finished can become test cases.";
      case "failed":
        return "This session's run did not finish, so the conversation is incomplete. Only sessions from runs that finished can become test cases.";
      case undefined:
        // The BACKEND is older than this client: a deploy that predates the
        // field sends no property at all. Blocking is still right, but this is
        // a deployment problem, not a damaged session, and it hits EVERY swarm
        // session at once. Without this line the only symptom is a trickle of
        // one-off "unknown outcome" tickets that each look like bad data.
        warnMissingRunAttemptStatusOnce();
        return "This session's run outcome is unknown, so it cannot be promoted to a test case.";
      default:
        // `null` (an attempt the backend could not identify) and any status
        // this client has not learned yet. A property of the session, so no
        // warning.
        return "This session's run outcome is unknown, so it cannot be promoted to a test case.";
    }
  }, [canPromoteThread, thread?.sourceType, thread?.runAttemptStatus]);

  // Reset when the viewer switches sessions, so a dialog opened on one thread
  // never lands on the next one — and when the capability goes away, since a
  // parent can withdraw it while this component stays mounted on the same
  // thread (filtering a selected row out of the swarm list, for instance).
  // Without the second dependency, restoring the filter would resurrect the
  // dialog the user had implicitly dismissed.
  useEffect(() => {
    setPromoteOpen(false);
  }, [threadId, canPromoteThread]);

  const handlePromoteImported = useCallback(
    (result: { suiteId: string; testCaseId: string }) => {
      setPromoteOpen(false);
      if (promote?.onImported) {
        promote.onImported(result);
        return;
      }
      // Land the user on the artifact they just created; a toast alone gives
      // them no way back to it. Shared with the per-turn promote action so
      // every surface lands in the same place.
      navigateToPromotedTestCase(result);
    },
    [promote],
  );

  const handleCopySessionRef = useCallback(async () => {
    if (!thread) return;
    const text = sessionLink ?? thread.chatSessionId ?? thread._id;
    const ok = await copyToClipboard(text);
    if (ok) {
      toast.success(
        sessionLink ? "Session link copied" : "Session reference copied",
      );
    } else {
      toast.error("Failed to copy");
    }
  }, [thread, sessionLink]);

  // Loading state: thread query or messages fetch
  if (thread === undefined || isLoadingMessages) {
    return (
      <div className="flex h-full items-center justify-center">
        <TranscriptEmptyState kind="loading" />
      </div>
    );
  }

  if (thread === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Thread not found</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!adaptedTrace || adaptedTrace.messages.length === 0) {
    // A swarm session with no persisted transcript (a failed or empty attempt)
    // must still expose the on-demand judge entry point — the verdict grades
    // the journey goal, not the transcript. Render a minimal shell with the
    // judge section instead of a dead-end "No messages" message.
    if (thread.sourceType === "swarm") {
      // Unless its attempt ended without recording a single message (#5188):
      // then there is nothing to judge or promote, and "may not have run" is a
      // guess about something the attempt row already knows. Say it never
      // ran, and why.
      if (thread.runAttemptStatus && threadNeverRan(thread)) {
        return (
          <div className="flex h-full items-center justify-center px-6">
            <SwarmSessionNotRun
              status={thread.runAttemptStatus}
              errorCode={thread.runAttemptErrorCode}
              errorMessage={thread.runAttemptErrorMessage}
              modelId={thread.modelId}
            />
          </div>
        );
      }
      return (
        <div className="flex h-full flex-col">
          <SwarmJudgeSection threadId={threadId} goalScore={thread.goalScore} />
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
            <TranscriptEmptyState kind="unrecorded" execution={(turnTraces?.length ?? 0) > 0 ? "observed" : "unknown"} />
            {/* This branch has no header, so the disabled promote button and
                its hover reason never render here — and an empty transcript is
                USUALLY a run that died before it said anything, which is the
                question the reader has. Say it in the empty state instead of
                leaving them to guess (BB-247, CodeRabbit on PR 5127). */}
            {promoteBlockedReason ? (
              <p
                className="max-w-sm text-xs text-muted-foreground"
                data-testid="share-usage-empty-promote-blocked"
              >
                {promoteBlockedReason}
              </p>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <TranscriptEmptyState kind="unrecorded" execution={(turnTraces?.length ?? 0) > 0 ? "observed" : "unknown"} />
      </div>
    );
  }

  const isScenarioThread = thread.sourceType === "scenario";
  const reasoningDisplayMode = isScenarioThread ? "collapsible" : "collapsed";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hideHeader ? null : (
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
        <div className="flex min-w-0 items-center gap-3">
          <p className="truncate text-sm font-semibold text-card-foreground">
            {thread.visitorDisplayName}
          </p>
          {/* Which client and model ran this session — beside the name on both
              products, so nobody has to open Raw or the trace to find out. */}
          <SessionClientModelChip
            sessionId={thread._id}
            modelId={thread.modelId}
          />
          <SessionFeedbackMark thread={thread} variant="header" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {thread.sourceType === "direct" && thread.chatSessionId && (
            <Button asChild variant="outline" size="sm">
              <a
                href={`/playground?${new URLSearchParams({
                  conversation: thread.chatSessionId,
                  ...(hasBrowserArtifacts ? { browser: "open" } : {}),
                  ...(thread.projectId ?? promote?.projectId
                    ? { project: (thread.projectId ?? promote?.projectId)! }
                    : {}),
                }).toString()}`}
              >
                Open in Playground
              </a>
            </Button>
          )}
          {canPromoteThread ? (
            promoteBlockedReason ? (
              /* Shown inert rather than hidden: a missing button reads as a
                 surface that lost a feature, while one that says why answers
                 the question the reader actually has.

                 `aria-disabled` rather than `disabled`, so the control stays
                 in the tab order and its reason is reachable without a mouse.
                 A truly disabled button takes no focus and fires no pointer
                 events, which leaves keyboard and touch users with no path to
                 an explanation that only exists in a hover hint. The reason is
                 therefore carried three ways: `title` for the mouse, an
                 `aria-describedby` target for assistive tech, and the visible
                 empty-state copy further up for a session with no transcript.
                 Inertness comes from never wiring `setPromoteOpen`, not from
                 any handler. The design system hangs its disabled styling off
                 the `disabled:` variant, which by definition never matches
                 here, so the muted look and the dead cursor are spelled out. */
              <span
                className="inline-flex"
                data-testid="share-usage-promote-blocked"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 cursor-not-allowed rounded-lg px-2.5 text-xs opacity-50 hover:bg-transparent hover:text-current"
                  data-testid="share-usage-promote-to-test-case"
                  title={promoteBlockedReason}
                  aria-disabled
                  aria-describedby={promoteBlockedReasonId}
                >
                  Promote to test case
                </Button>
                <span id={promoteBlockedReasonId} className="sr-only">
                  {promoteBlockedReason}
                </span>
              </span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-lg px-2.5 text-xs"
                data-testid="share-usage-promote-to-test-case"
                onClick={() => setPromoteOpen(true)}
              >
                Promote to test case
              </Button>
            )
          ) : null}
          <SessionAnalyzeNowButton thread={thread} />
          {/* Labeled, never icon-only: readers who wanted to send a session to
              a teammate did not recognize the copy icon as the way to do it.
              Same label on Swarm and User Testing. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-lg px-2.5 text-xs"
            data-testid="share-usage-share-session"
            title={
              sessionLink
                ? "Copy a link to this session"
                : "Copy this session's reference"
            }
            onClick={() => void handleCopySessionRef()}
          >
            <Share2 className="mr-1.5 size-3.5" />
            Share this session
          </Button>
        </div>
      </div>
      )}

      {/* Swarm-only: render before the first score exists so deployments with
          automatic judging disabled still expose the on-demand entry point. */}
      {thread.sourceType === "swarm" ? (
        <SwarmJudgeSection threadId={threadId} goalScore={thread.goalScore} />
      ) : null}

      {/* Trace / Chat / [Browser] / Raw tabs. The Browser tab appears when the
          session carries browser-rendered MCP App artifacts (synthetic runs);
          its active mode lives outside the shared TraceViewMode union. */}
      <ChatTraceViewModeHeaderBar
        mode={effectiveViewMode === "browser" ? "chat" : effectiveViewMode}
        onModeChange={setViewMode}
        showBrowserTab={hasBrowserArtifacts}
        browserActive={effectiveViewMode === "browser"}
        onSelectBrowser={() => setViewMode("browser")}
      />

      {/* Content area: must be a flex column so TraceViewer (fillContent) is a flex item; otherwise
          nested flex-1 / min-h-0 inside TraceTimeline collapses and the timeline paints empty. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveViewMode === "browser" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <BrowserArtifactsView
              observations={renderObservations}
              steps={interactionSteps}
              videoUrl={replayUrl}
            />
          </div>
        ) : effectiveViewMode === "chat" ? (
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              // `scroll-fade-y`, not `-b`: the top edge runs under the tab bar
              // and cuts a message just as flatly there. Each edge only paints
              // when there is something to scroll toward, so a transcript that
              // fits shows neither.
              fadeScrollEdges && "scroll-fade-y",
            )}
          >
            {host.status === "ready" ? (
              <ErrorBoundary
                // Retrying for a new session must also retry its ratings query.
                key={threadId}
                fallback={
                  <TraceViewer
                    trace={traceEnvelope}
                    adaptedTrace={adaptedTrace}
                    model={resolvedModel}
                    hostSnapshot={host.snapshot}
                    chatSessionId={thread.chatSessionId}
                    forcedViewMode="chat"
                    hideToolbar
                    frame="none"
                    interactive={false}
                    reasoningDisplayMode={reasoningDisplayMode}
                    widgetPolicy="live"
                  />
                }
              >
                <SessionScoredTranscript
                  threadId={threadId}
                  trace={traceEnvelope}
                  adaptedTrace={adaptedTrace}
                  model={resolvedModel}
                  hostSnapshot={host.snapshot}
                  chatSessionId={thread.chatSessionId}
                  forcedViewMode="chat"
                  hideToolbar
                  frame="none"
                  interactive={false}
                  reasoningDisplayMode={reasoningDisplayMode}
                  widgetPolicy="live"
                />
              </ErrorBoundary>
            ) : host.status === "loading" ? (
              <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Loading host configuration…
              </div>
            ) : (
              <p role="alert" className="p-8 text-sm text-muted-foreground">
                Could not load this session's host configuration.
              </p>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Same warning the swarm pane carries, for the same reason: the
                timeline below states "No timing data recorded" whenever it has
                no spans, which is a claim about the SESSION — and it is false
                when the spans exist and the fetch is what failed. This surface
                used to stay silent while the swarm one spoke, so the two views
                of one session disagreed about whether anything was wrong. */}
            {spanError ? (
              <div
                className="mx-4 mt-2 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning-foreground"
                data-testid="share-usage-span-error"
              >
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                {spanError} — {SPAN_LOAD_FAILURE_CONSEQUENCE}.
              </div>
            ) : null}
            <TraceViewer
              trace={traceEnvelope}
              model={resolvedModel}
              forcedViewMode={effectiveViewMode === "raw" ? "raw" : "timeline"}
              // Raw, not the timeline beside it: the same switch, because a
              // reader who wants softened edges on one scrolling pane of a
              // session wants them on the other. The timeline is excluded by
              // `TraceViewer` itself, not here — see the prop's note.
              rawFadeScrollEdges={fadeScrollEdges}
              hideToolbar
              fillContent
              traceStartedAtMs={traceStartedAtMs}
              traceEndedAtMs={traceEndedAtMs}
              interactive={false}
            />
          </div>
        )}
      </div>

      {/* Mounted only when the button that opens it can render, so guest and
          non-promotable sessions don't pay for the dialog's project queries. */}
      {promote && canPromoteThread ? (
        <ConvertPromotableSessionDialog
          open={promoteOpen}
          sessionId={threadId}
          seedProjectId={promote.projectId}
          seedTitle={thread?.visitorDisplayName ?? thread?.firstMessagePreview}
          onOpenChange={setPromoteOpen}
          onImported={handlePromoteImported}
        />
      ) : null}
    </div>
  );
}
