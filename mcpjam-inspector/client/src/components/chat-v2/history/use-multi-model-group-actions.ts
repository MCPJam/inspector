import { useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  chatHistoryGroupAction,
  type MultiModelGroupAction,
} from "@/lib/apis/web/chat-history-api";
import type { MultiModelGroupActions } from "./ChatHistoryGroupRow";

const actOnCurrentMultiModelGroup = makeFunctionReference<
  "mutation",
  { groupId: string; action: MultiModelGroupAction; title?: string }
>("directChatHistory/multiModelGroups:actOnCurrentMultiModelGroup");

/**
 * Rename, pin and archive for a whole multi-model session, in one change on
 * the backend. Signed-in callers use the live query's mutation; others go
 * through the history route and refetch, as the per-session actions do.
 */
export function useMultiModelGroupActions(args: {
  isReactive: boolean;
  requestHeaders?: HeadersInit;
  refetch: () => void;
}): MultiModelGroupActions {
  const { isReactive, requestHeaders, refetch } = args;
  const actReactive = useMutation(actOnCurrentMultiModelGroup);

  const act = useCallback(
    async (groupId: string, action: MultiModelGroupAction, title?: string) => {
      if (isReactive) {
        await actReactive({ groupId, action, ...(title !== undefined ? { title } : {}) });
        return;
      }
      await chatHistoryGroupAction(action, groupId, title, {
        headers: requestHeaders,
      });
      refetch();
    },
    [actReactive, isReactive, refetch, requestHeaders],
  );

  return useMemo(
    () => ({
      rename: (groupId: string, title: string) => act(groupId, "rename", title),
      pin: (groupId: string) => act(groupId, "pin"),
      unpin: (groupId: string) => act(groupId, "unpin"),
      archive: (groupId: string) => act(groupId, "archive"),
      unarchive: (groupId: string) => act(groupId, "unarchive"),
    }),
    [act],
  );
}
