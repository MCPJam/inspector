import { createPortal } from "react-dom";
import { useStore } from "zustand";
import type { ExtensionStore } from "./ExtensionWorkspaceProvider";
import { RetainedAppsView, type ThreadAppWorkspace } from "./ThreadAppPanel";

/**
 * A chat's inline Apps, drawn into the slot at the top of the chat and kept
 * hidden while another chat is shown. Its owner mounts it.
 */
export function InlineChatApps({
  store,
  chatId,
  workspace,
}: {
  store: ExtensionStore;
  chatId: string;
  workspace: ThreadAppWorkspace;
}) {
  const slot = useStore(store, (state) => state.inlineSlot);
  const shown = useStore(store, (state) => state.currentChatId === chatId);
  if (!slot || !workspace.apps.some((row) => row.inline)) return null;
  return createPortal(
    <div
      data-extension-inline-chat={chatId}
      hidden={!shown}
      // The transcript's column, above the chat's first message.
      className="mx-auto w-full min-w-0 max-w-4xl px-4 pt-8"
    >
      <RetainedAppsView workspace={workspace} inline />
    </div>,
    slot,
  );
}
