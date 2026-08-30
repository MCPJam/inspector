import { useAction, useConvexAuth } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { SWARM_ACTIONS, type SwarmSessionPromoteDetail } from "@/lib/swarm-api";
import {
  ConvertSessionDialogCore,
  type PromoteSessionDetailState,
  type PromoteSessionSummary,
} from "@/components/chat-v2/history/convert-session-dialog-core";

type ConvertPromotableSessionDialogProps = {
  open: boolean;
  /** `chatSessions._id` — what `importChatSessionToTestCase` takes. */
  sessionId: string | null;
  /**
   * The parent's known project, used until the action's authoritative
   * `projectId` arrives. `SharedChatThread` carries no project, so the
   * surface that owns the session supplies it.
   */
  seedProjectId: string | null;
  /** Fallback title while the detail read is in flight. */
  seedTitle?: string | null;
  onOpenChange: (open: boolean) => void;
  onImported: (result: { suiteId: string; testCaseId: string }) => void;
};

const IDLE_DETAIL: PromoteSessionDetailState = {
  loading: false,
  error: null,
  usedServerIds: [],
  selectedServers: [],
};

function buildTitle(
  detail: SwarmSessionPromoteDetail | null,
  seedTitle: string | null | undefined
): string {
  return (
    detail?.title ||
    detail?.firstMessagePreview?.slice(0, 60) ||
    seedTitle ||
    // Matches the sibling direct adapter and the core's placeholder — both
    // feed the same dialog, so the fallback should read the same.
    "Imported chat"
  );
}

/**
 * Source-agnostic adapter for {@link ConvertSessionDialogCore}.
 *
 * `chatSessionPromote:getChatSessionPromoteDetail` authorizes and shapes any
 * promotable sourceType, so swarm and User Testing sessions share one
 * adapter rather than forking per surface. The per-source rules all live
 * server-side (member tier where it applies, the swarm completion gate), and
 * surface as this dialog's detail error — a session that cannot be promoted
 * says so on open instead of failing at submit.
 *
 * `defaultHostId` pre-seeds the new-suite client attachment with the host the
 * session actually executes against, so a promoted case replays against the
 * same client emulation. It prefers the backend's `suggestedHostAttachment`
 * over the raw `hostId`: on environment-backed scenarios the session row
 * records the PUBLISH-TIME host (display-only), while the environment — which
 * live-follows and may have been re-pointed since — owns the real one. Falling
 * back to `hostId` keeps this working against a backend that predates the
 * field. `hostDefaultResolved` keeps a cached `projectHosts[0]` from winning
 * the initial-render race.
 *
 * Signed-in only. The direct/playground path keeps its own adapter because it
 * must also serve guest and HOSTED_MODE actors over the HTTP detail route,
 * which this Convex action cannot.
 */
export function ConvertPromotableSessionDialog({
  open,
  sessionId,
  seedProjectId,
  seedTitle,
  onOpenChange,
  onImported,
}: ConvertPromotableSessionDialogProps) {
  const { isAuthenticated } = useConvexAuth();
  const getPromoteDetail = useAction(
    SWARM_ACTIONS.getChatSessionPromoteDetail as any
  );
  const [detail, setDetail] = useState<PromoteSessionDetailState>(IDLE_DETAIL);
  const [promoteDetail, setPromoteDetail] =
    useState<SwarmSessionPromoteDetail | null>(null);
  // Guard against a stale response landing after the user switched sessions.
  const resolvedPromoteDetail =
    sessionId && promoteDetail?.sessionId === sessionId ? promoteDetail : null;

  useEffect(() => {
    if (!open || !sessionId) {
      return;
    }

    setDetail({ ...IDLE_DETAIL, loading: true });
    setPromoteDetail(null);

    let cancelled = false;

    void (async () => {
      try {
        const response = (await getPromoteDetail({
          sessionId,
        })) as SwarmSessionPromoteDetail;
        if (cancelled) {
          return;
        }

        setPromoteDetail(response);
        setDetail({
          loading: false,
          error: null,
          usedServerIds: response.usedServerIds ?? [],
          selectedServers: response.selectedServers ?? [],
          // Forwarded verbatim. The adapter never decides this from
          // `sourceType`: a synthetic scenario session IS a scenario session
          // and would be asked, wrongly, by any client-side rule.
          requiresContentTransferAcknowledgement:
            response.requiresContentTransferAcknowledgement === true,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load session";
        setDetail({ ...IDLE_DETAIL, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getPromoteDetail, open, sessionId]);

  useEffect(() => {
    if (!open) {
      setDetail(IDLE_DETAIL);
      setPromoteDetail(null);
    }
  }, [open]);

  const summary = useMemo<PromoteSessionSummary | null>(
    () =>
      sessionId
        ? {
            sessionId,
            title: buildTitle(resolvedPromoteDetail, seedTitle),
            projectId: resolvedPromoteDetail?.projectId ?? seedProjectId,
          }
        : null,
    [resolvedPromoteDetail, seedProjectId, seedTitle, sessionId]
  );

  return (
    <ConvertSessionDialogCore
      open={open}
      summary={summary}
      detail={detail}
      isAuthenticated={isAuthenticated}
      defaultHostId={
        resolvedPromoteDetail?.suggestedHostAttachment?.namedHostId ??
        resolvedPromoteDetail?.hostId ??
        null
      }
      hostDefaultResolved={resolvedPromoteDetail !== null}
      onOpenChange={onOpenChange}
      onImported={onImported}
    />
  );
}
