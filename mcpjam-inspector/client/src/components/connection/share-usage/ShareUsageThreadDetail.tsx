import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { copyToClipboard } from "@/lib/clipboard";
import type { ModelDefinition, ModelProvider } from "@/shared/types";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  ReadOnlyTranscript,
  type ToolRenderOverride as ChatUiToolRenderOverride,
} from "@mcpjam/chat-ui";
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
import { ConvertPromotableSessionDialog } from "@/components/chat-v2/history/convert-promotable-session-dialog";
import { navigateToPromotedTestCase } from "@/components/chat-v2/shared/promote-to-eval-navigation";
import { useAction } from "convex/react";
import { Gavel, RotateCcw } from "lucide-react";
import { JudgeVerdictCard } from "@/components/shared/session-quality/judge-presentation";
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
    "swarmJudge:requestSwarmSessionJudge" as never
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
    [requestJudge, threadId]
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

/**
 * Bridge inspector ToolRenderOverrides — whose widget/CSP fields use the MCP
 * Apps SDK types — to chat-ui's placeholder types. The read-only transcript
 * never reads those widget-specific fields, so the cast is safe. Kept as a
 * named seam so future read-only consumers can reuse it.
 */
function bridgeToolRenderOverrides(
  overrides: Record<string, unknown> | undefined
): Record<string, ChatUiToolRenderOverride> | undefined {
  return overrides as Record<string, ChatUiToolRenderOverride> | undefined;
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
}

/**
 * Surfaces whose sessions the shared promote dialog can carry.
 *
 * Mirrors the backend allowlist (`PROMOTABLE_CHAT_SESSION_SOURCE_TYPES`)
 * minus `direct`, which keeps its own adapter because it must also serve
 * guest/HOSTED_MODE actors over the HTTP detail route.
 */
const PROMOTABLE_SOURCE_TYPES = new Set(["swarm", "scenario"]);

