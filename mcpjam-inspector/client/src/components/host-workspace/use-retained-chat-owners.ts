import { useEffect, useState } from "react";
import type { ExtensionStore } from "./ExtensionWorkspaceProvider";

const MAX_RETAINED_CHATS = 8;

export function useRetainedChatOwners(
  identityKey: string | null,
  chatId: string | null,
  sessionId: string | null,
  store: ExtensionStore,
  released: ReadonlySet<string>,
) {
  // Retained chats for the current identity, most recent last.
  const [retained, setRetained] = useState<{
    identity: string | null;
    ids: string[];
  }>({ identity: null, ids: [] });
  const retainedIds = (
    retained.identity === identityKey ? retained.ids : ([] as string[])
  ).filter((id) => id === chatId || !released.has(id));
  const chatIds =
    chatId && !retainedIds.includes(chatId)
      ? [...retainedIds, chatId]
      : retainedIds;
  useEffect(() => {
    setRetained((old) => {
      const base = old.identity === identityKey ? old.ids : [];
      if (!chatId) return { identity: identityKey, ids: base };
      // A conflict borrows its source owner only while the continuation is
      // shown. Reopening either row later must acquire its own Apps.
      const ids = base.filter((id) => id !== chatId);
      if (sessionId === chatId) ids.push(chatId);
      // Release deleted chats and hidden chats with nothing open, then cap
      // the rest.
      const chats = store.getState().chats;
      const kept = ids.filter(
        (id) =>
          id === chatId ||
          (!released.has(id) &&
            ((chats[id]?.apps.length ?? 0) > 0 ||
              (chats[id]?.settings.sessions.length ?? 0) > 0)),
      );
      const capped = kept.slice(-MAX_RETAINED_CHATS);
      return old.identity === identityKey &&
        capped.length === old.ids.length &&
        capped.every((id, index) => old.ids[index] === id)
        ? old
        : { identity: identityKey, ids: capped };
    });
  }, [identityKey, chatId, sessionId, store, released]);
  return chatIds;
}
