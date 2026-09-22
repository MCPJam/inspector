import { useEffect, useRef } from "react";
import { isBrowserToolName } from "./useOpenBrowserOnBrowsing";
import {
  useBrowserComparisonStore,
  type BrowserComparisonClient,
} from "@/stores/browser-comparison-store";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";

/** Observe the transcript independently of Chat/Trace/Raw rendering. */
export function useComparisonBrowser(
  client: BrowserComparisonClient | null,
  messages: readonly { parts?: readonly unknown[] }[],
) {
  const seen = useRef(new Set<string>());
  const workspaceId = client?.workspaceId;
  const sessionId = client?.sessionId;
  useEffect(() => {
    if (client) useBrowserComparisonStore.getState().register(client);
  }, [
    workspaceId,
    sessionId,
    client?.projectId,
    client?.clientId,
    client?.name,
    client?.logo,
    client?.order,
    client?.clientCount,
    client?.engine,
  ]);
  useEffect(() => {
    seen.current.clear();
    return () => {
      if (sessionId && workspaceId)
        useBrowserComparisonStore.getState().unregister(sessionId, workspaceId);
    };
  }, [workspaceId, sessionId]);
  useEffect(() => {
    if (!sessionId || !workspaceId) return;
    for (const message of messages)
      for (const raw of message.parts ?? []) {
        const part = raw as {
          type?: string;
          toolName?: string;
          state?: string;
          toolCallId?: string;
        };
        const name =
          part.type === "dynamic-tool"
            ? part.toolName
            : part.type?.replace(/^tool-/, "");
        if (
          !isBrowserToolName(name) ||
          !part.toolCallId ||
          seen.current.has(part.toolCallId)
        )
          continue;
        if (
          part.state !== "input-streaming" &&
          part.state !== "input-available"
        )
          continue;
        seen.current.add(part.toolCallId);
        useBrowserWorkspaceStore.getState().openBrowser(sessionId);
      }
  }, [messages, workspaceId, sessionId]);
}
