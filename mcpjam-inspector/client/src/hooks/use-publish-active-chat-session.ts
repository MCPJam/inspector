import { useLayoutEffect, useState } from "react";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";

/** Publish row and App lifetime atomically, without a null gap on continuation. */
export function usePublishActiveChatSession(
  sessionId: string,
  appSessionScopeId: string,
  compareActive: boolean,
  viewOnly: boolean,
) {
  const [owner] = useState(() => Symbol("active-chat"));
  useLayoutEffect(() => {
    useActiveChatSessionStore.getState().publishSession(owner, {
      sessionId,
      appSessionScopeId,
      compareActive,
      viewOnly,
    });
  }, [owner, sessionId, appSessionScopeId, compareActive, viewOnly]);
  useLayoutEffect(
    () => () => {
      useActiveChatSessionStore.getState().releaseSession(owner);
    },
    [owner],
  );
}