export function ShareUsageThreadDetail({
  threadId,
  sessionLink,
  promote,
}: ShareUsageThreadDetailProps) {
  const { thread } = useSharedChatThread({ threadId });
  const { snapshots } = useSharedChatWidgetSnapshots({ threadId });
  const { traces: turnTraces } = useSharedChatTurnTraces({ threadId });
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

  // Fetch messages from blob URL
  useEffect(() => {
    if (!thread?.messagesBlobUrl) {
      setMessages(null);
      return;
    }

    let isActive = true;
    const controller = new AbortController();

    async function fetchMessages() {
      setIsLoadingMessages(true);
      setError(null);
      try {
        const response = await fetch(thread!.messagesBlobUrl!, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.status}`);
        }
        const data = await response.json();
        if (isActive) {
          setMessages(data);
        }
      } catch (err) {
        if (!isActive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load thread messages:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load messages"
        );
      } finally {
        if (isActive) {
          setIsLoadingMessages(false);
        }
      }
    }

    void fetchMessages();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [thread?.messagesBlobUrl]);

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
    // Eval blobs are anchored at the RUN start by `drive-local-eval-turn`,
    // while their per-turn rows carry a persist-time `turnStartedAt`. Rebasing
    // those would displace every span by the persist round-trip, so this
    // thread keeps the offsets its blobs already carry.
    // Compared as a string on purpose: `SharedChatSourceType` is
    // `"scenario" | "swarm"`, so TS calls this branch dead — but the sessions
    // feed types the same field as `"direct" | "scenario" | "eval" | "swarm"`
    // and `SessionsPanel` renders this component for every row without a
    // gate. The narrow type is the thing that is wrong here, not the check.
    const sessionAnchored =
      (thread?.sourceType as string | undefined) === "eval";
    void hydrateTurnTraceSpans(turnTraces, { sessionAnchored })
      .then((spans) => {
        if (!isActive) return;
        setHydratedSpans(spans);
        // `hydrateTurnTraceSpans` swallows every per-blob failure and returns
        // [], which made a total load failure indistinguishable from a session
        // that never recorded spans — and that is not a blank timeline:
        // `getRecordedSpans` reads [] as `undefined`, so the viewer silently
        // falls back to a timeline SYNTHESIZED from `estimatedDurationMs`. An
        // entirely estimated timeline shown without a word is BB-153 wearing a
        // confident face. `spanCount` is the rows' own record of what should be
        // there, so "expected some, got none" is precisely that failure.
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
  }, [turnTraces, thread?.sourceType]);

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
      messages: messages as any,
      widgetSnapshots,
      spans: hydratedSpans,
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
    widgetSnapshots,
    hydratedSpans,
    replayUrl,
    renderObservations,
    interactionSteps,
  ]);

  // Adapt trace to UI messages for the chat view
  const adaptedTrace = useMemo(() => {
    if (!messages) return null;
    return adaptTraceToUiMessages({
      trace: { messages: messages as any, widgetSnapshots },
      toolResultDisplay:
        thread?.sourceType === "scenario" ? "attached-to-tool" : "sibling-text",
    });
  }, [messages, thread?.sourceType, widgetSnapshots]);

  const resolvedModel: ModelDefinition = useMemo(
    () => ({
      id: thread?.modelId ?? "unknown",
      name: thread?.modelId ?? "Unknown",
      provider: "custom" as ModelProvider,
    }),
    [thread?.modelId]
  );

  // Trace timing from the turn rows. Non-finite rows are filtered inside the
  // shared helper, matching `hydrateTurnTraceSpans` — without that a single
  // garbage `startedAt` gave the axis a NaN anchor while the spans kept a
  // finite base, measuring labels and positions from two different origins.
  // `null` when nothing usable is left, the same answer as having no traces.
  const { startedAtMs: traceStartedAtMs, endedAtMs: traceEndedAtMs } = useMemo(
    () => turnTraceWallClockRange(turnTraces ?? []),
    [turnTraces]
  );

  const canPromoteThread = Boolean(
    promote?.canPromote &&
      thread?.sourceType &&
      PROMOTABLE_SOURCE_TYPES.has(thread.sourceType)
  );

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
    [promote]
  );

  const handleCopySessionRef = useCallback(async () => {
    if (!thread) return;
    const text = sessionLink ?? thread.chatSessionId ?? thread._id;
    const ok = await copyToClipboard(text);
    if (ok) {
      toast.success(
        sessionLink ? "Session link copied" : "Session reference copied"
      );
    } else {
      toast.error("Failed to copy");
    }
  }, [thread, sessionLink]);

  // Loading state: thread query or messages fetch
  if (thread === undefined || isLoadingMessages) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
      return (
        <div className="flex h-full flex-col">
          <SwarmJudgeSection threadId={threadId} goalScore={thread.goalScore} />
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No messages in this session
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No messages in thread</p>
      </div>
    );
  }

  const isScenarioThread = thread.sourceType === "scenario";
  const reasoningDisplayMode = isScenarioThread ? "collapsible" : "collapsed";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
        <div className="flex min-w-0 items-center gap-3">
          <p className="truncate text-sm font-semibold text-card-foreground">
            {thread.visitorDisplayName}
          </p>
          <SessionFeedbackMark thread={thread} variant="header" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canPromoteThread ? (
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
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 rounded-lg px-0"
            aria-label={
              sessionLink ? "Copy session link" : "Copy session ID"
            }
            onClick={() => void handleCopySessionRef()}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      </div>

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
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Ships dark: `sessionScores:listBySession` reaches production
                only on the next release promotion, and `useQuery` against an
                undeployed function throws. The fallback is the transcript
                itself — losing the conversation to a missing ratings query
                would be a far worse failure than losing the ratings. */}
            <ErrorBoundary
              // Keyed on the session so the boundary RETRIES. Without it a
              // single throw during the pre-deployment window latches the
              // fallback for the life of the mounted detail — every session a
              // PM opened afterwards would show a transcript with no ratings
              // even once the backend went live.
              key={threadId}
              fallback={
                <ReadOnlyTranscript
                  messages={adaptedTrace.messages}
                  model={resolvedModel}
                  toolRenderOverrides={bridgeToolRenderOverrides(
                    adaptedTrace.toolRenderOverrides
                  )}
                  reasoningDisplayMode={reasoningDisplayMode}
                  widgetPolicy="placeholder"
                  className="mx-auto max-w-4xl px-4 py-4"
                />
              }
            >
              <SessionScoredTranscript
                threadId={threadId}
                messages={adaptedTrace.messages}
                model={resolvedModel}
                toolRenderOverrides={bridgeToolRenderOverrides(
                  adaptedTrace.toolRenderOverrides
                )}
                reasoningDisplayMode={reasoningDisplayMode}
                widgetPolicy="placeholder"
                className="mx-auto max-w-4xl px-4 py-4"
              />
            </ErrorBoundary>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Same warning the swarm pane carries, for the same reason: with
                no recorded spans the timeline below is SYNTHESIZED from
                `estimatedDurationMs`, and showing that without a word is
                BB-153 over again. This surface used to stay silent while the
                swarm one spoke, so the two views of one session disagreed
                about whether anything was wrong. */}
            {spanError ? (
              <div
                className="mx-4 mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
                data-testid="share-usage-span-error"
              >
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                {spanError} — durations below are estimated.
              </div>
            ) : null}
            <TraceViewer
              trace={traceEnvelope}
              model={resolvedModel}
              forcedViewMode={effectiveViewMode === "raw" ? "raw" : "timeline"}
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
