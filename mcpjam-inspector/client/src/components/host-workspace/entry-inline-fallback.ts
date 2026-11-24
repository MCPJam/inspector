import { useMemo } from "react";
import type { ThreadAppDeclaration } from "./thread-app-api";
import type { ThreadAppWorkspace, WorkspaceServer } from "./ThreadAppPanel";
import { logExtensionEvent } from "./extension-log";

/** The part of the extension store this needs: who owns which chat. */
interface ChatOwnerState {
  currentChatId: string | null;
  chats: Record<string, ThreadAppWorkspace>;
}
export interface ChatOwnerStore {
  getState(): ChatOwnerState;
  subscribe(listener: (state: ChatOwnerState) => void): () => void;
}

/**
 * Starts a new chat the way New chat does and resolves to its id, or to null
 * when none started: a reply is streaming, the person kept their draft,
 * another transition is pending, or it ran out of time.
 */
export type BeginNewChat = (isCurrent: () => boolean) => Promise<string | null>;

export type InlineOpening = "opened" | "no-chat" | "chat-changed";

/** The chat's owner once the provider publishes it; null when another chat
 * is shown first or it doesn't appear in time. */
export function waitForChatOwner(
  store: ChatOwnerStore,
  chatId: string,
  timeoutMs: number,
): Promise<ThreadAppWorkspace | null> {
  return new Promise((resolve) => {
    // The chat the provider shows until it catches up with the new one.
    const before = store.getState().currentChatId;
    let done = false;
    const finish = (owner: ThreadAppWorkspace | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(owner);
    };
    const check = ({ chats, currentChatId }: ChatOwnerState) => {
      if (chats[chatId]) finish(chats[chatId]);
      else if (currentChatId !== before && currentChatId !== chatId)
        finish(null);
    };
    const unsubscribe = store.subscribe(check);
    const timer = setTimeout(() => finish(null), timeoutMs);
    check(store.getState());
  });
}

const MESSAGES: Record<InlineOpening, (title: string) => string> = {
  opened: (title) =>
    `${title} doesn't support full screen, so it opened inline in a new chat.`,
  "no-chat": (title) =>
    `${title} doesn't support full screen and needs a new chat, which couldn't start. Open it again from Apps after the reply finishes, or after you send or discard your draft.`,
  "chat-changed": (title) =>
    `${title} doesn't support full screen and needs a new chat, but another chat was opened first. Open it again from Apps.`,
};

interface InlineOpeningRequest {
  store: ChatOwnerStore;
  server: WorkspaceServer;
  declaration: ThreadAppDeclaration;
  beginNewChat: BeginNewChat;
  ownerTimeoutMs?: number;
}

async function openInNewChat({
  store,
  server,
  declaration,
  beginNewChat,
  ownerTimeoutMs = 5000,
}: InlineOpeningRequest): Promise<InlineOpening> {
  const source = store.getState().currentChatId;
  const chatId = await beginNewChat(
    () => store.getState().currentChatId === source,
  );
  if (!chatId) return "no-chat";
  await waitForChatOwner(store, chatId, ownerTimeoutMs);
  const { chats, currentChatId } = store.getState();
  const latest = chats[chatId];
  if (latest && currentChatId === chatId) {
    void latest.launch(server, declaration, undefined, false, "inline");
    return "opened";
  }
  return currentChatId === chatId || currentChatId === source
    ? "no-chat"
    : "chat-changed";
}

/**
 * Opens a global entry App that can't go fullscreen inline at the top of a
 * new chat, and says where it went in Logs. The same declaration launches
 * again in the new chat's owner, so its entry tool runs a second time there,
 * and the App isn't saved with the chat.
 */
export async function openEntrypointInNewChat(
  request: InlineOpeningRequest,
): Promise<InlineOpening> {
  const outcome = await openInNewChat(request);
  const { server, declaration } = request;
  logExtensionEvent({
    serverId: server.serverId,
    serverName: server.name,
    label: "display-mode",
    level: outcome === "opened" ? "info" : "warning",
    message: MESSAGES[outcome](declaration.title || declaration.toolName),
    detail: { tool: declaration.toolName },
  });
  return outcome;
}

/**
 * The global owner's `onFullscreenUnsupported`: while the client opens entry
 * Apps that can't go fullscreen inline, a stable handler that opens them in
 * a new chat; otherwise undefined, and such an App is refused.
 */
export function useEntrypointInNewChat(
  store: ChatOwnerStore,
  setting: "refuse" | "inline" | undefined,
  ports: { readonly current: { beginNewChat: BeginNewChat } },
) {
  return useMemo(
    () =>
      setting === "inline"
        ? (server: WorkspaceServer, declaration: ThreadAppDeclaration) =>
            void openEntrypointInNewChat({
              store,
              server,
              declaration,
              beginNewChat: (isCurrent) =>
                ports.current.beginNewChat(isCurrent),
            })
        : undefined,
    [setting, store, ports],
  );
}
