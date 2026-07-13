import { useAction, useConvexAuth } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import {
  SWARM_ACTIONS,
  type JourneySessionRow,
  type SwarmSessionPromoteDetail,
} from "@/lib/swarm-api";
import {
  ConvertSessionDialogCore,
  type PromoteSessionDetailState,
  type PromoteSessionSummary,
} from "@/components/chat-v2/history/convert-session-dialog-core";

type ConvertSwarmSessionDialogProps = {
  open: boolean;
  session: JourneySessionRow | null;
  onOpenChange: (open: boolean) => void;
  onImported: (result: { suiteId: string; testCaseId: string }) => void;
};

const IDLE_DETAIL: PromoteSessionDetailState = {
  loading: false,
  error: null,
  usedServerIds: [],
  selectedServers: [],
};

function buildTitle(detail: SwarmSessionPromoteDetail | null): string {
  if (!detail) {
    return "Imported swarm session";
  }
  return (
    detail.title ||
    detail.firstMessagePreview.slice(0, 60) ||
    "Imported swarm session"
  );
}

/**
 * Swarm adapter for {@link ConvertSessionDialogCore}: resolves the
 * session-servers detail through the source-agnostic
 * `chatSessionPromote:getChatSessionPromoteDetail` action (signed-in only —
 * the swarm surface is already gated at project member). The action enforces
 * the swarm completion gate server-side, so a mid-run session surfaces its
 * rejection here as the dialog's detail error rather than failing at submit.
 *
 * `defaultHostId` pre-seeds the new-suite client attachment from the
 * ACTION's hostId (the session row's authoritative attribution) — the list
 * row's copy is a display convenience. Provenance itself is derived by the
 * backend at import time; nothing here is sent back.
 */
export function ConvertSwarmSessionDialog({
  open,
  session,
  onOpenChange,
  onImported,
}: ConvertSwarmSessionDialogProps) {
  const { isAuthenticated } = useConvexAuth();
  const getPromoteDetail = useAction(
    SWARM_ACTIONS.getChatSessionPromoteDetail as any
  );
  const [detail, setDetail] = useState<PromoteSessionDetailState>(IDLE_DETAIL);
  const [promoteDetail, setPromoteDetail] =
    useState<SwarmSessionPromoteDetail | null>(null);
  const resolvedPromoteDetail =
    session && promoteDetail?.sessionId === session.id ? promoteDetail : null;

  useEffect(() => {
    if (!open || !session) {
      return;
    }

    setDetail({ ...IDLE_DETAIL, loading: true });
    setPromoteDetail(null);

    let cancelled = false;

    void (async () => {
      try {
        const response = (await getPromoteDetail({
          sessionId: session.id,
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
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load swarm session";
        setDetail({ ...IDLE_DETAIL, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getPromoteDetail, open, session]);

  useEffect(() => {
    if (!open) {
      setDetail(IDLE_DETAIL);
      setPromoteDetail(null);
    }
  }, [open]);

  const summary = useMemo<PromoteSessionSummary | null>(
    () =>
      session
        ? {
            sessionId: session.id,
            title: buildTitle(resolvedPromoteDetail),
            projectId: session.projectId,
          }
        : null,
    [resolvedPromoteDetail, session]
  );

  return (
    <ConvertSessionDialogCore
      open={open}
      summary={summary}
      detail={detail}
      isAuthenticated={isAuthenticated}
      defaultHostId={resolvedPromoteDetail?.hostId ?? null}
      hostDefaultResolved={resolvedPromoteDetail !== null}
      onOpenChange={onOpenChange}
      onImported={onImported}
    />
  );
}
