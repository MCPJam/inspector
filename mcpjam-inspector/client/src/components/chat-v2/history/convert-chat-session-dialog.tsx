import { useEffect, useMemo, useState } from "react";
import {
  getChatHistoryDetail,
  type ChatHistorySession,
} from "@/lib/apis/web/chat-history-api";
import { normalizeServerNames } from "@/components/evals/suite-environment-utils";
import {
  ConvertSessionDialogCore,
  type PromoteSessionDetailState,
  type PromoteSessionSummary,
} from "./convert-session-dialog-core";

type ConvertChatSessionDialogProps = {
  open: boolean;
  session: ChatHistorySession | null;
  isAuthenticated: boolean;
  projectId: string | null;
  requestHeaders?: HeadersInit;
  onOpenChange: (open: boolean) => void;
  onImported: (result: { suiteId: string; testCaseId: string }) => void;
};

function getSessionTitle(session: ChatHistorySession | null): string {
  if (!session) {
    return "Imported chat";
  }
  return (
    session.customTitle ||
    session.firstMessagePreview.slice(0, 60) ||
    "Imported chat"
  );
}

const IDLE_DETAIL: PromoteSessionDetailState = {
  loading: false,
  error: null,
  usedServerIds: [],
  selectedServers: [],
};

/**
 * Direct-history adapter for {@link ConvertSessionDialogCore}: resolves the
 * session-servers detail through the existing `/api/web/chat-history/detail`
 * route (which also serves guest/HOSTED_MODE actors via `requestHeaders`) and
 * keeps the exact props ChatHistoryRail has always passed. Swarm sessions go
 * through `ConvertSwarmSessionDialog`, a sibling adapter over the same core.
 */
export function ConvertChatSessionDialog({
  open,
  session,
  isAuthenticated,
  projectId,
  requestHeaders,
  onOpenChange,
  onImported,
}: ConvertChatSessionDialogProps) {
  const effectiveProjectId = session?.projectId ?? projectId ?? null;
  const [detail, setDetail] = useState<PromoteSessionDetailState>(IDLE_DETAIL);

  useEffect(() => {
    if (!open || !session) {
      return;
    }

    setDetail({ ...IDLE_DETAIL, loading: true });

    let cancelled = false;

    void (async () => {
      try {
        const response = await getChatHistoryDetail(
          {
            sessionId: session._id,
            chatSessionId: session.chatSessionId,
            projectId: effectiveProjectId ?? undefined,
          },
          {
            headers: requestHeaders,
          },
        );
        if (cancelled) {
          return;
        }

        setDetail({
          loading: false,
          error: null,
          usedServerIds: normalizeServerNames(response.session.usedServerIds),
          selectedServers: normalizeServerNames(
            response.session.resumeConfig?.selectedServers,
          ),
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load chat session";
        setDetail({ ...IDLE_DETAIL, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId, open, requestHeaders, session]);

  useEffect(() => {
    if (!open) {
      setDetail(IDLE_DETAIL);
    }
  }, [open]);

  const summary = useMemo<PromoteSessionSummary | null>(
    () =>
      session
        ? {
            sessionId: session._id,
            title: getSessionTitle(session),
            projectId: effectiveProjectId,
          }
        : null,
    [effectiveProjectId, session],
  );

  return (
    <ConvertSessionDialogCore
      open={open}
      summary={summary}
      detail={detail}
      isAuthenticated={isAuthenticated}
      onOpenChange={onOpenChange}
      onImported={onImported}
    />
  );
}
